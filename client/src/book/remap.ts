// A book replaced in place by a corrected EPUB (resumidor's units, tts-worker/publish_book.py):
// the reading place and the highlights are carried over by their text, since every CFI and
// sentence index may have shifted. Pure, except findText, which walks a section's DOM.

import type { Manifest } from '../data/types'

export interface Place { section: number | null; sentence: number | null; cfi: string }
export interface NewPlace { section: number; sentence: number; cfi: string; fraction: number }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

function lexLess(a: number[], b: number[]): boolean {
  for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) return a[j] < b[j]
  return false
}

/** 0..1 through the whole book, counted in sentences (what the reader stores as fraction). */
export function fractionOf(m: Manifest, section: number, sentence: number): number {
  const total = m.sections.reduce((n, s) => n + s.sentences.length, 0)
  if (!total) return 0
  let before = 0
  for (const s of m.sections) {
    if (s.i === section) return Math.min(1, (before + sentence) / total)
    before += s.sentences.length
  }
  return 0
}

function oldSentence(m: Manifest, p: Place): { pos: number; k: number } | null {
  if (p.section != null && p.sentence != null) {
    const pos = m.sections.findIndex(s => s.i === p.section)
    if (pos >= 0 && m.sections[pos].sentences[p.sentence]) return { pos, k: p.sentence }
  }
  for (const [pos, s] of m.sections.entries()) {
    const k = s.sentences.findIndex(x => x.c === p.cfi)
    if (k >= 0) return { pos, k }
  }
  return null
}

/** Where the same sentence is in the new manifest; a repeated sentence is told apart by its
 *  chapter and the sentence before it; a sentence that is gone falls back to the same place in
 *  its chapter (same label, else the chapter in the same position). Null only for an empty book. */
export function remapPlace(oldM: Manifest, newM: Manifest, p: Place): NewPlace | null {
  if (!newM.sections.length) return null
  const at = (pos: number, k: number): NewPlace => {
    const s = newM.sections[pos]
    const kk = Math.max(0, Math.min(k, s.sentences.length - 1))
    return { section: s.i, sentence: kk, cfi: s.sentences[kk].c, fraction: fractionOf(newM, s.i, kk) }
  }
  const o = oldSentence(oldM, p)
  if (!o) return at(0, 0)
  const os = oldM.sections[o.pos]
  const text = norm(os.sentences[o.k].t)
  const prev = o.k > 0 ? norm(os.sentences[o.k - 1].t) : ''
  let best: { score: number[]; pos: number; k: number } | null = null
  for (const [pos, s] of newM.sections.entries()) {
    for (const [k, x] of s.sentences.entries()) {
      if (norm(x.t) !== text) continue
      const score = [
        s.label === os.label ? 0 : 1,
        (k > 0 ? norm(s.sentences[k - 1].t) : '') === prev ? 0 : 1,
        Math.abs(pos - o.pos),
        Math.abs(k - o.k),
      ]
      if (!best || lexLess(score, best.score)) best = { score, pos, k }
    }
  }
  if (best) return at(best.pos, best.k)
  const sameLabel = newM.sections.findIndex(s => s.label === os.label)
  const pos = sameLabel >= 0 ? sameLabel : Math.min(o.pos, newM.sections.length - 1)
  const share = os.sentences.length > 1 ? o.k / (os.sentences.length - 1) : 0
  return at(pos, Math.round(share * (newM.sections[pos].sentences.length - 1)))
}

/** Sections whose sentences (text or CFI) are not exactly the same: their narration timings no
 *  longer fit and the audio of those chapters has to be attached again. */
export function changedSections(oldM: Manifest, newM: Manifest): number[] {
  const key = (m: Manifest, i: number) => JSON.stringify(m.sections.find(s => s.i === i)?.sentences.map(x => [x.c, x.t]) ?? null)
  return oldM.sections.map(s => s.i).filter(i => key(oldM, i) !== key(newM, i))
}

/** The Range of `text` in a section's document, whitespace-insensitive (a highlight's text is
 *  what the reader's Range gave, so runs of spaces and line breaks may differ). */
export function findText(doc: Document, text: string): Range | null {
  const needle = text.replace(/\s+/g, ' ').trim()
  if (!needle || !doc.body) return null
  const chars: string[] = []
  const where: [Text, number][] = []
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const tag = n.parentElement?.localName
    if (tag === 'script' || tag === 'style') continue
    const v = n.data
    for (let i = 0; i < v.length; i++) {
      const space = /\s/.test(v[i])
      if (space && (!chars.length || chars[chars.length - 1] === ' ')) continue
      chars.push(space ? ' ' : v[i])
      where.push([n, i])
    }
  }
  const at = chars.join('').indexOf(needle)
  if (at < 0) return null
  const [sn, so] = where[at]
  const [en, eo] = where[at + needle.length - 1]
  const r = doc.createRange()
  r.setStart(sn, so)
  r.setEnd(en, eo + 1)
  return r
}
