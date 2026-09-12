import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
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
