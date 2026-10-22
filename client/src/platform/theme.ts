import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import { prefs, type UiTheme } from '../settings'
import { isAndroid } from '.'

const media = matchMedia('(prefers-color-scheme: dark)')

export function isDark(theme: UiTheme = prefs().uiTheme): boolean {
  return theme === 'dark' || (theme === 'system' && media.matches)
}

// System bars match the paper color: on Android the app draws edge to edge
// (bars are transparent over our background), so only the icon style changes.
export function applyUiTheme(): void {
  const theme = prefs().uiTheme
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.dataset.theme = theme
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', paper)
  setBarsDark(isDark(theme))
}

export function setBarsDark(dark: boolean): void {
  if (isAndroid) void SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {})
}

media.addEventListener('change', () => applyUiTheme())
