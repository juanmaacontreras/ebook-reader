import { describe, expect, it } from 'vitest'
import { fold, searchManifest } from '../src/book/search'
import type { Manifest } from '../src/data/types'

const manifest: Manifest = {
  v: 1, lang: 'es', sections: [
    { i: 0, label: 'Portada', sentences: [] },
    { i: 1, label: 'Ruido', sentences: [
      { c: 'cfi-a', t: 'La fórmula de Friis da la figura de ruido total.', b: 0 },
      { c: 'cfi-b', t: 'Nada que ver.', b: 0 },
    ] },
    { i: 2, label: 'Modulación', sentences: [
      { c: 'cfi-c', t: `${'palabra '.repeat(30)}la relación señal a RUIDO mejora ${'otra '.repeat(30)}fin.`, b: 0 },
    ] },
  ],
}

describe('searchManifest', () => {
  it('finds without case or accents and says where the match is', () => {
    const hits = searchManifest(manifest, 'FORMULA de friis')
    expect(hits.map(h => [h.section, h.sentence, h.cfi, h.label])).toEqual([[1, 0, 'cfi-a', 'Ruido']])
    expect(hits[0].text.slice(hits[0].at, hits[0].at + hits[0].len)).toBe('fórmula de Friis')
  })

  it('goes through the book in order, every sentence once', () => {
    expect(searchManifest(manifest, 'ruido').map(h => h.cfi)).toEqual(['cfi-a', 'cfi-c'])
  })

  it('shortens a long sentence around the match, cut at words', () => {
    const h = searchManifest(manifest, 'ruido')[1]
    expect(h.text.length).toBeLessThan(180)
    expect(h.text.startsWith('…') && h.text.endsWith('…')).toBe(true)
    expect(h.text.slice(h.at, h.at + h.len)).toBe('RUIDO')
    expect(h.text).toContain('señal a RUIDO mejora')
  })

  it('needs two characters, and a book without a manifest finds nothing', () => {
    expect(searchManifest(manifest, 'r')).toEqual([])
    expect(searchManifest(null, 'ruido')).toEqual([])
  })

  it('stops at the limit', () => {
    expect(searchManifest(manifest, 'ruido', 1).length).toBe(1)
  })
})

describe('fold', () => {
  it('maps back to the original through composed and decomposed accents', () => {
    const f = fold('Señal ñ')
    expect(f.text).toBe('senal n')
    expect(f.map[f.text.indexOf('al')]).toBe(3)
  })
})
