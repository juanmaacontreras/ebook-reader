// Links from other apps (the brain app first): atril://book?sha256=<hex>[&listen=1]
//
// The book is named by the SHA-256 of its EPUB file, the same hash the importer
// stores in books.sha256 and Google Drive reports as sha256Checksum. That keeps
// the contract to a URL: no app reads another's database. Opening a book from a
// link is "opening the book", which never moves the shared place (see "Who moves
// the shared place"); listen=1 then does what the library's Escuchar does.
//
// Contract fixture, also tested in cerebro-app (tests/atril.test.ts):
//   atril://book?sha256=<64 lowercase hex>&listen=1

import { db } from '../data/db'
import { sync } from '../data/sync'
import type { Book } from '../data/types'

export interface BookLink { sha256: string; listen: boolean }

export function parseBookLink(url: string): BookLink | null {
  // Parsed by hand, not with URL: older Android WebViews put a custom scheme's
  // host in the path, newer ones in `host`.
  const m = /^atril:\/\/book\/?\?(.*)$/i.exec(url.trim())
  if (!m) return null
  const q = new URLSearchParams(m[1])
  const sha256 = (q.get('sha256') ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null
  return { sha256, listen: q.get('listen') === '1' }
}

async function findBySha(sha256: string): Promise<Book | undefined> {
  return (await db.all<Book>('books')).find(b => b.sha256 === sha256)
}

/** The book a link names, pulling once if this device hasn't seen it yet. */
export async function resolveBookLink(link: BookLink): Promise<Book | undefined> {
  const here = await findBySha(link.sha256)
  if (here) return here
  try { await sync() } catch { /* offline: answer with what is here */ }
  return findBySha(link.sha256)
}
