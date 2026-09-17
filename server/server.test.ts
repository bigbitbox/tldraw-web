import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from './server'

const token = 'test-browser-token-123456789012345'
const apiToken = 'test-api-token-123456789012345678'
const headers = { authorization: `Bearer ${apiToken}` }

test('authentication, durable rooms/assets, validated atomic edits and stale-write rejection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tldraw-test-'))
  let app = await buildServer({ dataDir: dir, accessToken: token, apiToken, clientDir: '/nonexistent' })
  try {
    assert.equal((await app.inject('/api/rooms')).statusCode, 401)
    assert.equal((await app.inject('/%61pi/rooms')).statusCode, 401)
    assert.equal((await app.inject('/%75ploads/test.png')).statusCode, 401)
    assert.equal((await app.inject({method:'POST',url:'/%73tream',payload:{}})).statusCode, 401)
    assert.equal((await app.inject({ url: '/api/rooms', headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/session', payload: { token: 'wrong' } })).statusCode, 401)
    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { token } })
    assert.equal(login.statusCode, 200)
    const cookie = login.headers['set-cookie'] as string
    assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'))
    assert.equal((await app.inject({ url: '/api/rooms', headers: { cookie } })).statusCode, 200)
    const create = await app.inject({ method: 'POST', url: '/api/rooms', headers, payload: { name: '持久化测试' } })
    assert.equal(create.statusCode, 200)
    const room = create.json()
    let snap = (await app.inject({ url: `/api/rooms/${room.id}/records`, headers })).json()
    const page = snap.records.find((r: any) => r.typeName === 'page')
    assert.ok(page)
    const bookmark = { id: 'asset:test', typeName: 'asset', type: 'bookmark', meta: {}, props: { src: 'https://example.com', title: 'Original', description: '', image: '', favicon: '' } }
    const write = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/records`, headers, payload: { expectedRevision: snap.revision, upsert: [bookmark] } })
    assert.equal(write.statusCode, 200, write.body)
    assert.equal((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/records`, headers, payload: { expectedRevision: snap.revision, upsert: [{...bookmark, props: {...bookmark.props,title:'stale'}}] } })).statusCode, 409)
    snap = (await app.inject({ url: `/api/rooms/${room.id}/records`, headers })).json()
    const denied = await app.inject({ method:'POST',url:`/api/rooms/${room.id}/records`,headers,payload:{expectedRevision:snap.revision,delete:[page.id],upsert:[{...bookmark,props:{...bookmark.props,title:'Should rollback'}}]} })
    assert.equal(denied.statusCode,400)
    assert.equal((await app.inject({method:'POST',url:`/api/rooms/${room.id}/records`,headers,payload:{expectedRevision:snap.revision,upsert:[{...bookmark,props:{src:4}}]}})).statusCode,400)
    assert.equal((await app.inject({ method:'PUT',url:'/uploads/test.png',headers:{...headers,'content-type':'image/png'},payload:Buffer.from('png-fixture') })).statusCode,200)
    assert.equal((await app.inject({ method:'PUT',url:'/uploads/test.html',headers:{...headers,'content-type':'text/html'},payload:'<script>bad</script>' })).statusCode,415)
    await app.close()
    app = await buildServer({ dataDir: dir, accessToken: token, apiToken, clientDir: '/nonexistent' })
    assert.ok((await app.inject({url:'/api/rooms',headers})).json().rooms.some((r:any)=>r.id===room.id))
    const restored=(await app.inject({url:`/api/rooms/${room.id}/records`,headers})).json()
    assert.equal(restored.records.find((r:any)=>r.id==='asset:test').props.title,'Original')
    assert.equal((await app.inject({url:'/uploads/test.png',headers})).body,'png-fixture')
    assert.equal((await app.inject({url:'/uploads/test.png'})).statusCode,401)
  } finally { await app.close() }
})


test('HTTPS session cookie and login limits behind exactly one trusted proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tldraw-proxy-test-'))
  const previous = process.env.TRUST_PROXY
  process.env.TRUST_PROXY = 'true'
  let app: Awaited<ReturnType<typeof buildServer>>
  try {
    app = await buildServer({ dataDir: dir, accessToken: token, apiToken, clientDir: '/nonexistent', secureCookie: true })
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY
    else process.env.TRUST_PROXY = previous
  }
  try {
    const attempt = (ip: string, value = 'wrong') => app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': ip }, payload: { token: value } })
    for (let i = 0; i < 12; i++) assert.equal((await attempt('198.51.100.1')).statusCode, 401)
    assert.equal((await attempt('198.51.100.1')).statusCode, 429)
    assert.equal((await attempt('198.51.100.99, 198.51.100.1')).statusCode, 429)
    assert.equal((await attempt('198.51.100.2')).statusCode, 401)
    const login = await attempt('198.51.100.2', token)
    assert.equal(login.statusCode, 200)
    assert.match(login.headers['set-cookie'] as string, /; Secure(?:;|$)/)
  } finally { await app.close() }
})

test('工作区排序与删除白板', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tldraw-order-test-'))
  let app = await buildServer({ dataDir: dir, accessToken: token, apiToken, clientDir: '/nonexistent' })
  try {
    const list = async () => (await app.inject({ url: '/api/rooms', headers })).json().rooms.map((r: any) => r.id)
    const create = async (name: string) => (await app.inject({ method: 'POST', url: '/api/rooms', headers, payload: { name } })).json()
    const a = await create('排序 A')
    const b = await create('排序 B')
    const c = await create('排序 C')

    // 新白板排在最前，主白板兜底在最后
    assert.deepEqual(await list(), [c.id, b.id, a.id, 'main'])

    // 未登录不能排序，也不能删除
    assert.equal((await app.inject({ method: 'PUT', url: '/api/rooms/order', payload: { ids: [a.id] } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` })).statusCode, 401)

    // 重新排序：服务端返回新顺序，后续读取保持一致
    const target = [a.id, c.id, b.id, 'main']
    const reorder = await app.inject({ method: 'PUT', url: '/api/rooms/order', headers, payload: { ids: target } })
    assert.equal(reorder.statusCode, 200, reorder.body)
    assert.deepEqual(reorder.json().rooms.map((r: any) => r.id), target)
    assert.deepEqual(await list(), target)

    // 集合对不上（漏项、重复、未知 id）一律拒绝，避免半途写坏顺序
    assert.equal((await app.inject({ method: 'PUT', url: '/api/rooms/order', headers, payload: { ids: [a.id, b.id] } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/rooms/order', headers, payload: { ids: [a.id, a.id, b.id, c.id, 'main'] } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/rooms/order', headers, payload: { ids: [a.id, b.id, c.id, 'main', 'nope'] } })).statusCode, 400)

    // 主白板是固定入口，不能删
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/rooms/main', headers })).statusCode, 400)
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/rooms/%6dain', headers })).statusCode, 400)

    // 删除白板：白板数据与它引用的附件一起清理
    assert.equal((await app.inject({ method: 'PUT', url: '/uploads/order-fixture.png', headers: { ...headers, 'content-type': 'image/png' }, payload: Buffer.from('png-fixture') })).statusCode, 200)
    const snap = (await app.inject({ url: `/api/rooms/${c.id}/records`, headers })).json()
    const asset = { id: 'asset:order-fixture', typeName: 'asset', type: 'image', meta: {}, props: { w: 10, h: 10, name: 'order-fixture.png', isAnimated: false, mimeType: 'image/png', src: '/uploads/order-fixture.png' } }
    assert.equal((await app.inject({ method: 'POST', url: `/api/rooms/${c.id}/records`, headers, payload: { expectedRevision: snap.revision, upsert: [asset] } })).statusCode, 200)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/rooms/${c.id}`, headers })).statusCode, 200)
    assert.deepEqual(await list(), [a.id, b.id, 'main'])
    assert.equal((await app.inject({ url: `/api/rooms/${c.id}/records`, headers })).statusCode, 404)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/rooms/${c.id}`, headers })).statusCode, 404)
    assert.equal((await app.inject({ url: '/uploads/order-fixture.png', headers })).statusCode, 404)
    assert.deepEqual((await readdir(join(dir, 'rooms'))).filter((name) => name.startsWith(c.id)), [])

    // 顺序要能跨重启保留
    await app.close()
    app = await buildServer({ dataDir: dir, accessToken: token, apiToken, clientDir: '/nonexistent' })
    assert.deepEqual(await list(), [a.id, b.id, 'main'])
  } finally { await app.close() }
})

test('静态资源缓存：字体长期缓存，避免导出重新回源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tldraw-cache-test-'))
  const clientDir = join(dir, 'client')
  await mkdir(join(clientDir, 'fonts'), { recursive: true })
  await mkdir(join(clientDir, 'assets'), { recursive: true })
  await mkdir(join(clientDir, 'tldraw-assets', 'fonts'), { recursive: true })
  await writeFile(join(clientDir, 'index.html'), '<html>ok</html>')
  await writeFile(join(clientDir, 'fonts', 'ZCOOL.woff2'), 'font')
  await writeFile(join(clientDir, 'assets', 'index-abc.js'), 'js')
  await writeFile(join(clientDir, 'tldraw-assets', 'fonts', 'plex.woff2'), 'font')
  const app = await buildServer({ dataDir: dir, accessToken: token, apiToken, clientDir })
  try {
    const cache = async (url: string) => (await app.inject({ url, headers })).headers['cache-control']
    assert.equal(await cache('/fonts/ZCOOL.woff2'), 'public, max-age=604800')
    assert.equal(await cache('/assets/index-abc.js'), 'public, max-age=31536000, immutable')
    assert.equal(await cache('/tldraw-assets/fonts/plex.woff2'), 'public, max-age=86400')
    assert.equal(await cache('/'), 'public, max-age=0')
    assert.equal(await cache('/r/main'), 'public, max-age=0')
  } finally { await app.close() }
})
