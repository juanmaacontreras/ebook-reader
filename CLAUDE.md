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

**Who moves the shared place (2026-11-02).** Only a move the reader makes on
that device: pages, swipes, scrolling, TOC, slider, links, the voice. Not
opening the book, not "Ir" (shown, not claimed: claiming would push the top of
the page, a few sentences earlier, as newer), not a re-layout (foliate reason
`'anchor'`: window resized or re-tiled, fonts, settings — it could push an old
page over a newer place). `reader.ts` reads the reason from the renderer's own
`relocate`, which fires right after the view's. Going back counts like any
move, also to a page this device had saved before (it didn't: the dedupe
compared with this device's own last save, so going back to a chapter's first
page on the PC never reached the Kobo). **A device left behind never takes the
others back**: while another device's newer place is known here, not taken, and
*past this device's place* (progress made there that this one missed:
`behind`, `data/places.ts`), page turns and the voice count only past that
place; an explicit jump (TOC, slider, highlight) or "Ir" first makes it count
again. A newer place *behind* this one is a move back made there: nothing was
missed, so moves here keep counting, back past it too ("Ir" is offered either
way). A device that
hadn't even heard of the newer place (offline, or a page turned before the pull
landed) is stopped by the server: each write carries `base` (the updated_at of
the newest place the device had seen; its unsent moves carry it forward), and
the `place` trigger drops a write from another device that goes back past a
newer place it hadn't seen (ahead of it still counts). `base` is never stored.
A refused write is missing from the upsert's answer: the device fetches the
book's place back (`pullPosition`) and shows "Ir". The Kobo function applies the
same rule (`takesPlace`: a Kobo whose previous report was behind the newest
place, so it missed progress, doesn't move it back; one at it or past it moves
it anywhere). Checked with `tools/sync_e2e.py` (rules, ahead, stale; the old
code failed 5 of the rules/stale checks and the ahead one) and
`tools/kobo_e2e.py`. (`resize` passes with the old code too: the 3-chapter
sample can't shift a page's first sentence.)

**Sync (client/src/data/sync.ts).** Offline-first: every change goes to
IndexedDB with `_dirty`, then is pushed. Pull is incremental by the
server-side `synced_at` (set by trigger), never by client clocks — an edit made
offline arrives later with an old `updated_at`. Conflicts: last writer wins by
client `updated_at`, enforced on the server by the `lww_guard` trigger (an
older UPDATE is silently dropped). Deleted chapters are learned from
`deleted_chapters` (a pull can't see a deleted row). Books imported offline keep
`_upload` until their files are in Storage.
Timing (measured with `tools/sync_e2e.py`, 2026-11-02): a local change is
pushed at once (`pushSoon`), only that push, no pulls; a book row, an upload or
a removal take the full sync (removals from elsewhere are pulled first), and so
does a foreign-key error (a book removed meanwhile). While listening the place
goes every 10 s, and at once when the voice stops (`flush`, reader.ts; the
controller emits the sentence before the playing state). Leaving the app
(hidden, Android pause, pagehide) flushes at once and the flush waits for local
writes still in flight (`localWrite`): a phone may freeze a background app
within seconds — before this, a place turned at 16:16 reached the server at
18:03. A Realtime event pulls just its table (books → + deleted_books, chapters
→ + deleted_chapters; our own position echo is skipped); every (re)subscription
catches up with a pull of everything. Full syncs: start, coming back, `online`,
after a failure (backoff 4 s → 1 min), and `safetySync` every 30 s while
Realtime is down (else 5 min). Pulls run all tables in parallel; pushes do books
first, then the rest in parallel. Deadlines only move earlier (`Later`): a lazy
request can't postpone an urgent one (it did: a session save's 5 s delayed a
position). Realtime may die without a word (a phone switching networks): a
heartbeat every 15 s (default 25), a new connection on `online`, and the
positions alone pulled every minute while visible (Realtime doesn't promise
delivery). Opening a book asks the server for its place first
(`positions.fresh`, ≤1.5 s, overlapped with loading the book) so it opens where
another device left it; the "Ir" offer is only for places that arrive after.

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

**Storage budget (free tier: 1 GB files, 5 GB egress/month).** EPUBs are
deleted only when the user removes the book ("Sacar de la biblioteca"). Audio of a book is deleted from Storage when it's marked finished
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

- 2026-10-27: **Kobo, plan only (nothing built; user said "no hagas nada").**
  The user is buying a Kobo Clara BW (6" e-ink, grayscale), will never use the
  Kobo store (DRM-free EPUBs only). Ranked, ignoring setup effort (sync,
  looks, comfort once set up): (1) stock Nickel reader + Atril acting as the
  Kobo sync server (change `api_endpoint` in `Kobo eReader.conf`, like
  calibre-web's Kobo sync): books arrive over Wi-Fi, position + finished state
  sync; KEPUB `koboSpan`s are near sentence-level, so position can map closely
  to the manifest; whether highlights can come through Kobo's annotation API is
  unconfirmed; (2) KOReader + a kosync-compatible endpoint + OPDS catalog
  (two-way position, books on demand, plainer UI, firmware updates can break
  the launcher); (3) stock reader + an on-device helper that, on Wi-Fi, uploads
  `KoboReader.sqlite` data (highlights, position, time read) and fetches new
  books (Kobo → Atril only; never write the Kobo DB); (4) USB cable import on
  the desktop app; (5) Kobo's Dropbox/Drive (books only); (6) Plato (no sync).
  My recommendation: 1 + 3. Also mentioned: an Android e-ink reader (Boox,
  PocketBook) running Atril itself would be best at everything but needs an
  e-ink mode. A simulation artifact of how option 1+3 would look was shown.
  Same day: **the phone/tablet/desktop apps must not change** ("que siga
  funcionando como funciona ahora"): the Kobo is just one more device. Its
  data lands in what already exists (position + "Ir" offer, highlights panel,
  Resumen's per-device numbers); no Kobo screens, buttons or settings in Atril.
  Also: highlights Atril → Kobo are **not wanted** (Kobo → Atril is enough), so
  never write `KoboReader.sqlite`. Position sync both ways is what matters most:
  check how often stock firmware syncs on its own (wake, closing a book, sleep,
  periodic?) and, if needed, have the helper push position more often.

- 2026-10-28: **narration only on purpose ("que sea consciente, cuando yo
  quiero"). Agreed plan, nothing built yet.** Why: the worker ran at every
  login and auto-narrated; Chatterbox held 3 of the GTX 1650's 4 GB and 98% of
  the GPU, starving Hyprland and every app (visual glitches, a frozen terminal,
  thousands of `nvidia-drm ... Failed to allocate NVKMS memory for GEM object`
  in the kernel log). Interim fix, outside this repo: `atril-tts.service` is
  disabled and hypridle (`~/dotfiles/config/hypr/hypridle.conf`) starts it
  after 15 idle minutes and stops it on input. The plan replaces that:
  1. Nothing generates by itself: drop automatic narration ("Generar audio
     solo", `autoNarrate`, `autoNarrateAll`, the automatic 'ahead' scope).
  2. The user starts it from the desktop app's Audios screen ("Generar ahora"),
     choosing what: this chapter, the next 3, or the whole book.
  3. It runs until that is done or the user taps "Parar", even with the screen
     or the app closed — the decision was already made (tying it to an open
     screen was considered and dropped: Chatterbox needs ~2.5 h of GPU per hour
     of audio, it would never finish a book).
  4. Visible while it runs: a Waybar module in `~/dotfiles` (same shape as
     `custom/timer` for Bitácora), click to stop. The PC is never busy
     without the user knowing why.
  5. VRAM guard: before loading a model, `torch.cuda.mem_get_info`; always
     leave ~600 MB to the desktop (Waydroid also uses this GPU). Not enough →
     don't load, say so in `worker_status` (shown in the app), never thrash.
  6. Phone/tablet: Audios stays read-only with real state ("Generando en la PC
     · capítulo 4 de 12 · faltan ~40 min", "Listo", "Sin audio · pedilo desde
     la PC", "PC apagada"); chapters appear as they finish; playing a chapter
     without audio still says "Pedilo desde la PC". New: **"Parar" is allowed
     on phones** (stopping only frees the GPU). Starting from a phone is not:
     the PC would start working with nobody in front of it.
  7. The worker stays running and cheap when there is nothing to do (no model
     loaded, heartbeat on, so the app never shows "PC apagada" wrongly). When
     this ships: `./run.sh --service` again, delete the second `listener` in
     `hypridle.conf`, and update the "Idle behavior" note in
     `~/dotfiles/CLAUDE.md`.
  Open design point: `status` is app-owned (see "Narration rows have two
  owners"), so a stop from the Waybar click must not have the worker write
  `status` itself — route it through an app-owned write or add an explicit
  stop-request column; decide when building. UI text and layout of the
  Audios changes go through screenshot variants first (working rules).
  Verify: with a job running and the desktop in use, no `NVKMS` errors in
  `journalctl -k`; with no job, `nvidia-smi` shows no worker memory; "Parar"
  from a phone frees the GPU within a chunk.

- 2026-10-28 (later): **on-purpose narration built** (not merged until the
  schema is applied). Jobs: `narrations.scope` chapter/next/all counted from
  `start_section`, app-owned `started_at`; a Waybar stop is the worker-owned
  `stopped_at` (runnable iff active and stopped_at < started_at,
  `worker/jobs.py`) — this settles the open design point above. VRAM guard via
  nvidia-smi (no CUDA context), reason in `worker_status.notice`; an idle
  worker unloads and re-execs itself to drop the CUDA context.
  `tts-worker/waybar.py` prints the module JSON, `--stop` on click. "Generar
  ahora" sheet (`screens/generate.ts`): option B (segmented what + one
  estimate line + voice + one button), picked over A (a big row per option).
  Dotfiles side done the same day: `custom/atril` Waybar module (runs
  `tts-worker/waybar.py` by path, so keep its location and `--stop` flag
  stable), hypridle listener removed, unit enabled again with `./run.sh --service`.

- 2026-10-29: **"Sacar de la biblioteca"** (book menu, every device, with a
  confirmation). Removes the book everywhere: the row is deleted (cascade:
  position, highlights, narration, chapters; reading sessions keep their time
  with book_id null, so Resumen totals stay), then its folders in both buckets.
  Other devices learn it from `deleted_books` (trigger log, like
  `deleted_chapters`), applied *before* push so a stale row can't fail its
  foreign key or bring the book back. Removed ids stay in local kv `goneBooks`
  (pull and push skip them); removals made offline wait in
  `pendingBookDeletes`. An open reader of a removed book goes back to the
  library. Worker: an upload whose chapter row fails (book removed mid-chapter)
  deletes its file; `sweep_removed` clears `work/` of removed books. A removed
  book's sessions drop out of the per-language speed (no language without the book).

- 2026-11-02: **Kobo sync built and deployed** (option 1 of 2026-10-27; user: "lo
  dejo todo a tu criterio"). A stock Kobo Clara BW (N365, firmware 4.45) syncs with
  Atril as if Atril were Kobo's store; see "Kobo" under Architecture. The phone,
  tablet and desktop apps look the same: the Kobo shows up only as a position
  ("Ir"), a status, and "Kobo" in Resumen's devices. Verified end to end against
  the real backend (`tools/kobo_e2e.py`, all checks pass). **Confirmed on the
  device the same evening** (see "Kobo", "Seen on the real device"). Setup done the same day: the Kobo's `api_endpoint` points
  at the function (original conf and the token in `~/.config/atril/kobo/`, outside
  the repo; a Kobo reset or Kobo-account sign-in may restore the stock line:
  write it again from there). A cloud session had built a first version the same
  day (branch `ccr-f98e385e-g1tw2k`, never merged: plain EPUB, position by
  percent); this one replaces it. Its leftovers (tables `kobo_states` /
  `kobo_events`, function `kobo_trim_events`, an unused `kobo_devices` row)
  were dropped the same day with the user's OK. Still open: highlights (need the
  "reading services" at a host root: the device strips any path from
  `reading_services_host`, so a Supabase function URL can't take them; options:
  a free Cloudflare Worker at its own root, or reading `KoboReader.sqlite`); how
  often the stock firmware syncs by itself (read `kobo_log`).
  **Requirement set by the user the same day:** tapping "Sincronizar" by hand is
  fine for library changes (a new or removed book), but switching devices must
  carry the position with no tap at all ("si tengo que tocar sincronizar cada vez
  que quiero cambiar el dispositivo, ahí sí ya es un problema"). To measure on
  the device, both ways, with `kobo_log`: Kobo → Atril (does it PUT the state by
  itself on closing a book / sleeping?) and Atril → Kobo (does it sync by itself
  on wake / opening a book?). Its "Automatic sync" setting was on "Night"; the
  options it offers are not known yet. If either way needs a tap: plan B, an
  on-device add-on that syncs on wake and on closing a book (explain what it is
  and how to remove it before installing; never write KoboReader.sqlite).
  **Result the same evening: met with no add-on** — the Kobo asks for a book's
  state each time it is opened and reports its place while reading (see "Kobo").

- 2026-11-02: **sync between devices made as fast as possible** (user: "lo más
  más más posible"). Measured against the real backend with
  `tools/sync_e2e.py` (two headless devices + a simulated Kobo, medians), before
  → after: a page turned on one device reaches the server 3.3 s → 0.25 s and
  the other open device 3.9 s → 0.34 s; a page turned right before leaving the
  app: lost (until the app came back; seen for real: 16:16 → 18:03) → 0.25 s;
  catching up after reconnecting 0.3 s (max 3.9 s) → 0.16 s (max 0.2 s);
  opening a book right after reconnecting: old place + "Ir" → the right place;
  Kobo report → open device 1.4 s → 0.85 s; device → Kobo (what the Kobo gets
  on opening the book) 3.5 s → 0.45 s. Kobo function server time (kobo_log.ms):
  GET state ~150 ms, PUT ~250 ms. How: see "Sync" under Architecture. Nothing
  visible changed. Still open: highlights from the Kobo, and whether the Kobo
  asks for the place on waking with a book open (to check in `kobo_log`).

- 2026-11-02 (night): **going back syncs too; a device left behind never takes
  the others back; status (Por leer / Leyendo / Terminado) both ways with the
  Kobo.** Found on the real device: going back to a chapter's first page on the
  PC never reached the Kobo (the reader's dedupe compared with its own last
  save). The user's condition for sending moves back: "evitemos el error de que
  avanzo en un dispositivo, y cuando agarro el otro no se llega a sincronizar y
  por lo tanto retrocede el otro". Rules: see "Who moves the shared place" under
  Architecture and the Kobo's "Sync rules". No UI change (the existing "Ir").
  Still to see on the real Kobo: whether it jumps *back* to a place behind its
  own ("parece que estuviste leyendo en otro dispositivo" was only seen going
  forward), and whether it shows a status set in Atril (after "Sincronizar").
  **Known gap (kobo_log, same night):** the Kobo reports nothing when the user
  accepts its own "reading on another device" jump, and nothing in its reports
  says whether it took Atril's place (every timestamp in a PUT is the report's
  time; it never echoes ours). So when the Kobo was *behind* the other device's
  place, a move back made on it right after accepting (before its next report,
  ~1 min), or after declining, stays `kept` until the Kobo passes that place:
  the others then open *ahead* of the real place, never behind. It happened
  for real at 20:05–20:06 local (accepted 8.66 from the PC, went back to
  7.320); the old function took it. Possible fix: count a state GET that
  answered a newer place as "the device showed its dialog" (after that, any
  move counts). Safe only if the Kobo shows the dialog on that GET: on waking
  with a book open it does (user, same night); on the periodic GETs while
  awake with the book open (~every 30–60 s) it shows nothing (user tested,
  23:30 the same night), so "a GET answered it" does not mean "the user saw
  it": counting those would let an awake Kobo read on from an old place and
  take the others back. **Left as is, the user's call** ("No es algo que me
  moleste eso igual"): the gap only leaves the others ahead.
  Also seen (user, same night): right after the power button (cover open)
  the Kobo still gets a newer place and shows its dialog on the sleep
  screen, ready when picked up; behind a closed cover it likely does the
  same, unseen. Not seen yet: whether a dialog left waiting while the other
  device read on for a long time offers the latest place or the older one.
- 2026-11-02 (later that night), **tested on the real devices**: going back on
  the phone took the Kobo back (its dialog, then the jump), but going back on
  the Kobo didn't reach the phone: the Kobo was *ahead* (17.142) when the phone
  went back (10.914), then went back itself (7.320) and was `kept` (the rule
  then required its previous report to be *at* the newest place). Relaxed on
  both sides: only a device that missed progress (the newest place is past it)
  is held back; a move back made elsewhere holds nobody back (`takesPlace`,
  `leftBehind` in `data/places.ts`). Function deployed the same night.
  Also found: the phone at the cover (no text) sent the Kobo its own place
  back; now the nearest text (`placeForKobo`).
- 2026-11-02 (late night): **"Por leer" means back to the start, everywhere.**
  The Kobo's "no leído" already sends the book to its cover; Atril's "Por leer"
  only changed the status, so the old place stayed and a fresh start on the
  Kobo counted as "behind" (held back until it passed the old place). Now
  marking "Por leer" in the apps (`positions.restart` in `data/store.ts`) or as
  unread on the Kobo moves the shared place to the first sentence of text and
  the library says "Sin empezar". Lost: only the old place, which is what
  "unread" means (user agreed: "Me parece bien"). Comes with the echo rule
  above (`told`), deployed to the function the same night.

- 2026-11-03: **external narration attached to a book** (`import_audio.py`).
  First case: resumidor's Seguridad e Higiene EPUB (guion text + summary as
  images, built by `resumidor/audiolibro/tools/epub.py`) with its existing XTTS
  mp3s as the narration, voice id `xtts:tomas`. The narration row is 'ready'
  with no `started_at`, so it is never a job: the worker leaves it alone, and a
  "Generar ahora" with another voice replaces it as usual. Whisper runs on the
  CPU (int8 small, ~1 min per 8 min of audio); the worker's session file is
  shared, so the service is stopped while the tool runs (rotating refresh token).

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

## The user's Arch PC (installed 2026-10-21)

- Desktop app: `~/.local/opt/atril/Atril.AppImage` (writable, so Tauri's updater
  can replace it), launcher `~/.local/share/applications/atril.desktop`, icon
  `~/.local/share/icons/hicolor/256x256/apps/atril.png`. Renders fine on the
  NVIDIA GTX 1650 under Hyprland (checked with a screenshot).
- Worker: systemd user service `atril-tts` (`./run.sh --service`), linked to the
  user's account (`tts-worker/.session.json`). Logs: `journalctl --user -u atril-tts`.
  Since 2026-10-28 it is **disabled** and started by hypridle only while the PC
  is idle — interim, until on-purpose narration ships (User decisions,
  2026-10-28). Don't re-enable it before that.
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

## Kobo

- **Protocol**: Kobo's store API as Calibre-Web reverse-engineered it, served by
  `supabase/functions/kobo` at `https://<ref>.supabase.co/functions/v1/kobo/<token>`
  (the Kobo's `[OneStoreServices] api_endpoint`). `v1/initialization` proxies
  Kobo's own resource list and overrides only the library, reading state,
  collections and covers, so sign-in, dictionaries, firmware and highlights stay
  Kobo's. Books of Kobo's store keep going to Kobo (307).
- **KEPUB = sentence identity on the Kobo.** A synced book is always opened by the
  KEPUB renderer, which can only report/restore a place at a `koboSpan`; a plain
  EPUB reports every place as the chapter start. `book/kepub.ts` wraps manifest
  sentence k in `kobo.<k+1>.<piece>` (pieces = text nodes split by inline markup,
  footnote refs left out) and `kepub.json` maps archive file → spine index. So the
  Kobo's `{Source, Value: kobo.N.M}` is sentence N-1, and Atril's (section,
  sentence) goes back as `kobo.<sentence+1>.1`. A place on a page without text
  (a cover, an image) goes as the start of the next text, else the end of the
  last one: the Kobo can only stand on text (`placeForKobo`; going back to the
  cover on the phone used to leave the Kobo where it was). Built by any device that has the
  EPUB, the desktop also downloads missing ones (`data/kepubs.ts`), refused if
  segmentation differs from the manifest. `books.kepub_path` is set by a direct
  update that leaves `updated_at` alone and is in `NOT_PUSHED` (sync.ts): a stale
  local row must never clear it. Only books with a KEPUB reach the Kobo. Changing
  `kepub.ts` output: bump `KEPUB_VERSION`, clear `kepub_path`.
- **Sync rules**: cursor = our own token over `books.synced_at`,
  `positions.synced_at`, `deleted_books.synced_at`. A place the device reports is
  written to `positions` (device `kobo:<id8>`, `updated_at` = the device's time, so
  LWW works with offline reading) only when it moved (it repeats its place on
  every open/close), and never back past a newer place from another device
  that it was behind (`takesPlace`, see "Who moves the shared place"). Status, both
  ways: Atril's goes in every reading state (sync and GET state); from the
  device only a change made there counts (it repeats its status on every
  report), plus reading on it: a "Por leer" book becomes "Leyendo" when its
  place moves; "Reading" undoes "terminado" only if the Kobo itself had it
  Finished (taken up again there). **The echo is not a change**: the Kobo takes
  a status Atril hands it and reports it back later (at its next sync, maybe
  hours), so `kobo_books.told` keeps the statuses it was told until it reports
  them (`tell`/`toldAfter` in `logic.ts`); else a "Por leer" echoed after reading
  on the phone would undo that reading. "No leído" made on the Kobo takes the
  shared place back to the book's first text sentence (`startOf`), unless
  another device read the book after it. The device's `StatusInfo.LastModified` is
  its report time, not when the status changed: no use for ordering.
  `SpentReadingMinutes` deltas become `reading_sessions`
  (`device_kind` 'ereader', words between the two places, never in reading
  speed). Removing a book on the Kobo only hides it there (`kobo_books.removed`).
- **Security**: deployed with JWT verification off (the device can't send one;
  the user authorized it 2026-11-02). The token is the credential, only its
  SHA-256 stored in `kobo_devices`; the function is the one place using the
  secret key, every query scoped to the token's user. New Kobo or lost token:
  insert a new `kobo_devices` row with the hash and write the URL into the conf.
- **Seen on the real device (2026-11-02, firmware 4.46.23852)**: a library sync
  brings new books and the device downloads them (and covers) by itself right
  away. Opening a book makes it `GET .../state`; if Atril's place is newer it
  shows its own "looks like you've been reading on another device" dialog and
  jumps to that exact span (PC → Kobo checked at sentence level: kobo.67.1 sent,
  that page shown). Its log of the same evening, read closely: it `PUT`s its
  place on closing the book and, while reading, about once a minute (when its
  reading-minutes counter moves), not every page; each arrives ~2 s after the
  bookmark's own time. It `GET`s the state on opening a book and about once a
  minute while one is open (whether it also does on waking with a book open is
  not confirmed). So switching devices needs no tap;
  only library changes (new/removed books) wait for a sync (manual, or its
  "Automatic sync" schedule). A device may lose a sync's answer (it refreshed its
  resources and synced again); books therefore go as *new* until the device
  confirms them (download or a state report, `kobo_books.confirmed_at`): it
  ignores a *changed* entry for a book it never stored. Store sections on its
  home screen (deals, featured) come here too and get `{}`: they show empty.
- **Debugging a real device**: `kobo_log` (every request, no token; reading-state
  bodies as sent, the place sent back on `GET state`, `ms` to answer; two
  weeks). Each request reads what it needs in one round of parallel queries,
  then writes in one (the function reaches PostgREST through the public URL,
  ~50–100 ms a round trip; it runs in sa-east-1 like the database). Never call
  the function with the real device's token for checks: a download counts as the
  device confirming the book. Cloudflare in front of Supabase caches `*.jpg`
  answers for minutes, a 404 too.
- **Deploy**: `SUPABASE_ACCESS_TOKEN=<short-lived PAT> npx supabase functions
  deploy kobo --project-ref uxavtsscsgtcjxfmfwrp --use-api --no-verify-jwt`
  (CLI in the scratchpad). CI runs `deno check` + `deno test` on it.

## Phase 2 (designed for, not built)

Tap a word → offline dictionary + vocabulary list (the reader already maps
taps to text positions; foliate-js has `dict.js` for StarDict/dictd);
export highlights/vocabulary to Markdown/PDF/flashcards (highlights carry text,
chapter, note, CFI); sleep timer (end of chapter = the controller's `track`
event; X minutes = timer + pause); reading stats (positions already log
device + time; add a sessions table); bookmarks (same shape as highlights with
a kind); full-text search (foliate-js `search.js` via `view.search()`); Kobo
highlights (their location is our koboSpan ids, so they map to sentences
directly; see the 2026-11-02 decision for how to receive them). Out of scope: store, social, non-EPUB formats.
