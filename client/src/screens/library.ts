import { importEpub } from '../book/importer'
import { db } from '../data/db'
import { local, remote } from '../data/files'
import { books, hasLocalEpub, positions } from '../data/store'
import { onChange, onSyncState, syncState, type SyncState } from '../data/sync'
import { userId } from '../data/supabase'
import type { Book, BookStatus, Local, NarrationChapter } from '../data/types'
import { prefs, setPrefs, type Prefs } from '../settings'
import { t } from '../strings'
import { openDialog, segmented, toast } from '../ui/dialog'
import { clear, h } from '../ui/dom'
import { icon } from '../ui/icons'
import { openHighlightsPanel } from './highlights'
import { openSettings } from './settings'

const coverUrls = new Map<string, string>()
const PLACEHOLDER_COLORS = ['#5E81AC', '#8FBCBB', '#B48EAD', '#D08770', '#A3BE8C', '#EBCB8B', '#BF616A']

export function libraryScreen(root: HTMLElement, openBook: (id: string) => void): () => void {
  const sub = h('div.sub')
  const grid = h('div')
  const fileInput = h('input', { type: 'file', accept: '.epub,application/epub+zip', multiple: true, style: 'display:none' })
  fileInput.onchange = () => { if (fileInput.files?.length) void importFiles([...fileInput.files]); fileInput.value = '' }

  const makeFilter = () => segmented<Prefs['libraryFilter']>(
    [['reading', t.filterReading], ['to_read', t.filterToRead], ['finished', t.filterFinished], ['all', t.filterAll]],
    prefs().libraryFilter, v => { void setPrefs({ libraryFilter: v }).then(render) })
  let filterEl = makeFilter()

  root.replaceChildren(h('div.wrap',
    h('div.hd',
      h('div', h('div.title', t.library), sub),
      h('div.spacer'),
      h('button.iconbtn', { title: t.allHighlights, 'aria-label': t.allHighlights, onclick: () => openHighlightsPanel(null, openBook) }, icon('highlight')),
      h('button.iconbtn', { title: t.settings, 'aria-label': t.settings, onclick: () => openSettings() }, icon('settings'))),
    h('div.filters', filterEl),
    grid,
    fileInput,
    h('button.fab', { onclick: () => fileInput.click() }, icon('plus'), t.importBooks),
  ))

  const setSub = (s: SyncState) => {
    clear(sub, s === 'syncing' ? t.syncing : s === 'offline' ? t.offline : s === 'error' ? t.error : '')
  }
  setSub(syncState)

  async function importFiles(files: File[]) {
    const uid = await userId()
    if (!uid) return
    let added = 0
    for (const [k, f] of files.entries()) {
      toast(t.importing(k + 1, files.length), undefined, 60000)
      try {
        const r = await importEpub(f, uid)
        if (r.duplicate) toast(t.importDuplicate(r.book.title))
        else added++
      } catch (e) {
        console.error(e)
        toast(t.importFailed(f.name))
      }
      await render()
    }
    if (added) {
      toast(t.importDone(added))
      // New books are "to read": make sure the current filter shows them.
      if (prefs().libraryFilter === 'reading' || prefs().libraryFilter === 'finished') {
        await setPrefs({ libraryFilter: 'all' })
        filterEl.replaceWith(filterEl = makeFilter())
        await render()
      }
    }
  }

  async function render() {
    const filterValue = prefs().libraryFilter
    const all = await books.all()
    const pos = new Map((await positions.all()).map(p => [p.book_id, p]))
    const chapters = await db.all<NarrationChapter>('chapters')
    const withAudio = new Set(chapters.map(c => c.book_id))
    const list = all
      .filter(b => filterValue === 'all' || b.status === filterValue)
      .sort((a, b) => (pos.get(b.id)?.updated_at ?? b.added_at).localeCompare(pos.get(a.id)?.updated_at ?? a.added_at))
    if (!all.length) {
      clear(grid, h('div.empty', h('b', t.emptyLibrary), t.emptyLibraryHint))
      return
    }
    if (!list.length) { clear(grid, h('div.empty', h('b', t.emptyFilter))); return }
    const card = async (b: Local<Book>) => bookCard(b, pos.get(b.id)?.fraction ?? null, withAudio.has(b.id), await hasLocalEpub(b.id))
    // Design proposal (CLAUDE.md: variants first). ?variant=list | hero; default grid.
    const variant = new URLSearchParams(location.search).get('variant')
    if (variant === 'list') {
      clear(grid, h('div.rows', await Promise.all(list.map(async b => bookRow(b, pos.get(b.id)?.fraction ?? null, withAudio.has(b.id))))))
      return
    }
    if (variant === 'hero') {
      const current = list.find(b => b.status === 'reading')
      const rest = list.filter(b => b !== current)
      clear(grid,
        current ? heroCard(current, pos.get(current.id)?.fraction ?? 0, withAudio.has(current.id)) : null,
        rest.length ? h('div.sechd', h('span.t', current ? t.filterAll : '')) : null,
        h('div.grid', await Promise.all(rest.map(card))))
      return
    }
    clear(grid, h('div.grid', await Promise.all(list.map(card))))
  }

  function bookRow(b: Local<Book>, fraction: number | null, audio: boolean): HTMLElement {
    const cover = h('div.cover.mini')
    void fillCover(cover, b)
    const pct = fraction != null ? Math.round(fraction * 100) : null
    return h('div.card.brow', { role: 'button', tabIndex: 0, onclick: () => openBook(b.id), oncontextmenu: (e: Event) => { e.preventDefault(); bookMenu(b) } },
      cover,
      h('div.mid',
        h('div.bt', b.title),
        h('div.ba', b.author || t.unknownAuthor),
        b.status === 'finished' ? h('div.prog', h('span.pct', t.finishedLabel))
          : pct ? h('div.prog', h('div.track', h('div.fill', { style: `width:${pct}%` })), h('span.pct.num', t.percentRead(pct)))
            : h('div.prog', h('span.pct', t.notStarted))),
      audio ? h('span.chip.live', icon('headphones')) : null,
      h('button.iconbtn.flat', { 'aria-label': t.more, onclick: (e: Event) => { e.stopPropagation(); bookMenu(b) } }, icon('more')))
  }

  function heroCard(b: Local<Book>, fraction: number, audio: boolean): HTMLElement {
    const cover = h('div.cover.hero-cover')
    void fillCover(cover, b)
    const pct = Math.round(fraction * 100)
    return h('div.card.herocard',
      cover,
      h('div.mid',
        h('div.eyebrow', t.filterReading),
        h('div.ht', b.title),
        h('div.ba', b.author || t.unknownAuthor),
        h('div.prog', h('div.track', h('div.fill', { style: `width:${pct}%` })), h('span.pct.num', t.percentRead(pct))),
        h('div.hbtns',
          h('button.btn.primary.small', { onclick: () => openBook(b.id) }, icon('book'), t.continueReading),
          h('button.btn.tonal.small', { onclick: () => openBook(b.id) }, icon('headphones'), audio ? t.listen : t.listen))))
  }

  function bookCard(b: Local<Book>, fraction: number | null, audio: boolean, downloaded: boolean): HTMLElement {
    const cover = h('div.cover')
    void fillCover(cover, b)
    if (audio) cover.append(h('div.badge', { title: t.hasAudio }, icon('headphones')))
    if (!downloaded) cover.append(h('div.cloud', { title: t.notDownloaded }, icon('cloud')))
    const pct = fraction != null ? Math.round(fraction * 100) : null
    let pressTimer: number | undefined
    const el = h('div.bookc', {
      role: 'button', tabIndex: 0,
      onclick: () => openBook(b.id),
      oncontextmenu: (e: Event) => { e.preventDefault(); bookMenu(b) },
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') openBook(b.id) },
      onpointerdown: () => { pressTimer = window.setTimeout(() => { pressTimer = undefined; bookMenu(b) }, 550) },
      onpointerup: () => clearTimeout(pressTimer),
      onpointerleave: () => clearTimeout(pressTimer),
    },
    cover,
    h('div.meta',
      h('div.bt', b.title),
      h('div.ba', b.author || t.unknownAuthor),
      b.status === 'finished' ? h('div.prog', h('span.pct', t.finishedLabel))
        : pct != null && pct > 0 ? h('div.prog', h('div.track', h('div.fill', { style: `width:${pct}%` })), h('span.pct.num', t.percentRead(pct)))
          : h('div.prog', h('span.pct', t.notStarted))))
    return el
  }

  function bookMenu(b: Local<Book>) {
    openDialog(b.title, (body, close) => {
      const choice = (ico: string, label: string, hint: string | null, run: () => void, danger = false) =>
        h('button.choice' + (danger ? '.danger' : ''), { onclick: () => { close(); run() } }, icon(ico), h('div', label, hint ? h('small', hint) : null))
      const status = (s: BookStatus, label: string, ico: string, hint: string | null = null) =>
        b.status === s ? null : choice(ico, label, hint, () => void books.setStatus(b.id, s).then(render))
      body.append(...[
        status('reading', t.markReading, 'book'),
        status('to_read', t.markToRead, 'bookmark'),
        status('finished', t.markFinished, 'check', t.markFinishedHint),
        choice('download', t.downloadBook, null, () => void ensureEpub(b).then(render)),
        choice('trash', t.removeDownload, t.removeDownloadHint, () => void removeLocal(b).then(render), true),
      ].filter((x): x is HTMLElement => x !== null))
    })
  }

  const off1 = onChange(changed => { if (changed.has('books') || changed.has('positions') || changed.has('chapters')) void render() })
  const off2 = onSyncState(setSub)
  void render()
  return () => { off1(); off2() }
}

async function fillCover(el: HTMLElement, b: Book) {
  let url = coverUrls.get(b.id)
  if (!url) {
    let blob = await local.get(`cover:${b.id}`)
    if (!blob && b.cover_path) {
      try {
        blob = await remote(b).download(b.cover_path)
        await local.put(`cover:${b.id}`, blob)
      } catch { /* offline: placeholder */ }
    }
    if (blob) { url = URL.createObjectURL(blob); coverUrls.set(b.id, url) }
  }
  if (url) el.prepend(h('img', { src: url, alt: '', loading: 'lazy', draggable: false }))
  else {
    const c = PLACEHOLDER_COLORS[parseInt(b.sha256.slice(0, 2), 16) % PLACEHOLDER_COLORS.length]
    el.prepend(h('div.ph', { '--c': c }, h('b', b.title), h('span', b.author ?? '')))
  }
}

export async function ensureEpub(b: Book, onProgress?: (f: number) => void): Promise<Blob> {
  const cached = await local.get(`epub:${b.id}`)
  if (cached) return cached
  const blob = await remote(b).download(b.epub_path, onProgress)
  await local.put(`epub:${b.id}`, blob)
  return blob
}

async function removeLocal(b: Book) {
  await local.del(`epub:${b.id}`)
  const { deleteBookAudio } = await import('../audio/cache')
  await deleteBookAudio(b.id)
}
