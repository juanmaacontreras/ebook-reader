import { describe, expect, it } from 'vitest'
import { parseBookLink } from '../src/platform/links'

// The contract with cerebro-app (its tests/atril.test.ts builds this same URL).
const SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'

describe('book links', () => {
  it('reads the contract fixture', () => {
    expect(parseBookLink(`atril://book?sha256=${SHA}&listen=1`)).toEqual({ sha256: SHA, listen: true })
    expect(parseBookLink(`atril://book?sha256=${SHA}`)).toEqual({ sha256: SHA, listen: false })
  })

  it('accepts a trailing slash and upper-case hex', () => {
    expect(parseBookLink(`atril://book/?sha256=${SHA.toUpperCase()}`)?.sha256).toBe(SHA)
  })

  it('refuses anything else', () => {
    expect(parseBookLink('https://example.com/?sha256=' + SHA)).toBeNull()
    expect(parseBookLink(`atril://shelf?sha256=${SHA}`)).toBeNull()
    expect(parseBookLink('atril://book?sha256=abc')).toBeNull()
    expect(parseBookLink('atril://book')).toBeNull()
    expect(parseBookLink('not a url')).toBeNull()
  })
})
