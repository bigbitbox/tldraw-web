import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { createTLSchema, type TLRecord } from '@tldraw/tlschema'

// 工作区索引行；position 由用户拖拽排序决定，越小越靠前。
interface RoomRow { id: string; name: string; createdAt: string; position: number | null }
export interface RoomEntry { room: TLSocketRoom<TLRecord>; db: DatabaseSync; storage: SQLiteSyncStorage<TLRecord>; touched: number }

const uploadName = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,239}$/

// 删除白板时顺带清理它引用的附件，避免 /data/uploads 里留下孤儿文件。
function referencedUploads(entry: RoomEntry) {
  const names = new Set<string>()
  for (const document of entry.room.getCurrentSnapshot().documents) {
    const record = document.state as { typeName?: string; props?: { src?: unknown } }
    const src = record.typeName === 'asset' ? record.props?.src : null
    if (typeof src !== 'string' || !src.startsWith('/uploads/')) continue
    const name = decodeURIComponent(src.slice('/uploads/'.length))
    if (uploadName.test(name)) names.add(name)
  }
  return names
}

export class Rooms {
  private index: DatabaseSync
  private active = new Map<string, RoomEntry>()
  private sweep: ReturnType<typeof setInterval>
  readonly schema = createTLSchema()
  constructor(private dir: string) {
    mkdirSync(join(dir, 'rooms'), { recursive: true })
    this.index = new DatabaseSync(join(dir, 'workspace.db'))
    this.index.exec('PRAGMA journal_mode = WAL')
    this.index.exec('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL)')
    // 老库没有 position 列：按原本的展示顺序（createdAt 倒序）补齐一次，之后顺序完全由 position 决定。
    const columns = this.index.prepare('PRAGMA table_info(rooms)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'position')) {
      this.index.exec('ALTER TABLE rooms ADD COLUMN position REAL')
      const rows = this.index.prepare('SELECT id FROM rooms ORDER BY createdAt DESC').all() as Array<{ id: string }>
      const setPosition = this.index.prepare('UPDATE rooms SET position=? WHERE id=?')
      rows.forEach((row, i) => setPosition.run(i + 1, row.id))
    }
    this.index.prepare('INSERT OR IGNORE INTO rooms (id, name, createdAt, position) VALUES (?, ?, ?, ?)').run('main', '我的画布', new Date().toISOString(), 0)
    this.sweep = setInterval(() => {
      for (const [id, entry] of this.active) {
        if (!entry.room.getNumActiveSessions() && Date.now() - entry.touched > 300_000) {
          entry.room.close(); entry.db.close(); this.active.delete(id)
        }
      }
    }, 60_000)
    this.sweep.unref()
  }
  list() { return this.index.prepare('SELECT * FROM rooms ORDER BY position ASC, createdAt DESC').all() as unknown as RoomRow[] }
  find(id: string) { return this.index.prepare('SELECT * FROM rooms WHERE id=?').get(id) as RoomRow | undefined }
  create(name: string) {
    // 新白板排在最前面，与过去「最新创建的在最上」的观感一致。
    const next = this.index.prepare('SELECT COALESCE(MIN(position), 1) - 1 AS position FROM rooms').get() as { position: number }
    const value = { id: randomUUID(), name, createdAt: new Date().toISOString(), position: next.position }
    this.index.prepare('INSERT INTO rooms VALUES (@id, @name, @createdAt, @position)').run(value)
    return value
  }
  rename(id: string, name: string) {
    this.index.prepare('UPDATE rooms SET name=? WHERE id=?').run(name, id)
    return this.find(id)
  }
  // 客户端提交完整的 id 顺序；集合对不上说明列表已被别的设备改过，让客户端刷新后重试。
  reorder(ids: string[]) {
    const existing = (this.index.prepare('SELECT id FROM rooms').all() as Array<{ id: string }>).map((row) => row.id)
    const known = new Set(existing)
    if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
      throw Object.assign(new Error('白板列表已变化，请刷新后重试'), { statusCode: 400 })
    }
    const setPosition = this.index.prepare('UPDATE rooms SET position=? WHERE id=?')
    this.index.exec('BEGIN IMMEDIATE')
    try {
      ids.forEach((id, i) => setPosition.run(i, id))
      this.index.exec('COMMIT')
    } catch (err) {
      this.index.exec('ROLLBACK')
      throw err
    }
    return this.list()
  }
  get(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !this.find(id)) throw Object.assign(new Error('画布不存在'), { statusCode: 404 })
    let entry = this.active.get(id)
    if (!entry) {
      const db = new DatabaseSync(join(this.dir, 'rooms', `${id}.db`))
      db.exec('PRAGMA journal_mode = WAL')
      const storage = new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(db) })
      const room = new TLSocketRoom<TLRecord>({ storage, schema: this.schema })
      entry = { db, storage, room, touched: Date.now() }
      this.active.set(id, entry)
    }
    entry.touched = Date.now()
    return entry
  }
  // 删除白板：先读出它引用的附件，再关掉房间、删索引行、清库文件与附件。
  async remove(id: string) {
    if (!this.find(id)) throw Object.assign(new Error('画布不存在'), { statusCode: 404 })
    const entry = this.get(id)
    const uploads = referencedUploads(entry)
    entry.room.close(); entry.db.close()
    this.active.delete(id)
    this.index.prepare('DELETE FROM rooms WHERE id=?').run(id)
    for (const name of uploads) {
      rmSync(join(this.dir, 'uploads', name), { force: true })
      rmSync(join(this.dir, 'uploads', `${name}.mime`), { force: true })
    }
    await this.purgeRoomFiles(id)
    return { ok: true, id, removedUploads: uploads.size }
  }
  // node:sqlite 关闭连接后还会在后台收尾，可能把删掉的库文件再写回来；
  // 所以删完等一拍校验，确认没有被重新建出来。
  private async purgeRoomFiles(id: string) {
    const base = join(this.dir, 'rooms', `${id}.db`)
    const paths = [base, `${base}-wal`, `${base}-shm`]
    const gone = () => !paths.some((path) => existsSync(path))
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const path of paths) rmSync(path, { force: true })
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (gone()) return
    }
  }
  close() {
    clearInterval(this.sweep)
    for (const e of this.active.values()) { e.room.close(); e.db.close() }
    this.active.clear(); this.index.close()
  }
}
