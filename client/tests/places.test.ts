import { describe, expect, it } from 'vitest'
import { isAhead, leftBehind } from '../src/data/places'

describe('places', () => {
  it('orders by section, then sentence', () => {
    expect(isAhead({ section: 2, sentence: 0 }, { section: 1, sentence: 99 })).toBe(true)
    expect(isAhead({ section: 1, sentence: 6 }, { section: 1, sentence: 5 })).toBe(true)
    expect(isAhead({ section: 1, sentence: 5 }, { section: 1, sentence: 5 })).toBe(false)
    expect(isAhead({ section: 1, sentence: 4 }, { section: 1, sentence: 5 })).toBe(false)
    expect(isAhead({ section: 0, sentence: 0 }, null)).toBe(true)
    expect(isAhead({ section: 0, sentence: 0 }, { section: null, sentence: null })).toBe(true)
  })

  it('a device is left behind only by progress it missed', () => {
    const here = { section: 5, sentence: 10 }
    expect(leftBehind({ section: 7, sentence: 0 }, here)).toBe(true)     // read on elsewhere
    expect(leftBehind({ section: 5, sentence: 11 }, here)).toBe(true)
    expect(leftBehind({ section: 3, sentence: 0 }, here)).toBe(false)    // went back elsewhere
    expect(leftBehind({ section: 5, sentence: 10 }, here)).toBe(false)
    expect(leftBehind({ section: null, sentence: null }, here)).toBe(true)
    expect(leftBehind({ section: 1, sentence: 0 }, null)).toBe(true)
  })
})
