#!/usr/bin/env bash
# One step to install and run the narration worker on Linux (Arch or other).
#   ./run.sh              install what's missing, then run in this terminal
#   ./run.sh --service    also install it as a user service that starts at login
#   ./run.sh --remove-service
# First run: a browser page opens (http://127.0.0.1:8765) to sign in once.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv (Python package manager)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

UNIT="$HOME/.config/systemd/user/atril-tts.service"
case "${1:-}" in
  --remove-service)
    systemctl --user disable --now atril-tts.service 2>/dev/null || true
    rm -f "$UNIT"; systemctl --user daemon-reload
    echo "Service removed."; exit 0 ;;
esac

# Python 3.12 + PyTorch (CUDA) + Kokoro + Chatterbox, into ./.venv (~6 GB).
uv sync --frozen

if [ "${1:-}" = "--service" ]; then
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<UNITEOF
[Unit]
Description=Atril narration worker (TTS on the GPU)
After=network-online.target

[Service]
WorkingDirectory=$PWD
ExecStart=$(command -v uv) run --frozen python -m worker
Restart=on-failure
RestartSec=30
Nice=10

[Install]
WantedBy=default.target
UNITEOF
  systemctl --user daemon-reload
  systemctl --user enable --now atril-tts.service
  echo "Service installed and running. Logs: journalctl --user -u atril-tts -f"
  exit 0
fi

exec uv run --frozen python -m worker
