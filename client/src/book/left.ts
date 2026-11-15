// How much is left to read from a place: words to the end of its chapter (the
// manifest section) and of the book. The reader turns them into time with the
// user's own reading speed (data/sessions.ts, habitualPace).

import type { Manifest } from '../data/types'

const count = (t: string) => t.split(/\s+/).filter(Boolean).length

export function wordsLeft(manifest: Manifest | null): (section: number, sentence: number) => { chapter: number; book: number } | null {
  if (!manifest) return () => null
  const sections = new Map<number, { before: number[]; end: number }>()
  let total = 0
  for (const s of manifest.sections) {
    const before: number[] = []
    for (const x of s.sentences) { before.push(total); total += count(x.t) }
    sections.set(s.i, { before, end: total })
  }
  return (section, sentence) => {
    const s = sections.get(section)
    if (!s) return null
    const here = s.before[sentence] ?? s.end
    return { chapter: s.end - here, book: total - here }
  }
}

/** Seconds to read `words` at `wpm`, in whole minutes (at least one while there is something left). */
export const readingSeconds = (words: number, wpm: number) => words <= 0 ? 0 : Math.max(1, Math.round(words / wpm)) * 60
