// deno test supabase/functions/bitacora
import { assertEquals } from 'jsr:@std/assert@1'
import { type BookRow, buildInbox, sameInbox, type SessionRow, since } from './logic.ts'

const books: BookRow[] = [
  { id: 'b2', title: 'Fundación', author: 'Isaac Asimov', subject: null },
  { id: 'b1', title: 'Sistemas de Comunicaciones — Segundo parcial', author: '', subject: 'Sistemas de Comunicaciones' },
  { id: 'b3', title: 'Sin sesiones', author: null, subject: null },
]
const row = (id: string, book: string | null, start: string, seconds = 600): SessionRow => ({
  id, book_id: book, kind: 'listen', started_at: start, seconds, updated_at: '2026-11-09T20:00:00Z',
})

Deno.test('the inbox carries sessions with a book and time, and only the books they use', () => {
  const inbox = buildInbox([
    row('s2', 'b2', '2026-11-09T18:00:00Z'),
    row('s1', 'b1', '2026-11-09T11:15:00Z', 2999.6),
    row('s3', null, '2026-11-09T12:00:00Z'),        // book deleted from the library
    row('s4', 'b1', '2026-11-09T13:00:00Z', 0),     // nothing counted
  ], books, 'default')
  assertEquals(inbox.v, 1)
  assertEquals(inbox.profile, 'default')
  assertEquals(inbox.sessions.map(s => [s.id, s.bookId, s.seconds]), [['s1', 'b1', 3000], ['s2', 'b2', 600]])
  assertEquals(inbox.sessions[0].start, Date.parse('2026-11-09T11:15:00Z'))
  assertEquals(inbox.sessions[0].updatedAt, Date.parse('2026-11-09T20:00:00Z'))
  assertEquals(inbox.books, [
    { id: 'b1', title: 'Sistemas de Comunicaciones — Segundo parcial', author: null, subject: 'Sistemas de Comunicaciones' },
    { id: 'b2', title: 'Fundación', author: 'Isaac Asimov', subject: null },
  ])
})

Deno.test('the same data gives the same inbox, in any order: nothing to write', () => {
  const a = buildInbox([row('s1', 'b1', '2026-11-09T11:15:00Z'), row('s2', 'b2', '2026-11-09T18:00:00Z')], books, 'default')
  const b = buildInbox([row('s2', 'b2', '2026-11-09T18:00:00Z'), row('s1', 'b1', '2026-11-09T11:15:00Z')], [...books].reverse(), 'default')
  assertEquals(sameInbox(JSON.parse(JSON.stringify(a)), b), true)
  assertEquals(sameInbox(null, b), false)
  // Read back from jsonb, keys come in Postgres's order (shorter first): still the same.
  const reordered = JSON.parse(JSON.stringify({ sessions: a.sessions.map(s => ({ updatedAt: s.updatedAt, id: s.id, kind: s.kind,
    start: s.start, bookId: s.bookId, seconds: s.seconds })), v: a.v, books: a.books, profile: a.profile }))
  assertEquals(sameInbox(reordered, b), true)
  assertEquals(sameInbox(a, buildInbox([row('s1', 'b1', '2026-11-09T11:15:00Z', 900)], books, 'default')), false)
})

Deno.test('sixty days back', () => {
  assertEquals(since(new Date('2026-11-09T00:00:00Z')), '2026-09-10T00:00:00.000Z')
})
