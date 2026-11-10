"""What is wrong with a synthesised chunk, from what Whisper heard of it (stdlib only).

The first check was one number: how alike the expected and the heard words are over the whole
chunk, accepted from 0.80. A chunk of thirty words with four babbled ones at the end scores
0.94, and babbling Whisper writes down as nothing doesn't lower it at all. So, besides the
score: words heard before the text starts or after it ends, a word said over and over, and
sound that goes on after the last word (or between two words) with nothing recognised in it.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field

# Words alike, whole chunk. 0.80 and not higher: spelled-out notation ("efe sub ese",
# "ele niveles") is misheard by the recogniser on clean audio. Measured 2026-11-10 on 110
# minutes of study narration: the median chunk scores 0.90 and 40% fall under 0.88. The
# other rules (sound that is no word, extra words, repeats) are what catch babbling.
ACCEPT = 0.80
MAX_EXTRA = 1          # words heard before the first / after the last expected one
MAX_TAIL = 0.6         # seconds of sound after the last word
MAX_HEAD = 0.6         # ...before the first one
MAX_GAP = 1.2          # ...between two words, with nothing recognised
MAX_REPEAT = 3         # the same word in a row, when the text doesn't


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Verdict:
    score: float
    issues: list[str] = field(default_factory=list)
    # Where the text's own speech starts and ends in the chunk (None: nothing matched): what is
    # outside can be cut off when the words themselves are right.
    speech: tuple[float, float] | None = None
    # expected word index -> time it was heard at
    times: dict[int, float] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.issues


def _voiced_seconds(voiced: list[bool], frame: float, start: float, end: float) -> float:
    a, b = max(0, int(start / frame)), min(len(voiced), int(end / frame))
    return sum(voiced[a:b]) * frame if b > a else 0.0


def _longest_run(words: list[str]) -> int:
    best = run = 0
    last = None
    for w in words:
        run = run + 1 if w == last else 1
        last = w
        best = max(best, run)
    return best


def judge(expected: list[str], heard: list[Word], voiced: list[bool], frame: float) -> Verdict:
    """expected: the text's words, normalised; heard: Whisper's, normalised the same way, with
    times; voiced: one flag per `frame` seconds of the chunk, True where there is sound."""
    if not expected:
        return Verdict(score=1.0)
    heard_words = [w.text for w in heard]
    sm = difflib.SequenceMatcher(a=expected, b=heard_words, autojunk=False)
    v = Verdict(score=sm.ratio())
    blocks = [b for b in sm.get_matching_blocks() if b.size]
    for a, b, size in blocks:
        for k in range(size):
            v.times[a + k] = heard[b + k].start
    if v.score < ACCEPT:
        v.issues.append(f"words {v.score:.2f}")
    if not blocks:
        return v
    first, last = blocks[0].b, blocks[-1].b + blocks[-1].size - 1
    # Words of the text itself that were misheard at either end are not extra speech.
    extra_head = max(0, first - blocks[0].a)
    extra_tail = max(0, (len(heard) - 1 - last) - (len(expected) - 1 - (blocks[-1].a + blocks[-1].size - 1)))
    if extra_head > MAX_EXTRA:
        v.issues.append(f"{extra_head} words before the text")
    if extra_tail > MAX_EXTRA:
        v.issues.append(f"{extra_tail} words after the text")
    if _longest_run(heard_words) >= MAX_REPEAT > _longest_run(expected):
        v.issues.append("a word repeated")
    duration = len(voiced) * frame
    start = heard[0].start if not extra_head else heard[first].start
    end = heard[-1].end if not extra_tail else heard[last].end
    v.speech = (start, end)
    head = _voiced_seconds(voiced, frame, 0.0, heard[0].start - 0.1)
    tail = _voiced_seconds(voiced, frame, heard[-1].end + 0.15, duration)
    if head > MAX_HEAD:
        v.issues.append(f"{head:.1f} s of sound before the first word")
        v.speech = (max(0.0, heard[0].start - 0.1), v.speech[1])
    if tail > MAX_TAIL:
        v.issues.append(f"{tail:.1f} s of sound after the last word")
    gap = max((_voiced_seconds(voiced, frame, a.end + 0.15, b.start - 0.1) for a, b in zip(heard, heard[1:])), default=0.0)
    if gap > MAX_GAP:
        v.issues.append(f"{gap:.1f} s of sound between two words, nothing recognised")
    return v


def only_outside(v: Verdict) -> bool:
    """The words are right and the only trouble is sound before or after them: cutting works."""
    return bool(v.issues) and v.speech is not None and all(
        ("before the" in i or "after the" in i) for i in v.issues)
