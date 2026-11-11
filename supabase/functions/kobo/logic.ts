// Pure parts of the Kobo sync (no I/O), tested by logic_test.ts.
//
// Positions. The KEPUB (client/src/book/kepub.ts) wraps manifest sentence k of
// a section in spans kobo.<k+1>.<piece>, and kepub.json says which archive file
// is which section. So a Kobo place {Source: file, Value: "kobo.N.M"} is
// sentence N-1 of that section, and Atril's (section, sentence) goes to the
// Kobo as kobo.<sentence+1>.1 in that section's file.

export interface KepubFile { p: string; i: number; n: number }
export interface KepubMap { v: number; files: KepubFile[] }
export interface ManifestSentence { c: string; t: string }
export interface Manifest { v: number; lang: string; sections: { i: number; label: string; sentences: ManifestSentence[] }[] }

export interface KoboLocation { Value?: string; Type?: string; Source?: string }
// deno-lint-ignore no-explicit-any
export type KoboState = Record<string, any>

// The archive file a Kobo names: as stored, or relative to some folder of it
// ("Text/ch1.xhtml" for "OEBPS/Text/ch1.xhtml"), maybe URL-encoded.
export function fileFor(map: KepubMap, source: string | undefined): KepubFile | null {
  if (!source) return null
  let s = source.split('#')[0]
  try { s = decodeURIComponent(s) } catch { /* as is */ }
  s = s.replace(/^\/+/, '')
  return map.files.find(f => f.p === s)
    ?? map.files.find(f => f.p.endsWith('/' + s) || s.endsWith('/' + f.p))
    ?? null
}

// Kobo place → (section, sentence). null when it isn't one of our spans.
export function placeFromKobo(map: KepubMap, loc: KoboLocation | undefined): { section: number; sentence: number } | null {
  if (!loc || loc.Type !== 'KoboSpan') return null
  const file = fileFor(map, loc.Source)
  const m = /^kobo\.(\d+)\.\d+$/.exec(loc.Value ?? '')
  if (!file || !m || !file.n) return null
  return { section: file.i, sentence: Math.min(Math.max(Number(m[1]) - 1, 0), file.n - 1) }
}

// (section, sentence) → Kobo place, with how far into the chapter it is (0..100).
// The Kobo can only stand on text: a page without any (a cover, an image) goes
// as the start of the next text, else the end of the last one.
export function placeForKobo(map: KepubMap, section: number | null, sentence: number | null): { location: Required<KoboLocation>; chapterPercent: number } | null {
  if (section == null) return null
  let file = map.files.find(f => f.i === section && f.n) ?? null
  let k = sentence ?? 0
  if (!file) {
    const text = map.files.filter(f => f.n).sort((a, b) => a.i - b.i)
    file = text.find(f => f.i > section) ?? null
    k = 0
    if (!file) {
      file = text.filter(f => f.i < section).pop() ?? null
      k = file ? file.n - 1 : 0
    }
    if (!file) return null
  }
  k = Math.min(Math.max(k, 0), file.n - 1)
  return {
    location: { Value: `kobo.${k + 1}.1`, Type: 'KoboSpan', Source: file.p },
    chapterPercent: Math.round((k / file.n) * 100),
  }
}

// Where a book starts: its first sentence of text (a cover or an image has
// none, and no place can stand there).
export function startOf(manifest: Manifest): { section: number; sentence: 0; cfi: string } | null {
  const s = manifest.sections.find(x => x.sentences.length)
  return s ? { section: s.i, sentence: 0, cfi: s.sentences[0].c } : null
}

function words(text: string): number {
  return text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length
}

// Words read going forward from one place to another (0 going back).
export function wordsBetween(manifest: Manifest, from: { section: number; sentence: number }, to: { section: number; sentence: number }): number {
  let total = 0
  for (const s of manifest.sections) {
    if (s.i < from.section || s.i > to.section) continue
    const a = s.i === from.section ? from.sentence : 0
    const b = s.i === to.section ? to.sentence : s.sentences.length
    for (let k = a; k < b; k++) total += words(s.sentences[k]?.t ?? '')
  }
  return total
}

// Kobo timestamps: seconds, "Z" (the format the device itself writes).
export function koboTime(iso: string | Date): string {
  return new Date(iso).toISOString().replace(/\.\d+Z$/, 'Z')
}

// A time the device wrote ("2026-11-02T20:14:18Z", maybe with 7 fraction
// digits), never later than now. null when unreadable.
export function deviceTime(s: unknown, now = new Date()): Date | null {
  if (typeof s !== 'string') return null
  const d = new Date(s.replace(/(\.\d{3})\d+/, '$1'))
  if (isNaN(d.getTime())) return null
  return d > now ? now : d
}

// The same place as the stored state: the device reports its place every time
// a book is opened or closed, moved or not.
export function samePlace(a: KoboState | null | undefined, b: KoboState): boolean {
  if (!a) return false
  const loc = (x: KoboState) => {
    const l = x?.CurrentBookmark?.Location
    return l ? `${l.Source}|${l.Value}|${l.Type}` : ''
  }
  return loc(a) === loc(b)
}

export type BookStatus = 'to_read' | 'reading' | 'finished'

export function koboStatus(status: BookStatus): 'ReadyToRead' | 'Reading' | 'Finished' {
  return status === 'finished' ? 'Finished' : status === 'reading' ? 'Reading' : 'ReadyToRead'
}

// What Atril should do with a status the device sent. Only a change made on
// the device counts: not the status it repeats on every report, nor one Atril
// told it (`told`: the device takes it and reports it back, maybe hours later
// at its next sync, when the book may be "Leyendo" again elsewhere). Plus
// reading on it: a book marked "Por leer" elsewhere becomes "Leyendo" again
// when the device's place moves, as it does in the app after a few pages.
// "Reading" undoes a "finished" only when the device itself had it finished
// (taken up again there), never one decided elsewhere.
export function statusChange(previous: string | undefined, sent: string | undefined, current: BookStatus, moved = false, told: string[] = []): BookStatus | null {
  if (!sent) return null
  if (sent === previous || told.includes(sent)) return sent === 'Reading' && moved && current === 'to_read' ? 'reading' : null
  if (sent === 'Finished') return current === 'finished' ? null : 'finished'
  if (sent === 'Reading') {
    if (current === 'to_read') return 'reading'
    return current === 'finished' && previous === 'Finished' ? 'reading' : null
  }
  if (sent === 'ReadyToRead' && previous) return current === 'to_read' ? null : 'to_read'
  return null
}

// The statuses Atril told the device (in a reading state) that it hasn't
// reported back yet, oldest first. Handing it a status other than the one it
// last reported adds it; it is not dropped when the device repeats its own
// (a report may still carry its state from before it took Atril's).
export function tell(told: string[], reported: string | undefined, status: string): string[] {
  if (status === reported) return told
  return told[told.length - 1] === status ? told : [...told.filter(s => s !== status), status]
}

// ...and after a report: one it was told is done (with anything told before
// it). Everything is dropped by a change of its own, and by a report made
// after it was told that still has its own status (`fresh`: it didn't take
// Atril's, or went on reading, which made the book "Leyendo" here): else a
// "no leído" marked there later would pass for the echo. A report made
// before it was told (one still pending when it got Atril's) keeps it.
export function toldAfter(told: string[], previous: string | undefined, sent: string | undefined, fresh = false): string[] {
  if (!sent || !told.length) return told
  const k = told.indexOf(sent)
  if (k >= 0) return told.slice(k + 1)
  return sent === previous && !fresh ? told : []
}

// The device has another version of the book's file than the library: one replaced in
// place after it downloaded it. Unknown (has_sha null, from before this was recorded) is
// not a difference.
export function replacedOnDevice(known: { confirmed_at: string | null; has_sha?: string | null } | undefined, sha: string | null | undefined): boolean {
  return !!known?.confirmed_at && !!known.has_sha && !!sha && known.has_sha !== sha
}

export interface Place { section: number; sentence: number }
export const before = (a: Place, b: Place) => a.section < b.section || (a.section === b.section && a.sentence < b.sentence)

// Whether a place the device reports becomes everyone's. A device that missed
// progress made elsewhere (its previous report was behind the newest place,
// another device's: picked up before it synced, or the jump not taken) doesn't
// take everyone back by reading on behind it; going past it counts. A device
// that missed nothing moves it anywhere, back too: the newest place is its own,
// it had reached it, or it was past it (then the newest place is a move back
// made elsewhere). The apps follow the same rule (reader.ts, schema.sql).
export function takesPlace(to: Place, from: Place | null, current: AtrilPosition | null, device: string): boolean {
  if (!current || current.device === device || current.section === null || current.sentence === null) return true
  const cur = { section: current.section, sentence: current.sentence }
  if (from && !before(from, cur)) return true
  return !before(to, cur)
}

export interface AtrilBook {
  id: string
  title: string
  author: string | null
  language: string | null
  status: BookStatus
  added_at: string
  finished_at: string | null
  updated_at: string
  subject?: string | null
}
export interface AtrilPosition { section: number | null; sentence: number | null; fraction: number | null; device: string | null; updated_at: string }

// The reading state Atril hands the device for a book: the Kobo's own last
// state when the latest place is its own, else Atril's place, dated by when it
// was decided so the device takes it over an older one of its own.
export function readingState(book: AtrilBook, position: AtrilPosition | null, map: KepubMap | null, own: { state: KoboState | null; device: string }): KoboState {
  const minutes = own.state?.Statistics?.SpentReadingMinutes
  const latest = [book.updated_at, position?.updated_at].filter(Boolean).sort().pop()!
  const at = koboTime(latest)
  if (own.state && (!position || position.device === own.device) && own.state.StatusInfo?.Status === koboStatus(book.status)) {
    return { ...own.state, EntitlementId: book.id }
  }
  const status = koboStatus(book.status)
  const state: KoboState = {
    EntitlementId: book.id,
    Created: koboTime(book.added_at),
    LastModified: at,
    PriorityTimestamp: at,
    StatusInfo: { LastModified: at, Status: status, TimesStartedReading: status === 'ReadyToRead' ? 0 : 1 },
    Statistics: { LastModified: at, ...(minutes ? { SpentReadingMinutes: minutes } : {}) },
    CurrentBookmark: { LastModified: at },
  }
  if (status === 'Finished' && book.finished_at) state.StatusInfo.LastTimeFinished = koboTime(book.finished_at)
  const place = position && map ? placeForKobo(map, position.section, position.sentence) : null
  if (place && position) {
    state.CurrentBookmark = {
      LastModified: at,
      ProgressPercent: Math.round((position.fraction ?? 0) * 100),
      ContentSourceProgressPercent: place.chapterPercent,
      Location: place.location,
    }
  } else if (own.state?.CurrentBookmark) {
    state.CurrentBookmark = { ...own.state.CurrentBookmark }
  }
  return state
}

// The Kobo takes a place from elsewhere only when it is dated after its own
// bookmark, and it dates its bookmark again on opening a book, moved or not
// (kobo_log 2026-11-04 and -05: a place read on the phone hours before, sent
// when the book was opened at home, ignored; a page turned on the phone right
// after, taken). So a place from another device goes dated a minute from now
// (past anything it stamped on opening, whatever its clock) until the device
// has had it: this very place was handed to it (`offered`, at `offered_at`) and
// it reported afterwards (`state_at`), all three by the server's clock. Then it
// goes with its real time, so a declined place isn't offered every minute.
// Not judged by the date of the bookmark it last reported (as until
// 2026-11-11): a report that reaches us before it asks (on waking, or a pending
// one sent on getting Wi-Fi back) carries a fresh date on its old page, and the
// place read on the phone on the way home passed for seen without ever being
// offered; only a page turned on the phone afterwards got through.
export const OFFER_AHEAD_MS = 60_000
export interface Own { state: KoboState | null; device: string; state_at?: string | null; offered?: string | null; offered_at?: string | null }
export function hadPlace(position: AtrilPosition, own: Own): boolean {
  if (!own.offered || !own.offered_at || !own.state_at) return false
  return Date.parse(own.offered) === Date.parse(position.updated_at) && Date.parse(own.state_at) > Date.parse(own.offered_at)
}
export function offerNewer(state: KoboState, position: AtrilPosition | null, own: Own, now = new Date()): KoboState {
  if (!position || position.device === own.device || !state.CurrentBookmark?.Location) return state
  if (hadPlace(position, own)) return state
  const at = koboTime(new Date(now.getTime() + OFFER_AHEAD_MS))
  return { ...state, LastModified: at, PriorityTimestamp: at, CurrentBookmark: { ...state.CurrentBookmark, LastModified: at } }
}

// A stable id for a series from its name (the device groups books by it).
export function seriesId(name: string): string {
  let hex = ''
  for (let seed = 0; seed < 4; seed++) {
    let x = 0x811c9dc5 ^ seed
    for (const c of name.trim().toLowerCase()) x = Math.imul(x ^ c.codePointAt(0)!, 0x01000193) >>> 0
    hex += x.toString(16).padStart(8, '0')
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// The books of each subject in the order they were added: a book's number in its series.
export function seriesNumbers(books: { id: string; subject: string | null; added_at: string }[]): Map<string, number> {
  const out = new Map<string, number>()
  const count = new Map<string, number>()
  for (const b of [...books].sort((a, b) => a.added_at.localeCompare(b.added_at) || a.id.localeCompare(b.id))) {
    const name = b.subject?.trim()
    if (!name) continue
    const n = (count.get(name.toLowerCase()) ?? 0) + 1
    count.set(name.toLowerCase(), n)
    out.set(b.id, n)
  }
  return out
}

// `number`: the book's place among those of its subject (seriesNumbers). A book with a
// subject (resumidor's) goes as part of the series named after it, so the Kobo groups the
// books of a subject together; other books carry no series, as before.
export function metadata(book: AtrilBook, base: string, size: number | null, number?: number): KoboState {
  const subject = book.subject?.trim()
  return {
    ...(subject ? { Series: { Id: seriesId(subject), Name: subject, Number: String(number ?? 1), NumberFloat: number ?? 1 } } : {}),
    Categories: ['00000000-0000-0000-0000-000000000001'],
    ContributorRoles: book.author ? book.author.split(/,\s*/).map(Name => ({ Name })) : [],
    Contributors: book.author ? book.author.split(/,\s*/) : [],
    CoverImageId: book.id,
    CrossRevisionId: book.id,
    CurrentDisplayPrice: { CurrencyCode: 'USD', TotalAmount: 0 },
    CurrentLoveDisplayPrice: { TotalAmount: 0 },
    Description: null,
    DownloadUrls: [{ DrmType: 'None', Format: 'KEPUB', Platform: 'Generic', Size: size ?? 0, Url: `${base}/download/${book.id}` }],
    EntitlementId: book.id,
    ExternalIds: [],
    Genre: '00000000-0000-0000-0000-000000000001',
    IsEligibleForKoboLove: false,
    IsInternetArchive: false,
    IsPreOrder: false,
    IsSocialEnabled: true,
    Language: (book.language ?? 'es').split('-')[0],
    PhoneticPronunciations: {},
    PublicationDate: koboTime(book.added_at),
    Publisher: { Imprint: '', Name: '' },
    RevisionId: book.id,
    Title: book.title,
    WorkId: book.id,
  }
}

export function entitlement(book: AtrilBook, removed = false): KoboState {
  return {
    Accessibility: 'Full',
    ActivePeriod: { From: koboTime(book.added_at) },
    Created: koboTime(book.added_at),
    CrossRevisionId: book.id,
    Id: book.id,
    IsRemoved: removed,
    IsHiddenFromArchive: false,
    IsLocked: false,
    LastModified: koboTime(book.updated_at),
    OriginCategory: 'Imported',
    RevisionId: book.id,
    Status: removed ? 'Deleted' : 'Active',
  }
}

// A book that left the library, for a device that has it.
export function removedEntitlement(id: string, at: string): KoboState {
  const t = koboTime(at)
  return {
    ChangedEntitlement: {
      BookEntitlement: {
        Accessibility: 'Full', ActivePeriod: { From: t }, Created: t, CrossRevisionId: id, Id: id, IsRemoved: true,
        IsHiddenFromArchive: false, IsLocked: false, LastModified: t, OriginCategory: 'Imported', RevisionId: id, Status: 'Deleted',
      },
      BookMetadata: { CrossRevisionId: id, RevisionId: id, EntitlementId: id, WorkId: id, Title: id },
    },
  }
}

// The sync token: opaque to the device, it hands it back on the next sync.
export interface SyncCursor { books: string; positions: string; deleted: string }
const EPOCH = '1970-01-01T00:00:00Z'
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

export function readCursor(header: string | null): SyncCursor | null {
  if (!header) return null
  try {
    const raw = JSON.parse(atob(header))
    // 2: since books count as on the device only once it confirmed them (any
    // older token starts over, so books lost to version 1 are sent again).
    if (raw?.atril !== 2) return null
    const c = { books: raw.b ?? EPOCH, positions: raw.p ?? EPOCH, deleted: raw.d ?? EPOCH }
    // Each part goes into a query: a token that isn't ours whole starts over.
    return Object.values(c).every(v => typeof v === 'string' && TIMESTAMP.test(v)) ? c : null
  } catch {
    return null  // Kobo's own token, from before this device synced with Atril
  }
}

export function writeCursor(c: SyncCursor): string {
  return btoa(JSON.stringify({ atril: 2, b: c.books, p: c.positions, d: c.deleted }))
}

export const START: SyncCursor = { books: EPOCH, positions: EPOCH, deleted: EPOCH }
