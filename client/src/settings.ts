// Per-device preferences (not synced: a phone and a tablet want different
// font sizes). Stored in the local kv store.

import { kv } from './data/db'

export type UiTheme = 'system' | 'light' | 'dark'
export type BookTheme = 'auto' | 'light' | 'sepia' | 'dark'
export type BookFont = 'book' | 'serif' | 'sans'
export type Margins = 's' | 'm' | 'l'
export type Spacing = 'tight' | 'normal' | 'loose'
export type Flow = 'paginated' | 'scrolled'

export interface Prefs {
  uiTheme: UiTheme
  bookTheme: BookTheme
  font: BookFont
  fontSize: number   // px
  margins: Margins
  spacing: Spacing
  flow: Flow
  justify: boolean
  libraryFilter: 'reading' | 'to_read' | 'finished' | 'all'
}

export const DEFAULT_PREFS: Prefs = {
  uiTheme: 'system', bookTheme: 'auto', font: 'serif', fontSize: 19, margins: 'm', spacing: 'normal',
  flow: 'paginated', justify: true, libraryFilter: 'all',
}

let cache: Prefs | null = null
const listeners = new Set<(p: Prefs) => void>()

export async function loadPrefs(): Promise<Prefs> {
  cache ??= { ...DEFAULT_PREFS, ...((await kv.get<Partial<Prefs>>('prefs')) ?? {}) }
  return cache
}
export function prefs(): Prefs { return cache ?? DEFAULT_PREFS }
export async function setPrefs(patch: Partial<Prefs>): Promise<void> {
  cache = { ...prefs(), ...patch }
  await kv.set('prefs', cache)
  for (const fn of listeners) fn(cache)
}
export function onPrefs(fn: (p: Prefs) => void): () => void { listeners.add(fn); return () => listeners.delete(fn) }
