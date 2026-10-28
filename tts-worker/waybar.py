"""Waybar module for the narration worker (stdlib only, no venv needed).

    python3 waybar.py          print the module's JSON (Waybar "exec", interval 5)
    python3 waybar.py --stop   stop what the PC is generating (Waybar "on-click")

Reads work/status.json, which the worker rewrites on every heartbeat. Shows
nothing while the worker is idle or not running, so the PC is never busy
without the user seeing why. A stop is a file the worker picks up within a
second (between chunks); it records the stop so nothing restarts by itself.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

WORK = Path(os.environ.get("WORK_DIR", Path(__file__).resolve().parent / "work"))
STALE_SECONDS = 120  # heartbeats are every 30 s; older means the worker isn't running


def minutes(seconds: float) -> str:
    m = max(1, round(seconds / 60))
    return f"{m} min" if m < 60 else f"{m // 60} h {m % 60:02d}"


def module() -> dict:
    try:
        st = json.loads((WORK / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"text": "", "class": "idle"}
    if time.time() - st.get("at", 0) > STALE_SECONDS or st.get("state") == "idle":
        return {"text": "", "class": "idle"}
    if (WORK / "stop-request").exists():
        return {"text": "Atril: parando…", "class": "stopping", "tooltip": "Parando la narración"}
    if st.get("state") == "blocked":
        return {"text": "Atril: GPU ocupada", "class": "blocked",
                "tooltip": (st.get("notice") or "") + "\nClic: parar"}
    cur = st.get("current") or {}
    left = cur.get("until", 0) - time.time()
    done, total = cur.get("done", 0), cur.get("total", 0)
    text = f"Atril {done + 1}/{total}" + (f" · {minutes(left)}" if left > 0 else "")
    tip = f"Narrando «{cur.get('title', '')}»\n{cur.get('label', '')}\nCapítulo {done + 1} de {total}"
    if left > 0:
        tip += f" · faltan ~{minutes(left)}"
    return {"text": text, "class": "generating", "tooltip": tip + "\nClic: parar"}


def main() -> None:
    if "--stop" in sys.argv:
        WORK.mkdir(parents=True, exist_ok=True)
        (WORK / "stop-request").touch()
        return
    print(json.dumps(module(), ensure_ascii=False))


if __name__ == "__main__":
    main()
