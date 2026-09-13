import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as oidc from 'openid-client'
import { buildServer } from './server'

test('OIDC verifies browser binding, PKCE, signed token claims and owner; preserves workspace/API sessions', async (t) => {
  const issuer = 'https://issuer.example'
  const settings = { issuer, clientId: 'whiteboard', clientSecret: 'private-client-secret', redirectUri: 'https://board.example/auth/oidc/callback', allowedSubject: 'owner-subject' }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
  const config = new oidc.Configuration({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks' }, settings.clientId, { id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic(settings.clientSecret))
  const grants = new Map<string, { nonce: string; challenge: string; mode: string }>()
  config[oidc.customFetch] = async (input, init) => {
    const url = new URL(input)
    if (url.pathname === '/jwks') return Response.json({ keys: [jwk] })
    assert.equal(url.pathname, '/token')
    const params = new URLSearchParams(String(init?.body))
    const code = params.get('code')!
    const grant = grants.get(code)
    assert.ok(grant)
    grants.delete(code)
    assert.equal(params.get('redirect_uri'), settings.redirectUri)
    assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), grant.challenge)
    if (grant.mode === 'pkce') return Response.json({ error: 'invalid_grant' }, { status: 400 })
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      iss: grant.mode === 'issuer' ? 'https://wrong.example' : issuer,
      sub: grant.mode === 'subject' ? 'other-user' : settings.allowedSubject,
      aud: grant.mode === 'audience' ? 'other-client' : settings.clientId,
      iat: now, exp: grant.mode === 'expired' ? now - 600 : now + 300,
      nonce: grant.mode === 'nonce' ? 'wrong' : grant.nonce,
    }
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const data = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(claims)}`
    const signature = grant.mode === 'signature' ? Buffer.from('invalid') : sign('RSA-SHA256', Buffer.from(data), privateKey)
    return Response.json({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 300, id_token: `${data}.${signature.toString('base64url')}` })
  }
  const options = { dataDir: await mkdtemp(join(tmpdir(), 'whiteboard-oidc-')), accessToken: 'browser-token-at-least-24-characters', apiToken: 'api-token-at-least-24-characters', clientDir: '/nonexistent', secureCookie: true, oidc: settings, oidcConfiguration: config }
  let app = await buildServer(options)
  const start = async (mode = 'valid', returnTo = '/r/main') => {
    const response = await app.inject('/auth/oidc/start?returnTo=' + encodeURIComponent(returnTo))
    assert.equal(response.statusCode, 302)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['referrer-policy'], 'no-referrer')
    const auth = new URL(response.headers.location!)
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    const state = auth.searchParams.get('state')!
    const code = 'code-' + state
    grants.set(code, { nonce: auth.searchParams.get('nonce')!, challenge: auth.searchParams.get('code_challenge')!, mode })
    const cookie = (response.headers['set-cookie'] as string).split(';')[0]
    assert.match(response.headers['set-cookie'] as string, /HttpOnly/)
    assert.match(response.headers['set-cookie'] as string, /Secure/)
    assert.match(response.headers['set-cookie'] as string, /SameSite=Lax/)
    return { cookie, url: '/auth/oidc/callback?' + new URLSearchParams({ code, state }) }
  }
  const sessionCookie = (response: { headers: Record<string, unknown> }) => ([] as string[]).concat(response.headers['set-cookie'] as string[] ?? []).find(c => c.startsWith('whiteboard_session='))
  try {
    for (const mode of ['cookie', 'state', 'nonce', 'issuer', 'audience', 'expired', 'subject', 'signature', 'pkce']) {
      const flow = await start(mode)
      const response = await app.inject({ url: flow.url + (mode === 'state' ? '&state=wrong' : ''), headers: mode === 'cookie' ? {} : { cookie: flow.cookie } })
      assert.equal(sessionCookie(response), undefined, `${mode} must not create a session`)
      assert.match(response.headers.location!, /auth_error=oidc/)
    }
    const old = await start()
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    t.mock.timers.tick(601_000)
    assert.equal(sessionCookie(await app.inject({ url: old.url, headers: { cookie: old.cookie } })), undefined)
    t.mock.timers.reset()
    const flow = await start()
    const login = await app.inject({ url: flow.url, headers: { cookie: flow.cookie } })
    assert.equal(login.headers.location, '/r/main')
    const cookie = sessionCookie(login)!.split(';')[0]
    assert.ok(cookie)
    assert.equal((await app.inject({ url: '/api/rooms', headers: { cookie } })).statusCode, 200)
    assert.equal(sessionCookie(await app.inject({ url: flow.url, headers: { cookie: flow.cookie } })), undefined)
    const external = await start('valid', '//evil.example')
    assert.equal((await app.inject({ url: external.url, headers: { cookie: external.cookie } })).headers.location, '/')
    await app.close()
    app = await buildServer(options)
    assert.equal((await app.inject({ url: '/api/rooms', headers: { cookie } })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/rooms', headers: { authorization: `Bearer ${options.apiToken}` } })).statusCode, 200)
    const forged = await app.inject({ url: '/api/rooms', headers: { 'remote-user': 'owner-subject', 'x-auth-request-user': 'owner-subject' } })
    assert.equal(forged.statusCode, 401)
    for (let i = 0; i < 10; i++) assert.equal((await app.inject({ url: '/auth/oidc/start', remoteAddress: '198.51.100.10' })).statusCode, 302)
    assert.equal((await app.inject({ url: '/auth/oidc/start', remoteAddress: '198.51.100.10' })).statusCode, 429)
    assert.equal((await app.inject({ url: '/auth/oidc/start', remoteAddress: '198.51.100.11' })).statusCode, 302)
  } finally { t.mock.timers.reset(); await app.close() }
})
