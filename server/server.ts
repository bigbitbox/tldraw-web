import fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import websocket from '@fastify/websocket'
import cookie from '@fastify/cookie'
import statics from '@fastify/static'
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, existsSync, createReadStream } from 'node:fs'
import { writeFile, rename, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { type TLRecord } from '@tldraw/tlschema'
import { AgentService } from '../worker/do/AgentService'
import { type AgentPrompt } from '../shared/types/AgentPrompt'
import { Rooms } from './rooms'
import { oidcFromEnv, registerOidc, type OidcSettings } from './oidc'
import type { Configuration } from 'openid-client'

const roomName = z.object({ name: z.string().trim().min(1).max(120) })
const roomOrder = z.object({ ids: z.array(z.string().trim().min(1).max(80)).min(1).max(500) })
const mutation = z.object({
  expectedRevision: z.number().int().nonnegative(),
  upsert: z.array(z.record(z.string(), z.unknown())).max(1000).default([]),
  delete: z.array(z.string()).max(1000).default([]),
})
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode })
const hash = (value: string) => createHash('sha256').update(value).digest()

export async function buildServer(options: { dataDir?: string; accessToken?: string; apiToken?: string; clientDir?: string; secureCookie?: boolean; oidc?: OidcSettings; oidcConfiguration?: Configuration } = {}) {
  const accessToken = options.accessToken ?? process.env.ACCESS_TOKEN ?? ''
  const apiToken = options.apiToken ?? process.env.API_TOKEN ?? accessToken
  if (accessToken.length < 24 || apiToken.length < 24) throw new Error('ACCESS_TOKEN and API_TOKEN must contain at least 24 characters')
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? '.data')
  const uploads = join(dataDir, 'uploads')
  mkdirSync(uploads, { recursive: true })
  const rooms = new Rooms(dataDir)
  const app = fastify({ trustProxy: process.env.TRUST_PROXY === 'true' ? (_address: string, hop: number) => hop === 0 : false, logger: { level: 'warn', redact: ['req.headers.authorization', 'req.headers.cookie'] }, bodyLimit: 8 * 1024 * 1024 })
  await app.register(cookie)
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } })
  const browserHash = hash(accessToken)
  const apiHash = hash(apiToken)
  const cookieValue = createHash('sha256').update('tldraw-session:' + accessToken).digest('hex')
  const oidcSettings = options.oidc ?? oidcFromEnv()
  const completeLogin = (reply: FastifyReply) => {
    reply.setCookie('whiteboard_session', cookieValue, { httpOnly: true, sameSite: 'strict', secure: !!oidcSettings || (options.secureCookie ?? process.env.SECURE_COOKIE === 'true'), path: '/', maxAge: 30 * 86400 })
  }
  const matches = (a: string, b: Buffer) => timingSafeEqual(hash(a), b)
  const authenticated = (req: FastifyRequest) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    return matches(bearer, apiHash) || matches(req.cookies.whiteboard_session ?? '', hash(cookieValue))
  }
  // Allow only the exact configured origin; the deployment exposes the backend only through Caddy.
  const validOrigin = (req: FastifyRequest) => {
    const origin = req.headers.origin
    if (!origin) return true
    const allowed = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)
    if (allowed.length) return allowed.includes(origin)
    try { return new URL(origin).host === req.headers.host } catch { return false }
  }
  app.addHook('onRequest', async (req, res) => {
    res.header('X-Content-Type-Options', 'nosniff')
    res.header('Referrer-Policy', 'same-origin')
    res.header('X-Frame-Options', 'SAMEORIGIN')
    if (!validOrigin(req)) throw fail(403, '来源不匹配')
    const path = req.routeOptions.url ?? req.url.split('?')[0]
    if (path.startsWith('/auth/')) res.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    if ((path.startsWith('/api/') && path !== '/api/session') || path.startsWith('/connect/') || path.startsWith('/uploads/') || path === '/stream') {
      res.header('Cache-Control', 'no-store')
      if (!authenticated(req)) throw fail(401, '请先登录')
    }
  })
  app.setErrorHandler((error, _req, res) => {
    const status = error instanceof z.ZodError ? 400 : (error as any).statusCode ?? 500
    if (status >= 500) app.log.error({ err: error }, 'request failed')
    res.status(status).send({ error: status >= 500 ? '服务暂时不可用' : (error as Error).message })
  })
  app.get('/healthz', async () => ({ ok: true, mode: process.env.APP_ENV ?? 'development' }))
  if (oidcSettings) registerOidc(app, oidcSettings, completeLogin, options.oidcConfiguration)
  app.get('/api/session', async (req, res) => { res.header('Cache-Control', 'no-store'); return { authenticated: authenticated(req), oidcEnabled: !!oidcSettings } })
  const attempts = new Map<string, { count: number; until: number }>()
  const attemptTimer = setInterval(() => { for (const [ip, a] of attempts) if (a.until < Date.now()) attempts.delete(ip) }, 60_000)
  attemptTimer.unref()
  app.post('/api/session', async (req, res) => {
    const ip = req.ip
    const previous = attempts.get(ip)
    if (previous && previous.until > Date.now() && previous.count >= 12) throw fail(429, '尝试过多，请稍后重试')
    const { token } = z.object({ token: z.string().max(256) }).parse(req.body)
    if (!matches(token, browserHash)) {
      attempts.set(ip, { count: previous && previous.until > Date.now() ? previous.count + 1 : 1, until: Date.now() + 300_000 })
      throw fail(401, '访问口令不正确')
    }
    attempts.delete(ip)
    completeLogin(res)
    return { authenticated: true }
  })
  app.delete('/api/session', async (_req, res) => { res.clearCookie('whiteboard_session', { path: '/' }); return { authenticated: false } })
  app.get('/api/rooms', async () => ({ rooms: rooms.list() }))
  app.post('/api/rooms', async (req) => rooms.create(roomName.parse(req.body).name))
  app.patch<{ Params: { id: string } }>('/api/rooms/:id', async (req) => {
    if (!rooms.find(req.params.id)) throw fail(404, '画布不存在')
    return rooms.rename(req.params.id, roomName.parse(req.body).name)
  })
  // 顺序与删除都是工作区列表的整体操作；主白板是固定入口，不参与删除。
  app.put('/api/rooms/order', async (req) => ({ rooms: rooms.reorder(roomOrder.parse(req.body).ids) }))
  app.delete<{ Params: { id: string } }>('/api/rooms/:id', async (req) => {
    if (req.params.id === 'main') throw fail(400, '主白板不能删除')
    return rooms.remove(req.params.id)
  })
  app.get<{ Params: { id: string } }>('/api/rooms/:id/records', async (req) => {
    const { room, storage } = rooms.get(req.params.id)
    const snapshot = room.getCurrentSnapshot()
    return { revision: storage.getClock(), schema: snapshot.schema, records: snapshot.documents.map(d => d.state) }
  })
  app.post<{ Params: { id: string } }>('/api/rooms/:id/records', async (req) => {
    const body = mutation.parse(req.body)
    const { room, storage } = rooms.get(req.params.id)
    const records = body.upsert.map(record => {
      if (!['shape', 'binding', 'asset'].includes(String(record.typeName))) throw fail(400, '接口只允许修改 shape、binding、asset')
      try { return rooms.schema.validateRecord({} as any, record as unknown as TLRecord, 'createRecord', null) as TLRecord }
      catch { throw fail(400, '图形记录格式无效') }
    })
    await room.updateStore(store => {
      if (body.expectedRevision !== storage.getClock()) throw fail(409, '画布已改变，请重新读取后再修改')
      for (const id of body.delete) {
        const existing = store.get(id)
        if (existing && !['shape', 'binding', 'asset'].includes(existing.typeName)) throw fail(400, '不能删除页面或文档记录')
      }
      for (const record of records) store.put(record)
      for (const id of body.delete) store.delete(id)
    })
    return { ok: true, revision: storage.getClock() }
  })
  app.get<{ Params: { roomId: string }; Querystring: { sessionId: string } }>('/connect/:roomId', { websocket: true, preValidation: async req => {
    if (!req.query.sessionId || req.query.sessionId.length > 128) throw fail(400, '缺少 sessionId')
    rooms.get(req.params.roomId)
  } }, (socket, req) => {
    rooms.get(req.params.roomId).room.handleSocketConnect({ sessionId: req.query.sessionId, socket })
  })
  await app.register(async upload => {
    upload.removeAllContentTypeParsers()
    upload.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => done(null, body))
    const assetPath = (id: string) => {
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,239}$/.test(id)) throw fail(400, '附件名称无效')
      return join(uploads, id)
    }
    upload.put<{ Params: { id: string } }>('/uploads/:id', async req => {
      const path = assetPath(req.params.id)
      if (existsSync(path)) throw fail(409, '附件已存在')
      const type = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]
      if (!/^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|application\/octet-stream)$/.test(type)) throw fail(415, '请上传 PNG、JPEG、GIF、WebP、AVIF 或视频')
      const temp = `${path}.tmp-${Date.now()}`
      await writeFile(temp, req.body as Buffer, { flag: 'wx' })
      await rename(temp, path)
      await writeFile(`${path}.mime`, type)
      return { ok: true }
    })
    upload.get<{ Params: { id: string } }>('/uploads/:id', async (req, res) => {
      const path = assetPath(req.params.id)
      if (req.params.id.endsWith('.mime') || !existsSync(path)) throw fail(404, '附件不存在')
      const { readFile } = await import('node:fs/promises')
      const type = await readFile(`${path}.mime`, 'utf8').catch(() => 'application/octet-stream')
      res.header('Content-Security-Policy', "default-src 'none'; sandbox")
      // 附件名唯一且内容不变；no-store 会让每次导出重新下载图片，同样拖慢导出。
      res.header('Cache-Control', 'private, max-age=604800')
      res.header('Content-Type', type)
      res.header('Content-Length', (await stat(path)).size)
      return res.send(createReadStream(path))
    })
  })
  const service = new AgentService({ OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '', OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '' })
  let streams = 0
  app.post('/stream', async (req, res) => {
    if (!process.env.OPENAI_API_KEY) throw fail(503, 'AI 尚未配置')
    if (streams >= 3) throw fail(429, 'AI 正在处理其他请求，请稍后重试')
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw fail(400, '请求格式无效')
    // Never let the client request prompt logging on the server.
    const { debug: _debug, ...parts } = req.body as Record<string, unknown>
    const prompt = parts as unknown as AgentPrompt
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 180_000)
    res.raw.on('close', () => controller.abort())
    streams++
    async function* events() {
      try {
        for await (const change of service.stream(prompt, controller.signal)) yield `data: ${JSON.stringify(change)}\n\n`
      } catch (err) {
        if (!controller.signal.aborted) yield `data: ${JSON.stringify({ error: 'AI 请求失败，请稍后重试' })}\n\n`
        app.log.warn({ error: (err as Error).message }, 'AI request failed')
      } finally { clearTimeout(timeout); streams-- }
    }
    res.header('Content-Type', 'text/event-stream').header('Cache-Control', 'no-cache, no-transform').header('X-Accel-Buffering', 'no')
    return res.send(Readable.from(events()))
  })
  const clientDir = resolve(options.clientDir ?? 'dist/client')
  if (existsSync(clientDir)) {
    // 复制为 PNG 会在导出时重新读取字体（以及画布里的图片），而且必须赶在浏览器 5 秒的
    // 用户激活窗口内完成剪贴板写入。原先所有静态资源都是 max-age=0，每次导出都要回源校验，
    // 网络一抖动（实测出现过 10~20 秒的响应）导出就会超时、剪贴板写入被拒。
    // 因此：构建产物带内容哈希可长期缓存，字体和 tldraw 资源按版本缓存。
    const cacheControl = (file: string) => {
      const normalized = file.replaceAll('\\', '/')
      if (normalized.includes('/assets/')) return 'public, max-age=31536000, immutable'
      if (normalized.includes('/tldraw-assets/')) return 'public, max-age=86400'
      if (normalized.includes('/fonts/')) return 'public, max-age=604800'
      return 'public, max-age=0'
    }
    await app.register(statics, {
      root: clientDir,
      wildcard: true,
      cacheControl: false,
      setHeaders: (res, file) => res.setHeader('Cache-Control', cacheControl(file)),
    })
    const spa = (_req: FastifyRequest, res: FastifyReply) => {
      res.header('Cache-Control', 'public, max-age=0')
      return res.sendFile('index.html')
    }
    app.get('/', spa)
    app.get('/r/:id', spa)
  }
  app.addHook('onClose', async () => { clearInterval(attemptTimer); rooms.close() })
  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await buildServer()
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 5858) })
  console.log('Whiteboard server ready on port ' + (process.env.PORT ?? 5858))
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void app.close().then(() => process.exit(0)) })
}
