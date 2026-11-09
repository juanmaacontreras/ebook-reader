// Atril → Bitácora: the inbox Atril publishes in Bitácora's `buckets` table, row
// `<USER_KEY>::atril`. Atril is its only writer; Bitácora (app and web) only reads it and
// turns it into its own activities and sessions (AtrilImport in the time-tracker repo).
// The format is the contract between the two projects: docs/bitacora.md here and
// docs/atril.md there. Pure, so it is tested without the network (logic_test.ts).

export const VERSION = 1
export const DAYS = 60

export interface SessionRow {
  id: string; book_id: string | null; kind: 'read' | 'listen'
  started_at: string; seconds: number; updated_at: string
}
export interface BookRow { id: string; title: string; author: string | null; subject: string | null }

export interface Inbox {
  v: number
  profile: string
  books: { id: string; title: string; author: string | null; subject: string | null }[]
  sessions: { id: string; bookId: string; kind: 'read' | 'listen'; start: number; seconds: number; updatedAt: number }[]
}

/** The inbox for these rows: sessions with a book and some time, the books they use, both
 *  in a stable order so that the same data always gives the same JSON. */
export function buildInbox(sessions: SessionRow[], books: BookRow[], profile: string): Inbox {
  const byId = new Map(books.map(b => [b.id, b]))
  const out = sessions
    .filter(s => s.book_id && byId.has(s.book_id) && s.seconds > 0)
    .map(s => ({
      id: s.id, bookId: s.book_id!, kind: s.kind, start: Date.parse(s.started_at),
      seconds: Math.round(s.seconds), updatedAt: Date.parse(s.updated_at),
    }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.updatedAt))
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))
  const used = new Set(out.map(s => s.bookId))
  const bookList = books
    .filter(b => used.has(b.id))
    .map(b => ({ id: b.id, title: b.title, author: b.author || null, subject: b.subject || null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  return { v: VERSION, profile, books: bookList, sessions: out }
}

/** Same content: writing it again would only wake Bitácora's devices for nothing. */
export function sameInbox(a: unknown, b: Inbox): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b)
}

/** Oldest start sent: sessions older than this stay in Bitácora but leave the inbox. */
export function since(now: Date): string {
  return new Date(now.getTime() - DAYS * 86400e3).toISOString()
}
