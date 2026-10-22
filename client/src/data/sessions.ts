// Reading sessions for the stats screen: how long and how much was read or
// listened, per device. The reader reports activity (page turns, the voice's
// progress); this turns it into rows in 'sessions' that sync like the rest.
//
// Time: the gap since the previous activity counts if it is short (reading:
// a page can take a few minutes; listening: reports come every second), longer
// gaps are idle and don't count. After BREAK_MS without activity, or when the
// kind changes, the next activity starts a new session.
// Words: progress through the book's sentence manifest; jumps (TOC, slider,
// seeking) and going back don't count.

import { isAndroid, isTauri } from '../platform'
import { db } from './db'
import { deviceId } from './store'
import { syncSoon } from './sync'
import type { DeviceKind, Local, Manifest, ReadingSession } from './types'

const GAP_MS = { read: 5 * 60_000, listen: 30_000 }
const JUMP_WORDS = { read: 1500, listen: 400 }
const BREAK_MS = 10 * 60_000
const SAVE_MS = 30_000

export const sessions = {
  all: () => db.all<Local<ReadingSession>>('sessions'),
}

export function deviceKind(): DeviceKind {
  if (isTauri || !isAndroid) return 'pc'
  return Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'phone'
}

/** Words before each sentence of the book, from the manifest: wordsAt(section, sentence). */
export function wordIndex(manifest: Manifest | null): (section: number, sentence: number) => number | null {
  if (!manifest) return () => null
  const starts = new Map<number, number[]>()
  let total = 0
  for (const s of manifest.sections) {
    const arr: number[] = []
    for (const x of s.sentences) { arr.push(total); total += x.t.split(/\s+/).filter(Boolean).length }
    starts.set(s.i, arr)
  }
  return (section, sentence) => starts.get(section)?.[sentence] ?? null
}

export class SessionTracker {
  private row: Local<ReadingSession> | null = null
  private last = 0
  private lastWords: number | null = null
  private lastSave = 0

  constructor(private bookId: string, private wordsAt: (section: number, sentence: number) => number | null) {}

  /** Something happened: kind of activity and, when known, the sentence reached. */
  async activity(kind: 'read' | 'listen', at?: { section: number; sentence: number }): Promise<void> {
    const now = Date.now()
    if (this.row && (this.row.kind !== kind || now - this.last > BREAK_MS)) await this.close()
    if (!this.row) {
      this.row = {
        id: crypto.randomUUID(), book_id: this.bookId, kind, device: await deviceId(), device_kind: deviceKind(),
        started_at: new Date(now).toISOString(), ended_at: new Date(now).toISOString(), seconds: 0, words: 0,
        updated_at: new Date(now).toISOString(),
      }
      this.last = now
    }
    const gap = now - this.last
    if (gap > 0 && gap <= GAP_MS[kind]) {
      this.row.seconds += gap / 1000
      this.row.ended_at = new Date(now).toISOString()
    }
    this.last = now
    const w = at ? this.wordsAt(at.section, at.sentence) : null
    if (w !== null) {
      const d = this.lastWords === null ? 0 : w - this.lastWords
      if (d > 0 && d <= JUMP_WORDS[kind]) this.row.words += d
      this.lastWords = w
    }
    if (now - this.lastSave > SAVE_MS) await this.save()
  }

  /** The reader is closing or the app goes to the background. */
  async close(): Promise<void> {
    await this.save()
    this.row = null
  }

  async save(): Promise<void> {
    this.lastSave = Date.now()
    const r = this.row
    if (!r || r.seconds < 1) return
    await db.put('sessions', { ...r, seconds: Math.round(r.seconds), updated_at: new Date().toISOString(), _dirty: true })
    syncSoon(5000)
  }
}
