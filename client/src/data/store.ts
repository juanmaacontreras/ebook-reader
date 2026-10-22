// App-level operations on the local database. Every write marks the row dirty
// and schedules a sync; screens re-render from onChange() events.

import { db, kv } from './db'
import { audioBucket, local } from './files'
import { emit, syncSoon } from './sync'
import { supabase } from './supabase'
import { prefs } from '../settings'
import { defaultVoice } from '../audio/voices'
import type { Book, BookStatus, Highlight, HighlightColor, Local, Narration, NarrationChapter, Position, WorkerStatus } from './types'

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
    emit(['books'])
    syncSoon()
    if (status === 'finished') await purgeAudio(id)
    if (status === 'reading') await autoNarrate(id)
  },
  async edit(id: string, patch: { title: string; author: string | null }): Promise<void> {
    const b = await books.get(id)
    if (!b || (b.title === patch.title && b.author === patch.author)) return
    await db.put('books', { ...b, ...patch, updated_at: now(), _dirty: true })
    emit(['books'])
    syncSoon()
  },
}

// "Generar audio solo": a book that becomes "reading" gets a narration request
// with the default voice for its language, starting where the user is.
export async function autoNarrate(bookId: string): Promise<void> {
  if (!prefs().autoNarrate) return
  const [b, existing] = await Promise.all([books.get(bookId), narration.get(bookId)])
  if (!b || b.status !== 'reading' || existing || !b.text_path) return
  const pos = await positions.get(bookId)
  await narration.request(bookId, defaultVoice((b.language ?? 'es').split('-')[0]), pos?.section ?? null)
}

// Books already in "reading" (on start, or when the setting is turned on).
export async function autoNarrateAll(): Promise<void> {
  if (!prefs().autoNarrate) return
  for (const b of await books.all()) if (b.status === 'reading') await autoNarrate(b.id)
}

export const positions = {
  get: (bookId: string) => db.get<Local<Position>>('positions', bookId),
  all: () => db.all<Local<Position>>('positions'),
  async save(p: Omit<Position, 'updated_at' | 'device'>): Promise<void> {
    const cur = await positions.get(p.book_id)
    if (cur && cur.cfi === p.cfi) return
    await db.put('positions', { ...p, device: await deviceId(), updated_at: now(), _dirty: true })
    syncSoon(3000)
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
    syncSoon()
    return row
  },
  async update(id: string, patch: Partial<Pick<Highlight, 'color' | 'note' | 'deleted'>>): Promise<void> {
    const cur = await db.get<Local<Highlight>>('highlights', id)
    if (!cur) return
    await db.put('highlights', { ...cur, ...patch, updated_at: now(), _dirty: true })
    emit(['highlights'])
    syncSoon()
  },
  remove: (id: string) => highlights.update(id, { deleted: true }),
}

export const narration = {
  get: (bookId: string) => db.get<Local<Narration>>('narrations', bookId),
  async chapters(bookId: string): Promise<NarrationChapter[]> {
    return db.byIndex<NarrationChapter>('chapters', 'book_id', bookId)
  },
  async request(bookId: string, voice: string, startSection: number | null): Promise<void> {
    const cur = await narration.get(bookId)
    const t = now()
    const row: Local<Narration> = {
      book_id: bookId, voice, status: 'active', start_section: startSection, priority_section: null,
      requested_at: cur && cur.voice === voice ? cur.requested_at : t, updated_at: t,
      state: cur && cur.voice === voice ? cur.state : 'waiting', current_section: null, error: null, _dirty: true,
    }
    await db.put('narrations', row)
    emit(['narrations'])
    syncSoon(200)
  },
  async prioritize(bookId: string, section: number): Promise<void> {
    const cur = await narration.get(bookId)
    if (!cur || (cur.priority_section === section && cur.status === 'active')) return
    await db.put('narrations', { ...cur, priority_section: section, status: 'active', updated_at: now(), _dirty: true })
    emit(['narrations'])
    syncSoon(200)
  },
  async setPaused(bookId: string, paused: boolean): Promise<void> {
    const cur = await narration.get(bookId)
    if (!cur) return
    await db.put('narrations', { ...cur, status: paused ? 'paused' : 'active', updated_at: now(), _dirty: true })
    emit(['narrations'])
    syncSoon(200)
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
  await deleteBookAudio(bookId)
}

export async function workerStatus(): Promise<WorkerStatus | null> {
  const { data } = await supabase.from('worker_status').select('heartbeat,voices,current,audio_bytes').maybeSingle()
  return (data as WorkerStatus | null) ?? null
}

export async function hasLocalEpub(bookId: string): Promise<boolean> {
  return local.has(`epub:${bookId}`)
}
