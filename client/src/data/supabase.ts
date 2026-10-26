import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_KEY, SUPABASE_URL } from '../config'

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY)

// ?demo: local-only mode with no account and no sync. Used to render the real
// app for screenshots (design proposals) and to try it without a backend.
export const demo = new URLSearchParams(location.search).has('demo')

export const supabase: SupabaseClient = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_KEY || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'atril-auth' },
  realtime: { params: { eventsPerSecond: 5 } },
})

// The session saved on this device, even with an expired access token.
// Offline, getSession() can't refresh an expired token and returns null, but
// supabase-js keeps the stored session on network errors and refreshes it once
// the device is back online. That's enough to open the local library and read.
function storedUserId(): string | null {
  try {
    const raw = localStorage.getItem('atril-auth')
    return raw ? (JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null : null
  } catch { return null }
}

export async function userId(): Promise<string | null> {
  if (demo) return 'demo'
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? storedUserId()
}
