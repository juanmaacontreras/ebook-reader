"""How fast a change on one device reaches the others, against the real backend.

Two headless Chromium "devices" (A and B: separate storage, one temporary
account, the real app) and a simulated Kobo talking to the deployed function:

  live         A turns a page while B has the book open: until B has A's place
  leaving      A turns a page and goes to the background right away (hidden, and
               cut off a second later: Android freezes or throttles a background
               app): does the place still reach the server?
  back         B was offline while A read: from reconnecting until B has it
  opening      B opens the book right after reconnecting: at A's place, or at its
               old one with the "Ir" offer?
  rules        going back on the device with the newest place reaches the other;
               a device left behind (another's newer place known, "Ir" not taken)
               doesn't take the others back by turning pages; an explicit jump
               (slider) does; after "Ir", going back does
  stale        the same for a device that hadn't even heard of the newer place
               (offline): its older page is refused by the server and the newer
               place comes back to it; a page past the newer one is taken
  resize       a device behind whose window changes size (a re-layout, no page
               turned) doesn't take the others back
  kobo         the Kobo reports a place (it does on closing the book and about
               once a minute while reading): until B, with the book open, has it;
               and B turns a page: until the Kobo gets it (it asks on opening a
               book and about once a minute while one is open)

    SUPABASE_PAT=... python tools/sync_e2e.py [--url http://localhost:5173] [--runs 5]
                                              [--only live,leaving,back,opening,rules,stale,resize,kobo]

Needs Playwright in a throwaway venv and `npm run dev` running in client/.
Everything it creates is deleted at the end.
"""

import argparse
import hashlib
import secrets
import statistics
import time
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from e2e_common import EPUB, KOBO_UA, URL, check, finish, http, lit, sign_in, sql, temp_account, wait_for

# A row of the app's local database (IndexedDB), as the device has it right now.
LOCAL_ROW = """async ([store, key]) => await new Promise((resolve, reject) => {
  const r = indexedDB.open('atril')
  r.onerror = () => reject(r.error)
  r.onsuccess = () => {
    const db = r.result
    const g = db.transaction(store).objectStore(store).get(key)
    g.onsuccess = () => { db.close(); resolve(g.result ?? null) }
    g.onerror = () => { db.close(); reject(g.error) }
  }
})"""

HIDE = """() => {
  for (const [k, v] of [['hidden', true], ['visibilityState', 'hidden']]) Object.defineProperty(document, k, { value: v, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}"""
SHOW = """() => {
  delete document.hidden
  delete document.visibilityState
  document.dispatchEvent(new Event('visibilitychange'))
}"""
TOAST = "Seguiste leyendo en otro dispositivo"
SCENARIOS = ["live", "leaving", "back", "opening", "rules", "stale", "resize", "kobo"]


def ms(seconds: float | None) -> str:
    return "—" if seconds is None else f"{seconds * 1000:.0f} ms"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5173")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--only", default=",".join(SCENARIOS), help="scenarios to run, comma-separated")
    ap.add_argument("--trace", action="store_true", help="print every request to the backend, with times")
    args = ap.parse_args()
    only = [s for s in SCENARIOS if s in args.only.split(",")]
    results: dict[str, list[float | None]] = {}

    def record(name: str, value: float | None) -> None:
        results.setdefault(name, []).append(value)

    with temp_account("atril-sync") as acc, sync_playwright() as p:
        browser = p.chromium.launch()
        phone = {"viewport": {"width": 400, "height": 860}}
        ctx_a, ctx_b = browser.new_context(**phone), browser.new_context(**phone)
        a, b = ctx_a.new_page(), ctx_b.new_page()
        start = time.monotonic()
        for name, page in (("A", a), ("B", b)):
            page.on("console", lambda m, n=name: m.type in ("warning", "error") and "sandbox" not in m.text
                    and "ERR_INTERNET" not in m.text and print(f"   [{n}]", m.text[:200]))
            if args.trace:
                def show(what: str, r, n=name) -> None:
                    if "supabase.co" in r.url:
                        print(f"   {time.monotonic() - start:8.3f} [{n}] {what:4} {r.method:5} {r.url.split('.co/', 1)[1][:110]}")
                page.on("request", lambda r, show=show: show("->", r))
                page.on("requestfinished", lambda r, show=show: show("<-", r))
                page.on("requestfailed", lambda r, show=show: show("FAIL", r))
                page.on("console", lambda m, n=name: m.type == "debug" and print(f"   {time.monotonic() - start:8.3f} [{n}] {m.text[:150]}"))

                def socket(ws, n=name) -> None:
                    t = lambda: f"{time.monotonic() - start:8.3f} [{n}]"  # noqa: E731
                    print(f"   {t()} realtime socket open")
                    ws.on("close", lambda _: print(f"   {t()} realtime socket closed"))
                    ws.on("framereceived", lambda f: "postgres_changes" in str(f) and print(f"   {t()} realtime event"))
                page.on("websocket", socket)

        def server_pos():
            _, _, rows = http("GET", f"{URL}/rest/v1/positions?select=cfi,device,section,sentence,updated_at&book_id=eq.{bid}", headers=acc.headers)
            return rows[0] if isinstance(rows, list) and rows else None

        def local_pos(page):
            x = page.evaluate(LOCAL_ROW, ["positions", bid])
            return x and {k: x[k] for k in ("cfi", "device", "section", "sentence")}

        def on_server(cfi: str):
            return lambda: (s := server_pos()) and s["cfi"] == cfi

        def open_book(page) -> None:
            page.evaluate(f"location.hash = '#/book/{bid}'")
            page.wait_for_function("() => document.querySelector('foliate-view')?.lastLocation", timeout=30000)

        forward = {}  # per device: the direction of its next page turn

        def turn(page) -> dict | None:
            """A page turn (back and forth; the other way at the first or last
            page); the device's new place once it saved it."""
            before = (local_pos(page) or {}).get("cfi")
            for _ in range(2):
                ahead = forward.get(page, True)
                forward[page] = not ahead
                page.evaluate(f"document.querySelector('foliate-view').{'goRight' if ahead else 'goLeft'}()")
                moved = wait_for(lambda: (x := local_pos(page)) and x["cfi"] != before and x, 2)
                if moved:
                    return moved
            return None

        def shown(page) -> str | None:
            """The page the device shows (its view), saved or not."""
            return page.evaluate("() => document.querySelector('foliate-view')?.lastLocation?.cfi ?? null")

        def go(page, right: bool) -> bool:
            before = shown(page)
            page.evaluate(f"document.querySelector('foliate-view').{'goRight' if right else 'goLeft'}()")
            return bool(wait_for(lambda: shown(page) != before, 3))

        def reopen(page) -> None:
            """Back to the library and into the book: it opens at the newest place."""
            page.evaluate("location.hash = '#/'")
            page.wait_for_timeout(500)
            open_book(page)
            page.wait_for_timeout(700)

        def stays(cfi: str, seconds: float = 2.5) -> bool:
            """The server still has that place after a while."""
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if (s := server_pos()) and s["cfi"] != cfi:
                    return False
                time.sleep(0.2)
            return True

        # ---- setup: A imports the book, both open it ----------------------------
        print("A: sign in, import the sample book")
        sign_in(a, args.url, acc)
        a.set_input_files("input[type=file]", str(EPUB))
        book = wait_for(lambda: (r := http("GET", f"{URL}/rest/v1/books?select=id,text_path", headers=acc.headers)[2])
                        and r[0].get("text_path") and r[0], 60, every=0.5)
        if not check(bool(book), "A imported the book and uploaded it"):
            finish()
        bid = book["id"]
        print("B: sign in")
        sign_in(b, args.url, acc)
        check(bool(wait_for(lambda: b.evaluate(LOCAL_ROW, ["books", bid]), 30, every=0.3)), "B's library has the book")
        open_book(a)
        wait_for(server_pos, 15, every=0.3)
        open_book(b)
        b.wait_for_timeout(1500)

        def live() -> None:
            print(f"\nlive: A turns a page, B has the book open ({args.runs} runs)")
            for _ in range(args.runs):
                t0 = time.monotonic()
                mine = turn(a)
                got = mine and wait_for(on_server(mine["cfi"]), 20, every=0.03)
                record("live: A -> server", time.monotonic() - t0 if got else None)
                got = mine and wait_for(lambda: (x := local_pos(b)) and x["cfi"] == mine["cfi"], 20, every=0.03)
                record("live: A -> B", time.monotonic() - t0 if got else None)
                a.wait_for_timeout(1200)

        def leaving() -> None:
            # Android may freeze or throttle a background app within seconds: what
            # isn't sent within a second of leaving is cut off here, as there.
            print("\nleaving: A turns a page and goes to the background at once (cut off 1 s later)")
            t0 = time.monotonic()
            mine = turn(a)
            a.evaluate(HIDE)
            hidden = time.monotonic()
            got = mine and wait_for(on_server(mine["cfi"]), 1.0, every=0.03)
            took = time.monotonic() - t0 if got else None
            time.sleep(max(0.0, 1.0 - (time.monotonic() - hidden)))
            ctx_a.set_offline(True)
            record("leaving: A -> server", took)
            check(bool(got), "a page turned right before leaving the app reaches the server")
            ctx_a.set_offline(False)
            a.evaluate(SHOW)
            if mine:
                wait_for(on_server(mine["cfi"]), 15, every=0.2)
            a.wait_for_timeout(1500)

        def back() -> None:
            print(f"\nback: B offline while A reads, then B reconnects ({args.runs} runs)")
            for _ in range(args.runs):
                ctx_b.set_offline(True)
                b.wait_for_timeout(300)
                mine = turn(a)
                if mine:
                    wait_for(on_server(mine["cfi"]), 20, every=0.1)
                t0 = time.monotonic()
                ctx_b.set_offline(False)
                got = mine and wait_for(lambda: (x := local_pos(b)) and x["cfi"] == mine["cfi"], 20, every=0.03)
                record("back: reconnect -> B", time.monotonic() - t0 if got else None)
                b.wait_for_timeout(800)

        def opening() -> None:
            print("\nopening: B in the library and offline; A reads; B reconnects and opens the book at once")
            # An "Ir" offer of an earlier scenario (6 s on screen) must not count here.
            wait_for(lambda: b.get_by_text(TOAST).count() == 0, 10, every=0.2)
            b.evaluate("location.hash = '#/'")
            b.wait_for_timeout(800)
            ctx_b.set_offline(True)
            mine = turn(a)
            if mine:
                wait_for(on_server(mine["cfi"]), 20, every=0.1)
            ctx_b.set_offline(False)
            if args.trace:
                print(f"   {time.monotonic() - start:8.3f} [B] back online, opening the book")
            open_book(b)
            offered = bool(wait_for(lambda: b.get_by_text(TOAST).count() > 0, 4, every=0.1))
            check(not offered, "B opens at A's place directly (no \"Ir\" offer needed)")

        def newest(page) -> dict | None:
            """This device turns a page forward from where everyone is: its place, on the server."""
            reopen(page)
            before = (local_pos(page) or {}).get("cfi")
            if not go(page, True):
                go(page, False)
            mine = wait_for(lambda: (x := local_pos(page)) and x["cfi"] != before and x, 3)
            return mine if mine and wait_for(on_server(mine["cfi"]), 10, every=0.1) else None

        def jump(page, frac: float) -> dict | None:
            """An explicit jump with the slider (it counts even from a device behind)."""
            page.evaluate(f"""() => {{ const s = document.querySelector('input[type=range]'); s.value = '{frac:.3f}'; s.dispatchEvent(new Event('input')) }}""")
            mine = settled(page)  # (the same place as before if it was already there)
            return mine if mine and wait_for(on_server(mine["cfi"]), 10, every=0.1) else None

        def settled(page) -> dict | None:
            """The device's place once its last page turns were saved."""
            page.wait_for_timeout(600)
            return local_pos(page)

        def rules() -> None:
            print("\nrules: going back reaches the others; a device left behind doesn't take them back")
            mine = newest(a)
            reopen(b)  # both at A's place
            go(a, True)
            a_fwd = wait_for(lambda: (x := local_pos(a)) and x["cfi"] != mine["cfi"] and x, 3)
            wait_for(on_server(a_fwd["cfi"]), 10, every=0.1) if a_fwd else None
            t0 = time.monotonic()
            go(a, False)
            a_back = wait_for(lambda: (x := local_pos(a)) and x["cfi"] != a_fwd["cfi"] and x, 3) if a_fwd else None
            got = a_back and wait_for(on_server(a_back["cfi"]), 10, every=0.03)
            check(bool(got), "a page back on the device with the newest place reaches the server")
            got_b = a_back and wait_for(lambda: (x := local_pos(b)) and x["cfi"] == a_back["cfi"], 10, every=0.03)
            check(bool(got_b), "…and the other device")
            record("rules: page back A -> B", time.monotonic() - t0 if got_b else None)

            # A moves ahead twice; B (behind, "Ir" not taken) turns pages.
            for _ in range(2):
                go(a, True)
            a_now = settled(a)
            if not (a_back and a_now and a_now["cfi"] != a_back["cfi"] and wait_for(on_server(a_now["cfi"]), 10, every=0.1)):
                check(False, "A moved ahead"); return
            wait_for(lambda: (x := local_pos(b)) and x["cfi"] == a_now["cfi"], 10, every=0.05)
            go(b, False)
            check(stays(a_now["cfi"]), "a device left behind turning a page back doesn't take the others back")
            go(b, True)
            check(stays(a_now["cfi"]), "…nor turning one forward while still behind")
            # An explicit jump does count: the slider, to half of where A is.
            frac = a.evaluate("() => document.querySelector('foliate-view').lastLocation.fraction")
            b.evaluate(f"""() => {{ const s = document.querySelector('input[type=range]'); s.value = '{max(0.0, frac / 2):.3f}'; s.dispatchEvent(new Event('input')) }}""")
            jumped = wait_for(lambda: (s := server_pos()) and s["cfi"] != a_now["cfi"] and s, 10, every=0.1)
            check(bool(jumped) and jumped["device"] == (local_pos(b) or {}).get("device"), "an explicit jump (slider) on the device behind does count")
            # Now A is behind: "Ir", then a page back reaches the others.
            took = wait_for(lambda: a.get_by_text("Ir", exact=True).count() > 0, 6, every=0.1)
            if took:
                a.get_by_text("Ir", exact=True).first.click()
                a.wait_for_timeout(800)
            check(bool(took) and stays(jumped["cfi"], 1.5) if jumped else False, "\"Ir\" itself doesn't claim the place")
            go(a, False)
            after = wait_for(lambda: (s := server_pos()) and jumped and s["cfi"] != jumped["cfi"] and s, 10, every=0.1)
            check(bool(after) and after["device"] == (local_pos(a) or {}).get("device"), "after \"Ir\", a page back reaches the others")

        def stale() -> None:
            # The sample book is three short chapters: a page turn is a chapter.
            print("\nstale: B offline doesn't know A moved on")
            reopen(a)
            mine = jump(a, 0.55)  # the middle chapter: room both ways
            reopen(b)  # both there
            ctx_b.set_offline(True)
            go(a, True)
            a_now = settled(a)
            if not (mine and a_now and a_now["cfi"] != mine["cfi"] and wait_for(on_server(a_now["cfi"]), 10, every=0.1)):
                check(False, "A moved ahead"); ctx_b.set_offline(False); return
            go(b, False)  # B, unaware, goes back
            b_old = settled(b)
            b_old = b_old if b_old and b_old["cfi"] != mine["cfi"] else None
            if not b_old:
                print(f"   B's page back wasn't saved: B shows {shown(b)}, has {local_pos(b)}; A's place {mine}")
            ctx_b.set_offline(False)
            check(bool(b_old) and stays(a_now["cfi"], 4), "an older page from a device that hadn't synced is refused by the server")
            back = wait_for(lambda: (x := local_pos(b)) and x["cfi"] == a_now["cfi"], 10, every=0.1)
            check(bool(back), "…and the newer place comes back to that device")
            # Past the newer place: taken.
            start = jump(a, 0.0)
            reopen(b)
            ctx_b.set_offline(True)
            go(a, True)
            a_next = settled(a)
            if a_next and start and a_next["cfi"] != start["cfi"]:
                wait_for(on_server(a_next["cfi"]), 10, every=0.1)
            go(b, True)
            go(b, True)
            b_far = settled(b)
            b_far = b_far if b_far and a_next and b_far["cfi"] != a_next["cfi"] and b_far["section"] > a_next["section"] else None
            ctx_b.set_offline(False)
            got = b_far and wait_for(on_server(b_far["cfi"]), 10, every=0.1)
            if not got:
                print(f"   A moved to {a_next}; B moved to {b_far}; server has {server_pos()}; B has {local_pos(b)}")
            check(bool(got), "a page past the newer place, from a device that hadn't synced, is taken")

        def resize() -> None:
            print("\nresize: A behind, its window changes size")
            mine = newest(b)
            if not mine:
                check(False, "B moved ahead"); return
            wait_for(lambda: (x := local_pos(a)) and x["cfi"] == mine["cfi"], 10, every=0.05)
            for w in (360, 520, 400):
                a.set_viewport_size({"width": w, "height": 860})
                a.wait_for_timeout(700)
            check(stays(mine["cfi"]), "a re-layout on a device behind doesn't take the others back")

        def kobo() -> None:
            print("\nkobo: waiting for the KEPUB (built by A in the background)")
            kp = wait_for(lambda: (r := http("GET", f"{URL}/rest/v1/books?select=kepub_path&id=eq.{bid}", headers=acc.headers)[2])
                          and r[0].get("kepub_path"), 90, every=1)
            if not check(bool(kp), "KEPUB ready"):
                return
            token = secrets.token_urlsafe(32)
            sql(f"insert into kobo_devices (user_id, token_hash, name) values ({lit(acc.uid)}, {lit(hashlib.sha256(token.encode()).hexdigest())}, 'sync-e2e')")
            base = f"{URL}/functions/v1/kobo/{token}"
            headers = {"User-Agent": KOBO_UA, "x-kobo-deviceid": "sync-e2e"}
            _, _, kmap = http("GET", f"{URL}/storage/v1/object/library/{acc.uid}/{bid}/kepub.json", headers=acc.headers)
            files = kmap["files"]
            # The Kobo reads on from where everyone is, as a real one does (one
            # that reads behind a newer place it never took doesn't move it: see
            # rules, stale and kobo_e2e). The book's start leaves room ahead.
            jump(a, 0.0)
            reopen(b)
            http("GET", f"{base}/v1/library/{bid}/state", headers=headers)  # as a device that just opened the book
            order = [(f, k) for f in files for k in range(f["n"])]
            cur = server_pos() or {}
            first = next((n for n, (f, k) in enumerate(order) if (f["i"], k) == (cur.get("section"), cur.get("sentence"))), -1) + 1

            print(f"kobo -> B ({args.runs} runs)")
            for i in range(args.runs):
                f, k = order[min(first + i, len(order) - 1)]
                span = f"kobo.{k + 1}.1"
                a.wait_for_timeout(1200)  # newer than the last place (the device reports whole seconds)
                now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                body = {"ReadingStates": [{
                    "EntitlementId": bid, "LastModified": now,
                    "CurrentBookmark": {"LastModified": now, "ProgressPercent": 50,
                                        "Location": {"Value": span, "Type": "KoboSpan", "Source": f["p"]}},
                    "Statistics": {"LastModified": now, "SpentReadingMinutes": i, "RemainingTimeMinutes": 30},
                    "StatusInfo": {"LastModified": now, "Status": "Reading"},
                }]}
                want = (f["i"], int(span.split(".")[1]) - 1)
                t0 = time.monotonic()
                status, _, answer = http("PUT", f"{base}/v1/library/{bid}/state", body, headers)
                record("kobo: PUT answered", time.monotonic() - t0)
                got = wait_for(lambda: (x := local_pos(b)) and (x["section"], x["sentence"]) == want and x["device"].startswith("kobo:"), 20, every=0.03)
                record("kobo -> B", time.monotonic() - t0 if got else None)
                if not got or time.monotonic() - t0 > 3:
                    print(f"   slow or lost: {span} in {f['p']} (PUT {status}); server has {server_pos()}; B has {local_pos(b)}")
                    print("   log:", sql("select method, status, note, ms from kobo_log where device_id = (select id from kobo_devices where "
                                       f"name = 'sync-e2e' and user_id = {lit(acc.uid)}) order by at desc limit 2"))

            print(f"B -> kobo ({args.runs} runs)")
            reopen(b)  # B takes the Kobo's newest place first (as "Ir" or opening the book does)
            for _ in range(args.runs):
                t0 = time.monotonic()
                mine = turn(b)
                fl = next((x for x in files if x["i"] == mine["section"]), None) if mine else None

                def kobo_sees():
                    _, _, st = http("GET", f"{base}/v1/library/{bid}/state", headers=headers)
                    loc = st[0]["CurrentBookmark"].get("Location") if isinstance(st, list) and st else None
                    return loc and loc["Value"] == f"kobo.{mine['sentence'] + 1}.1" and loc["Source"] == fl["p"]
                got = wait_for(kobo_sees, 20, every=0.05) if fl else None
                record("B -> kobo (on opening the book)", time.monotonic() - t0 if got else None)
                if not got:
                    _, _, st = http("GET", f"{base}/v1/library/{bid}/state", headers=headers)
                    loc = st[0]["CurrentBookmark"].get("Location") if isinstance(st, list) and st else st
                    print(f"   lost: B saved {mine}; server has {server_pos()}; the Kobo gets {loc}")
                b.wait_for_timeout(1200)

            # The function's own time (kobo_log.ms), without the network to it.
            rows = sql(f"select method, ms from kobo_log where ms is not null and device_id = "
                       f"(select id from kobo_devices where name = 'sync-e2e' and user_id = {lit(acc.uid)})")
            for method, label in (("GET", "kobo: GET state, server time"), ("PUT", "kobo: PUT state, server time")):
                for r in rows:
                    if r["method"] == method:
                        record(label, r["ms"] / 1000)

        for name in only:
            {"live": live, "leaving": leaving, "back": back, "opening": opening, "rules": rules,
             "stale": stale, "resize": resize, "kobo": kobo}[name]()
        browser.close()

    print("\n" + "-" * 64)
    for name, values in results.items():
        ok = [v for v in values if v is not None]
        lost = len(values) - len(ok)
        line = f"{name:34} median {ms(statistics.median(ok)) if ok else '—':>9}   max {ms(max(ok)) if ok else '—':>9}"
        print(line + (f"   {lost} of {len(values)} never arrived" if lost else ""))
        check(not lost, f"{name}: every change arrived")
    finish()


if __name__ == "__main__":
    main()
