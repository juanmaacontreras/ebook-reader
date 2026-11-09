// Publishes the user's reading and listening sessions to Bitácora (the time tracker, a
// separate project with its own Supabase): the inbox row `<BITACORA_BUCKET>::atril` in its
// `buckets` table. Called every 15 minutes by pg_cron (supabase/bitacora.sql); writes only
// when something changed. See docs/bitacora.md.
//
// Secrets (supabase secrets set): BITACORA_URL, BITACORA_KEY (its anon key), BITACORA_BUCKET
// (its USER_KEY), BITACORA_PROFILE (the Bitácora profile that receives them, "default"),
// ATRIL_USER (whose sessions) and BITACORA_CRON_SECRET (what pg_cron sends).

import { type BookRow, buildInbox, sameInbox, type SessionRow, since } from './logic.ts'

const env = (k: string) => Deno.env.get(k) ?? ''
const URL_BASE = env('SUPABASE_URL')
function secretKey(): string {
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}') as Record<string, string>
    const k = keys.default ?? Object.values(keys)[0]
    if (k) return k
  } catch { /* not set */ }
  return env('SUPABASE_SERVICE_ROLE_KEY')
}
const KEY = secretKey()

function auth(key: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: key, ...extra }
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`
  return h
}

async function get<T>(url: string, key: string): Promise<T> {
  const res = await fetch(url, { headers: auth(key, { Accept: 'application/json' }) })
  if (!res.ok) throw new Error(`GET ${url.split('?')[0]}: ${res.status} ${await res.text()}`)
  return await res.json() as T
}

Deno.serve(async req => {
  const secret = env('BITACORA_CRON_SECRET')
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('forbidden', { status: 403 })
  try {
    const user = env('ATRIL_USER')
    const sessions = await get<SessionRow[]>(
      `${URL_BASE}/rest/v1/reading_sessions?select=id,book_id,kind,started_at,seconds,updated_at` +
        `&user_id=eq.${user}&started_at=gte.${encodeURIComponent(since(new Date()))}&order=started_at`, KEY)
    const ids = [...new Set(sessions.map(s => s.book_id).filter(Boolean))]
    const books = ids.length
      ? await get<BookRow[]>(`${URL_BASE}/rest/v1/books?select=id,title,author,subject&user_id=eq.${user}&id=in.(${ids.join(',')})`, KEY)
      : []
    const inbox = buildInbox(sessions, books, env('BITACORA_PROFILE') || 'default')

    const base = env('BITACORA_URL').replace(/\/$/, ''), bkey = env('BITACORA_KEY')
    const userKey = `${env('BITACORA_BUCKET')}::atril`
    const rows = await get<{ data: unknown }[]>(`${base}/rest/v1/buckets?user_key=eq.${encodeURIComponent(userKey)}&select=data`, bkey)
    if (sameInbox(rows[0]?.data, inbox)) return Response.json({ written: false, sessions: inbox.sessions.length })
    const res = await fetch(`${base}/rest/v1/buckets?on_conflict=user_key`, {
      method: 'POST',
      headers: auth(bkey, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ user_key: userKey, data: inbox, updated_at: Date.now() }]),
    })
    if (!res.ok) throw new Error(`POST buckets: ${res.status} ${await res.text()}`)
    return Response.json({ written: true, sessions: inbox.sessions.length })
  } catch (e) {
    console.error(e)
    return new Response(String(e), { status: 500 })
  }
})
