"""Voice comparison: the same passages rendered with every candidate voice.

    uv run compare_voices.py                 # everything (Spanish + English)
    uv run compare_voices.py --lang es       # only Spanish
    uv run compare_voices.py --only kokoro   # only one engine

Writes samples/<lang>/<engine>__<voice>.opus, samples/results.json (speed,
VRAM, QC score per voice) and samples/index.html to listen side by side.

Cloning engines need reference clips in voices/. The Rioplatense ones are
generated on first run with edge-tts (Microsoft's free neural voices,
es-AR-TomasNeural and es-AR-ElenaNeural): the cloning model keeps its own
natural prosody and takes the accent from the clip — the trick that worked best
in resumidor. Drop any clean 10-20 s recording at voices/<name>.wav to try a
real voice (e.g. your own) with --refs <name>.
"""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import re
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

from worker.audio import write_opus  # noqa: E402
from worker.engines import VOICES_DIR, free_gpu, load_engine  # noqa: E402
from worker.engines.kokoro_engine import ENGLISH as KOKORO_EN  # noqa: E402
from worker.engines.kokoro_engine import SPANISH as KOKORO_ES  # noqa: E402
from worker.narrate import Sentence, narrate  # noqa: E402

ROOT = Path(__file__).parent
OUT = ROOT / "samples"

PASSAGES = {
    "es": """Llovía sobre Buenos Aires desde el mediodía, una lluvia finita y terca que no terminaba de decidirse. Martina cerró el libro, apoyó la taza en el borde de la ventana y miró la calle vacía.
—¿Vos también lo escuchaste? —preguntó sin darse vuelta.
—Escuché algo —dijo Tomás desde la cocina—, pero seguro fue el viento.
Ella no contestó. Había contado siete golpes, ni uno más ni uno menos, y el viento no sabe contar. Respiró hondo, agarró el abrigo y, antes de que él pudiera detenerla, ya estaba bajando la escalera de dos en dos. ¡Qué ganas de equivocarse, pensó, qué ganas de que fuera solamente el viento!""",
    "en": """The train was forty minutes late, which, for once, suited Eleanor perfectly. She had spent the whole night rehearsing what she would say, and every version sounded worse than the last.
"You came," her brother said when he finally spotted her on the platform. He looked older, thinner, and strangely happy.
"Of course I came. Did you really think I wouldn't?"
He laughed, the same crooked laugh she remembered from their childhood, and for a moment the twelve years between them simply disappeared. Then the whistle blew, the doors hissed open, and the moment was gone.""",
}

# Reference clips: name -> (edge-tts voice, text). ~12 s each.
REFS = {
    "ar_tomas": ("es-AR-TomasNeural", "Mirá, te voy a contar algo que me pasó el otro día, y no me lo vas a creer. Iba caminando por Corrientes, tranquilo, pensando en cualquier cosa, cuando de repente escucho que alguien me llama por mi nombre."),
    "ar_elena": ("es-AR-ElenaNeural", "Mirá, te voy a contar algo que me pasó el otro día, y no me lo vas a creer. Iba caminando por Corrientes, tranquila, pensando en cualquier cosa, cuando de repente escucho que alguien me llama por mi nombre."),
    "en_andrew": ("en-US-AndrewMultilingualNeural", "Let me tell you something that happened the other day. I was walking down the street, minding my own business, when all of a sudden someone called my name from across the road."),
    "en_sonia": ("en-GB-SoniaNeural", "Let me tell you something that happened the other day. I was walking down the street, minding my own business, when all of a sudden someone called my name from across the road."),
}


def candidates(lang: str, refs_es: list[str], refs_en: list[str]) -> list[str]:
    if lang == "es":
        return (
            [f"kokoro:{v}" for v in KOKORO_ES]
            + [f"chatterbox-latam:{r}" for r in refs_es]
            + [f"chatterbox-v3:{r}" for r in refs_es]
        )
    return [f"kokoro:{v}" for v in KOKORO_EN] + [f"chatterbox-v3:{r}" for r in refs_en]


def sentences_of(passage: str) -> list[Sentence]:
    out: list[Sentence] = []
    for block, line in enumerate(passage.strip().splitlines()):
        for s in re.split(r"(?<=[.!?])\s+(?=[—\"A-ZÁÉÍÓÚÑ¿¡])", line.strip()):
            if s.strip():
                out.append(Sentence(text=s.strip(), cfi=f"demo-{len(out)}", block=block))
    return out


def ensure_ref(name: str) -> Path:
    path = VOICES_DIR / f"{name}.wav"
    if path.exists():
        return path
    if name not in REFS:
        raise SystemExit(f"Missing reference clip {path} (put a 10-20 s clean recording there).")
    import edge_tts
    import soundfile as sf

    voice, text = REFS[name]
    mp3 = path.with_suffix(".mp3")
    print(f"  generating reference {name} with edge-tts ({voice})")
    asyncio.run(edge_tts.Communicate(text, voice, rate="-5%").save(str(mp3)))
    wav, sr = _decode(mp3)
    sf.write(path, wav, sr)
    mp3.unlink()
    return path


def _decode(path: Path) -> tuple[np.ndarray, int]:
    import av

    with av.open(str(path)) as f:
        stream = f.streams.audio[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=24000)
        chunks = []
        for frame in f.decode(stream):
            for r in resampler.resample(frame):
                chunks.append(r.to_ndarray().reshape(-1))
    return np.concatenate(chunks), 24000


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lang", choices=["es", "en", "all"], default="all")
    ap.add_argument("--only", help="engine name (kokoro, chatterbox-v3, chatterbox-latam)")
    ap.add_argument("--refs", help="comma-separated reference clips to clone (default: built-in ones)")
    ap.add_argument("--no-qc", action="store_true", help="skip the Whisper round trip")
    args = ap.parse_args()

    langs = ["es", "en"] if args.lang == "all" else [args.lang]
    refs_es = args.refs.split(",") if args.refs else ["ar_tomas", "ar_elena"]
    refs_en = args.refs.split(",") if args.refs else ["en_andrew", "en_sonia"]
    jobs: dict[str, list[tuple[str, str]]] = {}  # engine -> [(lang, voice_id)]
    for lang in langs:
        for vid in candidates(lang, refs_es, refs_en):
            engine = vid.split(":")[0]
            if args.only and engine != args.only:
                continue
            jobs.setdefault(engine, []).append((lang, vid))

    results_path = OUT / "results.json"
    results = json.loads(results_path.read_text(encoding="utf-8")) if results_path.exists() else {}
    asr = None
    for engine_name, items in jobs.items():
        print(f"\n== {engine_name} ==")
        if engine_name != "kokoro":
            for _, vid in items:
                ensure_ref(vid.split(":")[1])
            if not args.no_qc and asr is None:
                from worker.asr import Asr

                asr = Asr()
        import torch

        t0 = time.time()
        engine = load_engine(items[0][1])
        load_s = time.time() - t0
        for lang, vid in items:
            engine.set_voice(vid.split(":")[1])
            if torch.cuda.is_available():
                torch.cuda.reset_peak_memory_stats()
            t0 = time.time()
            audio = narrate(engine, sentences_of(PASSAGES[lang]), lang, asr=asr if engine.info.needs_qc else None)
            secs = time.time() - t0
            dur = audio.wav.size / audio.sample_rate
            out = OUT / lang / (vid.replace(":", "__") + ".opus")
            write_opus(out, audio.wav, audio.sample_rate)
            vram = torch.cuda.max_memory_allocated() / 2**30 if torch.cuda.is_available() else 0
            results[vid + "@" + lang] = {
                "voice": vid, "lang": lang, "file": str(out.relative_to(OUT)), "audio_s": round(dur, 1),
                "synth_s": round(secs, 1), "realtime_x": round(dur / secs, 2), "vram_gb": round(vram, 2),
                "load_s": round(load_s, 1), "warnings": audio.warnings, "kb": out.stat().st_size // 1024,
            }
            print(f"  {vid:32s} {lang}  {dur:5.1f}s audio in {secs:5.1f}s  ({dur / secs:4.1f}x realtime, {vram:.2f} GB VRAM)"
                  + (f"  [{len(audio.warnings)} QC warnings]" if audio.warnings else ""))
        engine.close()
        del engine
        free_gpu()

    OUT.mkdir(exist_ok=True)
    results_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    write_index(results)
    print(f"\nListen: {OUT / 'index.html'}")


def write_index(results: dict) -> None:
    rows = []
    for lang in ("es", "en"):
        items = [r for r in results.values() if r["lang"] == lang]
        if not items:
            continue
        rows.append(f"<h2>{'Español' if lang == 'es' else 'English'}</h2>")
        for r in items:
            rows.append(
                f"<div class=row><b>{html.escape(r['voice'])}</b>"
                f"<span>{r['realtime_x']}× tiempo real · {r['vram_gb']} GB VRAM · {r['kb']} KB</span>"
                f"<audio controls preload=none src='{html.escape(r['file'])}'></audio></div>"
            )
    (OUT / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><title>Voces</title><style>body{font:15px system-ui;max-width:720px;"
        "margin:24px auto;padding:0 16px;background:#ECEFF4;color:#2E3440}.row{background:#FAFBFC;border-radius:16px;"
        "padding:12px 14px;margin:8px 0;display:flex;flex-direction:column;gap:6px}span{color:#7A869B;font-size:13px}"
        "audio{width:100%}</style><h1>Comparación de voces</h1>" + "".join(rows),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
