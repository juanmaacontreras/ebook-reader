"""The narration worker: watches Supabase and turns books into audio, one
chapter at a time, on this PC's GPU.

    uv run python -m worker            (or ./run.sh / run.bat)

Loop:
  1. Heartbeat: worker_status (voices available, what it's doing).
  2. Sweep: finished books lose their audio in Storage (regenerable later).
  3. Job: the oldest active narration with chapters still missing. Next
     chapter = the one the user jumped to (priority_section), else the next
     one after where they were; wraps around to the start of the book.
  4. Synthesize → Opus → upload → narration_chapters row. Repeat.

Resumable: a chapter is done only when its row exists; inside a chapter every
chunk is cached on disk (work/chunks), so after a power cut it picks up the
same chapter where it stopped. While a chapter is being generated the worker
checks every ~20 s whether the user asked for a different one, and switches.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .audio import write_opus
from .engines import ENGINES, VOICES_DIR, free_gpu, load_engine, parse_voice
from .engines.kokoro_engine import ENGLISH as KOKORO_EN
from .engines.kokoro_engine import SPANISH as KOKORO_ES
from .narrate import ChunkCache, Sentence, narrate
from .supa import Supabase

ROOT = Path(__file__).resolve().parents[1]
log = logging.getLogger("worker")


def load_env() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


def supabase_config() -> tuple[str, str]:
    """URL and publishable key: from .env if set, else the app's own config
    (they are public by design; RLS protects the data)."""
    url, key = os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_KEY", "")
    if not (url and key):
        import re

        cfg = (ROOT.parent / "client" / "src" / "config.ts").read_text(encoding="utf-8")
        url = url or (re.search(r"SUPABASE_URL = '([^']*)'", cfg) or [None, ""])[1]
        key = key or (re.search(r"SUPABASE_KEY = '([^']*)'", cfg) or [None, ""])[1]
    return url, key


LINK_PORT = 8765
LINK_PAGE = """<!doctype html><html lang=es><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Vincular PC</title><style>body{{font:15px system-ui;background:#ECEFF4;color:#2E3440;margin:0}}
main{{max-width:380px;margin:12vh auto;padding:24px;background:#FAFBFC;border-radius:28px;box-shadow:0 2px 8px rgba(46,52,64,.06)}}
h1{{font-size:24px;font-weight:800;letter-spacing:-.5px;margin:0 0 8px}}p{{color:#4C566A}}
input{{width:100%;box-sizing:border-box;padding:13px 14px;border:2px solid transparent;border-radius:14px;background:#E5E9F0;font:inherit;font-size:16px;margin:6px 0}}
input:focus{{outline:none;border-color:#5E81AC;background:#fff}}button{{width:100%;height:46px;border:0;border-radius:23px;background:#5E81AC;color:#fff;font:inherit;font-weight:700;margin-top:10px}}
.e{{color:#BF616A;font-weight:600}}</style><main><h1>Vincular esta PC</h1>
<p>Entrá con la misma cuenta que usás en Atril. Es una sola vez: después la PC genera el audio sola.</p>
<form method=post><input name=email type=email placeholder=Correo required><input name=password type=password placeholder=Contraseña required>
<p class=e>{error}</p><button>Entrar</button></form></main></html>"""


def sign_in_interactive(db: Supabase) -> None:
    """First run on a PC: a small local page (http://127.0.0.1:8765) to sign in
    with the app's account. The password is sent only to Supabase; what stays
    on disk is the refresh token (.session.json)."""
    import webbrowser
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import parse_qs

    from .supa import AuthError

    class Handler(BaseHTTPRequestHandler):
        def _page(self, html: str) -> None:
            body = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            self._page(LINK_PAGE.format(error=""))

        def do_POST(self) -> None:
            form = parse_qs(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
            try:
                db.sign_in(form.get("email", [""])[0].strip(), form.get("password", [""])[0])
            except AuthError as e:
                self._page(LINK_PAGE.format(error=f"No se pudo entrar: {e}"))
                return
            self._page(LINK_PAGE.format(error="").split("<form")[0].replace("Vincular esta PC", "PC vinculada") + "<p>Listo, ya podés cerrar esta pestaña.</p></main></html>")

        def log_message(self, *args) -> None:
            pass

    server = HTTPServer(("127.0.0.1", LINK_PORT), Handler)
    url = f"http://127.0.0.1:{LINK_PORT}"
    log.info("not signed in yet: open %s to link this PC", url)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    while not db.signed_in():
        server.handle_request()
    server.server_close()
    log.info("signed in")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slug(voice: str) -> str:
    return "".join(c if c.isalnum() or c in "_-" else "_" for c in voice)


KOKORO_NAMES = {
    "ef_dora": "Dora", "em_alex": "Alex", "em_santa": "Santa", "af_heart": "Heart", "af_bella": "Bella",
    "af_nicole": "Nicole", "am_michael": "Michael", "am_fenrir": "Fenrir", "bf_emma": "Emma",
    "bm_george": "George", "bm_fable": "Fable",
}
CLONE_LABELS = {"ar_tomas": "Tomás (rioplatense)", "ar_elena": "Elena (rioplatense)", "en_andrew": "Andrew", "en_sonia": "Sonia"}


def available_voices() -> list[dict]:
    """What the app can offer: Kokoro's voices plus every reference clip in
    voices/ for each cloning engine (LatAm only for Spanish clips)."""
    voices = [{"id": f"kokoro:{v}", "label": KOKORO_NAMES.get(v, v), "languages": ["es"], "cloned": False} for v in KOKORO_ES]
    voices += [{"id": f"kokoro:{v}", "label": KOKORO_NAMES.get(v, v), "languages": ["en"], "cloned": False} for v in KOKORO_EN]
    for ref in sorted(VOICES_DIR.glob("*.wav")):
        name = ref.stem
        label = CLONE_LABELS.get(name, name.replace("_", " ").title())
        lang = "en" if name.startswith("en_") else "es"
        if lang == "es":
            voices.append({"id": f"chatterbox-latam:{name}", "label": f"{label} · LatAm", "languages": ["es"], "cloned": True})
        voices.append({"id": f"chatterbox-v3:{name}", "label": label, "languages": [lang], "cloned": True})
    return voices


class Worker:
    def __init__(self) -> None:
        load_env()
        url, key = supabase_config()
        if not url or not key:
            sys.exit("Supabase is not configured yet (client/src/config.ts is empty). See CLAUDE.md.")
        self.db = Supabase(url, key, ROOT / ".session.json")
        if not self.db.signed_in():
            sign_in_interactive(self.db)
        self.work = Path(os.environ.get("WORK_DIR", ROOT / "work"))
        self.work.mkdir(parents=True, exist_ok=True)
        self.max_audio = int(os.environ.get("MAX_AUDIO_MB", "700")) * 1_000_000
        self.poll = float(os.environ.get("POLL_SECONDS", "15"))
        self.engine = None
        self.engine_voice: str | None = None
        self.asr = None
        self.last_beat = 0.0
        self.current: dict | None = None
        self.stop = False

    # ---- helpers ------------------------------------------------------------------
    def users(self) -> list[str]:
        return [self.db.user_id]

    def heartbeat(self, force: bool = False) -> None:
        if not force and time.time() - self.last_beat < 30:
            return
        self.last_beat = time.time()
        try:
            audio = self.db.select("narration_chapters", {"select": "user_id,bytes"})
            voices = available_voices()
            for uid in self.users():
                used = sum(r["bytes"] for r in audio if r["user_id"] == uid)
                self.db.upsert("worker_status", {"user_id": uid, "heartbeat": now_iso(), "voices": voices,
                                                 "current": self.current, "audio_bytes": used}, "user_id")
        except Exception as e:  # never die because of a heartbeat
            log.warning("heartbeat failed: %s", e)

    def use_engine(self, voice: str):
        if self.engine_voice == voice:
            return self.engine
        engine_name, name = parse_voice(voice)
        if self.engine is not None and self.engine.info.name == engine_name:
            self.engine.set_voice(name)
        else:
            if self.engine is not None:
                self.engine.close()
                self.engine = None
                free_gpu()
            log.info("loading %s", engine_name)
            self.engine = load_engine(voice)
        self.engine_voice = voice
        if self.engine.info.needs_qc and self.asr is None:
            from .asr import Asr
            self.asr = Asr(os.environ.get("ASR_MODEL", "small"))
        return self.engine

    def manifest(self, book: dict) -> dict:
        cache = self.work / "manifests" / f"{book['id']}.json"
        if cache.exists():
            return json.loads(cache.read_text(encoding="utf-8"))
        m = self.db.download_json_gz("library", book["text_path"])
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
        return m

    def purge(self, book_id: str, voice: str | None = None, keep_voice: str | None = None) -> int:
        params = {"select": "voice,section,audio_path", "book_id": f"eq.{book_id}"}
        rows = self.db.select("narration_chapters", params)
        rows = [r for r in rows if (voice is None or r["voice"] == voice) and r["voice"] != keep_voice]
        if not rows:
            return 0
        self.db.remove("audio", [r["audio_path"] for r in rows])
        for r in rows:
            self.db.delete("narration_chapters", {"book_id": book_id, "voice": r["voice"], "section": str(r["section"])})
        shutil.rmtree(self.work / "chunks" / book_id, ignore_errors=True)
        return len(rows)

    # ---- sweep ----------------------------------------------------------------------
    def sweep_finished(self) -> None:
        finished = self.db.select("books", {"select": "id", "status": "eq.finished"})
        for b in finished:
            n = self.purge(b["id"])
            if n:
                log.info("book %s finished: removed %d audio chapters", b["id"], n)
            for row in self.db.select("narrations", {"select": "state", "book_id": f"eq.{b['id']}"}):
                if row["state"] != "purged":
                    self.db.update("narrations", {"book_id": b["id"]}, {"state": "purged", "current_section": None})

    # ---- jobs --------------------------------------------------------------------------
    def next_job(self):
        rows = self.db.select("narrations", {"select": "*", "status": "eq.active", "order": "requested_at.asc"})
        for n in rows:
            books = self.db.select("books", {"select": "*", "id": f"eq.{n['book_id']}"})
            if not books or books[0]["status"] == "finished" or not books[0].get("text_path"):
                continue
            book = books[0]
            try:
                parse_voice(n["voice"])
            except ValueError as e:
                self.db.update("narrations", {"book_id": book["id"]}, {"state": "error", "error": str(e)})
                continue
            # Voice changed: the old audio goes (storage is tight).
            self.purge(book["id"], keep_voice=n["voice"])
            manifest = self.manifest(book)
            done = {r["section"] for r in self.db.select(
                "narration_chapters", {"select": "section", "book_id": f"eq.{book['id']}", "voice": f"eq.{n['voice']}"})}
            sections = [s for s in manifest["sections"] if s["sentences"]]
            pending = [s for s in sections if s["i"] not in done]
            if not pending:
                if n["state"] != "ready":
                    self.db.update("narrations", {"book_id": book["id"]}, {"state": "ready", "current_section": None, "error": None})
                continue
            anchor = n.get("priority_section")
            if anchor is None:
                anchor = n.get("start_section") or sections[0]["i"]
            order = [s for s in sections if s["i"] >= anchor] + [s for s in sections if s["i"] < anchor]
            nxt = next(s for s in order if s["i"] not in done)
            return book, n, manifest, nxt, len(done), len(sections)
        return None

    def space_left(self) -> bool:
        used = sum(r["bytes"] for r in self.db.select("narration_chapters", {"select": "bytes"}))
        return used < self.max_audio

    def generate(self, book: dict, n: dict, manifest: dict, section: dict, done: int, total: int) -> None:
        voice, lang = n["voice"], manifest.get("lang", "es")
        engine_name, _ = parse_voice(voice)
        if engine_name == "chatterbox-latam" and lang != "es":
            raise ValueError("la voz LatAm es solo para libros en español")
        if not self.space_left():
            raise RuntimeError("no queda espacio para audio en la nube: terminá o borrá otro libro con audio")
        engine = self.use_engine(voice)
        self.current = {"book_id": book["id"], "section": section["i"], "voice": voice}
        self.db.update("narrations", {"book_id": book["id"]}, {"state": "generating", "current_section": section["i"], "error": None})
        self.heartbeat(force=True)
        log.info("%s · section %d (%d/%d) · %s", book["title"], section["i"], done + 1, total, voice)

        sentences = [Sentence(text=s["t"], cfi=s["c"], block=s.get("b", 0), heading=bool(s.get("h"))) for s in section["sentences"]]
        cache = ChunkCache(self.work / "chunks" / book["id"] / slug(voice), str(section["i"]))
        last_check = [time.time()]

        def should_stop() -> bool:
            self.heartbeat()
            if self.stop:
                return True
            if time.time() - last_check[0] < 20:
                return False
            last_check[0] = time.time()
            row = self.db.select("narrations", {"select": "status,voice,priority_section", "book_id": f"eq.{book['id']}"})
            if not row or row[0]["status"] != "active" or row[0]["voice"] != voice:
                return True
            p = row[0]["priority_section"]
            return p is not None and p != section["i"] and p != n.get("priority_section")

        t0 = time.time()
        audio = narrate(engine, sentences, lang, asr=self.asr if engine.info.needs_qc else None, cache=cache, should_stop=should_stop)
        if audio is None:
            log.info("switching: the user asked for something else")
            return
        out = self.work / "out" / f"{book['id']}-{slug(voice)}-{section['i']}.opus"
        write_opus(out, audio.wav, audio.sample_rate)
        data = out.read_bytes()
        path = f"{book['user_id']}/{book['id']}/{slug(voice)}/{section['i']}.opus"
        self.db.upload("audio", path, data, "audio/ogg")
        duration = audio.wav.size / audio.sample_rate
        self.db.upsert("narration_chapters", {
            "book_id": book["id"], "user_id": book["user_id"], "voice": voice, "section": section["i"],
            "audio_path": path, "duration": round(duration, 3), "bytes": len(data),
            "timings": [{"i": tm.index, "cfi": tm.cfi, "s": tm.start, "e": tm.end} for tm in audio.timings],
        }, "book_id,voice,section")
        out.unlink(missing_ok=True)
        shutil.rmtree(self.work / "chunks" / book["id"] / slug(voice) / str(section["i"]), ignore_errors=True)
        for w in audio.warnings:
            log.warning(w)
        took = time.time() - t0
        log.info("  done: %.1f min of audio in %.1f min (%.1fx), %.1f MB", duration / 60, took / 60, duration / max(took, 1e-6), len(data) / 1e6)
        if done + 1 >= total:
            self.db.update("narrations", {"book_id": book["id"]}, {"state": "ready", "current_section": None})

    # ---- main loop ------------------------------------------------------------------------
    def run(self) -> None:
        log.info("worker started · engines: %s · voices dir: %s", ", ".join(ENGINES), VOICES_DIR)
        signal.signal(signal.SIGINT, lambda *_: setattr(self, "stop", True))
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "stop", True))
        idle_since = time.time()
        while not self.stop:
            try:
                self.heartbeat()
                self.sweep_finished()
                job = self.next_job()
                if job:
                    book, n, *_ = job
                    try:
                        self.generate(*job)
                    except Exception as e:
                        log.exception("generation failed")
                        self.db.update("narrations", {"book_id": book["id"]}, {"state": "error", "error": str(e)[:300]})
                        time.sleep(self.poll)
                    idle_since = time.time()
                    continue
                self.current = None
                # Free the GPU after 10 idle minutes (the PC is also used for other things).
                if self.engine is not None and time.time() - idle_since > 600:
                    self.engine.close()
                    self.engine, self.engine_voice = None, None
                    free_gpu()
                    log.info("idle: model unloaded")
            except Exception as e:
                log.warning("loop error (retrying): %s", e)
            for _ in range(int(self.poll * 2)):
                if self.stop:
                    break
                time.sleep(0.5)
        log.info("stopped")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "faster_whisper", "phonemizer"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles
    Worker().run()


if __name__ == "__main__":
    main()
