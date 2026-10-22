// Keeps the screen from dimming while a book is open, like a video player does.
// It lets go after IDLE_MS without a page turn or a tap (fell asleep reading),
// and comes back with the next one. Android: window flag (ScreenPlugin.java);
// elsewhere: the Screen Wake Lock API where the webview has it.
import { registerPlugin } from '@capacitor/core'
import { isAndroid } from '.'

const Screen = registerPlugin<{ keepOn(o: { on: boolean }): Promise<void> }>('Screen')
const IDLE_MS = 10 * 60_000

let sentinel: { release(): Promise<void> } | null = null
let held = false
let timer: number | undefined

async function set(on: boolean) {
  if (on === held) return
  held = on
  try {
    if (isAndroid) { await Screen.keepOn({ on }); return }
    if (on) {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock
      sentinel = (await wl?.request('screen')) ?? null
    } else {
      await sentinel?.release()
      sentinel = null
    }
  } catch { held = false }
}

// The browser drops a wake lock when the page is hidden; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && timer !== undefined && !isAndroid) { held = false; void set(true) }
})

/** The reader calls this on open and on every page turn or tap. */
export function stayAwake() {
  void set(true)
  clearTimeout(timer)
  timer = window.setTimeout(() => { timer = undefined; void set(false) }, IDLE_MS)
}

/** The reader is closing. */
export function allowSleep() {
  clearTimeout(timer)
  timer = undefined
  void set(false)
}
