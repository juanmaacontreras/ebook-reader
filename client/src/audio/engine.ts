// Playback backend. The narration controller (controller.ts) drives one of:
//  - WebEngine: <audio> element + Media Session API (desktop, browser).
//  - NativeEngine: the app's own Android plugin (Media3/ExoPlayer in a
//    foreground service): keeps playing with the screen off, shows the media
//    notification and takes headphone/Bluetooth buttons.
// Tracks are chapters, always played from this device's cache (never streamed).

export interface Track {
  section: number
  src: string       // object URL (web) or absolute file path (Android)
  title: string
}

export interface TrackMeta { title: string; author: string; artwork?: string }

export interface EngineState { index: number; time: number; playing: boolean }

export interface EngineEvents {
  state: (s: EngineState) => void      // play/pause changes, seeks
  track: (index: number) => void       // moved to another track (end of chapter)
  ended: () => void                    // finished the last track
}

export interface AudioEngine {
  load(tracks: Track[], index: number, time: number, meta: TrackMeta): Promise<void>
  append(track: Track): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(index: number, time: number): Promise<void>
  setRate(rate: number): Promise<void>
  state(): Promise<EngineState>
  on<K extends keyof EngineEvents>(event: K, fn: EngineEvents[K]): void
  destroy(): Promise<void>
}

export class Emitter {
  private fns: { [K in keyof EngineEvents]?: EngineEvents[K][] } = {}
  on<K extends keyof EngineEvents>(event: K, fn: EngineEvents[K]): void {
    ;(this.fns[event] ??= [] as never[]).push(fn as never)
  }
  emit<K extends keyof EngineEvents>(event: K, ...args: Parameters<EngineEvents[K]>): void {
    for (const fn of this.fns[event] ?? []) (fn as (...a: unknown[]) => void)(...args)
  }
}

export const SKIP_SECONDS = 30
export const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
