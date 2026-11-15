import { beforeEach, describe, expect, it, vi } from 'vitest'

const saved: Record<string, unknown>[] = []
vi.mock('../src/data/db', () => ({ db: { put: async (_s: string, row: Record<string, unknown>) => { saved.push(row) }, all: async () => [] } }))
vi.mock('../src/data/store', () => ({ deviceId: async () => 'dev1' }))
vi.mock('../src/data/sync', () => ({ pushSoon: () => {} }))

const { SessionTracker, cleanPace, withEreaderPace, wordIndex } = await import('../src/data/sessions')
import type { ReadingSession } from '../src/data/types'

// One sentence of 100 words per "page", in two sections; then short ones.
const words = (n: number) => Array(n).fill('palabra').join(' ') + '.'
const manifest = {
  v: 1 as const, lang: 'es',
  sections: [
    { i: 0, label: 'Uno', sentences: Array.from({ length: 30 }, () => ({ c: '', t: words(100), b: 0 })) },
    { i: 2, label: 'Dos', sentences: [{ c: '', t: 'Seis siete ocho nueve.', b: 0 }, ...Array.from({ length: 40 }, () => ({ c: '', t: words(10), b: 0 }))] },
  ],
}
const last = () => saved.at(-1)!

describe('wordIndex', () => {
  it('counts the words before each sentence across sections', () => {
    const at = wordIndex(manifest)
    expect([at(0, 0), at(0, 1), at(2, 0), at(1, 0)]).toEqual([0, 100, 3000, null])
  })
})

describe('cleanPace', () => {
  it('uses fixed bounds until the habitual speed is known, then relative ones', () => {
    expect([cleanPace(60, null), cleanPace(250, null), cleanPace(800, null)]).toEqual([false, true, false])
    expect([cleanPace(110, 300), cleanPace(130, 300), cleanPace(650, 300), cleanPace(670, 300)]).toEqual([false, true, true, false])
  })
})

describe('SessionTracker', () => {
  beforeEach(() => { saved.length = 0; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T21:00:00Z')) })
  const page = async (tr: InstanceType<typeof SessionTracker>, k: number, after: number) => {
    vi.advanceTimersByTime(after)
    await tr.activity('read', { section: 0, sentence: k })
  }

  it('times normal pages for the speed', async () => {
    const tr = new SessionTracker('b1', wordIndex(manifest))
    await page(tr, 0, 0)
    await page(tr, 1, 24_000)   // 100 words in 24 s = 250 wpm
    await page(tr, 2, 30_000)   // 200 wpm
    await tr.close()
    expect(last()).toMatchObject({ seconds: 54, words: 200, pace_words: 200, pace_seconds: 54 })
  })

  it('leaves skimmed pages out of the speed', async () => {
    const tr = new SessionTracker('b1', wordIndex(manifest))
    await page(tr, 0, 0)
    await page(tr, 1, 24_000)
    for (let k = 2; k < 12; k++) await page(tr, k, 1500)   // 4000 wpm: flipping
    await tr.close()
    expect(last()).toMatchObject({ pace_words: 100, pace_seconds: 24 })
  })

  it('leaves a page left open out of the speed and caps its time once the speed is known', async () => {
    const tr = new SessionTracker('b1', wordIndex(manifest), 250)
    await page(tr, 0, 0)
    await page(tr, 1, 24_000)
    await page(tr, 2, 4 * 60_000)   // 25 wpm: distracted
    await tr.close()
    // 24 s + at most 3× the normal 24 s for the slow page
    expect(last()).toMatchObject({ seconds: 24 + 72, pace_words: 100, pace_seconds: 24 })
  })

  it('ignores a page read with the app in the background in between', async () => {
    const tr = new SessionTracker('b1', wordIndex(manifest))
    await page(tr, 0, 0)
    await page(tr, 1, 24_000)
    tr.interrupt()
    await page(tr, 2, 60_000)
    await page(tr, 3, 30_000)
    await tr.close()
    expect(last()).toMatchObject({ seconds: 54, words: 200, pace_words: 200, pace_seconds: 54 })
  })

  it('times a sentence that spans two pages together with the next page', async () => {
    const tr = new SessionTracker('b1', wordIndex(manifest))
    await page(tr, 0, 0)
    await page(tr, 0, 24_000)   // next page still starts inside sentence 0
    await page(tr, 1, 24_000)   // 100 words over both pages: 48 s
    await tr.close()
    expect(last()).toMatchObject({ seconds: 48, pace_words: 100, pace_seconds: 48 })
  })

  it('adds up small steps (scrolling, title pages) until there are enough words', async () => {
    const tr = new SessionTracker('b1', wordIndex(manifest))
    const at = async (k: number, after: number) => { vi.advanceTimersByTime(after); await tr.activity('read', { section: 2, sentence: k }) }
    await at(0, 0)
    for (let k = 1; k <= 9; k++) await at(k, 2500)   // 4 + 8×10 = 84 words in 22.5 s = 224 wpm
    await tr.close()
    expect(last()).toMatchObject({ pace_words: 84, pace_seconds: 23 })   // stored in whole seconds
  })

  it('leaves out of the speed a page where the menus or a selection were opened', async () => {
    const tr = new SessionTracker('b1', wordIndex(manifest))
    await page(tr, 0, 0)
    await page(tr, 1, 24_000)
    tr.taint()
    await page(tr, 2, 40_000)
    await page(tr, 3, 24_000)
    await tr.close()
    expect(last()).toMatchObject({ seconds: 88, pace_words: 200, pace_seconds: 48 })
  })

  it('doesn\'t count jumps or going back as words', async () => {
    const tr = new SessionTracker('b1', wordIndex(manifest))
    await page(tr, 0, 0)
    await page(tr, 25, 5000)   // jump of 2500 words
    await page(tr, 24, 5000)   // back
    await tr.close()
    expect(last()).toMatchObject({ words: 0, pace_words: 0 })
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
    expect(new Set(saved.map(r => r.id)).size).toBe(2)
    expect(saved.find(r => r.kind === 'listen')!.seconds).toBe(20)
  })
})

describe('withEreaderPace', () => {
  const T0 = Date.parse('2026-11-10T20:00:00Z')
  const NOW = T0 + 86400e3
  // A Kobo report: `minutes` read ending `endMin` minutes after T0, `words` passed.
  const kobo = (endMin: number, minutes: number, words: number, book = 'b'): ReadingSession => ({
    id: `${book}${endMin}`, book_id: book, kind: 'read', device: 'kobo:1', device_kind: 'ereader',
    started_at: new Date(T0 + (endMin - minutes) * 60_000).toISOString(), ended_at: new Date(T0 + endMin * 60_000).toISOString(),
    seconds: minutes * 60, words, pace_words: 0, pace_seconds: 0, updated_at: '',
  })
  const app = (minutes: number, wpm: number): ReadingSession => ({
    ...kobo(-600, minutes, 0), id: 'app', device: 'p', device_kind: 'phone', pace_words: wpm * minutes, pace_seconds: minutes * 60,
  })
  const pace = (rows: ReadingSession[]) => withEreaderPace(rows, () => 'es', NOW).filter(r => r.pace_seconds).map(r => [r.id, r.pace_words, r.pace_seconds])

  it('chains reports that follow one another into one block, on its first row', () => {
    // 2 min with the place not moved yet, then 20 min: 4400 words in 22 min, not in 20.
    expect(pace([kobo(22, 20, 4400), kobo(2, 2, 0)])).toEqual([['b2', 4400, 22 * 60]])
  })

  it('keeps apart reports with a pause in between, and other books', () => {
    expect(pace([kobo(10, 10, 2000), kobo(40, 10, 2200), kobo(50, 10, 1800, 'c')]))
      .toEqual([['b10', 2000, 600], ['b40', 2200, 600], ['c50', 1800, 600]])
  })

  it('leaves out short blocks, unknown places and unbelievable speeds', () => {
    expect(pace([kobo(3, 3, 600)])).toEqual([])                       // whole minutes too coarse
    expect(pace([kobo(15, 15, 0), kobo(26, 11, 2200)])).toEqual([['b26', 2200, 660]])  // 15 min, no words: not a lead-in
    expect(pace([kobo(10, 10, 9000)])).toEqual([])                    // 900 wpm
    expect(pace([app(20, 200), kobo(20, 20, 1400)])).toEqual([['app', 4000, 1200]])    // 70 wpm next to 200: left open
    expect(pace([app(20, 200), kobo(20, 20, 4200)]).length).toBe(2)
  })
})
