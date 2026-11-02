// The book as a Kobo reads it (KEPUB): the same EPUB with every sentence of the
// manifest wrapped in <span class="koboSpan" id="kobo.N.M">.
//
// A Kobo synced with Atril (supabase/functions/kobo) opens every book with its
// KEPUB renderer, which can only report and restore a position at such a span.
// kepubify numbers spans by paragraph; here N is the manifest's sentence index
// in that section + 1 (M counts the pieces of a sentence split by inline markup:
// "Seis <b>siete</b> ocho." is kobo.N.1, kobo.N.2, kobo.N.3). So the place a
// Kobo reports, {Source: chapter file, Value: "kobo.N.M"}, is manifest sentence
// N-1 of that file's section — the same sentence identity as everywhere else —
// and a position from another device goes to the Kobo as kobo.<sentence+1>.1.
//
// Built by a device that has the EPUB (data/kepubs.ts), from the same
// segmentation that built the manifest; refused when the two disagree.

import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { FoliateBook } from 'foliate-js/view.js'
import type { Manifest } from '../data/types'
import { segmentDocument, type SentenceRange } from './sentences'

// Bump to rebuild every KEPUB (also needs kepub_path cleared on the server).
export const KEPUB_VERSION = 1

// kepub.json next to the KEPUB: which file in the archive is which section.
export interface KepubMap {
  v: number
  files: { p: string; i: number; n: number }[]  // path in the archive, spine index, sentences
}

const XHTML_NS = 'http://www.w3.org/1999/xhtml'

// Already a KEPUB (or partly): its spans go, the text stays where it was.
function unwrapKoboSpans(doc: Document): void {
  for (const span of Array.from(doc.querySelectorAll('span.koboSpan'))) {
    while (span.firstChild) span.parentNode!.insertBefore(span.firstChild, span)
    span.remove()
  }
}

export function addKoboSpans(doc: Document, sentences: SentenceRange[]): void {
  const pieces: { node: Text; from: number; to: number; id: string }[] = []
  sentences.forEach((s, k) => s.pieces.forEach(([node, from, to], j) => pieces.push({ node, from, to, id: `kobo.${k + 1}.${j + 1}` })))
  // Back to front: splitting a text node keeps the original node as its head,
  // so the offsets of earlier pieces in the same node stay valid.
  const ns = doc.documentElement.namespaceURI ?? XHTML_NS
  for (let x = pieces.length - 1; x >= 0; x--) {
    const { node, from, to, id } = pieces[x]
    if (to < node.length) node.splitText(to)
    const mid = from > 0 ? node.splitText(from) : node
    const span = doc.createElementNS(ns, 'span')
    span.setAttribute('class', 'koboSpan')
    span.setAttribute('id', id)
    mid.parentNode!.insertBefore(span, mid)
    span.appendChild(mid)
  }
  // The wrappers kepubify (and Kobo's own books) put around the content.
  const body = doc.body ?? doc.querySelector('body')
  if (body && !doc.getElementById('book-columns')) {
    const columns = doc.createElementNS(ns, 'div')
    columns.setAttribute('id', 'book-columns')
    const inner = doc.createElementNS(ns, 'div')
    inner.setAttribute('id', 'book-inner')
    while (body.firstChild) inner.appendChild(body.firstChild)
    columns.appendChild(inner)
    body.appendChild(columns)
  }
}

function serialize(doc: Document): string {
  const xml = new XMLSerializer().serializeToString(doc)
  return xml.startsWith('<?xml') ? xml : `<?xml version="1.0" encoding="utf-8"?>\n${xml}`
}

const STORED = /\.(jpe?g|png|gif|webp|mp3|mp4|m4a|ogg|woff2?|otf|ttf)$/i

// null when this device's segmentation doesn't give the manifest's sentences
// (a different engine, an older manifest): positions would land on the wrong one.
export async function buildKepub(epub: Blob, book: FoliateBook, manifest: Manifest): Promise<{ kepub: Blob; map: KepubMap } | null> {
  const files = unzipSync(new Uint8Array(await epub.arrayBuffer()))
  const replaced = new Map<string, Uint8Array>()
  const map: KepubMap = { v: KEPUB_VERSION, files: [] }
  for (const ms of manifest.sections) {
    const section = book.sections[ms.i]
    if (!section?.createDocument || !(section.id in files)) return null
    const doc = await section.createDocument()
    unwrapKoboSpans(doc)
    const sentences = segmentDocument(doc, manifest.lang)
    if (sentences.length !== ms.sentences.length || sentences.some((s, k) => s.text !== ms.sentences[k].t)) return null
    addKoboSpans(doc, sentences)
    // A copy: TextEncoder's bytes may come from another realm (jsdom), which
    // fflate would take for a folder.
    replaced.set(section.id, new Uint8Array(strToU8(serialize(doc))))
    map.files.push({ p: section.id, i: ms.i, n: sentences.length })
  }
  // The mimetype entry first and uncompressed, as the EPUB container requires.
  const out: Zippable = { mimetype: [new Uint8Array(strToU8('application/epub+zip')), { level: 0 }] }
  for (const [name, data] of Object.entries(files)) {
    if (name === 'mimetype' || name.endsWith('/')) continue
    out[name] = [replaced.get(name) ?? data, { level: STORED.test(name) ? 0 : 6 }]
  }
  return { kepub: new Blob([zipSync(out) as Uint8Array<ArrayBuffer>], { type: 'application/epub+zip' }), map }
}
