// One catalog drives parsing, --help and schema discovery.
const s = (description, required = false) => ({ type: 'string', description, required })
const b = description => ({ type: 'boolean', description })
export const globalOptions = { server: s('Credential server origin (must match saved auth).'), format: s('json (default) or text.'), json: b('Explicit JSON output.'), help: { ...b('Show help without making a request.'), short: 'h' } }
const output = { output: s('Write to a local file instead of stdout.'), force: b('Allow overwriting the specified local output.') }
const dry = { 'dry-run': b('Validate and show the intended request without remote writes.') }
export const commands = {
  'auth login': { args: '', description: 'Store an API key for one server; key is read from stdin and verified before saving.', options: { 'with-token': b('Read API key from stdin; required for login.') }, example: 'tldraw auth login --server https://tldraw.rayzor.site --with-token < api-token.txt' },
  'auth status': { args: '', description: 'Verify configured authentication without exposing the key.', options: {} },
  'auth logout': { args: '', description: 'Remove saved local credentials. Does not revoke the server key.', options: {} },
  'board list': { args: '', description: 'List boards and permanent URLs.', options: {} },
  'board create': { args: '', description: 'Create a board and return its ID and permanent URL.', options: { name: s('Board name, 1–120 characters.', true), ...dry }, example: 'tldraw board create --name "项目设计"' },
  'board rename': { args: '<board>', description: 'Rename a board without changing its URL.', options: { name: s('New name.', true), ...dry } },
  'board read': { args: '<board>', description: 'Read shapes, text, coordinates, pages, bindings and image/video assets. Accepts a URL or ID.', options: { page: s('Filter shapes to a page ID.'), offset: s('Shape offset; default 0.'), limit: s('Number of shapes, 1–1000; default 100.'), raw: b('Full snapshot with revision, schema and native records; no shape pagination.'), ...output }, example: 'tldraw board read https://tldraw.rayzor.site/r/main --json' },
  'board apply': { args: '<board>', description: 'Apply a batch of native shape operations with revision checking. See schema board.apply.', options: { file: s('Edit JSON file, or - for stdin.', true), ...dry }, example: 'tldraw board apply main --file edit.json --dry-run' },
  'asset list': { args: '<board>', description: 'List image/video/bookmark records with source URLs and shape references.', options: {} },
  'asset get': { args: '<board> <asset-id>', description: 'Download a workspace image/video to inspect with the agent image tool; never forwards keys to external URLs.', options: { output: s('Local destination path.', true), force: b('Allow overwriting the local output.') } },
  'asset add': { args: '<board>', description: 'Upload an image and insert an editable image shape. Requires the revision from board read.', options: { file: s('Local PNG/JPEG/GIF/WebP/AVIF file.', true), 'if-revision': s('Expected board revision.', true), x: s('X coordinate; default 0.'), y: s('Y coordinate; default 0.'), width: s('Display width; aspect ratio is preserved.'), page: s('Page ID; required when multiple pages exist.'), id: s('Optional stable shape:identifier.'), alt: s('Image description.'), ...dry } },
  'api': { args: '<method> <path>', description: 'Low-level same-server API fallback. Mutations are not automatically retried.', options: { file: s('JSON body file, or - for stdin.'), ...dry } },
  'schema': { args: '[command]', description: 'Inspect commands or the JSON schema/defaults for board.apply. No authentication needed.', options: {}, example: 'tldraw schema board.apply' },
  'skill read': { args: '', description: 'Print the bundled Agent Skill. No authentication needed.', options: {} },
  'skill install': { args: '', description: 'Install the bundled Skill into Codex, or a specified agent skill directory.', options: { dir: s('Skill parent directory; default $CODEX_HOME/skills or ~/.codex/skills.') } },
}
export function help(name) {
  if (!name) return `tldraw — CLI for your self-hosted whiteboard (not an official tldraw CLI)\n\nUsage: tldraw <command> [options]\n\n${Object.entries(commands).map(([key, value]) => `  ${key.padEnd(16)} ${value.description}`).join('\n')}\n\nAgent quickstart:\n  tldraw auth status\n  tldraw board read <URL>\n  tldraw schema board.apply\n  tldraw board apply <URL> --file edit.json --dry-run\n\nJSON is the default; errors are JSON on stderr. Exit codes: 0 success, 1 request/runtime error, 2 invalid input, 4 authentication/host mismatch, 5 revision conflict.\nEnvironment: TLDRAW_URL, TLDRAW_TOKEN, TLDRAW_CONFIG_DIR. Keys are never printed.\nUse tldraw <command> --help or tldraw schema <command.with.dots>.\n`
  const item = commands[name]
  return `Usage: tldraw ${name} ${item.args} [options]\n\n${item.description}\n\n${Object.entries({ ...item.options, ...globalOptions }).map(([key, value]) => `  --${key}${value.type === 'string' ? ' <value>' : ''}${value.required ? ' (required)' : ''}\n      ${value.description}`).join('\n')}${item.example ? '\n\nExample:\n  ' + item.example : ''}\n`
}
