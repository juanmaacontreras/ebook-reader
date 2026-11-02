// KEPUBs for the Kobo (book/kepub.ts), built in the background after a sync by
// a device that has the book: any device with its EPUB stored locally, and the
// desktop app also for books it has to download first (so the library already
// imported gets them too). Each is uploaded next to the EPUB with its map
// (kepub.json); then books.kepub_path is set, which is what offers the book to
// the Kobo (supabase/functions/kobo). kepub_path is never pushed from a device's
// copy of the row (sync.ts, NOT_PUSHED): only this direct update writes it, and
// it leaves updated_at alone, so it can't win or lose a LWW race.

import { audioManager } from '../platform'
import { db } from './db'
import { library, local, paths, remote } from './files'
import { supabase } from './supabase'
import type { Book, Local, Manifest } from './types'

let busy = false
const refused = new Set<string>()  // this session: segmentation didn't match the manifest

export async function buildPendingKepubs(uid: string): Promise<void> {
  if (busy) return
  busy = true
  try {
    const books = (await db.all<Local<Book> & { _upload?: boolean }>('books'))
      .filter(b => !b.kepub_path && !b._upload && b.text_path && b.storage === 'supabase' && !refused.has(b.id))
    if (!books.length) return
    const { makeBook } = await import('foliate-js/view.js')
    const { buildKepub } = await import('../book/kepub')
    const { gunzipJson } = await import('../book/manifest')
    for (const b of books) {
      try {
        let epub = await local.get(`epub:${b.id}`)
        if (!epub) {
          if (!audioManager) continue
          epub = await remote(b).download(b.epub_path)
        }
        const text = (await local.get(`text:${b.id}`)) ?? await remote(b).download(b.text_path!)
        const manifest = await gunzipJson<Manifest>(text)
        const file = new File([epub], 'book.epub', { type: 'application/epub+zip' })
        const built = await buildKepub(file, await makeBook(file), manifest)
        if (!built) {
          refused.add(b.id)
          console.warn('kepub: sentences differ from the manifest, not built', b.id)
          continue
        }
        const path = paths.kepub(uid, b.id)
        await library.upload(path, built.kepub, 'application/epub+zip')
        await library.upload(paths.kepubMap(uid, b.id), new Blob([JSON.stringify(built.map)]), 'application/json')
        const { error } = await supabase.from('books').update({ kepub_path: path }).eq('id', b.id)
        if (error) throw error
        const current = await db.get<Local<Book>>('books', b.id)
        if (current) await db.put('books', { ...current, kepub_path: path })
      } catch (e) {
        // Offline, or the book was removed meanwhile: the next sync tries again.
        console.warn('kepub: failed', b.id, e)
      }
    }
  } finally {
    busy = false
  }
}
