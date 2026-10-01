"""Passwords, login sessions and login rate limiting."""

from __future__ import annotations

import hashlib
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

SECURE_COOKIE = "__Host-academia"
PLAIN_COOKIE = "academia_session"
MIN_PASSWORD_LENGTH = 10

# Session last-seen/expiry is refreshed at most this often to avoid a write per request.
TOUCH_INTERVAL = timedelta(minutes=10)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
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
    """Sliding-window limits on failed logins, per client IP and per username."""

    def __init__(self, per_ip: int = 20, per_user: int = 8, window_s: int = 900) -> None:
        self.per_ip = per_ip
        self.per_user = per_user
        self.window = window_s
        self._ip: dict[str, deque[float]] = {}
        self._user: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, bucket: dict[str, deque[float]], key: str, now: float) -> deque[float]:
        q = bucket.setdefault(key, deque())
        while q and q[0] <= now - self.window:
            q.popleft()
        return q

    def check(self, ip: str, username: str) -> None:
        now = time.monotonic()
        with self._lock:
            ip_q = self._prune(self._ip, ip, now)
            user_q = self._prune(self._user, username.lower(), now)
            if len(ip_q) >= self.per_ip or len(user_q) >= self.per_user:
                oldest = min([q[0] for q in (ip_q, user_q) if q], default=now)
                wait = int(max(1, oldest + self.window - now) // 60) + 1
                raise TooManyRequests(
                    f"Too many failed sign-in attempts. Try again in about {wait} minutes.",
                    code="rate_limited",
                )

    def failure(self, ip: str, username: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._prune(self._ip, ip, now).append(now)
            self._prune(self._user, username.lower(), now).append(now)
            # Keep memory bounded if someone sprays usernames.
            if len(self._user) > 10000:
                self._user.clear()
            if len(self._ip) > 10000:
                self._ip.clear()

    def success(self, username: str) -> None:
        with self._lock:
            self._user.pop(username.lower(), None)

    def reset(self) -> None:
        with self._lock:
            self._ip.clear()
            self._user.clear()


login_limiter = LoginRateLimiter()
