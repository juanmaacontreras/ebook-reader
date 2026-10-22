import { Capacitor } from '@capacitor/core'

export type Platform = 'android' | 'tauri' | 'web'

export const platform: Platform =
  Capacitor.getPlatform() === 'android' ? 'android' : '__TAURI_INTERNALS__' in window ? 'tauri' : 'web'

export const isAndroid = platform === 'android'
export const isTauri = platform === 'tauri'

// Narration is requested and managed only from the desktop app (the PC that
// generates it). Phones and tablets only listen to what already exists: no
// voice choice, no requests (not even implicit ones), no queue/cloud actions.
// ?demo&as=phone renders the phone variant in a browser (screenshots).
const params = new URLSearchParams(location.search)
export const audioManager = !isAndroid && !(params.has('demo') && params.get('as') === 'phone')
