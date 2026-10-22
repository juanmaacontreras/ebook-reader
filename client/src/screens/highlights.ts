import { books, highlights } from '../data/store'
import type { Highlight, HighlightColor } from '../data/types'
import { HIGHLIGHT_COLORS } from '../data/types'
import { t } from '../strings'
import { openDialog, segmented } from '../ui/dialog'
import { clear, h } from '../ui/dom'
import { icon } from '../ui/icons'

export const HL_VAR: Record<HighlightColor, string> = {
  yellow: '--hl-yellow', green: '--hl-green', blue: '--hl-blue', orange: '--hl-orange', purple: '--hl-purple',
}

// Highlights panel: this book or the whole library, searchable. In the library
// (bookId = null) tapping an item opens its book; in the reader it jumps.
export function openHighlightsPanel(bookId: string | null, openBook: (id: string) => void, jump?: (cfi: string) => void): void {
  let scope: 'book' | 'all' = bookId ? 'book' : 'all'
  let query = ''
  openDialog(t.highlights, (body, close) => {
    const list = h('div.panel-list')
    const search = h('input.field', { type: 'search', placeholder: t.searchHighlights, oninput: () => { query = search.value; void render() } })
    if (bookId) body.append(segmented([['book', t.thisBook], ['all', t.allBooks]], scope, v => { scope = v; void render() }, 'small'), h('div', { style: 'height:12px' }))
    body.append(search, list)

    async function render() {
      const all = scope === 'book' && bookId ? await highlights.forBook(bookId) : await highlights.all()
      const titles = new Map((await books.all()).map(b => [b.id, b.title]))
      const q = normalize(query)
      const items = all
        .filter(x => !q || normalize(x.text).includes(q) || normalize(x.note ?? '').includes(q) || normalize(titles.get(x.book_id) ?? '').includes(q))
        .sort((a, b) => scope === 'book' ? (a.section ?? 0) - (b.section ?? 0) || a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at))
      if (!all.length) { clear(list, h('div.empty', h('b', t.highlightsEmpty), t.highlightsEmptyHint)); return }
      if (!items.length) { clear(list, h('div.empty', t.noResults)); return }
      const out: HTMLElement[] = []
      let group = ''
      for (const x of items) {
        const g = scope === 'book' ? (x.chapter ?? '') : (titles.get(x.book_id) ?? '')
        if (g !== group) { group = g; if (g) out.push(h('div.hlgroup', g)) }
        out.push(h('div.hlitem', {
          '--c': `var(${HL_VAR[x.color] ?? HL_VAR.yellow})`,
          onclick: () => { close(); if (jump && x.book_id === bookId) jump(x.cfi); else { sessionStorage.setItem('jump', x.cfi); openBook(x.book_id) } },
          oncontextmenu: (e: Event) => { e.preventDefault(); editHighlight(x) },
        },
        h('div.bar'),
        h('div.body',
          h('div.q', mark(x.text, query)),
          x.note ? h('div.n', mark(x.note, query)) : null,
          h('div.src', scope === 'all' ? (x.chapter ?? '') : '')),
        h('button.iconbtn.flat', { 'aria-label': t.more, onclick: (e: Event) => { e.stopPropagation(); editHighlight(x, false, () => void render()) } }, icon('more'))))
      }
      clear(list, out)
    }
    void render()
  }, { wide: true })
}

export function editHighlight(x: Highlight, focusNote = false, done?: () => void): void {
  openDialog(null, (body, close) => {
    let color = x.color
    const note = h('textarea.field', { placeholder: t.notePlaceholder, value: x.note ?? '' }) as HTMLTextAreaElement
    const swatches = h('div', { style: 'display:flex;gap:10px;margin:4px 0 14px' })
    const renderSwatches = () => clear(swatches, HIGHLIGHT_COLORS.map(c =>
      h('button.hlswatch' + (c === color ? '.sel' : ''), { '--c': `var(${HL_VAR[c]})`, 'aria-label': c, onclick: () => { color = c; renderSwatches() } })))
    renderSwatches()
    body.append(
      h('div.hlitem', { '--c': `var(${HL_VAR[x.color]})`, style: 'padding:0 0 12px;cursor:default' }, h('div.bar'), h('div.body', h('div.q', x.text))),
      swatches,
      note,
      h('div.dbtns',
        h('button.btn.small.ghost', { style: 'margin-right:auto;color:var(--danger)', onclick: async () => { await highlights.remove(x.id); close(); done?.() } }, t.deleteHighlight),
        h('button.btn.small.ghost', { onclick: () => close() }, t.cancel),
        h('button.btn.small.primary', { onclick: async () => { await highlights.update(x.id, { color, note: note.value.trim() || null }); close(); done?.() } }, t.save)))
    if (focusNote) setTimeout(() => note.focus(), 50)
  })
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function mark(text: string, query: string): (Node | string)[] {
  const q = normalize(query.trim())
  if (!q) return [text]
  const n = normalize(text)
  const out: (Node | string)[] = []
  let i = 0
  for (let k = n.indexOf(q); k >= 0; k = n.indexOf(q, k + q.length)) {
    out.push(text.slice(i, k), h('mark.q', text.slice(k, k + q.length)))
    i = k + q.length
  }
  out.push(text.slice(i))
  return out
}
