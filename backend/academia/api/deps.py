"""FastAPI dependencies: database sessions and the signed-in user."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request, Response
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..db import read_session, write_session
from ..errors import Forbidden, Unauthorized
from ..models import Session, User, utcnow
from ..security import PLAIN_COOKIE, SECURE_COOKIE, TOUCH_INTERVAL, find_session

log = logging.getLogger(__name__)


def get_db(request: Request) -> Iterator[DbSession]:
    """Read-only session for GET/HEAD, write-locked session otherwise.

    Handlers that write must call ``db.commit()`` themselves before returning, so the
    commit is guaranteed to happen before the response is sent.
    """
    factory = read_session if request.method in ("GET", "HEAD") else write_session
    with factory() as db:
        yield db


Db = Annotated[DbSession, Depends(get_db)]


def session_token(request: Request) -> str | None:
    # Over HTTPS only the __Host- cookie counts: a plain cookie could have been planted by a
    # sibling subdomain or over plain HTTP.
    if request.url.scheme == "https":
        return request.cookies.get(SECURE_COOKIE)
    return request.cookies.get(SECURE_COOKIE) or request.cookies.get(PLAIN_COOKIE)


def set_session_cookie(response: Response, token: str, secure: bool) -> None:
    response.set_cookie(
        SECURE_COOKIE if secure else PLAIN_COOKIE,
        token,
        max_age=get_settings().session_days * 86400,
        path="/",
        secure=secure,
        httponly=True,
        samesite="lax",
    )


def _load_session(request: Request) -> Session:
    token = session_token(request)
    if not token:
        raise Unauthorized("Please sign in.", code="unauthenticated")
    with read_session() as db:
        session = find_session(db, token)
        if session is None or session.user.disabled_at is not None:
            raise Unauthorized("Your session has ended. Please sign in again.", code="unauthenticated")
        user = session.user
        db.expunge_all()
    now = utcnow()
    if now - session.last_seen_at > TOUCH_INTERVAL:
        from datetime import timedelta

        try:
            with write_session() as db:
                live = db.get(Session, session.id)
                if live is not None:
                    live.last_seen_at = now
                    live.expires_at = now + timedelta(days=get_settings().session_days)
        except OperationalError:
            # Renewing is bookkeeping: when another write keeps the database locked for longer
            # than busy_timeout, the request goes ahead and a later one renews the session.
            log.warning("Session not renewed: the database is busy.")
        else:
            if live is not None:
                # The browser's cookie must slide too; GuardMiddleware sends it again.
                request.state.renew_session = token
    request.state.session_id = session.id
    request.state.user = user
    return session


def any_user(request: Request) -> User:
    """Signed-in user, even if they still have to change their password."""
    return _load_session(request).user


def current_user(request: Request) -> User:
    user = _load_session(request).user
    if user.must_change_password:
        raise Forbidden("Please choose a new password to continue.", code="password_change_required")
    return user


def admin_user(user: Annotated[User, Depends(current_user)]) -> User:
    if not user.is_admin:
        raise Forbidden("Administrator access is required.", code="admin_required")
    return user


AnyUser = Annotated[User, Depends(any_user)]
CurrentUser = Annotated[User, Depends(current_user)]
AdminUser = Annotated[User, Depends(admin_user)]
