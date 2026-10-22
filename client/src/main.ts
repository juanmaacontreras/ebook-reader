import './styles/tokens.css'
import './styles/app.css'
import { App } from '@capacitor/app'
import { configured, demo, supabase } from './data/supabase'
import { db } from './data/db'
import { startRealtime, stopRealtime, sync } from './data/sync'
import { applyUiTheme } from './platform/theme'
import { checkForUpdate } from './platform/updater'
import { isAndroid } from './platform'
import { authScreen } from './screens/auth'
import { libraryScreen } from './screens/library'
import { loadPrefs } from './settings'

const root = document.getElementById('app')!
let teardown: (() => void) | null = null

// Routes: #/ (library) and #/book/<id> (reader).
async function route(): Promise<void> {
  teardown?.()
  teardown = null
  const m = location.hash.match(/^#\/book\/([\w-]+)/)
  if (m) {
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
  applyUiTheme()
  const { data } = await supabase.auth.getSession()
  if (!demo && (!configured || !data.session)) {
    authScreen(root)
    supabase.auth.onAuthStateChange((event, session) => { if (event === 'SIGNED_IN' && session) location.reload() })
    return
  }
  window.addEventListener('hashchange', () => void route())
  await route()
  void sync()
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
