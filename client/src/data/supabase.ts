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

export async function userId(): Promise<string | null> {
  if (demo) return 'demo'
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? null
}
