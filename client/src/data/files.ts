// Book files: a remote provider (where the library lives) and the local cache
// (where this device keeps its copy).
//
// Remote: Supabase Storage today. books.storage says which provider holds a
// book's files, so moving EPUBs to Google Drive later means adding a provider
// here and a migration that rewrites books.storage/epub_path — the rest of the
// app only talks to `remote(book)`.

import { supabase } from './supabase'
import { db } from './db'
import type { Book } from './types'

export interface RemoteFiles {
  upload(path: string, blob: Blob, contentType: string): Promise<void>
  download(path: string, onProgress?: (fraction: number) => void): Promise<Blob>
  signedUrl(path: string, seconds?: number): Promise<string>
  remove(paths: string[]): Promise<void>
  removeFolder(prefix: string): Promise<void>
}

function supabaseBucket(bucket: string): RemoteFiles {
  const api = () => supabase.storage.from(bucket)
  return {
    async upload(path, blob, contentType) {
      const { error } = await api().upload(path, blob, { contentType, upsert: true })
      if (error) throw error
    },
    async download(path, onProgress) {
      // Signed URL + fetch instead of storage.download() to report progress.
      const url = await this.signedUrl(path)
      return fetchWithProgress(url, onProgress)
    },
    async signedUrl(path, seconds = 3600) {
      const { data, error } = await api().createSignedUrl(path, seconds)
      if (error || !data) throw error ?? new Error('no signed url')
      return data.signedUrl
    },
    async remove(paths) {
      if (!paths.length) return
      const { error } = await api().remove(paths)
      if (error) throw error
    },
    // Everything under prefix, subfolders included (Storage lists one level at a
    // time; a folder is an entry without id).
    async removeFolder(prefix) {
      const { data, error } = await api().list(prefix, { limit: 1000 })
      if (error) throw error
      const files: string[] = []
      for (const e of data ?? []) {
        if (e.id) files.push(`${prefix}/${e.name}`)
        else await this.removeFolder(`${prefix}/${e.name}`)
      }
      await this.remove(files)
    },
  }
}

export const library = supabaseBucket('library')
export const audioBucket = supabaseBucket('audio')

export function remote(book: Pick<Book, 'storage'>): RemoteFiles {
  if (book.storage === 'supabase') return library
  throw new Error(`storage provider not available: ${book.storage}`)
}

export async function fetchWithProgress(url: string, onProgress?: (f: number) => void): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (!onProgress || !total) return res.blob()
  const reader = res.body.getReader()
  const parts: BlobPart[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    got += value.length
    onProgress(got / total)
  }
  return new Blob(parts, { type: res.headers.get('content-type') ?? '' })
}

// Local blob cache (IndexedDB). Keys: epub:<book>, cover:<book>, audio:<book>:<voice>:<section>
export const local = {
  get: (key: string) => db.get<Blob>('files', key),
  put: (key: string, blob: Blob) => db.put('files', blob, key),
  del: (key: string) => db.del('files', key),
  async has(key: string) { return (await db.get('files', key)) !== undefined },
  async keysWithPrefix(prefix: string) {
    return (await db.keys('files')).map(String).filter(k => k.startsWith(prefix))
  },
}

export const paths = {
  epub: (uid: string, book: string) => `${uid}/${book}/book.epub`,
  cover: (uid: string, book: string) => `${uid}/${book}/cover.jpg`,
  text: (uid: string, book: string) => `${uid}/${book}/text.json.gz`,
}
