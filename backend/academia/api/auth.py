"""Sign-in, sign-out and the signed-in user's own account."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import read_session
from ..errors import BadRequest, Unauthorized
from ..models import Session, User, utcnow
from ..security import (
    PLAIN_COOKIE,
    SECURE_COOKIE,
    burn_verify_time,
    create_session,
    hash_password,
    login_limiter,
    needs_rehash,
    revoke_user_sessions,
    token_hash,
    validate_new_password,
    verify_password,
)
from ..services.users import DEFAULT_PREFS, clean_display_name, find_user, user_json
from .deps import AnyUser, CurrentUser, Db, session_token, set_session_cookie

router = APIRouter(tags=["auth"])


class LoginBody(BaseModel):
    username: str = Field(max_length=128)
    password: str = Field(max_length=1024)


class PasswordBody(BaseModel):
    current_password: str = Field(max_length=1024)
    new_password: str = Field(max_length=1024)


class ProfileBody(BaseModel):
    display_name: str | None = Field(default=None, max_length=128)


class ReaderPrefs(BaseModel):
    layout: Literal["auto", "single", "double"] | None = None
    cover_alone: bool | None = None


class SortPrefs(BaseModel):
    key: Literal["name", "modified", "type", "pages"] | None = None
    dir: Literal["asc", "desc"] | None = None


class PrefsBody(BaseModel):
    theme: Literal["system", "light", "dark"] | None = None
    view: Literal["grid", "list"] | None = None
    sort: SortPrefs | None = None
    reader: ReaderPrefs | None = None


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _clear_cookies(response: Response) -> None:
    response.delete_cookie(SECURE_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
    response.delete_cookie(PLAIN_COOKIE, path="/", httponly=True, samesite="lax")


@router.post("/auth/login")
def login(body: LoginBody, request: Request, response: Response, db: Db) -> dict[str, Any]:
    ip = _client_ip(request)
    username = body.username.strip()
    login_limiter.check(username, ip)
    # Argon2 runs outside any write transaction: holding the database's write lock for it
    # would make every sign-in and every other write wait in line.
    with read_session() as rdb:
        found = find_user(rdb, username) if username else None
        account = (found.id, found.password_hash) if found else None
    if account is None:
        burn_verify_time(body.password)
        login_limiter.failure(ip)
        raise Unauthorized("Incorrect username or password.", code="invalid_credentials")
    user_id, password_hash = account
    if not verify_password(password_hash, body.password):
        login_limiter.failure(ip)
        raise Unauthorized("Incorrect username or password.", code="invalid_credentials")
    login_limiter.success(username)
    new_hash = hash_password(body.password) if needs_rehash(password_hash) else None
    user = db.get(User, user_id)
    if user is None or user.password_hash != password_hash:
        # Deleted, or the password was changed or reset while it was being verified.
        raise Unauthorized("Incorrect username or password.", code="invalid_credentials")
    if user.disabled_at is not None:
        raise Unauthorized("This account has been disabled. Contact your administrator.", code="disabled")
    if new_hash is not None:
        user.password_hash = new_hash
    user.last_login_at = utcnow()
    token = create_session(db, user, ip, request.headers.get("user-agent", ""))
    data = user_json(user)
    db.commit()
    set_session_cookie(response, token, secure=request.url.scheme == "https")
    return data


@router.post("/auth/logout")
def logout(request: Request, response: Response, db: Db) -> dict[str, bool]:
    token = session_token(request)
    if token:
        session = db.scalar(select(Session).where(Session.token_hash == token_hash(token)))
        if session is not None:
            db.delete(session)
            db.commit()
    _clear_cookies(response)
    return {"ok": True}


@router.get("/auth/me")
def me(user: AnyUser) -> dict[str, Any]:
    return user_json(user)


@router.post("/auth/password")
def change_password(body: PasswordBody, request: Request, user: AnyUser, db: Db) -> dict[str, Any]:
    ip = _client_ip(request)
    login_limiter.check(user.username, ip)
    # As in login, Argon2 runs before the write transaction starts.
    if not verify_password(user.password_hash, body.current_password):
        login_limiter.failure(ip)
        raise BadRequest("Your current password is incorrect.", code="invalid_password")
    login_limiter.success(user.username)
    validate_new_password(body.new_password)
    if body.new_password == body.current_password:
        raise BadRequest("Please choose a password you haven't used here.", code="weak_password")
    new_hash = hash_password(body.new_password)
    live = db.get(User, user.id)
    assert live is not None
    if live.password_hash != user.password_hash:
        raise BadRequest("Your current password is incorrect.", code="invalid_password")
    live.password_hash = new_hash
    live.must_change_password = False
    revoke_user_sessions(db, live.id, except_session_id=getattr(request.state, "session_id", None))
    data = user_json(live)
    db.commit()
    return data


@router.post("/auth/logout-others")
def logout_others(request: Request, user: CurrentUser, db: Db) -> dict[str, bool]:
    revoke_user_sessions(db, user.id, except_session_id=getattr(request.state, "session_id", None))
    db.commit()
    return {"ok": True}


@router.patch("/me/profile")
def update_profile(body: ProfileBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    live = db.get(User, user.id)
    assert live is not None
    if body.display_name is not None:
        live.display_name = clean_display_name(body.display_name)
    data = user_json(live)
    db.commit()
    return data


@router.patch("/me/prefs")
def update_prefs(body: PrefsBody, user: AnyUser, db: Db) -> dict[str, Any]:
    live = db.get(User, user.id)
    assert live is not None
    prefs = {**DEFAULT_PREFS, **(live.prefs or {})}
    patch = body.model_dump(exclude_none=True)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(prefs.get(key), dict):
            prefs[key] = {**prefs[key], **value}
        else:
            prefs[key] = value
    live.prefs = prefs
    data = user_json(live)
    db.commit()
    return data
