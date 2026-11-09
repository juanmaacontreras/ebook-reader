# Architecture decisions

> Moved verbatim from `CLAUDE.md` on 2026-11-04. The index that says when to read this file is `CLAUDE.md`.

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

**Links from other apps (2026-11-09).** `atril://book?sha256=<hex>[&listen=1]`
opens a book from outside (Android only: an intent filter on `MainActivity`).
The book is named by the SHA-256 of its EPUB, what the importer stores in
`books.sha256` and Google Drive reports as `sha256Checksum`, so the brain app
needs nothing of Atril's but the file it already lists: no shared database. A
hash not known here triggers one full sync before giving up with "no está en tu
biblioteca". Opening from a link is opening the book (never moves the shared
place); `listen=1` sets the same `sessionStorage` flag as the library's Escuchar.
A different EPUB file of the same book (re-exported, other edition) has another
hash and does not match: by design, it is another file. Parser and contract
fixture: `platform/links.ts`, `tests/links.test.ts`; cerebro-app tests the same
fixture on its side.

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
