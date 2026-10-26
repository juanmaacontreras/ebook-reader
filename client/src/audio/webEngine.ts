import { Emitter, SKIP_SECONDS, type AudioEngine, type EngineState, type Track, type TrackMeta } from './engine'

export class WebEngine extends Emitter implements AudioEngine {
  private audio = new Audio()
  private tracks: Track[] = []
  private index = 0
  private rate = 1

  constructor(private resolveSrc: (t: Track) => Promise<string> = async t => t.src) {
    super()
    this.audio.preload = 'auto'
    this.audio.addEventListener('ended', () => void this.next())
    this.audio.addEventListener('play', () => this.emitState())
    this.audio.addEventListener('pause', () => this.emitState())
    this.audio.addEventListener('seeked', () => this.emitState())
    this.audio.addEventListener('error', () => {
      if (this.audio.getAttribute('src')) this.emit('error', this.index, this.audio.error?.message || `code ${this.audio.error?.code}`)
    })
    const ms = navigator.mediaSession
    if (ms) {
      ms.setActionHandler('play', () => void this.play())
      ms.setActionHandler('pause', () => void this.pause())
      ms.setActionHandler('seekbackward', () => void this.seek(this.index, this.audio.currentTime - SKIP_SECONDS))
      ms.setActionHandler('seekforward', () => void this.seek(this.index, this.audio.currentTime + SKIP_SECONDS))
      ms.setActionHandler('previoustrack', () => void this.seek(Math.max(0, this.index - 1), 0))
      ms.setActionHandler('nexttrack', () => void (this.index + 1 < this.tracks.length && this.seek(this.index + 1, 0)))
    }
  }

  private emitState() { this.emit('state', { index: this.index, time: this.audio.currentTime, playing: !this.audio.paused }) }

  private async setTrack(index: number, time: number): Promise<void> {
    this.index = index
    const src = await this.resolveSrc(this.tracks[index])
    if (this.audio.src !== src) {
      if (this.audio.src.startsWith('blob:')) URL.revokeObjectURL(this.audio.src)
      this.audio.src = src
      await new Promise<void>((resolve, reject) => {
        const off = () => { this.audio.removeEventListener('loadedmetadata', done); this.audio.removeEventListener('error', fail) }
        const done = () => { off(); resolve() }
        const fail = () => { off(); reject(new Error('audio unplayable')) }
        this.audio.addEventListener('loadedmetadata', done)
        this.audio.addEventListener('error', fail)
        this.audio.load()
      })
    }
    this.audio.playbackRate = this.rate
    this.audio.currentTime = Math.max(0, time)
  }

  private async next(): Promise<void> {
    if (this.index + 1 >= this.tracks.length) { this.emit('ended'); this.emitState(); return }
    await this.setTrack(this.index + 1, 0)
    this.emit('track', this.index)
    await this.audio.play()
  }

  async load(tracks: Track[], index: number, time: number, meta: TrackMeta): Promise<void> {
    this.tracks = [...tracks]
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title, artist: meta.author, artwork: meta.artwork ? [{ src: meta.artwork, sizes: '512x512' }] : [],
      })
    }
    await this.setTrack(index, time)
  }
  async append(track: Track) { this.tracks.push(track) }
  async play() { await this.audio.play() }
  async pause() { this.audio.pause() }
  async seek(index: number, time: number) {
    if (index !== this.index) {
      const playing = !this.audio.paused
      await this.setTrack(index, time)
      this.emit('track', index)
      if (playing) await this.audio.play()
    } else this.audio.currentTime = Math.max(0, Math.min(time, (this.audio.duration || time) - 0.05))
    this.emitState()
  }
  async setRate(rate: number) { this.rate = rate; this.audio.playbackRate = rate }
  async volume() { return null }  // browsers don't expose the system volume
  async state(): Promise<EngineState> { return { index: this.index, time: this.audio.currentTime, playing: !this.audio.paused } }
  async destroy() {
    this.audio.pause()
    if (this.audio.src.startsWith('blob:')) URL.revokeObjectURL(this.audio.src)
    this.audio.removeAttribute('src')
    this.audio.load()
  }
}
