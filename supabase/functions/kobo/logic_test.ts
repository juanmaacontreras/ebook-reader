// deno test supabase/functions/kobo
import { assertEquals } from 'jsr:@std/assert@1'
import {
  deviceTime, fileFor, type KepubMap, type Manifest, placeForKobo, placeFromKobo, readCursor, readingState, samePlace,
  statusChange, takesPlace, wordsBetween, writeCursor,
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
  assertEquals(placeForKobo(map, 7, 0), null)
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

Deno.test('sync token round trip; Kobo\'s own token starts over', () => {
  const c = { books: '2026-11-02T10:00:00.123456+00:00', positions: '1970-01-01T00:00:00Z', deleted: '2026-11-01T08:00:00.5+00:00' }
  assertEquals(readCursor(writeCursor(c)), c)
  assertEquals(readCursor('eyJhbGciOi.abc.def'), null)
  assertEquals(readCursor(btoa(JSON.stringify({ atril: 1, b: '2026-11-02T00:00:00Z' }))), null)  // version 1 starts over
  assertEquals(readCursor(btoa(JSON.stringify({ atril: 2, b: '2099' + "'" }))), null)  // not a date: starts over
  assertEquals(readCursor(null), null)
})
