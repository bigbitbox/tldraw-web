import { readFile, writeFile, mkdir, rename, chmod, unlink } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export class CliError extends Error {
  constructor(code, message, exitCode = 1, details) {
    super(message); Object.assign(this, { code, exitCode, details })
  }
}
export const invalid = (message) => new CliError('INVALID_ARGUMENT', message, 2)
export const configPath = () => join(process.env.TLDRAW_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tldraw-cli'), 'config.json')

export function serverOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw invalid('Server must be an absolute HTTPS URL.') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalid('Server must contain only an origin, for example https://tldraw.rayzor.site.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw invalid('Use HTTPS (HTTP is only allowed on loopback for local development).')
  return url.origin
}

export async function loadConfig() {
  try {
    const data = JSON.parse(await readFile(configPath(), 'utf8'))
    if (typeof data.token !== 'string' || !data.token) throw new Error('Missing token')
    return { server: serverOrigin(data.server), token: data.token }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new CliError('CONFIG_ERROR', `Cannot read ${configPath()}; repair it or run auth login again.`)
  }
}

export async function saveConfig(config) {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(config) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temp, path)
  await chmod(path, 0o600)
}
export async function logout() { await unlink(configPath()).catch(e => { if (e.code !== 'ENOENT') throw e }) }

export async function credentials(explicitServer) {
  if (process.env.TLDRAW_TOKEN && !explicitServer && !process.env.TLDRAW_URL) throw new CliError('AUTH_REQUIRED', 'TLDRAW_TOKEN requires an explicit TLDRAW_URL or --server; it is never paired with a saved server implicitly.', 4)
  const saved = await loadConfig()
  const token = process.env.TLDRAW_TOKEN || saved?.token
  const candidate = explicitServer || process.env.TLDRAW_URL || saved?.server
  if (!candidate || !token) throw new CliError('AUTH_REQUIRED', 'Run tldraw auth login --server URL --with-token < token-file, or set TLDRAW_URL and TLDRAW_TOKEN.', 4)
  const server = serverOrigin(candidate)
  // Never reuse a saved host's token for a host supplied by a URL or a flag.
  if (!process.env.TLDRAW_TOKEN && server !== saved.server) throw new CliError('HOST_MISMATCH', 'This server differs from the saved credential host. Run auth login for it explicitly.', 4)
  return { server, token }
}

export function boardId(value, server) {
  if (!value) throw invalid('A board ID or /r/<id> URL is required.')
  let id = value
  if (/^https?:/i.test(value)) {
    let url
    try { url = new URL(value) } catch { throw invalid('Invalid board URL.') }
    if (url.origin !== server || url.username || url.password) throw new CliError('HOST_MISMATCH', 'The board URL is not on the configured server; no credential was sent.', 4)
    const match = url.pathname.match(/^\/r\/([a-zA-Z0-9_-]{1,80})\/?$/)
    if (!match) throw invalid('Expected a board link ending in /r/<id>.')
    id = match[1]
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw invalid('Invalid board ID.')
  return id
}

export function requestPath(path) {
  if (!/^\/(api|uploads)\//.test(path) && path !== '/healthz') throw invalid('API path must start with /api/ or /uploads/, or equal /healthz.')
  if (path.includes('\\') || /[\r\n]/.test(path) || path.includes('#')) throw invalid('Invalid API path.')
  const decoded = decodeURIComponent(path.split('?')[0])
  if (decoded.split('/').some(p => p === '..' || p === '.')) throw invalid('Path traversal is not allowed.')
  return path
}

export class Client {
  constructor(config) { this.server = config.server; this.token = config.token }
  async response(path, { method = 'GET', body, contentType } = {}) {
    requestPath(path)
    let response
    try {
      response = await fetch(this.server + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': contentType || 'application/json' }) },
        body: body === undefined ? undefined : contentType ? body : JSON.stringify(body),
      })
    } catch {
      throw new CliError('NETWORK_ERROR', 'Request failed or timed out. A write may have succeeded: read the board before retrying; writes are never retried automatically.')
    }
    if (!response.ok) {
      // Do not echo arbitrary proxy/server responses that might contain credentials.
      const status = response.status
      const [code, message, exitCode] = status === 401 ? ['AUTH_REQUIRED', 'API key was rejected. Reconfigure auth login (the browser passphrase is a different credential).', 4]
        : status === 409 ? ['CONFLICT', 'The board revision changed or the object already exists. Read current state and rebuild the edit; do not blindly retry.', 5]
        : status === 404 ? ['NOT_FOUND', 'Board, asset, or API route was not found.', 1]
        : ['HTTP_ERROR', `Server returned HTTP ${status}.`, 1]
      throw new CliError(code, message, exitCode, { status })
    }
    return response
  }
  async json(path, options) { return (await this.response(path, options)).json() }
  snapshot(id) { return this.json(`/api/rooms/${id}/records`) }
  url(id) { return `${this.server}/r/${id}` }
}

export async function readInput(file, maxBytes = 8 * 1024 * 1024) {
  if (!file) throw invalid('--file is required (use - for stdin).')
  const data = file === '-' ? await readStdin(maxBytes) : await readFile(file)
  if (data.length > maxBytes) throw invalid(`Input exceeds ${maxBytes} bytes.`)
  try { return JSON.parse(data.toString('utf8')) } catch { throw invalid('Input is not valid JSON.') }
}
export async function readStdin(maxBytes = 8192) {
  if (process.stdin.isTTY) throw invalid('Read input from a pipe or redirected file; interactive prompts are not used.')
  const chunks = []; let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > maxBytes) throw invalid(`Input exceeds ${maxBytes} bytes.`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
export async function writeOutput(path, bytes, force = false) {
  if (!path || path === '-') throw invalid('Choose a local --output path.')
  const absolute = resolve(path)
  // Explicit overwrite, private artifacts by default, never follow a pre-existing path silently.
  await writeFile(absolute, bytes, { flag: force ? 'w' : 'wx', mode: 0o600 }).catch(e => {
    if (e.code === 'EEXIST') throw invalid(`Output already exists: ${absolute}. Choose a new path or pass --force.`)
    throw e
  })
  return absolute
}
