# Kobo

> Moved verbatim from `CLAUDE.md` on 2026-11-04. The index that says when to read this file is `CLAUDE.md`.

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
- **It dates its bookmark again on opening a book (2026-11-05)**, moved or not,
  and takes a place from elsewhere only when it is dated after that. A place read
  on the phone on the way home, sent dated by when it was read, was ignored on
  opening the book at home (kobo_log 2026-11-04 19:40 and 11-05 17:05: "sent
  kobo.87.1 (from 5eecb208)", then the device's "no change" on its old page); a
  page turned on the phone afterwards, dated later, was taken. So `GET state`
  hands a place from another device that the Kobo hasn't seen (newer than the
  bookmark it last reported) dated a minute from now (`offerNewer`, logic.ts;
  the log says "offered as new"); once it reports again it goes with its real
  time, so a declined place isn't offered every minute. Status keeps its real
  time (the `told` echo rule reads it). Not yet confirmed on the device: whether
  a Kobo left open and idle after declining asks again each minute.
- **Which places count as seen (2026-11-11, not deployed, not read in the log)**:
  the user still had to turn a page on the phone at home before the Kobo offered
  the place. Until now a place counted as seen when the bookmark the Kobo last
  reported was dated after it; but a report can get here before it asks (on
  waking, or a pending one sent on getting Wi-Fi back) with its old page freshly
  dated, and then the phone's place went with its real time and was ignored
  without ever being offered. Now it is by the server's clock only: a place is
  offered as new until this very place was handed out (`kobo_books.offered` = its
  `positions.updated_at`, at `offered_at`) and the device reported after that
  (`state_at`); `hadPlace`, logic.ts. A side effect, wanted: a Kobo read offline
  *behind* the phone's place ("behind: kept") is now offered that place once.
  Deploy order: the two columns first (`schema.sql`), then the function. To
  confirm in `kobo_log` on the next walk home: a `PUT` "no change" seconds
  before the `GET state`, which must now say "offered as new".
- **Subject as series (2026-11-10, not deployed, not seen on the device)**: a book with
  `books.subject` goes with `Series` in its metadata (name = the subject, number = its
  place among that subject's books by `added_at`; `seriesId`, `seriesNumbers` in
  logic.ts), in the shape Calibre-Web sends. Books without a subject carry none. The
  device learns it when the book is sent again in a sync (`books.synced_at` moves), so
  books it already has need a touch. To see on the device: the series under the title
  and in its Series tab.
- **A replaced book (2026-11-10)**: the device keeps the file of an id it already has,
  whatever it is told. Tried on the real device the same day, all without a `download/`
  in `kobo_log`: a *changed* entry (03:36 UTC); removed and new in one round (13:51: it
  only took the new entry's metadata, the series showed up); removed in one sync and new
  in the next (14:06 and 14:07: the book left the screen and came back, same file). So a
  replaced book is handed under a **new id**: `kobo_books.has_sha` keeps the EPUB hash
  whose KEPUB the device downloaded; when it differs from `books.sha256` the sync sends
  the old id as removed and the book as new under `kobo_books.kid` (a fresh UUID; null =
  the book's own id), offered on every sync until it is downloaded. Every id the device
  uses goes through `bookId` (index.ts): a `kid` stands for its book, the id of a
  replaced version for nothing (its reports are not taken). `has_sha` null (downloaded
  before this): left alone. Covered by `tools/kobo_e2e.py` (ALL PASSED against the
  deployed function). Highlights made on the Kobo in that book go with the old file.
  Also learnt: the device takes `Series` only from a *new* entitlement. Known gap: a
  book replaced once and later removed from the library stays on the device.
- **Initialization on the fallback list since 2026-11-03 (open)**: the first fallback
  was a timeout (6 s, 19:44 UTC); from 20:33 on every one is a fast failure (~0.5 s), so
  Kobo answers but not with 200. The log now says why ("resources: fallback, Kobo
  answered 401"). Everything Atril serves works; what the short fallback list leaves out
  of Kobo's own services on the device is not known.
- **Speed (2026-11-10)**: in everyday use the function answered a `GET state` in ~0.4 s
  and a `PUT` in ~0.5 s (medians of `kobo_log.ms` over a week; ~0.15 s only on the day
  of heavy use), plus a cold start the log doesn't see: 0.9 s for a first request
  against 0.15–0.3 s right after, measured from the PC. So a scheduled call hits
  `kobo/ping` every minute (`supabase/kobo.sql`, pg_cron + pg_net; no token, one small
  read, not logged), and the per-book map and text stay cached ten minutes, dropped
  when the book's hash changes (`replaced`, index.ts). What is left is the firmware's:
  it reports its place about every 30 s while reading (median 27 s, 90 % under 140 s)
  and on closing, and asks for the place on opening a book and on waking.
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
