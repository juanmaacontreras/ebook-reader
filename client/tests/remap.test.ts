import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { changedSections, findText, fractionOf, remapPlace } from '../src/book/remap'
import type { Manifest } from '../src/data/types'

const m = (sections: [number, string, string[]][]): Manifest => ({
  v: 1, lang: 'es',
  sections: sections.map(([i, label, ts]) => ({ i, label, sentences: ts.map((t, k) => ({ c: `c${i}.${k}.${t.length}`, t, b: k })) })),
})

describe('remapPlace', () => {
  const old = m([[1, 'U1', ['Hola.', 'Uno.', 'Dos.']], [2, 'U2', ['Tres.', 'Cuatro.', 'Cinco.']]])

  it('follows the same sentence when a unit is inserted before it', () => {
    const neu = m([[1, 'U1', ['Hola.', 'Uno.', 'Dos.']], [2, 'U1b', ['Nueva.', 'Otra.']], [3, 'U2', ['Tres.', 'Cuatro.', 'Cinco.']]])
    const p = remapPlace(old, neu, { section: 2, sentence: 1, cfi: 'c2.1.7' })
    expect(p).toMatchObject({ section: 3, sentence: 1, cfi: neu.sections[2].sentences[1].c })
    expect(p!.fraction).toBeCloseTo(6 / 8)
  })

  it('tells a repeated sentence apart by its chapter and the sentence before', () => {
    const o = m([[1, 'A', ['Resumen.', 'x.']], [2, 'B', ['Intro.', 'Resumen.']]])
    const n = m([[1, 'A', ['Resumen.', 'x.']], [2, 'B', ['Intro.', 'Agregada.', 'Resumen.']]])
    expect(remapPlace(o, n, { section: 2, sentence: 1, cfi: '' })).toMatchObject({ section: 2, sentence: 2 })
  })

  it('falls back to the same share of the chapter when the sentence was rewritten', () => {
    const neu = m([[1, 'U1', ['Hola.', 'Uno.', 'Dos.']], [2, 'U2', ['A.', 'B.', 'C.', 'D.', 'E.']]])
    expect(remapPlace(old, neu, { section: 2, sentence: 2, cfi: '' })).toMatchObject({ section: 2, sentence: 4 })
  })

  it('finds the old sentence by CFI when the index is missing', () => {
    expect(remapPlace(old, old, { section: null, sentence: null, cfi: 'c2.2.6' })).toMatchObject({ section: 2, sentence: 2 })
  })

  it('fraction counts sentences', () => {
    expect(fractionOf(old, 2, 0)).toBeCloseTo(0.5)
  })
})

describe('changedSections', () => {
  it('lists only chapters whose sentences changed', () => {
    const a = m([[1, 'U1', ['a.', 'b.']], [2, 'U2', ['c.']], [3, 'U3', ['d.']]])
    const b = m([[1, 'U1', ['a.', 'b.']], [2, 'U2', ['c cambiada.']]])
    expect(changedSections(a, b)).toEqual([2, 3])
  })
})

describe('a corrected EPUB of the sample book', () => {
  it('carries the place and a highlight over by their text', async () => {
    const { makeBook } = await import('foliate-js/view.js')
    const { buildManifest } = await import('../src/book/manifest')
    // muestra-corregida.epub = muestra.epub with a paragraph added to chapter 1 (two sentences)
    const load = (f: string) => makeBook(new File([readFileSync(`tests/fixtures/${f}`)], f, { type: 'application/epub+zip' }))
    const oldB = await load('muestra.epub')
    const newB = await load('muestra-corregida.epub')
    const oldM = await buildManifest(oldB, 'es')
    const newM = await buildManifest(newB, 'es')

    const s = oldM.sections[0]
    const k = s.sentences.findIndex(x => x.t.startsWith('—Escuché algo'))
    const p = remapPlace(oldM, newM, { section: s.i, sentence: k, cfi: s.sentences[k].c })!
    expect(newM.sections[0].sentences[p.sentence].t).toBe(s.sentences[k].t)
    expect(p.sentence).toBe(k + 2)
    expect(changedSections(oldM, newM)).toEqual([s.i])

    const doc = await newB.sections[s.i].createDocument!()
    const r = findText(doc, 'Martina cerró   el libro\n y miró')
    expect(r?.toString()).toBe('Martina cerró el libro y miró')
    expect(findText(doc, 'no está en el libro')).toBeNull()
  })
})
