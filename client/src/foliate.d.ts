// Minimal types for the parts of foliate-js this app uses (it ships plain JS).

declare module 'foliate-js/view.js' {
  export interface TocItem { label: string; href: string; subitems?: TocItem[] }
  export interface Section {
    id: string
    cfi?: string
    linear?: string
    size?: number
    createDocument?: () => Promise<Document>
  }
  export interface FoliateBook {
    metadata: { title?: unknown; author?: unknown; language?: string | string[]; identifier?: string }
    sections: Section[]
    toc?: TocItem[]
    dir?: string
    getCover?: () => Promise<Blob | null>
    resolveHref: (href: string) => { index: number; anchor?: unknown } | null
    splitTOCHref?: (href: string) => [string, string]
  }
  export interface Location {
    fraction: number
    section: { current: number; total: number }
    location: { current: number; next: number; total: number }
    tocItem?: { label: string; href: string; id?: number }
    pageItem?: { label: string }
    cfi: string
    range: Range
  }
  export interface Renderer extends HTMLElement {
    setStyles(css: string | [string, string]): void
    getContents(): { index: number; doc: Document; overlayer?: unknown }[]
    scrollToAnchor(anchor: Range | Element | number, select?: boolean): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    goTo(target: unknown): Promise<void>
    readonly start: number
    readonly end: number
    readonly page: number
    readonly pages: number
    readonly size: number
    destroy(): void
  }
  export class View extends HTMLElement {
    book: FoliateBook
    renderer: Renderer
    lastLocation: Location | null
    open(book: File | Blob | FoliateBook | string): Promise<void>
    close(): void
    init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>
    goTo(target: string | number | { fraction: number }): Promise<{ index: number; anchor: (doc: Document) => Range } | undefined>
    goToFraction(f: number): Promise<void>
    getCFI(index: number, range?: Range): string
    resolveNavigation(target: unknown): { index: number; anchor: (doc: Document) => Range | Element } | undefined
    addAnnotation(a: { value: string; color?: string }, remove?: boolean): Promise<unknown>
    deleteAnnotation(a: { value: string }): Promise<unknown>
    getSectionFractions(): number[]
    deselect(): void
    next(): Promise<void>
    prev(): Promise<void>
    goLeft(): Promise<void>
    goRight(): Promise<void>
  }
  export function makeBook(file: File | Blob | string): Promise<FoliateBook>
}

declare module 'foliate-js/epubcfi.js' {
  export const isCFI: RegExp
  export function fromRange(range: Range): string
  export function joinIndir(...parts: string[]): string
  export function parse(cfi: string): unknown
  export function compare(a: string, b: string): number
  export function collapse(cfi: string, toEnd?: boolean): string
  export function toRange(doc: Document, parts: unknown): Range
  export const fake: { fromIndex(index: number): string; toIndex(part: unknown): number }
}

declare module 'foliate-js/overlayer.js' {
  type Draw = (rects: DOMRectList, options?: Record<string, unknown>) => SVGElement
  export class Overlayer {
    static highlight: Draw
    static underline: Draw
    static outline: Draw
    add(key: string, range: Range, draw: Draw, options?: Record<string, unknown>): void
    remove(key: string): void
    redraw(): void
  }
}
