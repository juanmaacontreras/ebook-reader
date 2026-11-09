"""Put an EPUB in the library without the app, or replace a book's EPUB in place.

    uv run python publish_book.py BOOK.epub                 # a new book; prints its id
    uv run python publish_book.py BOOK.epub --book <id>     # a corrected version of that book

For books made elsewhere (resumidor's units: `resumidor/audiolibro/tools/a_atril.py`). The
sentence manifest is built by the app's own code, headless (client/tools/analyze.tool.ts, in the
same jsdom the tests use), so it is the manifest the app would build at import.

Replacing keeps the book's id, so its reading place, highlights, sessions and Kobo entry stay
with it: the place and the highlights are moved by their text to where they are in the new
version (client/src/book/remap.ts); a highlight whose text is gone is left as it was and
counted. The narration of chapters whose sentences changed is removed (its timings no longer
fit): attach the new audio of those chapters again (import_audio.py). Devices notice the new
hash on their next sync and download the new files (sync.ts, merge); the Kobo's KEPUB is rebuilt.

Needs Node (to run the analyzer) and client/node_modules (`npm ci` in client/). Signs in with the
worker's session (.session.json); since the refresh token rotates, a running atril-tts service is
stopped for the duration and started again afterwards.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from worker.main import ROOT, load_env, supabase_config
from worker.supa import Supabase

CLIENT = ROOT.parent / "client"
SERVICE = "atril-tts.service"


def analyze(epub: Path, out: Path, old: dict | None = None) -> dict[str, Any]:
    node = os.environ.get("ATRIL_NODE") or shutil.which("node")
    if not node:
        sys.exit("Node is needed to read the EPUB like the app does (pacman -S nodejs npm)")
    if not (CLIENT / "node_modules").is_dir():
        sys.exit(f"missing {CLIENT}/node_modules: run `npm ci` there once")
    job = {"epub": str(epub.resolve()), "out": str(out)}
    if old:
        job["old"] = old
    (out / "job.json").write_text(json.dumps(job), encoding="utf-8")
    r = subprocess.run([node, "node_modules/vitest/vitest.mjs", "run", "--config", "tools/vitest.config.ts"],
                       cwd=CLIENT, env={**os.environ, "ATRIL_JOB": str(out / "job.json")}, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("the analyzer failed:\n" + (r.stdout + r.stderr)[-2000:])
    return json.loads((out / "result.json").read_text(encoding="utf-8"))


def paths(uid: str, book: str) -> dict[str, str]:
    """Same as client/src/data/files.ts `paths`."""
    base = f"{uid}/{book}"
    return {"epub": f"{base}/book.epub", "cover": f"{base}/cover.jpg", "text": f"{base}/text.json.gz",
            "kepub": f"{base}/book.kepub.epub", "kepub_map": f"{base}/kepub.json"}


def book_row(meta: dict, uid: str, book_id: str, now: str, cover: bool) -> dict[str, Any]:
    p = paths(uid, book_id)
    return {"id": book_id, "user_id": uid, "sha256": meta["sha256"], "title": meta["title"] or "Sin título",
            "author": meta["author"], "language": meta["language"], "storage": "supabase",
            "epub_path": p["epub"], "cover_path": p["cover"] if cover else None, "text_path": p["text"],
            "size_bytes": meta["size_bytes"], "section_count": meta["section_count"],
            "status": "to_read", "added_at": now, "finished_at": None, "updated_at": now}


def replaced_row(meta: dict, book: dict, now: str, cover: bool) -> dict[str, Any]:
    """What changes in a book row replaced in place: the file's identity, never the user's state."""
    return {"sha256": meta["sha256"], "title": meta["title"] or book["title"], "author": meta["author"],
            "language": meta["language"], "size_bytes": meta["size_bytes"], "section_count": meta["section_count"],
            "cover_path": paths(book["user_id"], book["id"])["cover"] if cover else book.get("cover_path"),
            "kepub_path": None, "updated_at": now}


def moved_place(pos: dict, new: dict, now: str) -> dict[str, Any]:
    # base = the place we read: the position trigger keeps this write unless someone moved meanwhile
    return {"book_id": pos["book_id"], "user_id": pos["user_id"], "cfi": new["cfi"], "section": new["section"],
            "sentence": new["sentence"], "fraction": round(new["fraction"], 6), "device": "Actualización",
            "updated_at": now, "base": pos["updated_at"]}


def upload_files(db: Supabase, out: Path, epub: bytes, meta: dict, p: dict[str, str]) -> bool:
    db.upload("library", p["epub"], epub, "application/epub+zip")
    db.upload("library", p["text"], (out / "text.json.gz").read_bytes(), "application/gzip")
    if meta.get("cover_type"):
        db.upload("library", p["cover"], (out / "cover").read_bytes(), meta["cover_type"])
        return True
    return False


def publish(db: Supabase, epub_path: Path, book_id: str | None, work: Path) -> dict[str, Any]:
    epub = epub_path.read_bytes()
    sha = hashlib.sha256(epub).hexdigest()
    same = db.select("books", {"select": "id,title", "sha256": f"eq.{sha}"})
    if same:
        return {"id": same[0]["id"], "action": "unchanged", "title": same[0]["title"]}
    now = datetime.now(timezone.utc).isoformat()
    uid = db.user_id

    if not book_id:
        res = analyze(epub_path, work)
        new_id = str(uuid.uuid4())
        cover = upload_files(db, work, epub, res["meta"], paths(uid, new_id))
        db.upsert("books", book_row(res["meta"], uid, new_id, now, cover), "id")
        return {"id": new_id, "action": "added", "title": res["meta"]["title"]}

    rows = db.select("books", {"select": "*", "id": f"eq.{book_id}"})
    if not rows:
        sys.exit(f"no book {book_id} in the library (removed?): publish without --book to add it again")
    book = rows[0]
    (work / "old.json.gz").write_bytes(db.download("library", book["text_path"]))
    pos = (db.select("positions", {"select": "*", "book_id": f"eq.{book_id}"}) or [None])[0]
    highlights = db.select("highlights", {"select": "id,text,section", "book_id": f"eq.{book_id}", "deleted": "is.false"})
    res = analyze(epub_path, work, {
        "manifest": str(work / "old.json.gz"),
        "position": {k: pos[k] for k in ("section", "sentence", "cfi")} if pos else None,
        "highlights": highlights,
    })
    p = paths(book["user_id"], book_id)
    cover = upload_files(db, work, epub, res["meta"], p)
    db.remove("library", [p["kepub"], p["kepub_map"]])  # rebuilt from the new EPUB by a device
    db.update("books", {"id": book_id}, replaced_row(res["meta"], book, now, cover))
    if pos and res.get("position"):
        db.upsert("positions", moved_place(pos, res["position"], now), "book_id")
    lost = 0
    for h in res.get("highlights", []):
        if h.get("lost"):
            lost += 1
            continue
        db.update("highlights", {"id": h["id"]}, {"cfi": h["cfi"], "section": h["section"], "chapter": h["chapter"], "updated_at": now})
    chapters = []
    for section in res.get("changed", []):
        gone = db.select("narration_chapters", {"select": "voice,section,audio_path", "book_id": f"eq.{book_id}", "section": f"eq.{section}"})
        if gone:
            db.remove("audio", [g["audio_path"] for g in gone if g.get("audio_path")])
            db.delete("narration_chapters", {"book_id": book_id, "section": str(section)})
            chapters.append(section)
    return {"id": book_id, "action": "replaced", "title": res["meta"]["title"], "highlights_moved": len(highlights) - lost,
            "highlights_lost": lost, "place_moved": bool(pos and res.get("position")), "audio_removed": chapters,
            "changed_sections": res.get("changed", [])}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("epub", type=Path)
    ap.add_argument("--book", help="id of the book this EPUB replaces")
    a = ap.parse_args()
    load_env()
    url, key = supabase_config()
    active = subprocess.run(["systemctl", "--user", "is-active", "--quiet", SERVICE]).returncode == 0
    if active:  # stopped before reading the session: it may have just rotated the token
        subprocess.run(["systemctl", "--user", "stop", SERVICE], check=True)
    try:
        db = Supabase(url, key, ROOT / ".session.json")
        if not db.signed_in():
            sys.exit("this PC is not linked: run the worker once and sign in")
        with tempfile.TemporaryDirectory(prefix="atril-publish-") as d:
            print(json.dumps(publish(db, a.epub, a.book, Path(d)), ensure_ascii=False))
    finally:
        if active:
            subprocess.run(["systemctl", "--user", "start", SERVICE])


if __name__ == "__main__":
    main()
