// Styles injected into the book's own document (inside foliate's iframe). The
// reading surface has its own light/sepia/dark themes, framed by the app UI.

import { isDark } from '../platform/theme'
import type { BookFont, BookTheme, Margins, Prefs, Spacing } from '../settings'

export interface BookPalette { bg: string; fg: string; muted: string; link: string; sentence: string; dark: boolean }

const PALETTES: Record<Exclude<BookTheme, 'auto'>, BookPalette> = {
  light: { bg: '#FAFBFC', fg: '#2E3440', muted: '#7A869B', link: '#5E81AC', sentence: '#88C0D0', dark: false },
  sepia: { bg: '#F4ECD8', fg: '#4F3F2E', muted: '#8C7A63', link: '#8A5A3B', sentence: '#D9B46A', dark: false },
  dark: { bg: '#2E3440', fg: '#D8DEE9', muted: '#9AA4B6', link: '#88C0D0', sentence: '#5E81AC', dark: true },
}

export function palette(theme: BookTheme): BookPalette {
  return PALETTES[theme === 'auto' ? (isDark() ? 'dark' : 'light') : theme]
}

const FONTS: Record<BookFont, string | null> = {
  book: null,
  serif: '"Literata", "Iowan Old Style", "Palatino Linotype", Palatino, "Noto Serif", Georgia, serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif',
}
export const LINE_HEIGHT: Record<Spacing, number> = { tight: 1.35, normal: 1.55, loose: 1.8 }
export const MARGIN_GAP: Record<Margins, string> = { s: '4%', m: '7%', l: '11%' }

export function bookCss(p: Prefs): string {
  const c = palette(p.bookTheme)
  const font = FONTS[p.font]
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: ${c.dark ? 'dark' : 'light'}; background: ${c.bg} !important; color: ${c.fg} !important; }
    body { background: transparent !important; color: ${c.fg} !important; font-size: ${p.fontSize}px !important; }
    ${font ? `body, p, li, blockquote, dd, div, span { font-family: ${font} !important; }` : ''}
    p, li, blockquote, dd {
      line-height: ${LINE_HEIGHT[p.spacing]} !important;
      text-align: ${p.justify ? 'justify' : 'start'};
      -webkit-hyphens: auto; hyphens: auto;
      widows: 2; orphans: 2;
    }
    p, li, blockquote, dd, h1, h2, h3, h4, h5, h6, span, div { color: inherit !important; background-color: transparent !important; }
    a:link, a:visited { color: ${c.link} !important; }
    img, svg { max-width: 100%; height: auto; }
    ${c.dark ? 'img { filter: brightness(.9); }' : ''}
    pre { white-space: pre-wrap !important; }
    aside[epub|type~="endnote"], aside[epub|type~="footnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
    ::selection { background: ${c.dark ? 'rgba(136,192,208,.35)' : 'rgba(94,129,172,.28)'}; }
  `
}
