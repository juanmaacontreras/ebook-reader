// "Audios": every book with narration in one place — what the PC is doing and
// how long it has left, what's queued, ready or stopped, how much cloud space
// it takes. Narration happens only on purpose: the desktop starts it here
// ("Generar ahora"); any device can stop it ("Parar"); phones only watch.

import { db } from '../data/db'
import { books, jobRunning, jobSections, narration, workerStatus } from '../data/store'
import { onChange } from '../data/sync'
import type { Book, Narration, NarrationChapter, WorkerStatus } from '../data/types'
import { DEFAULT_VOICES } from '../audio/voices'
import { t } from '../strings'
import { confirmDialog, openDialog } from '../ui/dialog'
import { clear, h } from '../ui/dom'
import { icon } from '../ui/icons'
import { audioManager } from '../platform'
import { coverMini, loadManifest, minutes, openBookPicker, openGenerateSheet } from './generate'

const CLOUD_LIMIT = 700e6  // worker default MAX_AUDIO_MB (tts-worker/README.md)

type Chapter = NarrationChapter & { cached?: boolean }
type Kind = 'generating' | 'queued' | 'ready' | 'stopped' | 'error'

interface Item {
  book: Book
  n: Narration
  kind: Kind
  ready: number         // chapters with audio (this voice)
  total: number | null  // chapters in the book
  bytes: number
  status: string        // the line under the title
  voice: string
}

const mb = (bytes: number) => Math.max(bytes ? 1 : 0, Math.round(bytes / 1e6))

async function loadItems(ws: WorkerStatus | null, online: boolean): Promise<Item[]> {
  const rows = await db.all<Narration>('narrations')
  const chapters = await db.all<Chapter>('chapters')
  const voices = ws?.voices?.length ? ws.voices : DEFAULT_VOICES
  const items: Item[] = []
  for (const n of rows) {
    const book = await books.get(n.book_id)
    if (!book || book.status === 'finished') continue
    const mine = chapters.filter(c => c.book_id === n.book_id && c.voice === n.voice)
    const m = await loadManifest(book)
    const ids = m ? m.sections.filter(s => s.sentences.length).map(s => s.i) : []
    const total = m ? ids.length : null
    const done = new Set(mine.map(c => c.section))
    const left = jobSections(n, ids).filter(i => !done.has(i)).length
    const running = jobRunning(n)
    const cur = ws?.current?.book_id === n.book_id ? ws.current : null
    const kind: Kind = n.state === 'error' && running ? 'error'
      : running && (cur || n.state === 'generating') ? 'generating'
      : running && (left > 0 || !m) && n.state !== 'ready' ? 'queued'
      : !running && !(total != null && mine.length >= total) && !(n.state === 'ready' && n.scope !== 'ahead' && !left) ? 'stopped'
      : 'ready'
    const status = kind === 'generating'
      ? !online ? t.pcOff
        : [t.generatingOnPc, cur?.total ? t.chapterOf((cur.done ?? 0) + 1, cur.total) : null,
          cur?.until && cur.until * 1000 > Date.now() ? t.genLeft(minutes(cur.until - Date.now() / 1000)) : null].filter(Boolean).join(' · ')
      : kind === 'queued' ? (online ? t.queued : t.pcOff)
      : kind === 'error' ? t.errorLabel + (n.error ? `: ${n.error}` : '')
      : kind === 'stopped' ? (!mine.length && !audioManager ? t.noAudioAskPc
        : n.stopped_at && n.started_at && Date.parse(n.stopped_at) >= Date.parse(n.started_at) ? t.stoppedFromPc : t.pausedLabel)
      : total != null && mine.length >= total ? t.readyAll : t.readyPart
    items.push({
      book, n, kind, ready: mine.length, total, bytes: mine.reduce((a, c) => a + c.bytes, 0), status,
      voice: voices.find(v => v.id === n.voice)?.label ?? n.voice.split(':')[1],
    })
  }
  const order: Kind[] = ['generating', 'queued', 'error', 'ready', 'stopped']
  return items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.n.requested_at.localeCompare(b.n.requested_at))
}

export function audiosScreen(root: HTMLElement, openBook: (id: string) => void, goBack: () => void): () => void {
  const head = h('div')
  const list = h('div')
  root.replaceChildren(h('div.wrap.audios',
    h('div.hd',
      h('button.iconbtn', { 'aria-label': t.back, onclick: () => goBack() }, icon('back')),
      h('div', h('div.title', t.audios)),
      h('div.spacer'),
      audioManager ? h('button.btn.small.primary', { onclick: () => void openBookPicker() }, icon('plus'), t.generateNow) : null),
    head, list))

  const rerender = () => void render()
  const stopBtn = (it: Item) => h('button.btn.small.tonal', { onclick: async (e: Event) => { e.stopPropagation(); await narration.stop(it.book.id); rerender() } }, icon('pause'), t.stop)

  // Phone/tablet: tapping a book opens it to listen. Desktop: a sheet of actions.
  const actions = (it: Item) => audioManager ? manage(it) : openBook(it.book.id)
  const manage = (it: Item) => openDialog(it.book.title, (body, close) => {
    const choice = (ico: string, label: string, run: () => Promise<void> | void, danger = false) =>
      h('button.choice' + (danger ? '.danger' : ''), { onclick: async () => { close(); await run(); rerender() } }, icon(ico), h('div', label))
    body.append(...[
      choice('book', t.listen, () => openBook(it.book.id)),
      choice('play', t.generateNow, () => openGenerateSheet(it.book, undefined, rerender)),
      it.kind === 'generating' || it.kind === 'queued' || it.kind === 'error' ? choice('pause', t.stop, () => narration.stop(it.book.id)) : null,
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

  const progress = (it: Item) => it.total ? h('div.prog', h('div.track', h('div.fill', { style: `width:${Math.round(100 * it.ready / it.total)}%` }))) : null

  // A row: cover, title, state · voice · chapters · size; "Parar" while queued.
  const row = (it: Item) => h('div.crow', { onclick: () => actions(it) },
    coverMini(it.book),
    h('div.mid', h('div.bt', it.book.title), h('div.ba', `${it.status} · ${meta(it)}`)),
    it.kind === 'queued' ? h('button.iconbtn.flat', { 'aria-label': t.stop, title: t.stop, onclick: async (e: Event) => { e.stopPropagation(); await narration.stop(it.book.id); rerender() } }, icon('pause')) : null,
    audioManager ? h('button.iconbtn.flat', { 'aria-label': t.more, onclick: (e: Event) => { e.stopPropagation(); actions(it) } }, icon('more')) : null)

  async function render() {
    const ws = await workerStatus().catch(() => null)
    const mins = ws ? Math.round((Date.now() - Date.parse(ws.heartbeat)) / 60000) : null
    const online = mins != null && mins < 3
    const items = await loadItems(ws, online)
    const used = items.reduce((a, it) => a + it.bytes, 0) || ws?.audio_bytes || 0
    const pc = h('span.chip' + (online ? '.live' : ''), icon('pc'), online ? t.workerOnline : mins == null ? t.workerNever : t.workerOffline(t.ago(mins)))
    const meter = h('div.card.meter',
      h('div.mrow', h('b', t.cloudAudio(`${mb(used)} MB`, `${mb(CLOUD_LIMIT)} MB`)), pc),
      h('div.track', h('div.fill', { style: `width:${Math.min(100, Math.round(100 * used / CLOUD_LIMIT))}%` })),
      online && ws?.notice ? h('div.notice', icon('pc'), t.gpuBusy(ws.notice)) : null)
    clear(head, meter)
    if (!items.length) {
      clear(list, h('div.empty', h('b', t.audiosEmpty), audioManager ? t.audiosEmptyHint : t.audiosEmptyHintPhone))
      return
    }
    // Grouped by state, the book being generated on top (option B, picked by
    // the user 2026-10-22 over a list of cards and a compact list).
    const now = items.find(i => i.kind === 'generating')
    const groups: [string, Item[]][] = [
      [t.queued, items.filter(i => i.kind === 'queued' || i.kind === 'error')],
      [t.audioReady, items.filter(i => i.kind === 'ready')],
      [t.pausedLabel, items.filter(i => i.kind === 'stopped')],
    ]
        clear(list,
      now ? h('div.card.nowcard', { onclick: () => actions(now) },
        coverMini(now.book),
        h('div.mid',
          h('div.eyebrow', h('span.pulse'), t.generatingOnPc),
          h('div.ht', now.book.title),
          h('div.ba', now.status.replace(t.generatingOnPc + ' · ', '')),
          h('div.ba', meta(now)),
          progress(now),
          h('div.nowbtns', stopBtn(now)))) : null,
      groups.filter(([, g]) => g.length).map(([label, g]) => [
        h('div.sechd', h('span.t', label)),
        h('div.card.glist', g.map(row)),
      ]))
  }

  const off = onChange(changed => { if (changed.has('narrations') || changed.has('chapters')) void render() })
  const timer = window.setInterval(() => void render(), 30_000)
  void render()
  return () => { off(); clearInterval(timer) }
}
