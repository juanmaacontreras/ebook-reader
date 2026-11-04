# Structure

> Moved verbatim from `CLAUDE.md` on 2026-11-04. The index that says when to read this file is `CLAUDE.md`.

## Structure

```
client/                   the app: one web codebase (TypeScript + Vite, no framework)
  src/main.ts             boot: auth gate, hash router (#/ library, #/book/<id> reader), sync triggers
  src/strings.ts          ALL UI copy (Spanish)
  src/config.ts           Supabase URL + publishable key, GitHub repo for updates
  src/settings.ts         per-device prefs (theme, font, size...), not synced
  src/styles/tokens.css   design tokens (copied from Bitácora/time-tracker) — see "Design"
  src/styles/app.css      components
  src/ui/                 dom.ts (h() builder), icons.ts (own SVG set), dialog.ts (sheets, toast, segmented)
  src/data/
    types.ts              row shapes: contract with supabase/schema.sql and tts-worker
    db.ts                 IndexedDB (offline-first local database + blob store)
    sync.ts               pull/push with Supabase + Realtime (see "Sync")
    store.ts              app operations (status, positions, highlights, narration requests)
    sessions.ts           reading sessions (time + words read/listened per device) for stats
    stats.ts              numbers for the Resumen screen, computed from the synced sessions
    places.ts             reading places compared (who is ahead, who was left behind) — see "Who moves the shared place"
    files.ts              remote file provider (Supabase Storage; Google Drive later) + local blobs
    kepubs.ts             builds missing KEPUBs in the background after a sync
  src/book/
    sentences.ts          sentence segmentation — shared by import (manifest) and reader (highlight/tap)
    manifest.ts           builds the per-book sentence manifest (CFI + text per sentence)
    importer.ts           EPUB import: hash, metadata, cover, manifest, local save → sync uploads
    kepub.ts              the book as a Kobo reads it: manifest sentences wrapped in koboSpans (see "Kobo")
    bookStyles.ts         CSS injected into the book (light/sepia/dark reading themes, fonts, spacing)
  src/audio/
    controller.ts         narration of the open book: chapters, downloads, playlist, time→sentence
    engine.ts             playback backend interface
    webEngine.ts          <audio> + Media Session (desktop/browser)
    nativeEngine.ts       bridge to the Android plugin (NarrationPlayer)
    cache.ts              this device's audio copy (files on Android, IndexedDB elsewhere)
    voices.ts             fallback voice list
  src/screens/            auth, library, reader, player, toc, highlights, narration, readingSettings, settings,
                          audios (#/audios), stats (#/stats, "Resumen")
  src/platform/           platform detection, UI theme + system bars, self-updater, keepAwake
  android/                Capacitor Android project (committed). Own native code in
                          app/src/main/java/com/atril/reader/: PlaybackService (Media3),
                          NarrationPlayerPlugin, AppUpdatePlugin, ScreenPlugin, MainActivity
  src-tauri/              Tauri desktop shell (updater + process plugins only)
  tests/                  vitest (jsdom): segmentation, CFI round trip, manifest of the sample EPUB, sessions, places
  tests/fixtures/muestra.epub   small Spanish EPUB (regenerate: tests/make_sample_epub.py)
tts-worker/               narration worker for the PC (Python 3.12, uv)
  worker/main.py          the loop (heartbeat, sweep finished books, pick chapter, generate, upload)
  worker/narrate.py       chapter → audio + sentence timings (chunk cache, QC retries)
  worker/text.py          cleanup, long-sentence splitting, chunk grouping (stdlib only, tested in CI)
  worker/asr.py           faster-whisper round trip: QC + sentence starts inside a chunk
  worker/align.py         manifest sentences ↔ Whisper words of an external narration (stdlib, tested in CI)
  import_audio.py         attach audio made elsewhere (resumidor's XTTS mp3s) to a book: transcribe, align, upload
  worker/audio.py         trimming, pauses, Ogg Opus 32 kbps mono (PyAV)
  worker/engines/         kokoro_engine.py, chatterbox_engine.py (+ registry in __init__.py)
  worker/supa.py          Supabase Auth/PostgREST/Storage client (signs in as the user)
  compare_voices.py       renders the same passages with every candidate voice
  run.sh / run.bat        one-step install + run (Linux / Windows), optional autostart
supabase/schema.sql       full schema, idempotent (tables, RLS, triggers, buckets, Realtime)
supabase/functions/kobo/  Edge Function: Atril as a Kobo's store (index.ts I/O, logic.ts pure + logic_test.ts)
tools/screenshots.py      renders the real app in headless Chromium (design proposals)
tools/kobo_e2e.py         Kobo sync end to end against the real backend (temporary account, cleaned up)
tools/sync_e2e.py         device-to-device sync timing and rules (two headless devices + a simulated Kobo), real backend
tools/e2e_common.py       shared by both: temporary account, HTTP/SQL helpers, signing the app in
.github/workflows/        build.yml (test → APK + AppImage + NSIS → Release on main), keepalive.yml
```
