"""Turn one chapter (a list of sentences) into audio plus a sentence timing map."""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from .audio import normalize, silence, trim
from .engines import Engine
from .engines import free_gpu
from .text import Chunk, Piece, group_chunks, split_long, to_pieces

log = logging.getLogger(__name__)

PAUSE_SENTENCE = 0.32
PAUSE_PARAGRAPH = 0.65
PAUSE_HEADING = 0.9
MAX_TRIES = 4
STABLE_AFTER = 3  # takes whose scores barely move mean an ASR bias, not babbling
STABLE_SPREAD = 0.06


@dataclass
class Sentence:
    text: str
    cfi: str
    # Block (paragraph) index inside the chapter; a change means a longer pause.
    block: int = 0
    heading: bool = False


@dataclass
class Timing:
    index: int
    cfi: str
    start: float
    end: float


@dataclass
class ChapterAudio:
    wav: np.ndarray
    sample_rate: int
    timings: list[Timing]
    warnings: list[str] = field(default_factory=list)


def _pause_after(sentences: list[Sentence], i: int) -> float:
    if i + 1 >= len(sentences):
        return PAUSE_PARAGRAPH
    if sentences[i].heading or sentences[i + 1].heading:
        return PAUSE_HEADING
    if sentences[i + 1].block != sentences[i].block:
        return PAUSE_PARAGRAPH
    return PAUSE_SENTENCE


class ChunkCache:
    """On-disk cache of synthesised pieces/chunks, so an interrupted chapter (PC
    turned off, a higher-priority chapter requested) resumes where it stopped."""

    def __init__(self, root: Path | None, key: str):
        self.dir = root / key if root else None

    def _path(self, text: str) -> Path | None:
        if not self.dir:
            return None
        return self.dir / (hashlib.sha1(text.encode()).hexdigest()[:20] + ".npz")

    def get(self, text: str):
        p = self._path(text)
        if p and p.exists():
            try:
                data = np.load(p)
                return data["wav"], [float(x) for x in data["starts"]]
            except Exception:
                p.unlink(missing_ok=True)
        return None

    def put(self, text: str, wav: np.ndarray, starts: list[float]) -> None:
        p = self._path(text)
        if p:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp.npz")
            np.savez(tmp, wav=wav, starts=np.array(starts))
            tmp.replace(p)


def narrate(
    engine: Engine,
    sentences: list[Sentence],
    lang: str,
    asr=None,
    cache: ChunkCache | None = None,
    should_stop: Callable[[], bool] = lambda: False,
) -> ChapterAudio | None:
    """Returns None if should_stop() turned true midway (work so far is cached)."""
    sr = engine.sample_rate
    info = engine.info
    pieces = to_pieces([s.text for s in sentences], info.max_chars)
    if info.mode == "sentence":
        chunks = [Chunk([p]) for p in pieces]
    else:
        chunks = group_chunks(pieces, info.chunk_target, info.max_chars)

    out: list[np.ndarray] = []
    pos = 0.0
    starts: dict[int, float] = {}
    ends: dict[int, float] = {}
    warnings: list[str] = []
    for ci, chunk in enumerate(chunks):
        if should_stop():
            return None
        cached = cache.get(chunk.text) if cache else None
        if cached is not None:
            wav, rel = cached
        else:
            wav, rel, warn = _synth_or_split(engine, chunk, lang, asr)
            if warn:
                warnings.append(warn)
            if cache:
                cache.put(chunk.text, wav, rel)
        for s_idx, r in zip(chunk.sentences, rel):
            starts.setdefault(s_idx, pos + r)
        pos += wav.size / sr
        out.append(wav)
        last = chunk.pieces[-1]
        ends[last.sentence] = pos
        next_piece_same_sentence = ci + 1 < len(chunks) and chunks[ci + 1].pieces[0].sentence == last.sentence
        gap = 0.12 if next_piece_same_sentence else _pause_after(sentences, last.sentence)
        out.append(silence(gap, sr))
        pos += gap

    timings: list[Timing] = []
    spoken = sorted(starts)
    for k, i in enumerate(spoken):
        end = starts[spoken[k + 1]] if k + 1 < len(spoken) else pos
        timings.append(Timing(index=i, cfi=sentences[i].cfi, start=round(starts[i], 3), end=round(end, 3)))
    wav = np.concatenate(out) if out else np.zeros(0, dtype=np.float32)
    return ChapterAudio(wav=wav, sample_rate=sr, timings=timings, warnings=warnings)


def _synth_or_split(engine: Engine, chunk: Chunk, lang: str, asr, depth: int = 0) -> tuple[np.ndarray, list[float], str | None]:
    """Synthesize a chunk; if the GPU runs out of memory on it (some chunks make
    the decoder's working set too big for the GTX 1650: 2026-10-22, chapter 15 of
    Bóvedas de acero), split it in halves and synthesize them one by one."""
    try:
        return _synth_chunk(engine, chunk, lang, asr)
    except Exception as e:
        if type(e).__name__ != "OutOfMemoryError" or depth >= 4:
            raise
    free_gpu()
    pieces = chunk.pieces
    if len(pieces) == 1:
        p = pieces[0]
        pieces = [Piece(p.sentence, t) for t in split_long(p.text, max(30, len(p.text) // 2))]
        if len(pieces) == 1:
            raise RuntimeError(f"cannot split chunk further: {p.text[:60]}")
    mid = len(pieces) // 2
    sr = engine.sample_rate
    wavs, starts, warns = [], [], []
    offset = 0.0
    seen: list[int] = []
    for half in (Chunk(pieces[:mid]), Chunk(pieces[mid:])):
        wav, rel, warn = _synth_or_split(engine, half, lang, asr, depth + 1)
        for s, r in zip(half.sentences, rel):
            if s not in seen:  # a sentence split across both halves starts in the first
                seen.append(s)
                starts.append(offset + r)
        wavs += [wav, silence(0.12, sr)]
        offset += wav.size / sr + 0.12
        if warn:
            warns.append(warn)
    log.info("chunk split after GPU out of memory (depth %d)", depth + 1)
    return np.concatenate(wavs[:-1]), starts, "; ".join(warns) or None


def _synth_chunk(engine: Engine, chunk: Chunk, lang: str, asr) -> tuple[np.ndarray, list[float], str | None]:
    sr = engine.sample_rate
    texts = _sentence_texts(chunk.pieces)
    if not engine.info.needs_qc or asr is None:
        wav = normalize(trim(engine.synth(chunk.text, lang), sr))
        return wav, _proportional_starts(texts, wav.size / sr), None

    best = None
    scores: list[float] = []
    for attempt in range(MAX_TRIES):
        temperature = max(0.35, 0.8 - 0.15 * attempt)
        wav = normalize(trim(engine.synth(chunk.text, lang, temperature=temperature), sr))
        dur = wav.size / sr
        expected = len(chunk.text) / 15.0  # ~15 characters per second of speech
        if dur < expected * 0.45 or dur > expected * 2.2:
            score, rel = 0.0, _proportional_starts(texts, dur)
        else:
            check = asr.check(wav, sr, lang, texts)
            score, rel = check.score, check.starts
        scores.append(score)
        if best is None or score > best[0]:
            best = (score, wav, rel)
        if score >= 0.80:
            break
        if len(scores) >= STABLE_AFTER and max(scores[-STABLE_AFTER:]) - min(scores[-STABLE_AFTER:]) <= STABLE_SPREAD:
            break
    score, wav, rel = best
    warn = None if score >= 0.80 else f"chunk below QC threshold ({score:.2f}): {chunk.text[:80]}"
    return wav, rel, warn


def _sentence_texts(pieces: list[Piece]) -> list[str]:
    texts: list[str] = []
    last = None
    for p in pieces:
        if p.sentence == last:
            texts[-1] += " " + p.text
        else:
            texts.append(p.text)
            last = p.sentence
    return texts


def _proportional_starts(texts: list[str], duration: float) -> list[float]:
    total = sum(len(t) for t in texts) or 1
    acc, out = 0, []
    for t in texts:
        out.append(duration * acc / total)
        acc += len(t)
    return out
