import { Capacitor } from '@capacitor/core'

export type Platform = 'android' | 'tauri' | 'web'

export const platform: Platform =
  Capacitor.getPlatform() === 'android' ? 'android' : '__TAURI_INTERNALS__' in window ? 'tauri' : 'web'

export const isAndroid = platform === 'android'
export const isTauri = platform === 'tauri'
