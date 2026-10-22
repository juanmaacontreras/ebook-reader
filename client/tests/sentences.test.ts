import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as CFI from 'foliate-js/epubcfi.js'
import { segmentDocument, sentenceAt } from '../src/book/sentences'
import { findTiming } from '../src/audio/controller'

const xhtml = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="es"><head><title>x</title></head>
<body>${body}</body></html>`
const parse = (body: string) => new DOMParser().parseFromString(xhtml(body), 'application/xhtml+xml')

describe('segmentDocument', () => {
  it('splits paragraphs into sentences and keeps block/heading info', () => {
    const doc = parse('<h1>Capítulo uno</h1><p>Primera oración. ¿Segunda? ¡Tercera!</p><p>—¿Vos venís? —preguntó.</p>')
    const s = segmentDocument(doc, 'es')
    expect(s.map(x => x.text)).toEqual(['Capítulo uno', 'Primera oración.', '¿Segunda?', '¡Tercera!', '—¿Vos venís? —preguntó.'])
    expect(s.map(x => x.block)).toEqual([0, 1, 1, 1, 2])
    expect(s[0].heading).toBe(true)
    expect(s[1].heading).toBe(false)
  })

  it('skips footnotes and note references but keeps inline markup', () => {
    const doc = parse('<p>Siete golpes<a epub:type="noteref" href="#n">1</a>, y el <em>viento</em> no sabe contar.</p><aside epub:type="footnote" id="n"><p>Nota.</p></aside>')
    const s = segmentDocument(doc, 'es')
    expect(s.map(x => x.text)).toEqual(['Siete golpes, y el viento no sabe contar.'])
  })

  it('produces ranges whose CFI resolves back to the same text', () => {
    const doc = parse('<section><p>Uno dos tres. Cuatro cinco.</p><p>Seis <b>siete</b> ocho.</p></section>')
    for (const s of segmentDocument(doc, 'es')) {
      const cfi = CFI.fromRange(s.range)
      const back = CFI.toRange(doc, CFI.parse(`epubcfi(${cfi.replace(/^epubcfi\(|\)$/g, '')})`))
      expect(back.toString().replace(/\s+/g, ' ').trim()).toBe(s.text)
    }
  })

  it('finds the sentence at a point', () => {
    const doc = parse('<p>Uno. Dos. Tres.</p>')
    const s = segmentDocument(doc, 'es')
    const text = doc.querySelector('p')!.firstChild!
    expect(sentenceAt(s, text, 0)).toBe(0)
    expect(sentenceAt(s, text, 6)).toBe(1)
    expect(sentenceAt(s, text, 11)).toBe(2)
  })

  it('builds the manifest of the sample book', async () => {
    const { makeBook } = await import('foliate-js/view.js')
    const { buildManifest } = await import('../src/book/manifest')
    const raw = readFileSync('tests/fixtures/muestra.epub')
    const book = await makeBook(new File([raw], 'muestra.epub', { type: 'application/epub+zip' }))
    const m = await buildManifest(book, 'es')
    expect(m.sections.map(s => s.label)).toEqual(['Capítulo Uno: La lluvia', 'Capítulo Dos: La escalera', 'Capítulo Tres: La puerta'])
    const first = m.sections[0].sentences
    expect(first[0]).toMatchObject({ t: 'Capítulo Uno: La lluvia', b: 0, h: 1 })
    expect(first.some(s => s.t.includes('Siete, como los días'))).toBe(false)
    expect(first.every(s => s.c.startsWith('epubcfi(/6/'))).toBe(true)
  })
})

describe('findTiming', () => {
  const tm = [0, 2.5, 5, 9].map((s, i) => ({ i, cfi: '', s, e: s + 2 }))
  it('maps a time to the sentence playing', () => {
    expect(findTiming(tm, 0)).toBe(0)
    expect(findTiming(tm, 2.4)).toBe(0)
    expect(findTiming(tm, 2.5)).toBe(1)
    expect(findTiming(tm, 100)).toBe(3)
  })
})
