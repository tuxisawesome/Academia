"""User administration (admins only)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..errors import NotFound
from ..models import User
from ..services import users as users_service
from .deps import AdminUser, Db

router = APIRouter(prefix="/admin", tags=["admin"])


class CreateUserBody(BaseModel):
    username: str = Field(max_length=64)
    display_name: str = Field(default="", max_length=128)
    password: str | None = Field(default=None, max_length=1024)
    is_admin: bool = False


class UpdateUserBody(BaseModel):
    display_name: str | None = Field(default=None, max_length=128)
    is_admin: bool | None = None
    disabled: bool | None = None
    reset_password: bool = False


@router.get("/users")
def list_users(_admin: AdminUser, db: Db) -> list[dict[str, Any]]:
    return users_service.list_users(db)


@router.post("/users")
def create_user(body: CreateUserBody, _admin: AdminUser, db: Db) -> dict[str, Any]:
    user, generated = users_service.create_user(
        db,
        body.username,
        display_name=body.display_name,
        password=body.password or None,
        is_admin=body.is_admin,
        must_change=True,
    )
    data = {"user": users_service.user_json(user), "temporary_password": generated}
    db.commit()
    return data


@router.patch("/users/{user_id}")
def update_user(user_id: str, body: UpdateUserBody, admin: AdminUser, db: Db) -> dict[str, Any]:
    user, generated = users_service.update_user(
        db,
        admin,
        user_id,
        display_name=body.display_name,
        is_admin=body.is_admin,
        disabled=body.disabled,
        reset_password=body.reset_password,
    )
    data = {"user": users_service.user_json(user), "temporary_password": generated}
    db.commit()
    return data


@router.delete("/users/{user_id}")
def delete_user(user_id: str, admin: AdminUser, db: Db) -> dict[str, bool]:
    if db.get(User, user_id) is None:
        raise NotFound("User not found.")
    source_ids, job_ids = users_service.delete_user(db, admin, user_id)
    db.commit()
    users_service.remove_files(user_id, source_ids, job_ids)
    return {"ok": True}
