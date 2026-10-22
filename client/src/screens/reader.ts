import 'foliate-js/view.js'
import type { Location, View } from 'foliate-js/view.js'
import { Overlayer } from 'foliate-js/overlayer.js'
import { NarrationController } from '../audio/controller'
import { bookCss, MARGIN_GAP, palette } from '../book/bookStyles'
import { gunzipJson } from '../book/manifest'
import { segmentDocument, sentenceAt, type SentenceRange } from '../book/sentences'
import { local, remote } from '../data/files'
import { books, deviceId, highlights, positions } from '../data/store'
import { onChange } from '../data/sync'
import type { Book, Highlight, HighlightColor, Manifest } from '../data/types'
import { HIGHLIGHT_COLORS } from '../data/types'
import { setBarsDark } from '../platform/theme'
import { audioManager } from '../platform'
import { onPrefs, prefs } from '../settings'
import { t } from '../strings'
import { toast } from '../ui/dialog'
import { clear, h } from '../ui/dom'
import { icon } from '../ui/icons'
import { openHighlightsPanel, editHighlight, HL_VAR } from './highlights'
import { ensureEpub } from './library'
import { openNarrationSheet } from './narration'
import { playerCard, type PlayerCard } from './player'
import { openReadingSettings } from './readingSettings'
import { openToc } from './toc'

interface Annotation { value: string; color?: string; kind?: 'tts' | 'hl'; id?: string }

export async function readerScreen(root: HTMLElement, bookId: string, goBack: () => void): Promise<() => void> {
  const book = await books.get(bookId)
  if (!book) { goBack(); return () => {} }

  // ---- Shell ---------------------------------------------------------------
  const titleEl = h('b', book.title)
  const chapterEl = h('span', '')
  const footLeft = h('span.grow', '')
  const footRight = h('span.num', '')
  const stage = h('div.stage')
  const dock = h('div.bottomdock')
  const listenBtn = h('button.iconbtn.flat', { title: t.listen, 'aria-label': t.listen }, icon('headphones'))
  const topbar = h('div.rbar.top',
    h('button.iconbtn.flat', { 'aria-label': t.back, onclick: () => goBack() }, icon('back')),
    h('div.rtitle', titleEl, chapterEl),
    h('button.iconbtn.flat', { title: t.contents, 'aria-label': t.contents, onclick: () => showToc() }, icon('list')),
    h('button.iconbtn.flat', { title: t.highlights, 'aria-label': t.highlights, onclick: () => openHighlightsPanel(book.id, () => {}, cfi => void view.goTo(cfi)) }, icon('highlight')),
    h('button.iconbtn.flat', { title: t.readingSettings, 'aria-label': t.readingSettings, onclick: () => openReadingSettings() }, icon('type')),
    listenBtn)
  const shell = h('div.reader.chrome-off', stage, topbar, dock, h('div.rfoot', footLeft, footRight))
  root.replaceChildren(shell)
  const loading = h('div.empty', { style: 'margin:auto' }, h('div.spinner', { style: 'margin:0 auto 12px' }), t.downloading)
  stage.append(loading)

  // ---- Load the book and its sentence manifest -------------------------------
  let file: Blob
  try {
    file = await ensureEpub(book, f => { loading.lastChild!.textContent = `${t.downloading} ${Math.round(f * 100)}%` })
  } catch {
    clear(stage, h('div.empty', { style: 'margin:auto' }, h('b', t.openFailed), t.needDownload))
    return () => {}
  }
  const manifest = await loadManifest(book)
  const lang = manifest?.lang ?? (book.language ?? 'es').split('-')[0]

  const view = document.createElement('foliate-view') as View
  stage.replaceChildren(view)
  await view.open(new File([file], 'book.epub', { type: 'application/epub+zip' }))
  const me = await deviceId()

  // ---- Styles & layout ------------------------------------------------------
  const applyPrefs = () => {
    const p = prefs()
    const pal = palette(p.bookTheme)
    shell.style.setProperty('--book-bg', pal.bg)
    shell.style.setProperty('--book-muted', pal.muted)
    setBarsDark(pal.dark)
    const r = view.renderer
    r.setAttribute('flow', p.flow)
    r.setAttribute('gap', MARGIN_GAP[p.margins])
    r.setAttribute('margin', p.flow === 'scrolled' ? '0px' : '44px')
    r.setAttribute('max-inline-size', '720px')
    r.setAttribute('max-column-count', '2')
    r.setStyles(bookCss(p))
  }
  applyPrefs()
  const offPrefs = onPrefs(applyPrefs)

  // ---- Per-section sentence ranges (same segmentation as the manifest) ------
  const segCache = new Map<number, { doc: Document; sentences: SentenceRange[] }>()
  const sentencesOf = (index: number, doc: Document) => {
    let c = segCache.get(index)
    if (!c || c.doc !== doc) { c = { doc, sentences: segmentDocument(doc, lang) }; segCache.set(index, c) }
    return c.sentences
  }
  const currentDoc = () => view.renderer.getContents()[0]

  // ---- Position -------------------------------------------------------------
  let lastLoc: Location | null = null
  let audioDriven = false
  let lastSaved = ''
  const savePosition = (section: number, sentence: number, cfi: string) => {
    if (cfi === lastSaved) return
    lastSaved = cfi
    void positions.save({ book_id: book.id, cfi, section, sentence, fraction: lastLoc?.fraction ?? null })
  }

  view.addEventListener('relocate', ((e: CustomEvent<Location>) => {
    const loc = e.detail
    lastLoc = loc
    chapterEl.textContent = loc.tocItem?.label ?? ''
    footLeft.textContent = loc.tocItem?.label ?? ''
    footRight.textContent = `${Math.round((loc.fraction ?? 0) * 100)}%`
    slider.value = String(loc.fraction ?? 0)
    if (audioDriven && narr?.playing) return  // while listening, the voice sets the position
    const c = currentDoc()
    if (!c || !loc.range) return
    const sents = sentencesOf(c.index, c.doc)
    if (!sents.length) { savePosition(c.index, 0, loc.cfi); return }
    const k = sentenceAt(sents, loc.range.startContainer, loc.range.startOffset)
    const cfi = manifest?.sections.find(s => s.i === c.index)?.sentences[k]?.c ?? view.getCFI(c.index, sents[k].range)
    savePosition(c.index, k, cfi)
    // Opening a book is not reading it: "Leyendo" (and automatic narration)
    // only after a few page turns or two minutes in the book.
    pagesSeen.add(loc.cfi)
    if (book.status === 'to_read' && (pagesSeen.size >= 4 || Date.now() - openedAt > 120_000)) {
      book.status = 'reading'
      void books.setStatus(book.id, 'reading')
    }
    if ((loc.fraction ?? 0) > 0.995 && book.status !== 'finished') offerFinish()
  }) as EventListener)

  const pagesSeen = new Set<string>()
  const openedAt = Date.now()
  let offeredFinish = false
  const offerFinish = () => {
    if (offeredFinish) return
    offeredFinish = true
    toast(t.bookEnd, { label: t.bookEndYes, run: () => void books.setStatus(book.id, 'finished') }, 6000)
  }

  // ---- Highlights -----------------------------------------------------------
  let hlByCfi = new Map<string, Highlight>()
  const loadHighlights = async () => {
    const list = await highlights.forBook(book.id)
    const next = new Map(list.map(x => [x.cfi, x]))
    for (const [cfi, old] of hlByCfi) if (!next.has(cfi) || next.get(cfi)!.color !== old.color) await view.deleteAnnotation({ value: cfi })
    for (const [cfi, x] of next) if (!hlByCfi.has(cfi) || hlByCfi.get(cfi)!.color !== x.color) await view.addAnnotation({ value: cfi, color: x.color, kind: 'hl', id: x.id } as Annotation)
    hlByCfi = next
  }
  view.addEventListener('create-overlay', ((e: CustomEvent<{ index: number }>) => {
    for (const x of hlByCfi.values()) if (x.section === e.detail.index) void view.addAnnotation({ value: x.cfi, color: x.color, kind: 'hl', id: x.id } as Annotation)
    if (ttsCfi) void view.addAnnotation({ value: ttsCfi, kind: 'tts' } as Annotation)
  }) as EventListener)
  view.addEventListener('draw-annotation', ((e: CustomEvent<{ draw: (f: unknown, o: unknown) => void; annotation: Annotation }>) => {
    const { draw, annotation } = e.detail
    if (annotation.kind === 'tts') draw(Overlayer.highlight, { color: palette(prefs().bookTheme).sentence })
    else draw(Overlayer.highlight, { color: getComputedStyle(document.documentElement).getPropertyValue(HL_VAR[(annotation.color ?? 'yellow') as HighlightColor]).trim() })
  }) as EventListener)
  view.addEventListener('show-annotation', ((e: CustomEvent<{ value: string }>) => {
    const x = hlByCfi.get(e.detail.value)
    if (x) editHighlight(x)
  }) as EventListener)

  // ---- Selection → highlight bar ---------------------------------------------
  let selTimer: number | undefined
  const selbar = h('div.card.selbar.hidden')
  const navrow = h('div.card.navrow')
  const slider = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0' }) as HTMLInputElement
  slider.oninput = () => void view.goToFraction(parseFloat(slider.value))
  navrow.append(slider)
  dock.append(selbar, navrow)

  const showSelection = (doc: Document, index: number) => {
    const sel = doc.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (!sel || sel.isCollapsed || !text) { selbar.classList.add('hidden'); return }
    const range = sel.getRangeAt(0).cloneRange()
    const save = async (color: HighlightColor, withNote = false) => {
      const cfi = view.getCFI(index, range)
      const chapter = manifest?.sections.find(s => s.i === index)?.label ?? lastLoc?.tocItem?.label ?? null
      const row = await highlights.add({ book_id: book.id, cfi, text, color, section: index, chapter })
      sel.removeAllRanges()
      selbar.classList.add('hidden')
      await loadHighlights()
      if (withNote) editHighlight(row, true)
    }
    clear(selbar,
      HIGHLIGHT_COLORS.map(c => h('button.hlswatch', { '--c': `var(${HL_VAR[c]})`, 'aria-label': `${t.highlightColor} ${c}`, onclick: () => void save(c) })),
      h('div.sep'),
      h('button.iconbtn.flat', { title: t.addNote, 'aria-label': t.addNote, onclick: () => void save('yellow', true) }, icon('note')),
      h('button.iconbtn.flat', { title: t.copy, 'aria-label': t.copy, onclick: () => { void navigator.clipboard?.writeText(text); toast(t.copied); sel.removeAllRanges(); selbar.classList.add('hidden') } }, icon('copy')),
      h('div.grow'),
      h('button.iconbtn.flat', { 'aria-label': t.close, onclick: () => { sel.removeAllRanges(); selbar.classList.add('hidden') } }, icon('close')))
    selbar.classList.remove('hidden')
    setChrome(true)
  }

  // ---- Taps: page turns, chrome, and seek-to-sentence while listening --------
  let chromeOn = false
  const setChrome = (on: boolean) => { chromeOn = on; shell.classList.toggle('chrome-off', !on) }
  view.addEventListener('load', ((e: CustomEvent<{ doc: Document; index: number }>) => {
    const { doc, index } = e.detail
    sentencesOf(index, doc)
    doc.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = window.setTimeout(() => showSelection(doc, index), 250) })
    doc.addEventListener('keydown', onKey)
    doc.addEventListener('click', (ev: MouseEvent) => {
      if ((ev.target as Element).closest?.('a[href]')) return
      if (!doc.getSelection()?.isCollapsed) return
      const frame = doc.defaultView?.frameElement as HTMLElement | null
      const x = ev.clientX + (frame?.getBoundingClientRect().left ?? 0) - stage.getBoundingClientRect().left
      const w = stage.clientWidth
      if (narr?.status && x > w * 0.2 && x < w * 0.8 && playerVisible) {
        const pos = caretAt(doc, ev.clientX, ev.clientY)
        if (pos) {
          const k = sentenceAt(sentencesOf(index, doc), pos.node, pos.offset)
          void narr.seekSentence(index, k)
          return
        }
      }
      if (prefs().flow === 'paginated' && x < w * 0.25) void view.prev()
      else if (prefs().flow === 'paginated' && x > w * 0.75) void view.next()
      else setChrome(!chromeOn)
    })
  }) as EventListener)

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') void view.goLeft()
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') void view.goRight()
    else if (e.key === ' ' && narr && playerVisible) { e.preventDefault(); void narr.toggle() }
    else if (e.key === 'Escape') goBack()
  }
  document.addEventListener('keydown', onKey)

  // ---- Narration / read-along -------------------------------------------------
  let narr: NarrationController | null = null
  let player: PlayerCard | null = null
  let playerVisible = false
  let ttsCfi: string | null = null

  const followSentence = async (section: number, i: number, cfi: string) => {
    audioDriven = true
    savePosition(section, i, cfi)
    if (ttsCfi) await view.deleteAnnotation({ value: ttsCfi })
    ttsCfi = cfi
    const c = currentDoc()
    if (!c || c.index !== section) { await view.goTo(cfi); return }
    const range = sentencesOf(section, c.doc)[i]?.range
    await view.addAnnotation({ value: cfi, kind: 'tts' } as Annotation)
    if (range && !visible(range)) await view.renderer.scrollToAnchor(range)
  }
  const visible = (range: Range) => {
    const r = lastLoc?.range
    if (!r) return false
    try {
      return r.compareBoundaryPoints(Range.START_TO_START, range) <= 0 && r.compareBoundaryPoints(Range.END_TO_END, range) >= 0
    } catch { return false }
  }

  if (manifest) {
    narr = await new NarrationController(book, manifest, {
      sentence: (s, i, cfi) => void followSentence(s, i, cfi),
      status: (m, busy) => player?.setStatus(m, busy),
      playing: p => { player?.setPlaying(p); shell.classList.toggle('playing', p) },
      time: (s, time, dur) => player?.setTime(s, time, dur),
      // Phone/tablet: the chapter has no audio and can't be requested from here:
      // a short message and the player closes (option B, picked 2026-10-22).
      missing: () => { toast(t.chapterNoAudioPhone); void hidePlayer() },
    }).init()
  }

  const currentSentence = (): { section: number; sentence: number } => {
    const c = currentDoc()
    if (!c || !lastLoc?.range) return { section: manifest?.sections[0]?.i ?? 0, sentence: 0 }
    const sents = sentencesOf(c.index, c.doc)
    return { section: c.index, sentence: sents.length ? sentenceAt(sents, lastLoc.range.startContainer, lastLoc.range.startOffset) : 0 }
  }

  const showPlayer = async () => {
    if (!narr) return
    if (book.status === 'to_read') { book.status = 'reading'; void books.setStatus(book.id, 'reading') }
    if (!player) {
      player = playerCard(narr, {
        close: () => hidePlayer(),
        voice: () => openNarrationSheet(book, narr!, currentSentence().section),
        title: s => manifest?.sections.find(x => x.i === s)?.label ?? '',
      })
      dock.insertBefore(player.el, navrow)
    }
    navrow.classList.add('hidden')
    player.el.classList.remove('hidden')
    playerVisible = true
    setChrome(true)
    const { section, sentence } = currentSentence()
    if (!narr.playing) await narr.start(manifest!.sections.some(s => s.i === section) ? section : nextNarratedSection(section), sentence)
  }
  const hidePlayer = async () => {
    await narr?.pause()
    audioDriven = false
    playerVisible = false
    player?.el.classList.add('hidden')
    navrow.classList.remove('hidden')
    if (ttsCfi) { await view.deleteAnnotation({ value: ttsCfi }); ttsCfi = null }
  }
  const nextNarratedSection = (section: number) => manifest!.sections.find(s => s.i >= section)?.i ?? manifest!.sections[0].i

  listenBtn.onclick = async () => {
    if (!narr) { toast(t.openFailed); return }
    await narr.refresh()
    if (!narr.status || narr.status.state === 'purged' || !narr.readyCount()) openNarrationSheet(book, narr, currentSentence().section, audioManager ? () => void showPlayer() : undefined)
    else await showPlayer()
  }

  const showToc = () => openToc(view, narr, chapterEl.textContent ?? '', href => void view.goTo(href))

  // ---- Remote position (another device) ---------------------------------------
  const offChange = onChange(async changed => {
    if (changed.has('highlights')) void loadHighlights()
    if (changed.has('positions')) {
      const p = await positions.get(book.id)
      if (p && p.device !== me && p.cfi !== lastSaved && !(narr?.playing)) {
        toast(t.continueOther, { label: t.goThere, run: () => { lastSaved = p.cfi; void view.goTo(p.cfi) } }, 6000)
      }
    }
  })

  // ---- Open at the saved position ------------------------------------------------
  const pos = await positions.get(book.id)
  await view.init({ lastLocation: pos?.cfi, showTextStart: !pos })
  if (pos) lastSaved = pos.cfi
  await loadHighlights()
  const jump = sessionStorage.getItem('jump')
  if (jump) { sessionStorage.removeItem('jump'); await view.goTo(jump) }
  // "Escuchar" on the library's keep-reading card.
  if (sessionStorage.getItem('listen')) { sessionStorage.removeItem('listen'); listenBtn.click() }

  return () => {
    offPrefs()
    offChange()
    document.removeEventListener('keydown', onKey)
    void narr?.destroy()
    view.close()
    view.remove()
  }
}

async function loadManifest(book: Book): Promise<Manifest | null> {
  try {
    let blob = await local.get(`text:${book.id}`)
    if (!blob && book.text_path) {
      blob = await remote(book).download(book.text_path)
      await local.put(`text:${book.id}`, blob)
    }
    return blob ? await gunzipJson<Manifest>(blob) : null
  } catch (e) {
    console.warn('manifest unavailable', e)
    return null
  }
}

function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y)
    return p ? { node: p.offsetNode, offset: p.offset } : null
  }
  const r = doc.caretRangeFromPoint?.(x, y)
  return r ? { node: r.startContainer, offset: r.startOffset } : null
}
