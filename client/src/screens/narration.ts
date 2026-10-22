import type { NarrationController } from '../audio/controller'
import { cachedCount, deleteBookAudio } from '../audio/cache'
import { DEFAULT_VOICES, defaultVoice } from '../audio/voices'
import { narration, workerStatus } from '../data/store'
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
    body.append(statusBox, h('label.flabel', t.voice), voicesBox, actions)

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
          : row.state === 'ready' || done >= total ? `${t.audioReady}. ${t.audioDownloaded(local, total)}`
          : done ? t.audioGenerating(done, total) : t.audioQueued))
      const usable = voices.filter(v => v.languages.includes(lang))
      clear(voicesBox, usable.map(v => h('button.voice' + (v.id === selected ? '.sel' : ''), { onclick: () => { selected = v.id; void render() } },
        icon(v.cloned ? 'wave' : 'headphones'),
        h('span.vn', v.label, h('small', v.cloned ? t.voiceCloned : t.voiceFast)),
        v.id === row?.voice ? icon('check') : null)))

      const sameVoice = row && row.voice === selected
      const generating = row && row.state !== 'ready' && row.state !== 'purged' && done < total
      clear(actions,
        row && local ? h('button.btn.small.ghost', { style: 'margin-right:auto', onclick: async () => { await deleteBookAudio(book.id); void render() } }, t.deleteLocalAudio) : null,
        sameVoice && generating && row.status === 'active'
          ? h('button.btn.small.ghost', { onclick: async () => { await narration.setPaused(book.id, true); void render() } }, t.pauseGeneration) : null,
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
