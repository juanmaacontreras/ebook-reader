// Edge Function `kobo`: lets a Kobo e-reader sync with Atril as if Atril were the
// Kobo store. The device is pointed here by `api_endpoint` in its
// "Kobo eReader.conf": https://<ref>.supabase.co/functions/v1/kobo/<device token>
//
// Runs with the platform's service role (injected by Supabase, never in the repo)
// and scopes every query to the user that owns the device token. Deploy with JWT
// verification off: the Kobo can't send a Supabase JWT, the token is the secret.
// See protocol.ts for the pure parts and the "not confirmed on a device" caveat.
import { createClient } from 'npm:@supabase/supabase-js@2'
import resources from './resources.json' with { type: 'json' }
import {
  EPOCH, bookEntitlement, bookMetadata, decodeCursor, encodeCursor, initResources, parsePath,
  parseStatePut, percentAtSentence, placeAtPercent, readingState,
  type BookRow, type KoboStateRow, type ManifestLike,
} from './protocol.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const db = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const BASE = `${SUPABASE_URL}/functions/v1/kobo`
const PAGE = 50 // books per sync round; the device asks again while we answer x-kobo-sync: continue

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signed(bucket: string, path: string) {
  const { data } = await db.storage.from(bucket).createSignedUrl(path, 3600)
  return data?.signedUrl ?? null
}

const manifests = new Map<string, ManifestLike | null>()
async function manifest(userId: string, bookId: string, textPath: string | null): Promise<ManifestLike | null> {
  if (!textPath) return null
  if (manifests.has(bookId)) return manifests.get(bookId)!
  let m: ManifestLike | null = null
  try {
    const { data } = await db.storage.from('library').download(textPath)
    if (data) m = JSON.parse(await new Response(data.stream().pipeThrough(new DecompressionStream('gzip'))).text())
  } catch { /* no manifest: fall back to the stored fraction */ }
  manifests.set(bookId, m)
  return m
}

const BOOK_COLS = 'id,title,author,language,status,added_at,updated_at,synced_at,size_bytes,text_path,cover_path,epub_path'
type Book = BookRow & { text_path: string | null; cover_path: string | null; epub_path: string }

/** Atril's position of a book as a percent of the text, for the device. */
async function atrilPercent(userId: string, b: Book) {
  const { data: p } = await db.from('positions').select('section,sentence,fraction,updated_at,device').eq('book_id', b.id).maybeSingle()
  if (!p) return null
  let percent: number | null = null
  if (p.section != null && p.sentence != null) {
    const m = await manifest(userId, b.id, b.text_path)
    if (m) percent = percentAtSentence(m, p.section, p.sentence)
  }
  if (percent == null && p.fraction != null) percent = p.fraction * 100
  return percent == null ? null : { percent, at: p.updated_at as string, device: p.device as string | null }
}

async function stateFor(userId: string, b: Book) {
  const { data: k } = await db.from('kobo_states').select('*').eq('book_id', b.id).maybeSingle()
  const a = await atrilPercent(userId, b)
  return readingState(b, (k as KoboStateRow | null), a)
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const route = parsePath(url.pathname)
  if (!route) return json({})
  const { token, rest } = route

  const { data: dev } = await db.from('kobo_devices').select('user_id').eq('token_hash', await sha256(token)).maybeSingle()
  if (!dev) return json({ error: 'unknown device' }, 401)
  const userId: string = dev.user_id
  const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text()
  let body: unknown = null
  try { body = bodyText ? JSON.parse(bodyText) : null } catch { /* not JSON */ }

  // Debug trail: the first days with a real device decide what this file gets wrong.
  if (!rest.endsWith('image.jpg')) {
    await db.from('kobo_events').insert({ user_id: userId, method: req.method, path: rest + url.search, body })
    await db.from('kobo_devices').update({ last_seen: new Date().toISOString() }).eq('token_hash', await sha256(token))
  }

  if (req.method === 'GET' && rest === '/v1/initialization') {
    return json({ Resources: initResources(resources as Record<string, unknown>, BASE, token) }, 200, { 'x-kobo-apitoken': 'e30=' })
  }
  if (req.method === 'POST' && (rest === '/v1/auth/device' || rest === '/v1/auth/refresh')) {
    const b = (body ?? {}) as { UserKey?: string }
    return json({
      AccessToken: crypto.randomUUID().replaceAll('-', ''), RefreshToken: crypto.randomUUID().replaceAll('-', ''),
      TokenType: 'Bearer', TrackingId: crypto.randomUUID(), UserKey: b.UserKey ?? '',
    })
  }

  if (req.method === 'GET' && rest === '/v1/library/sync') return await sync(userId, token, req)

  let m = rest.match(/^\/v1\/library\/([0-9a-f-]{36})\/metadata$/)
  if (m && req.method === 'GET') {
    const { data: b } = await db.from('books').select(BOOK_COLS).eq('id', m[1]).eq('user_id', userId).maybeSingle()
    if (!b) return json([], 404)
    return json([bookMetadata(b as Book, `${BASE}/${token}/download/${b.id}`)])
  }

  m = rest.match(/^\/v1\/library\/([0-9a-f-]{36})\/state$/)
  if (m) {
    const { data: b } = await db.from('books').select(BOOK_COLS).eq('id', m[1]).eq('user_id', userId).maybeSingle()
    if (!b) return json({}, 404)
    if (req.method === 'GET') return json([await stateFor(userId, b as Book)])
    if (req.method === 'PUT') return await putState(userId, b as Book, body)
  }

  // Deleting a book on the Kobo only removes it from the device; the library keeps it.
  if (req.method === 'DELETE' && /^\/v1\/library\/[0-9a-f-]{36}$/.test(rest)) return new Response(null, { status: 204 })

  m = rest.match(/^\/download\/([0-9a-f-]{36})$/)
  if (m) {
    const { data: b } = await db.from('books').select('epub_path').eq('id', m[1]).eq('user_id', userId).maybeSingle()
    const u = b && await signed('library', b.epub_path)
    return u ? Response.redirect(u, 302) : json({}, 404)
  }

  m = rest.match(/^\/([0-9a-f-]{36})\/\d+\/\d+\/(?:[^/]+\/)?[^/]+\/image\.jpg$/)
  if (m) {
    const { data: b } = await db.from('books').select('cover_path').eq('id', m[1]).eq('user_id', userId).maybeSingle()
    const u = b?.cover_path && await signed('library', b.cover_path)
    return u ? Response.redirect(u, 302) : new Response(null, { status: 404 })
  }

  // Store features the device may ask for: nothing to show, but never an error.
  if (rest === '/v1/analytics/gettests') return json({ Result: 'Success', TestKey: req.headers.get('x-kobo-userkey') ?? '', Tests: {} })
  if (rest === '/v1/user/loyalty/benefits') return json({ Benefits: {} })
  if (rest.startsWith('/v1/library/tags')) return json([])
  return json({})
}

async function sync(userId: string, token: string, req: Request) {
  const cur = decodeCursor(req.headers.get('x-kobo-synctoken'))
  const results: unknown[] = []

  const { data: books } = await db.from('books').select(BOOK_COLS).eq('user_id', userId)
    .gt('synced_at', cur.books).order('synced_at').limit(PAGE)
  const sentIds = new Set<string>()
  let booksCursor = cur.books
  for (const b of (books ?? []) as Book[]) {
    sentIds.add(b.id)
    booksCursor = b.synced_at
    const isNew = cur.books === EPOCH || b.added_at > cur.books
    const entitlement = {
      BookEntitlement: bookEntitlement(b),
      BookMetadata: bookMetadata(b, `${BASE}/${token}/download/${b.id}`),
      ReadingState: await stateFor(userId, b),
    }
    results.push(isNew ? { NewEntitlement: entitlement } : { ChangedEntitlement: entitlement })
  }
  const more = (books?.length ?? 0) === PAGE

  // Books removed from the library: the device drops its copy.
  if (!more) {
    const { data: gone } = await db.from('deleted_books').select('book_id,synced_at').eq('user_id', userId).gt('synced_at', cur.books)
    for (const g of gone ?? []) {
      const stub = { id: g.book_id, added_at: g.synced_at, updated_at: g.synced_at } as BookRow
      results.push({ ChangedEntitlement: { BookEntitlement: bookEntitlement(stub, true), BookMetadata: { EntitlementId: g.book_id, Title: '' } } })
      if (g.synced_at > booksCursor) booksCursor = g.synced_at
    }
  }

  // Position changes made elsewhere (phone, tablet, PC), not echoes of the Kobo's own.
  let posCursor = cur.positions
  if (!more) {
    const { data: pos } = await db.from('positions').select('book_id,synced_at,device').eq('user_id', userId)
      .gt('synced_at', cur.positions).order('synced_at').limit(PAGE)
    for (const p of pos ?? []) {
      posCursor = p.synced_at
      if (p.device === 'kobo' || sentIds.has(p.book_id)) continue
      const { data: b } = await db.from('books').select(BOOK_COLS).eq('id', p.book_id).maybeSingle()
      if (b) results.push({ ChangedReadingState: { ReadingState: await stateFor(userId, b as Book) } })
    }
  }

  const headers: Record<string, string> = { 'x-kobo-synctoken': encodeCursor({ books: booksCursor, positions: posCursor }) }
  if (more) headers['x-kobo-sync'] = 'continue'
  return json(results, 200, headers)
}

async function putState(userId: string, b: Book, body: unknown) {
  const p = parseStatePut(body)
  const now = new Date().toISOString()
  const result: Record<string, unknown> = { EntitlementId: b.id }

  if (p.hasBookmark || p.status || p.spent_minutes != null) {
    await db.from('kobo_states').upsert({
      book_id: b.id, user_id: userId, status: (body as { ReadingStates?: { StatusInfo?: { Status?: string } }[] })?.ReadingStates?.[0]?.StatusInfo?.Status ?? null,
      progress: p.progress, source_progress: p.source_progress, location: p.location,
      spent_minutes: p.spent_minutes, remaining_minutes: p.remaining_minutes, raw: body, last_modified: now,
    })
  }

  if (p.hasBookmark) {
    result.CurrentBookmarkResult = { Result: 'Success' }
    const percent = p.source_progress ?? p.progress
    const m = percent == null ? null : await manifest(userId, b.id, b.text_path)
    const place = m && percent != null ? placeAtPercent(m, percent) : null
    if (place) {
      await db.from('positions').upsert({
        book_id: b.id, user_id: userId, cfi: place.cfi, section: place.section, sentence: place.sentence,
        fraction: place.fraction, device: 'kobo', updated_at: now,
      })
    }
  }
  if (p.spent_minutes != null || p.remaining_minutes != null) result.StatisticsResult = { Result: 'Success' }

  if (p.status) {
    result.StatusInfoResult = { Result: 'Success' }
    // "ReadyToRead" is what an unopened book says; never let it undo reading/finished.
    if ((p.status === 'reading' && b.status === 'to_read') || (p.status === 'finished' && b.status !== 'finished')) {
      await db.from('books').update({ status: p.status, updated_at: now, finished_at: p.status === 'finished' ? now : null }).eq('id', b.id)
    }
  }

  await db.rpc('kobo_trim_events').then(() => {}, () => {})
  return json({ RequestResult: 'Success', UpdateResults: [{ ...result, LastModified: now, PriorityTimestamp: now }] })
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (e) {
    console.error('kobo', req.method, req.url, e)
    return json({ error: String(e) }, 500)
  }
})
