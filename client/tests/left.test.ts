import { describe, expect, it } from 'vitest'
import { readingSeconds, wordsLeft } from '../src/book/left'

const manifest = {
  v: 1 as const, lang: 'es',
  sections: [
    { i: 0, label: 'Uno', sentences: [{ c: '', t: 'uno dos tres.', b: 0 }, { c: '', t: 'cuatro cinco.', b: 0 }] },
    { i: 2, label: 'Dos', sentences: [{ c: '', t: 'seis siete ocho nueve.', b: 0 }] },
  ],
}

describe('wordsLeft', () => {
  it('counts the words to the end of the chapter and of the book', () => {
    const left = wordsLeft(manifest)
    expect(left(0, 0)).toEqual({ chapter: 5, book: 9 })
    expect(left(0, 1)).toEqual({ chapter: 2, book: 6 })
    expect(left(2, 0)).toEqual({ chapter: 4, book: 4 })
    expect(left(2, 5)).toEqual({ chapter: 0, book: 0 })   // past the last sentence
    expect(left(1, 0)).toBeNull()                         // a section with no text
    expect(wordsLeft(null)(0, 0)).toBeNull()
  })
})

describe('readingSeconds', () => {
  it('gives whole minutes, never zero while something is left', () => {
    expect([readingSeconds(0, 200), readingSeconds(30, 200), readingSeconds(1300, 200), readingSeconds(40000, 200)]).toEqual([0, 60, 420, 12000])
  })
})
