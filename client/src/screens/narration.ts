import type { NarrationController } from '../audio/controller'
import { cachedCount, deleteBookAudio, downloadAll } from '../audio/cache'
import { DEFAULT_VOICES, defaultVoice, featuredVoices } from '../audio/voices'
import { narration, workerStatus } from '../data/store'
import { db } from '../data/db'
import type { NarrationChapter } from '../data/types'
import type { Book, VoiceInfo } from '../data/types'
import { t } from '../strings'
import { confirmDialog, openDialog } from '../ui/dialog'
import { clear, h } from '../ui/dom'
import { icon } from '../ui/icons'

// Narration sheet: voice choice, generation status, and this device's copy.
export function openNarrationSheet(book: Book, narr: NarrationController, section: number, onStarted?: () => void): void {
  openDialog(t.narration, (body, close) => {
    const lang = (book.language ?? 'es').split('-')[0]
    const statusBox = h('div')
    const voicesBox = h('div.voices')
    const actions = h('div.dbtns')
    let selected = narr.voice ?? defaultVoice(lang)
    let voices: VoiceInfo[] = DEFAULT_VOICES
    let showAll = false
    let downloading: string | null = null
    const downloadBox = h('div')
    body.append(statusBox, downloadBox, h('label.flabel', t.voice), voicesBox, actions)

    const render = async () => {
      await narr.refresh()
      const row = narr.status
      const ws = await workerStatus().catch(() => null)
      if (ws?.voices?.length) voices = ws.voices
      const mins = ws ? Math.round((Date.now() - Date.parse(ws.heartbeat)) / 60000) : null
      const online = mins != null && mins < 3
      const total = narr.sections.length
      const done = narr.readyCount()
      const local = row ? await cachedCount(book.id, row.voice) : 0
      clear(statusBox,
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px' },
          h('span.chip' + (online ? '.live' : ''), icon('pc', 'ico'), online ? t.workerOnline : mins == null ? t.workerNever : t.workerOffline(t.ago(mins)))),
        h('p', !row ? t.audioNone + ' ' + t.audioNoneHint
          : row.state === 'purged' ? t.audioPurged
          : row.state === 'error' ? t.audioError(row.error ?? '')
          : row.status === 'paused' ? `${t.audioPaused} (${done}/${total})`
          : done >= total ? `${t.audioReady}. ${t.audioDownloaded(local, total)}`
          : row.scope === 'ahead' ? `${row.state === 'ready' ? t.audioAheadReady : t.audioAheadGenerating} (${done}/${total}). ${t.aheadHint}`
          : done ? t.audioGenerating(done, total) : t.audioQueued))
      const usable = voices.filter(v => v.languages.includes(lang))
      const featured = featuredVoices(lang, row?.voice ?? null)
      const shown = showAll ? usable : usable.filter(v => featured.includes(v.id) || v.id === selected)
      const voiceBtn = (v: VoiceInfo) => h('button.voice' + (v.id === selected ? '.sel' : ''), { onclick: () => { selected = v.id; void render() } },
        icon(v.cloned ? 'wave' : 'headphones'),
        h('span.vn', v.label, h('small', v.cloned ? t.voiceCloned : t.voiceFast)),
        v.id === row?.voice ? icon('check') : null)
      clear(voicesBox, shown.map(voiceBtn),
        usable.length > shown.length || showAll
          ? h('button.textbtn', { style: 'align-self:flex-start', onclick: () => { showAll = !showAll; void render() } }, showAll ? t.fewerVoices : t.moreVoices)
          : null)

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

      const sameVoice = row && row.voice === selected
      const generating = row && row.state !== 'ready' && row.state !== 'purged' && done < total
      clear(actions,
        row && local ? h('button.btn.small.ghost', { style: 'margin-right:auto', onclick: async () => { await deleteBookAudio(book.id); void render() } }, t.deleteLocalAudio) : null,
        sameVoice && generating && row.status === 'active'
          ? h('button.btn.small.ghost', { onclick: async () => { await narration.setPaused(book.id, true); void render() } }, t.pauseGeneration) : null,
        sameVoice && row.scope === 'ahead' && done < total
          ? h('button.btn.small.ghost', { onclick: async () => { await narration.setScope(book.id, 'all'); void render() } }, t.generateAll) : null,
        sameVoice && (row.status === 'paused' || row.state === 'error')
          ? h('button.btn.small.ghost', { onclick: async () => { await narration.request(book.id, selected, section); void render() } }, t.resumeGeneration) : null,
        sameVoice
          ? h('button.btn.small.primary', { onclick: () => { close(); onStarted?.() } }, icon('play'), t.listen)
          : h('button.btn.small.primary', { onclick: async () => {
              if (row && done && !(await confirmDialog(t.changeVoice, t.changeVoiceWarn, t.changeVoice, true))) return
              await narration.request(book.id, selected, section)
              close()
              onStarted?.()
            } }, row ? t.changeVoice : t.generateAudio))
    }
    void render()
  })
}
