// This device's copy of a book's narration. Audio is downloaded once per
// device and played locally — never streamed — to protect the 5 GB/month
// egress of the free tier. On Android chapters are files (the native player
// needs a path); elsewhere they are blobs in IndexedDB.

import { Directory, Filesystem } from '@capacitor/filesystem'
import { FileTransfer } from '@capacitor/file-transfer'
import { db } from '../data/db'
import { audioBucket, fetchWithProgress, local } from '../data/files'
import { fetchChapterTimings } from '../data/sync'
import type { NarrationChapter, Timing } from '../data/types'
import { isAndroid } from '../platform'

type Chapter = NarrationChapter & { cached?: boolean; timings?: Timing[] }

const slug = (voice: string) => voice.replace(/[^a-z0-9_-]+/gi, '_')
const fileKey = (c: Pick<NarrationChapter, 'book_id' | 'voice' | 'section'>) => `audio:${c.book_id}:${slug(c.voice)}:${c.section}`
const filePath = (c: Pick<NarrationChapter, 'book_id' | 'voice' | 'section'>) => `audio/${c.book_id}/${slug(c.voice)}/${c.section}.opus`

export function isCached(c: Chapter): boolean {
  return Boolean(c.cached && c.timings)
}

async function markCached(c: Chapter, timings: Timing[]): Promise<void> {
  const cur = await db.get<Chapter>('chapters', [c.book_id, c.voice, c.section])
  await db.put('chapters', { ...(cur ?? c), cached: true, timings })
}

// Downloads (if needed) and returns what the player needs.
export async function ensureChapter(c: Chapter, onProgress?: (f: number) => void): Promise<{ src: string; timings: Timing[] }> {
  const cur = (await db.get<Chapter>('chapters', [c.book_id, c.voice, c.section])) ?? c
  if (isCached(cur)) {
    const src = await localSrc(cur)
    if (src) return { src, timings: cur.timings! }
  }
  const timings = cur.timings ?? (await fetchChapterTimings(c))
  const url = await audioBucket.signedUrl(c.audio_path)
  if (isAndroid) {
    const { uri } = await Filesystem.getUri({ directory: Directory.Data, path: filePath(c) })
    await Filesystem.mkdir({ directory: Directory.Data, path: filePath(c).replace(/\/[^/]+$/, ''), recursive: true }).catch(() => {})
    const handle = onProgress
      ? await FileTransfer.addListener('progress', p => { if (p.contentLength) onProgress(p.bytes / p.contentLength) })
      : null
    try {
      await FileTransfer.downloadFile({ url, path: uri, progress: Boolean(onProgress) })
    } finally {
      await handle?.remove()
    }
  } else {
    const blob = await fetchWithProgress(url, onProgress)
    await local.put(fileKey(c), new Blob([blob], { type: 'audio/ogg' }))
  }
  await markCached(cur, timings)
  return { src: (await localSrc(cur))!, timings }
}

async function localSrc(c: Chapter): Promise<string | null> {
  if (isAndroid) {
    try {
      const { uri } = await Filesystem.getUri({ directory: Directory.Data, path: filePath(c) })
      await Filesystem.stat({ path: uri })
      return uri
    } catch { return null }
  }
  const blob = await local.get(fileKey(c))
  return blob ? URL.createObjectURL(blob) : null
}

// The web engine resolves sources lazily: one object URL at a time.
export const lazySrc = (c: Pick<NarrationChapter, 'book_id' | 'voice' | 'section'>) => `lazy:${fileKey(c)}`
export async function resolveLazy(src: string): Promise<string> {
  if (!src.startsWith('lazy:')) return src
  const blob = await local.get(src.slice(5))
  if (!blob) throw new Error('audio not cached')
  return URL.createObjectURL(blob)
}

export async function deleteBookAudio(bookId: string): Promise<void> {
  const chapters = await db.byIndex<Chapter>('chapters', 'book_id', bookId)
  for (const c of chapters) {
    if (!c.cached) continue
    if (isAndroid) await Filesystem.deleteFile({ directory: Directory.Data, path: filePath(c) }).catch(() => {})
    else await local.del(fileKey(c))
    await db.put('chapters', { ...c, cached: false })
  }
  if (isAndroid) await Filesystem.rmdir({ directory: Directory.Data, path: `audio/${bookId}`, recursive: true }).catch(() => {})
}

export async function cachedCount(bookId: string, voice: string): Promise<number> {
  return (await db.byIndex<Chapter>('chapters', 'book_id', bookId)).filter(c => c.voice === voice && c.cached).length
}
