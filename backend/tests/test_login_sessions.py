"""Regression tests for sign-in, sessions, rate limiting and cookies (group BE-5a)."""

from __future__ import annotations

import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from academia import config, security
from academia.api import auth as auth_api
from academia.db import write_session
from academia.errors import TooManyRequests
from academia.models import Session, utcnow
from academia.services import users as users_service
from conftest import ORIGIN, PASSWORD, add_user, login

HTTPS_ORIGIN = "https://testserver"


def _write_lock_free() -> bool:
    """Can an independent connection take the database write lock right now?"""
    conn = sqlite3.connect(config.get_settings().db_path, timeout=0, isolation_level=None)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("ROLLBACK")
        return True
    except sqlite3.OperationalError:
        return False
    finally:
        conn.close()


# Argon2 must not run while the database-wide write lock is held.


def test_login_verifies_password_without_write_lock(anon, monkeypatch):
    add_user("carol")
    seen: list[bool] = []
    real = auth_api.verify_password
    monkeypatch.setattr(auth_api, "verify_password", lambda h, p: seen.append(_write_lock_free()) or real(h, p))
    r = anon.post("/api/auth/login", json={"username": "carol", "password": PASSWORD})
    assert r.status_code == 200, r.text
    assert seen == [True]


def test_unknown_user_burn_runs_without_write_lock(anon, monkeypatch):
    seen: list[bool] = []
    real = auth_api.burn_verify_time
    monkeypatch.setattr(auth_api, "burn_verify_time", lambda p: seen.append(_write_lock_free()) or real(p))
    r = anon.post("/api/auth/login", json={"username": "nobody", "password": "whatever-123"})
    assert r.status_code == 401
    assert seen == [True]


def test_change_password_hashes_without_write_lock(anon, monkeypatch):
    add_user("dora")
    login(anon, "dora")
    seen: list[bool] = []
    real_verify, real_hash = auth_api.verify_password, auth_api.hash_password
    monkeypatch.setattr(auth_api, "verify_password", lambda h, p: seen.append(_write_lock_free()) or real_verify(h, p))
    monkeypatch.setattr(auth_api, "hash_password", lambda p: seen.append(_write_lock_free()) or real_hash(p))
    r = anon.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "a much better password"})
    assert r.status_code == 200, r.text
    assert seen == [True, True]
    assert anon.get("/api/auth/me").status_code == 200
    anon.post("/api/auth/logout")
    login(anon, "dora", "a much better password")


def test_admin_reset_and_new_user_hash_without_write_lock(client, monkeypatch):
    uid = add_user("kate")
    seen: list[bool] = []
    real = users_service.hash_password
    monkeypatch.setattr(users_service, "hash_password", lambda p: seen.append(_write_lock_free()) or real(p))
    r = client.patch(f"/api/admin/users/{uid}", json={"reset_password": True})
    assert r.status_code == 200, r.text
    r = client.post("/api/admin/users", json={"username": "liam"})
    assert r.status_code == 200, r.text
    assert seen == [True, True]


def test_slow_login_does_not_block_other_writes(client, anon, monkeypatch):
    add_user("dave")
    real = auth_api.verify_password
    started = threading.Event()
    release = threading.Event()

    def slow(h, p):
        started.set()
        release.wait(10)
        return real(h, p)

    monkeypatch.setattr(auth_api, "verify_password", slow)
    with ThreadPoolExecutor(1) as ex:
        fut = ex.submit(lambda: anon.post("/api/auth/login", json={"username": "dave", "password": PASSWORD}))
        assert started.wait(10)
        try:
            assert _write_lock_free()
            r = client.post("/api/folders", json={"name": "During login"})
        finally:
            release.set()
        assert r.status_code == 200, r.text
        assert fut.result().status_code == 200


def test_password_reset_during_login_verification_wins(client, anon, monkeypatch):
    """A login that verified the old password must not create a session after an admin reset."""
    uid = add_user("gina")
    real = auth_api.verify_password

    def reset_meanwhile(h, p):
        ok = real(h, p)
        r = client.patch(f"/api/admin/users/{uid}", json={"reset_password": True})
        assert r.status_code == 200, r.text
        return ok

    monkeypatch.setattr(auth_api, "verify_password", reset_meanwhile)
    r = anon.post("/api/auth/login", json={"username": "gina", "password": PASSWORD})
    assert r.status_code == 401
    assert anon.get("/api/auth/me").status_code == 401


# Limit how many Argon2 operations (64 MiB each) run at once.


def test_argon2_concurrency_is_bounded(anon, monkeypatch):
    lock = threading.Lock()
    active = peak = 0

    class CountingHasher:
        def verify(self, _h, _p):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.2)
            with lock:
                active -= 1
            return False

    monkeypatch.setattr(security, "_hasher", CountingHasher())

    def attempt(i: int) -> int:
        # An empty username skips the user lookup entirely.
        return anon.post("/api/auth/login", json={"username": "", "password": f"guess-{i}"}).status_code

    with ThreadPoolExecutor(8) as ex:
        codes = list(ex.map(attempt, range(8)))
    assert codes == [401] * 8
    assert 1 <= peak <= 4


# Sliding expiry must also renew the browser cookie.


def _age_session() -> None:
    with write_session() as db:
        session = db.scalars(select(Session)).one()
        now = utcnow()
        session.created_at = now - timedelta(days=29)
        session.last_seen_at = now - timedelta(minutes=11)
        session.expires_at = now + timedelta(days=1)


def test_session_renewal_refreshes_cookie(client):
    token = client.cookies.get(security.PLAIN_COOKIE)
    assert client.get("/api/auth/me").headers.get("set-cookie") is None
    _age_session()
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    cookie = r.headers.get("set-cookie")
    assert cookie is not None
    assert cookie.startswith(f"{security.PLAIN_COOKIE}={token};")
    assert "Max-Age=2592000" in cookie and "HttpOnly" in cookie and "Path=/" in cookie
    assert "Secure" not in cookie
    # Only renewals carry the cookie.
    assert client.get("/api/auth/me").headers.get("set-cookie") is None


def test_session_renewal_refreshes_secure_cookie_over_https(app):
    add_user("hank")
    with TestClient(app, base_url=HTTPS_ORIGIN, headers={"Origin": HTTPS_ORIGIN}) as c:
        login(c, "hank")
        token = c.cookies.get(security.SECURE_COOKIE)
        assert token
        _age_session()
        r = c.get("/api/tree")
        assert r.status_code == 200
        cookie = r.headers.get("set-cookie")
        assert cookie is not None and cookie.startswith(f"{security.SECURE_COOKIE}={token};")
        assert "Secure" in cookie and "Max-Age=2592000" in cookie


# Over HTTPS only the __Host- cookie may carry the session.


def test_plain_cookie_is_ignored_over_https(app):
    add_user("mallory")
    with TestClient(app, base_url=HTTPS_ORIGIN, headers={"Origin": HTTPS_ORIGIN}) as c:
        login(c, "mallory")
        token = c.cookies.get(security.SECURE_COOKIE)
        assert c.get("/api/auth/me").status_code == 200
    with TestClient(app, base_url=HTTPS_ORIGIN, headers={"Origin": HTTPS_ORIGIN}) as victim:
        victim.cookies.set(security.PLAIN_COOKIE, token)
        assert victim.get("/api/auth/me").status_code == 401
        assert victim.post("/api/folders", json={"name": "Planted"}).status_code == 401


def test_plain_cookie_still_works_over_http(client):
    assert client.cookies.get(security.PLAIN_COOKIE)
    assert client.get("/api/auth/me").status_code == 200


# Failures by others from a shared address must not block a correct password.


def test_shared_address_failures_do_not_block_correct_login(anon):
    add_user("frank")
    for i in range(20):
        r = anon.post("/api/auth/login", json={"username": f"student{i}", "password": "wrong-password-1"})
        assert r.status_code == 401
    r = anon.post("/api/auth/login", json={"username": "frank", "password": PASSWORD})
    assert r.status_code == 200, r.text
    # Further wrong guesses from that address are still answered as rate limited.
    r = anon.post("/api/auth/login", json={"username": "frank", "password": "wrong-password-1"})
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "rate_limited"


# An address that keeps failing is turned away before any password is checked: guesses spread
# over many accounts, and the Argon2 work they cost, stay bounded.


def test_address_far_over_its_limit_is_refused_before_verification(app, anon, monkeypatch):
    add_user("frank")
    login(anon, "frank")
    real = security._hasher
    verified = 0

    class CountingHasher:
        def verify(self, _h, _p):
            nonlocal verified
            verified += 1
            return False

    monkeypatch.setattr(security, "_hasher", CountingHasher())
    codes = [
        anon.post("/api/auth/login", json={"username": f"student{i}", "password": "springtime-2026"}).status_code
        for i in range(100)
    ]
    assert codes == [401] * 20 + [429] * 80
    assert verified == 100
    for username in ("student100", "frank"):
        r = anon.post("/api/auth/login", json={"username": username, "password": PASSWORD})
        assert r.status_code == 429
        assert r.json()["error"]["code"] == "rate_limited"
    r = anon.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "a much better password"})
    assert r.status_code == 429
    assert verified == 100

    # Other addresses are not affected.
    monkeypatch.setattr(security, "_hasher", real)
    with TestClient(app, base_url=ORIGIN, headers={"Origin": ORIGIN}, client=("192.0.2.7", 50000)) as elsewhere:
        login(elsewhere, "frank")


# Concurrent attempts must not slip past the per-username limit.


def test_in_flight_attempts_count_towards_user_limit():
    limiter = security.LoginRateLimiter()
    for _ in range(8):
        limiter.check("alice", "10.0.0.1")
    with pytest.raises(TooManyRequests):
        limiter.check("alice", "10.0.0.1")
    limiter.success("alice")
    limiter.check("alice", "10.0.0.1")


def test_spraying_usernames_does_not_reset_a_locked_account():
    """With the per-address limit turning attempts away before verification only far above its
    limit, one client can spray usernames; keeping memory bounded must not wipe a guessed
    account's count."""
    limiter = security.LoginRateLimiter(max_buckets=100)
    for _ in range(8):
        limiter.check("alice", "10.0.0.1")
    for i in range(500):
        limiter.check(f"spray{i}", "10.0.0.1")
    assert len(limiter._user) <= 101
    with pytest.raises(TooManyRequests):
        limiter.check("alice", "10.0.0.1")


def test_concurrent_guesses_respect_user_limit(anon, monkeypatch):
    add_user("ivan")
    real = auth_api.verify_password

    def slow(h, p):
        time.sleep(0.3)
        return real(h, p)

    monkeypatch.setattr(auth_api, "verify_password", slow)

    def guess(i: int) -> int:
        return anon.post("/api/auth/login", json={"username": "ivan", "password": f"guess-{i}"}).status_code

    with ThreadPoolExecutor(16) as ex:
        codes = list(ex.map(guess, range(16)))
    assert codes.count(401) <= 8
    assert codes.count(429) == 16 - codes.count(401)


# An admin password reset lifts the account's sign-in lockout.


def test_admin_reset_lifts_lockout(client, anon):
    uid = add_user("erin")
    for _ in range(8):
        assert anon.post("/api/auth/login", json={"username": "erin", "password": "nope-nope-nope"}).status_code == 401
    assert anon.post("/api/auth/login", json={"username": "erin", "password": PASSWORD}).status_code == 429
    r = client.patch(f"/api/admin/users/{uid}", json={"reset_password": True})
    assert r.status_code == 200, r.text
    temp = r.json()["temporary_password"]
    r = anon.post("/api/auth/login", json={"username": "erin", "password": temp})
    assert r.status_code == 200, r.text


# Guesses of the current password are rate limited like sign-ins.


def test_change_password_guesses_are_rate_limited(anon):
    add_user("judy")
    login(anon, "judy")
    codes = [
        anon.post(
            "/api/auth/password", json={"current_password": f"wrong-{i}", "new_password": "a much better password"}
        ).status_code
        for i in range(10)
    ]
    assert codes[:8] == [400] * 8
    assert codes[8:] == [429, 429]
    r = anon.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "a much better password"})
    assert r.status_code == 429


# The advertised wait comes from the bucket that is actually full.


def test_lockout_wait_uses_the_full_bucket(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(security, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    limiter = security.LoginRateLimiter()
    limiter.check("housemate", "10.0.0.1")
    limiter.failure("10.0.0.1")
    clock[0] += 14 * 60
    for _ in range(8):
        limiter.check("alice", "10.0.0.1")
        limiter.failure("10.0.0.1")
    clock[0] += 10
    with pytest.raises(TooManyRequests) as exc:
        limiter.check("alice", "10.0.0.1")
    assert "about 15 minutes" in exc.value.message
    clock[0] += 14 * 60 + 20
    with pytest.raises(TooManyRequests) as exc:
        limiter.check("alice", "10.0.0.1")
    assert "about 1 minute." in exc.value.message
