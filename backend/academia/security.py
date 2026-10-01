"""Passwords, login sessions and login rate limiting."""

from __future__ import annotations

import hashlib
import math
import os
import secrets
import string
import threading
import time
from collections import deque
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from sqlalchemy import delete, select
from sqlalchemy.orm import Session as DbSession

from .config import get_settings
from .errors import BadRequest, TooManyRequests
from .models import Session, User, utcnow

_hasher = PasswordHasher()

# Each Argon2 hash or verification needs 64 MiB and several CPU threads. Bound how many run
# at once so a burst of sign-in attempts cannot exhaust the server's memory.
_argon2_slots = threading.BoundedSemaphore(max(1, min(4, os.cpu_count() or 1)))

SECURE_COOKIE = "__Host-academia"
PLAIN_COOKIE = "academia_session"
MIN_PASSWORD_LENGTH = 10

# Session last-seen/expiry is refreshed at most this often to avoid a write per request.
TOUCH_INTERVAL = timedelta(minutes=10)


def hash_password(password: str) -> str:
    with _argon2_slots:
        return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        with _argon2_slots:
            return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


# A precomputed hash so failed logins for unknown users take as long as for known ones.
_DUMMY_HASH = _hasher.hash(secrets.token_hex(16))


def burn_verify_time(password: str) -> None:
    verify_password(_DUMMY_HASH, password)


def validate_new_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise BadRequest(f"Passwords must be at least {MIN_PASSWORD_LENGTH} characters long.", code="weak_password")
    if len(password) > 1024:
        raise BadRequest("That password is too long.", code="weak_password")


def generate_password(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits
    # Group in blocks of four for readability, e.g. "hT4k-9wQe-..."
    raw = "".join(secrets.choice(alphabet) for _ in range(length))
    return "-".join(raw[i : i + 4] for i in range(0, length, 4))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: DbSession, user: User, ip: str, user_agent: str) -> str:
    token = secrets.token_urlsafe(32)
    now = utcnow()
    db.add(
        Session(
            user_id=user.id,
            token_hash=token_hash(token),
            created_at=now,
            last_seen_at=now,
            expires_at=now + timedelta(days=get_settings().session_days),
            ip=ip[:64],
            user_agent=user_agent[:512],
        )
    )
    return token


def find_session(db: DbSession, token: str) -> Session | None:
    session = db.scalar(select(Session).where(Session.token_hash == token_hash(token)))
    if session is None or session.expires_at <= utcnow():
        return None
    return session


def revoke_user_sessions(db: DbSession, user_id: str, except_session_id: str | None = None) -> None:
    stmt = delete(Session).where(Session.user_id == user_id)
    if except_session_id:
        stmt = stmt.where(Session.id != except_session_id)
    db.execute(stmt)


class LoginRateLimiter:
    """Sliding-window limits on failed logins, per username and per client IP.

    The per-username limit is enforced before the password is checked. The per-IP limit is
    shared by everyone behind one address (a school's NAT, or every client when the app sits
    behind a tunnel), so it only turns away wrong passwords and never a correct one. Only an
    address with many times that many failures is turned away before the password is checked,
    which bounds the guesses one address can spread over all accounts and the Argon2 work it
    can cause.
    """

    def __init__(self, per_ip: int = 20, per_user: int = 8, window_s: int = 900, max_buckets: int = 10000) -> None:
        self.per_ip = per_ip
        # Far more failures than a class behind one address makes.
        self.ip_cap = 5 * per_ip
        self.per_user = per_user
        self.window = window_s
        self.max_buckets = max_buckets
        self._ip: dict[str, deque[float]] = {}
        self._user: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, bucket: dict[str, deque[float]], key: str, now: float) -> deque[float]:
        q = bucket.setdefault(key, deque())
        while q and q[0] <= now - self.window:
            q.popleft()
        return q

    def _bound(self, bucket: dict[str, deque[float]], now: float) -> None:
        """Keep memory bounded when someone sprays usernames or addresses.

        Expired buckets go first, then those with the fewest failures. Clearing everything
        instead would also wipe the count of an account that is being guessed at.
        """
        if len(bucket) <= self.max_buckets:
            return
        for key in [k for k, q in bucket.items() if not q or q[-1] <= now - self.window]:
            del bucket[key]
        if len(bucket) > self.max_buckets:
            for key in sorted(bucket, key=lambda k: len(bucket[k]))[: len(bucket) - self.max_buckets // 2]:
                del bucket[key]

    def _limit(self, q: deque[float], limit: int, now: float) -> None:
        if len(q) >= limit:
            # The bucket drops below its limit once its limit-th newest entry expires.
            wait = max(1, math.ceil((q[-limit] + self.window - now) / 60))
            raise TooManyRequests(
                f"Too many failed sign-in attempts. Try again in about {wait} minute{'' if wait == 1 else 's'}.",
                code="rate_limited",
            )

    def check(self, username: str, ip: str) -> None:
        """Start an attempt for ``username`` from ``ip``, or raise 429 if the account has failed
        too often or the address has reached its cap.

        The attempt counts as failed until ``success()``, so concurrent guesses can't all
        get past the limit before the first of them is verified.
        """
        now = time.monotonic()
        with self._lock:
            self._limit(self._prune(self._ip, ip, now), self.ip_cap, now)
            self._bound(self._ip, now)
            user_q = self._prune(self._user, username.lower(), now)
            self._limit(user_q, self.per_user, now)
            user_q.append(now)
            self._bound(self._user, now)

    def failure(self, ip: str) -> None:
        """Record a wrong password from ``ip``; raise 429 if that address was already over its limit."""
        now = time.monotonic()
        with self._lock:
            ip_q = self._prune(self._ip, ip, now)
            over = len(ip_q) >= self.per_ip
            # Failures over the limit are counted too, towards the cap that check() enforces.
            ip_q.append(now)
            self._bound(self._ip, now)
            if over:
                self._limit(ip_q, self.per_ip, now)

    def success(self, username: str) -> None:
        """Forget the failed attempts for ``username`` (correct password or admin reset)."""
        with self._lock:
            self._user.pop(username.lower(), None)

    def reset(self) -> None:
        with self._lock:
            self._ip.clear()
            self._user.clear()


login_limiter = LoginRateLimiter()
