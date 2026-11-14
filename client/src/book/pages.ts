// Book pages the way an e-reader counts them ("45 de 353"): a page is one
// screen at the current layout. Only the open section is laid out, so the
// book's pages are estimated from text length: sections already seen count
// their real pages, the rest their characters over the characters a page
// holds here (measured on the sections seen). Layout changes start over.

/** Below this many pages a section says little about a page's capacity (a title page, a short note). */
const MIN_PAGES_TO_CALIBRATE = 2

export class PageCounter {
  private seen = new Map<number, number>()
  /**
   * chars[i]: text length of section i, in any unit as long as it is the same
   * for every section; null for a section that isn't read in order (no pages).
   */
  constructor(private chars: (number | null)[]) {}

  /** The layout changed (font, size, margins, window): pages measured so far no longer hold. */
  reset() { this.seen.clear() }

  /** Section i is laid out in this many pages. */
  measure(i: number, pages: number) { if (pages > 0) this.seen.set(i, pages) }

  private perPage(): number | null {
    let chars = 0, pages = 0
    for (const [i, p] of this.seen) {
      const c = this.chars[i] ?? 0
      if (p < MIN_PAGES_TO_CALIBRATE || c <= 0) continue
      chars += c
      pages += p - 0.5  // a section's last page is half full on average
    }
    if (pages > 0) return chars / pages
    // Only short sections seen: their pages are all there is to go on.
    for (const [i, p] of this.seen) { chars += this.chars[i] ?? 0; pages += p }
    return chars > 0 && pages > 0 ? chars / pages : null
  }

  private pagesOf(i: number, perPage: number): number {
    const seen = this.seen.get(i)
    if (seen != null) return seen
    const c = this.chars[i]
    if (c == null) return 0
    return Math.max(1, Math.ceil(c / perPage))
  }

  /** Page `page` (1-based) of section `section`, as a page of the whole book. */
  at(section: number, page: number): { page: number; total: number } | null {
    const perPage = this.perPage()
    if (!perPage) return null
    let before = 0, total = 0
    for (let i = 0; i < this.chars.length; i++) {
      const n = this.pagesOf(i, perPage)
      if (i < section) before += n
      total += n
    }
    const current = Math.min(before + page, total)
    return { page: current, total }
  }
}

// A label that already says which chapter it is: "Capítulo 3", "3. El río",
// "III", "1.2 Potencia", "Chapter One".
const NUMBERED = /^\s*(cap[ií]tulo|cap\.|chapter|parte|part|libro|book|\d|[ivxlcdm]+\b[\s.:)\-–—]|[ivxlcdm]+$)/i

// A label that is only the number ("II", "7"): it gets the word in front.
const BARE = /^\s*(\d+|[ivxlcdm]+)\s*$/i

/**
 * What the reader's top line calls the open chapter: its TOC label, with the
 * chapter's number in front when the book's labels don't carry one.
 * labels: the TOC label of each section that starts a chapter, in book order.
 * word: how a bare number is named ("Capítulo" → "Capítulo II").
 */
export function chapterHeading(labels: Map<number, string>, section: number, word = 'Capítulo'): string {
  let current: string | null = null
  let n = 0, k = 0
  for (const [i, label] of [...labels].sort((a, b) => a[0] - b[0])) {
    if (i > section) break
    k++
    current = label
    n = k
  }
  if (current == null) return ''
  const numbered = [...labels.values()].some(l => NUMBERED.test(l))
  if (BARE.test(current)) return `${word} ${current.trim()}`
  return numbered ? current : `${n}. ${current}`
}
