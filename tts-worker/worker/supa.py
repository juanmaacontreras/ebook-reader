"""Minimal Supabase client (Auth + PostgREST + Storage over HTTPS).

The worker signs in as the user (same email and password as the app), so RLS
applies to it like to any device and no secret/admin key exists anywhere. The
refresh token is kept in tts-worker/.session.json (gitignored) and rotated on
every refresh, so the password is asked only once per PC.
"""

from __future__ import annotations

import gzip
import json
import time
from pathlib import Path
from typing import Any

import httpx


class AuthError(RuntimeError):
    pass


class Supabase:
    def __init__(self, url: str, key: str, session_file: Path):
        self.url = url.rstrip("/")
        self.key = key
        self.session_file = session_file
        self.session: dict[str, Any] = {}
        if session_file.exists():
            self.session = json.loads(session_file.read_text(encoding="utf-8"))
        self.http = httpx.Client(timeout=httpx.Timeout(60.0, connect=15.0), event_hooks={"request": [self._auth]})

    # ---- Auth -----------------------------------------------------------------
    @property
    def user_id(self) -> str:
        return self.session["user"]["id"]

    def signed_in(self) -> bool:
        return bool(self.session.get("refresh_token"))

    def _token(self, grant: str, body: dict[str, str]) -> None:
        r = httpx.post(f"{self.url}/auth/v1/token", params={"grant_type": grant}, json=body,
                       headers={"apikey": self.key}, timeout=30)
        if r.status_code >= 400:
            raise AuthError(r.json().get("error_description") or r.json().get("msg") or r.text)
        s = r.json()
        s["expires_at"] = time.time() + s.get("expires_in", 3600)
        self.session = s
        self.session_file.write_text(json.dumps(s), encoding="utf-8")
        try:
            self.session_file.chmod(0o600)
        except OSError:
            pass

    def sign_in(self, email: str, password: str) -> None:
        self._token("password", {"email": email, "password": password})

    def sign_up(self, email: str, password: str) -> None:
        """Create the account (sign-ups are allow-listed and auto-confirmed), then sign in."""
        r = httpx.post(f"{self.url}/auth/v1/signup", json={"email": email, "password": password},
                       headers={"apikey": self.key}, timeout=30)
        if r.status_code >= 400:
            body = r.json()
            raise AuthError(body.get("msg") or body.get("error_description") or body.get("message") or r.text)
        self.sign_in(email, password)

    def _auth(self, request: httpx.Request) -> None:
        if self.session.get("expires_at", 0) - time.time() < 120:
            self._token("refresh_token", {"refresh_token": self.session["refresh_token"]})
        request.headers["apikey"] = self.key
        request.headers["Authorization"] = f"Bearer {self.session['access_token']}"

    # ---- PostgREST ----------------------------------------------------------
    def select(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        r = self.http.get(f"{self.url}/rest/v1/{table}", params=params)
        r.raise_for_status()
        return r.json()

    def upsert(self, table: str, rows: list[dict[str, Any]] | dict[str, Any], on_conflict: str) -> None:
        r = self.http.post(
            f"{self.url}/rest/v1/{table}",
            params={"on_conflict": on_conflict},
            headers={"Prefer": "resolution=merge-duplicates,return=minimal", "Content-Type": "application/json"},
            content=json.dumps(rows),
        )
        r.raise_for_status()

    def update(self, table: str, match: dict[str, str], values: dict[str, Any]) -> None:
        r = self.http.patch(
            f"{self.url}/rest/v1/{table}",
            params={k: f"eq.{v}" for k, v in match.items()},
            headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
            content=json.dumps(values),
        )
        r.raise_for_status()

    def delete(self, table: str, match: dict[str, str]) -> None:
        r = self.http.delete(f"{self.url}/rest/v1/{table}", params={k: f"eq.{v}" for k, v in match.items()})
        r.raise_for_status()

    # ---- Storage --------------------------------------------------------------
    def download(self, bucket: str, path: str) -> bytes:
        r = self.http.get(f"{self.url}/storage/v1/object/{bucket}/{path}")
        r.raise_for_status()
        return r.content

    def download_json_gz(self, bucket: str, path: str) -> Any:
        data = self.download(bucket, path)
        if data[:2] == b"\x1f\x8b":
            data = gzip.decompress(data)
        return json.loads(data)

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        r = self.http.post(
            f"{self.url}/storage/v1/object/{bucket}/{path}",
            headers={"Content-Type": content_type, "x-upsert": "true"},
            content=data,
            timeout=httpx.Timeout(300.0, connect=15.0),
        )
        r.raise_for_status()

    def remove(self, bucket: str, paths: list[str]) -> None:
        for i in range(0, len(paths), 100):
            r = self.http.request(
                "DELETE", f"{self.url}/storage/v1/object/{bucket}",
                headers={"Content-Type": "application/json"}, content=json.dumps({"prefixes": paths[i : i + 100]}),
            )
            r.raise_for_status()
