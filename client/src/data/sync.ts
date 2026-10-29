// Mirror between the local database (db.ts) and Supabase.
//
// Pull: rows whose server-side synced_at is newer than this device's cursor
// (cheap: a quiet library pulls nothing). Push: local rows marked _dirty.
// Conflicts: last writer wins by updated_at, enforced on both ends — locally
// in merge(), on the server by the lww_guard trigger.
//
// Runs on start, when the app comes back to the foreground, every few minutes,
// shortly after a local change, and when Realtime reports a remote change.

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
// Columns the worker owns: never pushed from a device.
const WORKER_FIELDS: Partial<Record<Table, string[]>> = { narrations: ['state', 'current_section', 'error', 'stopped_at'] }

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

let running: Promise<void> | null = null
let again = false
let pushTimer: number | undefined

export function syncSoon(ms = 1500): void {
  clearTimeout(pushTimer)
  pushTimer = window.setTimeout(() => void sync(), ms)
}

export function sync(): Promise<void> {
  if (running) { again = true; return running }
  running = (async () => {
    try {
      do {
        again = false
        await syncOnce()
      } while (again)
      setState('idle')
    } catch (e) {
      console.warn('sync failed', e)
      setState(navigator.onLine ? 'error' : 'offline')
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
  await pull()
}

function strip<T extends object>(row: T, table: Table): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const skip = [...LOCAL_FIELDS, ...(WORKER_FIELDS[table] ?? [])]
  for (const [k, v] of Object.entries(row)) if (!skip.includes(k)) out[k] = v
  return out
}

async function push(): Promise<void> {
  const gone = new Set((await kv.get<string[]>('goneBooks')) ?? [])
  for (const spec of SPECS.filter(s => PUSHED.includes(s.table))) {
    let rows = (await db.all<Local<{ updated_at: string }>>(spec.store)).filter(r => r._dirty && !(r as { _upload?: boolean })._upload)
    if (gone.size) rows = await dropGone(spec.table, rows as Row[], gone)
    if (!rows.length) continue
    const conflict = spec.table === 'positions' || spec.table === 'narrations' ? 'book_id' : 'id'
    const { error } = await supabase.from(spec.table).upsert(rows.map(r => strip(r, spec.table)), { onConflict: conflict })
    if (error) throw error
    // Clear the flag only on rows nobody touched while the request was in flight.
    const key = spec.table === 'positions' || spec.table === 'narrations' ? 'book_id' : 'id'
    for (const row of rows) {
      const current = await db.get<Local<{ updated_at: string }>>(spec.store, (row as Record<string, unknown>)[key] as string)
      if (current && current.updated_at === row.updated_at) await db.put(spec.store, { ...current, _dirty: false })
    }
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

async function pull(): Promise<void> {
  const changed = new Set<StoreName>()
  // A pull racing a removal made here could bring the book back for a moment.
  const gone = new Set((await kv.get<string[]>('goneBooks')) ?? [])
  for (const spec of SPECS) {
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
        if (await merge(spec, row)) changed.add(spec.store)
      }
      cursor = rows[rows.length - 1].synced_at as string
      await kv.set(cursorKey, cursor)
      if (rows.length < 500) break
    }
  }
  // Purged audio: chapters deleted on the server.
  const delKey = 'cursor:deleted_chapters'
  const since = (await kv.get<string>(delKey)) ?? '1970-01-01T00:00:00Z'
  const { data: dels, error } = await supabase.from('deleted_chapters').select('book_id,voice,section,synced_at').gt('synced_at', since).order('synced_at').limit(1000)
  if (error) throw error
  if (dels?.length) {
    const { deleteLocalChapter } = await import('../audio/cache')
    for (const d of dels) {
      await deleteLocalChapter(d)
      await db.del('chapters', [d.book_id, d.voice, d.section])
      changed.add('chapters')
    }
  }
  if (dels?.length) await kv.set(delKey, dels[dels.length - 1].synced_at)
  emit(changed)
}

async function merge(spec: Spec, row: Record<string, unknown>): Promise<boolean> {
  const key = spec.table === 'narration_chapters' ? [row.book_id, row.voice, row.section] as IDBValidKey
    : spec.table === 'positions' || spec.table === 'narrations' ? row.book_id as string : row.id as string
  const current = await db.get<Local<Record<string, unknown>>>(spec.store, key)
  if (current && current.synced_at === row.synced_at) return false
  if (spec.lww && current?._dirty && String(current.updated_at) >= String(row.updated_at)) {
    // Ours is newer and still to be pushed; take only the worker's columns.
    const worker = WORKER_FIELDS[spec.table] ?? []
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

// Realtime: any change on our tables triggers an (incremental) pull.
let channel: ReturnType<typeof supabase.channel> | null = null
export function startRealtime(): void {
  if (channel || demo) return
  channel = supabase.channel('atril-db')
  for (const table of ['books', 'positions', 'highlights', 'narrations', 'narration_chapters', 'worker_status', 'deleted_books'])
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => syncSoon(300))
  channel.subscribe()
}

export async function stopRealtime(): Promise<void> {
  if (channel) await supabase.removeChannel(channel)
  channel = null
}

export async function fetchChapterTimings(ch: Pick<NarrationChapter, 'book_id' | 'voice' | 'section'>): Promise<NarrationChapter['timings']> {
  const { data, error } = await supabase.from('narration_chapters').select('timings')
    .eq('book_id', ch.book_id).eq('voice', ch.voice).eq('section', ch.section).single()
  if (error) throw error
  return data.timings
}
