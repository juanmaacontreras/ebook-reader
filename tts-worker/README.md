# Atril narration worker

Runs on the PC with the GPU (NVIDIA GTX 1650, 4 GB, CUDA). Watches Supabase
for books that need narration and generates the audio chapter by chapter.

## Install and run (one step)

- **Linux (Arch):** `./run.sh` — or `./run.sh --service` to also start it at
  every login (systemd user service; `./run.sh --remove-service` undoes it).
- **Windows:** double-click `run.bat` — or `run.bat --startup` to start it at
  every login (`run.bat --remove-startup` undoes it).

The script installs `uv` if missing, creates `.venv` with Python 3.12,
PyTorch (CUDA 12.4 build, no system CUDA needed), Kokoro and Chatterbox
(~6 GB), then runs the worker. Models download on first use into the Hugging
Face cache (`~/.cache/huggingface`, ~4 GB with Chatterbox).

First run only: a page opens at http://127.0.0.1:8765 to sign in with the
same account as the app. The worker stores only a refresh token
(`.session.json`).

## Voices

- `kokoro:*` — fast (≈23× real time on the GTX 1650). Default.
- `chatterbox-latam:<clip>` and `chatterbox-v3:<clip>` — clone the voice in
  `voices/<clip>.wav`; slower (≈0.4× real time) and more natural.

`uv run compare_voices.py` renders the same Spanish and English passages
with every voice into `samples/` (open `samples/index.html`). It also creates
the Rioplatense reference clips (`voices/ar_tomas.wav`, `voices/ar_elena.wav`)
with edge-tts. Any clean 10–20 s recording saved as `voices/<name>.wav` becomes
a new cloned voice in the app.

## Settings (optional, `.env`)

```
MAX_AUDIO_MB=700     # stop generating when cloud audio reaches this
POLL_SECONDS=15
ASR_MODEL=small      # Whisper model for the quality check of cloned voices
```
