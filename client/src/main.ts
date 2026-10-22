import './styles/tokens.css'
import './styles/app.css'
import { App } from '@capacitor/app'
import { configured, demo, supabase } from './data/supabase'
import { db } from './data/db'
import { startRealtime, stopRealtime, sync, syncState } from './data/sync'
import { autoNarrateAll } from './data/store'
import { applyUiTheme } from './platform/theme'
import { checkForUpdate } from './platform/updater'
import { isAndroid } from './platform'
import { authScreen } from './screens/auth'
import { libraryScreen } from './screens/library'
import { loadPrefs } from './settings'

const root = document.getElementById('app')!
let teardown: (() => void) | null = null

// Routes: #/ (library), #/book/<id> (reader), #/audios, #/stats.
async function route(): Promise<void> {
  teardown?.()
  teardown = null
  const m = location.hash.match(/^#\/book\/([\w-]+)/)
  if (location.hash === '#/audios') {
    applyUiTheme()
    const { audiosScreen } = await import('./screens/audios')
    teardown = audiosScreen(root, id => (location.hash = `#/book/${id}`), () => history.back())
  } else if (location.hash === '#/stats') {
    applyUiTheme()
    const { statsScreen } = await import('./screens/stats')
    teardown = statsScreen(root, id => (location.hash = `#/book/${id}`), () => history.back())
  } else if (m) {
    const { readerScreen } = await import('./screens/reader')
    teardown = await readerScreen(root, m[1], () => history.length > 1 ? history.back() : (location.hash = '#/'))
  } else {
    applyUiTheme()
    teardown = libraryScreen(root, id => (location.hash = `#/book/${id}`))
  }
}

async function main(): Promise<void> {
  if (demo) (window as unknown as { __atril: unknown }).__atril = { db }  // screenshot seeding
  await loadPrefs()
  // Design proposals (CLAUDE.md): ?variant=NAME is exposed to CSS while a choice is pending.
  const variant = new URLSearchParams(location.search).get('variant')
  if (variant) document.documentElement.dataset.variant = variant
  applyUiTheme()
  const { data } = await supabase.auth.getSession()
  if (!demo && (!configured || !data.session)) {
    authScreen(root)
    supabase.auth.onAuthStateChange((event, session) => { if (event === 'SIGNED_IN' && session) location.reload() })
    return
  }
  window.addEventListener('hashchange', () => void route())
  await route()
  // Auto-narration only after a successful pull: a request made before knowing
  // the remote narration row could overwrite the voice chosen on another device.
  void sync().then(() => { if (syncState === 'idle') void autoNarrateAll() })
  startRealtime()
  void checkForUpdate()

  // Sync when coming back to the app, and every 5 minutes as a safety net
  // (Realtime normally reports changes within a second).
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync() })
  window.addEventListener('online', () => void sync())
  setInterval(() => { if (!document.hidden) void sync() }, 5 * 60_000)
  if (isAndroid) {
    void App.addListener('backButton', ({ canGoBack }) => {
      if (document.querySelector('.overlay')) (document.querySelector('.overlay') as HTMLElement).click()
      else if (location.hash.startsWith('#/book/')) history.back()
      else if (!canGoBack) void App.exitApp()
      else history.back()
    })
    void App.addListener('appStateChange', ({ isActive }) => { if (isActive) { void sync(); startRealtime() } else void stopRealtime() })
  }
}

void main()
