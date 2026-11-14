import { describe, expect, it } from 'vitest'
import { chapterHeading, PageCounter } from '../src/book/pages'

describe('book pages', () => {
  it('nothing measured yet: no estimate', () => {
    expect(new PageCounter([1000, 2000]).at(0, 1)).toBeNull()
  })

  it('estimates the unseen sections from the pages of the seen one', () => {
    // 1000 chars a page: section 1 measured at 10.5 pages' worth (last page half full).
    const pc = new PageCounter([500, 10_500, 20_000, null, 3_000])
    pc.measure(1, 11)
    // 1 (500 chars) + 11 (seen) + 20 + 0 (not in reading order) + 3
    expect(pc.at(1, 1)).toEqual({ page: 2, total: 35 })
    expect(pc.at(1, 11)).toEqual({ page: 12, total: 35 })
    expect(pc.at(4, 2)).toEqual({ page: 34, total: 35 })
  })

  it('seen sections count their real pages; short ones do not skew the page size', () => {
    const pc = new PageCounter([50, 10_500, 20_000])
    pc.measure(0, 1)   // a title page: 50 chars on a whole page
    pc.measure(1, 11)
    expect(pc.at(2, 1)).toEqual({ page: 13, total: 32 })
  })

  it('only short sections seen: still an estimate', () => {
    const pc = new PageCounter([800, 8_000])
    pc.measure(0, 1)
    expect(pc.at(0, 1)).toEqual({ page: 1, total: 11 })
  })

  it('a new layout starts over', () => {
    const pc = new PageCounter([10_500, 10_500])
    pc.measure(0, 11)
    pc.reset()
    expect(pc.at(0, 1)).toBeNull()
    pc.measure(0, 22)  // twice the font size
    expect(pc.at(1, 1)?.total).toBe(44)
  })

  it('never past the last page', () => {
    const pc = new PageCounter([10_500])
    pc.measure(0, 11)
    expect(pc.at(0, 14)).toEqual({ page: 11, total: 11 })
  })
})

describe('chapter heading', () => {
  it('keeps labels that already carry the number', () => {
    const labels = new Map([[0, 'Cubierta'], [2, 'Capítulo 1'], [3, 'Capítulo 2']])
    expect(chapterHeading(labels, 3)).toBe('Capítulo 2')
    expect(chapterHeading(labels, 0)).toBe('Cubierta')
    const study = new Map([[1, '1. Introducción'], [2, 'El nacimiento de una autora'], [3, '4. La eclosión']])
    expect(chapterHeading(study, 2)).toBe('El nacimiento de una autora')
  })

  it('numbers chapters when no label does', () => {
    const labels = new Map([[1, 'Modulación Lineal (AM)'], [4, 'Modulación Exponencial (FM/PM)']])
    expect(chapterHeading(labels, 1)).toBe('1. Modulación Lineal (AM)')
    expect(chapterHeading(labels, 5)).toBe('2. Modulación Exponencial (FM/PM)')
    expect(chapterHeading(labels, 0)).toBe('')
  })

  it('roman numerals and English count as numbered', () => {
    expect(chapterHeading(new Map([[0, 'I'], [1, 'II']]), 1)).toBe('Capítulo II')
    expect(chapterHeading(new Map([[0, '7']]), 0, 'Chapter')).toBe('Chapter 7')
    expect(chapterHeading(new Map([[0, 'IV. La isla'], [1, 'Otro']]), 1)).toBe('Otro')
    expect(chapterHeading(new Map([[0, 'Chapter One']]), 0)).toBe('Chapter One')
    // A word that merely starts with roman letters is not a number.
    expect(chapterHeading(new Map([[0, 'Ciudad'], [1, 'Mar']]), 1)).toBe('2. Mar')
  })
})
