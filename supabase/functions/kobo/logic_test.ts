// deno test supabase/functions/kobo
import { assertEquals } from 'jsr:@std/assert@1'
import {
  deviceTime, fileFor, type KepubMap, type Manifest, metadata, offerNewer, replacedOnDevice, placeForKobo, placeFromKobo, readCursor, readingState, samePlace,
  seriesId, seriesNumbers, startOf, statusChange, takesPlace, tell, toldAfter, wordsBetween, writeCursor,
} from './logic.ts'

const map: KepubMap = { v: 1, files: [{ p: 'OEBPS/Text/cap1.xhtml', i: 2, n: 10 }, { p: 'OEBPS/Text/cap2.xhtml', i: 3, n: 4 }] }

Deno.test('a Kobo place is a manifest sentence, and back', () => {
  assertEquals(placeFromKobo(map, { Type: 'KoboSpan', Value: 'kobo.5.2', Source: 'OEBPS/Text/cap1.xhtml' }), { section: 2, sentence: 4 })
  assertEquals(placeForKobo(map, 2, 4)?.location, { Value: 'kobo.5.1', Type: 'KoboSpan', Source: 'OEBPS/Text/cap1.xhtml' })
  // Named without the archive's folder, encoded, or with a fragment.
  assertEquals(placeFromKobo(map, { Type: 'KoboSpan', Value: 'kobo.1.1', Source: 'Text/cap2.xhtml' }), { section: 3, sentence: 0 })
  assertEquals(fileFor(map, 'OEBPS/Text/cap2.xhtml#kobo.1.1')?.i, 3)
  assertEquals(fileFor(map, 'OEBPS%2FText%2Fcap1.xhtml')?.i, 2)
  // Past the end clamps; not a span or another chapter is nothing.
  assertEquals(placeFromKobo(map, { Type: 'KoboSpan', Value: 'kobo.99.1', Source: 'OEBPS/Text/cap2.xhtml' })?.sentence, 3)
  assertEquals(placeFromKobo(map, { Type: 'KoboSpan', Value: 'point(/1/4)', Source: 'OEBPS/Text/cap2.xhtml' }), null)
  assertEquals(placeFromKobo(map, { Type: 'KoboSpan', Value: 'kobo.1.1', Source: 'OEBPS/Text/portada.xhtml' }), null)
  // A section with no text of its own goes to the nearest text (see below).
  assertEquals(placeForKobo(map, 7, 0)?.location.Value, 'kobo.4.1')
})

Deno.test('words read going forward', () => {
  const m: Manifest = { v: 1, lang: 'es', sections: [
    { i: 2, label: '', sentences: [{ c: '', t: 'Uno dos.' }, { c: '', t: 'Tres — cuatro.' }, { c: '', t: 'Cinco.' }] },
    { i: 3, label: '', sentences: [{ c: '', t: 'Seis siete.' }, { c: '', t: 'Ocho.' }] },
  ] }
  assertEquals(wordsBetween(m, { section: 2, sentence: 1 }, { section: 3, sentence: 1 }), 5)  // tres cuatro cinco seis siete
  assertEquals(wordsBetween(m, { section: 3, sentence: 1 }, { section: 2, sentence: 0 }), 0)
})

Deno.test('device times', () => {
  const now = new Date('2026-11-02T20:00:00Z')
  assertEquals(deviceTime('2026-11-02T19:14:18.1234567Z', now)?.toISOString(), '2026-11-02T19:14:18.123Z')
  assertEquals(deviceTime('2027-01-01T00:00:00Z', now), now)  // a clock ahead never wins
  assertEquals(deviceTime('mañana', now), null)
})

Deno.test('only a status changed on the device counts', () => {
  assertEquals(statusChange('Reading', 'Reading', 'to_read'), null)        // repeated
  assertEquals(statusChange('ReadyToRead', 'Reading', 'to_read'), 'reading')
  assertEquals(statusChange('Reading', 'Reading', 'finished'), null)
  assertEquals(statusChange(undefined, 'Reading', 'finished'), null)      // never undoes "terminado"
  assertEquals(statusChange('Reading', 'Finished', 'reading'), 'finished')
  assertEquals(statusChange('Finished', 'ReadyToRead', 'finished'), 'to_read')  // "marcar como no leído"
  assertEquals(statusChange(undefined, 'ReadyToRead', 'reading'), null)  // first report of a new book
  assertEquals(statusChange('Reading', 'ReadyToRead', 'reading'), 'to_read')  // "marcar como no leído" mid-book
  // "Por leer" set in Atril while the device had it as Reading: reading on there
  // (its place moved) makes it "Leyendo" again; the same place repeated doesn't.
  assertEquals(statusChange('Reading', 'Reading', 'to_read', true), 'reading')
  assertEquals(statusChange('Reading', 'Reading', 'to_read', false), null)
  assertEquals(statusChange('Reading', 'Reading', 'finished', true), null)   // finished elsewhere: reading on doesn't undo it
  assertEquals(statusChange('Finished', 'Reading', 'finished'), 'reading')   // taken up again on the device
  assertEquals(statusChange('ReadyToRead', 'Reading', 'finished'), null)     // finished elsewhere, then opened here
})

Deno.test('a status Atril told the device does not come back as a change made there', () => {
  // "Por leer" set in Atril; the device takes it and says so at its next sync,
  // when the book is "Leyendo" again elsewhere: nothing changes.
  assertEquals(statusChange('Reading', 'ReadyToRead', 'reading', false, ['ReadyToRead']), null)
  assertEquals(statusChange('Reading', 'Finished', 'reading', false, ['Finished']), null)
  assertEquals(statusChange('ReadyToRead', 'Reading', 'to_read', true, ['Reading']), 'reading')  // reading on there still counts
  assertEquals(statusChange('Reading', 'ReadyToRead', 'reading', false, ['Finished']), 'to_read')  // not told: made there
  // What it was told: only a status other than the one it last reported.
  assertEquals(tell([], 'Reading', 'ReadyToRead'), ['ReadyToRead'])
  assertEquals(tell([], 'Reading', 'Reading'), [])
  assertEquals(tell(['ReadyToRead'], 'Reading', 'ReadyToRead'), ['ReadyToRead'])
  assertEquals(tell(['ReadyToRead', 'Reading'], 'Finished', 'ReadyToRead'), ['Reading', 'ReadyToRead'])
  assertEquals(tell(['ReadyToRead'], 'Reading', 'Reading'), ['ReadyToRead'])  // its own status: a report may still carry RTR
  // And after each report.
  assertEquals(toldAfter(['ReadyToRead'], 'Reading', 'Reading'), ['ReadyToRead'])  // made before it was told
  assertEquals(toldAfter(['ReadyToRead'], 'Reading', 'Reading', true), [])         // made after: it didn't take it
  assertEquals(toldAfter(['ReadyToRead'], 'Reading', 'ReadyToRead', true), [])      // took it
  assertEquals(toldAfter(['ReadyToRead', 'Reading'], 'Finished', 'ReadyToRead'), ['Reading'])
  assertEquals(toldAfter(['ReadyToRead'], 'Reading', 'Finished'), [])               // a change of its own
  assertEquals(toldAfter(['ReadyToRead'], 'Reading', undefined, true), ['ReadyToRead'])
})

Deno.test('a book starts at its first sentence of text', () => {
  const m: Manifest = { v: 1, lang: 'es', sections: [
    { i: 0, label: 'Cubierta', sentences: [] },
    { i: 2, label: '', sentences: [{ c: 'epubcfi(/6/6!/4/2/1:0)', t: 'Uno.' }, { c: 'x', t: 'Dos.' }] },
  ] }
  assertEquals(startOf(m), { section: 2, sentence: 0, cfi: 'epubcfi(/6/6!/4/2/1:0)' })
  assertEquals(startOf({ v: 1, lang: 'es', sections: [{ i: 0, label: '', sentences: [] }] }), null)
})

Deno.test('a device that missed progress elsewhere does not take everyone back', () => {
  const phone = { section: 5, sentence: 10, fraction: 0.5, device: 'phone-1', updated_at: '2026-11-02T10:00:00Z' }
  const at = (section: number, sentence: number) => ({ section, sentence })
  // Picked up before it synced: its previous report was elsewhere.
  assertEquals(takesPlace(at(3, 4), at(3, 2), phone, 'kobo:1'), false)   // reading on behind: kept
  assertEquals(takesPlace(at(5, 9), at(3, 2), phone, 'kobo:1'), false)
  assertEquals(takesPlace(at(5, 11), at(3, 2), phone, 'kobo:1'), true)   // past it: counts
  assertEquals(takesPlace(at(6, 0), null, phone, 'kobo:1'), true)
  // In sync: it had reached that place, or the newest place is its own.
  assertEquals(takesPlace(at(5, 2), at(5, 10), phone, 'kobo:1'), true)    // went back from there
  // Past it: the newest place is a move back made elsewhere, nothing it missed.
  assertEquals(takesPlace(at(3, 0), at(7, 0), phone, 'kobo:1'), true)     // back past it too
  assertEquals(takesPlace(at(5, 3), at(5, 12), phone, 'kobo:1'), true)
  assertEquals(takesPlace(at(8, 0), at(7, 0), phone, 'kobo:1'), true)
  assertEquals(takesPlace(at(1, 0), at(4, 0), { ...phone, device: 'kobo:1' }, 'kobo:1'), true)
  assertEquals(takesPlace(at(1, 0), null, null, 'kobo:1'), true)
  assertEquals(takesPlace(at(1, 0), null, { ...phone, section: null, sentence: null }, 'kobo:1'), true)
})

Deno.test('a page without text goes to the Kobo as the nearest text', () => {
  const book: KepubMap = { v: 1, files: [
    { p: 'OEBPS/Text/cover.xhtml', i: 0, n: 0 }, { p: 'OEBPS/Text/ch1.xhtml', i: 1, n: 8 },
    { p: 'OEBPS/Text/plate.xhtml', i: 2, n: 0 }, { p: 'OEBPS/Text/ch2.xhtml', i: 3, n: 5 }, { p: 'OEBPS/Text/end.xhtml', i: 4, n: 0 },
  ] }
  // The cover (or a place before any text): the start of the book's text.
  assertEquals(placeForKobo(book, 0, 0)?.location, { Value: 'kobo.1.1', Type: 'KoboSpan', Source: 'OEBPS/Text/ch1.xhtml' })
  // An image between chapters: the start of the next one.
  assertEquals(placeForKobo(book, 2, 0)?.location, { Value: 'kobo.1.1', Type: 'KoboSpan', Source: 'OEBPS/Text/ch2.xhtml' })
  // Nothing after it: the end of the last text.
  assertEquals(placeForKobo(book, 4, 0)?.location, { Value: 'kobo.5.1', Type: 'KoboSpan', Source: 'OEBPS/Text/ch2.xhtml' })
  assertEquals(placeForKobo(book, 1, 3)?.location.Value, 'kobo.4.1')
  assertEquals(placeForKobo({ v: 1, files: [] }, 0, 0), null)
})

Deno.test('same place ignores the time and status', () => {
  const at = (v: string, t: string) => ({ CurrentBookmark: { LastModified: t, Location: { Value: v, Type: 'KoboSpan', Source: 'a' } } })
  assertEquals(samePlace(at('kobo.1.1', 'x'), at('kobo.1.1', 'y')), true)
  assertEquals(samePlace(at('kobo.1.1', 'x'), at('kobo.2.1', 'x')), false)
  assertEquals(samePlace(null, at('kobo.1.1', 'x')), false)
})

Deno.test('reading state: a place from the phone goes to the Kobo', () => {
  const book = { id: 'b', title: 'T', author: null, language: 'es', status: 'reading' as const, added_at: '2026-10-01T00:00:00Z', finished_at: null, updated_at: '2026-11-01T00:00:00Z' }
  const pos = { section: 3, sentence: 2, fraction: 0.42, device: 'phone-1', updated_at: '2026-11-02T10:00:00.500Z' }
  const s = readingState(book, pos, map, { state: { Statistics: { SpentReadingMinutes: 30 } }, device: 'kobo:1' })
  assertEquals(s.CurrentBookmark.Location, { Value: 'kobo.3.1', Type: 'KoboSpan', Source: 'OEBPS/Text/cap2.xhtml' })
  assertEquals(s.CurrentBookmark.ProgressPercent, 42)
  assertEquals(s.LastModified, '2026-11-02T10:00:00Z')
  assertEquals(s.StatusInfo.Status, 'Reading')
  assertEquals(s.Statistics.SpentReadingMinutes, 30)  // the device's count is kept
  // Its own place: handed back as it sent it.
  const own = { CurrentBookmark: { Location: { Value: 'kobo.9.1' } }, StatusInfo: { Status: 'Reading' } }
  const back = readingState(book, { ...pos, device: 'kobo:1' }, map, { state: own, device: 'kobo:1' })
  assertEquals(back.CurrentBookmark.Location.Value, 'kobo.9.1')
})

Deno.test('a place the Kobo has not seen goes dated after its opening stamp', () => {
  // kobo_log 2026-11-05: read on the phone at 19:34Z, the Kobo opened at home at
  // 20:05Z (its last report: the night before) and kept its own page.
  const book = { id: 'b', title: 'T', author: null, language: 'es', status: 'reading' as const, added_at: '2026-10-01T00:00:00Z', finished_at: null, updated_at: '2026-11-01T00:00:00Z' }
  const pos = { section: 3, sentence: 2, fraction: 0.42, device: 'phone-1', updated_at: '2026-11-05T19:34:07.320Z' }
  const lastNight = { CurrentBookmark: { LastModified: '2026-11-05T02:22:00Z', Location: { Value: 'kobo.285.1' } }, StatusInfo: { Status: 'Reading' } }
  const own = { state: lastNight, device: 'kobo:1' }
  const now = new Date('2026-11-05T20:05:04Z')
  const s = offerNewer(readingState(book, pos, map, own), pos, own, now)
  assertEquals(s.CurrentBookmark.LastModified, '2026-11-05T20:06:04Z')
  assertEquals(s.LastModified, '2026-11-05T20:06:04Z')
  assertEquals(s.PriorityTimestamp, '2026-11-05T20:06:04Z')
  assertEquals(s.CurrentBookmark.Location.Value, 'kobo.3.1')  // the place itself is unchanged
  assertEquals(s.StatusInfo.LastModified, '2026-11-05T19:34:07Z')  // status keeps its real time
  // Handed to it, and it reported since a bookmark dated after that (took it, declined and
  // read on): the real time, not offered again.
  const after = { ...lastNight, CurrentBookmark: { ...lastNight.CurrentBookmark, LastModified: '2026-11-05T20:05:38Z' } }
  const had = { state: after, device: 'kobo:1', offered: '2026-11-05T19:34:07.32+00:00', offered_at: '2026-11-05T20:05:04Z', state_at: '2026-11-05T20:05:40Z' }
  assertEquals(offerNewer(readingState(book, pos, map, had), pos, had, now).CurrentBookmark.LastModified, '2026-11-05T19:34:07Z')
  // kobo_log 2026-11-10 15:14: handed 5 s after the book was opened (Wi-Fi waking) and not
  // taken; then its report of the old page, stamped on opening, before the offer. Not had:
  // offered again at its next request.
  const opening = { ...had, state: { ...lastNight, CurrentBookmark: { ...lastNight.CurrentBookmark, LastModified: '2026-11-05T20:04:59Z' } } }
  assertEquals(offerNewer(readingState(book, pos, map, opening), pos, opening, now).CurrentBookmark.LastModified, '2026-11-05T20:06:04Z')
  // Handed but no report after it yet: still offered.
  const asked = { ...had, state_at: '2026-11-05T02:22:02Z' }
  assertEquals(offerNewer(readingState(book, pos, map, asked), pos, asked, now).CurrentBookmark.LastModified, '2026-11-05T20:06:04Z')
  // A report freshly dated that got here before it asked: never handed, so offered.
  const woke = { state: { ...lastNight, CurrentBookmark: { ...lastNight.CurrentBookmark, LastModified: '2026-11-05T20:05:03Z' } }, device: 'kobo:1', state_at: '2026-11-05T20:05:03Z' }
  assertEquals(offerNewer(readingState(book, pos, map, woke), pos, woke, now).CurrentBookmark.LastModified, '2026-11-05T20:06:04Z')
  // It had an earlier place from the phone; the phone read on since: the new one is offered.
  const earlier = { ...had, offered: '2026-11-05T18:00:00Z', offered_at: '2026-11-05T18:10:00Z' }
  assertEquals(offerNewer(readingState(book, pos, map, earlier), pos, earlier, now).CurrentBookmark.LastModified, '2026-11-05T20:06:04Z')
  // Never reported: offered. Its own place: handed back as it is.
  const none = { state: null, device: 'kobo:1' }
  assertEquals(offerNewer(readingState(book, pos, map, none), pos, none, now).CurrentBookmark.LastModified, '2026-11-05T20:06:04Z')
  const mine = { ...pos, device: 'kobo:1' }
  const back = readingState(book, mine, map, own)
  assertEquals(offerNewer(back, mine, own, now), back)
})

Deno.test('sync token round trip; Kobo\'s own token starts over', () => {
  const c = { books: '2026-11-02T10:00:00.123456+00:00', positions: '1970-01-01T00:00:00Z', deleted: '2026-11-01T08:00:00.5+00:00' }
  assertEquals(readCursor(writeCursor(c)), c)
  assertEquals(readCursor('eyJhbGciOi.abc.def'), null)
  assertEquals(readCursor(btoa(JSON.stringify({ atril: 1, b: '2026-11-02T00:00:00Z' }))), null)  // version 1 starts over
  assertEquals(readCursor(btoa(JSON.stringify({ atril: 2, b: '2099' + "'" }))), null)  // not a date: starts over
  assertEquals(readCursor(null), null)
})

Deno.test('a book with a subject goes as part of that series, numbered by when it was added', () => {
  const book = { id: 'b2', title: 'Segundo parcial', author: null, language: 'es', status: 'reading' as const, added_at: '2026-11-09T00:00:00Z', finished_at: null, updated_at: '2026-11-09T00:00:00Z' }
  const numbers = seriesNumbers([
    { id: 'b2', subject: 'Sistemas de Comunicaciones', added_at: '2026-11-09T00:00:00Z' },
    { id: 'b1', subject: 'sistemas de comunicaciones ', added_at: '2026-11-03T00:00:00Z' },
    { id: 'x', subject: 'TC2', added_at: '2026-11-05T00:00:00Z' },
    { id: 'n', subject: null, added_at: '2026-11-01T00:00:00Z' },
  ])
  assertEquals([numbers.get('b1'), numbers.get('b2'), numbers.get('x'), numbers.get('n')], [1, 2, 1, undefined])
  const m = metadata({ ...book, subject: 'Sistemas de Comunicaciones' }, 'https://x', 10, numbers.get('b2'))
  assertEquals(m.Series, { Id: seriesId('Sistemas de Comunicaciones'), Name: 'Sistemas de Comunicaciones', Number: '2', NumberFloat: 2 })
  // The same series whatever the case or spaces; a valid UUID shape; another subject, another id.
  assertEquals(seriesId(' sistemas de comunicaciones'), seriesId('Sistemas de Comunicaciones'))
  assertEquals(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/.test(seriesId('TC2')), true)
  assertEquals(seriesId('TC2') === seriesId('TC1'), false)
  // No subject: no series at all, as before.
  assertEquals('Series' in metadata(book, 'https://x', 10), false)
  assertEquals('Series' in metadata({ ...book, subject: '  ' }, 'https://x', 10), false)
})

Deno.test('a book replaced after the device downloaded it is told apart; an unknown version is left alone', () => {
  const at = '2026-11-10T03:30:08Z'
  assertEquals(replacedOnDevice({ confirmed_at: at, has_sha: 'old' }, 'new'), true)
  assertEquals(replacedOnDevice({ confirmed_at: at, has_sha: 'same' }, 'same'), false)
  assertEquals(replacedOnDevice({ confirmed_at: at, has_sha: null }, 'new'), false)   // downloaded before this was recorded
  assertEquals(replacedOnDevice({ confirmed_at: null, has_sha: 'old' }, 'new'), false) // not on the device: it goes as new anyway
  assertEquals(replacedOnDevice(undefined, 'new'), false)
  assertEquals(replacedOnDevice({ confirmed_at: at, has_sha: 'old' }, null), false)
})
