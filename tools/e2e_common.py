"""Shared pieces of the end-to-end checks against the real backend
(tools/kobo_e2e.py, tools/sync_e2e.py): HTTP and SQL helpers, a temporary
account (allow-listed, signed up, deleted with its files at the end) and signing
the real app in, in headless Chromium.

The SQL goes through the Management API: SUPABASE_PAT must hold a short-lived
token (CLAUDE.md, "Applying schema changes").
"""

import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REF = "uxavtsscsgtcjxfmfwrp"
URL = f"https://{REF}.supabase.co"
ANON = "sb_publishable_JYqkVR_9sR5BGEABXR8hvQ_0-1p14J4"
EPUB = ROOT / "client" / "tests" / "fixtures" / "muestra.epub"
KOBO_UA = ("Mozilla/5.0 (Linux; U; Android 2.0; en-us;) AppleWebKit/538.1 (KHTML, like Gecko) "
           "Version/4.0 Mobile Safari/538.1 (Kobo Touch 0390/4.45.23655)")

failures: list[str] = []


def check(ok: bool, what: str) -> bool:
    print(("  ok   " if ok else "  FAIL ") + what)
    if not ok:
        failures.append(what)
    return ok


def finish() -> None:
    print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: " + "; ".join(failures))
    sys.exit(1 if failures else 0)


def http(method: str, url: str, body=None, headers=None, raw=False):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            content = r.read()
            return r.status, dict(r.headers), content if raw else (json.loads(content) if content else None)
    except urllib.error.HTTPError as e:
        content = e.read()
        return e.code, dict(e.headers), content if raw else content.decode(errors="replace")


def sql(query: str):
    for attempt in range(3):  # the Management API times out now and then
        try:
            status, _, out = http("POST", f"https://api.supabase.com/v1/projects/{REF}/database/query", {"query": query},
                                  {"Authorization": f"Bearer {os.environ['SUPABASE_PAT']}", "User-Agent": "atril-e2e"})
        except TimeoutError:
            if attempt == 2:
                raise
            continue
        if status >= 300:
            raise RuntimeError(f"sql {status}: {out}")
        return out


def lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def wait_for(fn, timeout: float, every: float = 0.05):
    """fn() until it returns something truthy (returned), or None after timeout seconds."""
    end = time.monotonic() + timeout
    while True:
        got = fn()
        if got or time.monotonic() > end:
            return got or None
        time.sleep(every)


@dataclass
class Account:
    email: str
    password: str
    uid: str
    access: str

    @property
    def headers(self) -> dict:
        return {"apikey": ANON, "Authorization": f"Bearer {self.access}"}


@contextmanager
def temp_account(prefix: str = "atril-e2e"):
    """An allow-listed account, signed up; on exit it goes with its rows and files."""
    email = f"{prefix}-{secrets.token_hex(4)}@example.com"
    password = secrets.token_urlsafe(16)
    acc: Account | None = None
    print(f"test account {email}")
    sql(f"insert into allowed_emails values ({lit(email)}) on conflict do nothing")
    try:
        status, _, s = http("POST", f"{URL}/auth/v1/signup", {"email": email, "password": password}, {"apikey": ANON})
        assert status == 200 and s.get("access_token"), s
        acc = Account(email, password, s["user"]["id"], s["access_token"])
        yield acc
    finally:
        print("cleanup")
        if acc:
            for bucket in ("library", "audio"):
                _, _, folders = http("POST", f"{URL}/storage/v1/object/list/{bucket}", {"prefix": acc.uid, "limit": 100}, acc.headers)
                names = []
                for f in folders if isinstance(folders, list) else []:
                    _, _, files = http("POST", f"{URL}/storage/v1/object/list/{bucket}", {"prefix": f"{acc.uid}/{f['name']}", "limit": 100}, acc.headers)
                    if isinstance(files, list):
                        names += [f"{acc.uid}/{f['name']}/{x['name']}" for x in files]
                if names:
                    http("DELETE", f"{URL}/storage/v1/object/{bucket}", {"prefixes": names}, acc.headers)
            sql(f"delete from auth.users where id = {lit(acc.uid)}")
        sql(f"delete from allowed_emails where email = {lit(email)}")
        left = sql(f"select count(*) as n from storage.objects where name like {lit((acc.uid if acc else 'none') + '/%')}")[0]["n"]
        print(f"  test account, rows and {('no files' if left == 0 else str(left) + ' FILES')} left")


def sign_in(page, url: str, acc: Account) -> None:
    """The real app's sign-in screen, then wait for the library."""
    page.goto(url)
    page.fill("input[type=email]", acc.email)
    page.fill("input[type=password]", acc.password)
    page.click("button[type=submit]")
    page.wait_for_selector("input[type=file]", state="attached", timeout=30000)
