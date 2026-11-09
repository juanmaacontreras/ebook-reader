"""Stdlib-only tests of publish_book.py with a fake Supabase and a canned analyzer result."""

import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# publish_book imports the worker's HTTP client (httpx); these tests never reach the network.
sys.modules.setdefault("worker.main", types.SimpleNamespace(ROOT=ROOT, load_env=lambda: None, supabase_config=lambda: ("", "")))
sys.modules.setdefault("worker.supa", types.SimpleNamespace(Supabase=object))

import publish_book  # noqa: E402

UID, BOOK = "u1", "b1"


class FakeDb:
    user_id = UID

    def __init__(self, tables):
        self.t = tables
        self.calls = []

    def select(self, table, params):
        rows = self.t.get(table, [])
        for k, v in params.items():
            if k == "select":
                continue
            op, _, val = v.partition(".")
            if op == "eq":
                rows = [r for r in rows if str(r.get(k)) == val]
            elif op == "is" and val == "false":
                rows = [r for r in rows if r.get(k) is False]
        return [dict(r) for r in rows]

    def download(self, bucket, path):
        return b"old"

    def upload(self, *a):
        self.calls.append(("upload",) + a[:2])

    def remove(self, bucket, paths):
        self.calls.append(("remove", bucket, tuple(paths)))

    def update(self, table, match, values):
        self.calls.append(("update", table, match, values))

    def upsert(self, table, rows, on_conflict):
        self.calls.append(("upsert", table, rows))

    def delete(self, table, match):
        self.calls.append(("delete", table, match))


META = {"sha256": "new", "title": "SHyMA", "author": None, "language": "es", "size_bytes": 10, "section_count": 4, "cover_type": None}


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp())
        (self.work / "text.json.gz").write_bytes(b"gz")
        self.epub = self.work / "in.epub"
        self.epub.write_bytes(b"epub-bytes")
        self.analyzed = []

    def run_publish(self, db, book_id, result, same_title=False):
        def fake(epub, out, old=None):
            self.analyzed.append(old)
            return result
        orig = publish_book.analyze
        publish_book.analyze = fake
        try:
            return publish_book.publish(db, self.epub, book_id, self.work, same_title)
        finally:
            publish_book.analyze = orig

    def test_same_file_is_left_alone(self):
        import hashlib
        db = FakeDb({"books": [{"id": BOOK, "title": "x", "sha256": hashlib.sha256(b"epub-bytes").hexdigest()}]})
        self.assertEqual(self.run_publish(db, None, {})["action"], "unchanged")
        self.assertEqual(db.calls, [])

    def test_new_book_gets_the_apps_paths(self):
        db = FakeDb({})
        r = self.run_publish(db, None, {"meta": META})
        row = [c for c in db.calls if c[0] == "upsert"][0][2]
        self.assertEqual(row["epub_path"], f"{UID}/{r['id']}/book.epub")
        self.assertEqual(row["text_path"], f"{UID}/{r['id']}/text.json.gz")
        self.assertEqual((row["status"], row["cover_path"]), ("to_read", None))

    def test_replace_moves_place_and_highlights_and_drops_changed_audio(self):
        db = FakeDb({
            "books": [{"id": BOOK, "user_id": UID, "title": "SHyMA", "sha256": "old", "text_path": "t", "cover_path": None}],
            "positions": [{"book_id": BOOK, "user_id": UID, "cfi": "c-old", "section": 2, "sentence": 5, "updated_at": "2026-11-09T10:00:00Z"}],
            "highlights": [{"id": "h1", "book_id": BOOK, "text": "a", "section": 2, "deleted": False},
                           {"id": "h2", "book_id": BOOK, "text": "b", "section": 3, "deleted": False},
                           {"id": "h3", "book_id": BOOK, "text": "c", "section": 3, "deleted": True}],
            "narration_chapters": [{"book_id": BOOK, "voice": "xtts:tomas", "section": 3, "audio_path": "a/3.opus"},
                                   {"book_id": BOOK, "voice": "xtts:tomas", "section": 1, "audio_path": "a/1.opus"}],
        })
        result = {"meta": META, "changed": [3],
                  "position": {"section": 2, "sentence": 7, "cfi": "c-new", "fraction": 0.4},
                  "highlights": [{"id": "h1", "cfi": "h-new", "section": 2, "chapter": "U2"}, {"id": "h2", "lost": True}]}
        r = self.run_publish(db, BOOK, result)
        self.assertEqual([h["id"] for h in self.analyzed[0]["highlights"]], ["h1", "h2"])  # deleted ones not moved
        self.assertEqual(self.analyzed[0]["position"], {"section": 2, "sentence": 5, "cfi": "c-old"})
        book = [c for c in db.calls if c[0] == "update" and c[1] == "books"][0][3]
        self.assertEqual((book["sha256"], book["kepub_path"]), ("new", None))
        self.assertNotIn("status", book)  # the user's state is not the file's
        pos = [c for c in db.calls if c[0] == "upsert" and c[1] == "positions"][0][2]
        self.assertEqual((pos["sentence"], pos["cfi"], pos["base"]), (7, "c-new", "2026-11-09T10:00:00Z"))
        hl = [c for c in db.calls if c[0] == "update" and c[1] == "highlights"]
        self.assertEqual([(c[2]["id"], c[3]["cfi"]) for c in hl], [("h1", "h-new")])
        self.assertIn(("remove", "audio", ("a/3.opus",)), db.calls)
        self.assertIn(("delete", "narration_chapters", {"book_id": BOOK, "section": "3"}), db.calls)
        self.assertIn(("remove", "library", (f"{UID}/{BOOK}/book.kepub.epub", f"{UID}/{BOOK}/kepub.json")), db.calls)
        self.assertEqual((r["highlights_moved"], r["highlights_lost"], r["audio_removed"]), (1, 1, [3]))

    def test_same_title_replaces_the_book_imported_by_hand(self):
        import zipfile
        with zipfile.ZipFile(self.epub, "w") as z:
            z.writestr("META-INF/container.xml", '<rootfile full-path="OEBPS/content.opf"/>')
            z.writestr("OEBPS/content.opf", "<metadata><dc:title>SHyMA &#8212; Segundo parcial</dc:title></metadata>")
        db = FakeDb({"books": [{"id": BOOK, "user_id": UID, "title": "SHyMA \u2014 Segundo parcial", "sha256": "old", "text_path": "t"}]})
        r = self.run_publish(db, None, {"meta": META, "changed": [], "position": None, "highlights": []}, same_title=True)
        self.assertEqual((r["id"], r["action"]), (BOOK, "replaced"))


if __name__ == "__main__":
    unittest.main()
