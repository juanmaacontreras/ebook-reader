// Search inside a book, over its sentence manifest: every sentence already has its text and
// the CFI to jump to, so nothing of the EPUB is opened. Case and accents don't count
// ("friis" finds "Friis", "formula" finds "fórmula").

import type { Manifest } from '../data/types'

export interface Hit {
  section: number
  sentence: number
  cfi: string
  label: string   // the chapter
  text: string    // the sentence, or a stretch of it around the match
  at: number      // where the match is in `text`
  len: number
}

// Lowercase, no accents; map[k] = where character k of the result was in the original.
export function fold(s: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    const f = s[i].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    for (const c of f) { text += c; map.push(i) }
  }
  map.push(s.length)
  return { text, map }
}

const AROUND = 70  // characters kept on each side of the match in a long sentence

export function searchManifest(manifest: Manifest | null, query: string, limit = 300): Hit[] {
  const q = fold(query.trim().replace(/\s+/g, ' ')).text
  if (!manifest || q.length < 2) return []
  const hits: Hit[] = []
  for (const s of manifest.sections) {
    for (const [k, x] of s.sentences.entries()) {
      const f = fold(x.t)
      const p = f.text.indexOf(q)
      if (p < 0) continue
      const from = f.map[p]
      const to = f.map[p + q.length]
      // Cut at a word, with an ellipsis, when the sentence is long.
      let a = Math.max(0, from - AROUND)
      let b = Math.min(x.t.length, to + AROUND)
      if (a > 0) a = x.t.indexOf(' ', a) + 1 || a
      if (b < x.t.length) b = x.t.lastIndexOf(' ', b) > to ? x.t.lastIndexOf(' ', b) : b
      const text = (a > 0 ? '…' : '') + x.t.slice(a, b) + (b < x.t.length ? '…' : '')
      hits.push({ section: s.i, sentence: k, cfi: x.c, label: s.label, text, at: from - a + (a > 0 ? 1 : 0), len: to - from })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
