// Kobo sync protocol, pure functions (no Deno or network), so vitest can test them
// (client/tests/kobo.test.ts). index.ts wires them to Supabase.
//
// Written from the protocol as documented by the calibre-web project's Kobo sync
// (the device talks to whatever `api_endpoint` in "Kobo eReader.conf" says).
// Nothing here is confirmed against a real device yet: index.ts logs raw requests
// to kobo_events so the first session with the Clara BW can correct this file.

export type AtrilStatus = 'to_read' | 'reading' | 'finished'
export type KoboStatus = 'ReadyToRead' | 'Reading' | 'Finished'

export const statusToKobo = (s: string): KoboStatus =>
  s === 'finished' ? 'Finished' : s === 'reading' ? 'Reading' : 'ReadyToRead'
export const statusFromKobo = (s: unknown): AtrilStatus | null =>
  s === 'Finished' ? 'finished' : s === 'Reading' ? 'reading' : s === 'ReadyToRead' ? 'to_read' : null

/** The device wants "2024-01-31T12:00:00Z", no milliseconds. */
export const koboTime = (d: string | Date): string => new Date(d).toISOString().replace(/\.\d+Z$/, 'Z')

// ---- Routing ---------------------------------------------------------------

/** "/kobo/<token>/v1/library/sync" (the platform may or may not prefix /functions/v1) -> token + rest. */
export function parsePath(pathname: string): { token: string; rest: string } | null {
  const m = pathname.match(/\/kobo\/([^/]+)(\/.*)?$/)
  if (!m) return null
  return { token: m[1], rest: m[2] ?? '/' }
}

// ---- Sync token (opaque to the device, it just echoes the header back) -----

export interface SyncCursor { books: string; positions: string }
export const EPOCH = '1970-01-01T00:00:00.000Z'

export function decodeCursor(header: string | null): SyncCursor {
  try {
    if (header) {
      const o = JSON.parse(atob(header))
      if (o && o.v === 1 && typeof o.books === 'string' && typeof o.positions === 'string') return { books: o.books, positions: o.positions }
    }
  } catch { /* fall through: start from scratch */ }
  return { books: EPOCH, positions: EPOCH }
}
export const encodeCursor = (c: SyncCursor): string => btoa(JSON.stringify({ v: 1, ...c }))

// ---- Resources the device reads at start ------------------------------------

/** Every store URL points back to this function, so nothing leaves for kobo.com. */
export function initResources(template: Record<string, unknown>, base: string, token: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const swap = (v: unknown): unknown => typeof v === 'string' ? v.replaceAll('{BASE}', base) : v
  for (const [k, v] of Object.entries(template)) out[k] = swap(v)
  const root = `${base}/${token}`
  out.image_host = root
  out.image_url_template = `${root}/{ImageId}/{Width}/{Height}/false/image.jpg`
  out.image_url_quality_template = `${root}/{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}/image.jpg`
  out.library_sync = `${root}/v1/library/sync`
  return out
}

// ---- Books ------------------------------------------------------------------

export interface BookRow {
  id: string; title: string; author: string | null; language: string | null
  status: string; added_at: string; updated_at: string; synced_at: string
  size_bytes: number | null
}

const lang2 = (l: string | null) => (l || 'es').split(/[-_]/)[0].toLowerCase()

export function bookEntitlement(b: BookRow, removed = false) {
  return {
    Accessibility: 'Full',
    ActivePeriod: { From: koboTime(b.added_at) },
    Created: koboTime(b.added_at),
    CrossRevisionId: b.id,
    Id: b.id,
    IsRemoved: removed,
    IsHiddenFromArchive: false,
    IsLocked: false,
    LastModified: koboTime(b.updated_at),
    OriginCategory: 'Imported',
    RevisionId: b.id,
    Status: 'Active',
  }
}

export function bookMetadata(b: BookRow, downloadUrl: string) {
  const authors = b.author ? b.author.split(/\s*[;&]\s*|\s+y\s+/).filter(Boolean) : []
  return {
    Categories: ['00000000-0000-0000-0000-000000000001'],
    ContributorRoles: authors.map((Name) => ({ Name })),
    Contributors: authors.length ? authors : null,
    CoverImageId: b.id,
    CrossRevisionId: b.id,
    CurrentDisplayPrice: { CurrencyCode: 'USD', TotalAmount: 0 },
    CurrentLoveDisplayPrice: { TotalAmount: 0 },
    Description: null,
    DownloadUrls: [{ Format: 'EPUB3', Size: b.size_bytes ?? 0, Url: downloadUrl, Platform: 'Generic' }],
    EntitlementId: b.id,
    ExternalIds: [],
    Genre: '00000000-0000-0000-0000-000000000001',
    IsEligibleForKoboLove: false,
    IsInternetArchive: false,
    IsPreOrder: false,
    IsSocialEnabled: true,
    Language: lang2(b.language),
    PhoneticPronunciations: {},
    PublicationDate: koboTime(b.added_at),
    Publisher: { Imprint: '', Name: null },
    RevisionId: b.id,
    Title: b.title,
    WorkId: b.id,
  }
}

// ---- Position <-> percent ---------------------------------------------------
// A Kobo reports a percentage of the book (and, on KEPUB, a koboSpan inside a
// chapter file). Atril's position is a sentence of the manifest, so the two are
// matched by how much text comes before the sentence.

export interface ManifestLike { sections: { i: number; sentences: { c: string; t: string }[] }[] }

export interface Place { section: number; sentence: number; cfi: string; fraction: number }

/** Total characters before each sentence, flattened in reading order. */
function flatten(m: ManifestLike) {
  const flat: { section: number; sentence: number; cfi: string; before: number }[] = []
  let total = 0
  for (const s of m.sections) {
    s.sentences.forEach((x, j) => {
      flat.push({ section: s.i, sentence: j, cfi: x.c, before: total })
      total += x.t.length
    })
  }
  return { flat, total }
}

/** Sentence at `percent` (0..100) of the book's text. */
export function placeAtPercent(m: ManifestLike, percent: number): Place | null {
  const { flat, total } = flatten(m)
  if (!flat.length || total <= 0) return null
  const f = Math.min(1, Math.max(0, percent / 100))
  const target = f * total
  let lo = 0, hi = flat.length - 1
  while (lo < hi) { // last sentence that starts at or before the target
    const mid = (lo + hi + 1) >> 1
    if (flat[mid].before <= target) lo = mid; else hi = mid - 1
  }
  const x = flat[lo]
  return { section: x.section, sentence: x.sentence, cfi: x.cfi, fraction: f }
}

/** Percent (0..100) of the book's text before a given sentence. */
export function percentAtSentence(m: ManifestLike, section: number, sentence: number): number | null {
  const { flat, total } = flatten(m)
  const x = flat.find((y) => y.section === section && y.sentence === sentence)
  if (!x || total <= 0) return null
  return (x.before / total) * 100
}

// ---- Reading state ----------------------------------------------------------

export interface KoboStateRow {
  status: string | null; progress: number | null; source_progress: number | null
  location: { Value: string; Type: string; Source: string } | null
  spent_minutes: number | null; remaining_minutes: number | null; last_modified: string
}

const clean = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 100) / 100)

/**
 * What the device should believe about a book. `percent` is where Atril says the
 * reader is (from `positions`), which wins when it is newer than what the Kobo
 * reported; otherwise the Kobo's own last report is echoed back.
 */
export function readingState(
  b: BookRow,
  k: KoboStateRow | null,
  atril: { percent: number | null; at: string } | null,
) {
  const useAtril = !!atril && atril.percent != null && (!k || new Date(atril.at) > new Date(k.last_modified))
  const modified = useAtril ? atril!.at : (k?.last_modified ?? b.updated_at)
  const bookmark: Record<string, unknown> = { LastModified: koboTime(modified) }
  if (useAtril) {
    bookmark.ProgressPercent = clean(atril!.percent!)
    bookmark.ContentSourceProgressPercent = clean(atril!.percent!)
    // No Location: a span id can only come from a KEPUB the device generated or got from us.
  } else if (k) {
    if (k.progress != null) bookmark.ProgressPercent = clean(k.progress)
    if (k.source_progress != null) bookmark.ContentSourceProgressPercent = clean(k.source_progress)
    if (k.location?.Value) bookmark.Location = k.location
  }
  const stats: Record<string, unknown> = { LastModified: koboTime(modified) }
  if (k?.spent_minutes) stats.SpentReadingMinutes = k.spent_minutes
  if (k?.remaining_minutes) stats.RemainingTimeMinutes = k.remaining_minutes
  return {
    EntitlementId: b.id,
    Created: koboTime(b.added_at),
    LastModified: koboTime(modified),
    PriorityTimestamp: koboTime(modified),
    StatusInfo: { LastModified: koboTime(b.updated_at), Status: statusToKobo(b.status), TimesStartedReading: b.status === 'to_read' ? 0 : 1 },
    Statistics: stats,
    CurrentBookmark: bookmark,
  }
}

/** Reads a PUT /v1/library/<id>/state body. Tolerant: any missing piece is just absent. */
export function parseStatePut(body: unknown): {
  status: AtrilStatus | null; progress: number | null; source_progress: number | null
  location: { Value: string; Type: string; Source: string } | null
  spent_minutes: number | null; remaining_minutes: number | null; hasBookmark: boolean
} {
  const rs = (body as { ReadingStates?: Record<string, unknown>[] } | null)?.ReadingStates?.[0] ?? {}
  const bm = (rs.CurrentBookmark ?? null) as Record<string, unknown> | null
  const st = (rs.Statistics ?? null) as Record<string, unknown> | null
  const si = (rs.StatusInfo ?? null) as Record<string, unknown> | null
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : null)
  const loc = (bm?.Location ?? null) as { Value?: string; Type?: string; Source?: string } | null
  return {
    status: statusFromKobo(si?.Status),
    progress: num(bm?.ProgressPercent),
    source_progress: num(bm?.ContentSourceProgressPercent),
    location: loc?.Value ? { Value: loc.Value, Type: loc.Type ?? '', Source: loc.Source ?? '' } : null,
    spent_minutes: num(st?.SpentReadingMinutes),
    remaining_minutes: num(st?.RemainingTimeMinutes),
    hasBookmark: !!bm,
  }
}
