# Run, verify, the PC install and schema changes

> Moved verbatim from `CLAUDE.md` on 2026-11-04. The index that says when to read this file is `CLAUDE.md`.

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
