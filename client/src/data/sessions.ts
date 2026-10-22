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
//
// Reading speed (pace_words / pace_seconds) uses only "clean" stretches of
// reading, judged as the position moves forward. A stretch runs from one
// point to the next once at least PACE.minWords words have been passed, so a
// title page or a sentence that spans two pages joins the next page instead of
// being timed alone (in scrolled mode, the small steps add up the same way).
// It counts when it was read with the app in the foreground, without menus or
// a selection open, with no idle gap, no jump and no going back, and at a
// believable speed: too fast = skimming, too slow = left open or distracted.
// The bounds start fixed and then follow the reader's own habitual speed in
// that language. A too-slow page also counts at most a few times its normal
// reading time in the totals.

import { isAndroid, isTauri } from '../platform'
import { db } from './db'
import { deviceId } from './store'
import { syncSoon } from './sync'
import type { Book, DeviceKind, Local, Manifest, ReadingSession } from './types'

const GAP_MS = { read: 5 * 60_000, listen: 30_000 }
const JUMP_WORDS = { read: 1500, listen: 400 }
const BREAK_MS = 10 * 60_000
const SAVE_MS = 30_000

// Clean pages (reading speed).
export const PACE = {
  minWords: 40,            // fewer words (titles, images): too noisy to time
  fixed: [80, 700],        // words per minute, until the reader's own speed is known
  relative: [0.4, 2.2],    // then: this range around the habitual speed
  absolute: [40, 1200],    // never outside this
  slowTimeFactor: 3,       // a too-slow page counts at most 3× its normal time
  habitualDays: 90,
  habitualMinSeconds: 10 * 60,
}

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

export const langOf = (b: Pick<Book, 'language'> | undefined) => (b?.language ?? 'es').split('-')[0].toLowerCase()

/** Reading speed (words per minute) over the last few months, from clean pages, for books in `lang`. */
export async function habitualPace(lang: string, now = Date.now()): Promise<number | null> {
  const books = new Map((await db.all<Book>('books')).map(b => [b.id, b]))
  let w = 0, s = 0
  for (const x of await sessions.all()) {
    if (x.kind !== 'read' || !x.pace_seconds || Date.parse(x.started_at) < now - PACE.habitualDays * 86400e3) continue
    if (langOf(books.get(x.book_id ?? '')) !== lang) continue
    w += x.pace_words; s += x.pace_seconds
  }
  return s >= PACE.habitualMinSeconds ? w / (s / 60) : null
}

/** Is a page read at `wpm` believable, given the habitual speed (if known)? */
export function cleanPace(wpm: number, habitual: number | null): boolean {
  const [lo, hi] = habitual ? [habitual * PACE.relative[0], habitual * PACE.relative[1]] : PACE.fixed
  return wpm >= Math.max(lo, PACE.absolute[0]) && wpm <= Math.min(hi, PACE.absolute[1])
}

type Row = Local<ReadingSession>

export class SessionTracker {
  private row: Row | null = null
  private last = 0
  private lastWords: number | null = null
  private lastSave = 0
  private interrupted = false
  private anchor: { t: number; w: number } | null = null  // start of the stretch being timed for speed
  private tainted = false

  /** habitual: reading speed in this book's language (habitualPace), null while unknown. */
  constructor(private bookId: string, private wordsAt: (section: number, sentence: number) => number | null, private habitual: number | null = null) {}

  /** The app went to the background: the page being read doesn't count at all. */
  interrupt(): void { this.interrupted = true }

  /** Menus, a selection, a dialog: the page counts as time, not for speed. */
  taint(): void { this.tainted = true }

  /** Something happened: kind of activity and, when known, the sentence reached. */
  async activity(kind: 'read' | 'listen', at?: { section: number; sentence: number }): Promise<void> {
    const now = Date.now()
    if (this.row && (this.row.kind !== kind || now - this.last > BREAK_MS)) await this.close()
    if (!this.row) {
      this.row = {
        id: crypto.randomUUID(), book_id: this.bookId, kind, device: await deviceId(), device_kind: deviceKind(),
        started_at: new Date(now).toISOString(), ended_at: new Date(now).toISOString(), seconds: 0, words: 0,
        pace_words: 0, pace_seconds: 0, updated_at: new Date(now).toISOString(),
      }
      this.last = now
    }
    const r = this.row
    const gap = (now - this.last) / 1000
    const w = at ? this.wordsAt(at.section, at.sentence) : null
    const d = w !== null && this.lastWords !== null ? w - this.lastWords : 0
    const forward = d > 0 && d <= JUMP_WORDS[kind]
    // Reading with the app in the background in between: nothing about that page is known.
    const blind = kind === 'read' && this.interrupted
    this.interrupted = false
    const idle = gap * 1000 > GAP_MS[kind]
    if (!blind && !idle && gap > 0) {
      let t = gap
      // Too slow for the reader: probably not reading the whole time.
      if (kind === 'read' && forward && d >= PACE.minWords && this.habitual && d / (gap / 60) < this.habitual * PACE.relative[0])
        t = Math.min(gap, PACE.slowTimeFactor * d / this.habitual * 60)
      r.seconds += t
      r.ended_at = new Date(now).toISOString()
    }
    if (!blind && forward) r.words += d
    if (kind === 'read' && w !== null) {
      const a = this.anchor
      if (!a || blind || idle || !(forward || d === 0)) this.restart(now, w)
      else if (w - a.w >= PACE.minWords) {
        const dw = w - a.w, dt = (now - a.t) / 1000
        if (!this.tainted && dt > 0 && cleanPace(dw / (dt / 60), this.habitual)) { r.pace_words += dw; r.pace_seconds += dt }
        this.restart(now, w)
      }
    } else if (kind === 'listen') this.anchor = null
    if (w !== null) this.lastWords = w
    this.last = now
    if (now - this.lastSave > SAVE_MS) await this.save()
  }

  private restart(t: number, w: number) { this.anchor = { t, w }; this.tainted = false }

  /** The reader is closing or the app goes to the background. */
  async close(): Promise<void> {
    await this.save()
    this.row = null
  }

  async save(): Promise<void> {
    this.lastSave = Date.now()
    const r = this.row
    if (!r || r.seconds < 1) return
    await db.put('sessions', { ...r, seconds: Math.round(r.seconds), pace_seconds: Math.round(r.pace_seconds), updated_at: new Date().toISOString(), _dirty: true })
    syncSoon(5000)
  }
}
