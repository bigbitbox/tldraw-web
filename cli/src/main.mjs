#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, mkdir, cp, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { Client, CliError, invalid, credentials, configPath, saveConfig, serverOrigin, boardId, readStdin, readInput, logout, writeOutput, requestPath } from './client.mjs'
import { applyContract, compileEdit, summarize } from './board.mjs'
import { addImage, downloadAsset } from './assets.mjs'
import { commands, globalOptions, help } from './commands.mjs'

const skillDir = fileURLToPath(new URL('../skill/', import.meta.url))
function number(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid(`Expected an integer between ${min} and ${max}.`)
  return n
}
function name(value) {
  const result = value?.trim()
  if (!result || result.length > 120) throw invalid('--name must be 1–120 characters.')
  return result
}
export async function run(argv) {
  if (!argv.length || ['--help', '-h', 'help'].includes(argv[0])) return { text: help() }
  if (['--version', '-v'].includes(argv[0])) return { text: 'tldraw 0.1.0 (SDK 5.4.2)' }
  let key = argv[0], count = 1
  if (!commands[key]) { key = argv.slice(0, 2).join(' '); count = 2 }
  if (!commands[key]) {
    if (argv.length === 1 || ['--help', '-h'].includes(argv[1])) {
      const matches = Object.keys(commands).filter(k => k.startsWith(argv[0] + ' '))
      if (matches.length) return { text: matches.map(k => help(k)).join('\n') }
    }
    throw invalid('Unknown command. Run tldraw --help.')
  }
  const entry = commands[key]
  const definitions = { ...globalOptions, ...entry.options }
  let parsed
  try { parsed = parseArgs({ args: argv.slice(count), options: Object.fromEntries(Object.entries(definitions).map(([k, v]) => [k, { type: v.type, ...(v.short ? { short: v.short } : {}) }])), allowPositionals: true, strict: true }) }
  catch (error) { throw invalid(error.message) }
  const options = parsed.values, args = parsed.positionals
  if (options.help) return { text: help(key) }
  if (options.format && !['json', 'text'].includes(options.format)) throw invalid('--format must be json or text.')
  for (const [k, v] of Object.entries(definitions)) if (v.required && options[k] === undefined) throw invalid(`--${k} is required. See tldraw ${key} --help.`)
  const required = (entry.args.match(/<[^>]+>/g) || []).length
  const optional = (entry.args.match(/\[[^\]]+\]/g) || []).length
  if (args.length < required || args.length > required + optional) throw invalid(`Expected: tldraw ${key} ${entry.args}`)

  let data
  if (key === 'schema') {
    const target = args[0]?.replaceAll('.', ' ')
    if (target === 'board apply') data = applyContract()
    else if (target && !commands[target]) throw invalid('Unknown schema name. Run tldraw schema for the catalog.')
    else data = target ? { command: target, ...commands[target], globalOptions } : { cliVersion: '0.1.0', commands, globalOptions }
  } else if (key === 'skill read') return { text: await readFile(join(skillDir, 'SKILL.md'), 'utf8') }
  else if (key === 'skill install') {
    const parent = options.dir || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills')
    const target = resolve(parent, 'tldraw')
    try { await access(target); throw invalid(`Skill already exists at ${target}; update it explicitly instead of overwriting local changes.`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await mkdir(parent, { recursive: true })
    await cp(skillDir, target, { recursive: true, force: false, errorOnExist: true })
    data = { installed: true, path: target }
  } else if (key === 'auth login') {
    if (!options['with-token']) throw invalid('Use --with-token < api-token-file; tokens are never accepted as command-line arguments.')
    const server = serverOrigin(options.server || process.env.TLDRAW_URL)
    const token = (await readStdin()).toString('utf8').trim()
    if (token.length < 24 || /\s/.test(token)) throw invalid('Expected a single API key with at least 24 characters.')
    await new Client({ server, token }).json('/api/rooms')
    await saveConfig({ server, token })
    data = { authenticated: true, server, configFile: configPath() }
  } else if (key === 'auth logout') {
    await logout(); data = { removedSavedCredentials: true, environmentTokenStillSet: Boolean(process.env.TLDRAW_TOKEN) }
  } else {
    const client = new Client(await credentials(options.server))
    if (key === 'auth status') {
      await client.json('/api/rooms'); data = { authenticated: true, server: client.server, source: process.env.TLDRAW_TOKEN ? 'environment' : configPath() }
    } else if (key === 'board list') {
      const result = await client.json('/api/rooms')
      data = { boards: result.rooms.map(r => ({ ...r, url: client.url(r.id) })) }
    } else if (key === 'board create') {
      const body = { name: name(options.name) }
      data = options['dry-run'] ? { dryRun: true, method: 'POST', path: '/api/rooms', body } : await client.json('/api/rooms', { method: 'POST', body })
      if (!options['dry-run']) data.url = client.url(data.id)
    } else if (key === 'api') {
      const method = args[0].toUpperCase(), path = requestPath(args[1])
      if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw invalid('Unsupported HTTP method.')
      const body = options.file ? await readInput(options.file) : undefined
      if (method === 'GET' && body !== undefined) throw invalid('GET cannot have a body.')
      data = options['dry-run'] ? { dryRun: true, method, path, ...(body !== undefined ? { body } : {}) } : await client.json(path, { method, body })
    } else {
      const id = boardId(args[0], client.server)
      if (key === 'board rename') {
        const body = { name: name(options.name) }
        data = options['dry-run'] ? { dryRun: true, method: 'PATCH', path: `/api/rooms/${id}`, body } : { ...await client.json(`/api/rooms/${id}`, { method: 'PATCH', body }), url: client.url(id) }
      } else {
        const snapshot = await client.snapshot(id)
        if (key === 'board read') {
          if (options.raw && (options.page || options.offset || options.limit)) throw invalid('--raw returns all records; do not combine it with page/offset/limit.')
          data = { boardId: id, url: client.url(id), ...(options.raw ? snapshot : summarize(snapshot, { page: options.page, offset: number(options.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit: number(options.limit, 100, 1, 1000) })) }
        } else if (key === 'board apply') {
          const compiled = compileEdit(snapshot, await readInput(options.file))
          data = options['dry-run'] ? { dryRun: true, boardId: id, ...compiled } : { ...await client.json(`/api/rooms/${id}/records`, { method: 'POST', body: compiled.request }), boardId: id, url: client.url(id), changes: compiled.changes }
        } else if (key === 'asset list') data = { boardId: id, revision: snapshot.revision, assets: summarize(snapshot).assets }
        else if (key === 'asset get') data = await downloadAsset(client, snapshot, args[1], options.output, options.force)
        else if (key === 'asset add') {
          number(options['if-revision'], undefined, 0, Number.MAX_SAFE_INTEGER)
          data = await addImage(client, id, snapshot, options)
        }
      }
    }
  }
  if (options.output && key === 'board read') {
    const path = await writeOutput(options.output, JSON.stringify(data, null, 2) + '\n', options.force)
    return { data: { path, boardId: data.boardId, revision: data.revision } }
  }
  if (options.format === 'text' && !options.json) {
    if (data.boards) return { text: data.boards.map(r => `${r.name}\t${r.id}\t${r.url}`).join('\n') }
    if (data.shapes) return { text: [`${data.url}  revision=${data.revision}  shapes=${data.totalShapes}`, ...data.shapes.map(r => `${r.id}\t${r.type}\t(${r.x}, ${r.y})\t${r.text.replaceAll('\n', ' / ')}`), data.hasMore ? `More shapes: --offset ${data.nextOffset}` : '', `${data.assets.length} asset(s); use asset list/get to inspect images.`].filter(Boolean).join('\n') }
  }
  return { data }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(process.argv.slice(2))
    process.stdout.write((result.text ?? JSON.stringify(result.data, null, 2)) + '\n')
  } catch (error) {
    const known = error instanceof CliError
    process.stderr.write(JSON.stringify({ error: { code: known ? error.code : 'LOCAL_ERROR', message: known ? error.message : 'Local operation failed; check file paths and permissions.', ...(known && error.details ? { details: error.details } : {}) } }) + '\n')
    process.exitCode = known ? error.exitCode : 1
  }
}
