# Atril — project state

Personal EPUB reader for Android (Xiaomi phone, Samsung Galaxy Tab S10 FE) and
desktop (Arch Linux, Windows) that also narrates books like an audiobook, with
read-along highlighting. Library, reading position (to the sentence),
highlights/notes and audio state sync across devices through Supabase (free
tier). Narration is generated on the user's PC GPU by `tts-worker/`. Everything
is free: no paid APIs.

The user (Juanma) does not write code or run commands: Claude makes the
technical decisions and does all the work, including running things. If
something can't be done from the session, say so plainly instead of handing
over a command. The user does all on-device testing.

## Language rules

- Code, comments, configs, docs, commit messages: **English**.
- App UI text: **Spanish, Rioplatense ("vos")**, all of it in
  `client/src/strings.ts` (one place, easy to adjust). Same for the worker's
  user-facing strings (its sign-in page, error messages shown in the app).

## Working rules

- **Design changes: proposals first, code after.** Before implementing any
  visual change, render 2–3 variants of the real app as screenshots
  (`tools/screenshots.py`, see "Screenshots") and wait for the user to pick.
- **Don't leave unused software installed.** Tools needed only for a session
  (Node, Playwright, Chromium, Android SDK) go in the session scratchpad, not
  in the system. If a dependency is tried and dropped, remove it right away.
- Releases come from `main` only. Work on a branch, let CI build, merge.
- Never put secrets in the repo. The Supabase URL and publishable key in
  `client/src/config.ts` are public by design (RLS + allow-listed sign-up).

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
    files.ts              remote file provider (Supabase Storage; Google Drive later) + local blobs
  src/book/
    sentences.ts          sentence segmentation — shared by import (manifest) and reader (highlight/tap)
    manifest.ts           builds the per-book sentence manifest (CFI + text per sentence)
    importer.ts           EPUB import: hash, metadata, cover, manifest, local save → sync uploads
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
  tests/                  vitest (jsdom): segmentation, CFI round trip, manifest of the sample EPUB, sessions
  tests/fixtures/muestra.epub   small Spanish EPUB (regenerate: tests/make_sample_epub.py)
tts-worker/               narration worker for the PC (Python 3.12, uv)
  worker/main.py          the loop (heartbeat, sweep finished books, pick chapter, generate, upload)
  worker/narrate.py       chapter → audio + sentence timings (chunk cache, QC retries)
  worker/text.py          cleanup, long-sentence splitting, chunk grouping (stdlib only, tested in CI)
  worker/asr.py           faster-whisper round trip: QC + sentence starts inside a chunk
  worker/audio.py         trimming, pauses, Ogg Opus 32 kbps mono (PyAV)
  worker/engines/         kokoro_engine.py, chatterbox_engine.py (+ registry in __init__.py)
  worker/supa.py          Supabase Auth/PostgREST/Storage client (signs in as the user)
  compare_voices.py       renders the same passages with every candidate voice
  run.sh / run.bat        one-step install + run (Linux / Windows), optional autostart
supabase/schema.sql       full schema, idempotent (tables, RLS, triggers, buckets, Realtime)
tools/screenshots.py      renders the real app in headless Chromium (design proposals)
.github/workflows/        build.yml (test → APK + AppImage + NSIS → Release on main), keepalive.yml
```

## Architecture decisions

**EPUB renderer: foliate-js** (pinned commit in `client/package.json`), not
epub.js. epub.js's last release is from 2020 and it has long-standing
pagination/CFI bugs; foliate-js is actively maintained (it powers the Foliate
app), renders in a closed shadow DOM with iframes, has paginated and scrolled
modes, a correct EPUB CFI implementation (`epubcfi.js`), an overlay layer for
highlights (`overlayer.js`) and works on a parsed section without rendering it
(`section.createDocument()`), which the manifest builder needs. It ships as
plain ES modules (no npm release), typed locally in `client/src/foliate.d.ts`.
Its PDF reader is stubbed out in `vite.config.ts` (400 kB, EPUB only here).

**Sentence manifest = the single source of sentence identity.** At import the
app segments every spine section (`book/sentences.ts`: block-level grouping +
`Intl.Segmenter` sentence granularity, footnotes/noterefs skipped) and stores
`text.json.gz` in Storage: `{v, lang, sections: [{i, label, sentences: [{c: CFI,
t: text, b: block, h?: heading}]}]}`. The worker narrates exactly that list and
writes timings indexed by sentence. The reader re-runs the same segmentation on
the rendered section, so sentence N there is sentence N in the manifest — no
CFI computation in Python. Changing segmentation rules shifts indices: bump
`MANIFEST_VERSION` and rebuild manifests.

**Reading position = CFI of a sentence**, stored with section and sentence
index. While reading, it's the first sentence on the visible page; while
listening, the sentence being spoken. Switching modes never loses it, and
another device opens at the same sentence (or offers "Ir" if the book is
already open).

**Sync (client/src/data/sync.ts).** Offline-first: every change goes to
IndexedDB with `_dirty`, then is pushed. Pull is incremental by the
server-side `synced_at` (set by trigger), never by client clocks — an edit made
offline arrives later with an old `updated_at`. Conflicts: last writer wins by
client `updated_at`, enforced on the server by the `lww_guard` trigger (an
older UPDATE is silently dropped). Realtime (postgres_changes on all tables)
triggers an incremental pull within ~1 s; also on focus, on reconnect, every 5
min. Deleted chapters are learned from `deleted_chapters` (a pull can't see a
deleted row). Books imported offline keep `_upload` until their files are in
Storage.

**Narration rows have two owners** (`narrations`): the app owns `voice`,
`status` (active/paused), `start_section`, `priority_section`, `updated_at`;
the worker owns `state` (waiting/generating/ready/error/purged),
`current_section`, `error` and never touches `updated_at`. The app never
pushes worker columns (`WORKER_FIELDS` in sync.ts). Without this split a
worker status update could win a LWW race and drop a user's "jump to this
chapter" request.

**Worker credentials: the user's own account.** The worker signs in with the
same email/password as the app (local page at http://127.0.0.1:8765 on first
run), keeps only the rotating refresh token in `tts-worker/.session.json`
(gitignored) and goes through RLS like any device. There is no service-role
key anywhere.

**Audio pipeline.** Chapter by chapter, starting where the user is; a chapter
the user jumps to (`priority_section`) goes next; checked every ~20 s during
generation, switching keeps finished chunks in `work/chunks` (resumable after a
power cut too: a chapter counts as done only when its `narration_chapters` row
exists). Output: Ogg Opus 32 kbps mono, 24 kHz (~14 MB/h). Sentence map per
chapter in `narration_chapters.timings` (`[{i, cfi, s, e}]`), downloaded with the
audio, not on every pull. Pauses are the worker's: 0.32 s between sentences,
0.65 s between paragraphs, 0.9 s around headings (model silences trimmed).

**Engines** (ids `<engine>:<voice>` everywhere):
- `kokoro:*` — Kokoro-82M, fast default (~23× real time on the GTX 1650,
  0.7 GB VRAM). One sentence per synthesis → exact timings. Spanish:
  ef_dora, em_alex, em_santa; English: af_heart, af_bella, am_michael, bf_emma,
  bm_george, ... Non-English text goes through espeak and is truncated past 510
  phonemes, hence `max_chars=300` splitting.
- `chatterbox-v3:<ref>` / `chatterbox-latam:<ref>` — Resemble AI Chatterbox
  Multilingual V3 (MIT) and its Latin-American Spanish finetune, cloning
  `voices/<ref>.wav`. Installed from a pinned GitHub commit (PyPI 0.1.7 predates
  V3). On the 4 GB GTX 1650 the T3 model runs in fp16 with autocast (fp32 does
  not fit next to the desktop: OOM measured); the decoder stays fp32. ~0.4× real
  time (≈2.5 h of GPU per hour of audio), 2.6 GB VRAM. Chunks of ~190 chars
  (DP grouping in `text.py`), each checked by a Whisper round trip (accept ≥
  0.80, up to 4 takes with falling temperature, stop early when scores are
  stable = recognizer bias, not babbling) — lessons carried over from
  resumidor's XTTS pipeline. Sentence starts inside a chunk come from Whisper
  word timestamps.
- Rioplatense references are generated by `compare_voices.py` with edge-tts
  (es-AR-TomasNeural / ElenaNeural): the cloning model keeps its own prosody and
  takes the accent from the clip. Any clean 10–20 s recording dropped in
  `voices/<name>.wav` becomes a voice (the app lists what the worker reports in
  `worker_status.voices`).

**Storage budget (free tier: 1 GB files, 5 GB egress/month).** EPUBs are never
deleted. Audio of a book is deleted from Storage when it's marked finished
(app does it immediately; the worker sweeps too) and can be regenerated. The
worker refuses to generate past `MAX_AUDIO_MB` (700 MB default). Devices
download each chapter once and play locally — never stream. Keep-alive: the
project pauses after 7 idle days, `keepalive.yml` pings `rpc/ping` every 3
days. To move EPUBs to Google Drive later: add a provider in
`client/src/data/files.ts` (`remote(book)` switches on `books.storage`) and a
migration rewriting `storage`/`epub_path`.

**Android background playback**: Media3 `MediaSessionService` + ExoPlayer
(`PlaybackService.java`) with the chapter playlist; foreground service while
playing, media notification with −30 s / play / +30 s, headphone and
Bluetooth buttons, pauses when headphones are unplugged. JS polls state at 4 Hz
for the highlight; chapter changes happen natively even with the WebView
asleep. Edge to edge (`EdgeToEdge.enable` + Capacitor SystemBars
`insetsHandling: css`): system bars are transparent over the paper color.

**Updates** (same pattern as time-tracker): CI release `v<N>`, N = commit
count = Android versionCode = desktop version `0.1.N`. Android: the app reads
the latest release, downloads the APK and opens the system installer
(`AppUpdatePlugin`). Desktop: Tauri updater with `latest.json` from the
release (signed; key in GitHub secret `TAURI_SIGNING_PRIVATE_KEY`, public key
in `tauri.conf.json`). APK signing key: secrets `ANDROID_KEYSTORE_B64` +
`ANDROID_KEYSTORE_PASSWORD` (PKCS12, alias `atril`). Losing either key means
updates stop installing over old versions.

## Design

Same family as Bitácora (time-tracker/web/index.html). Tokens in
`client/src/styles/tokens.css`: Nord light "Snow Storm" / dark "Polar Night",
system + manual override (`data-theme` on `<html>`), soft tints via
`color-mix` (accent ~13% over card), radii 22/16/12 px, dialogs 28 px,
borderless surfaces (paper < card, surface2 for tracks/fields), segmented
controls with a raised active option, system font 15 px, 800-weight titles
with negative letter-spacing, tabular numerals for times, rounded minimal
icons (`ui/icons.ts`), system bars = paper color. Dialogs are centered on wide
screens and bottom sheets on phones. The reading surface has its own themes
(light / sepia / dark / auto) in `book/bookStyles.ts`. Highlight colors:
`--hl-*` (yellow, green, blue, orange, purple), keys stored in the DB.

## How to run / verify

- Session tools go in the scratchpad: Node (nodejs.org tarball), Playwright +
  Chromium (`uv venv`, `PLAYWRIGHT_BROWSERS_PATH`). Nothing global.
- `cd client && npm ci && npm test && npm run typecheck && npm run build`.
- `npm run dev`, then `http://localhost:5173/?demo` runs the app locally with
  no account and no sync (local only) — used for screenshots.
- **Screenshots**: `python tools/screenshots.py OUT_DIR` with Playwright, while
  `npm run dev` runs. Phone 400×860 and tablet 1280×800, light and dark.
  `--variant NAME` passes `?variant=NAME` for design proposals.
- Worker: `cd tts-worker && uv sync && uv run compare_voices.py` (GPU PC only;
  cloud sessions have no GPU and may not reach Hugging Face).
  `python -m unittest discover -s tests` runs anywhere (stdlib only).
- Android/desktop builds: CI. Locally only if needed, with SDK/Rust in the
  scratchpad.

## User decisions

- 2026-10-21: library layout C ("keep reading" card on top, grid below), chosen
  over a plain cover grid and a list. Default voices: Spanish
  `chatterbox-latam:ar_elena`, English `kokoro:af_heart`
  (`client/src/audio/voices.ts`). Round 2 (same day): Elena with
  exaggeration 0.5 / cfg_weight 0.25 ("más pausada") won over more expressive,
  calmer, and XTTS-v2 (Elena or resumidor's reference; XTTS was ~7× faster but
  not chosen, so it is not an engine here). Chatterbox defaults are now 0.5/0.25.

- 2026-10-22: added "Bajar todo el audio" (narration sheet) and "Generar audio
  solo" (setting, default on: a book that becomes "reading" gets a narration
  request with the default voice, only after a successful pull). Voice list:
  short by default (default + fast + current), the rest behind "Más voces";
  Spanish clips are offered only on the LatAm model. Books can be renamed
  (book menu → "Editar título y autor"). Covers: real proportions (no crop) and,
  on phones, the keep-reading card stacked with a large cover (option B, picked
  over A = bigger side-by-side cover and C = fixed tiles with blurred fill).

- 2026-10-22: audio management, user's call ("confío en tu criterio") on my
  proposal: (1) opening a book no longer makes it "reading": that takes 4 pages
  or 2 minutes, or starting audio; (2) narrations have a `scope`: 'ahead'
  (automatic: the worker keeps the current chapter + 2 ready from the synced
  position, `AHEAD_CHAPTERS`) or 'all' (the sheet's "Generar todo el libro");
  (3) an "Audios" screen (`screens/audios.ts`, route `#/audios`): PC status,
  cloud usage vs 700 MB, every narration with pause/resume, generate all, move
  up the queue (`putFirst` = oldest requested_at), delete audio (cloud + device,
  row kept paused so auto-narration doesn't recreate it). Design: option B (grouped
  by state, the book being generated on top), picked over a list of cards and a
  compact list; opened from the headphones button in the library header.

- 2026-10-22: **audio is requested and managed only from the desktop app.**
  `audioManager` (`platform/index.ts`) is false on Android: no voice choice, no
  generate / generate all / pause / resume, no automatic narration (setting
  hidden), and playing a chapter without audio never prioritizes it — it says
  "Pedilo desde la PC". Phones keep: listening, "Bajar todo el audio", deleting
  this device's copy, and the Audios screen as read-only (tap opens the book).
  Finishing a book no longer deletes audio from the app: the worker deletes it
  `PURGE_AFTER_HOURS` (24) after `finished_at`, so a mistaken "terminado" can be
  undone, and every device drops its local copy when the chapters disappear
  (`deleted_chapters` → `deleteLocalChapter`). Note: an 'ahead' narration started
  from the PC follows the synced reading position, including reading on the
  phone. A chapter without audio on the phone: a toast and the player closes (option B,
  picked over a warning in the player and a notice replacing the controls).
  Preview the phone UI in a browser with `?demo&as=phone`.

- 2026-10-22: speed control = a sheet with −/+ in 0.05 steps, a 0.5–2.5× slider
  and presets (option B, over a preset grid and an inline stepper). Reader footer:
  "Quedan N páginas del capítulo · P%" (option B, over "3 de 12" and estimated
  book pages). The screen stays on while a book is open, released after 10 min
  without a page turn or tap (`platform/keepAwake.ts`).
- 2026-10-22: stats ("Resumen", `#/stats`, chart button in the library header),
  layout A (one column of cards, two on wide screens; over KPI tiles and tabs).
  Content the user chose: time per week/month/year vs the previous period, daily
  bars read/listened, year calendar, finished books + optional yearly goal (local
  kv `yearGoal`), words per minute, time left per book, hours of day, devices,
  per-book line. No streaks ("capaz un día leo un libro físico"). Data:
  `reading_sessions`, written by `SessionTracker` from page turns and the voice's
  progress: gaps up to 5 min (reading) / 30 s (listening) count as time, a 10 min
  break starts a new session, jumps don't count as words. Read/listen colors
  `--c-read` / `--c-listen` (blue/orange, CVD-checked in both themes).
- 2026-10-22: reading speed must be as precise as possible (user: "la resolvemos
  hoy y me olvido"). Only clean stretches count (`pace_words`/`pace_seconds`,
  see the header of `data/sessions.ts`): ≥40 words, app in the foreground, no
  menus/selection, no idle gap/jump/going back, 80–700 wpm until the habitual
  speed in that language is known, then 0.4–2.2× of it. Resumen shows speed per
  language, vs 3 months earlier (or the first month), a line chart week by week
  (month by month after half a year; option A over bars and a sparkline) and
  speed per book. Verified end to end with a fake clock (phone + tablet):
  skimming, a page left open and a page with menus are left out.
  Found on the way: the last page of a chapter can be reported as starting at
  the section's <body> (only a hidden footnote visible), which saved "sentence 0"
  as the position; the reader now ignores such relocates (`reader.ts`).

## Current state (2026-10-21)

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
- Position push while listening with the screen off relies on the WebView
  still receiving plugin events; worst case it's pushed when the app resumes.
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

## The user's Arch PC (installed 2026-10-21)

- Desktop app: `~/.local/opt/atril/Atril.AppImage` (writable, so Tauri's updater
  can replace it), launcher `~/.local/share/applications/atril.desktop`, icon
  `~/.local/share/icons/hicolor/256x256/apps/atril.png`. Renders fine on the
  NVIDIA GTX 1650 under Hyprland (checked with a screenshot).
- Worker: systemd user service `atril-tts` (`./run.sh --service`), linked to the
  user's account (`tts-worker/.session.json`). Logs: `journalctl --user -u atril-tts`.
- Signing-key backup: `~/.config/atril/signing/`.

## Applying schema changes

`supabase/schema.sql` is idempotent: run the whole file again. It needs either
the SQL Editor of the Supabase dashboard (the user would have to paste it) or
a Management API personal access token
(`POST https://api.supabase.com/v1/projects/<ref>/database/query`). Ask the user
for a short-lived token ("Create legacy token" in Account → Access Tokens) and
tell them to revoke it afterwards; never store it in the repo. To test against
the real backend, temporarily add a test email to `allowed_emails`, then delete
that user (`delete from auth.users where email=...`), its Storage files and the
allow-list entry.

## Phase 2 (designed for, not built)

Tap a word → offline dictionary + vocabulary list (the reader already maps
taps to text positions; foliate-js has `dict.js` for StarDict/dictd);
export highlights/vocabulary to Markdown/PDF/flashcards (highlights carry text,
chapter, note, CFI); sleep timer (end of chapter = the controller's `track`
event; X minutes = timer + pause); reading stats (positions already log
device + time; add a sessions table); bookmarks (same shape as highlights with
a kind); full-text search (foliate-js `search.js` via `view.search()`); Kobo
highlight import (KoboReader.sqlite `Bookmark` table → match book by title,
map their spans to CFIs). Out of scope: store, social, non-EPUB formats.
