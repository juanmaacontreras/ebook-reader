import { beforeEach, describe, expect, it, vi } from 'vitest'

const saved: Record<string, unknown>[] = []
vi.mock('../src/data/db', () => ({ db: { put: async (_s: string, row: Record<string, unknown>) => { saved.push(row) }, all: async () => [] } }))
vi.mock('../src/data/store', () => ({ deviceId: async () => 'dev1' }))
vi.mock('../src/data/sync', () => ({ syncSoon: () => {} }))

const { SessionTracker, cleanPace, wordIndex } = await import('../src/data/sessions')

// One sentence of 100 words per "page", in two sections.
const words100 = Array(100).fill('palabra').join(' ') + '.'
const manifest = {
  v: 1 as const, lang: 'es',
  sections: [
    { i: 0, label: 'Uno', sentences: Array.from({ length: 30 }, () => ({ c: '', t: words100, b: 0 })) },
    { i: 2, label: 'Dos', sentences: [{ c: '', t: 'Seis siete ocho nueve.', b: 0 }] },
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
    expect([cleanPace(80, 300), cleanPace(150, 300), cleanPace(700, 300), cleanPace(800, 300)]).toEqual([false, true, true, false])
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
