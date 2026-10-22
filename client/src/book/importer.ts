import { makeBook, type FoliateBook } from 'foliate-js/view.js'
import { db } from '../data/db'
import { local, paths } from '../data/files'
import { syncSoon } from '../data/sync'
import type { Book, Local } from '../data/types'
import { buildManifest, gzipJson } from './manifest'

export interface ImportResult { book: Book; duplicate: boolean }

async function sha256(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}

export function languageMap(x: unknown): string {
  if (!x) return ''
  if (typeof x === 'string') return x
  if (typeof x === 'object') {
    const values = Object.values(x as Record<string, string>)
    return values[0] ?? ''
  }
  return ''
}

export function contributors(x: unknown): string {
  const one = (c: unknown) => (typeof c === 'string' ? c : languageMap((c as { name?: unknown })?.name))
  const list = Array.isArray(x) ? x.map(one) : [one(x)]
  return list.filter(Boolean).join(', ')
}

export function bookLanguage(book: FoliateBook): string {
  const raw = Array.isArray(book.metadata.language) ? book.metadata.language[0] : book.metadata.language
  return (raw || 'es').trim()
}

async function resizeCover(blob: Blob, maxH = 600): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(blob)
    const scale = Math.min(1, maxH / bmp.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    return await new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', 0.85))
  } catch {
    return null
  }
}

// Import one EPUB: everything is saved locally first (so it works offline),
// then sync uploads the files and pushes the row (see uploadPendingBooks).
export async function importEpub(file: File, uid: string, onProgress?: (f: number) => void): Promise<ImportResult> {
  const buf = await file.arrayBuffer()
  const hash = await sha256(buf)
  const existing = (await db.all<Book>('books')).find(b => b.sha256 === hash)
  if (existing) return { book: existing, duplicate: true }

  const epub = new File([buf], file.name, { type: 'application/epub+zip' })
  const fb = await makeBook(epub)
  const id = crypto.randomUUID()
  const lang = bookLanguage(fb)
  const coverRaw = await fb.getCover?.().catch(() => null)
  const cover = coverRaw ? await resizeCover(coverRaw) : null
  const manifest = await buildManifest(fb, lang.split('-')[0], onProgress)
  const text = await gzipJson(manifest)
  const now = new Date().toISOString()
  const book: Local<Book> & { _upload: boolean } = {
    id,
    sha256: hash,
    title: languageMap(fb.metadata.title) || file.name.replace(/\.epub$/i, ''),
    author: contributors(fb.metadata.author) || null,
    language: lang,
    storage: 'supabase',
    epub_path: paths.epub(uid, id),
    cover_path: cover ? paths.cover(uid, id) : null,
    text_path: paths.text(uid, id),
    size_bytes: buf.byteLength,
    section_count: fb.sections.length,
    status: 'to_read',
    added_at: now,
    finished_at: null,
    updated_at: now,
    _dirty: true,
    _upload: true,
  }
  await local.put(`epub:${id}`, epub)
  if (cover) await local.put(`cover:${id}`, cover)
  await local.put(`text:${id}`, text)
  await db.put('books', book)
  syncSoon(200)
  return { book, duplicate: false }
}
