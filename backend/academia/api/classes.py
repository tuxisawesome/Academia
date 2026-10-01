"""The user's classes (Settings → Classes), which pages are tagged with."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..services import classes as classes_service
from .deps import CurrentUser, Db

router = APIRouter(tags=["classes"])


class ClassBody(BaseModel):
    name: str = Field(max_length=1000)
    color: str | None = None


class ClassPatch(BaseModel):
    name: str | None = Field(default=None, max_length=1000)
    color: str | None = None
    clear_color: bool = False


class ClassOrderBody(BaseModel):
    class_ids: list[str] = Field(max_length=classes_service.MAX_CLASSES)


@router.get("/classes")
def list_classes(user: CurrentUser, db: Db) -> list[dict[str, Any]]:
    return classes_service.list_classes(db, user.id)


@router.post("/classes")
def create_class(body: ClassBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    cls = classes_service.create_class(db, user.id, body.name, body.color)
    data = classes_service.class_json(db, user.id, cls.id)
    db.commit()
    return data


@router.put("/classes/order")
def order_classes(body: ClassOrderBody, user: CurrentUser, db: Db) -> list[dict[str, Any]]:
    classes_service.reorder(db, user.id, body.class_ids)
    db.commit()
    return classes_service.list_classes(db, user.id)


@router.patch("/classes/{class_id}")
def update_class(class_id: str, body: ClassPatch, user: CurrentUser, db: Db) -> dict[str, Any]:
    cls = classes_service.update_class(
        db, user.id, class_id, name=body.name, color=body.color, clear_color=body.clear_color
    )
    data = classes_service.class_json(db, user.id, cls.id)
    db.commit()
    return data


@router.delete("/classes/{class_id}")
def delete_class(class_id: str, user: CurrentUser, db: Db) -> dict[str, bool]:
    classes_service.delete_class(db, user.id, class_id)
    db.commit()
    return {"ok": True}
