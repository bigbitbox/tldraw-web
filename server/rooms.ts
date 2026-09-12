import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { createTLSchema, type TLRecord } from '@tldraw/tlschema'

export class Rooms {
  private index: DatabaseSync
  private active = new Map<string, { room: TLSocketRoom<TLRecord>; db: DatabaseSync; storage: SQLiteSyncStorage<TLRecord>; touched: number }>()
  private sweep: ReturnType<typeof setInterval>
  readonly schema = createTLSchema()
  constructor(private dir: string) {
    mkdirSync(join(dir, 'rooms'), { recursive: true })
    this.index = new DatabaseSync(join(dir, 'workspace.db'))
    this.index.exec('PRAGMA journal_mode = WAL')
    this.index.exec('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL)')
    this.index.prepare('INSERT OR IGNORE INTO rooms VALUES (?, ?, ?)').run('main', '我的画布', new Date().toISOString())
    this.sweep = setInterval(() => {
      for (const [id, entry] of this.active) {
        if (!entry.room.getNumActiveSessions() && Date.now() - entry.touched > 300_000) {
          entry.room.close(); entry.db.close(); this.active.delete(id)
        }
      }
    }, 60_000)
    this.sweep.unref()
  }
  list() { return this.index.prepare('SELECT * FROM rooms ORDER BY createdAt DESC').all() }
  find(id: string) { return this.index.prepare('SELECT * FROM rooms WHERE id=?').get(id) }
  create(name: string) {
    const value = { id: randomUUID(), name, createdAt: new Date().toISOString() }
    this.index.prepare('INSERT INTO rooms VALUES (@id, @name, @createdAt)').run(value)
    return value
  }
  rename(id: string, name: string) {
    this.index.prepare('UPDATE rooms SET name=? WHERE id=?').run(name, id)
    return this.find(id)
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
  close() {
    clearInterval(this.sweep)
    for (const e of this.active.values()) { e.room.close(); e.db.close() }
    this.active.clear(); this.index.close()
  }
}
