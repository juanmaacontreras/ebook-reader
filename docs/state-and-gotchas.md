# Current state and gotchas

> Moved verbatim from `CLAUDE.md` on 2026-11-04. The index that says when to read this file is `CLAUDE.md`.

## Current state (2026-10-21)

> Written on 2026-10-21, before any device had the app. Since then it is in daily use on
> the phone, the PC and the Kobo; what the devices confirmed is in `docs/decisions.md` and
> `docs/kobo.md`. The ⏳ marks below were not revisited one by one.

Built, not yet confirmed on a device:
- ⏳ Library (import, covers, filters), reader (themes, font, size, margins,
  spacing, paginated/scrolled), TOC, highlights + notes + panel (book / all,
  searchable), sentence-level position sync, narration player (±30 s, ±sentence,
  0.75–2×), read-along highlight, tap-to-seek, offline audio cache, Android
  background playback service, self-update on Android and desktop.
- ⏳ Worker: loop, priorities, resume, QC, upload, purge on finish, sign-in page,
  run scripts. Kokoro and Chatterbox verified on the GTX 1650 with
  `compare_voices.py` (samples in `tts-worker/samples/`, gitignored).
- ✅ Supabase project `atril` (ref `uxavtsscsgtcjxfmfwrp`, sa-east-1, free tier,
  same org as time-tracker), created 2026-10-21 through the Management API.
  Schema applied, email confirmation off (sign-up is allow-listed instead),
  allow-list = juammac@gmail.com.
- ✅ End-to-end test against the real backend (2026-10-21, headless Chromium +
  worker on the GTX 1650, temporary test account deleted afterwards): sign-up,
  import, upload, narration request → worker (Kokoro) → chapters → playback in 8
  s, read-along highlight, sentence position synced.

Not verified yet / to watch:
- Android: Java plugins compile only in CI so far; media notification buttons
  use Media3 `setMediaButtonPreferences` (1.6+ API).
- WebKitGTK (Linux desktop) playing Ogg Opus depends on GStreamer plugins
  (the AppImage bundles the media framework).
- Position push while listening with the screen off: the voice stopping (a
  native `state` event) pushes at once; meanwhile the 10 s cadence runs on
  timers a hidden WebView may slow down (Capacitor keeps timers running:
  `KeepRunning` defaults to true).
- Chatterbox's first chapter takes ~2.5× its length to generate; Kokoro ~1 min.

## App gotchas

- **Taps that did nothing (2026-10-26).** foliate-js calls `preventDefault()` on
  every `touchmove` to drag the page, which cancels the `click`: a tap with a few
  px of finger jitter was lost. The reader detects taps from touch events
  (`TAP_SLOP`/`TAP_MS` in `reader.ts`) and ignores the click that may follow.
- **Silent narration (2026-10-26, cause not confirmed on a device).** Covered:
  player errors now reach JS (`error` engine event) and a broken local chapter is
  deleted and downloaded again once; a toast warns when the media volume is 0 and
  the volume keys always control media volume (`MainActivity`); leaving and
  reopening a book no longer lets the old engine's release stop the new playlist
  (`releasing` in `controller.ts`); a start that finishes after the book was
  closed doesn't play.

## Worker gotchas (learned the hard way)

- **GPU out of memory, 2026-10-22, ~3 h lost overnight.** Two causes stacked:
  (1) worker processes left running by an integration test (they held VRAM): kill
  test workers when a test ends, always; (2) one chunk whose decoder working set
  didn't fit the 4 GB GTX 1650 even on an empty GPU. Now: on OOM a chunk is split
  in halves (`narrate._synth_or_split`), and an OOM that still escapes reloads the
  model instead of retrying in the same process state; the service sets
  `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`.
- Chatterbox's real speed on long chapters was ~0.3× real time (≈1.4 h per
  ~25k-character chapter), a bit slower than the 0.4× of the short samples.
