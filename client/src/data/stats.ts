// Numbers for the "Resumen" screen, computed on the device from the synced
// reading sessions (data/sessions.ts), books, positions and highlights.

import { gunzipJson } from '../book/manifest'
import { kv } from './db'
import { local } from './files'
import { sessions, wordIndex } from './sessions'
import { books, highlights, positions } from './store'
import type { Book, DeviceKind, Manifest, ReadingSession } from './types'

export type Period = 'week' | 'month' | 'year'
export interface Split { read: number; listen: number }
export interface Bucket extends Split { label: string; title: string; current: boolean }

export interface BookStats {
  book: Book
  seconds: number
  first: Date | null
  last: Date | null
  highlights: number
  notes: number
}

export interface Stats {
  empty: boolean
  sessions: ReadingSession[]
  daily: Map<string, Split>                   // local date key → seconds
  finished: Book[]                            // this year, newest first
  goal: number | null
  pace: { read: number | null; listen: number | null }  // words per minute
  rate: number
  left: { book: Book; read: number | null; listen: number | null }[]  // seconds
  hours: number[]                             // seconds per hour of day
  devices: [DeviceKind, number][]             // seconds, most used first
  perBook: BookStats[]
}

export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const splitTotal = (s: Split) => s.read + s.listen
const PACE_DAYS = 90
const PACE_MIN_SECONDS = 10 * 60

export async function loadStats(): Promise<Stats> {
  const all = (await sessions.all()).filter(s => s.seconds > 0)
  const year = new Date().getFullYear()
  const daily = new Map<string, Split>()
  const hours = Array(24).fill(0) as number[]
  const devices = new Map<DeviceKind, number>()
  const byBook = new Map<string, { seconds: number; first: Date; last: Date }>()
  const since = Date.now() - PACE_DAYS * 86400e3
  const pace = { read: [0, 0], listen: [0, 0] }
  for (const s of all) {
    const start = new Date(s.started_at)
    const k = dayKey(start)
    const d = daily.get(k) ?? { read: 0, listen: 0 }
    d[s.kind] += s.seconds
    daily.set(k, d)
    hours[start.getHours()] += s.seconds
    if (s.device_kind) devices.set(s.device_kind, (devices.get(s.device_kind) ?? 0) + s.seconds)
    if (s.book_id) {
      const b = byBook.get(s.book_id)
      const end = new Date(s.ended_at)
      if (!b) byBook.set(s.book_id, { seconds: s.seconds, first: start, last: end })
      else { b.seconds += s.seconds; if (start < b.first) b.first = start; if (end > b.last) b.last = end }
    }
    if (start.getTime() > since && s.words > 0) { pace[s.kind][0] += s.words; pace[s.kind][1] += s.seconds }
  }
  const wpm = ([w, sec]: number[]) => sec >= PACE_MIN_SECONDS ? Math.round(w / (sec / 60)) : null

  const lib = await books.all()
  const hls = await highlights.all()
  const finished = lib.filter(b => b.status === 'finished' && b.finished_at && new Date(b.finished_at).getFullYear() === year)
    .sort((a, b) => b.finished_at!.localeCompare(a.finished_at!))
  const perBook: BookStats[] = lib
    .filter(b => byBook.has(b.id) || b.status !== 'to_read')
    .map(b => {
      const x = byBook.get(b.id)
      const mine = hls.filter(h => h.book_id === b.id)
      return { book: b, seconds: x?.seconds ?? 0, first: x?.first ?? null, last: x?.last ?? (b.finished_at ? new Date(b.finished_at) : null),
        highlights: mine.length, notes: mine.filter(h => h.note).length }
    })
    .sort((a, b) => (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0))

  const p = { read: wpm(pace.read), listen: wpm(pace.listen) }
  const rate = (await kv.get<number>('rate')) ?? 1
  const left: Stats['left'] = []
  for (const b of lib.filter(b => b.status === 'reading')) {
    const words = await wordsLeft(b)
    if (words == null) continue
    left.push({ book: b, read: p.read ? words / p.read * 60 : null, listen: p.listen ? words / p.listen * 60 : null })
  }

  return {
    empty: all.length === 0,
    sessions: all, daily, finished,
    goal: (await kv.get<number>('yearGoal')) ?? null,
    pace: p, rate, left, hours,
    devices: [...devices].sort((a, b) => b[1] - a[1]),
    perBook,
  }
}

export const setGoal = (n: number | null) => kv.set('yearGoal', n)

// Words from the synced position to the end, from the manifest on this device
// (never downloaded just for this).
async function wordsLeft(b: Book): Promise<number | null> {
  try {
    const blob = await local.get(`text:${b.id}`)
    if (!blob) return null
    const m = await gunzipJson<Manifest>(blob)
    const at = wordIndex(m)
    const last = m.sections[m.sections.length - 1]
    const end = (at(last.i, last.sentences.length - 1) ?? 0) + (last.sentences.at(-1)?.t.split(/\s+/).length ?? 0)
    const pos = await positions.get(b.id)
    const here = pos?.section != null ? at(pos.section, pos.sentence ?? 0) ?? 0 : 0
    return Math.max(0, end - here)
  } catch { return null }
}

// ---- Periods ------------------------------------------------------------------

function startOf(p: Period, d = new Date()): Date {
  const x = new Date(d.getFullYear(), p === 'year' ? 0 : d.getMonth(), p === 'year' ? 1 : p === 'month' ? 1 : d.getDate())
  if (p === 'week') x.setDate(x.getDate() - (x.getDay() + 6) % 7)  // Monday
  return x
}

function shift(p: Period, d: Date, n: number): Date {
  const x = new Date(d)
  if (p === 'week') x.setDate(x.getDate() + 7 * n)
  else if (p === 'month') x.setMonth(x.getMonth() + n)
  else x.setFullYear(x.getFullYear() + n)
  return x
}

function sum(st: Stats, from: Date, to: Date): Split {
  const out = { read: 0, listen: 0 }
  for (const s of st.sessions) {
    const t = new Date(s.started_at)
    if (t >= from && t < to) out[s.kind] += s.seconds
  }
  return out
}

/** This period so far, and the previous one up to the same point. */
export function periodTotals(st: Stats, p: Period): { now: Split; before: Split } {
  const from = startOf(p)
  const now = new Date()
  const prevFrom = shift(p, from, -1)
  return { now: sum(st, from, now), before: sum(st, prevFrom, new Date(prevFrom.getTime() + (now.getTime() - from.getTime()))) }
}

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
export const fmtDate = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`

/** Bars for the period: days of the week or month, months of the year. */
export function periodBuckets(st: Stats, p: Period): Bucket[] {
  const from = startOf(p)
  const today = dayKey(new Date())
  if (p === 'year') return MONTHS.map((m, i) => {
    const s = sum(st, new Date(from.getFullYear(), i, 1), new Date(from.getFullYear(), i + 1, 1))
    return { ...s, label: m[0].toUpperCase(), title: m, current: i === new Date().getMonth() }
  })
  const out: Bucket[] = []
  const end = shift(p, from, 1)
  for (let d = new Date(from), i = 0; d < end; d.setDate(d.getDate() + 1), i++) {
    const k = dayKey(d)
    const s = st.daily.get(k) ?? { read: 0, listen: 0 }
    out.push({ ...s, label: p === 'week' ? WEEKDAYS[i] : (d.getDate() === 1 || d.getDate() % 5 === 0 ? String(d.getDate()) : ''),
      title: fmtDate(d), current: k === today })
  }
  return out
}
