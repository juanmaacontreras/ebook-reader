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

        def report(value: str, minutes: int, status_: str, at: datetime, source: str | None = None):
            body = {"ReadingStates": [{
                "EntitlementId": bid, "LastModified": ts(at),
                "CurrentBookmark": {"LastModified": ts(at), "ProgressPercent": 40, "ContentSourceProgressPercent": 20,
                                    "Location": {"Value": value, "Type": "KoboSpan", "Source": source or f1["p"]}},
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

        pos_q = f"select section, sentence, device from positions where book_id = {lit(bid)}"
        later = lambda: (time.sleep(1.1), datetime.now(timezone.utc))[1]  # noqa: E731 (the device writes whole seconds)
        print("kobo: picked up before taking the phone's place")
        report("kobo.4.1", 8, "Reading", later())
        pos = sql(pos_q)[0]
        check(pos["device"] == "phone-e2e" and (pos["section"], pos["sentence"]) == (s2["i"], 4),
              "reading on behind the phone's newer place doesn't take it back")
        report("kobo.5.1", 8, "Reading", later(), fl["p"])
        pos = sql(pos_q)[0]
        check(pos["device"].startswith("kobo:") and (pos["section"], pos["sentence"]) == (s2["i"], 4), "taking the phone's place: in sync")
        report("kobo.3.1", 8, "Reading", later(), fl["p"])
        pos = sql(pos_q)[0]
        check((pos["section"], pos["sentence"]) == (s2["i"], 2), "then a page back on the Kobo goes to everyone")

        print("kobo: ahead of a place moved back elsewhere")
        http("POST", f"{URL}/rest/v1/positions?on_conflict=book_id",
             {"book_id": bid, "cfi": s2["sentences"][1]["c"], "section": s2["i"], "sentence": 1, "fraction": 0.85,
              "device": "phone-e2e", "updated_at": later().isoformat()},
             {**user, "Prefer": "resolution=merge-duplicates"})
        check(sql(pos_q)[0]["device"] == "phone-e2e", "the phone goes back, behind the Kobo")
        report("kobo.1.1", 8, "Reading", later(), fl["p"])
        pos = sql(pos_q)[0]
        check(pos["device"].startswith("kobo:") and (pos["section"], pos["sentence"]) == (s2["i"], 0),
              "the Kobo (it missed nothing: it was ahead) going back further reaches everyone")
        report("kobo.3.1", 8, "Reading", later(), fl["p"])  # back where the next checks expect it

        print("status both ways")
        st = lambda: sql(f"select status from books where id = {lit(bid)}")[0]["status"]  # noqa: E731
        told = lambda: sql(f"select told from kobo_books where book_id = {lit(bid)}")[0]["told"]  # noqa: E731
        first = next(x for x in manifest["sections"] if x["sentences"])
        f0 = next(f for f in kmap["files"] if f["i"] == first["i"])
        cover = f"{bid}!OEBPS!Text/cubierta.xhtml"  # where the device stands after "no leído": no text, no place

        def phone(status_: str | None, section: dict, k: int) -> None:
            at = later().isoformat()
            if status_:
                http("PATCH", f"{URL}/rest/v1/books?id=eq.{bid}", {"status": status_, "finished_at": None, "updated_at": at}, user)
            http("POST", f"{URL}/rest/v1/positions?on_conflict=book_id",
                 {"book_id": bid, "cfi": section["sentences"][k]["c"], "section": section["i"], "sentence": k,
                  "fraction": 0 if k == 0 and section is first else 0.9, "device": "phone-e2e", "updated_at": at},
                 {**user, "Prefer": "resolution=merge-duplicates"})

        phone("to_read", first, 0)  # "Marcar como «Por leer»" in the app: the status, and the place back to the start
        status, h, items = http("GET", f"{base}/v1/library/sync", headers={**kobo, "x-kobo-synctoken": cursor})
        states = [i["ChangedReadingState"]["ReadingState"] for i in items if "ChangedReadingState" in i] \
            + [i["ChangedEntitlement"]["ReadingState"] for i in items if "ChangedEntitlement" in i and "ReadingState" in i["ChangedEntitlement"]]
        check(len(states) == 1 and states[0]["StatusInfo"]["Status"] == "ReadyToRead"
              and states[0]["CurrentBookmark"]["Location"] == {"Value": "kobo.1.1", "Type": "KoboSpan", "Source": f0["p"]},
              "\"Por leer\" in Atril reaches the Kobo's sync as ReadyToRead, at the start of the text")
        check(told() == ["ReadyToRead"], "…and the server notes it told the Kobo so")
        cursor = h.get("x-kobo-synctoken") or cursor
        _, _, got = http("GET", f"{base}/v1/library/{bid}/state", headers=kobo)
        check(got[0]["StatusInfo"]["Status"] == "ReadyToRead", "…and its GET state")
        report("kobo.3.1", 8, "Reading", later(), fl["p"])
        check(st() == "to_read" and told() == ["ReadyToRead"], "the Kobo repeating \"Reading\" at the same place doesn't undo it")
        report("kobo.4.1", 9, "Reading", later(), fl["p"])
        check(st() == "reading" and told() == [], "reading on the Kobo (its place moved) makes it \"Leyendo\" again")
        report("kobo.1.1", 9, "ReadyToRead", later(), cover)
        pos = sql(pos_q)[0]
        check(st() == "to_read" and pos["device"].startswith("kobo:") and (pos["section"], pos["sentence"]) == (first["i"], 0),
              "\"Mark as unread\" on the Kobo → \"Por leer\" in Atril, and the place back to the start")
        report("kobo.4.1", 9, "Reading", later(), fl["p"])
        check(st() == "reading", "opened again on the Kobo → \"Leyendo\"")

        print("kobo: its echo of Atril's own status")
        phone("to_read", first, 0)
        _, _, got = http("GET", f"{base}/v1/library/{bid}/state", headers=kobo)
        check(got[0]["StatusInfo"]["Status"] == "ReadyToRead" and told() == ["ReadyToRead"], "\"Por leer\" on the phone again; the Kobo opens the book and is told")
        k6 = min(6, len(s2["sentences"]) - 1)
        phone("reading", s2, k6)  # then read on the phone: "Leyendo", further on
        report("kobo.1.1", 9, "ReadyToRead", later(), cover)  # the Kobo says it took "Por leer" (its next sync)
        pos = sql(pos_q)[0]
        check(st() == "reading" and pos["device"] == "phone-e2e" and (pos["section"], pos["sentence"]) == (s2["i"], k6),
              "the Kobo saying later it took «Por leer» doesn't undo the reading done on the phone since")
        check(told() == [], "…and that echo is done with")

        print("kobo: finished, then removed on the device")
        report("kobo.5.1", 9, "Finished", later(), fl["p"])
        check(st() == "finished", "Finished on the Kobo → terminado in Atril")
        report("kobo.5.1", 9, "Reading", later(), fl["p"])
        check(st() == "reading", "taken up again on the Kobo (Finished → Reading) → \"Leyendo\"")
        unread_at = later()  # "no leído" on the Kobo, offline…
        phone(None, s2, 2)   # …then reading on the phone; the Kobo's report arrives after
        report("kobo.1.1", 9, "ReadyToRead", unread_at, cover)
        pos = sql(pos_q)[0]
        check(st() == "reading" and pos["device"] == "phone-e2e" and (pos["section"], pos["sentence"]) == (s2["i"], 2),
              "a «no leído» made on the Kobo before reading done on the phone doesn't take that back")
        http("PATCH", f"{URL}/rest/v1/books?id=eq.{bid}", {"status": "finished", "finished_at": datetime.now(timezone.utc).isoformat(),
             "updated_at": datetime.now(timezone.utc).isoformat()}, user)  # "terminado" on the phone
        report("kobo.6.1", 10, "Reading", later(), fl["p"])
        check(st() == "finished", "\"terminado\" decided on the phone isn't undone by the Kobo reading on")
        print("kobo: the book is replaced in place (publish_book.py)")
        sync = f"{base}/v1/library/sync"
        has = sql(f"select has_sha, (select sha256 from books where id = {lit(bid)}) sha from kobo_books where book_id = {lit(bid)}")[0]
        check(bool(has["sha"]) and has["has_sha"] == has["sha"], "the download recorded which version the device has")
        _, h, _ = http("GET", sync, headers={**kobo, "x-kobo-synctoken": cursor})
        cursor = h.get("x-kobo-synctoken") or cursor
        sql(f"update books set sha256 = 'replaced-e2e' where id = {lit(bid)}")
        status, h, items = http("GET", sync, headers={**kobo, "x-kobo-synctoken": cursor})
        gone = [i["ChangedEntitlement"]["BookEntitlement"] for i in items if "ChangedEntitlement" in i]
        check(status == 200 and len(items) == 1 and len(gone) == 1 and gone[0]["Id"] == bid and gone[0]["IsRemoved"] is True,
              "the next sync takes the old version off the device")
        check(h.get("x-kobo-sync") == "continue", "…and asks it to sync again right away")
        cursor = h.get("x-kobo-synctoken") or cursor
        http("DELETE", f"{base}/v1/library/{bid}", headers=kobo)
        check(sql(f"select removed from kobo_books where book_id = {lit(bid)}")[0]["removed"] is False,
              "a removal the device may answer with meanwhile is not taken as the user's")
        report("kobo.6.1", 10, "Reading", later(), fl["p"])  # a report still on its way
        for attempt in ("right after", "and again until it downloads it"):
            status, h, items = http("GET", sync, headers={**kobo, "x-kobo-synctoken": cursor})
            new = [i["NewEntitlement"] for i in items if "NewEntitlement" in i]
            check(status == 200 and len(new) == 1 and new[0]["BookMetadata"]["EntitlementId"] == bid, f"the book goes as new {attempt}")
            cursor = h.get("x-kobo-synctoken") or cursor
        status, _, again_ = http("GET", f"{base}/download/{bid}", headers=kobo, raw=True)
        has = sql(f"select has_sha, confirmed_at from kobo_books where book_id = {lit(bid)}")[0]
        check(status == 200 and has["has_sha"] == "replaced-e2e" and has["confirmed_at"], "downloaded again: the device has the new version")
        status, h, items = http("GET", sync, headers={**kobo, "x-kobo-synctoken": cursor})
        check(status == 200 and items == [], "…and nothing more to sync")

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
