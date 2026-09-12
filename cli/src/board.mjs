import { createTLSchema, toRichText, b64Vecs } from '@tldraw/tlschema'
import { getIndexAbove, ZERO_INDEX_KEY } from '@tldraw/utils'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import defaults from './defaults.json' with { type: 'json' }
import { CliError, invalid } from './client.mjs'

export const sdkSchema = createTLSchema()
const finite = z.number().finite()
const object = z.record(z.string(), z.unknown())
const shapeId = z.string().regex(/^shape:[a-zA-Z0-9_-]{1,120}$/)
const common = {
  x: finite.optional(), y: finite.optional(), rotation: finite.optional(), opacity: finite.min(0).max(1).optional(),
  isLocked: z.boolean().optional(), parentId: z.string().optional(), props: object.optional(), meta: object.optional(), text: z.string().optional(),
  points: z.array(z.tuple([finite, finite])).min(2).max(10000).optional(),
}
export const editSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  pageId: z.string().optional(),
  operations: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('create'), id: shapeId.optional(), type: z.enum(Object.keys(defaults.shapes)), ...common }).strict(),
    z.object({ op: z.literal('update'), id: shapeId, ...common }).strict(),
    z.object({ op: z.literal('delete'), id: shapeId }).strict(),
    z.object({ op: z.literal('bind'), id: z.string().regex(/^binding:[a-zA-Z0-9_-]{1,120}$/).optional(), fromId: shapeId, toId: shapeId,
      terminal: z.enum(['start', 'end']), anchor: z.object({ x: finite.min(0).max(1), y: finite.min(0).max(1) }).strict().optional() }).strict(),
  ])).min(1).max(1000),
}).strict()

export function validateRecord(record) {
  try { return sdkSchema.validateRecord({}, record, 'createRecord', null) }
  catch (error) { throw invalid(`Invalid ${record.id}: ${error.message}`) }
}
export function validateSnapshot(snapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.records) || !snapshot.schema) throw new CliError('SCHEMA_MISMATCH', 'Server did not return a tldraw snapshot.')
  // SDK upgrades must be coordinated; never write old defaults into a newer record schema.
  const local = sdkSchema.serialize()
  const a = snapshot.schema.sequences, b = local.sequences
  if (snapshot.schema.schemaVersion !== local.schemaVersion || JSON.stringify(Object.entries(a || {}).sort()) !== JSON.stringify(Object.entries(b).sort())) throw new CliError('SCHEMA_MISMATCH', `Server schema differs from CLI SDK ${defaults.sdkVersion}. Update the CLI before editing.`)
}
export function currentPage(snapshot, requested) {
  const pages = snapshot.records.filter(r => r.typeName === 'page').sort((a, b) => a.index.localeCompare(b.index))
  if (requested) {
    if (!pages.some(p => p.id === requested)) throw invalid(`Page not found: ${requested}`)
    return requested
  }
  if (pages.length !== 1) throw invalid('This board has multiple pages. Supply pageId in the edit or --page for an image.')
  return pages[0].id
}
function richText(value) {
  if (!value) return ''
  if (value.type === 'text') return value.text || ''
  return (value.content || []).map(richText).join(value.type === 'doc' ? '\n' : '')
}
function pageFor(record, records) {
  const seen = new Set()
  let parent = record
  while (parent?.typeName === 'shape') {
    if (seen.has(parent.id)) return null
    seen.add(parent.id); parent = records.get(parent.parentId)
  }
  return parent?.typeName === 'page' ? parent.id : null
}
export function summarize(snapshot, { page, offset = 0, limit = 100 } = {}) {
  const records = new Map(snapshot.records.map(r => [r.id, r]))
  if (page && records.get(page)?.typeName !== 'page') throw invalid(`Page not found: ${page}`)
  const all = snapshot.records.filter(r => r.typeName === 'shape' && (!page || pageFor(r, records) === page)).sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : a.id.localeCompare(b.id))
  return {
    revision: snapshot.revision,
    pages: snapshot.records.filter(r => r.typeName === 'page').map(({ id, name, index }) => ({ id, name, index })),
    totalShapes: all.length, offset, limit, hasMore: offset + limit < all.length,
    nextOffset: offset + limit < all.length ? offset + limit : null,
    coordinates: 'x/y are relative to parentId; rotation is radians. Props contain native tldraw geometry. Read all pages/chunks before deciding an area is empty.',
    shapes: all.slice(offset, offset + limit).map(r => {
      const props = structuredClone(r.props)
      // Freehand paths can be huge; make them discoverable through --raw instead of losing them silently.
      if (props.segments) props.segments = props.segments.map(({ path, ...segment }) => ({ ...segment, encodedBytes: path?.length || 0, pathOmitted: true }))
      return { id: r.id, type: r.type, pageId: pageFor(r, records), parentId: r.parentId, x: r.x, y: r.y, rotation: r.rotation, index: r.index, opacity: r.opacity, isLocked: r.isLocked, text: richText(r.props.richText) || r.props.name || '', props }
    }),
    bindings: snapshot.records.filter(r => r.typeName === 'binding'),
    assets: snapshot.records.filter(r => r.typeName === 'asset').map(r => ({ ...r, usedBy: snapshot.records.filter(s => s.typeName === 'shape' && s.props.assetId === r.id).map(s => s.id) })),
  }
}

function changes(record, op) {
  const result = structuredClone(record)
  for (const key of ['x', 'y', 'rotation', 'opacity', 'isLocked', 'parentId']) if (op[key] !== undefined) result[key] = op[key]
  if (op.props) result.props = { ...result.props, ...op.props }
  if (op.meta) result.meta = { ...result.meta, ...op.meta }
  if (op.text !== undefined) {
    if (!('richText' in result.props)) throw invalid(`${result.type} does not support text; for frames set props.name.`)
    result.props.richText = toRichText(op.text)
  }
  if (op.points) {
    if (!['draw', 'highlight'].includes(result.type)) throw invalid('points is only supported for draw and highlight shapes.')
    result.props.segments = [{ type: 'free', path: b64Vecs.encodePoints(op.points.map(([x, y]) => ({ x, y, z: 0.5 }))), dim: 3 }]
    result.props.isComplete = true
  }
  return validateRecord(result)
}

export function compileEdit(snapshot, input) {
  validateSnapshot(snapshot)
  const parsed = editSchema.safeParse(input)
  if (!parsed.success) throw invalid(`Invalid edit: ${parsed.error.message}`)
  const body = parsed.data
  if (body.expectedRevision !== snapshot.revision) throw new CliError('CONFLICT', 'The revision you read has changed. Read the board again before editing.', 5, { expectedRevision: body.expectedRevision, currentRevision: snapshot.revision })
  const original = new Map(snapshot.records.map(r => [r.id, r]))
  const records = new Map(original)
  const removed = new Set()
  for (const op of body.operations) {
    if (op.op === 'create') {
      const id = op.id || `shape:${randomUUID()}`
      if (records.has(id) || original.has(id)) throw invalid(`Record already exists: ${id}. Use update or inspect a previous write.`)
      const parentId = op.parentId || currentPage(snapshot, body.pageId)
      const siblings = [...records.values()].filter(r => r.typeName === 'shape' && r.parentId === parentId).map(r => r.index).sort()
      const index = siblings.length ? getIndexAbove(siblings.at(-1)) : ZERO_INDEX_KEY
      const record = sdkSchema.types.shape.create({ id, type: op.type, parentId, index, props: structuredClone(defaults.shapes[op.type]) })
      records.set(id, changes(record, op))
    } else if (op.op === 'update') {
      const record = records.get(op.id)
      if (record?.typeName !== 'shape') throw invalid(`Shape not found: ${op.id}`)
      if (record.isLocked && op.isLocked !== false) throw invalid(`Shape is locked: ${op.id}. Explicitly unlock only when intended.`)
      records.set(op.id, changes(record, op))
    } else if (op.op === 'delete') {
      if (records.get(op.id)?.typeName !== 'shape') throw invalid(`Shape not found: ${op.id}`)
      // Delete descendants and connecting bindings together, rather than leaving invalid dangling records.
      const pending = [op.id]
      while (pending.length) {
        const id = pending.pop()
        if (records.get(id)?.isLocked) throw invalid(`Shape is locked: ${id}. Unlock explicitly before deletion.`)
        for (const r of records.values()) if (r.typeName === 'shape' && r.parentId === id) pending.push(r.id)
        records.delete(id); removed.add(id)
      }
      for (const r of records.values()) if (r.typeName === 'binding' && (removed.has(r.fromId) || removed.has(r.toId))) { records.delete(r.id); removed.add(r.id) }
    } else if (op.op === 'bind') {
      if (records.get(op.fromId)?.type !== 'arrow' || records.get(op.toId)?.typeName !== 'shape' || op.fromId === op.toId) throw invalid('bind requires an existing arrow fromId and another shape toId.')
      const id = op.id || `binding:${randomUUID()}`
      if (records.has(id) || original.has(id)) throw invalid(`Binding already exists: ${id}`)
      // One binding per arrow terminal. Rebinding removes the previous one atomically.
      for (const r of records.values()) if (r.typeName === 'binding' && r.fromId === op.fromId && r.props.terminal === op.terminal) { records.delete(r.id); removed.add(r.id) }
      records.set(id, validateRecord({ id, typeName: 'binding', type: 'arrow', fromId: op.fromId, toId: op.toId, meta: {}, props: { terminal: op.terminal, normalizedAnchor: op.anchor || { x: 0.5, y: 0.5 }, isExact: false, isPrecise: true, snap: 'none' } }))
    }
  }
  for (const r of records.values()) {
    if (r.typeName === 'shape') {
      const parent = records.get(r.parentId)
      if (parent?.typeName !== 'page' && !(parent?.typeName === 'shape' && ['frame', 'group'].includes(parent.type))) throw invalid(`Invalid parentId on ${r.id}; use a page or frame/group.`)
      if (!pageFor(r, records)) throw invalid(`Cyclic or missing parent on ${r.id}.`)
      if (r.props.assetId && records.get(r.props.assetId)?.typeName !== 'asset') throw invalid(`Missing asset ${r.props.assetId} on ${r.id}; use asset add to upload images.`)
      if (r.props.assetId && ['image', 'video', 'bookmark'].includes(r.type) && records.get(r.props.assetId).type !== r.type) throw invalid(`Asset type does not match ${r.type} shape ${r.id}.`)
    }
    if (r.typeName === 'binding' && (pageFor(records.get(r.fromId), records) !== pageFor(records.get(r.toId), records))) throw invalid('Arrow bindings cannot cross pages.')
  }
  const upsert = [...records.values()].filter(r => ['shape', 'binding', 'asset'].includes(r.typeName) && JSON.stringify(r) !== JSON.stringify(original.get(r.id)))
  const deleted = [...removed].filter(id => original.has(id))
  if (upsert.length > 1000 || deleted.length > 1000) throw invalid('Edit exceeds server limit of 1000 upserts/deletions. Split into smaller edits and re-read between writes.')
  return { request: { expectedRevision: body.expectedRevision, upsert, delete: deleted }, changes: { created: upsert.filter(r => !original.has(r.id)).map(r => r.id), updated: upsert.filter(r => original.has(r.id)).map(r => r.id), deleted } }
}

export const applyContract = () => ({ sdkVersion: defaults.sdkVersion, input: z.toJSONSchema(editSchema), shapeDefaults: defaults.shapes,
  notes: ['props is a shallow patch validated by the official SDK; nested objects must be complete.', 'x/y and points are local to the parent/shape; radians for rotation.', 'Use stable shape: identifiers to identify an ambiguous previous write.', 'Delete includes descendants and connected bindings; inspect --dry-run before a large deletion.', 'Freehand paths are editable native draw shapes, not raster pictures.', 'No automatic write retry. Revision conflicts exit 5.'],
  example: { expectedRevision: 0, operations: [{ op: 'create', id: 'shape:idea', type: 'geo', x: 100, y: 100, text: 'Idea', props: { geo: 'rectangle', w: 240, h: 120, color: 'blue', fill: 'semi' } }] } })
