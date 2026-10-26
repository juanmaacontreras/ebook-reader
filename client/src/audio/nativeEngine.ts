import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { Emitter, type AudioEngine, type EngineState, type Track, type TrackMeta } from './engine'

// Bridge to android/app/src/main/java/com/atril/reader/NarrationPlayerPlugin.java
interface NarrationPlayerPlugin {
  load(o: { tracks: { path: string; title: string }[]; index: number; time: number; title: string; author: string; artwork?: string }): Promise<void>
  append(o: { path: string; title: string }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(o: { index: number; time: number }): Promise<void>
  setRate(o: { rate: number }): Promise<void>
  getState(): Promise<EngineState>
  getVolume(): Promise<{ level: number; max: number }>
  release(): Promise<void>
  addListener(event: 'state' | 'track' | 'ended', fn: (d: EngineState & { index: number }) => void): Promise<PluginListenerHandle>
  addListener(event: 'error', fn: (d: { index: number; message: string }) => void): Promise<PluginListenerHandle>
}

const Native = registerPlugin<NarrationPlayerPlugin>('NarrationPlayer')

export class NativeEngine extends Emitter implements AudioEngine {
  private handles: PluginListenerHandle[] = []

  async init(): Promise<this> {
    this.handles.push(
      await Native.addListener('state', s => this.emit('state', s)),
      await Native.addListener('track', s => this.emit('track', s.index)),
      await Native.addListener('ended', () => this.emit('ended')),
      await Native.addListener('error', e => this.emit('error', e.index, e.message)),
    )
    return this
  }
  async load(tracks: Track[], index: number, time: number, meta: TrackMeta) {
    await Native.load({ tracks: tracks.map(t => ({ path: t.src, title: t.title })), index, time, title: meta.title, author: meta.author, artwork: meta.artwork })
  }
  append(t: Track) { return Native.append({ path: t.src, title: t.title }) }
  play() { return Native.play() }
  pause() { return Native.pause() }
  seek(index: number, time: number) { return Native.seek({ index, time: Math.max(0, time) }) }
  setRate(rate: number) { return Native.setRate({ rate }) }
  state() { return Native.getState() }
  async volume() {
    const v = await Native.getVolume()
    return v.max > 0 ? v.level / v.max : null
  }
  async destroy() {
    for (const h of this.handles) await h.remove()
    this.handles = []
    await Native.release()
  }
}
