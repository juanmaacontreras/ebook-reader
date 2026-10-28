import type { NarrationController } from '../audio/controller'
import { cachedCount, deleteBookAudio, downloadAll } from '../audio/cache'
import { jobRunning, narration, workerStatus } from '../data/store'
import { db } from '../data/db'
import type { NarrationChapter } from '../data/types'
import type { Book } from '../data/types'
import { t } from '../strings'
import { openDialog } from '../ui/dialog'
import { clear, h } from '../ui/dom'
import { icon } from '../ui/icons'
import { audioManager } from '../platform'
import { minutes, openGenerateSheet } from './generate'

// Narration sheet: generation status, "Generar ahora" (desktop), "Parar" (any
// device), and this device's copy.
export function openNarrationSheet(book: Book, narr: NarrationController, section: number, onStarted?: () => void): void {
  openDialog(t.narration, (body, close) => {
    const statusBox = h('div')
    const actions = h('div.dbtns')
    let downloading: string | null = null
    const downloadBox = h('div')
    body.append(statusBox, downloadBox, actions)

    const render = async () => {
      await narr.refresh()
      const row = narr.status
      const ws = await workerStatus().catch(() => null)
      const mins = ws ? Math.round((Date.now() - Date.parse(ws.heartbeat)) / 60000) : null
      const online = mins != null && mins < 3
      const total = narr.sections.length
      const done = narr.readyCount()
      const local = row ? await cachedCount(book.id, row.voice) : 0
      const running = jobRunning(row)
      const cur = ws?.current?.book_id === book.id ? ws.current : null
      const left = cur?.until && cur.until * 1000 > Date.now() ? t.genLeft(minutes(cur.until - Date.now() / 1000)) : null
      clear(statusBox,
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px' },
          h('span.chip' + (online ? '.live' : ''), icon('pc', 'ico'), online ? t.workerOnline : mins == null ? t.workerNever : t.workerOffline(t.ago(mins)))),
        h('p', !row || (!done && !running) ? (audioManager ? t.audioNone + ' ' + t.audioNoneHint : t.bookNoAudioPhone)
          : row.state === 'purged' ? t.audioPurged
          : running && row.state === 'error' ? t.audioError(row.error ?? '')
          : running && cur ? [t.generatingOnPc, cur.total ? t.chapterOf((cur.done ?? 0) + 1, cur.total) : null, left].filter(Boolean).join(' · ')
          : running && row.state !== 'ready' ? `${online ? t.audioQueued : t.pcOff} (${done}/${total})`
          : done >= total ? t.audioReady
          : t.chaptersReady(done, total)),
        done ? h('p.muted', { style: 'font-size:13.5px' }, t.audioDownloaded(local, total)) : null,
        !audioManager && done ? h('p.muted', { style: 'font-size:13px' }, t.audioFromPc) : null,
        online && ws?.notice && running ? h('p.muted', { style: 'font-size:13px' }, t.gpuBusy(ws.notice)) : null)

      // This device's copy: download everything that's ready, in one go.
      const ready = row ? (await db.byIndex<NarrationChapter & { cached?: boolean }>('chapters', 'book_id', book.id)).filter(c => c.voice === row.voice) : []
      const missing = ready.filter(c => !c.cached)
      const mb = Math.max(1, Math.round(missing.reduce((a, c) => a + c.bytes, 0) / 1e6))
      const downloadAllBtn = h('button.btn.tonal.small', {
        disabled: downloading !== null,
        onclick: async () => {
          downloading = t.downloadingAll(0, ready.length)
          void render()
          try {
            await downloadAll(book.id, row!.voice, (n, of) => {
              downloading = t.downloadingAll(n, of)
              const b = downloadBox.querySelector('button')
              if (b) b.textContent = downloading
            })
          } finally { downloading = null; void render() }
        },
      }, icon('download'), downloading ?? t.downloadAllAudio(mb))
      clear(downloadBox, !ready.length ? null
        : !missing.length ? h('p.muted', { style: 'font-size:13.5px' }, t.allAudioHere)
        : downloadAllBtn)

      clear(actions,
        row && local ? h('button.btn.small.ghost', { style: 'margin-right:auto', onclick: async () => { await deleteBookAudio(book.id); void render() } }, t.deleteLocalAudio) : null,
        // Stopping only frees the PC's GPU: allowed from every device.
        running && row?.state !== 'ready' ? h('button.btn.small.ghost', { onclick: async () => { await narration.stop(book.id); void render() } }, t.stop) : null,
        audioManager ? h('button.btn.small' + (done ? '.ghost' : '.primary'), { onclick: () => { close(); void openGenerateSheet(book, section) } }, t.generateNow) : null,
        done ? h('button.btn.small.primary', { onclick: () => { close(); onStarted?.() } }, icon('play'), t.listen)
          : !audioManager ? h('button.btn.small.primary', { onclick: () => close() }, t.ok) : null)
    }
    void render()
  })
}
