"""Audio helpers: silence trimming, pauses and Ogg Opus encoding."""

from __future__ import annotations

from pathlib import Path

import numpy as np

# ~32 kbps mono speech Opus: ~14 MB per hour, ~150 MB for a 10 h book.
OPUS_BITRATE = 32000


def silence(seconds: float, sr: int) -> np.ndarray:
    return np.zeros(int(round(seconds * sr)), dtype=np.float32)


def trim(wav: np.ndarray, sr: int, threshold_db: float = -45.0, keep: float = 0.04) -> np.ndarray:
    """Cut leading/trailing silence so that pauses between sentences are ours
    (fixed and even) instead of whatever the model happened to emit."""
    if wav.size == 0:
        return wav
    win = max(1, int(sr * 0.01))
    n = wav.size // win
    if n == 0:
        return wav
    frames = wav[: n * win].reshape(n, win)
    rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-12)
    peak = rms.max()
    loud = np.nonzero(20 * np.log10(rms / peak + 1e-12) > threshold_db)[0]
    if loud.size == 0:
        return wav[:0]
    pad = int(keep * sr)
    start = max(0, loud[0] * win - pad)
    end = min(wav.size, (loud[-1] + 1) * win + pad)
    return wav[start:end]


def normalize(wav: np.ndarray, peak: float = 0.89) -> np.ndarray:
    m = float(np.max(np.abs(wav))) if wav.size else 0.0
    return wav if m < 1e-6 else (wav * (peak / m)).astype(np.float32)


def write_opus(path: Path, wav: np.ndarray, sr: int, bitrate: int = OPUS_BITRATE) -> None:
    import av

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    with av.open(str(tmp), mode="w", format="ogg") as out:
        stream = out.add_stream("libopus", rate=sr, layout="mono")
        stream.bit_rate = bitrate
        stream.options = {"application": "audio", "vbr": "on"}
        fifo = av.AudioFifo()
        data = np.clip(wav, -1.0, 1.0).astype(np.float32).reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(data, format="flt", layout="mono")
        frame.sample_rate = sr
        fifo.write(frame)
        frame_size = stream.codec_context.frame_size or int(sr * 0.02)
        while fifo.samples >= frame_size:
            for packet in stream.encode(fifo.read(frame_size)):
                out.mux(packet)
        rest = fifo.read()
        if rest is not None:
            pad = np.zeros((1, frame_size), dtype=np.float32)
            tail = rest.to_ndarray().reshape(1, -1)
            pad[:, : tail.shape[1]] = tail
            last = av.AudioFrame.from_ndarray(pad, format="flt", layout="mono")
            last.sample_rate = sr
            for packet in stream.encode(last):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    tmp.replace(path)
