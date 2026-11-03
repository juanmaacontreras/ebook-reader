// Mirror between the local database (db.ts) and Supabase.
//
// Pull: rows whose server-side synced_at is newer than this device's cursor
// (cheap: a quiet library pulls nothing), every table at once. Push: local rows
// marked _dirty. Conflicts: last writer wins by updated_at, enforced on both
// ends — locally in merge(), on the server by the lww_guard trigger.
//
// When, so a change reaches the other devices as fast as possible:
// - a local change is pushed at once (pushSoon; while listening, every 10 s
//   and when the voice stops); leaving the app sends what's pending right away
//   (flush), since a phone may freeze a background app within seconds;
// - a Realtime event pulls just its table, at once;
// - a full sync (both ways, every table) on start, on coming back to the app,
//   on reconnecting, when Realtime (re)connects, after a failure (retried with
//   backoff) and as a safety net: every 30 s while Realtime is down, else 5 min
//   (and the places alone every minute: Realtime doesn't promise delivery).
// One run at a time: whatever is asked meanwhile goes in the next round.

import { db, kv, type StoreName } from './db'
import { audioBucket, library, local, paths } from './files'
import { demo, supabase, userId } from './supabase'
import type { Book, Highlight, Local, NarrationChapter, ReadingSession } from './types'

type Table = 'books' | 'positions' | 'highlights' | 'narrations' | 'narration_chapters' | 'reading_sessions'

interface Spec { table: Table; store: StoreName; select: string; lww: boolean }

const SPECS: Spec[] = [
  { table: 'books', store: 'books', select: '*', lww: true },
  { table: 'positions', store: 'positions', select: '*', lww: true },
  { table: 'highlights', store: 'highlights', select: '*', lww: true },
  { table: 'narrations', store: 'narrations', select: '*', lww: true },
  // Timings (the sentence map) are fetched with the audio, not on every pull.
  { table: 'narration_chapters', store: 'chapters', select: 'book_id,voice,section,audio_path,duration,bytes,created_at,synced_at', lww: false },
  { table: 'reading_sessions', store: 'sessions', select: '*', lww: true },
]
const PUSHED: Table[] = ['books', 'positions', 'highlights', 'narrations', 'reading_sessions']
const LOCAL_FIELDS = ['_dirty', '_upload', 'synced_at', 'timings', 'cached']
// Columns a device never pushes: the worker's, and kepub_path (written by a
// direct update in kepubs.ts; a stale local copy of the row must not clear it).
const NOT_PUSHED: Partial<Record<Table, string[]>> = {
  narrations: ['state', 'current_section', 'error', 'stopped_at'],
  books: ['kepub_path'],
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error'

type Listener = (changed: Set<StoreName>) => void
const listeners = new Set<Listener>()
const stateListeners = new Set<(s: SyncState) => void>()
export let syncState: SyncState = 'idle'

export function onChange(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn) }
export function onSyncState(fn: (s: SyncState) => void): () => void { stateListeners.add(fn); return () => stateListeners.delete(fn) }
export function emit(changed: Iterable<StoreName>): void {
  const set = new Set(changed)
  if (set.size) for (const fn of listeners) fn(set)
}
function setState(s: SyncState) { syncState = s; for (const fn of stateListeners) fn(s) }

// What to pull: a table, or one of the logs of rows deleted on the server.
type PullKey = Table | 'deleted_books' | 'deleted_chapters'
const ALL_PULLS: PullKey[] = ['deleted_books', ...SPECS.map(s => s.table), 'deleted_chapters']

let running: Promise<void> | null = null
let wantFull = false
let wantPush = false
const wantPull = new Set<PullKey>()
let failures = 0
let lastFull = 0
let lastPlaces = 0  // last pull of positions

// A run at a given time; asking again never makes it later, only sooner.
// ms <= 0 runs now, without a timer: a hidden page's timers may be held back.
class Later {
  private timer: number | undefined
  private due = Infinity
  constructor(private fire: () => void) {}
  in(ms: number): void {
    if (ms <= 0) { this.cancel(); this.fire(); return }
    const at = Date.now() + ms
    if (this.timer !== undefined && at >= this.due) return
    clearTimeout(this.timer)
    this.due = at
    this.timer = window.setTimeout(() => { this.timer = undefined; this.due = Infinity; this.fire() }, ms)
  }
  cancel(): void { clearTimeout(this.timer); this.timer = undefined; this.due = Infinity }
}
const fullLater = new Later(() => { wantFull = true; void run() })
const pushLater = new Later(() => { wantPush = true; void run() })

/** Full sync (both ways, every table) in ms. */
export function syncSoon(ms = 1500): void { fullLater.in(ms) }
/** Push this device's changes in ms (0: now). */
export function pushSoon(ms = 0): void { pushLater.in(ms) }
/** Full sync now. */
export function sync(): Promise<void> { fullLater.cancel(); wantFull = true; return run() }
/** Push now, with the local writes still on their way: leaving the app, the voice stopping. */
export function flush(): Promise<void> { pushLater.cancel(); wantPush = true; return run() }
function pullSoon(keys: PullKey[]): void { for (const k of keys) wantPull.add(k); void run() }

/** Safety net (main.ts, every 30 s while visible): Realtime down, or 5 minutes without a full sync. */
export function safetySync(): void {
  if (!realtimeUp || Date.now() - lastFull > 5 * 60_000) void sync()
  else if (Date.now() - lastPlaces > 60_000) pullSoon(['positions'])
}

// Local writes still on their way to IndexedDB (store.ts): a push waits for
// them, so a page turned a moment before leaving the app goes with it.
const writes = new Set<Promise<unknown>>()
export function localWrite<T>(p: Promise<T>): Promise<T> {
  writes.add(p)
  void p.catch(() => {}).finally(() => writes.delete(p))
  return p
}

function run(): Promise<void> {
  if (running) return running  // the loop below takes what was just asked
  running = (async () => {
    try {
      while (wantFull || wantPush || wantPull.size) {
        if (writes.size) await Promise.allSettled([...writes])
        const full = wantFull
        const push = wantPush
        const pulls = [...wantPull]
        wantFull = wantPush = false
        wantPull.clear()
        if (full) await syncOnce()
        else if (push || pulls.length) await partial(push, pulls)
      }
      failures = 0
      setState('idle')
    } catch (e) {
      console.warn('sync failed', e)
      const online = navigator.onLine
      setState(online ? 'error' : 'offline')
      // Online: try again on its own, backing off (4 s, 8 s ... 1 min). Offline:
      // the 'online' event syncs (main.ts).
      if (online) syncSoon(Math.min(60_000, 2000 * 2 ** ++failures))
    } finally {
      running = null
    }
  })()
  return running
}

async function syncOnce(): Promise<void> {
  const uid = await userId()
  if (!uid || demo) return
  setState('syncing')
  await uploadPendingBooks(uid)
  // Before push: a row of a book removed elsewhere would fail its foreign key
  // (or bring the book back, if it's the book row itself).
  await pullDeletedBooks()
  await pushDeletedBooks(uid)
  await push()
  await pull(ALL_PULLS.filter(k => k !== 'deleted_books'))
  lastFull = Date.now()
  // Background, after the sync: KEPUBs for the Kobo that are still missing.
  void import('./kepubs').then(m => m.buildPendingKepubs(uid))
}

// The quick way: this device's changes and/or the tables Realtime named.
// A book row, a book to upload or a removal take the full way (removals made
// elsewhere come first there, see syncOnce), and so does a change pointing at
// a book that is gone from the server (foreign key violation).
async function partial(push_: boolean, pulls: PullKey[]): Promise<void> {
  const uid = await userId()
  if (!uid || demo) return
  if (push_) {
    const books = await db.all<Local<Book> & { _upload?: boolean }>('books')
    if (books.some(b => b._dirty || b._upload) || (await kv.get<string[]>('pendingBookDeletes'))?.length) return syncOnce()
    try {
      await push()
    } catch (e) {
      if ((e as { code?: string }).code === '23503') return syncOnce()
      throw e
    }
  }
  if (pulls.length) await pull(pulls)
}

function strip<T extends object>(row: T, table: Table): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const skip = [...LOCAL_FIELDS, ...(NOT_PUSHED[table] ?? [])]
  for (const [k, v] of Object.entries(row)) if (!skip.includes(k)) out[k] = v
  return out
}

// Books first (every other row points at one), then the other tables at once.
async function push(): Promise<void> {
  const gone = new Set((await kv.get<string[]>('goneBooks')) ?? [])
  const specs = SPECS.filter(s => PUSHED.includes(s.table))
  await pushTable(specs[0], gone)
  await Promise.all(specs.slice(1).map(s => pushTable(s, gone)))
}

async function pushTable(spec: Spec, gone: Set<string>): Promise<void> {
  let rows = (await db.all<Local<{ updated_at: string }>>(spec.store)).filter(r => r._dirty && !(r as { _upload?: boolean })._upload)
  if (gone.size) rows = await dropGone(spec.table, rows as Row[], gone)
  if (!rows.length) return
  const key = spec.table === 'positions' || spec.table === 'narrations' ? 'book_id' : 'id'
  const { error } = await supabase.from(spec.table).upsert(rows.map(r => strip(r, spec.table)), { onConflict: key })
  if (error) throw error
  // Clear the flag only on rows nobody touched while the request was in flight.
  for (const row of rows) {
    const current = await db.get<Local<{ updated_at: string }>>(spec.store, (row as Record<string, unknown>)[key] as string)
    if (current && current.updated_at === row.updated_at) await db.put(spec.store, { ...current, _dirty: false })
  }
}

type Row = Local<{ id?: string; book_id?: string | null; updated_at: string }>

// Rows written for a removed book after this device forgot it (a reader still
// open at that moment): sessions keep their time without the book, the rest goes.
async function dropGone(table: Table, rows: Row[], gone: Set<string>): Promise<Row[]> {
  const spec = SPECS.find(s => s.table === table)!
  const out: Row[] = []
  for (const r of rows) {
    const book = table === 'books' ? r.id : r.book_id
    if (!book || !gone.has(book)) out.push(r)
    else if (table === 'reading_sessions') {
      const kept = { ...r, book_id: null }
      await db.put(spec.store, kept)
      out.push(kept)
    } else await db.del(spec.store, (table === 'positions' || table === 'narrations' ? r.book_id : r.id)!)
  }
  return out
}

// Removed books first (a pulled row of one would bring it back for a moment),
// then every other table at once.
async function pull(keys: PullKey[]): Promise<void> {
  if (keys.includes('deleted_books')) await pullDeletedBooks()
  const gone = new Set((await kv.get<string[]>('goneBooks')) ?? [])
  const changed = new Set<StoreName>()
  await Promise.all(keys.map(async k => {
    if (k === 'deleted_books') return
    if (k === 'deleted_chapters') { if (await pullDeletedChapters()) changed.add('chapters'); return }
    const spec = SPECS.find(s => s.table === k)!
    if (await pullTable(spec, gone)) changed.add(spec.store)
    if (k === 'positions') lastPlaces = Date.now()
  }))
  emit(changed)
}

async function pullTable(spec: Spec, gone: Set<string>): Promise<boolean> {
  let changed = false
  const cursorKey = `cursor:${spec.table}`
  let cursor = (await kv.get<string>(cursorKey)) ?? '1970-01-01T00:00:00Z'
  for (;;) {
    const { data, error } = await supabase.from(spec.table).select(spec.select)
      .gt('synced_at', cursor).order('synced_at').limit(500)
    if (error) throw error
    const rows = (data ?? []) as unknown as Record<string, unknown>[]
    if (!rows.length) break
    for (const row of rows) {
      if (gone.has((spec.table === 'books' ? row.id : row.book_id) as string)) continue
      if (await merge(spec, row)) changed = true
    }
    cursor = rows[rows.length - 1].synced_at as string
    await kv.set(cursorKey, cursor)
    if (rows.length < 500) break
  }
  return changed
}

// Purged audio: chapters deleted on the server.
async function pullDeletedChapters(): Promise<boolean> {
  const key = 'cursor:deleted_chapters'
  const since = (await kv.get<string>(key)) ?? '1970-01-01T00:00:00Z'
  const { data: dels, error } = await supabase.from('deleted_chapters').select('book_id,voice,section,synced_at').gt('synced_at', since).order('synced_at').limit(1000)
  if (error) throw error
  if (!dels?.length) return false
  const { deleteLocalChapter } = await import('../audio/cache')
  for (const d of dels) {
    await deleteLocalChapter(d)
    await db.del('chapters', [d.book_id, d.voice, d.section])
  }
  await kv.set(key, dels[dels.length - 1].synced_at)
  return true
}

// One book's place, straight from the server (opening a book: reader.ts).
// Returns whether it changed the local copy; tells the screens only if `tell`.
export async function pullPosition(bookId: string, tell: () => boolean): Promise<boolean> {
  if (demo || !(await userId())) return false
  const { data, error } = await supabase.from('positions').select('*').eq('book_id', bookId).maybeSingle()
  if (error || !data || (await kv.get<string[]>('goneBooks'))?.includes(bookId)) return false
  const changed = await merge(SPECS.find(s => s.table === 'positions')!, data as Record<string, unknown>)
  if (changed && tell()) emit(['positions'])
  return changed
}

async function merge(spec: Spec, row: Record<string, unknown>): Promise<boolean> {
  const key = spec.table === 'narration_chapters' ? [row.book_id, row.voice, row.section] as IDBValidKey
    : spec.table === 'positions' || spec.table === 'narrations' ? row.book_id as string : row.id as string
  const current = await db.get<Local<Record<string, unknown>>>(spec.store, key)
  if (current && current.synced_at === row.synced_at) return false
  if (spec.lww && current?._dirty && String(current.updated_at) >= String(row.updated_at)) {
    // Ours is newer and still to be pushed; take only the columns we never push.
    const worker = NOT_PUSHED[spec.table] ?? []
    if (!worker.length) return false
    const patch = Object.fromEntries(worker.map(k => [k, row[k]]))
    await db.put(spec.store, { ...current, ...patch })
    return true
  }
  // Keep local-only fields (a chapter's downloaded timings, for instance).
  await db.put(spec.store, { ...(current ?? {}), ...row, _dirty: false })
  return true
}

// ---- Removed books ("Sacar de la biblioteca") ----------------------------------

// Every local trace of a removed book goes. Reading sessions stay, without the
// book (time read still counts in Resumen), as the server does (on delete set null).
export async function forgetBook(id: string): Promise<void> {
  const gone = (await kv.get<string[]>('goneBooks')) ?? []
  if (!gone.includes(id)) await kv.set('goneBooks', [...gone, id])
  const { deleteBookAudio } = await import('../audio/cache')
  await deleteBookAudio(id)  // local files first: it walks the chapter rows
  for (const c of await db.byIndex<NarrationChapter>('chapters', 'book_id', id)) await db.del('chapters', [c.book_id, c.voice, c.section])
  for (const h of await db.byIndex<Highlight>('highlights', 'book_id', id)) await db.del('highlights', h.id)
  for (const s of await db.byIndex<Local<ReadingSession>>('sessions', 'book_id', id)) await db.put('sessions', { ...s, book_id: null })
  for (const store of ['narrations', 'positions', 'books'] as const) await db.del(store, id)
  for (const kind of ['epub', 'cover', 'text']) await local.del(`${kind}:${id}`)
  emit(['books', 'positions', 'highlights', 'narrations', 'chapters', 'sessions'])
}

// Removed on another device: the server keeps a log (a pull can't see a deleted row).
async function pullDeletedBooks(): Promise<void> {
  const key = 'cursor:deleted_books'
  const since = (await kv.get<string>(key)) ?? '1970-01-01T00:00:00Z'
  const { data, error } = await supabase.from('deleted_books').select('book_id,synced_at').gt('synced_at', since).order('synced_at').limit(1000)
  if (error) throw error
  if (!data?.length) return
  for (const d of data) await forgetBook(d.book_id)
  await kv.set(key, data[data.length - 1].synced_at)
}

// Removed here, maybe offline. The row first: its delete cascades on the server
// (position, highlights, narration — which also stops the PC — and chapters) and
// tells the other devices. Then the files; if that fails, the next sync retries.
async function pushDeletedBooks(uid: string): Promise<void> {
  for (const id of (await kv.get<string[]>('pendingBookDeletes')) ?? []) {
    const { error } = await supabase.from('books').delete().eq('id', id)
    if (error) throw error
    await library.removeFolder(`${uid}/${id}`)
    await audioBucket.removeFolder(`${uid}/${id}`)
    await kv.set('pendingBookDeletes', ((await kv.get<string[]>('pendingBookDeletes')) ?? []).filter(x => x !== id))
  }
}

// Books imported offline (or whose upload failed) carry _upload until their
// files are in the cloud; only then the row is pushed.
async function uploadPendingBooks(uid: string): Promise<void> {
  const books = (await db.all<Local<Book> & { _upload?: boolean }>('books')).filter(b => b._upload)
  for (const book of books) {
    const epub = await local.get(`epub:${book.id}`)
    if (!epub) continue
    await library.upload(paths.epub(uid, book.id), epub, 'application/epub+zip')
    const cover = await local.get(`cover:${book.id}`)
    if (cover) await library.upload(paths.cover(uid, book.id), cover, 'image/jpeg')
    const text = await local.get(`text:${book.id}`)
    if (text) await library.upload(paths.text(uid, book.id), text, 'application/gzip')
    await db.put('books', { ...book, _upload: false, _dirty: true })
  }
}

// Realtime: a change on one of our tables pulls that table (and, for books and
// chapters, the log of deleted ones) at once. Each (re)connection catches up
// with whatever happened while it was down.
const ON_CHANGE: Record<string, PullKey[]> = {
  books: ['deleted_books', 'books'],
  positions: ['positions'],
  highlights: ['highlights'],
  narrations: ['narrations'],
  narration_chapters: ['narration_chapters', 'deleted_chapters'],
}
let channel: ReturnType<typeof supabase.channel> | null = null
let realtimeUp = false
let me: string | null | undefined  // this device's id (store.ts, deviceId)
export function startRealtime(): void {
  if (channel || demo) return
  const ch = supabase.channel('atril-db')
  channel = ch
  void (async () => {
    me ??= (await kv.get<string>('device')) ?? null
    if (channel !== ch) return  // stopped meanwhile
    for (const [table, keys] of Object.entries(ON_CHANGE)) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table }, payload => {
        // Our own place coming back: nothing new here.
        if (table === 'positions' && me && (payload.new as { device?: string } | null)?.device === me) return
        pullSoon(keys)
      })
    }
    // Called again on every rejoin (the socket reconnects by itself).
    ch.subscribe(status => {
      if (channel !== ch) return  // an old connection closing after a restart
      const up = status === 'SUBSCRIBED'
      if (up && !realtimeUp) pullSoon(ALL_PULLS)
      realtimeUp = up
    })
  })()
}

export async function stopRealtime(): Promise<void> {
  const ch = channel
  channel = null
  realtimeUp = false
  if (ch) await supabase.removeChannel(ch)
}

// A new connection, if one is running (a phone in the background has none).
export async function restartRealtime(): Promise<void> {
  if (!channel) return
  await stopRealtime()
  startRealtime()
}

export async function fetchChapterTimings(ch: Pick<NarrationChapter, 'book_id' | 'voice' | 'section'>): Promise<NarrationChapter['timings']> {
  const { data, error } = await supabase.from('narration_chapters').select('timings')
    .eq('book_id', ch.book_id).eq('voice', ch.voice).eq('section', ch.section).single()
  if (error) throw error
  return data.timings
}
