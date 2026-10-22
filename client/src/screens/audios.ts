// "Audios": every book with narration in one place — what the PC is doing,
// what's queued, what's ready, how much cloud space it takes — with the
// actions to pause, generate the whole book, move up the queue or delete.

import { db } from '../data/db'
import { local, remote } from '../data/files'
import { books, narration, workerStatus } from '../data/store'
import { onChange } from '../data/sync'
import type { Book, Narration, NarrationChapter, WorkerStatus } from '../data/types'
import { gunzipJson } from '../book/manifest'
import type { Manifest } from '../data/types'
import { DEFAULT_VOICES } from '../audio/voices'
import { t } from '../strings'
import { confirmDialog, openDialog } from '../ui/dialog'
import { clear, h } from '../ui/dom'
import { icon } from '../ui/icons'

const CLOUD_LIMIT = 700e6  // worker default MAX_AUDIO_MB (tts-worker/README.md)

type Chapter = NarrationChapter & { cached?: boolean }
type Kind = 'generating' | 'queued' | 'ready' | 'paused' | 'error'

interface Item {
  book: Book
  n: Narration
  kind: Kind
  ready: number
  total: number | null
  bytes: number
  onDevice: number
  current: string | null
  voice: string
}

const mb = (bytes: number) => Math.max(bytes ? 1 : 0, Math.round(bytes / 1e6))

async function totalSections(book: Book): Promise<{ total: number | null; labels: Map<number, string> }> {
  try {
    let blob = await local.get(`text:${book.id}`)
    if (!blob && book.text_path) { blob = await remote(book).download(book.text_path); await local.put(`text:${book.id}`, blob) }
    if (!blob) return { total: null, labels: new Map() }
    const m = await gunzipJson<Manifest>(blob)
    return { total: m.sections.length, labels: new Map(m.sections.map(s => [s.i, s.label])) }
  } catch { return { total: null, labels: new Map() } }
}

async function loadItems(ws: WorkerStatus | null): Promise<Item[]> {
  const rows = await db.all<Narration>('narrations')
  const chapters = await db.all<Chapter>('chapters')
  const voices = ws?.voices?.length ? ws.voices : DEFAULT_VOICES
  const items: Item[] = []
  for (const n of rows) {
    const book = await books.get(n.book_id)
    if (!book || book.status === 'finished') continue
    const mine = chapters.filter(c => c.book_id === n.book_id && c.voice === n.voice)
    const { total, labels } = await totalSections(book)
    const busy = ws?.current?.book_id === n.book_id
    const kind: Kind = n.status === 'paused' ? 'paused' : n.state === 'error' ? 'error'
      : busy || n.state === 'generating' ? 'generating'
      : n.state === 'ready' || (total != null && mine.length >= total) ? 'ready' : 'queued'
    items.push({
      book, n, kind, ready: mine.length, total, bytes: mine.reduce((a, c) => a + c.bytes, 0),
      onDevice: mine.filter(c => c.cached).length,
      current: busy && ws?.current ? labels.get(ws.current.section) ?? null : null,
      voice: voices.find(v => v.id === n.voice)?.label ?? n.voice.split(':')[1],
    })
  }
  const order: Kind[] = ['generating', 'queued', 'error', 'ready', 'paused']
  return items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.n.requested_at.localeCompare(b.n.requested_at))
}

function statusText(it: Item): string {
  switch (it.kind) {
    case 'generating': return it.current ? t.generatingChapter(it.current) : it.n.scope === 'all' ? t.generatingAll : t.audioAheadGenerating
    case 'queued': return t.queued
    case 'ready': return it.total != null && it.ready >= it.total ? t.readyAll : t.readyAhead
    case 'paused': return t.pausedLabel
    case 'error': return t.errorLabel + (it.n.error ? `: ${it.n.error}` : '')
  }
}

const chipClass: Record<Kind, string> = { generating: '.live', queued: '', ready: '.ok', paused: '', error: '.warn' }

export function audiosScreen(root: HTMLElement, openBook: (id: string) => void, goBack: () => void): () => void {
  const variant = document.documentElement.dataset.variant ?? 'a'
  const head = h('div')
  const list = h('div')
  root.replaceChildren(h('div.wrap.audios.v-' + variant,
    h('div.hd',
      h('button.iconbtn', { 'aria-label': t.back, onclick: () => goBack() }, icon('back')),
      h('div', h('div.title', t.audios)),
      h('div.spacer')),
    head, list))

  const actions = (it: Item, rerender: () => void) => openDialog(it.book.title, (body, close) => {
    const choice = (ico: string, label: string, run: () => Promise<void> | void, danger = false) =>
      h('button.choice' + (danger ? '.danger' : ''), { onclick: async () => { close(); await run(); rerender() } }, icon(ico), h('div', label))
    body.append(...[
      choice('book', t.listen, () => openBook(it.book.id)),
      it.kind === 'paused' || it.kind === 'error'
        ? choice('play', t.resumeGeneration, () => narration.setPaused(it.book.id, false))
        : it.kind !== 'ready' ? choice('pause', t.pauseGeneration, () => narration.setPaused(it.book.id, true)) : null,
      it.n.scope === 'ahead' && !(it.total != null && it.ready >= it.total) ? choice('download', t.generateAll, () => narration.setScope(it.book.id, 'all')) : null,
      it.kind === 'queued' ? choice('update', t.putFirst, () => narration.putFirst(it.book.id)) : null,
      it.ready ? choice('trash', t.deleteAudio, async () => {
        if (await confirmDialog(t.deleteAudio, t.deleteAudioConfirm, t.delete, true)) await narration.deleteAudio(it.book.id)
      }, true) : null,
    ].filter((x): x is HTMLElement => x !== null))
  })

  const meta = (it: Item) => [
    it.voice,
    it.total != null ? t.chaptersReady(it.ready, it.total) : null,
    it.bytes ? t.sizeMb(mb(it.bytes)) : null,
  ].filter(Boolean).join(' · ')

  const cover = (b: Book) => {
    const el = h('div.cover.mini')
    void local.get(`cover:${b.id}`).then(blob => {
      if (blob) el.prepend(h('img', { src: URL.createObjectURL(blob), alt: '' }))
      else el.append(h('div.ph', h('b', b.title)))
    })
    return el
  }

  const progress = (it: Item) => it.total ? h('div.prog', h('div.track', h('div.fill', { style: `width:${Math.round(100 * it.ready / it.total)}%` }))) : null

  // A: one list of cards; tap a card for its actions.
  const rowA = (it: Item, rerender: () => void) => h('div.card.arow', { role: 'button', tabIndex: 0, onclick: () => actions(it, rerender) },
    cover(it.book),
    h('div.mid',
      h('div.bt', it.book.title),
      h('div.astate', h('span.chip' + chipClass[it.kind], statusText(it))),
      h('div.ba', meta(it)),
      progress(it)),
    h('span.more', icon('more')))

  // C: compact rows with the common actions right there.
  const rowC = (it: Item, rerender: () => void) => h('div.crow',
    cover(it.book),
    h('div.mid', h('div.bt', it.book.title), h('div.ba', `${statusText(it)} · ${meta(it)}`)),
    it.kind === 'paused' || it.kind === 'error'
      ? h('button.iconbtn.flat', { 'aria-label': t.resumeGeneration, title: t.resumeGeneration, onclick: async () => { await narration.setPaused(it.book.id, false); rerender() } }, icon('play'))
      : it.kind !== 'ready' ? h('button.iconbtn.flat', { 'aria-label': t.pauseGeneration, title: t.pauseGeneration, onclick: async () => { await narration.setPaused(it.book.id, true); rerender() } }, icon('pause')) : null,
    h('button.iconbtn.flat', { 'aria-label': t.more, onclick: () => actions(it, rerender) }, icon('more')))

  async function render() {
    const ws = await workerStatus().catch(() => null)
    const items = await loadItems(ws)
    const used = items.reduce((a, it) => a + it.bytes, 0) || ws?.audio_bytes || 0
    const mins = ws ? Math.round((Date.now() - Date.parse(ws.heartbeat)) / 60000) : null
    const online = mins != null && mins < 3
    const pc = h('span.chip' + (online ? '.live' : ''), icon('pc'), online ? t.workerOnline : mins == null ? t.workerNever : t.workerOffline(t.ago(mins)))
    const meter = h('div.card.meter',
      h('div.mrow', h('b', t.cloudAudio(`${mb(used)} MB`, `${mb(CLOUD_LIMIT)} MB`)), pc),
      h('div.track', h('div.fill', { style: `width:${Math.min(100, Math.round(100 * used / CLOUD_LIMIT))}%` })))
    if (!items.length) {
      clear(head, meter)
      clear(list, h('div.empty', h('b', t.audiosEmpty), t.audiosEmptyHint))
      return
    }
    const rerender = () => void render()
    if (variant === 'b') {
      // B: grouped by state, the one being generated on top as a hero.
      clear(head, meter)
      const now = items.find(i => i.kind === 'generating')
      const groups: [string, Item[]][] = [
        [t.queued, items.filter(i => i.kind === 'queued' || i.kind === 'error')],
        [t.audioReady, items.filter(i => i.kind === 'ready')],
        [t.pausedLabel, items.filter(i => i.kind === 'paused')],
      ]
      clear(list,
        now ? h('div.card.nowcard', { onclick: () => actions(now, rerender) },
          cover(now.book),
          h('div.mid',
            h('div.eyebrow', h('span.pulse'), t.audioAheadGenerating),
            h('div.ht', now.book.title),
            h('div.ba', now.current ?? ''),
            h('div.ba', meta(now)),
            progress(now))) : null,
        groups.filter(([, g]) => g.length).map(([label, g]) => [
          h('div.sechd', h('span.t', label)),
          h('div.card.glist', g.map(it => rowC(it, rerender))),
        ]))
      return
    }
    if (variant === 'c') {
      clear(head)
      clear(list, h('div.card.glist', items.map(it => rowC(it, rerender))), meter)
      return
    }
    clear(head, meter)
    clear(list, h('div.rows', items.map(it => rowA(it, rerender))))
  }

  const off = onChange(changed => { if (changed.has('narrations') || changed.has('chapters')) void render() })
  const timer = window.setInterval(() => void render(), 30_000)
  void render()
  return () => { off(); clearInterval(timer) }
}
