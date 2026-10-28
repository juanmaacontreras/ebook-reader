// "Generar ahora" (desktop only): the user decides what the PC narrates —
// this chapter, it and the next two, or the whole book — from the chapter
// they're in, with which voice. It runs until done or "Parar" (CLAUDE.md,
// User decisions 2026-10-28). Nothing else starts the PC.

import { db } from '../data/db'
import { local, remote } from '../data/files'
import { books, jobSections, narration, positions, workerStatus } from '../data/store'
import type { Book, Manifest, NarrationChapter, NarrationScope, VoiceInfo } from '../data/types'
import { gunzipJson } from '../book/manifest'
import { DEFAULT_VOICES, defaultVoice, featuredVoices } from '../audio/voices'
import { t } from '../strings'
import { confirmDialog, openDialog, segmented } from '../ui/dialog'
import { clear, h } from '../ui/dom'
import { icon } from '../ui/icons'

export async function loadManifest(book: Book): Promise<Manifest | null> {
  try {
    let blob = await local.get(`text:${book.id}`)
    if (!blob && book.text_path) { blob = await remote(book).download(book.text_path); await local.put(`text:${book.id}`, blob) }
    return blob ? await gunzipJson<Manifest>(blob) : null
  } catch { return null }
}

// GPU seconds per character on the user's PC (tts-worker/worker/jobs.py DEFAULT_RATE).
const RATE: Record<string, number> = { kokoro: 0.003, 'chatterbox-v3': 0.22, 'chatterbox-latam': 0.22 }
const rate = (voice: string) => RATE[voice.split(':')[0]] ?? 0.1
export const minutes = (seconds: number) => t.duration(Math.round(seconds / 60))

// Pick a book first (Audios' "Generar ahora"): books not finished, reading first.
export async function openBookPicker(): Promise<void> {
  const all = (await books.all()).filter(b => b.status !== 'finished' && b.text_path)
  const order = { reading: 0, to_read: 1, finished: 2 } as Record<string, number>
  all.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.title.localeCompare(b.title))
  openDialog(t.pickBook, (body, close) => {
    body.append(h('p.muted', { style: 'font-size:13.5px;margin:0 0 6px' }, t.pickBookHint),
      ...all.map(b => h('button.choice', { onclick: () => { close(); void openGenerateSheet(b) } },
        coverMini(b), h('div', b.title, h('small', b.author ?? '')))))
  })
}

export function coverMini(b: Book): HTMLElement {
  const el = h('div.cover.mini')
  void local.get(`cover:${b.id}`).then(blob => {
    if (blob) el.prepend(h('img', { src: URL.createObjectURL(blob), alt: '' }))
    else el.append(h('div.ph', h('b', b.title)))
  })
  return el
}

export async function openGenerateSheet(book: Book, startSection?: number, onStarted?: () => void): Promise<void> {
  const [manifest, row, pos, ws] = await Promise.all([loadManifest(book), narration.get(book.id), positions.get(book.id), workerStatus().catch(() => null)])
  if (!manifest) return
  const lang = (book.language ?? 'es').split('-')[0]
  const sections = manifest.sections.filter(s => s.sentences.length)
  const ids = sections.map(s => s.i)
  const start = startSection ?? pos?.section ?? ids[0]
  const startLabel = (manifest.sections.find(s => s.i >= start) ?? sections[0])?.label || book.title
  const chars = new Map(sections.map(s => [s.i, s.sentences.reduce((a, x) => a + x.t.length, 0)]))
  const voices: VoiceInfo[] = (ws?.voices?.length ? ws.voices : DEFAULT_VOICES).filter(v => v.languages.includes(lang))
  const chapters = await db.byIndex<NarrationChapter>('chapters', 'book_id', book.id)
  let voice = row?.voice ?? defaultVoice(lang)
  let scope: Exclude<NarrationScope, 'ahead'> = row && row.scope !== 'ahead' ? row.scope : 'next'
  let showAll = false

  // What is left to do for a scope with the chosen voice, and how long the PC takes.
  const plan = (sc: NarrationScope) => {
    const done = new Set(chapters.filter(c => c.voice === voice).map(c => c.section))
    const todo = jobSections({ scope: sc, start_section: start }, ids).filter(i => !done.has(i))
    return { todo: todo.length, seconds: todo.reduce((a, i) => a + (chars.get(i) ?? 0), 0) * rate(voice) }
  }
  const scopes: [Exclude<NarrationScope, 'ahead'>, string][] = (['chapter', 'next', 'all'] as const).map(k => [k, t.scopeShort(k).replace(/^./, c => c.toUpperCase())])

  openDialog(t.generateNow, (body, close) => {
    const go = async (sc: NarrationScope) => {
      if (row && row.voice !== voice && chapters.some(c => c.voice === row.voice)
        && !(await confirmDialog(t.changeVoice, t.changeVoiceWarn, t.changeVoice, true))) return
      await narration.start(book.id, voice, start, sc)
      close()
      onStarted?.()
    }
    const render = () => {
      const featured = featuredVoices(lang, row?.voice ?? null)
      const shown = showAll ? voices : voices.filter(v => featured.includes(v.id) || v.id === voice)
      const voiceList = h('div.voices',
        shown.map(v => h('button.voice' + (v.id === voice ? '.sel' : ''), { onclick: () => { voice = v.id; render() } },
          icon(v.cloned ? 'wave' : 'headphones'), h('span.vn', v.label, h('small', v.cloned ? t.voiceCloned : t.voiceFast)),
          v.id === voice ? icon('check') : null)),
        voices.length > shown.length || showAll
          ? h('button.textbtn', { style: 'align-self:flex-start', onclick: () => { showAll = !showAll; render() } }, showAll ? t.fewerVoices : t.moreVoices) : null)
      const head = h('div.genhead', coverMini(book), h('div', h('b', book.title), h('small', t.fromChapter(startLabel))))
      // Option B (picked by the user 2026-10-28 over big per-option rows): segmented choice + one estimate line + a single primary button.
      const p = plan(scope)
      clear(body, head,
        h('label.flabel', t.generateWhat),
        segmented(scopes, scope, v => { scope = v; render() }),
        h('p.genest', p.todo ? t.pcTimeLong(minutes(p.seconds)) : t.alreadyDone),
        h('label.flabel', t.voice), voiceList,
        h('p.muted', { style: 'font-size:12.5px;margin:12px 0 0' }, t.generateRuns),
        h('div.dbtns', h('button.btn.small.ghost', { onclick: () => close() }, t.cancel),
          h('button.btn.small.primary', { disabled: !p.todo, onclick: () => void go(scope) }, icon('play'), t.generateNow)))
    }
    render()
  })
}
