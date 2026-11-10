// Headless half of "publish a book" (tts-worker/publish_book.py): reads an EPUB and writes what
// the app's importer would (sentence manifest, cover, metadata). For a book replaced in place it
// also carries the reading place and the highlights over by their text (book/remap.ts).
// Run: ATRIL_JOB=job.json node node_modules/vitest/vitest.mjs run --config tools/vitest.config.ts
//   job.json: { epub, out, old?: { manifest (gz path), position?: Place, highlights?: [{id,text,section}] } }
//   out/: text.json.gz, cover.<ext>, book.kepub.epub + kepub.json (the book as a Kobo reads it,
//         meta.kepub says whether they were built), result.json { meta, position, highlights, changed }
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { unzipSync } from 'fflate'
import { expect, test } from 'vitest'
import * as CFI from 'foliate-js/epubcfi.js'
import { bookLanguage, contributors, languageMap } from '../src/book/importer'
import { buildKepub } from '../src/book/kepub'
import { buildManifest } from '../src/book/manifest'
import { changedSections, findText, remapPlace, type Place } from '../src/book/remap'
import type { Manifest } from '../src/data/types'

interface Job {
  epub: string
  out: string
  old?: { manifest: string; position?: Place | null; highlights?: { id: string; text: string; section: number | null }[] }
}

test('analyze', async () => {
  const jobPath = process.env.ATRIL_JOB
  expect(jobPath, 'ATRIL_JOB not set').toBeTruthy()
  const job = JSON.parse(readFileSync(jobPath!, 'utf8')) as Job
  mkdirSync(job.out, { recursive: true })
  const raw = readFileSync(job.epub)
  const { makeBook } = await import('foliate-js/view.js')
  const fb = await makeBook(new File([raw], 'book.epub', { type: 'application/epub+zip' }))
  const lang = bookLanguage(fb)
  const manifest = await buildManifest(fb, lang.split('-')[0])
  writeFileSync(join(job.out, 'text.json.gz'), gzipSync(JSON.stringify(manifest)))  // jsdom's Blob has no streams
  // The cover straight from the archive, at the href foliate picks (getCover's Blob mixes
  // Node's and jsdom's Blob classes here and reads back as the text "[object Blob]").
  const res = (fb as unknown as { resources?: { cover?: { href: string; mediaType: string } } }).resources
  let coverType: string | null = null
  const cover = res?.cover?.href ? unzipSync(new Uint8Array(raw), { filter: f => f.name === res.cover!.href })[res.cover.href] : null
  if (cover?.length) {
    coverType = res!.cover!.mediaType || 'image/jpeg'
    writeFileSync(join(job.out, 'cover'), cover)
  }
  // The KEPUB too, so the book reaches the Kobo (and stays on it when replaced) without waiting
  // for a device to build it (data/kepubs.ts). A fresh book: buildKepub edits its documents.
  const file = new File([raw], 'book.epub', { type: 'application/epub+zip' })
  const built = await buildKepub(file, await makeBook(file), manifest)
  if (built) {
    writeFileSync(join(job.out, 'book.kepub.epub'), new Uint8Array(await built.kepub.arrayBuffer()))
    writeFileSync(join(job.out, 'kepub.json'), JSON.stringify(built.map))
  }
  const result: Record<string, unknown> = {
    meta: {
      sha256: createHash('sha256').update(raw).digest('hex'),
      title: languageMap(fb.metadata.title),
      author: contributors(fb.metadata.author) || null,
      language: lang,
      size_bytes: raw.byteLength,
      section_count: fb.sections.length,
      cover_type: coverType,
      kepub: !!built,
    },
  }
  if (job.old) {
    const oldM = JSON.parse(gunzipSync(readFileSync(job.old.manifest)).toString('utf8')) as Manifest
    result.changed = changedSections(oldM, manifest)
    result.position = job.old.position ? remapPlace(oldM, manifest, job.old.position) : null
    const labels = new Map(manifest.sections.map(s => [s.i, s.label]))
    const docs = new Map<number, Document>()
    const doc = async (i: number) => {
      if (!docs.has(i)) docs.set(i, await fb.sections[i].createDocument!())
      return docs.get(i)!
    }
    const order = (from: number | null) => manifest.sections.map(s => s.i)
      .sort((a, b) => Math.abs(a - (from ?? 0)) - Math.abs(b - (from ?? 0)))
    result.highlights = []
    for (const h of job.old.highlights ?? []) {
      let found = null
      for (const i of order(h.section)) {
        const r = findText(await doc(i), h.text)
        if (!r) continue
        const base = fb.sections[i].cfi ?? CFI.fake.fromIndex(i)
        found = { id: h.id, cfi: CFI.joinIndir(base, CFI.fromRange(r)), section: i, chapter: labels.get(i) ?? null }
        break
      }
      ;(result.highlights as unknown[]).push(found ?? { id: h.id, lost: true })
    }
  }
  writeFileSync(join(job.out, 'result.json'), JSON.stringify(result))
})
