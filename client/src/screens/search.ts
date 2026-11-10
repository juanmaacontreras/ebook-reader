import { searchManifest, type Hit } from '../book/search'
import type { Manifest } from '../data/types'
import { t } from '../strings'
import { openDialog } from '../ui/dialog'
import { clear, h } from '../ui/dom'

// The field and its results, to put in a dialog. `pick` gets every hit and the one tapped,
// so the reader can go on to the next ones. `idle` is shown while there is nothing to search.
export function searchBox(manifest: Manifest | null, pick: (hits: Hit[], k: number) => void, idle?: HTMLElement): { field: HTMLInputElement; list: HTMLElement } {
  const list = h('div.panel-list')
  const field = h('input.field', { type: 'search', placeholder: t.searchBook, enterkeyhint: 'search', oninput: () => render() }) as HTMLInputElement
  const render = () => {
    const q = field.value.trim()
    if (q.length < 2) { clear(list, idle ?? h('div.empty', t.searchBookHint)); return }
    const hits = searchManifest(manifest, q)
    if (!hits.length) { clear(list, h('div.empty', t.noResults)); return }
    const out: HTMLElement[] = [h('div.hitcount', t.searchCount(hits.length))]
    let group: number | null = null
    for (const [k, x] of hits.entries()) {
      if (x.section !== group) { group = x.section; if (x.label) out.push(h('div.hlgroup', x.label)) }
      out.push(h('button.hit', { onclick: () => pick(hits, k) },
        x.text.slice(0, x.at), h('mark.q', x.text.slice(x.at, x.at + x.len)), x.text.slice(x.at + x.len)))
    }
    clear(list, out)
  }
  render()
  return { field, list }
}

export function openSearch(manifest: Manifest | null, pick: (hits: Hit[], k: number) => void, query = ''): void {
  openDialog(t.searchBook, (body, close) => {
    const { field, list } = searchBox(manifest, (hits, k) => { close(); pick(hits, k) })
    body.append(field, list)
    if (query) { field.value = query; field.dispatchEvent(new Event('input')) }
    setTimeout(() => field.focus(), 50)
  }, { wide: true })
}
