// Narration of the open book: picks chapters, downloads them, keeps the engine's
// playlist ahead of the listener, and turns playback time into "sentence N of
// section S" for the read-along highlight and the synced reading position.

import { kv } from '../data/db'
import { narration as narrationStore } from '../data/store'
import { onChange } from '../data/sync'
import type { Book, Manifest, Narration, NarrationChapter, Timing } from '../data/types'
import { isAndroid } from '../platform'
import { t } from '../strings'
import { ensureChapter, lazySrc, resolveLazy } from './cache'
import { SKIP_SECONDS, type AudioEngine, type Track } from './engine'

export interface NarrationHooks {
  sentence(section: number, index: number, cfi: string): void
  status(message: string | null, busy?: boolean): void
  playing(playing: boolean): void
  time(section: number, time: number, duration: number): void
}

interface Loaded { section: number; timings: Timing[]; duration: number }

let enginePromise: Promise<AudioEngine> | null = null
async function engine(): Promise<AudioEngine> {
  enginePromise ??= (async () => {
    if (isAndroid) {
      const { NativeEngine } = await import('./nativeEngine')
      return new NativeEngine().init()
    }
    const { WebEngine } = await import('./webEngine')
    return new WebEngine(track => resolveLazy(track.src))
  })()
  return enginePromise
}

export class NarrationController {
  private eng: AudioEngine | null = null
  private loaded: Loaded[] = []         // the engine's playlist, in order
  private chapters = new Map<number, NarrationChapter>()
  private row: Narration | null = null
  private poll: number | undefined
  private lastSentence = -1
  private unsub: (() => void) | null = null
  private appending = false
  playing = false
  rate = 1
  current = { section: -1, sentence: -1 }

  constructor(private book: Book, private manifest: Manifest, private hooks: NarrationHooks) {}

  get voice(): string | null { return this.row?.voice ?? null }
  get sections(): number[] { return this.manifest.sections.map(s => s.i) }
  get status(): Narration | null { return this.row }
  hasChapter(section: number): boolean { return this.chapters.has(section) }
  readyCount(): number { return this.chapters.size }

  async init(): Promise<this> {
    this.rate = (await kv.get<number>('rate')) ?? 1
    await this.refresh()
    this.unsub = onChange(changed => {
      if (changed.has('narrations') || changed.has('chapters')) void this.refresh().then(() => this.onNewChapters())
    })
    return this
  }

  async refresh(): Promise<void> {
    this.row = (await narrationStore.get(this.book.id)) ?? null
    this.chapters.clear()
    if (!this.row) return
    for (const c of await narrationStore.chapters(this.book.id)) if (c.voice === this.row.voice) this.chapters.set(c.section, c)
  }

  private nextSection(section: number): number | null {
    const list = this.sections
    const k = list.indexOf(section)
    return k >= 0 && k + 1 < list.length ? list[k + 1] : null
  }

  private title(section: number): string {
    return this.manifest.sections.find(s => s.i === section)?.label || this.book.title
  }

  // Start (or jump) narration at a sentence.
  async start(section: number, sentence: number, autoplay = true): Promise<void> {
    // The request may have been written a moment ago (narration sheet): read it now
    // instead of waiting for the change event, or this start is silently lost.
    if (!this.row || !this.chapters.has(section)) await this.refresh()
    if (!this.row) return
    const ch = this.chapters.get(section)
    if (!ch) {
      this.hooks.status(t.waitingChapter, true)
      await narrationStore.prioritize(this.book.id, section)
      this.pendingStart = { section, sentence }
      return
    }
    this.pendingStart = null
    this.hooks.status(t.downloadingAudio(0), true)
    const { src, timings } = await ensureChapter(ch, f => this.hooks.status(t.downloadingAudio(Math.round(f * 100)), true))
    this.hooks.status(null)
    this.eng ??= await engine()
    this.bindEngine()
    const start = timings.find(x => x.i >= sentence)?.s ?? timings.at(-1)?.s ?? 0
    this.loaded = [{ section, timings, duration: ch.duration }]
    await this.eng.load([this.track(section, src)], 0, start, { title: this.book.title, author: this.book.author ?? '' })
    await this.eng.setRate(this.rate)
    this.current = { section, sentence }
    this.lastSentence = -1
    if (autoplay) await this.play()
    void this.fillAhead()
  }
  private pendingStart: { section: number; sentence: number } | null = null

  private track(section: number, src: string): Track {
    return { section, src: isAndroid ? src : lazySrcFor(this.chapters.get(section)!, src), title: this.title(section) }
  }

  private bound = false
  private bindEngine() {
    if (this.bound || !this.eng) return
    this.bound = true
    this.eng.on('state', s => { this.setPlaying(s.playing); this.tick(s.index, s.time) })
    this.eng.on('track', i => { this.lastSentence = -1; void this.fillAhead(); this.tick(i, 0) })
    this.eng.on('ended', () => void this.onEnded())
  }

  // Download and queue the following chapters while the current one plays.
  private async fillAhead(): Promise<void> {
    if (this.appending || !this.eng) return
    this.appending = true
    try {
      for (let k = 0; k < 2; k++) {  // keep up to two chapters queued after the current
        const last = this.loaded[this.loaded.length - 1]
        const next = last ? this.nextSection(last.section) : null
        if (next == null) return
        const ch = this.chapters.get(next)
        if (!ch) { void narrationStore.prioritize(this.book.id, next); return }
        const { src, timings } = await ensureChapter(ch)
        this.loaded.push({ section: next, timings, duration: ch.duration })
        await this.eng.append(this.track(next, src))
      }
    } catch (e) {
      console.warn('prefetch failed', e)
    } finally {
      this.appending = false
    }
  }

  private async onEnded(): Promise<void> {
    const last = this.loaded[this.loaded.length - 1]
    const next = last ? this.nextSection(last.section) : null
    this.setPlaying(false)
    if (next == null) { this.hooks.status(null); return }
    await this.start(next, 0)
  }

  private async onNewChapters(): Promise<void> {
    if (this.pendingStart && this.chapters.has(this.pendingStart.section)) {
      const { section, sentence } = this.pendingStart
      await this.start(section, sentence)
    } else if (this.eng && this.loaded.length) void this.fillAhead()
  }

  private setPlaying(p: boolean) {
    if (p === this.playing) return
    this.playing = p
    this.hooks.playing(p)
    clearInterval(this.poll)
    if (p) this.poll = window.setInterval(() => void this.pollState(), 250)
  }

  private async pollState() {
    if (!this.eng) return
    const s = await this.eng.state()
    this.setPlaying(s.playing)
    this.tick(s.index, s.time)
  }

  private tick(index: number, time: number) {
    const l = this.loaded[index]
    if (!l) return
    this.hooks.time(l.section, time, l.duration)
    const k = findTiming(l.timings, time)
    if (k < 0) return
    const tm = l.timings[k]
    if (l.section === this.current.section && tm.i === this.lastSentence) return
    this.lastSentence = tm.i
    this.current = { section: l.section, sentence: tm.i }
    this.hooks.sentence(l.section, tm.i, tm.cfi)
  }

  async play() { await this.eng?.play() }
  async pause() { await this.eng?.pause() }
  async toggle() {
    if (!this.eng || !this.loaded.length) {
      const { section, sentence } = this.current
      return this.start(section >= 0 ? section : this.sections[0], Math.max(0, sentence))
    }
    return this.playing ? this.pause() : this.play()
  }

  private async here(): Promise<{ index: number; time: number; l: Loaded } | null> {
    if (!this.eng) return null
    const s = await this.eng.state()
    const l = this.loaded[s.index]
    return l ? { index: s.index, time: s.time, l } : null
  }

  async skip(seconds: number) {
    const h = await this.here()
    if (!h) return
    await this.eng!.seek(h.index, Math.max(0, Math.min(h.time + seconds, h.l.duration - 0.2)))
  }
  back() { return this.skip(-SKIP_SECONDS) }
  forward() { return this.skip(SKIP_SECONDS) }

  async stepSentence(delta: number) {
    const h = await this.here()
    if (!h) return
    const k = findTiming(h.l.timings, h.time)
    // "Previous" restarts the current sentence if we're more than 1.5 s into it.
    const target = delta < 0 && k >= 0 && h.time - h.l.timings[k].s > 1.5 ? k : k + delta
    if (target < 0 || target >= h.l.timings.length) {
      const section = delta > 0 ? this.nextSection(h.l.section) : this.sections[this.sections.indexOf(h.l.section) - 1]
      if (section != null) await this.start(section, delta > 0 ? 0 : Number.MAX_SAFE_INTEGER, this.playing)
      return
    }
    await this.eng!.seek(h.index, h.l.timings[target].s + 0.01)
  }

  async seekSentence(section: number, sentence: number) {
    const idx = this.loaded.findIndex(l => l.section === section)
    if (idx >= 0 && this.eng) {
      const tm = this.loaded[idx].timings.find(x => x.i >= sentence)
      await this.eng.seek(idx, (tm?.s ?? 0) + 0.01)
      if (!this.playing) await this.play()
    } else await this.start(section, sentence)
  }

  async setRate(rate: number) {
    this.rate = rate
    await kv.set('rate', rate)
    await this.eng?.setRate(rate)
  }

  async destroy() {
    clearInterval(this.poll)
    this.unsub?.()
    if (this.eng) {
      await this.eng.destroy()
      enginePromise = null
    }
    this.eng = null
  }
}

function lazySrcFor(ch: NarrationChapter, src: string): string {
  if (src.startsWith('blob:')) URL.revokeObjectURL(src)
  return lazySrc(ch)
}

export function findTiming(timings: Timing[], time: number): number {
  let lo = 0, hi = timings.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (timings[mid].s <= time + 0.02) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans === -1 && timings.length ? 0 : ans
}
