import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_KEY, SUPABASE_URL } from '../config'

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY)

// ?demo: local-only mode with no account and no sync. Used to render the real
// app for screenshots (design proposals) and to try it without a backend.
export const demo = new URLSearchParams(location.search).has('demo')

export const supabase: SupabaseClient = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_KEY || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'atril-auth' },
  // A heartbeat every 15 s (default 25): a connection that died without a word
  // (a phone switching networks) is noticed, rejoined and caught up sooner.
  realtime: { params: { eventsPerSecond: 5 }, heartbeatIntervalMs: 15_000 },
})

// The session saved on this device, even with an expired access token.
// Read directly instead of through getSession(): offline, supabase-js retries
// refreshing an expired token for ~30 s before giving up (and keeps the stored
// session, refreshing it once back online), and getSession() waits for that.
// The user id is enough to open the local library and read.
function storedUserId(): string | null {
  try {
    const raw = localStorage.getItem('atril-auth')
    return raw ? (JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null : null
  } catch { return null }
}

export async function userId(): Promise<string | null> {
  if (demo) return 'demo'
  const stored = storedUserId()
  if (stored) return stored
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? null
}
