import './styles/tokens.css'
import './styles/app.css'
import { App } from '@capacitor/app'
import { configured, demo, supabase, userId } from './data/supabase'
import { db } from './data/db'
import { flush, onChange, restartRealtime, safetySync, startRealtime, stopRealtime, sync } from './data/sync'
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
  if (!demo && (!configured || !(await userId()))) {
    authScreen(root)
    supabase.auth.onAuthStateChange((event, session) => { if (event === 'SIGNED_IN' && session) location.reload() })
    return
  }
  window.addEventListener('hashchange', () => void route())
  await route()
  void sync()
  startRealtime()
  // The open book was removed from the library on another device.
  onChange(async changed => {
    const m = location.hash.match(/^#\/book\/([\w-]+)/)
    if (m && changed.has('books') && !(await db.get('books', m[1]))) location.replace('#/')
  })
  void checkForUpdate()

  // Coming back to the app: a full sync. Leaving it: what's pending goes at once
  // (a phone may freeze a background app within seconds). Realtime brings the
  // rest within a second; safetySync covers it while it's down.
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flush(); else void sync() })
  window.addEventListener('pagehide', () => void flush())
  // Back online: a new Realtime connection too (the old one may be dead silently).
  window.addEventListener('online', () => { void sync(); void restartRealtime() })
  setInterval(() => { if (!document.hidden) safetySync() }, 30_000)
  if (isAndroid) {
    void App.addListener('backButton', ({ canGoBack }) => {
      if (document.querySelector('.overlay')) (document.querySelector('.overlay') as HTMLElement).click()
      else if (location.hash.startsWith('#/book/')) history.back()
      else if (!canGoBack) void App.exitApp()
      else history.back()
    })
    void App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) { void sync(); startRealtime() } else { void flush(); void stopRealtime() }
    })
  }
}

void main()
