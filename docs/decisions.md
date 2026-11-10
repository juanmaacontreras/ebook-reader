# User decisions (log)

> Moved verbatim from `CLAUDE.md` on 2026-11-04. The index that says when to read this file is `CLAUDE.md`.

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
- 2026-11-03 (night): **one cover slot + a mini player** (user: "me copa" to my
  proposal, then "hacelo", skipping the variants step to have it on the phone
  for the next morning's commute). Covers: every library-grid cover sits in a
  3:4 slot, the shape of resumidor's covers (Kobo Clara screen). Taller covers
  scale to the slot's height (2:3 ones ~11% narrower, centered), wider ones keep
  the width at the bottom; nothing cropped or stretched (`fillCover` measures,
  CSS "Covers"). The keep-reading card keeps real proportions. Player: while
  listening, the toolbars and the full player fold back after 4 s untouched
  (`AUTOHIDE_MS`; a finger held on a control keeps them) into a mini bar
  (play/pause, chapter, time, progress line). It fits in the room the page
  already leaves at the bottom (44 px page margin + the footer's place), so the
  text is never under it; scrolled flow adds 42 px. A tap on the bar unfolds
  everything; a middle tap while unfolded only folds (no seek); folded, a middle
  tap seeks as before. Checked in headless Chromium (`?demo`, silent narration
  seeded): bar top 14 px below the text, fold/unfold/hold/seek/pause/close.
- 2026-11-09: **links from the brain app** (ecosystem phase 6, user: "mandale,
  sin miedo"). `atril://book?sha256=…&listen=1` opens the book and, with
  `listen=1`, presses Escuchar. Identity by EPUB hash, not by Atril's book id,
  so cerebro-app never reads Atril's data (ecosystem rule 4). Opening to a given
  chapter is left for the resumidor package, which will say which chapter is
  which unit; nobody can produce that link yet. See "Links from other apps".
- 2026-11-09: **books published and replaced without the app** (ecosystem phase 6, user:
  "quiero el proyecto cerebro andando al 100%"). `tts-worker/publish_book.py` adds an EPUB
  or replaces a book's EPUB in place, keeping its id: place and highlights move by their
  text, a highlight whose text is gone stays as it was (never deleted), the audio of
  changed chapters is removed (timings no longer fit). The manifest is built by the app's
  own code in jsdom (`client/tools/analyze.tool.ts`), never by a second segmenter.
  Matching a resumidor unit to its book is resumidor's job (it stores the id). See
  "Books replaced in place".
- 2026-11-09: **sessions go to Bitácora** (ecosystem phase 7; three variants rendered on
  Bitácora's Día view, user: "Dale, la C"). A book adds to its subject: the time of a
  resumidor book counts as that subject's activity, any other book as its own activity.
  Atril publishes an inbox row in Bitácora's database every 15 minutes (Edge Function
  `bitacora`, pg_cron) and Bitácora merges it with its own logic; neither reads the
  other's tables. See docs/bitacora.md.
- 2026-11-10: **published books carry their KEPUB** (`publish_book.py`, PR #38): a book
  published or replaced from the PC reaches the Kobo with no app open. Open: whether the
  Kobo downloads a replaced file again (docs/kobo.md, "A replaced book").
- 2026-11-10: **the book's inside is not restyled for the Kobo** (user: "No quiero que
  cambies como se ve el libro por dentro"): no e-ink CSS, boxes or formula sizing in the
  KEPUB. Outside the book (subject as series, collections) only if the user asks.
- 2026-11-10: **coverage map looked at, not built.** `reading_sessions` has no section, so
  "what was read or heard per unit" cannot come from existing data (IDEAS.md called it
  quick): it needs a new record written by `SessionTracker`, a schema change and a
  screen. Past sessions cannot be split by unit.
- 2026-11-10: **the Kobo comes first for new work** (user: "prioricemos todo lo que tenga
  que ver con el ebook, me interesa personalizar eso"), still without restyling the book's
  inside (same day, above). First step: the subject as the book's series (see "Subject as
  series" in docs/kobo.md); built, to deploy with a short-lived token.
