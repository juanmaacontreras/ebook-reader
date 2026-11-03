"""End-to-end test of the Kobo sync against the real backend.

A temporary account imports the sample book in the real app (headless
Chromium), which builds and uploads its KEPUB; then this script acts as a Kobo
against the deployed function (supabase/functions/kobo): initialization, library
sync, metadata, download, cover, reading-state reports, a place from "another
device", removal. Everything the test created is deleted at the end.

    SUPABASE_PAT=... python tools/kobo_e2e.py [--url http://localhost:5173]

Needs a short-lived Management API token (see CLAUDE.md, "Applying schema
changes"), Playwright in a throwaway venv and `npm run dev` running in client/.
"""

import argparse
import gzip
import hashlib
import io
import json
import secrets
import time
import zipfile
from datetime import datetime, timedelta, timezone

from playwright.sync_api import sync_playwright

from e2e_common import ANON, EPUB, KOBO_UA, URL, check, finish, http, lit, sign_in, sql, temp_account


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5173")
    args = ap.parse_args()

    token = secrets.token_urlsafe(32)
    with temp_account() as acc:
        uid, user = acc.uid, acc.headers

        # ---- the app imports the book and builds the KEPUB ----
        print("app: import in headless Chromium")
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.on("console", lambda m: m.type in ("warning", "error") and print("   [app]", m.text))
            sign_in(page, args.url, acc)
            page.set_input_files("input[type=file]", str(EPUB))
            book = None
            for _ in range(90):
                _, _, rows = http("GET", f"{URL}/rest/v1/books?select=id,kepub_path,text_path", headers=user)
                if rows and rows[0].get("kepub_path"):
                    book = rows[0]
                    break
                time.sleep(1)
            browser.close()
        check(book is not None, "the app built and uploaded the KEPUB (kepub_path set)")
        if not book:
            finish()
        bid = book["id"]
        _, _, gz = http("GET", f"{URL}/storage/v1/object/library/{book['text_path']}", headers=user, raw=True)
        manifest = json.loads(gzip.decompress(gz))

        # ---- the Kobo ----
        sql(f"insert into kobo_devices (user_id, token_hash, name) values ({lit(uid)}, {lit(hashlib.sha256(token.encode()).hexdigest())}, 'e2e')")
        base = f"{URL}/functions/v1/kobo/{token}"
        kobo = {"User-Agent": KOBO_UA, "x-kobo-deviceid": "e2e"}

        print("kobo: initialization")
        status, h, init = http("GET", f"{base}/v1/initialization", headers=kobo)
        check(status == 200 and init["Resources"]["library_sync"] == f"{base}/v1/library/sync", "initialization points the library here")
        check(h.get("x-kobo-apitoken") == "e30=", "x-kobo-apitoken header")
        print(f"       resources from: {h.get('x-atril-resources')}; reading services: {init['Resources'].get('reading_services_host')}")

        status, _, bad = http("GET", f"{URL}/functions/v1/kobo/{'x' * 43}/v1/initialization", headers=kobo)
        check(status == 401, "an unknown token is refused")

        print("kobo: library sync")
        status, h, items = http("GET", f"{base}/v1/library/sync", headers=kobo)
        new = [i["NewEntitlement"] for i in items if "NewEntitlement" in i]
        check(status == 200 and len(new) == 1 and new[0]["BookMetadata"]["EntitlementId"] == bid, "the book arrives as a new entitlement")
        cursor = h.get("x-kobo-synctoken")
        check(bool(cursor), "sync token handed to the device")
        status, h, again = http("GET", f"{base}/v1/library/sync", headers={**kobo, "x-kobo-synctoken": cursor})
        check(status == 200 and again == [], "the next sync has nothing new")
        cursor = h.get("x-kobo-synctoken") or cursor

        status, _, meta = http("GET", f"{base}/v1/library/{bid}/metadata", headers=kobo)
        dl = meta[0]["DownloadUrls"][0]
        check(status == 200 and dl["Format"] == "KEPUB" and dl["Size"] > 0, f"metadata: KEPUB, {dl['Size']} bytes")

        status, h, kepub = http("GET", dl["Url"], headers=kobo, raw=True)
        check(status == 200 and len(kepub) == dl["Size"], "download matches the announced size")
        z = zipfile.ZipFile(io.BytesIO(kepub))
        check(z.namelist()[0] == "mimetype" and z.read("mimetype") == b"application/epub+zip", "KEPUB container: mimetype first")
        _, _, kmap = http("GET", f"{URL}/storage/v1/object/library/{uid}/{bid}/kepub.json", headers=user)
        f1 = kmap["files"][1]
        chapter = z.read(f1["p"]).decode()
        sec = next(s for s in manifest["sections"] if s["i"] == f1["i"])
        check(chapter.count('class="koboSpan"') >= len(sec["sentences"]) and 'id="kobo.3.1"' in chapter, f"{f1['p']}: spans for its {len(sec['sentences'])} sentences")

        # The sample book has no cover: one is put in its place, as the app would.
        status, h, img = http("GET", f"{base}/{bid}/300/400/false/image.jpg", headers=kobo, raw=True)
        check(status == 404, "a book without a cover: 404 (not sent to Kobo's image server)")
        jpeg = b"\xff\xd8\xff\xe0" + b"\0" * 60 + b"\xff\xd9"
        http("POST", f"{URL}/storage/v1/object/library/{uid}/{bid}/cover.jpg", jpeg, {**user, "Content-Type": "image/jpeg"})
        # Cloudflare (in front of Supabase) caches *.jpg answers, the 404 too: another size.
        status, h, img = http("GET", f"{base}/{bid}/301/401/false/image.jpg", headers=kobo, raw=True)
        check(status == 200 and img == jpeg, "cover")

        print("kobo: reading on the device")
        # Reports dated after the import (an older one would rightly lose to it).
        imported = sql(f"select updated_at from books where id = {lit(bid)}")[0]["updated_at"]
        now = datetime.fromisoformat(imported).replace(microsecond=0) + timedelta(minutes=11)
        ts = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")

        def report(value: str, minutes: int, status_: str, at: datetime):
            body = {"ReadingStates": [{
                "EntitlementId": bid, "LastModified": ts(at),
                "CurrentBookmark": {"LastModified": ts(at), "ProgressPercent": 40, "ContentSourceProgressPercent": 20,
                                    "Location": {"Value": value, "Type": "KoboSpan", "Source": f1["p"]}},
                "Statistics": {"LastModified": ts(at), "SpentReadingMinutes": minutes, "RemainingTimeMinutes": 30},
                "StatusInfo": {"LastModified": ts(at), "Status": status_, "TimesStartedReading": 1},
            }]}
            return http("PUT", f"{base}/v1/library/{bid}/state", body, kobo)

        status, _, r = report("kobo.1.1", 0, "Reading", now - timedelta(minutes=10))
        check(status == 200 and r["RequestResult"] == "Success", "first report (book opened) accepted")
        status, _, r = report("kobo.3.2", 5, "Reading", now - timedelta(minutes=5))
        q = f"select section, sentence, cfi, device, fraction from positions where book_id = {lit(bid)}"
        pos = sql(q)[0]
        check(pos["section"] == f1["i"] and pos["sentence"] == 2 and pos["cfi"] == sec["sentences"][2]["c"],
              f"Kobo place kobo.3.2 → sentence 2 of section {f1['i']} with the manifest's CFI")
        check(pos["device"].startswith("kobo:") and abs(pos["fraction"] - 0.4) < 1e-6, "position: device kobo, 40 %")
        st = sql(f"select status from books where id = {lit(bid)}")[0]["status"]
        check(st == "reading", "status: to_read → reading")
        sess = sql(f"select seconds, device_kind, words from reading_sessions where book_id = {lit(bid)}")
        check(len(sess) == 1 and sess[0]["seconds"] == 300 and sess[0]["device_kind"] == "ereader", f"reading session: 5 min on the e-reader ({sess[0]['words'] if sess else 0} words)")

        before = sql(f"select updated_at from positions where book_id = {lit(bid)}")[0]["updated_at"]
        report("kobo.3.2", 7, "Reading", now - timedelta(minutes=2))  # closed at the same place
        after = sql(f"select updated_at from positions where book_id = {lit(bid)}")[0]["updated_at"]
        check(before == after, "the same place reported again doesn't move the position")
        check(len(sql(f"select 1 from reading_sessions where book_id = {lit(bid)}")) == 2, "…but its 2 extra minutes count")

        print("another device moves on")
        s2 = manifest["sections"][-1]
        status, _, out = http("POST", f"{URL}/rest/v1/positions?on_conflict=book_id",
                              {"book_id": bid, "cfi": s2["sentences"][4]["c"], "section": s2["i"], "sentence": 4, "fraction": 0.9,
                               "device": "phone-e2e", "updated_at": datetime.now(timezone.utc).isoformat()},
                              {**user, "Prefer": "resolution=merge-duplicates"})
        check(status < 300, "phone pushes a newer place")
        status, h, items = http("GET", f"{base}/v1/library/sync", headers={**kobo, "x-kobo-synctoken": cursor})
        # As a state alone, or inside the book's entry when the book row changed too
        # (here: its status went to "reading" from the Kobo's report).
        states = [i["ChangedReadingState"]["ReadingState"] for i in items if "ChangedReadingState" in i] \
            + [i["ChangedEntitlement"]["ReadingState"] for i in items if "ChangedEntitlement" in i]
        fl = next(f for f in kmap["files"] if f["i"] == s2["i"])
        check(len(states) == 1 and states[0]["CurrentBookmark"]["Location"] == {"Value": "kobo.5.1", "Type": "KoboSpan", "Source": fl["p"]},
              "the Kobo's next sync points it to the phone's sentence (kobo.5.1)")
        check(states and states[0]["Statistics"].get("SpentReadingMinutes") == 7, "…keeping the Kobo's own reading minutes")
        cursor = h.get("x-kobo-synctoken") or cursor
        status, _, got = http("GET", f"{base}/v1/library/{bid}/state", headers=kobo)
        check(status == 200 and got[0]["CurrentBookmark"]["Location"]["Value"] == "kobo.5.1", "GET state agrees")

        print("kobo: finished, then removed on the device")
        report("kobo.5.1", 7, "Finished", datetime.now(timezone.utc))
        check(sql(f"select status from books where id = {lit(bid)}")[0]["status"] == "finished", "Finished on the Kobo → terminado in Atril")
        status, _, _ = http("DELETE", f"{base}/v1/library/{bid}", headers=kobo)
        removed = sql(f"select removed from kobo_books where book_id = {lit(bid)}")
        check(status == 204 and removed and removed[0]["removed"] is True, "removed on the device: not offered again")

        status, _, _ = http("GET", f"{base}/v1/library/00000000-0000-0000-0000-000000000001/metadata", headers=kobo, raw=True)
        print(f"       a store book's metadata → {status} (redirected to Kobo)")
        log = sql("select method, path, status, note from kobo_log where device_id = (select id from kobo_devices where name = 'e2e' and user_id = " + lit(uid) + ") order by at")
        check(len(log) >= 10 and all("/kobo/" not in r["path"] for r in log), f"{len(log)} requests logged, no token in them")
        for r in log:
            print(f"       {r['status']} {r['method']:6} {r['path'][:60]:60} {r['note'] or ''}")
    finish()


if __name__ == "__main__":
    main()
