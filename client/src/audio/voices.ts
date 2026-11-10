import type { VoiceInfo } from '../data/types'

// Fallback voice list for when the PC hasn't reported its own yet
// (worker_status.voices). Same ids as tts-worker/worker/engines.
export const DEFAULT_VOICES: VoiceInfo[] = [
  { id: 'chatterbox-latam:ar_mateo', label: 'Mateo', languages: ['es'], cloned: true },
  { id: 'chatterbox-latam:ar_lucia', label: 'Lucía', languages: ['es'], cloned: true },
  { id: 'chatterbox-latam:ar_elena', label: 'Elena', languages: ['es'], cloned: true },
  { id: 'kokoro:ef_dora', label: 'Dora', languages: ['es'], cloned: false },
  { id: 'kokoro:em_alex', label: 'Alex', languages: ['es'], cloned: false },
  { id: 'kokoro:em_santa', label: 'Santa', languages: ['es'], cloned: false },
  { id: 'kokoro:af_heart', label: 'Heart', languages: ['en'], cloned: false },
  { id: 'kokoro:af_bella', label: 'Bella', languages: ['en'], cloned: false },
  { id: 'kokoro:am_michael', label: 'Michael', languages: ['en'], cloned: false },
  { id: 'kokoro:bf_emma', label: 'Emma', languages: ['en'], cloned: false },
  { id: 'kokoro:bm_george', label: 'George', languages: ['en'], cloned: false },
]

// Defaults picked by the user by ear. Spanish (2026-11-10): Mateo and Lucía, cloned from
// human recordings, over Elena, cloned from a synthetic voice and heard as robotic.
const SPANISH = ['chatterbox-latam:ar_mateo', 'chatterbox-latam:ar_lucia']

export function defaultVoice(lang: string): string {
  return lang.startsWith('en') ? 'kokoro:af_heart' : SPANISH[0]
}

// The short list shown first: the default voice (both picks in Spanish), a fast one, and
// whatever the book already uses. Everything else is behind "Más voces".
export function featuredVoices(lang: string, current: string | null): string[] {
  const fast = lang.startsWith('en') ? 'kokoro:af_heart' : 'kokoro:ef_dora'
  return [...new Set([...(lang.startsWith('en') ? [defaultVoice(lang)] : SPANISH), fast, ...(current ? [current] : [])])]
}
