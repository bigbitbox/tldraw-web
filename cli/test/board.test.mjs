import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileEdit, summarize, sdkSchema } from '../src/board.mjs'
import { boardId, serverOrigin, requestPath } from '../src/client.mjs'

const snapshot = () => ({ revision: 7, schema: sdkSchema.serialize(), records: [{ id: 'page:page', typeName: 'page', name: 'Page', index: 'a1', meta: {} }] })
function apply(snapshot, edit) {
  const result = compileEdit(snapshot, { expectedRevision: snapshot.revision, operations: edit })
  const map = new Map(snapshot.records.map(r => [r.id, r]))
  for (const r of result.request.upsert) map.set(r.id, r)
  for (const id of result.request.delete) map.delete(id)
  return { ...snapshot, revision: snapshot.revision + 1, records: [...map.values()] }
}
test('native defaults, partial edits, freehand encoding, and untouched records', () => {
  const first = apply(snapshot(), [{ op: 'create', id: 'shape:one', type: 'geo', text: 'Hello', props: { w: 250, fill: 'semi', color: 'blue' } }, { op: 'create', id: 'shape:two', type: 'draw', points: [[0, 0], [25, 50], [80, 0]] }])
  const second = apply(first, [{ op: 'update', id: 'shape:one', text: 'Changed', props: { color: 'green' } }])
  const r = second.records.find(r => r.id === 'shape:one')
  assert.equal(r.props.w, 250); assert.equal(r.props.color, 'green'); assert.equal(r.props.fill, 'semi')
  assert.deepEqual(second.records.find(r => r.id === 'shape:two'), first.records.find(r => r.id === 'shape:two'))
  assert.ok(first.records.find(r => r.id === 'shape:two').props.segments[0].path.length > 0)
  assert.equal(summarize(second).shapes.find(s => s.id === 'shape:one').text, 'Changed')
})
test('conflicts, malformed props, missing refs and parent cycles fail before writes', () => {
  assert.throws(() => compileEdit(snapshot(), { expectedRevision: 6, operations: [{ op: 'create', type: 'geo' }] }), e => e.exitCode === 5)
  for (const op of [{ op: 'create', type: 'geo', props: { color: '#abc' } }, { op: 'create', type: 'geo', parentId: 'page:absent' }, { op: 'create', type: 'frame', id: 'shape:cycle', parentId: 'shape:cycle' }, { op: 'create', type: 'image', props: { assetId: 'asset:absent' } }, { op: 'update', id: 'shape:absent' }]) assert.throws(() => apply(snapshot(), [op]))
  const s = snapshot(); s.schema.sequences['com.tldraw.shape.geo'] = 999
  assert.throws(() => apply(s, [{ op: 'create', type: 'geo' }]), e => e.code === 'SCHEMA_MISMATCH')
})
test('delete includes descendants and bindings and refuses locked descendants', () => {
  const s = apply(snapshot(), [{ op: 'create', id: 'shape:f', type: 'frame' }, { op: 'create', id: 'shape:c', type: 'geo', parentId: 'shape:f' }, { op: 'create', id: 'shape:a', type: 'arrow' }, { op: 'bind', fromId: 'shape:a', toId: 'shape:c', terminal: 'end' }])
  const edit = compileEdit(s, { expectedRevision: s.revision, operations: [{ op: 'delete', id: 'shape:f' }] })
  assert.equal(edit.request.delete.length, 3)
  assert.ok(edit.request.delete.includes('shape:c'))
  const locked = apply(s, [{ op: 'update', id: 'shape:c', isLocked: true }])
  assert.throws(() => apply(locked, [{ op: 'delete', id: 'shape:f' }]), /locked/)
})
test('strict board link origin, safe path and transport boundaries', () => {
  const origin = 'https://tldraw.rayzor.site'
  assert.equal(boardId(origin + '/r/main?d=page#test', origin), 'main')
  assert.throws(() => boardId('https://tldraw.rayzor.site.evil.test/r/main', origin), /configured/)
  assert.throws(() => boardId('https://user@tldraw.rayzor.site/r/main', origin))
  assert.throws(() => serverOrigin('http://public.example'))
  assert.equal(serverOrigin('http://127.0.0.1:1234'), 'http://127.0.0.1:1234')
  for (const path of ['//evil.test/api/x', '/api/../stream', '/api/%2e%2e/stream', '/api/\\evil', '/uploads/x#foo']) assert.throws(() => requestPath(path))
})

test('image shapes cannot reference bookmark assets', () => {
  const s = snapshot()
  s.records.push({ id: 'asset:bookmark', typeName: 'asset', type: 'bookmark', meta: {}, props: { src: 'https://example.com', title: '', description: '', image: '', favicon: '' } })
  assert.throws(() => apply(s, [{ op: 'create', type: 'image', props: { assetId: 'asset:bookmark' } }]), /Asset type/)
})

test('change summary reflects the actual net diff, including no-ops', () => {
  const first = apply(snapshot(), [{ op: 'create', id: 'shape:one', type: 'geo', x: 10 }])
  const noop = compileEdit(first, { expectedRevision: first.revision, operations: [{ op: 'update', id: 'shape:one', x: 20 }, { op: 'update', id: 'shape:one', x: 10 }] })
  assert.equal(noop.request.upsert.length, 0); assert.deepEqual(noop.changes.updated, [])
  const created = compileEdit(first, { expectedRevision: first.revision, operations: [{ op: 'create', id: 'shape:new', type: 'geo' }, { op: 'update', id: 'shape:new', text: 'Final' }] })
  assert.deepEqual(created.changes.created, ['shape:new']); assert.deepEqual(created.changes.updated, [])
})
