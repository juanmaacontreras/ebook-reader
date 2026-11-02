import { describe, expect, it } from 'vitest'
import {
  bookEntitlement, decodeCursor, encodeCursor, EPOCH, initResources, koboTime, parsePath, parseStatePut,
  percentAtSentence, placeAtPercent, readingState, statusFromKobo, statusToKobo, type BookRow,
} from '../../supabase/functions/kobo/protocol'
import resources from '../../supabase/functions/kobo/resources.json'

const book: BookRow = {
  id: '11111111-2222-3333-4444-555555555555', title: 'T', author: 'A y B', language: 'es-AR',
  status: 'reading', added_at: '2026-11-01T10:00:00.123Z', updated_at: '2026-11-02T10:00:00.000Z',
  synced_at: '2026-11-02T10:00:00.000Z', size_bytes: 10,
}
const manifest = {
  sections: [
    { i: 0, sentences: [{ c: 'a', t: 'x'.repeat(10) }, { c: 'b', t: 'x'.repeat(10) }] },
    { i: 2, sentences: [{ c: 'c', t: 'x'.repeat(20) }, { c: 'd', t: 'x'.repeat(60) }] },
  ],
}

describe('kobo protocol', () => {
  it('routes with and without the functions prefix', () => {
    expect(parsePath('/functions/v1/kobo/tok/v1/library/sync')).toEqual({ token: 'tok', rest: '/v1/library/sync' })
    expect(parsePath('/kobo/tok')).toEqual({ token: 'tok', rest: '/' })
    expect(parsePath('/other')).toBeNull()
  })
  it('formats timestamps without milliseconds', () => {
    expect(koboTime('2026-11-01T10:00:00.123Z')).toBe('2026-11-01T10:00:00Z')
  })
  it('maps statuses both ways', () => {
    expect(statusToKobo('finished')).toBe('Finished')
    expect(statusFromKobo('Reading')).toBe('reading')
    expect(statusFromKobo('nope')).toBeNull()
  })
  it('round trips the sync cursor and survives garbage', () => {
    const c = { books: '2026-01-01T00:00:00.000Z', positions: '2026-01-02T00:00:00.000Z' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
    expect(decodeCursor('%%%')).toEqual({ books: EPOCH, positions: EPOCH })
    expect(decodeCursor(null).books).toBe(EPOCH)
  })
  it('points every store URL at the function', () => {
    const r = initResources(resources, 'https://x.supabase.co/functions/v1/kobo', 'tok')
    expect(JSON.stringify(r)).not.toContain('storeapi.kobo.com')
    expect(r.library_sync).toBe('https://x.supabase.co/functions/v1/kobo/tok/v1/library/sync')
    expect(r.reading_state).toBe('https://x.supabase.co/functions/v1/kobo/v1/library/{Ids}/state')
  })
  it('builds an entitlement keyed by the book id', () => {
    const e = bookEntitlement(book)
    expect(e.Id).toBe(book.id)
    expect(e.IsRemoved).toBe(false)
    expect(bookEntitlement(book, true).IsRemoved).toBe(true)
  })
  it('maps percent to the sentence by text length and back', () => {
    // 100 characters in total: sentence starts at 0, 10, 20, 40
    expect(placeAtPercent(manifest, 0)).toMatchObject({ section: 0, sentence: 0 })
    expect(placeAtPercent(manifest, 25)).toMatchObject({ section: 2, sentence: 0, cfi: 'c' })
    expect(placeAtPercent(manifest, 99)).toMatchObject({ section: 2, sentence: 1, cfi: 'd' })
    expect(placeAtPercent(manifest, 150)).toMatchObject({ cfi: 'd' })
    expect(percentAtSentence(manifest, 2, 1)).toBe(40)
    expect(percentAtSentence(manifest, 9, 9)).toBeNull()
    expect(placeAtPercent({ sections: [] }, 10)).toBeNull()
  })
  it('prefers a newer Atril position, otherwise echoes the Kobo report', () => {
    const k = {
      status: 'Reading', progress: 12.5, source_progress: 12.5,
      location: { Value: 'kobo.1.1', Type: 'KoboSpan', Source: 'ch1.xhtml' },
      spent_minutes: 5, remaining_minutes: 60, last_modified: '2026-11-02T09:00:00Z',
    }
    const newer = readingState(book, k, { percent: 40, at: '2026-11-02T11:00:00Z' })
    expect(newer.CurrentBookmark.ProgressPercent).toBe(40)
    expect(newer.CurrentBookmark).not.toHaveProperty('Location')
    const older = readingState(book, k, { percent: 40, at: '2026-11-02T08:00:00Z' })
    expect(older.CurrentBookmark.ProgressPercent).toBe(12.5)
    expect(older.CurrentBookmark.Location).toEqual(k.location)
    expect(older.StatusInfo.Status).toBe('Reading')
    expect(readingState(book, null, null).CurrentBookmark).toEqual({ LastModified: '2026-11-02T10:00:00Z' })
  })
  it('parses a state PUT and tolerates missing parts', () => {
    const p = parseStatePut({
      ReadingStates: [{
        CurrentBookmark: { ProgressPercent: 33, ContentSourceProgressPercent: 30, Location: { Value: 'kobo.2.3', Type: 'KoboSpan', Source: 'c.xhtml' } },
        Statistics: { SpentReadingMinutes: 7, RemainingTimeMinutes: 90 },
        StatusInfo: { Status: 'Finished' },
      }],
    })
    expect(p).toMatchObject({ status: 'finished', progress: 33, source_progress: 30, spent_minutes: 7, hasBookmark: true })
    expect(p.location?.Value).toBe('kobo.2.3')
    expect(parseStatePut(null)).toMatchObject({ status: null, progress: null, hasBookmark: false })
  })
})
