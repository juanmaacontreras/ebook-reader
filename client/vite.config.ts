import { defineConfig, type Plugin } from 'vitest/config'

// foliate-js can open PDFs, comics, FB2 and MOBI too; this app reads EPUB only.
// The PDF reader alone is 400 kB, so its import resolves to an empty module.
function dropFoliatePdf(): Plugin {
  return {
    name: 'drop-foliate-pdf',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './pdf.js' && importer?.includes('foliate-js')) return '\0foliate-pdf-stub'
    },
    load(id) {
      if (id === '\0foliate-pdf-stub') return 'export const makePDF = () => { throw new Error("PDF not supported") }'
    },
  }
}

export default defineConfig({
  // Relative asset paths: the same build is loaded from Capacitor's
  // https://localhost, Tauri's custom protocol and a plain static server.
  base: './',
  plugins: [dropFoliatePdf()],
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? '0') },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 2000 },
  server: { port: 5173, strictPort: true },
  test: { environment: 'jsdom' },
})
