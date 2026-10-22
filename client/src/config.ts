// Public by design: the publishable key only grants what RLS allows a signed-in
// user to do with their own rows, and sign-ups are limited to allow-listed
// emails (supabase/schema.sql). The secret key lives only on the PC running
// the TTS worker (tts-worker/.env), never here.
export const SUPABASE_URL = ''
export const SUPABASE_KEY = ''

export const GITHUB_REPO = 'juanmaacontreras/ebook-reader'

// Injected by CI (vite define): the release number = commit count. 0 in dev.
declare const __APP_VERSION__: string
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0'
