// Numbers for the "Resumen" screen, computed on the device from the synced
// reading sessions (data/sessions.ts), books, positions and highlights.

import { gunzipJson } from '../book/manifest'
import { kv } from './db'
import { local } from './files'
import { langOf, PACE, sessions, wordIndex } from './sessions'
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
  wpm: number | null          // clean pages of this book
}

// Reading speed in one language: now (last 30 days, or 90 if that's too little),
// a reference to compare with (3 months earlier, else the first month with
// data) and its evolution week by week (month by month after half a year).
export interface LangPace {
  lang: string
  now: number | null
  before: number | null
  beforeKind: 'months3' | 'start'
  series: { start: Date; wpm: number; minutes: number }[]
  monthly: boolean
}

export interface Stats {
  empty: boolean
  sessions: ReadingSession[]
  daily: Map<string, Split>                   // local date key → seconds
  finished: Book[]                            // this year, newest first
  goal: number | null
  pace: { read: LangPace[]; listen: number | null }  // words per minute; read per language, most read first
  rate: number
  left: { book: Book; read: number | null; listen: number | null }[]  // seconds
  hours: number[]                             // seconds per hour of day
  devices: [DeviceKind, number][]             // seconds, most used first
  perBook: BookStats[]
}

export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const splitTotal = (s: Split) => s.read + s.listen
const DAY = 86400e3
const PACE_MIN_SECONDS = 10 * 60     // a speed needs at least this much clean reading
const POINT_MIN_SECONDS = 20 * 60    // a week (or month) in the chart too

export async function loadStats(): Promise<Stats> {
  const all = (await sessions.all()).filter(s => s.seconds > 0)
  const year = new Date().getFullYear()
  const daily = new Map<string, Split>()
  const hours = Array(24).fill(0) as number[]
  const devices = new Map<DeviceKind, number>()
  const byBook = new Map<string, { seconds: number; first: Date; last: Date }>()
  const since = Date.now() - PACE.habitualDays * DAY
  const listen = [0, 0]
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
    if (s.kind === 'listen' && start.getTime() > since && s.words > 0) { listen[0] += s.words; listen[1] += s.seconds }
  }
  const wpm = ([w, sec]: number[]) => sec >= PACE_MIN_SECONDS ? Math.round(w / (sec / 60)) : null

  const lib = await books.all()
  const bookById = new Map(lib.map(b => [b.id, b]))
  const clean = all.filter(s => s.kind === 'read' && s.pace_seconds > 0 && s.book_id && bookById.has(s.book_id))
  const langs = new Map<string, ReadingSession[]>()
  for (const s of clean) {
    const l = langOf(bookById.get(s.book_id!))
    langs.set(l, [...(langs.get(l) ?? []), s])
  }
  const read = [...langs].map(([l, ss]) => langPace(l, ss))
    .sort((a, b) => clean.filter(s => langOf(bookById.get(s.book_id!)) === b.lang).length - clean.filter(s => langOf(bookById.get(s.book_id!)) === a.lang).length)
  const bookPace = (id: string) => wpm(clean.filter(s => s.book_id === id).reduce((a, s) => [a[0] + s.pace_words, a[1] + s.pace_seconds], [0, 0]))
  const hls = await highlights.all()
  const finished = lib.filter(b => b.status === 'finished' && b.finished_at && new Date(b.finished_at).getFullYear() === year)
    .sort((a, b) => b.finished_at!.localeCompare(a.finished_at!))
  const perBook: BookStats[] = lib
    .filter(b => byBook.has(b.id) || b.status !== 'to_read')
    .map(b => {
      const x = byBook.get(b.id)
      const mine = hls.filter(h => h.book_id === b.id)
      return { book: b, seconds: x?.seconds ?? 0, first: x?.first ?? null, last: x?.last ?? (b.finished_at ? new Date(b.finished_at) : null),
        highlights: mine.length, notes: mine.filter(h => h.note).length, wpm: bookPace(b.id) }
    })
    .sort((a, b) => (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0))

  const p = { read, listen: wpm(listen) }
  const habitual = (b: Book) => {
    const ss = langs.get(langOf(b)) ?? []
    return wpm(ss.filter(s => Date.parse(s.started_at) > since).reduce((a, s) => [a[0] + s.pace_words, a[1] + s.pace_seconds], [0, 0]))
  }
  const rate = (await kv.get<number>('rate')) ?? 1
  const left: Stats['left'] = []
  for (const b of lib.filter(b => b.status === 'reading')) {
    const words = await wordsLeft(b)
    if (words == null) continue
    const r = habitual(b)
    left.push({ book: b, read: r ? words / r * 60 : null, listen: p.listen ? words / p.listen * 60 : null })
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

function langPace(lang: string, ss: ReadingSession[], now = Date.now()): LangPace {
  const win = (from: number, to: number) => {
    let w = 0, sec = 0
    for (const s of ss) { const t = Date.parse(s.started_at); if (t >= from && t < to) { w += s.pace_words; sec += s.pace_seconds } }
    return sec >= PACE_MIN_SECONDS ? Math.round(w / (sec / 60)) : null
  }
  const current = win(now - 30 * DAY, now) ?? win(now - 90 * DAY, now)
  let before = win(now - 120 * DAY, now - 90 * DAY)
  let beforeKind: LangPace['beforeKind'] = 'months3'
  const first = Math.min(...ss.map(s => Date.parse(s.started_at)))
  if (before === null && first < now - 60 * DAY) { before = win(first, first + 30 * DAY); beforeKind = 'start' }
  // Weekly points for the last half year; monthly when the history is longer.
  const monthly = first < now - 182 * DAY
  const buckets = new Map<number, { start: Date; w: number; s: number }>()
  for (const s of ss) {
    const d = new Date(s.started_at)
    const start = monthly ? new Date(d.getFullYear(), d.getMonth(), 1) : new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7)
    const b = buckets.get(start.getTime()) ?? { start, w: 0, s: 0 }
    b.w += s.pace_words; b.s += s.pace_seconds
    buckets.set(start.getTime(), b)
  }
  const series = [...buckets.values()].filter(b => b.s >= POINT_MIN_SECONDS)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(monthly ? -24 : -26)
    .map(b => ({ start: b.start, wpm: Math.round(b.w / (b.s / 60)), minutes: Math.round(b.s / 60) }))
  return { lang, now: current, before, beforeKind, series, monthly }
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
