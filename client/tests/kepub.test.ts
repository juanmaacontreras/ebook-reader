import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { addKoboSpans, buildKepub } from '../src/book/kepub'
import { segmentDocument } from '../src/book/sentences'

const xhtml = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="es"><head><title>x</title></head>
<body>${body}</body></html>`
const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xhtml+xml')

// The text of every span of sentence k (kobo.<k+1>.*), joined.
function spanText(doc: Document, k: number): string {
  return Array.from(doc.querySelectorAll('span.koboSpan'))
    .filter(s => s.id.startsWith(`kobo.${k + 1}.`))
    .map(s => s.textContent).join('').replace(/\s+/g, ' ')
}

describe('addKoboSpans', () => {
  it('wraps each sentence, one span per piece split by inline markup', () => {
    const doc = parse(xhtml('<h1>Título</h1><p>Uno dos. Seis <b>siete</b> ocho.</p><p>Golpes<a epub:type="noteref" href="#n">1</a>, y más.</p>'))
    const sentences = segmentDocument(doc, 'es')
    addKoboSpans(doc, sentences)
    expect(sentences.map((_, k) => spanText(doc, k))).toEqual(['Título', 'Uno dos.', 'Seis siete ocho.', 'Golpes, y más.'])
    expect(Array.from(doc.querySelectorAll('span.koboSpan'), s => s.id))
      .toEqual(['kobo.1.1', 'kobo.2.1', 'kobo.3.1', 'kobo.3.2', 'kobo.3.3', 'kobo.4.1', 'kobo.4.2'])
    // The note reference stays outside every span; the content is inside the kepub wrappers.
    expect(doc.querySelector('a')!.closest('span.koboSpan')).toBeNull()
    expect(doc.querySelector('body > #book-columns > #book-inner > h1')).not.toBeNull()
    // Same text as before, nothing lost or duplicated.
    expect(doc.body.textContent).toBe('TítuloUno dos. Seis siete ocho.Golpes1, y más.')
  })

  it('keeps the sentences of the result identical (the reader segments it too)', () => {
    const doc = parse(xhtml('<p>Primera oración. ¿Segunda? <em>¡Tercera!</em></p>'))
    const before = segmentDocument(doc, 'es').map(s => s.text)
    addKoboSpans(doc, segmentDocument(doc, 'es'))
    expect(segmentDocument(doc, 'es').map(s => s.text)).toEqual(before)
  })
})

describe('buildKepub', () => {
  it('builds the KEPUB of the sample book, sentence N in span kobo.N+1', async () => {
    const { makeBook } = await import('foliate-js/view.js')
    const { buildManifest } = await import('../src/book/manifest')
    const raw = readFileSync('tests/fixtures/muestra.epub')
    const file = new File([raw], 'muestra.epub', { type: 'application/epub+zip' })
    const book = await makeBook(file)
    const manifest = await buildManifest(book, 'es')
    const built = await buildKepub(file, book, manifest)
    expect(built).not.toBeNull()
    const { kepub, map } = built!
    expect(map.files.map(f => f.i)).toEqual(manifest.sections.map(s => s.i))

    const bytes = new Uint8Array(await kepub.arrayBuffer())
    // The container rule: "mimetype" is the first entry, stored.
    expect(strFromU8(bytes.subarray(30, 38))).toBe('mimetype')
    const files = unzipSync(bytes)
    expect(Object.keys(files).length).toBe(Object.keys(unzipSync(new Uint8Array(raw))).filter(n => !n.endsWith('/')).length)
    for (const f of map.files) {
      const doc = parse(strFromU8(files[f.p]))
      const sentences = manifest.sections.find(s => s.i === f.i)!.sentences
      expect(f.n).toBe(sentences.length)
      sentences.forEach((s, k) => expect(spanText(doc, k)).toBe(s.t))
    }
  })

  it('refuses when the manifest has other sentences', async () => {
    const { makeBook } = await import('foliate-js/view.js')
    const { buildManifest } = await import('../src/book/manifest')
    const raw = readFileSync('tests/fixtures/muestra.epub')
    const file = new File([raw], 'muestra.epub', { type: 'application/epub+zip' })
    const book = await makeBook(file)
    const manifest = await buildManifest(book, 'es')
    manifest.sections[0].sentences[1].t = 'Otra cosa.'
    expect(await buildKepub(file, book, manifest)).toBeNull()
  })
})
