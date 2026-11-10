// Atril as a Kobo's store: a Kobo whose eReader.conf has
//   [OneStoreServices] api_endpoint=https://<project>.supabase.co/functions/v1/kobo/<token>
// gets the Atril library over Wi-Fi (as KEPUBs, client/src/book/kepub.ts) and
// syncs its reading place, status and reading time with every other device.
// The protocol is Kobo's store API as reverse-engineered by Calibre-Web.
//
//   GET  v1/initialization        Kobo's own resource list, with the library pointing here
//   GET  v1/library/sync          new/changed/removed books and places from other devices
//   GET  v1/library/<id>/metadata
//   GET  v1/library/<id>/state    PUT: the device's place, status and reading minutes
//   DELETE v1/library/<id>        removed on the device: not offered again
//   GET  download/<id>            the KEPUB
//   GET  <id>/<w>/<h>/.../image.jpg  the cover
//
// Sign-in, dictionaries and highlights ("reading services") stay Kobo's.
// Deployed with verify_jwt off (the device sends no Supabase token); the token
// in the path is the credential, kept hashed in kobo_devices. This is the one
// place that uses the service role: every query below is limited to the
// token's user. Requests are logged in kobo_log (no token; reading-state bodies
// as sent; the time to answer, ms).
//
// Speed: every request reads what it needs in one go (parallel queries), then
// writes in one go; a device's own lookups are cached in the instance.

import {
  type AtrilBook, type AtrilPosition, deviceTime, entitlement, type KepubMap, type KoboState, type Manifest,
  metadata, offerNewer, placeFromKobo, readCursor, readingState, removedEntitlement, replacedOnDevice, samePlace, seriesNumbers, START, startOf, statusChange,
  type SyncCursor, takesPlace, tell, toldAfter, wordsBetween, writeCursor,
} from './logic.ts'

const URL_BASE = Deno.env.get('SUPABASE_URL')!
// The project's secret key: the new-style one when Supabase provides it, else
// the legacy service_role JWT.
function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>
    const k = keys.default ?? Object.values(keys)[0]
    if (k) return k
  } catch { /* not set */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
}
const KEY = secretKey()
const KOBO_STORE = 'https://storeapi.kobo.com'
const LIMIT = 100

interface Device { id: string; user_id: string; tag: string }

// ---- Supabase (PostgREST + Storage) with the service role -----------------------

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, 'Content-Type': 'application/json', ...extra }
  if (KEY.startsWith('eyJ')) h.Authorization = `Bearer ${KEY}`
  return h
}

// deno-lint-ignore no-explicit-any
async function rest<T = any>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: headers(init.prefer ? { Prefer: init.prefer } : {}),
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

function storage(path: string): Promise<Response> {
  return fetch(`${URL_BASE}/storage/v1/object/library/${path}`, { headers: headers() })
}

const q = encodeURIComponent

// Small per-instance caches: a sync touches the same few books many times.
const cache = new Map<string, { at: number; value: unknown }>()
async function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.value as T
  const value = await load()
  if (cache.size > 40) cache.clear()
  cache.set(key, { at: Date.now(), value })
  return value
}

async function kepubMap(uid: string, book: string): Promise<KepubMap | null> {
  return cached(`map:${book}`, 60_000, async () => {  // a minute: a replaced book has another
    const res = await storage(`${uid}/${book}/kepub.json`)
    return res.ok ? await res.json() as KepubMap : null
  })
}

async function manifest(uid: string, book: string): Promise<Manifest | null> {
  return cached(`text:${book}`, 60_000, async () => {
    const res = await storage(`${uid}/${book}/text.json.gz`)
    if (!res.ok || !res.body) return null
    return JSON.parse(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text()) as Manifest
  })
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('')
}

// Five minutes: a removed device (its row deleted) stops working within that.
async function deviceFor(token: string): Promise<Device | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null
  return cached(`dev:${token}`, 5 * 60_000, async () => {
    const rows = await rest<{ id: string; user_id: string }[]>(`kobo_devices?select=id,user_id&token_hash=eq.${await sha256(token)}`)
    return rows[0] ? { ...rows[0], tag: `kobo:${rows[0].id.slice(0, 8)}` } : null
  })
}

const BOOK_COLUMNS = 'id,title,author,language,status,added_at,finished_at,updated_at,synced_at,kepub_path,subject,sha256'
type BookRow = AtrilBook & { synced_at: string; kepub_path: string | null; sha256: string | null }

const UUID = /^[0-9a-f-]{36}$/i

async function bookOf(dev: Device, id: string): Promise<BookRow | null> {
  if (!UUID.test(id)) return null
  const rows = await rest<BookRow[]>(`books?select=${BOOK_COLUMNS}&id=eq.${id}&user_id=eq.${dev.user_id}&kepub_path=not.is.null`)
  return rows[0] ?? null
}

// Each book's number in its subject's series (logic.ts, seriesNumbers). Never fails a sync:
// without it the books go as number 1.
function seriesOf(dev: Device): Promise<Map<string, number>> {
  return cached(`series:${dev.user_id}`, 60_000, async () =>
    seriesNumbers(await rest<{ id: string; subject: string | null; added_at: string }[]>(`books?select=id,subject,added_at&user_id=eq.${dev.user_id}&subject=not.is.null`)),
  ).catch(e => { console.error('kobo: series', e); return new Map<string, number>() })
}

type KoboBook = {
  book_id: string; removed: boolean; state: KoboState | null; state_at: string | null; confirmed_at: string | null
  told: string[]; told_at: string | null; has_sha: string | null; resend_at: string | null
  // The id this device knows the book by: the book's own until it is replaced in place,
  // then a new one per version (the device keeps the file of an id it already has).
  kid: string | null
}

// The book as this device knows it: its ids are the device's (`kid`).
const asKnown = <T extends { id: string }>(b: T, known: KoboBook | undefined): T => known?.kid ? { ...b, id: known.kid } : b

// The book an id from the device stands for; null for the id of a version it should no
// longer have (replaced since). An id that is nothing of this device's is returned as it
// came (a store book: the lookups that follow find nothing). Kept a minute per instance;
// an id it doesn't know (a version handed out by another instance) is looked up again.
type Ids = { byKid: Map<string, string>; replaced: Set<string>; own: Set<string> }
function idsOf(dev: Device): Promise<Ids> {
  return cached(`ids:${dev.id}`, 60_000, async () => {
    const rows = await rest<{ book_id: string; kid: string | null }[]>(`kobo_books?select=book_id,kid&device_id=eq.${dev.id}`)
    return {
      byKid: new Map(rows.filter(r => r.kid).map(r => [r.kid!, r.book_id])),
      replaced: new Set(rows.filter(r => r.kid).map(r => r.book_id)),
      own: new Set(rows.map(r => r.book_id)),
    }
  })
}
async function bookId(dev: Device, id: string): Promise<string | null> {
  if (!UUID.test(id)) return id
  const find = (k: Ids) => k.byKid.get(id) ?? (k.replaced.has(id) ? null : k.own.has(id) ? id : undefined)
  let found = find(await idsOf(dev))
  if (found === undefined) {
    cache.delete(`ids:${dev.id}`)
    found = find(await idsOf(dev))
  }
  return found === undefined ? id : found
}

// The device showed it has the book: later syncs send it as changed, not new.
// `sha`: the version of the file it downloaded.
async function confirm(dev: Device, book: string, sha: string | null): Promise<void> {
  await rest('kobo_books?on_conflict=device_id,book_id', {
    method: 'POST', prefer: 'resolution=merge-duplicates',
    body: JSON.stringify({ device_id: dev.id, book_id: book, confirmed_at: new Date().toISOString(), has_sha: sha }),
  })
}

async function koboBooks(dev: Device, ids: string[]): Promise<Map<string, KoboBook>> {
  if (!ids.length) return new Map()
  const rows = await rest<KoboBook[]>(`kobo_books?select=book_id,removed,state,state_at,confirmed_at,told,told_at,has_sha,resend_at,kid&device_id=eq.${dev.id}&book_id=in.(${ids.join(',')})`)
  return new Map(rows.map(r => [r.book_id, r]))
}

// Reading states handed to the device: remember the statuses it was told, so
// they don't come back as changes made on it (logic.ts, statusChange). One
// write for all of them, only when something changed (a status changed in
// Atril since the device's last report: rare).
function told(dev: Device, handed: { book: string; known: KoboBook | undefined; state: KoboState }[]): Promise<unknown> {
  const rows = handed.flatMap(({ book, known, state }) => {
    const status = state.StatusInfo?.Status
    const before = known?.told ?? []
    const after = status ? tell(before, known?.state?.StatusInfo?.Status, status) : before
    return after === before ? [] : [{ device_id: dev.id, book_id: book, told: after, told_at: new Date().toISOString() }]
  })
  if (!rows.length) return Promise.resolve()
  return rest('kobo_books?on_conflict=device_id,book_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: JSON.stringify(rows) })
}

async function positionsOf(dev: Device, ids: string[]): Promise<Map<string, AtrilPosition & { book_id: string }>> {
  if (!ids.length) return new Map()
  const rows = await rest<(AtrilPosition & { book_id: string })[]>(`positions?select=book_id,section,sentence,fraction,device,updated_at&user_id=eq.${dev.user_id}&book_id=in.(${ids.join(',')})`)
  return new Map(rows.map(r => [r.book_id, r]))
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } })
}

// ---- Initialization ---------------------------------------------------------------

// Used only when Kobo's own list can't be fetched: enough for the library.
const FALLBACK_RESOURCES: Record<string, string> = {
  oauth_host: 'https://oauth.kobo.com',
  dictionary_host: 'https://ereaderfiles.kobo.com',
  userguide_host: 'https://ereaderfiles.kobo.com',
  reading_services_host: 'https://readingservices.kobo.com',
  store_host: 'www.kobo.com',
  kobo_audiobooks_enabled: 'False',
  kobo_subscriptions_enabled: 'False',
  kobo_wishlist_enabled: 'False',
  kobo_superpoints_enabled: 'False',
  kobo_display_price: 'False',
  use_one_store: 'True',
}

async function initialization(req: Request, base: string): Promise<Response> {
  let resources: Record<string, unknown> | null = null
  let why = ''  // why Kobo's own list wasn't used, for the log
  try {
    const fwd = new Headers()
    for (const [k, v] of req.headers) if (k === 'authorization' || k.startsWith('x-kobo-') || k === 'user-agent') fwd.set(k, v)
    const res = await fetch(`${KOBO_STORE}/v1/initialization`, { headers: fwd, signal: AbortSignal.timeout(6000) })
    if (res.ok) resources = (await res.json())?.Resources ?? null
    // Why, as Kobo says it (never the token): whether the device sent one, and the reason
    // in WWW-Authenticate ("invalid_token", "expired"...).
    if (!resources) {
      const reason = (res.headers.get('www-authenticate') ?? '').replace(/\s+/g, ' ').slice(0, 90)
      why = `Kobo answered ${res.status}${fwd.has('authorization') ? '' : ', the device sent no sign-in'}${reason ? ` (${reason})` : ''}`
    }
  } catch (e) {
    why = (e as Error)?.name === 'TimeoutError' ? 'Kobo timed out' : `Kobo unreachable (${(e as Error)?.name ?? 'error'})`
  }
  const local = !resources
  resources ??= { ...FALLBACK_RESOURCES, device_auth: `${base}/v1/auth/device`, device_refresh: `${base}/v1/auth/refresh` }
  Object.assign(resources, {
    library_sync: `${base}/v1/library/sync`,
    library_metadata: `${base}/v1/library/{Ids}/metadata`,
    library_book: `${base}/v1/library/{LibraryItemId}`,
    delete_entitlement: `${base}/v1/library/{Ids}`,
    reading_state: `${base}/v1/library/{Ids}/state`,
    tags: `${base}/v1/library/tags`,
    create_tag: `${base}/v1/library/tags`,
    delete_tag: `${base}/v1/library/tags/{TagId}`,
    rename_tag: `${base}/v1/library/tags/{TagId}`,
    tag_items: `${base}/v1/library/tags/{TagId}/items`,
    delete_tag_items: `${base}/v1/library/tags/{TagId}/items/delete`,
    image_host: base,
    image_url_template: `${base}/{ImageId}/{Width}/{Height}/false/image.jpg`,
    image_url_quality_template: `${base}/{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}/image.jpg`,
  })
  return json({ Resources: resources }, 200, { 'x-kobo-apitoken': 'e30=', 'x-atril-resources': local ? `fallback, ${why}` : 'kobo' })
}

// ---- Library sync -----------------------------------------------------------------

async function librarySync(req: Request, dev: Device, base: string): Promise<Response> {
  const cursor: SyncCursor = readCursor(req.headers.get('x-kobo-synctoken')) ?? { ...START }
  const fresh = cursor.books === START.books
  const out: KoboState[] = []
  let more = false

  // The three feeds at once: books, removals, places; and the books taken off this
  // device to send again (a replaced one) that it hasn't downloaded yet.
  const [feed, deleted, moved, waiting] = await Promise.all([
    rest<BookRow[]>(`books?select=${BOOK_COLUMNS}&user_id=eq.${dev.user_id}&kepub_path=not.is.null&synced_at=gt.${q(cursor.books)}&order=synced_at&limit=${LIMIT}`),
    rest<{ book_id: string; synced_at: string }[]>(`deleted_books?select=book_id,synced_at&user_id=eq.${dev.user_id}&synced_at=gt.${q(cursor.deleted)}&order=synced_at&limit=${LIMIT}`),
    rest<(AtrilPosition & { book_id: string; synced_at: string })[]>(`positions?select=book_id,section,sentence,fraction,device,updated_at,synced_at&user_id=eq.${dev.user_id}&synced_at=gt.${q(cursor.positions)}&order=synced_at&limit=${LIMIT}`),
    rest<{ book_id: string }[]>(`kobo_books?select=book_id&device_id=eq.${dev.id}&confirmed_at=is.null&resend_at=not.is.null&removed=is.false&limit=${LIMIT}`),
  ])

  // 1. Books added or changed (title, status, a KEPUB just built), then those waiting.
  if (feed.length === LIMIT) more = true
  const again = waiting.map(w => w.book_id).filter(id => !feed.some(b => b.id === id))
  const books = again.length
    ? [...feed, ...await rest<BookRow[]>(`books?select=${BOOK_COLUMNS}&id=in.(${again.join(',')})&user_id=eq.${dev.user_id}&kepub_path=not.is.null`)]
    : feed
  const ids = books.map(b => b.id)
  const [series, kb, pos, sizes, maps] = await Promise.all([
    ids.length ? seriesOf(dev) : Promise.resolve(new Map<string, number>()),
    koboBooks(dev, ids),
    positionsOf(dev, ids),
    ids.length ? rest<{ book_id: string; bytes: number }[]>('rpc/kobo_kepub_sizes', { method: 'POST', body: JSON.stringify({ uid: dev.user_id }) }) : Promise.resolve([]),
    Promise.all(ids.map(id => kepubMap(dev.user_id, id))),
  ])
  const size = new Map(sizes.map(s => [s.book_id, s.bytes]))
  const sent: string[] = []
  const handed: { book: string; known: KoboBook | undefined; state: KoboState }[] = []
  const inEntitlements = new Set<string>()
  const resend: { book_id: string; kid: string }[] = []
  for (const [k, b] of books.entries()) {
    let known = kb.get(b.id)
    if (known?.removed) continue
    // Replaced in place since the device downloaded it. It keeps the file of an id it
    // has, whatever it is told (changed, or removed and new again: seen 2026-11-10), so
    // the version it has goes as removed and the book comes as a new one under a new id.
    if (known && replacedOnDevice(known, b.sha256)) {
      out.push(removedEntitlement(known.kid ?? b.id, new Date().toISOString()))
      known = { ...known, kid: crypto.randomUUID(), confirmed_at: null, has_sha: null, state: null, told: [] }
      resend.push({ book_id: b.id, kid: known.kid! })
    }
    const map = maps[k]
    const mine = asKnown(b, known)
    const state = readingState(mine, pos.get(b.id) ?? null, map, { state: known?.state ?? null, device: dev.tag })
    out.push({ [known?.confirmed_at ? 'ChangedEntitlement' : 'NewEntitlement']: { BookEntitlement: entitlement(mine), BookMetadata: metadata(mine, base, size.get(b.id) ?? null, series.get(b.id)), ReadingState: state } })
    inEntitlements.add(b.id)
    if (!known) sent.push(b.id)
    handed.push({ book: b.id, known, state })
  }
  if (feed.length) cursor.books = feed[feed.length - 1].synced_at
  if (resend.length) {
    cache.delete(`ids:${dev.id}`)
    for (const r of resend) { cache.delete(`map:${r.book_id}`); cache.delete(`text:${r.book_id}`) }
    const now = new Date().toISOString()
    await rest('kobo_books?on_conflict=device_id,book_id', {
      method: 'POST', prefer: 'resolution=merge-duplicates',
      body: JSON.stringify(resend.map(r => ({ device_id: dev.id, ...r, confirmed_at: null, has_sha: null, state: null, told: [], resend_at: now }))),
    })
  }
  if (sent.length) {
    await rest('kobo_books?on_conflict=device_id,book_id', {
      method: 'POST', prefer: 'resolution=ignore-duplicates',
      body: JSON.stringify(sent.map(book_id => ({ device_id: dev.id, book_id }))),
    })
  }

  // 2. Books removed from the library (a first sync has nothing to remove).
  if (deleted.length === LIMIT) more = true
  // Known gap: a book the device knows by another id (replaced once) and then removed
  // from the library stays on the device: its kobo_books row, with that id, went with it.
  if (!fresh) for (const d of deleted) out.push(removedEntitlement(d.book_id, d.synced_at))
  if (deleted.length) cursor.deleted = deleted[deleted.length - 1].synced_at

  // 3. Places that changed elsewhere (a phone, the PC) in books the Kobo has.
  if (moved.length === LIMIT) more = true
  const others = moved.filter(p => p.device !== dev.tag && !inEntitlements.has(p.book_id))
  if (others.length && !fresh) {
    const ids = others.map(p => p.book_id)
    const [has, rows, maps] = await Promise.all([
      koboBooks(dev, ids),
      rest<BookRow[]>(`books?select=${BOOK_COLUMNS}&id=in.(${ids.join(',')})&user_id=eq.${dev.user_id}&kepub_path=not.is.null`),
      Promise.all(ids.map(id => kepubMap(dev.user_id, id))),
    ])
    const byId = new Map(rows.map(b => [b.id, b]))
    for (const [k, p] of others.entries()) {
      const known = has.get(p.book_id)
      const book = byId.get(p.book_id)
      if (!known || known.removed || !book) continue
      const state = readingState(asKnown(book, known), p, maps[k], { state: known.state, device: dev.tag })
      out.push({ ChangedReadingState: { ReadingState: state } })
      handed.push({ book: book.id, known, state })
    }
  }
  if (moved.length) cursor.positions = moved[moved.length - 1].synced_at
  await told(dev, handed).catch(e => console.error('kobo: told', e))

  const extra: Record<string, string> = { 'x-kobo-synctoken': writeCursor(cursor) }
  if (more) extra['x-kobo-sync'] = 'continue'
  return json(out, 200, extra)
}

// ---- Reading state from the device ------------------------------------------------

function taken(id: string): Response {
  return json({
    RequestResult: 'Success',
    UpdateResults: [{
      EntitlementId: id,
      CurrentBookmarkResult: { Result: 'Success' },
      StatisticsResult: { Result: 'Success' },
      StatusInfoResult: { Result: 'Success' },
    }],
  })
}

type Routed = { res: Response; note?: string; body?: unknown }

// `asked`: the id the device used; `id`: the book it stands for.
async function putState(req: Request, dev: Device, asked: string): Promise<Routed> {
  const id = await bookId(dev, asked)
  if (!id || !UUID.test(id)) return { res: taken(asked), note: id ? 'not ours' : 'a replaced version: not taken' }
  // Everything this needs, at once (the map and the text are cached).
  // deno-lint-ignore no-explicit-any
  const [book, body, kb, map, text, places]: [BookRow | null, any, Map<string, KoboBook>, KepubMap | null, Manifest | null, Map<string, AtrilPosition>] = await Promise.all([
    bookOf(dev, id), req.json().catch(() => null), koboBooks(dev, [id]), kepubMap(dev.user_id, id), manifest(dev.user_id, id),
    positionsOf(dev, [id]),
  ])
  if (!book) return { res: taken(asked), note: 'not ours' }  // a store book, or one removed from Atril
  const incoming: KoboState | undefined = body?.ReadingStates?.[0]
  if (!incoming) return { res: json({ error: 'missing ReadingStates' }, 400), body }
  const sent = structuredClone(incoming)
  const known = kb.get(id)
  const previous = known?.state ?? null
  // What a report leaves out stays as it was.
  for (const part of ['Statistics', 'CurrentBookmark', 'StatusInfo']) if (!incoming[part] && previous?.[part]) incoming[part] = previous[part]
  const now = new Date()
  const notes: string[] = []
  const writes: Promise<unknown>[] = []

  const to = map ? placeFromKobo(map, incoming.CurrentBookmark?.Location) : null
  const from = map && previous ? placeFromKobo(map, previous.CurrentBookmark?.Location) : null
  const when = deviceTime(incoming.CurrentBookmark?.LastModified, now) ?? deviceTime(incoming.LastModified, now) ?? now

  const moved = !!to && !samePlace(previous, incoming)
  const current = places.get(id) ?? null
  const place = (p: { section: number; sentence: number; cfi: string }, fraction: number | null, at: Date) =>
    writes.push(rest('positions?on_conflict=book_id', {
      method: 'POST', prefer: 'resolution=merge-duplicates',
      body: JSON.stringify({
        book_id: id, user_id: dev.user_id, cfi: p.cfi, section: p.section, sentence: p.sentence, fraction,
        device: dev.tag, updated_at: at.toISOString(), base: null,
      }),
    }))

  // Status: only a change made on the device, not one Atril told it (`told`).
  // Its time is when it was made there: a status changed in the device's
  // library reaches here at its next sync.
  const told = known?.told ?? []
  const status = statusChange(previous?.StatusInfo?.Status, incoming.StatusInfo?.Status, book.status, moved, told)
  const decided = deviceTime(incoming.StatusInfo?.LastModified, now) ?? now
  // "Por leer" takes the book back to its start, as in the apps (user
  // decision 2026-11-02); not over reading done on another device after it.
  const newerElsewhere = !!current && current.device !== dev.tag && Date.parse(current.updated_at) > decided.getTime()
  const applies = !!status && decided.toISOString() > book.updated_at && !(status === 'to_read' && newerElsewhere)
  if (status && applies) {
    writes.push(rest(`books?id=eq.${id}&user_id=eq.${dev.user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status, updated_at: decided.toISOString(),
        finished_at: status === 'finished' ? decided.toISOString() : status === 'to_read' ? null : book.finished_at,
      }),
    }))
    notes.push(`status ${status}`)
  } else if (status) notes.push(`status ${status}: older, kept`)
  const start = status === 'to_read' && applies && text ? startOf(text) : null

  // Place: from the start after "Por leer"; else only a real move (not the
  // same place reported again on open/close), and never back past a newer
  // place this device hadn't reached (takesPlace).
  if (start) {
    place(start, 0, decided)
    notes.push(`place ${start.section}.0 (from the start)`)
  } else if (to && moved && !takesPlace(to, from, current, dev.tag)) notes.push(`behind ${current?.section}.${current?.sentence}: kept`)
  else if (to && moved) {
    const cfi = text?.sections.find(s => s.i === to.section)?.sentences[to.sentence]?.c
    if (cfi) {
      const pct = Number(incoming.CurrentBookmark?.ProgressPercent)
      place({ ...to, cfi }, Number.isFinite(pct) ? Math.min(Math.max(pct / 100, 0), 1) : null, when)
      notes.push(`place ${to.section}.${to.sentence}`)
    }
  }

  // Reading time: the minutes the device added since its last report.
  const minutes = Number(incoming.Statistics?.SpentReadingMinutes) || 0
  const before = Number(previous?.Statistics?.SpentReadingMinutes) || 0
  const delta = minutes - before
  if (delta > 0 && delta <= 12 * 60) {
    let words = text && to && from ? wordsBetween(text, from, to) : 0
    if (words > delta * 1000) words = 0  // a jump, not reading
    writes.push(rest('reading_sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: crypto.randomUUID(), user_id: dev.user_id, book_id: id, kind: 'read', device: dev.tag, device_kind: 'ereader',
        started_at: new Date(when.getTime() - delta * 60_000).toISOString(), ended_at: when.toISOString(),
        seconds: delta * 60, words, pace_words: 0, pace_seconds: 0, updated_at: now.toISOString(),
      }),
    }))
    notes.push(`+${delta} min, ${words} words`)
  }

  // What it was told and has now reported is done; `told` is written only
  // when that changes (a state handed out meanwhile must not be overwritten).
  // A report made after it was told (10 s for the clocks) without it: dropped.
  // A report doesn't show the device has the book while it is being sent again (taken
  // off it minutes ago, not downloaded yet): one still on its way must not stop that.
  const resending = !!known?.resend_at && !known.confirmed_at
  const fresh = applies || !known?.told_at || decided.getTime() > Date.parse(known.told_at) + 10_000
  const left = toldAfter(told, previous?.StatusInfo?.Status, incoming.StatusInfo?.Status, fresh)
  writes.push(rest('kobo_books?on_conflict=device_id,book_id', {
    method: 'POST', prefer: 'resolution=merge-duplicates',
    body: JSON.stringify({
      device_id: dev.id, book_id: id, state: incoming, state_at: now.toISOString(),
      ...(resending ? {} : { confirmed_at: now.toISOString() }),
      ...(left === told ? {} : { told: left }),
    }),
  }))
  await Promise.all(writes)
  return { res: taken(asked), note: notes.join('; ') || 'no change', body: sent }
}

// ---- Files --------------------------------------------------------------------------

async function download(dev: Device, asked: string): Promise<Response> {
  const id = await bookId(dev, asked)
  const book = id ? await bookOf(dev, id) : null
  if (!book?.kepub_path) return new Response('not found', { status: 404 })
  const res = await storage(book.kepub_path)
  if (!res.ok || !res.body) return new Response('not found', { status: 404 })
  await confirm(dev, book.id, book.sha256)
  const h = new Headers({ 'Content-Type': 'application/epub+zip', 'Content-Disposition': 'attachment; filename="book.kepub.epub"' })
  const len = res.headers.get('content-length')
  if (len) h.set('Content-Length', len)
  return new Response(res.body, { headers: h })
}

async function cover(dev: Device, id: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('not found', { status: 404 })
  const res = await storage(`${dev.user_id}/${id}/cover.jpg`)
  if (!res.ok || !res.body) return new Response('not found', { status: 404 })
  return new Response(res.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' } })
}

// ---- Router -------------------------------------------------------------------------

// A book from Kobo's store (one bought or sampled before): Kobo answers, as before.
function toKobo(path: string, url: URL): { res: Response; note: string } {
  return { res: Response.redirect(`${KOBO_STORE}/${path}${url.search}`, 307), note: 'store book' }
}

async function route(req: Request, url: URL, dev: Device, path: string, base: string): Promise<Routed> {
  const m = req.method
  let x: RegExpExecArray | null
  if (path === 'v1/initialization') {
    const res = await initialization(req, base)
    return { res, note: `resources: ${res.headers.get('x-atril-resources')}` }
  }
  if (path === 'v1/library/sync') {
    const res = await librarySync(req, dev, base)
    return { res, note: `${(await res.clone().json()).length} items${res.headers.get('x-kobo-sync') ? ', continue' : ''}` }
  }
  if ((x = /^v1\/library\/([^/]+)\/metadata$/.exec(path))) {
    const id = await bookId(dev, x[1])
    const [book, series, sizes] = await Promise.all([
      id ? bookOf(dev, id) : Promise.resolve(null),
      seriesOf(dev),
      rest<{ book_id: string; bytes: number }[]>('rpc/kobo_kepub_sizes', { method: 'POST', body: JSON.stringify({ uid: dev.user_id }) }),
    ])
    if (!book) return toKobo(path, url)
    return { res: json([metadata({ ...book, id: x[1] }, base, sizes.find(s => s.book_id === book.id)?.bytes ?? null, series.get(book.id))]) }
  }
  if ((x = /^v1\/library\/([^/]+)\/state$/.exec(path))) {
    if (m === 'PUT') return await putState(req, dev, x[1])
    const asked = x[1]
    const id = await bookId(dev, asked)
    if (!id || !UUID.test(id)) return toKobo(path, url)
    // The device waits for this one (opening a book): all of it at once.
    const [book, kb, places, map] = await Promise.all([bookOf(dev, id), koboBooks(dev, [id]), positionsOf(dev, [id]), kepubMap(dev.user_id, id)])
    if (!book) return toKobo(path, url)
    const known = kb.get(id)
    const pos = places.get(id)
    const own = { state: known?.state ?? null, device: dev.tag }
    const plain = readingState({ ...book, id: asked }, pos ?? null, map, own)
    const state = offerNewer(plain, pos ?? null, own)
    await told(dev, [{ book: id, known, state }]).catch(e => console.error('kobo: told', e))
    const loc = state.CurrentBookmark?.Location
    const status = state.StatusInfo?.Status !== known?.state?.StatusInfo?.Status ? `, ${state.StatusInfo?.Status}` : ''
    const offered = state !== plain ? ', offered as new' : ''
    return { res: json([state]), note: (loc ? `sent ${loc.Value} in ${loc.Source} (from ${pos?.device ?? '?'})` : 'sent no place') + offered + status }
  }
  if (path.startsWith('v1/library/tags')) {
    // Collections stay on the device; acknowledge so it doesn't retry.
    if (m === 'POST' && path === 'v1/library/tags') return { res: json(crypto.randomUUID(), 201) }
    return { res: new Response(null, { status: m === 'POST' ? 201 : 200 }) }
  }
  if ((x = /^v1\/library\/([^/]+)$/.exec(path)) && m === 'DELETE') {
    const ids = x[1].split(',').filter(id => /^[0-9a-f-]{36}$/i.test(id))
    const real = (await Promise.all(ids.map(id => bookId(dev, id)))).filter((id): id is string => !!id)
    const known = await koboBooks(dev, real)
    let kept = 0
    for (const id of real) {
      if (!(await bookOf(dev, id))) continue
      // Not the user's doing: the device answering a book this sync just took off it to
      // send again (were it to say so). The book must still be offered.
      const kb = known.get(id)
      if (kb?.resend_at && !kb.confirmed_at && Date.now() - Date.parse(kb.resend_at) < 10 * 60_000) { kept++; continue }
      await rest('kobo_books?on_conflict=device_id,book_id', {
        method: 'POST', prefer: 'resolution=merge-duplicates',
        body: JSON.stringify({ device_id: dev.id, book_id: id, removed: true }),
      })
    }
    return { res: new Response(null, { status: 204 }), note: `removed ${ids.length - kept}` + (kept ? `, ${kept} being sent again: kept` : '') }
  }
  if ((x = /^download\/([^/]+)$/.exec(path))) return { res: await download(dev, x[1]) }
  if ((x = /^([0-9a-f-]{36})\/.*image\.jpg$/i.exec(path))) {
    // A cover of a Kobo store book: Kobo's image server.
    const id = await bookId(dev, x[1])
    if (!id || !(await bookOf(dev, id))) return { res: Response.redirect(`https://cdn.kobo.com/book-images/${path}`, 307), note: 'store cover' }
    return { res: await cover(dev, id) }
  }
  if (path === 'v1/auth/device' || path === 'v1/auth/refresh') {
    // Only reached with the fallback resources (Kobo's sign-in unreachable).
    const body = await req.json().catch(() => ({}))
    const rnd = () => crypto.randomUUID().replaceAll('-', '')
    return { res: json({ AccessToken: rnd(), RefreshToken: rnd(), TokenType: 'Bearer', TrackingId: crypto.randomUUID(), UserKey: body?.UserKey ?? '' }) }
  }
  if (path === 'v1/user/loyalty/benefits') return { res: json({ Benefits: {} }) }
  if (path === 'v1/analytics/gettests') return { res: json({ Result: 'Success', TestKey: req.headers.get('x-kobo-userkey') ?? '', Tests: {} }) }
  // Anything else: an empty answer, so the device carries on.
  return { res: json({}), note: 'unhandled' }
}

Deno.serve(async (req: Request) => {
  const t0 = performance.now()
  const url = new URL(req.url)
  const rest_ = url.pathname.split('/kobo/')[1] ?? ''
  const slash = rest_.indexOf('/')
  const token = slash < 0 ? rest_ : rest_.slice(0, slash)
  const path = slash < 0 ? '' : rest_.slice(slash + 1).replace(/\/+$/, '')
  let dev: Device | null = null
  try {
    dev = await deviceFor(token)
  } catch (e) {
    console.error('kobo: device lookup failed', e)
    return json({ error: 'unavailable' }, 503)
  }
  if (!dev) return json({ error: 'unknown device' }, 401)
  const base = `${URL_BASE}/functions/v1/kobo/${token}`
  let res: Response
  let note: string | undefined
  let body: unknown
  try {
    ;({ res, note, body } = await route(req, url, dev, path, base))
  } catch (e) {
    console.error('kobo:', req.method, path, e)
    res = json({ error: 'failed' }, 500)
    note = String(e).slice(0, 300)
  }
  // The log: never the token (it is in the path's first segment, left out).
  const logged = rest('kobo_log', {
    method: 'POST',
    body: JSON.stringify({
      device_id: dev.id, method: req.method, path: path.slice(0, 200), status: res.status, note: note ?? null, body: body ?? null,
      ms: Math.round(performance.now() - t0),
    }),
  }).then(() => rest(`kobo_devices?id=eq.${dev!.id}`, { method: 'PATCH', body: JSON.stringify({ last_seen: new Date().toISOString() }) }))
    .then(() => Math.random() < 0.02 ? rest(`kobo_log?at=lt.${q(new Date(Date.now() - 14 * 864e5).toISOString())}`, { method: 'DELETE' }) : null)
    .catch(e => console.error('kobo: log failed', e))
  // @ts-ignore EdgeRuntime exists on Supabase: finish the log after answering.
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(logged)
  else await logged
  return res
})
