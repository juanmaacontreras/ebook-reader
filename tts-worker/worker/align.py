"""Sentence timings for audio that was not made by this worker. Stdlib only
(tested in CI).

An existing narration (e.g. resumidor's XTTS audiobooks) is transcribed with
Whisper word timestamps; the manifest sentences of the chapter are aligned
against those words, so the app can highlight and seek exactly as with its own
audio. Words Whisper heard differently (numbers written as words, accents)
simply don't match: their sentence takes the time of the nearest matched word,
or is interpolated by text position between matched neighbours.
"""

from __future__ import annotations

import difflib
import re
import unicodedata

Word = tuple[str, float, float]  # (normalized word, start, end) in seconds


def norm_words(text: str) -> list[str]:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.findall(r"[a-z0-9]+", text)


def likeness(sentences: list[str], heard: list[Word]) -> float:
    """How much a transcript looks like a chapter (bag of words, 0..1): enough
    to tell which audio file belongs to which chapter."""
    a = [w for s in sentences for w in norm_words(s)]
    b = [w for w, _, _ in heard]
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(a=a, b=b, autojunk=False).quick_ratio()


def sentence_times(sentences: list[str], heard: list[Word], duration: float) -> tuple[list[tuple[float, float]], float]:
    """(start, end) of every sentence, plus the share of words matched."""
    expected: list[str] = []
    first: list[int] = []
    for s in sentences:
        first.append(len(expected))
        expected.extend(norm_words(s))
    first.append(len(expected))
    sm = difflib.SequenceMatcher(a=expected, b=[w for w, _, _ in heard], autojunk=False)
    at: dict[int, tuple[float, float]] = {}
    for a, b, size in sm.get_matching_blocks():
        for k in range(size):
            at[a + k] = (heard[b + k][1], heard[b + k][2])
    matched = len(at) / max(1, len(expected))

    # Start: the first matched word among the sentence's first few, moved back by
    # the words before it that weren't heard (~0.3 s each). End: its last matched word.
    starts: list[float | None] = []
    ends: list[float | None] = []
    for i in range(len(sentences)):
        words = range(first[i], first[i + 1])
        hit = next((k for k in words[:5] if k in at), None)
        starts.append(None if hit is None else max(0.0, at[hit][0] - 0.3 * (hit - first[i])))
        last = next((k for k in reversed(words) if k in at), None)
        ends.append(None if last is None else at[last][1])

    # Sentences with no match near their start: interpolate by word position
    # between the nearest known starts (the chapter's edges count as known).
    known = [(-1, 0.0)] + [(first[i], s) for i, s in enumerate(starts) if s is not None] + [(len(expected), duration)]
    out_s: list[float] = []
    for i, s in enumerate(starts):
        if s is None:
            pos = first[i]
            lo = max((p for p in known if p[0] <= pos), key=lambda p: p[0])
            hi = min((p for p in known if p[0] > pos), key=lambda p: p[0])
            span = max(1, hi[0] - lo[0])
            s = lo[1] + (hi[1] - lo[1]) * (pos - lo[0]) / span
        out_s.append(s)
    out_s[0] = 0.0 if out_s and out_s[0] < 1.0 else (out_s[0] if out_s else 0.0)
    for i in range(1, len(out_s)):  # never backwards
        out_s[i] = max(out_s[i], out_s[i - 1])

    result: list[tuple[float, float]] = []
    for i, s in enumerate(out_s):
        nxt = out_s[i + 1] if i + 1 < len(out_s) else duration
        e = ends[i]
        e = nxt if e is None or e < s or e > nxt else e
        result.append((round(s, 3), round(max(e, s), 3)))
    return result, matched
