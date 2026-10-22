"""Whisper round trip for autoregressive engines: quality control and sentence
timing inside a chunk.

Lesson carried over from resumidor's XTTS pipeline: checking a finished
14-minute file does not work, Whisper uses the context to paper over the
babbling. Each ~15 s chunk is transcribed right after synthesis, compared with
its own text, and re-synthesised if it does not match. The same word
timestamps tell where each sentence starts inside the chunk.
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass

import numpy as np

ACCEPT = 0.80


def _norm_words(text: str) -> list[str]:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.findall(r"[a-z0-9ñ]+", text)


@dataclass
class Check:
    score: float
    # Start time (seconds, relative to the chunk) of each sentence in the chunk,
    # in the same order as Chunk.sentences.
    starts: list[float]


class Asr:
    def __init__(self, model: str = "small", device: str = "cpu"):
        from faster_whisper import WhisperModel

        # CPU int8 keeps the 4 GB of VRAM for the TTS model; a 15 s chunk takes
        # ~1-2 s on 12 threads, far less than the synthesis itself.
        self.model = WhisperModel(model, device=device, compute_type="int8")

    def check(self, wav: np.ndarray, sr: int, lang: str, sentence_texts: list[str]) -> Check:
        if sr != 16000:
            import librosa

            wav = librosa.resample(wav, orig_sr=sr, target_sr=16000)
        segments, _ = self.model.transcribe(
            wav.astype(np.float32), language=lang, word_timestamps=True, beam_size=1, vad_filter=False,
            condition_on_previous_text=False,
        )
        heard: list[tuple[str, float]] = []
        for seg in segments:
            for w in seg.words or []:
                for token in _norm_words(w.word):
                    heard.append((token, w.start))
        expected: list[str] = []
        first_word: list[int] = []
        for s in sentence_texts:
            first_word.append(len(expected))
            expected.extend(_norm_words(s))
        heard_words = [w for w, _ in heard]
        sm = difflib.SequenceMatcher(a=expected, b=heard_words, autojunk=False)
        score = sm.ratio() if expected else 1.0

        # Map expected word index -> heard time where they matched.
        times: dict[int, float] = {}
        for a, b, size in sm.get_matching_blocks():
            for k in range(size):
                times[a + k] = heard[b + k][1]
        duration = wav.size / 16000
        starts: list[float] = []
        for i, fw in enumerate(first_word):
            if i == 0:
                starts.append(0.0)
                continue
            t = next((times[k] for k in range(fw, min(fw + 4, len(expected))) if k in times), None)
            if t is None:  # no match nearby: proportional to text position
                t = duration * fw / max(1, len(expected))
            starts.append(max(t - 0.05, starts[-1]))
        return Check(score=score, starts=starts)
