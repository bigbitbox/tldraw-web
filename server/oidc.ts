import type { FastifyInstance, FastifyReply } from 'fastify'
import * as oidc from 'openid-client'

export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  allowedSubject: string
}

export function oidcFromEnv(): OidcSettings | undefined {
  if (!process.env.OIDC_ISSUER) return undefined
  return {
    issuer: process.env.OIDC_ISSUER,
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
    redirectUri: process.env.OIDC_REDIRECT_URI ?? '',
    allowedSubject: process.env.OIDC_ALLOWED_SUBJECT ?? '',
  }
}

// One owner and one existing workspace; the API and browser session remain unchanged.
export function registerOidc(app: FastifyInstance, settings: OidcSettings,
  completeLogin: (reply: FastifyReply) => void, testConfiguration?: oidc.Configuration) {
  const issuer = new URL(settings.issuer)
  const callback = new URL(settings.redirectUri)
  if (issuer.protocol !== 'https:' || callback.protocol !== 'https:' ||
      issuer.username || issuer.password || callback.username || callback.password ||
      issuer.search || issuer.hash || callback.search || callback.hash ||
      callback.pathname !== '/auth/oidc/callback' ||
      !settings.clientId || !settings.clientSecret || !settings.allowedSubject) {
    throw new Error('OIDC requires HTTPS URLs, client credentials and an explicit owner subject')
  }
  type Flow = { verifier: string; nonce: string; returnTo: string; expires: number; ip: string }
  const flows = new Map<string, Flow>()
  const flowCookie = 'whiteboard_oidc_flow'
  const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/auth/oidc', maxAge: 600 }
  let configuration: Promise<oidc.Configuration> | undefined
  const getConfiguration = () => {
    configuration ??= (testConfiguration ? Promise.resolve(testConfiguration) :
      oidc.discovery(issuer, settings.clientId, { id_token_signed_response_alg: 'RS256' },
        oidc.ClientSecretBasic(settings.clientSecret), { timeout: 10 }))
      .then(config => { oidc.enableNonRepudiationChecks(config); return config })
      .catch(error => { configuration = undefined; throw error })
    return configuration
  }
  const prune = () => { for (const [state, flow] of flows) if (flow.expires <= Date.now()) flows.delete(state) }
  const safePath = (path: unknown) => typeof path === 'string' && /^(\/|\/r\/[a-zA-Z0-9_-]{1,128})$/.test(path) ? path : '/'
  const loginError = (reply: FastifyReply, path = '/') => reply.redirect(`${path}?auth_error=oidc`)

  app.get<{ Querystring: { returnTo?: string } }>('/auth/oidc/start', async (req, reply) => {
    prune()
    const previous = req.cookies[flowCookie]
    if (previous) flows.delete(previous)
    try {
      const config = await getConfiguration()
      const state = oidc.randomState()
      const verifier = oidc.randomPKCECodeVerifier()
      const nonce = oidc.randomNonce()
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: callback.href, scope: 'openid profile', state, nonce,
        code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      })
      // Check immediately before insertion, after asynchronous discovery/PKCE work.
      const pendingForIp = [...flows.values()].filter(flow => flow.ip === req.ip).length
      if (flows.size >= 1000 || pendingForIp >= 10) return reply.code(429).send({ error: '登录请求过多，请稍后重试' })
      flows.set(state, { verifier, nonce, returnTo: safePath(req.query.returnTo), expires: Date.now() + 600_000, ip: req.ip })
      reply.setCookie(flowCookie, state, cookieOptions)
      return reply.redirect(url.href)
    } catch {
      return loginError(reply, safePath(req.query.returnTo))
    }
  })

  app.get('/auth/oidc/callback', async (req, reply) => {
    prune()
    const state = req.cookies[flowCookie] ?? ''
    const flow = flows.get(state)
    flows.delete(state) // Consume before network I/O; a callback cannot be replayed.
    reply.clearCookie(flowCookie, { path: cookieOptions.path, secure: true, sameSite: 'lax' })
    if (!flow) return loginError(reply)
    try {
      // Never derive the redirect URI or issuer from Host / X-Forwarded-* headers.
      const current = new URL(callback)
      current.search = new URL(req.url, callback.origin).search
      const tokens = await oidc.authorizationCodeGrant(await getConfiguration(), current, {
        pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce,
        idTokenExpected: true,
      })
      if (tokens.claims()?.sub !== settings.allowedSubject) return loginError(reply, flow.returnTo)
      completeLogin(reply)
      return reply.redirect(flow.returnTo)
    } catch {
      // Provider errors can contain codes/tokens. Do not log or send them to the browser.
      return loginError(reply, flow.returnTo)
    }
  })
  app.addHook('onClose', async () => { flows.clear() })
}
