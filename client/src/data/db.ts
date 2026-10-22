// Local database (IndexedDB): the app works offline from here; sync.ts mirrors
// it with Supabase. Blobs (EPUBs, covers, audio on web/desktop) go in 'files'.

const NAME = 'atril'
const VERSION = 2
export const STORES = ['books', 'positions', 'highlights', 'narrations', 'chapters', 'kv', 'files', 'sessions'] as const
export type StoreName = (typeof STORES)[number]

const KEYS: Record<StoreName, string | string[] | null> = {
  books: 'id', positions: 'book_id', highlights: 'id', narrations: 'book_id',
  chapters: ['book_id', 'voice', 'section'], kv: null, files: null, sessions: 'id',
}

let dbp: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of STORES) {
        if (db.objectStoreNames.contains(s)) continue
        const key = KEYS[s]
        const store = db.createObjectStore(s, key ? { keyPath: key } : undefined)
        if (s === 'highlights') store.createIndex('book_id', 'book_id')
        if (s === 'chapters' || s === 'sessions') store.createIndex('book_id', 'book_id')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function store(name: StoreName, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name)
}

export const db = {
  async get<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return wrap((await store(name)).get(key))
  },
  async all<T>(name: StoreName): Promise<T[]> {
    return wrap((await store(name)).getAll())
  },
  async byIndex<T>(name: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
    return wrap((await store(name)).index(index).getAll(value))
  },
  async put<T>(name: StoreName, value: T, key?: IDBValidKey): Promise<void> {
    await wrap((await store(name, 'readwrite')).put(value, key))
  },
  async putMany<T>(name: StoreName, values: T[]): Promise<void> {
    if (!values.length) return
    const tx = (await open()).transaction(name, 'readwrite')
    const s = tx.objectStore(name)
    for (const v of values) s.put(v)
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) })
  },
  async del(name: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
    await wrap((await store(name, 'readwrite')).delete(key))
  },
  async keys(name: StoreName): Promise<IDBValidKey[]> {
    return wrap((await store(name)).getAllKeys())
  },
}

export const kv = {
  get: <T>(key: string) => db.get<T>('kv', key),
  set: <T>(key: string, value: T) => db.put('kv', value, key),
}
