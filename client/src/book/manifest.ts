import * as CFI from 'foliate-js/epubcfi.js'
import type { FoliateBook, TocItem } from 'foliate-js/view.js'
import type { Manifest, ManifestSection } from '../data/types'
import { segmentDocument } from './sentences'

// Bump when sentences.ts changes how it splits text (indices would shift).
export const MANIFEST_VERSION = 1

export function sectionLabels(book: FoliateBook): Map<number, string> {
  const labels = new Map<number, string>()
  const walk = (items: TocItem[] | undefined) => {
    for (const item of items ?? []) {
      try {
        const r = item.href ? book.resolveHref(item.href) : null
        if (r && !labels.has(r.index) && item.label?.trim()) labels.set(r.index, item.label.trim())
      } catch { /* broken TOC entry */ }
      walk(item.subitems)
    }
  }
  walk(book.toc)
  return labels
}

export async function buildManifest(book: FoliateBook, lang: string, onProgress?: (f: number) => void): Promise<Manifest> {
  const labels = sectionLabels(book)
  const sections: ManifestSection[] = []
  let lastLabel = ''
  for (const [index, section] of book.sections.entries()) {
    onProgress?.(index / book.sections.length)
    if (labels.has(index)) lastLabel = labels.get(index)!
    if (!section.createDocument || section.linear === 'no') continue
    let doc: Document
    try { doc = await section.createDocument() } catch { continue }
    const sentences = segmentDocument(doc, lang)
    if (!sentences.length) continue
    const base = section.cfi ?? CFI.fake.fromIndex(index)
    sections.push({
      i: index,
      label: labels.get(index) ?? lastLabel,
      sentences: sentences.map(s => ({ c: CFI.joinIndir(base, CFI.fromRange(s.range)), t: s.text, b: s.block, ...(s.heading ? { h: 1 as const } : {}) })),
    })
  }
  return { v: MANIFEST_VERSION, lang, sections }
}

export async function gzipJson(value: unknown): Promise<Blob> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).blob().then(b => new Blob([b], { type: 'application/gzip' }))
}

export async function gunzipJson<T>(blob: Blob): Promise<T> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'))
  return JSON.parse(await new Response(stream).text()) as T
}
