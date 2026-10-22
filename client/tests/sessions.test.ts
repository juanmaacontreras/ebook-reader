import { beforeEach, describe, expect, it, vi } from 'vitest'

const saved: Record<string, unknown>[] = []
vi.mock('../src/data/db', () => ({ db: { put: async (_s: string, row: Record<string, unknown>) => { saved.push(row) }, all: async () => [] } }))
vi.mock('../src/data/store', () => ({ deviceId: async () => 'dev1' }))
vi.mock('../src/data/sync', () => ({ syncSoon: () => {} }))

const { SessionTracker, wordIndex } = await import('../src/data/sessions')

const manifest = {
  v: 1 as const, lang: 'es',
  sections: [
    { i: 0, label: 'Uno', sentences: [{ c: '', t: 'Una dos tres.', b: 0 }, { c: '', t: 'Cuatro cinco.', b: 0 }] },
    { i: 2, label: 'Dos', sentences: [{ c: '', t: 'Seis siete ocho nueve.', b: 0 }] },
  ],
}

describe('wordIndex', () => {
  it('counts the words before each sentence across sections', () => {
    const at = wordIndex(manifest)
    expect([at(0, 0), at(0, 1), at(2, 0), at(1, 0)]).toEqual([0, 3, 5, null])
  })
})

describe('SessionTracker', () => {
  beforeEach(() => { saved.length = 0; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T21:00:00Z')) })

  it('counts short gaps and forward progress, not idle time or jumps', async () => {
    const tr = new SessionTracker('b1', wordIndex(manifest))
    await tr.activity('read', { section: 0, sentence: 0 })
    vi.advanceTimersByTime(60_000)
    await tr.activity('read', { section: 0, sentence: 1 })   // +60 s, +3 words
    vi.advanceTimersByTime(7 * 60_000)
    await tr.activity('read', { section: 2, sentence: 0 })   // idle gap: no time; +2 words
    await tr.close()
    const row = saved.at(-1)!
    expect(row.kind).toBe('read')
    expect(row.seconds).toBe(60)
    expect(row.words).toBe(5)
  })

  it('starts a new session after a long break or when the kind changes', async () => {
    const tr = new SessionTracker('b1', () => null)
    await tr.activity('read')
    vi.advanceTimersByTime(30_000)
    await tr.activity('read')
    vi.advanceTimersByTime(1000)
    await tr.activity('listen')
    vi.advanceTimersByTime(20_000)
    await tr.activity('listen')
    await tr.close()
    const ids = new Set(saved.map(r => r.id))
    expect(ids.size).toBe(2)
    expect(saved.find(r => r.kind === 'listen')!.seconds).toBe(20)
  })
})
