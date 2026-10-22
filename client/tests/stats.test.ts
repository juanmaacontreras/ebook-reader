import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/data/db', () => ({ db: {}, kv: {} }))
vi.mock('../src/data/files', () => ({ local: {} }))
vi.mock('../src/data/store', () => ({ books: {}, highlights: {}, positions: {} }))
vi.mock('../src/data/sync', () => ({ syncSoon: () => {} }))

const { langPace } = await import('../src/data/stats')
import type { ReadingSession } from '../src/data/types'

const NOW = new Date('2026-10-22T12:00:00').getTime()
const DAY = 86400e3
// A session `daysAgo` with `minutes` of clean reading at `wpm`.
const s = (daysAgo: number, minutes: number, wpm: number): ReadingSession => ({
  id: String(Math.random()), book_id: 'b', kind: 'read', device: null, device_kind: null,
  started_at: new Date(NOW - daysAgo * DAY).toISOString(), ended_at: '', seconds: minutes * 60, words: 0,
  pace_words: wpm * minutes, pace_seconds: minutes * 60, updated_at: '',
})

describe('langPace', () => {
  it('compares the last 30 days with 3 months earlier', () => {
    const p = langPace('es', [s(100, 30, 200), s(10, 30, 250)], NOW)
    expect(p).toMatchObject({ now: 250, before: 200, beforeKind: 'months3', monthly: false })
  })

  it('falls back to the first month when there is nothing 3 months back', () => {
    const p = langPace('es', [s(70, 30, 220), s(10, 30, 240)], NOW)
    expect(p).toMatchObject({ now: 240, before: 220, beforeKind: 'start' })
  })

  it('needs 10 minutes for a number and 20 for a point in the chart', () => {
    const p = langPace('es', [s(10, 5, 250)], NOW)
    expect(p.now).toBeNull()
    const q = langPace('es', [s(3, 15, 250), s(10, 25, 230), s(17, 25, 210)], NOW)
    expect(q.now).toBe(Math.round((15 * 250 + 25 * 230 + 25 * 210) / 65))
    expect(q.series.map(x => x.wpm)).toEqual([210, 230])
  })

  it('switches to monthly points after half a year', () => {
    const p = langPace('es', [s(250, 30, 200), s(220, 30, 210), s(10, 30, 250)], NOW)
    expect(p.monthly).toBe(true)
    expect(p.series).toHaveLength(3)
  })
})
