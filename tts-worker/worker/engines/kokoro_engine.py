"""Kokoro-82M: fast, non-autoregressive, no cloning. The default engine.

Voice names carry their language in the first letter (a = US English,
b = British English, e = Spanish), which is also Kokoro's pipeline code.
"""

from __future__ import annotations

import numpy as np

from . import Engine, EngineInfo

REPO = "hexgrad/Kokoro-82M"

SPANISH = ["ef_dora", "em_alex", "em_santa"]
ENGLISH = ["af_heart", "af_bella", "af_nicole", "am_michael", "am_fenrir", "bf_emma", "bm_george", "bm_fable"]


class KokoroEngine(Engine):
    sample_rate = 24000
    # Non-English text is phonemised by espeak and silently truncated past 510
    # phonemes; 300 characters stays well under that.
    info = EngineInfo(name="kokoro", mode="sentence", needs_qc=False, max_chars=300)

    def __init__(self, voice: str, device: str = "cuda"):
        import torch
        from kokoro import KModel, KPipeline

        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"
        self.model = KModel(repo_id=REPO).to(device).eval()
        self.pipelines: dict[str, KPipeline] = {}
        self._make_pipeline = lambda code: KPipeline(lang_code=code, repo_id=REPO, model=self.model)
        self.set_voice(voice)

    def set_voice(self, voice: str) -> None:
        code = voice[0]
        if code not in self.pipelines:
            self.pipelines[code] = self._make_pipeline(code)
        self.pipeline = self.pipelines[code]
        self.pipeline.load_voice(voice)
        self.voice = voice

    def synth(self, text: str, lang: str, temperature: float | None = None) -> np.ndarray:
        parts = []
        # split_pattern=None: the worker already hands over one sentence (or one
        # piece of a long sentence); Kokoro must not split it again.
        for result in self.pipeline(text, voice=self.voice, speed=1.0, split_pattern=None):
            if result.audio is not None:
                parts.append(result.audio.detach().cpu().numpy())
        if not parts:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(parts).astype(np.float32)

    def close(self) -> None:
        del self.pipeline, self.pipelines, self.model
