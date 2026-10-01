"""User accounts (managed by admins; there is no self sign-up)."""

from __future__ import annotations

import re
import shutil
import unicodedata
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..errors import BadRequest, Conflict, NotFound
from ..models import NOTEBOOK, Job, Node, Source, User, utcnow
from ..security import generate_password, hash_password, login_limiter, revoke_user_sessions, validate_new_password
from ..storage import deleted_source_marker, remove_export_files, user_pdf_cache_dir
from .common import unwanted_in_name

USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

DEFAULT_PREFS: dict[str, Any] = {
    "theme": "system",
    "view": "grid",
    "sort": {"key": "name", "dir": "asc"},
    "reader": {"layout": "auto", "cover_alone": False},
}


def user_json(user: User) -> dict[str, Any]:
    prefs = {**DEFAULT_PREFS, **(user.prefs or {})}
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name or user.username,
        "is_admin": user.is_admin,
        "must_change_password": user.must_change_password,
        "disabled": user.disabled_at is not None,
        "created_at": user.created_at,
        "last_login_at": user.last_login_at,
        "prefs": prefs,
    }


def validate_username(username: str) -> str:
    username = (username or "").strip()
    if not USERNAME_RE.match(username):
        raise BadRequest(
            "Usernames are 1–64 characters: letters, digits, dots, dashes and underscores.",
            code="invalid_username",
        )
    return username


def clean_display_name(name: str | None) -> str:
    """``name`` without control characters and invisible formatting such as bidi overrides.

    Display names reach administrators' screens, including their terminal (``academia
    list-users``), where escape sequences could rewrite the output or drive the terminal.
    """
    cleaned = "".join(ch for ch in unicodedata.normalize("NFC", name or "") if not unwanted_in_name(ch))
    return " ".join(cleaned.split())[:128]


def find_user(db: Session, username: str) -> User | None:
    return db.scalar(select(User).where(User.username == username.strip()))


def create_user(
    db: Session,
    username: str,
    display_name: str = "",
    password: str | None = None,
    is_admin: bool = False,
    must_change: bool = True,
) -> tuple[User, str | None]:
    username = validate_username(username)
    generated = None
    if password:
        validate_new_password(password)
    else:
        password = generated = generate_password()
    # As in auth.login, Argon2 runs before the first query starts the write transaction.
    password_hash = hash_password(password)
    if find_user(db, username) is not None:
        raise Conflict("That username is already taken.", code="username_taken")
    user = User(
        username=username,
        display_name=clean_display_name(display_name),
        password_hash=password_hash,
        is_admin=is_admin,
        must_change_password=must_change,
        prefs={},
    )
    db.add(user)
    db.flush()
    return user, generated


def _active_admin_count(db: Session) -> int:
    return (
        db.scalar(select(func.count()).select_from(User).where(User.is_admin.is_(True), User.disabled_at.is_(None)))
        or 0
    )


def _guard_last_admin(db: Session, user: User) -> None:
    if user.is_admin and user.disabled_at is None and _active_admin_count(db) <= 1:
        raise Conflict("This is the only active administrator.", code="last_admin")


def update_user(
    db: Session,
    actor: User,
    user_id: str,
    *,
    display_name: str | None = None,
    is_admin: bool | None = None,
    disabled: bool | None = None,
    reset_password: bool = False,
) -> tuple[User, str | None]:
    generated = new_hash = None
    if reset_password:
        if user_id == actor.id:
            raise BadRequest("Use Settings → Account to change your own password.", code="self_change")
        # As in auth.login, Argon2 runs before the first query starts the write transaction.
        generated = generate_password()
        new_hash = hash_password(generated)
    user = db.get(User, user_id)
    if user is None:
        raise NotFound("User not found.")
    if display_name is not None:
        user.display_name = clean_display_name(display_name)
    if is_admin is not None and is_admin != user.is_admin:
        if user.id == actor.id:
            raise BadRequest("You can't change your own administrator role.", code="self_change")
        if not is_admin:
            _guard_last_admin(db, user)
        user.is_admin = is_admin
    if disabled is not None and disabled != (user.disabled_at is not None):
        if user.id == actor.id:
            raise BadRequest("You can't disable your own account.", code="self_change")
        if disabled:
            _guard_last_admin(db, user)
            user.disabled_at = utcnow()
            revoke_user_sessions(db, user.id)
        else:
            user.disabled_at = None
            login_limiter.success(user.username)
    if new_hash is not None:
        user.password_hash = new_hash
        user.must_change_password = True
        revoke_user_sessions(db, user.id)
        # Let the user sign in with the new password straight away, even if locked out.
        login_limiter.success(user.username)
    db.flush()
    return user, generated


def delete_user(db: Session, actor: User | None, user_id: str) -> tuple[list[str], list[str]]:
    """Delete a user and all of their data. Returns the source and export job ids whose files
    should be removed (see ``remove_files``)."""
    user = db.get(User, user_id)
    if user is None:
        raise NotFound("User not found.")
    if actor is not None and user.id == actor.id:
        raise BadRequest("You can't delete your own account.", code="self_change")
    _guard_last_admin(db, user)
    source_ids = list(db.scalars(select(Source.id).where(Source.owner_id == user.id)))
    # Jobs go with the user (ON DELETE CASCADE); their archives are found through these ids.
    job_ids = list(db.scalars(select(Job.id).where(Job.owner_id == user.id)))
    # Delete the tree first so pages go before the sources they reference.
    db.execute(delete(Node).where(Node.owner_id == user.id, Node.parent_id.is_(None)))
    db.execute(delete(Node).where(Node.owner_id == user.id))
    db.execute(delete(Source).where(Source.owner_id == user.id))
    db.delete(user)
    db.flush()
    return source_ids, job_ids


def remove_files(user_id: str, source_ids: list[str], job_ids: list[str]) -> None:
    """Remove a deleted user's files. Export archives and cached PDFs go now; uploads are left
    for maintenance to remove after the grace period that applies to all unused uploads, so
    that a recent database backup can still be restored with its files."""
    for sid in source_ids:
        marker = deleted_source_marker(sid)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    for job_id in job_ids:
        remove_export_files(job_id)
    shutil.rmtree(user_pdf_cache_dir(user_id), ignore_errors=True)


def list_users(db: Session) -> list[dict[str, Any]]:
    usage = dict(
        db.execute(
            select(Source.owner_id, func.coalesce(func.sum(Source.byte_size), 0)).group_by(Source.owner_id)
        ).all()
    )
    notebooks = dict(
        db.execute(
            select(Node.owner_id, func.count())
            .where(Node.kind == NOTEBOOK, Node.trashed_at.is_(None))
            .group_by(Node.owner_id)
        ).all()
    )
    out = []
    for user in db.scalars(select(User).order_by(func.lower(User.username))):
        item = user_json(user)
        item.pop("prefs", None)
        item["storage_bytes"] = int(usage.get(user.id, 0))
        item["notebook_count"] = int(notebooks.get(user.id, 0))
        out.append(item)
    return out
