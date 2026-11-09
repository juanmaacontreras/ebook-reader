// Runs tools/*.tool.ts (headless book tools) in the same jsdom the tests use, so a manifest
// built here is the one the app builds at import. See tools/analyze.tool.ts.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'jsdom', include: ['tools/*.tool.ts'], testTimeout: 600_000 },
})
