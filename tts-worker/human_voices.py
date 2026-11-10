"""Human reference clips for the cloned Spanish voices.

    uv run human_voices.py            # build voices/ar_mateo.wav and voices/ar_lucia.wav
    uv run human_voices.py --keep     # keep the downloaded archives in work/slr61

A cloned voice sounds like its reference: the first clips were made with a
synthetic voice (edge-tts) and the narration sounded like a machine. These come
from real Argentine speakers in Google's crowdsourced set, OpenSLR 61
(https://www.openslr.org/61/, CC BY-SA 4.0: Guevara-Rukoz et al., "Crowdsourcing
Latin American Spanish for Low-Resource Text-to-Speech", LREC 2020). The user
picked these two by ear on 2026-11-10 out of six.

Each clip is the speaker's longest recordings, silence trimmed, joined with
0.3 s pauses up to about 16 s. The archives are 0.55 GB (male) and 1.26 GB
(female) and are deleted afterwards unless --keep is given.
"""

from __future__ import annotations

import argparse
import io
import urllib.request
import wave
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).parent
BASE = "https://www.openslr.org/resources/61"
# voice name -> (archive, file prefix, speaker id)
VOICES = {
    "ar_mateo": ("es_ar_male.zip", "arm", "03397"),
    "ar_lucia": ("es_ar_female.zip", "arf", "04766"),
}
TARGET_SECONDS = 15.0
PAUSE = 0.3


def trimmed(raw: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(raw)) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    loud = np.nonzero(np.abs(x) > 0.02)[0]
    if loud.size == 0:
        return x[:0], sr
    return x[max(0, loud[0] - int(0.05 * sr)): loud[-1] + int(0.1 * sr)], sr


def build(archive: Path, prefix: str, speaker: str) -> tuple[np.ndarray, int]:
    with zipfile.ZipFile(archive) as z:
        # Sorted names, then longest first with the name as tie-break: the same clip every time.
        clips = sorted(((trimmed(z.read(n)), n) for n in sorted(z.namelist()) if n.startswith(f"{prefix}_{speaker}_")),
                       key=lambda c: (-c[0][0].size, c[1]))
    parts: list[np.ndarray] = []
    total, sr = 0.0, clips[0][0][1]
    for (x, sr), _ in clips[:12]:
        if total > TARGET_SECONDS:
            break
        parts += [x, np.zeros(int(PAUSE * sr), np.float32)]
        total += x.size / sr + PAUSE
    y = np.concatenate(parts)
    return y / np.abs(y).max() * 0.89, sr


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--keep", action="store_true", help="keep the downloaded archives")
    ap.add_argument("--archives", type=Path, default=ROOT / "work" / "slr61", help="where the archives are or go")
    args = ap.parse_args()
    args.archives.mkdir(parents=True, exist_ok=True)
    (ROOT / "voices").mkdir(exist_ok=True)
    for name, (archive, prefix, speaker) in VOICES.items():
        path = args.archives / archive
        if not path.exists():
            print(f"downloading {archive}…", flush=True)
            urllib.request.urlretrieve(f"{BASE}/{archive}", path)
        y, sr = build(path, prefix, speaker)
        out = ROOT / "voices" / f"{name}.wav"
        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((y * 32767).astype(np.int16).tobytes())
        print(f"{out.name}: {y.size / sr:.1f} s, speaker {speaker}")
        if not args.keep:
            path.unlink()


if __name__ == "__main__":
    main()
