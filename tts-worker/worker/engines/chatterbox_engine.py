"""Chatterbox Multilingual V3 (Resemble AI, MIT): zero-shot voice cloning.

Two checkpoints share the same code and decoder:
  chatterbox-v3     the general multilingual model (Spanish and English)
  chatterbox-latam  Resemble's Latin American Spanish finetune (Spanish only)

The voice is cloned from voices/<voice>.wav (5-20 s of clean speech). A
Rioplatense reference is what gives the narration its accent.

The checkpoints are assembled file by file instead of via the library's
from_pretrained(): the LatAm finetune lives in its own repository and only ships
the T3 weights, and from_local() always loads the V2 decoder.
"""

from __future__ import annotations

import numpy as np

from . import VOICES_DIR, Engine, EngineInfo

BASE_REPO = "ResembleAI/chatterbox"
CHECKPOINTS = {
    "chatterbox-v3": (BASE_REPO, "t3_mtl23ls_v3.safetensors"),
    "chatterbox-latam": ("ResembleAI/Chatterbox-Multilingual-es-mx-latam", "t3_es_mx_latam.safetensors"),
}


def _fetch(repo: str, filename: str) -> str:
    from huggingface_hub import hf_hub_download

    return hf_hub_download(repo_id=repo, filename=filename)


class ChatterboxEngine(Engine):
    sample_rate = 24000

    def __init__(self, engine: str, voice: str, device: str = "cuda"):
        import torch
        from chatterbox.models.s3gen import S3Gen
        from chatterbox.models.t3 import T3
        from chatterbox.models.t3.modules.t3_config import T3Config
        from chatterbox.models.tokenizers import MTLTokenizer
        from chatterbox.models.voice_encoder import VoiceEncoder
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        from safetensors.torch import load_file

        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"
        self.info = EngineInfo(name=engine, mode="chunk", needs_qc=True, max_chars=260, chunk_target=190)
        t3_repo, t3_file = CHECKPOINTS[engine]

        loc = None if device == "cuda" else torch.device("cpu")
        ve = VoiceEncoder()
        ve.load_state_dict(torch.load(_fetch(BASE_REPO, "ve.pt"), map_location=loc, weights_only=True))
        ve.to(device).eval()

        t3 = T3(T3Config.multilingual())
        state = load_file(_fetch(t3_repo, t3_file))
        if "model" in state:
            state = state["model"][0]
        t3.load_state_dict(state)
        del state
        if device == "cuda":
            # fp32 T3 (2 GB) plus the decoder (1 GB) does not fit in the GTX 1650's
            # 4 GB next to the desktop. Half precision weights + autocast for the
            # token generation; the decoder stays fp32 (audio quality).
            t3.half()
            _inference = t3.inference

            def inference_fp16(*args, **kwargs):
                with torch.autocast("cuda", dtype=torch.float16):
                    return _inference(*args, **kwargs)

            t3.inference = inference_fp16
        t3.to(device).eval()

        s3gen = S3Gen()
        # The V3 decoder checkpoint leaves out the tokenizer's mel filterbank and
        # window, which are fixed buffers the constructor already computes.
        result = s3gen.load_state_dict(
            torch.load(_fetch(BASE_REPO, "s3gen_v3.pt"), map_location=loc, weights_only=True), strict=False
        )
        unexpected_missing = set(result.missing_keys) - {"tokenizer._mel_filters", "tokenizer.window"}
        if unexpected_missing or result.unexpected_keys:
            raise RuntimeError(f"s3gen_v3 mismatch: {unexpected_missing} {result.unexpected_keys}")
        s3gen.to(device).eval()

        tokenizer = MTLTokenizer(_fetch(BASE_REPO, "grapheme_mtl_merged_expanded_v1.json"))
        self.model = ChatterboxMultilingualTTS(t3, s3gen, ve, tokenizer, device)
        self.set_voice(voice)

    def set_voice(self, voice: str) -> None:
        ref = VOICES_DIR / f"{voice}.wav"
        if not ref.exists():
            raise FileNotFoundError(f"reference clip not found: {ref}")
        self.model.prepare_conditionals(str(ref), exaggeration=0.5)
        self.voice = voice

    def synth(self, text: str, lang: str, temperature: float | None = None) -> np.ndarray:
        import torch

        with torch.inference_mode():
            wav = self.model.generate(
                text,
                language_id=lang,
                exaggeration=0.5,
                cfg_weight=0.5,
                temperature=temperature if temperature is not None else 0.8,
            )
        return wav.squeeze(0).cpu().numpy().astype(np.float32)

    def close(self) -> None:
        del self.model
