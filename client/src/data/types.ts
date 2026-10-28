// Row shapes shared with the database (supabase/schema.sql) and the TTS worker
// (tts-worker/worker/). Field names are a contract: change all three together.

export type BookStatus = 'to_read' | 'reading' | 'finished'

export interface Book {
  id: string
  sha256: string
  title: string
  author: string | null
  language: string | null
  storage: string
  epub_path: string
  cover_path: string | null
  text_path: string | null
  size_bytes: number | null
  section_count: number | null
  status: BookStatus
  added_at: string
  finished_at: string | null
  updated_at: string
}

export interface Position {
  book_id: string
  cfi: string
  section: number | null
  sentence: number | null
  fraction: number | null
  device: string | null
  updated_at: string
}

// A stretch of reading or listening on one device (stats). See supabase/schema.sql.
export type DeviceKind = 'phone' | 'tablet' | 'pc'
export interface ReadingSession {
  id: string
  book_id: string | null
  kind: 'read' | 'listen'
  device: string | null
  device_kind: DeviceKind | null
  started_at: string
  ended_at: string
  seconds: number
  words: number
  pace_words: number     // clean pages only (reading speed), see data/sessions.ts
  pace_seconds: number
  updated_at: string
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'orange' | 'purple'
export const HIGHLIGHT_COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'orange', 'purple']

export interface Highlight {
  id: string
  book_id: string
  cfi: string
  text: string
  note: string | null
  color: HighlightColor
  section: number | null
  chapter: string | null
  deleted: boolean
  created_at: string
  updated_at: string
}

// status is the user's intent (app-owned); state is what the PC reports
// (worker-owned, read-only here). See supabase/schema.sql.
export type NarrationState = 'waiting' | 'generating' | 'ready' | 'error' | 'purged'

export type NarrationScope = 'chapter' | 'next' | 'all' | 'ahead'

export interface Narration {
  book_id: string
  voice: string
  status: 'active' | 'paused'
  // What the user asked for, from start_section: that chapter, it + the next two,
  // or the whole book. 'ahead' = the old automatic narration, never runs again.
  scope: NarrationScope
  start_section: number | null
  priority_section: number | null
  requested_at: string
  started_at: string | null  // last "Generar ahora"
  updated_at: string
  state: NarrationState
  current_section: number | null
  stopped_at: string | null  // worker: stopped from the PC (Waybar)
  error: string | null
}

export interface Timing { i: number; cfi: string; s: number; e: number }

export interface NarrationChapter {
  book_id: string
  voice: string
  section: number
  audio_path: string
  duration: number
  bytes: number
  timings: Timing[]
  created_at: string
}

export interface VoiceInfo { id: string; label: string; languages: string[]; cloned: boolean }

export interface WorkerStatus {
  heartbeat: string
  voices: VoiceInfo[]
  // until: epoch seconds when the running job should end (worker's estimate).
  current: { book_id: string; section: number; voice: string; title?: string; label?: string; done?: number; total?: number; until?: number } | null
  notice?: string | null  // why the PC can't generate now (GPU busy)
  audio_bytes: number | null
}

// Sentence manifest, built once per book at import (book/manifest.ts) and read
// by the worker. Sections are spine indices.
export interface ManifestSentence { c: string; t: string; b: number; h?: 1 }
export interface ManifestSection { i: number; label: string; sentences: ManifestSentence[] }
export interface Manifest { v: 1; lang: string; sections: ManifestSection[] }

// Local-only marker on records waiting to be pushed.
export type Local<T> = T & { _dirty?: boolean }
