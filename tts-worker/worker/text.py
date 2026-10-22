"""Text preparation for narration: cleanup, splitting long sentences and grouping
sentences into synthesis chunks.

Sentences come from the app (see client/src/book/sentences.ts): the app segments
every chapter once at import time and stores the result, so the CFI of each
sentence is computed by the same code that later highlights it. The worker never
re-segments; it only splits a sentence that is too long for a model into pieces
and keeps track of which sentence every piece belongs to.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

_SPACES = re.compile(r"\s+")
_FOOTNOTE_MARK = re.compile(r"\[\d{1,3}\]|[¹²³⁴⁵⁶⁷⁸⁹⁰]+")
# Spanish dialogue dashes: "—¿Vos venís? —preguntó." Models read a bare dash
# as nothing at best and as a glitch at worst; a comma keeps the pause.
_DIALOGUE_DASH = re.compile(r"\s*[—―]\s*")


def clean(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = _FOOTNOTE_MARK.sub("", text)
    text = text.replace("…", "...").replace("«", '"').replace("»", '"')
    text = text.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    text = _DIALOGUE_DASH.sub(", ", text)
    text = _SPACES.sub(" ", text).strip()
    text = re.sub(r"^[,;:\s]+", "", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r",\s*,", ",", text)
    return text


_CLAUSE_BREAKS = [re.compile(p) for p in (r"[;:]\s", r",\s", r"\s(?:y|e|o|pero|que|and|but|or|which)\s", r"\s")]


def split_long(text: str, max_chars: int) -> list[str]:
    """Split one sentence into pieces of at most max_chars, preferring the
    strongest clause boundary closest to the middle."""
    if len(text) <= max_chars:
        return [text]
    mid = len(text) / 2
    for pattern in _CLAUSE_BREAKS:
        cuts = [m.end() if pattern.pattern.startswith("[") else m.start() + 1 for m in pattern.finditer(text)]
        cuts = [c for c in cuts if 20 <= c <= len(text) - 20]
        if cuts:
            cut = min(cuts, key=lambda c: abs(c - mid))
            return split_long(text[:cut].strip(), max_chars) + split_long(text[cut:].strip(), max_chars)
    cut = max_chars
    return [text[:cut]] + split_long(text[cut:], max_chars)


@dataclass
class Piece:
    sentence: int  # index into the chapter's sentence list
    text: str


@dataclass
class Chunk:
    pieces: list[Piece]

    @property
    def text(self) -> str:
        return " ".join(p.text for p in self.pieces)

    @property
    def sentences(self) -> list[int]:
        out: list[int] = []
        for p in self.pieces:
            if not out or out[-1] != p.sentence:
                out.append(p.sentence)
        return out


def to_pieces(sentences: list[str], max_chars: int) -> list[Piece]:
    pieces: list[Piece] = []
    for i, s in enumerate(sentences):
        s = clean(s)
        if not re.search(r"\w", s):
            continue
        pieces.extend(Piece(i, part) for part in split_long(s, max_chars))
    return pieces


def group_chunks(pieces: list[Piece], target: int, max_chars: int) -> list[Chunk]:
    """Group consecutive pieces into chunks close to `target` characters.

    Autoregressive models (Chatterbox, XTTS) hallucinate on very short inputs and
    drift on very long ones, so chunk length matters more than sentence
    boundaries. Dynamic programming over the cut points, minimising the squared
    distance to the target (the same idea Knuth uses to justify paragraphs, and
    what fixed the babbling in resumidor's XTTS pipeline). Cutting in the middle
    of a sentence that was split into pieces is penalised.
    """
    n = len(pieces)
    if n == 0:
        return []
    INF = float("inf")
    best = [INF] * (n + 1)
    prev = [0] * (n + 1)
    best[0] = 0.0
    for j in range(1, n + 1):
        length = -1
        for i in range(j - 1, -1, -1):
            length += len(pieces[i].text) + 1
            if length > max_chars and i < j - 1:
                break
            cost = (target - length) ** 2 if length < target else (length - target) ** 2 * 0.5
            if j < n and pieces[j].sentence == pieces[j - 1].sentence:
                cost += target**2  # cut inside a sentence
            if best[i] + cost < best[j]:
                best[j] = best[i] + cost
                prev[j] = i
    chunks: list[Chunk] = []
    j = n
    while j > 0:
        i = prev[j]
        chunks.append(Chunk(pieces[i:j]))
        j = i
    chunks.reverse()
    return chunks
