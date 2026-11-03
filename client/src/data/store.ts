// App-level operations on the local database. Every write marks the row dirty
// and is pushed right away (sync.ts, pushSoon); screens re-render from
// onChange() events.

import { db, kv } from './db'
import { audioBucket, loadManifest, local } from './files'
import { emit, forgetBook, localWrite, pullPosition, pushSoon } from './sync'
import { demo, supabase } from './supabase'
import { audioManager } from '../platform'
import type { Book, BookStatus, Highlight, HighlightColor, Local, Narration, NarrationChapter, NarrationScope, Position, WorkerStatus } from './types'

const now = () => new Date().toISOString()

export async function deviceId(): Promise<string> {
  let id = await kv.get<string>('device')
  if (!id) {
    id = crypto.randomUUID().slice(0, 8)
    await kv.set('device', id)
  }
  return id
}

export const books = {
  all: () => db.all<Local<Book>>('books'),
  get: (id: string) => db.get<Local<Book>>('books', id),
  async setStatus(id: string, status: BookStatus): Promise<void> {
    const b = await books.get(id)
    if (!b || b.status === status) return
    await db.put('books', { ...b, status, finished_at: status === 'finished' ? now() : null, updated_at: now(), _dirty: true })
    // "Por leer" starts the book over, here, on every device and on the Kobo
    // (user decision 2026-11-02): the library says "Sin empezar".
    if (status === 'to_read') await positions.restart(b)
    emit(status === 'to_read' ? ['books', 'positions'] : ['books'])
    pushSoon()
    // Finishing a book doesn't delete audio here: the PC's worker does it a day
    // later (a mistaken "terminado" can be undone meanwhile), and every device
    // drops its copy when the cloud one goes (deleted_chapters, sync.ts).
  },
  async edit(id: string, patch: { title: string; author: string | null }): Promise<void> {
    const b = await books.get(id)
    if (!b || (b.title === patch.title && b.author === patch.author)) return
    await db.put('books', { ...b, ...patch, updated_at: now(), _dirty: true })
    emit(['books'])
    pushSoon()
  },
  // "Sacar de la biblioteca": gone from this device now, from the cloud and the
  // other devices on the next sync (sync.ts, pushDeletedBooks → deleted_books).
  async remove(id: string): Promise<void> {
    const pending = (await kv.get<string[]>('pendingBookDeletes')) ?? []
    if (!pending.includes(id)) await kv.set('pendingBookDeletes', [...pending, id])
    await forgetBook(id)
    pushSoon()
  },
}

export const positions = {
  get: (bookId: string) => db.get<Local<Position>>('positions', bookId),
  all: () => db.all<Local<Position>>('positions'),
  // Reading: pushed at once (a page turned is where another device should
  // open). Listening: every 10 s, and at once when the voice stops (reader.ts).
  save(p: Omit<Position, 'updated_at' | 'device'>, how: 'read' | 'listen' = 'read'): Promise<void> {
    return localWrite((async () => {
      const cur = await positions.get(p.book_id)
      if (cur && cur.cfi === p.cfi) return
      // The newest place this device had seen from the server; moves of its own
      // not sent yet carry that same knowledge forward.
      const base = cur ? (cur._dirty ? cur.base ?? null : cur.updated_at) : null
      await db.put('positions', { ...p, base, device: await deviceId(), updated_at: now(), _dirty: true })
      pushSoon(how === 'listen' ? 10_000 : 0)
    })())
  },
  // Back to the book's first sentence of text ("Por leer"). A decision, not a
  // page turned: it goes over a newer place from another device (no base).
  // Without the book's text here (offline, never downloaded) the place stays.
  async restart(book: Book): Promise<void> {
    const first = (await loadManifest(book))?.sections.find(s => s.sentences.length)
    if (!first) return
    const cur = await positions.get(book.id)
    if (cur && cur.section === first.i && cur.sentence === 0) return
    await localWrite((async () => {
      await db.put('positions', {
        book_id: book.id, cfi: first.sentences[0].c, section: first.i, sentence: 0, fraction: 0,
        base: null, device: await deviceId(), updated_at: now(), _dirty: true,
      })
    })())
  },
  // Opening a book: the place on the server too (newest wins), so the book opens
  // where another device left it without waiting for a sync. Waits at most
  // `wait` ms; an answer after that still arrives, as a change (the "Ir" offer).
  // (Not gated on navigator.onLine: it lags behind a reconnection; offline,
  // the request fails at once.)
  async fresh(bookId: string, wait = 1500): Promise<Local<Position> | undefined> {
    if (!demo) {
      let waiting = true
      const got = pullPosition(bookId, () => !waiting).catch(() => false)
      await Promise.race([got, new Promise(r => setTimeout(r, wait))])
      waiting = false
    }
    return positions.get(bookId)
  },
}

export const highlights = {
  async forBook(bookId: string): Promise<Local<Highlight>[]> {
    return (await db.byIndex<Local<Highlight>>('highlights', 'book_id', bookId)).filter(h => !h.deleted)
  },
  async all(): Promise<Local<Highlight>[]> {
    return (await db.all<Local<Highlight>>('highlights')).filter(h => !h.deleted)
  },
  async add(h: { book_id: string; cfi: string; text: string; color: HighlightColor; section: number | null; chapter: string | null; note?: string | null }): Promise<Highlight> {
    const row: Local<Highlight> = { id: crypto.randomUUID(), note: null, ...h, deleted: false, created_at: now(), updated_at: now(), _dirty: true }
    await db.put('highlights', row)
    emit(['highlights'])
    pushSoon()
    return row
  },
  async update(id: string, patch: Partial<Pick<Highlight, 'color' | 'note' | 'deleted'>>): Promise<void> {
    const cur = await db.get<Local<Highlight>>('highlights', id)
    if (!cur) return
    await db.put('highlights', { ...cur, ...patch, updated_at: now(), _dirty: true })
    emit(['highlights'])
    pushSoon()
  },
  remove: (id: string) => highlights.update(id, { deleted: true }),
}

// Narration happens only on purpose (CLAUDE.md, 2026-10-28): a job runs from
// the user's "Generar ahora" until it's done or someone stops it — "Parar" in
// the app (status) or on the PC's Waybar (the worker's stopped_at).
export function jobRunning(n: Narration | null | undefined): boolean {
  if (!n || n.status !== 'active' || n.scope === 'ahead' || !n.started_at) return false
  return !n.stopped_at || Date.parse(n.stopped_at) < Date.parse(n.started_at)
}

export const NEXT_CHAPTERS = 3  // tts-worker/worker/jobs.py

// The chapters a job covers, from its start (same rule as the worker's job_sections).
export function jobSections(n: Pick<Narration, 'scope' | 'start_section'>, sections: number[]): number[] {
  if (!sections.length) return []
  let k = sections.findIndex(s => n.start_section != null && s >= n.start_section)
  if (k < 0) k = 0
  if (n.scope === 'chapter') return [sections[k]]
  if (n.scope === 'next') return sections.slice(k, k + NEXT_CHAPTERS)
  return [...sections.slice(k), ...sections.slice(0, k)]
}

export const narration = {
  get: (bookId: string) => db.get<Local<Narration>>('narrations', bookId),
  async chapters(bookId: string): Promise<NarrationChapter[]> {
    return db.byIndex<NarrationChapter>('chapters', 'book_id', bookId)
  },
  // "Generar ahora" (desktop only): what, from which chapter, with which voice.
  async start(bookId: string, voice: string, startSection: number | null, scope: NarrationScope): Promise<void> {
    if (!audioManager) return  // a phone never starts the PC
    const cur = await narration.get(bookId)
    const t = now()
    const row: Local<Narration> = {
      book_id: bookId, voice, status: 'active', scope, start_section: startSection, priority_section: null,
      // Re-asking while it runs keeps its place in the queue; anything else goes last.
      requested_at: jobRunning(cur) && cur ? cur.requested_at : t, started_at: t, updated_at: t,
      state: cur && cur.voice === voice && cur.state === 'generating' ? 'generating' : 'waiting',
      current_section: null, stopped_at: cur?.stopped_at ?? null, error: null, _dirty: true,
    }
    await db.put('narrations', row)
    emit(['narrations'])
    pushSoon()
  },
  async prioritize(bookId: string, section: number): Promise<void> {
    // Only reorders a job that is running and covers that chapter; never starts one.
    if (!audioManager) return
    const cur = await narration.get(bookId)
    if (!jobRunning(cur) || !cur || cur.priority_section === section) return
    await db.put('narrations', { ...cur, priority_section: section, updated_at: now(), _dirty: true })
    emit(['narrations'])
    pushSoon()
  },
  // Move to the front of the PC's queue (it takes the oldest request first).
  async putFirst(bookId: string): Promise<void> {
    const all = await db.all<Local<Narration>>('narrations')
    const cur = all.find(n => n.book_id === bookId)
    if (!cur) return
    const first = Math.min(...all.map(n => Date.parse(n.requested_at)))
    await db.put('narrations', { ...cur, requested_at: new Date(first - 1000).toISOString(), updated_at: now(), _dirty: true })
    emit(['narrations'])
    pushSoon()
  },
  // Free the cloud and this device; the row stays (stopped) with its voice.
  async deleteAudio(bookId: string): Promise<void> {
    await narration.stop(bookId)
    await purgeAudio(bookId)
    emit(['chapters', 'narrations'])
  },
  // "Parar": allowed on every device (stopping only frees the PC's GPU).
  async stop(bookId: string): Promise<void> {
    const cur = await narration.get(bookId)
    if (!cur || cur.status === 'paused') return
    await db.put('narrations', { ...cur, status: 'paused', updated_at: now(), _dirty: true })
    emit(['narrations'])
    pushSoon()
  },
}

// Finishing a book frees its audio in the cloud right away (the worker sweeps
// too, in case this device was offline) and on this device.
async function purgeAudio(bookId: string): Promise<void> {
  const chs = await narration.chapters(bookId)
  try {
    if (chs.length) await audioBucket.remove(chs.map(c => c.audio_path))
    await supabase.from('narration_chapters').delete().eq('book_id', bookId)
  } catch (e) {
    console.warn('purge failed, the worker will retry', e)
  }
  const { deleteBookAudio } = await import('../audio/cache')
  await deleteBookAudio(bookId)  // local files first: it walks the chapter rows
  for (const c of chs) await db.del('chapters', [c.book_id, c.voice, c.section])
}

export async function workerStatus(): Promise<WorkerStatus | null> {
  if (demo) return (window as unknown as { __atrilWs?: WorkerStatus }).__atrilWs ?? null  // screenshots
  const { data } = await supabase.from('worker_status').select('*').maybeSingle()
  return (data as WorkerStatus | null) ?? null
}

export async function hasLocalEpub(bookId: string): Promise<boolean> {
  return local.has(`epub:${bookId}`)
}
