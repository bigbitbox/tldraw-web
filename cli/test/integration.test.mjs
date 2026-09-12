import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { buildServer } from '../../server/server.ts'

const cli = fileURLToPath(new URL('../src/main.mjs', import.meta.url))
const apiToken = 'local-cli-test-api-token-123456789'
const headers = { authorization: `Bearer ${apiToken}` }
test('real CLI against app: auth, board CRUD, edits, conflict, assets and offline discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tldraw-cli-test-'))
  const app = await buildServer({ dataDir: join(dir, 'data'), accessToken: 'browser-test-token-123456789012345', apiToken, clientDir: '/nonexistent' })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const server = `http://127.0.0.1:${app.server.address().port}`
  const environment = { ...process.env, TLDRAW_CONFIG_DIR: join(dir, 'config') }
  delete environment.TLDRAW_TOKEN; delete environment.TLDRAW_URL
  const run = (args, stdin = '', env = environment) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', s => { stdout += s }); proc.stderr.on('data', s => { stderr += s }); proc.on('error', reject)
    proc.stdin.end(stdin)
    proc.on('close', code => {
      assert.ok(!stdout.includes(apiToken) && !stderr.includes(apiToken), 'must never print credential')
      resolve({ code, stdout, stderr, data: stdout.startsWith('{') ? JSON.parse(stdout) : null })
    })
  })
  try {
    assert.equal((await run(['schema', 'board.apply'])).code, 0)
    assert.equal((await run(['board', 'list'])).code, 4)
    const login = await run(['auth', 'login', '--server', server, '--with-token'], apiToken)
    assert.equal(login.code, 0, login.stderr)
    assert.equal((await stat(join(dir, 'config/config.json'))).mode & 0o777, 0o600)
    assert.equal((await run(['auth', 'status'])).data.authenticated, true)
    assert.equal((await run(['auth', 'status'], '', { ...environment, TLDRAW_TOKEN: apiToken })).code, 4, 'environment token must not inherit a saved host')
    assert.equal((await run(['auth', 'status'], '', { ...environment, TLDRAW_TOKEN: apiToken, TLDRAW_URL: server })).code, 0)
    const created = await run(['board', 'create', '--name', 'CLI Test'])
    assert.equal(created.code, 0, created.stderr)
    const url = created.data.url
    assert.equal((await run(['board', 'rename', url, '--name', 'Renamed'])).data.name, 'Renamed')
    const before = (await run(['board', 'read', url, '--raw'])).data
    const input = JSON.stringify({ expectedRevision: before.revision, operations: [{ op: 'create', id: 'shape:a', type: 'geo', x: 10, y: 20, text: 'CLI hello' }, { op: 'create', id: 'shape:b', type: 'geo', x: 300, text: 'Second' }, { op: 'create', id: 'shape:arrow', type: 'arrow' }, { op: 'bind', fromId: 'shape:arrow', toId: 'shape:a', terminal: 'start' }, { op: 'bind', fromId: 'shape:arrow', toId: 'shape:b', terminal: 'end' }] })
    assert.equal((await run(['board', 'apply', url, '--file', '-', '--dry-run'], input)).data.dryRun, true)
    assert.deepEqual((await run(['board', 'read', url, '--raw'])).data, before, 'dry-run must not mutate')
    const applied = await run(['board', 'apply', url, '--file', '-'], input)
    assert.equal(applied.code, 0, applied.stderr)
    assert.equal((await run(['board', 'apply', url, '--file', '-'], input)).code, 5)
    const partial = (await run(['board', 'read', url, '--limit', '1'])).data
    assert.equal(partial.shapes.length, 1); assert.equal(partial.nextOffset, 1); assert.equal(partial.totalShapes, 3)
    assert.equal((await run(['board', 'read', url, '--raw', '--limit', '1'])).code, 2)
    const snapshotFile = join(dir, 'snapshot.json')
    assert.equal((await run(['board', 'read', url, '--raw', '--output', snapshotFile])).code, 0)
    assert.equal((await run(['board', 'read', url, '--raw', '--output', snapshotFile])).code, 2)
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmh0AAAAASUVORK5CYII=', 'base64')
    const imageFile = join(dir, 'input.png'); await writeFile(imageFile, image)
    const revision = partial.revision
    const imageArgs = ['asset', 'add', url, '--file', imageFile, '--if-revision', String(revision), '--id', 'shape:image', '--x', '50']
    assert.equal((await run([...imageArgs, '--dry-run'])).data.dryRun, true)
    const added = await run(imageArgs); assert.equal(added.code, 0, added.stderr)
    const path = join(dir, 'download.png')
    const downloaded = await run(['asset', 'get', url, added.data.assetId, '--output', path])
    assert.equal(downloaded.code, 0, downloaded.stderr)
    assert.deepEqual(await readFile(path), image)
    assert.equal((await run(['asset', 'list', url])).data.assets.length, 1)
    // Treat stored asset URLs as untrusted, even if an authenticated user wrote them.
    const snap = (await app.inject({ url: `/api/rooms/${created.data.id}/records`, headers })).json()
    const asset = snap.records.find(r => r.id === added.data.assetId)
    asset.props.src = 'https://untrusted.example/image.png'
    await app.inject({ method: 'POST', url: `/api/rooms/${created.data.id}/records`, headers, payload: { expectedRevision: snap.revision, upsert: [asset] } })
    assert.equal(JSON.parse((await run(['asset', 'get', url, asset.id, '--output', join(dir, 'external.png')])).stderr).error.code, 'EXTERNAL_ASSET')
    assert.equal((await run(['board', 'read', 'https://other.example/r/main'])).code, 4)
    assert.equal((await run(['board', 'list', '--server', 'https://other.example'])).code, 4)
    assert.equal((await run(['skill', 'install', '--dir', join(dir, 'skills')])).code, 0)
    assert.equal((await run(['skill', 'install', '--dir', join(dir, 'skills')])).code, 2)
    assert.ok((await readFile(join(dir, 'skills/tldraw/SKILL.md'), 'utf8')).includes('board read'))
    assert.equal((await run(['auth', 'logout'])).code, 0)
    assert.equal((await run(['auth', 'status'])).code, 4)
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})

test('HTTP redirect never leaks an API key to another origin', async () => {
  const { Client } = await import('../src/client.mjs')
  let received = 0
  const target = createServer((_req, res) => { received++; res.end('{}') })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  const redirect = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/api/rooms` }); res.end() })
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve))
  try {
    const client = new Client({ server: `http://127.0.0.1:${redirect.address().port}`, token: apiToken })
    await assert.rejects(client.json('/api/rooms'), e => e.code === 'NETWORK_ERROR')
    assert.equal(received, 0)
  } finally { await new Promise(resolve => redirect.close(resolve)); await new Promise(resolve => target.close(resolve)) }
})

test('uncertain upload response retains recovery identifiers without claiming a board write', async () => {
  const { addImage } = await import('../src/assets.mjs')
  const { sdkSchema } = await import('../src/board.mjs')
  const { CliError } = await import('../src/client.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'tldraw-upload-test-'))
  const file = join(dir, 'image.png')
  await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmh0AAAAASUVORK5CYII=', 'base64'))
  const snapshot = { revision: 0, schema: sdkSchema.serialize(), records: [{ id: 'page:page', typeName: 'page', name: 'Page', index: 'a1', meta: {} }] }
  const requests = []
  const client = { json: async path => { requests.push(path); throw new CliError('NETWORK_ERROR', 'timeout') } }
  try {
    await assert.rejects(addImage(client, 'main', snapshot, { file, 'if-revision': '0' }), e => e.code === 'NETWORK_ERROR' && e.details.uploadConfirmed === false && e.details.uploadPath === requests[0] && e.details.uploadedAsset.props.src === requests[0] && e.details.shapeId.startsWith('shape:'))
    assert.equal(requests.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
