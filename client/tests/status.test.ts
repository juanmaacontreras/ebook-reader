import { beforeEach, expect, it, vi } from 'vitest'

// The local database, the sync and the book's text, in memory.
const rows = new Map<string, Record<string, unknown>>()
const key = (store: string, row: Record<string, unknown>) => `${store}:${(row.id ?? row.book_id) as string}`
vi.mock('../src/data/db', () => ({
  db: {
    get: async (store: string, id: string) => rows.get(`${store}:${id}`),
    put: async (store: string, row: Record<string, unknown>) => { rows.set(key(store, row), row) },
  },
  kv: { get: async () => 'phone1', set: async () => {} },
}))
vi.mock('../src/data/sync', () => ({
  emit: () => {}, forgetBook: async () => {}, localWrite: (p: Promise<void>) => p, pullPosition: async () => false, pushSoon: () => {},
}))
// A cover (no text), then the first chapter.
let manifest: unknown = {
  v: 1, lang: 'es',
  sections: [{ i: 0, label: '', sentences: [] }, { i: 1, label: 'Uno', sentences: [{ c: 'epubcfi(/6/4!/4/2/1:0)', t: 'Había una vez.' }, { c: 'b', t: 'Otra.' }] }],
}
vi.mock('../src/data/files', () => ({ audioBucket: {}, local: {}, loadManifest: async () => manifest }))
vi.mock('../src/data/supabase', () => ({ demo: true, supabase: {} }))
vi.mock('../src/platform', () => ({ audioManager: true }))

const { books } = await import('../src/data/store')

const book = { id: 'b1', title: 'T', author: null, language: 'es', status: 'reading', added_at: '2026-10-01T00:00:00Z', finished_at: null, updated_at: '2026-11-01T00:00:00Z', storage: 'supabase' }
const midway = { book_id: 'b1', cfi: 'epubcfi(/6/12!/4/80/1:0)', section: 5, sentence: 39, fraction: 0.42, device: 'kobo:1', updated_at: '2026-11-02T10:00:00Z' }

beforeEach(() => {
  rows.clear()
  rows.set('books:b1', { ...book })
  rows.set('positions:b1', { ...midway })
})

it('"Por leer" takes the shared place back to the first sentence of text', async () => {
  await books.setStatus('b1', 'to_read')
  expect(rows.get('books:b1')).toMatchObject({ status: 'to_read', finished_at: null, _dirty: true })
  // A decision, not a page turned: no base, so it goes over another device's newer place.
  expect(rows.get('positions:b1')).toMatchObject({
    section: 1, sentence: 0, cfi: 'epubcfi(/6/4!/4/2/1:0)', fraction: 0, base: null, device: 'phone1', _dirty: true,
  })
})

it('finishing or reading leaves the place where it was', async () => {
  await books.setStatus('b1', 'finished')
  expect(rows.get('positions:b1')).toEqual(midway)
  rows.set('books:b1', { ...book, status: 'to_read' })
  await books.setStatus('b1', 'reading')
  expect(rows.get('positions:b1')).toEqual(midway)
})

it('without the book\'s text here, only the status changes', async () => {
  const saved = manifest
  manifest = null
  await books.setStatus('b1', 'to_read')
  manifest = saved
  expect(rows.get('books:b1')).toMatchObject({ status: 'to_read' })
  expect(rows.get('positions:b1')).toEqual(midway)
})
