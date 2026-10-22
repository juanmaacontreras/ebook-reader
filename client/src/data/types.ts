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

export interface Narration {
  book_id: string
  voice: string
  status: 'active' | 'paused'
  start_section: number | null
  priority_section: number | null
  requested_at: string
  updated_at: string
  state: NarrationState
  current_section: number | null
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
  current: { book_id: string; section: number; voice: string } | null
  audio_bytes: number | null
}

// Sentence manifest, built once per book at import (book/manifest.ts) and read
// by the worker. Sections are spine indices.
export interface ManifestSentence { c: string; t: string; b: number; h?: 1 }
export interface ManifestSection { i: number; label: string; sentences: ManifestSentence[] }
export interface Manifest { v: 1; lang: string; sections: ManifestSection[] }

// Local-only marker on records waiting to be pushed.
export type Local<T> = T & { _dirty?: boolean }
