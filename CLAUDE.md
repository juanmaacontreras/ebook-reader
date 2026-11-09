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
- **This file is an index.** Details, the why and the history live in `docs/`:
  read the file the table below names *before* that kind of task. A reference
  like see "X" is a section title: `grep -rn "X" docs/`.

## Rules that hold everywhere

- The sentence manifest is the single source of sentence identity. Changing
  segmentation shifts indices: bump `MANIFEST_VERSION` (and `KEPUB_VERSION` for
  `kepub.ts`).
- Narration rows have two owners: the app never pushes worker columns
  (`WORKER_FIELDS`); the worker never touches `updated_at`.
- No service-role key in the app or the worker: the worker signs in as the user.
- A device left behind never takes the others back (`data/places.ts`, the
  `place` trigger, the Kobo's `takesPlace`).
- Audio is requested and managed only from the desktop app; nothing generates
  by itself. Phones may "Parar".
- The Kobo is just one more device: no Kobo screens or settings in Atril, never
  write `KoboReader.sqlite`, never call the function with the real device's token.
- Schema: `supabase/schema.sql` is idempotent; apply with a short-lived token
  the user revokes afterwards, never stored.
- Losing the APK or Tauri signing key stops updates from installing.
- Kill test workers when a test ends (they hold the GPU's VRAM).

## Commands

```bash
cd client && npm ci && npm test && npm run typecheck && npm run build
npm run dev   # then http://localhost:5173/?demo  (&as=phone for the phone UI)
python tools/screenshots.py OUT_DIR [--variant NAME]   # design proposals
cd tts-worker && python -m unittest discover -s tests  # stdlib, runs anywhere
claude-budget  # startup context, must stay < 3000 tokens
```

## When to read what

| Before… | Read |
|---|---|
| finding a file or adding a module | `docs/structure.md` |
| touching sync, positions, the manifest, narration, engines, storage, Android playback or updates | `docs/architecture.md` |
| any visual change | `docs/design.md` |
| running, verifying, the user's PC install, or applying schema changes | `docs/operations.md` |
| changing a behavior the user chose (check the dated log first) | `docs/decisions.md` |
| debugging taps, silent narration, GPU OOM; what is unconfirmed on devices | `docs/state-and-gotchas.md` |
| anything Kobo (protocol, KEPUB, sync rules, security, deploy) | `docs/kobo.md` |
| sessions sent to Bitácora (contract, function, cron, `books.subject`) | `docs/bitacora.md` |
| proposing new features | `docs/roadmap.md`, `IDEAS.md` |

New decisions go into the matching `docs/` file (the dated log in
`docs/decisions.md`); add a line here only if it holds for every task, and keep
`claude-budget` green.
