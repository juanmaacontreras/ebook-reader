// Sentence segmentation of one EPUB section (an XHTML document).
//
// This exact code runs twice: at import, on the parsed section, to build the
// manifest the TTS worker narrates (each sentence with its CFI), and in the
// reader, on the rendered section, to find the Range of the sentence being
// spoken or the one the user tapped. Both see the same DOM, so sentence N here
// is sentence N there. Any change to the rules below changes the indices: bump
// MANIFEST_VERSION in manifest.ts so old manifests are rebuilt.

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul', 'body',
])
const SKIP_TAGS = new Set(['script', 'style', 'rt', 'rp', 'svg', 'math', 'head', 'title', 'template'])
const NOTE_TYPES = ['footnote', 'endnote', 'note', 'rearnote', 'noteref', 'pagebreak']
const OPS_NS = 'http://www.idpf.org/2007/ops'
const HAS_WORD = /[\p{L}\p{N}]/u

export interface SentenceRange {
  range: Range
  text: string
  block: number
  heading: boolean
}

function epubTypes(el: Element): string[] {
  const v = el.getAttributeNS(OPS_NS, 'type') ?? el.getAttribute('epub:type') ?? ''
  return v ? v.split(/\s+/) : []
}

function skipped(el: Element): boolean {
  const tag = el.localName.toLowerCase()
  if (SKIP_TAGS.has(tag)) return true
  if (el.getAttribute('hidden') != null || el.getAttribute('aria-hidden') === 'true') return true
  const types = epubTypes(el)
  if (types.some(x => NOTE_TYPES.includes(x))) return true
  const role = el.getAttribute('role') ?? ''
  return role === 'doc-noteref' || role === 'doc-footnote' || role === 'doc-endnote' || role === 'doc-pagebreak'
}

function blockOf(node: Node, root: Element): Element {
  let el = node.parentElement
  while (el && el !== root && !BLOCK_TAGS.has(el.localName.toLowerCase())) el = el.parentElement
  return el ?? root
}

function collectText(root: Element): { node: Text; block: Element }[] {
  const out: { node: Text; block: Element }[] = []
  const walk = (el: Element) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) {
        if (!skipped(n as Element)) walk(n as Element)
      } else if (n.nodeType === 3 || n.nodeType === 4) {
        if ((n as Text).data.length) out.push({ node: n as Text, block: blockOf(n, root) })
      }
    }
  }
  walk(root)
  return out
}

export function segmentDocument(doc: Document, lang: string): SentenceRange[] {
  const root = doc.body ?? doc.documentElement
  const texts = collectText(root)
  const segmenter = new Intl.Segmenter(lang || 'en', { granularity: 'sentence' })
  const result: SentenceRange[] = []
  let blockIndex = -1
  let i = 0
  while (i < texts.length) {
    const block = texts[i].block
    const group: Text[] = []
    while (i < texts.length && texts[i].block === block) group.push(texts[i++].node)
    const strs = group.map(n => n.data)
    const all = strs.join('')
    if (!HAS_WORD.test(all)) continue
    blockIndex++
    const heading = /^h[1-6]$/.test(block.localName.toLowerCase())
    // Cumulative start offset of every node in `all`.
    const starts: number[] = []
    let acc = 0
    for (const s of strs) { starts.push(acc); acc += s.length }
    const locate = (offset: number, isEnd: boolean): [Text, number] => {
      let k = starts.length - 1
      while (k > 0 && (isEnd ? starts[k] >= offset : starts[k] > offset)) k--
      return [group[k], offset - starts[k]]
    }
    for (const { index, segment } of segmenter.segment(all)) {
      let a = index
      let b = index + segment.length
      while (a < b && /\s/.test(all[a])) a++
      while (b > a && /\s/.test(all[b - 1])) b--
      const text = all.slice(a, b).replace(/\s+/g, ' ')
      if (!HAS_WORD.test(text)) continue
      const range = doc.createRange()
      const [sn, so] = locate(a, false)
      const [en, eo] = locate(b, true)
      range.setStart(sn, so)
      range.setEnd(en, eo)
      result.push({ range, text, block: blockIndex, heading })
    }
  }
  return result
}

// Index of the sentence containing (or, failing that, the first one after) a
// point in the document. Used for "tap a sentence to seek" and to find where
// reading should start when switching to audio.
export function sentenceAt(sentences: SentenceRange[], node: Node, offset: number): number {
  for (let k = 0; k < sentences.length; k++) {
    // -1: the point is before this sentence, 0: inside it.
    if (sentences[k].range.comparePoint(node, offset) <= 0) return k
  }
  return sentences.length - 1
}
