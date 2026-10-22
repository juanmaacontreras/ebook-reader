"""TTS engines. Each one turns a short text into float32 mono samples.

A voice is identified everywhere (database, app, file names) by a string
"<engine>:<voice>", e.g. "kokoro:ef_dora" or "chatterbox-latam:ar_tomas".
For cloning engines the voice part names a reference clip in voices/<voice>.wav.
"""

from __future__ import annotations

import gc
from dataclasses import dataclass
from pathlib import Path

import numpy as np

VOICES_DIR = Path(__file__).resolve().parents[2] / "voices"


@dataclass
class EngineInfo:
    name: str
    # "sentence": synthesise every sentence on its own (timings are exact).
    # "chunk": group sentences into ~200-char chunks (autoregressive models
    # hallucinate on short inputs) and recover sentence timings by alignment.
    mode: str
    # Autoregressive engines can babble; their chunks go through ASR round-trip QC.
    needs_qc: bool
    max_chars: int
    chunk_target: int = 0


class Engine:
    info: EngineInfo
    sample_rate: int

    def synth(self, text: str, lang: str, temperature: float | None = None) -> np.ndarray:
        raise NotImplementedError

    def set_voice(self, voice: str) -> None:
        raise NotImplementedError

    def close(self) -> None:
        pass


ENGINES = ("kokoro", "chatterbox-v3", "chatterbox-latam")


def parse_voice(voice_id: str) -> tuple[str, str]:
    engine, _, voice = voice_id.partition(":")
    if engine not in ENGINES or not voice:
        raise ValueError(f"unknown voice id {voice_id!r}")
    return engine, voice


def load_engine(voice_id: str, device: str = "cuda") -> Engine:
    engine, voice = parse_voice(voice_id)
    if engine == "kokoro":
        from .kokoro_engine import KokoroEngine

        return KokoroEngine(voice, device)
    from .chatterbox_engine import ChatterboxEngine

    return ChatterboxEngine(engine, voice, device)


def free_gpu() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
