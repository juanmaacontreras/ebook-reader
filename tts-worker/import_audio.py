"""Attach narration audio made elsewhere to a book in the library.

    uv run python import_audio.py transcribe FILE.mp3 ...
    uv run python import_audio.py attach "Book title" --voice xtts:tomas FILE.mp3 ...

For audiobooks whose text is the book's own text, made by another pipeline
(resumidor's XTTS audiobooks, the first case). `transcribe` runs Whisper with
word timestamps and caches the words (work/import/); `attach` (transcribing
first if needed) works out which chapter each file belongs to by its words,
aligns the chapter's manifest sentences against them (worker/align.py),
encodes Ogg Opus like the worker's own audio, uploads it and writes the
`narration_chapters` rows plus a 'ready' narration with that voice. The
narration is not a job (no started_at), so the worker never touches it; a new
"Generar ahora" with another voice replaces it as usual.

Signs in with the worker's session (.session.json). The refresh token rotates,
so stop the service first (systemctl --user stop atril-tts) and start it again
afterwards: two processes refreshing the same token would sign the worker out.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from worker.align import Word, likeness, norm_words, sentence_times
from worker.main import ROOT, load_env, slug, supabase_config
from worker.supa import Supabase

CACHE = ROOT / "work" / "import"


def file_key(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def duration_of(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


_model = None


def transcribe(path: Path, lang: str = "es") -> dict:
    cached = CACHE / f"{file_key(path)}.json"
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        # CPU int8: leaves the GPU to the desktop (and to the worker).
        _model = WhisperModel("small", device="cpu", compute_type="int8")
    print(f"transcribing {path.name} ...", flush=True)
    # Decoded here: the PyAV pinned for the worker is newer than faster-whisper's decoder expects.
    import numpy as np

    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    segments, _ = _model.transcribe(np.frombuffer(pcm, dtype=np.float32), language=lang, word_timestamps=True, beam_size=1,
                                    condition_on_previous_text=False)
    words: list[Word] = []
    for seg in segments:
        for w in seg.words or []:
            for token in norm_words(w.word):
                words.append((token, round(w.start, 3), round(w.end, 3)))
    data = {"file": path.name, "duration": duration_of(path), "words": words}
    CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def to_opus(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "24000",
                    "-c:a", "libopus", "-b:a", "32k", "-application", "audio", str(dst)], check=True)


def attach(title: str, voice: str, files: list[Path], min_match: float) -> None:
    load_env()
    url, key = supabase_config()
    db = Supabase(url, key, ROOT / ".session.json")
    if not db.signed_in():
        sys.exit("this PC is not linked: run the worker once and sign in")
    books = db.select("books", {"select": "*", "title": f"eq.{title}"}) or db.select("books", {"select": "*", "id": f"eq.{title}"} if len(title) == 36 else {"select": "*", "title": f"ilike.*{title}*"})
    if len(books) != 1:
        sys.exit(f"expected one book matching {title!r}, found {len(books)}")
    book = books[0]
    manifest = db.download_json_gz("library", book["text_path"])
    sections = [s for s in manifest["sections"] if s.get("sentences")]
    lang = manifest.get("lang", "es")

    # Which chapter each file is: the best bag-of-words match, one file per chapter.
    plan: dict[int, tuple[Path, dict]] = {}
    for f in files:
        tr = transcribe(f, lang)
        scored = sorted(((likeness([x["t"] for x in s["sentences"]], tr["words"]), s["i"]) for s in sections), reverse=True)
        score, i = scored[0]
        if score < 0.7:
            sys.exit(f"{f.name}: no chapter looks like it (best {score:.2f})")
        if i in plan:
            sys.exit(f"{f.name} and {plan[i][0].name} both look like section {i}")
        plan[i] = (f, tr)

    rows = []
    for s in sections:
        if s["i"] not in plan:
            continue
        f, tr = plan[s["i"]]
        times, matched = sentence_times([x["t"] for x in s["sentences"]], [tuple(w) for w in tr["words"]], tr["duration"])
        print(f"section {s['i']:>2} {s.get('label', '')[:40]:<40} ← {f.name}: {len(times)} sentences, {matched:.0%} of words matched")
        if matched < min_match:
            sys.exit(f"  too few words matched (< {min_match:.0%}): is this the same text?")
        out = ROOT / "work" / "out" / f"import-{book['id']}-{s['i']}.opus"
        to_opus(f, out)
        rows.append((s, out, tr["duration"], times))

    for s, out, duration, times in rows:
        data = out.read_bytes()
        path = f"{book['user_id']}/{book['id']}/{slug(voice)}/{s['i']}.opus"
        db.upload("audio", path, data, "audio/ogg")
        db.upsert("narration_chapters", {
            "book_id": book["id"], "user_id": book["user_id"], "voice": voice, "section": s["i"],
            "audio_path": path, "duration": round(duration, 3), "bytes": len(data),
            "timings": [{"i": k, "cfi": x["c"], "s": a, "e": b} for k, (x, (a, b)) in enumerate(zip(s["sentences"], times))],
        }, "book_id,voice,section")
        out.unlink(missing_ok=True)

    now = datetime.now(timezone.utc).isoformat()
    db.upsert("narrations", {
        "book_id": book["id"], "user_id": book["user_id"], "voice": voice, "status": "active", "scope": "all",
        "start_section": None, "priority_section": None, "started_at": None, "requested_at": now,
        "updated_at": now, "state": "ready", "current_section": None, "error": None,
    }, "book_id")
    print(f"done: {len(rows)} chapters of {book['title']!r} with voice {voice}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("transcribe")
    t.add_argument("files", nargs="+", type=Path)
    a = sub.add_parser("attach")
    a.add_argument("book", help="exact title (or id, or part of the title)")
    a.add_argument("files", nargs="+", type=Path)
    a.add_argument("--voice", required=True, help="voice id shown in the app, e.g. xtts:tomas")
    a.add_argument("--min-match", type=float, default=0.6)
    args = p.parse_args()
    if args.cmd == "transcribe":
        for f in args.files:
            d = transcribe(f)
            print(f"{f.name}: {len(d['words'])} words, {d['duration'] / 60:.1f} min")
    else:
        attach(args.book, args.voice, args.files, args.min_match)


if __name__ == "__main__":
    main()
