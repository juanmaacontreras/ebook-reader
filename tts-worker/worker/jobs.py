"""What to generate, and how long it will take. Stdlib only (tested in CI).

Narration only happens on purpose (CLAUDE.md, User decisions 2026-10-28): the
user starts a job from the desktop app and picks what — this chapter, the next
three or the whole book — counted from the chapter they were in when they
asked (start_section). The job never follows the reading position afterwards.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

NEXT_CHAPTERS = 3
SCOPES = ("chapter", "next", "all")


def runnable(n: dict) -> bool:
    """An active job the user started and nobody stopped since. A stop from the
    PC itself (Waybar click) is recorded by the worker as stopped_at (it never
    writes the app-owned status); a new start from the app (started_at) wins."""
    if n.get("status") != "active" or n.get("scope") not in SCOPES or not n.get("started_at"):
        return False
    stopped = n.get("stopped_at")
    return not stopped or _ts(stopped) < _ts(n["started_at"])


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def job_sections(sections: list[dict], n: dict) -> list[dict]:
    """The chapters this job covers, in generation order (only those with text)."""
    sections = [s for s in sections if s.get("sentences")]
    if not sections:
        return []
    start = n.get("start_section")
    k = next((j for j, s in enumerate(sections) if start is not None and s["i"] >= start), 0)
    scope = n.get("scope")
    order = [sections[k]] if scope == "chapter" else sections[k : k + NEXT_CHAPTERS] if scope == "next" else sections[k:] + sections[:k]
    # A chapter the user jumped to while the job runs goes first, if the job covers it.
    prio = next((s for s in order if s["i"] == n.get("priority_section")), None)
    if prio is not None:
        order = [prio] + [s for s in order if s is not prio]
    return order


def chars(section: dict) -> int:
    return sum(len(s["t"]) for s in section.get("sentences", []))


# GPU seconds per character of text, measured on the GTX 1650 (CLAUDE.md:
# Kokoro ~23x real time, Chatterbox ~0.3x; Spanish narration ~15 chars/s).
DEFAULT_RATE = {"kokoro": 0.003, "chatterbox-v3": 0.22, "chatterbox-latam": 0.22}


class Speed:
    """Running estimate of GPU seconds per character, per engine, kept on disk
    so the first chapter after a restart already has a good guess."""

    def __init__(self, path: Path):
        self.path = path
        try:
            self.rates: dict[str, float] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.rates = {}

    def rate(self, engine: str) -> float:
        return self.rates.get(engine, DEFAULT_RATE.get(engine, 0.1))

    def record(self, engine: str, n_chars: int, seconds: float) -> None:
        if n_chars < 200 or seconds <= 0:
            return
        r = seconds / n_chars
        self.rates[engine] = 0.7 * self.rate(engine) + 0.3 * r if engine in self.rates else r
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.rates), encoding="utf-8")
        except OSError:
            pass

    def eta(self, engine: str, n_chars: int) -> int:
        return round(self.rate(engine) * n_chars)
