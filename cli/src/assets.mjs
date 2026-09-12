import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { imageSize } from 'image-size'
import { CliError, invalid, writeOutput } from './client.mjs'
import { compileEdit, validateRecord } from './board.mjs'

const maxBytes = 20 * 1024 * 1024
const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }

export async function downloadAsset(client, snapshot, id, output, force) {
  const asset = snapshot.records.find(r => r.id === id && r.typeName === 'asset')
  if (!asset || !['image', 'video'].includes(asset.type)) throw invalid('Choose an image/video asset ID from asset list or board read.')
  const src = asset.props.src
  if (typeof src !== 'string') throw invalid('Asset has no downloadable source.')
  let data, mimeType
  if (src.startsWith('data:')) {
    const match = src.match(/^data:(image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=\s]+)$/)
    if (!match || match[2].length > maxBytes * 1.4) throw invalid('Unsupported or oversized inline asset.')
    mimeType = match[1]; data = Buffer.from(match[2], 'base64')
  } else {
    let url
    try { url = new URL(src, client.server) } catch { throw invalid('Invalid asset URL.') }
    // Canvas content is untrusted. Never send the workspace token to a third-party asset URL.
    if (url.origin !== client.server || url.username || url.password || !/^\/uploads\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,239}$/.test(url.pathname) || url.search || url.hash) throw new CliError('EXTERNAL_ASSET', 'Asset points outside this workspace upload store. Its URL is available in asset list; download separately without the workspace credential if appropriate.')
    const response = await client.response(url.pathname)
    mimeType = (response.headers.get('content-type') || '').split(';')[0]
    if (!/^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|application\/octet-stream)$/.test(mimeType)) throw invalid('Server returned an unsupported asset MIME type.')
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > maxBytes) throw invalid('Asset exceeds 20 MiB.')
      chunks.push(chunk)
    }
    data = Buffer.concat(chunks)
  }
  if (data.length > maxBytes) throw invalid('Asset exceeds 20 MiB.')
  const path = await writeOutput(output, data, force)
  return { assetId: id, path, mimeType, bytes: data.length, width: asset.props.w, height: asset.props.h }
}

export async function addImage(client, board, snapshot, options) {
  if (!options.file || options.file === '-') throw invalid('asset add requires a local image --file.')
  if ((await stat(options.file)).size > maxBytes) throw invalid('Image exceeds 20 MiB.')
  const data = await readFile(options.file)
  let image
  try { image = imageSize(data) } catch { throw invalid('Cannot decode image dimensions.') }
  const mimeType = mimeTypes[image.type]
  if (!mimeType) throw invalid('Supported images: PNG, JPEG, GIF, WebP, AVIF.')
  const assetId = `asset:${randomUUID()}`
  const shapeId = options.id || `shape:${randomUUID()}`
  const uploadPath = `/uploads/${randomUUID()}.${image.type}`
  const asset = validateRecord({ id: assetId, typeName: 'asset', type: 'image', meta: {}, props: { name: basename(options.file), src: uploadPath, w: image.width, h: image.height, mimeType, isAnimated: image.type === 'gif', fileSize: data.length } })
  const w = options.width === undefined ? image.width : Number(options.width)
  if (!Number.isFinite(w) || w <= 0) throw invalid('--width must be positive.')
  const compiled = compileEdit({ ...snapshot, records: [...snapshot.records, asset] }, {
    expectedRevision: Number(options['if-revision']), pageId: options.page,
    operations: [{ op: 'create', id: shapeId, type: 'image', x: Number(options.x || 0), y: Number(options.y || 0), props: { assetId, w, h: w * image.height / image.width, altText: options.alt || '' } }],
  })
  compiled.request.upsert.unshift(asset)
  if (options['dry-run']) return { dryRun: true, boardId: board, upload: { path: uploadPath, mimeType, bytes: data.length }, ...compiled }
  let uploadConfirmed = false
  try {
    await client.json(uploadPath, { method: 'PUT', contentType: mimeType, body: data })
    uploadConfirmed = true
    const result = await client.json(`/api/rooms/${board}/records`, { method: 'POST', body: compiled.request })
    return { ...result, boardId: board, url: client.url(board), shapeId, assetId }
  } catch (error) {
    // The upload and record edit are separate requests. Keep the recoverable uploaded record in the error.
    error.details = { ...error.details, uploadConfirmed, uploadPath, uploadedAsset: asset, shapeId, note: uploadConfirmed ? 'Upload completed; the board edit failed or is uncertain. Read the board before retrying. The uploaded file may be unreferenced.' : 'Upload failed or is uncertain. No board edit was attempted. Check this uploadPath before uploading again; the file may already exist.' }
    throw error
  }
}
