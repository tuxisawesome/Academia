"""Search and sidebar pins."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from ..services import pins
from ..services import search as search_service
from ..services.classes import MAX_CLASSES, parse_date
from .deps import CurrentUser, Db

router = APIRouter(tags=["search"])


# ---- search --------------------------------------------------------------------------------


@router.get("/search")
def search(
    user: CurrentUser,
    db: Db,
    q: str = Query(default="", max_length=200),
    folder: str | None = Query(default=None, alias="in"),
    classes: list[str] = Query(default=[], alias="class", max_length=MAX_CLASSES),
    date_from: str | None = Query(default=None, alias="from", max_length=32),
    date_to: str | None = Query(default=None, alias="to", max_length=32),
) -> dict[str, Any]:
    return search_service.search(
        db,
        user.id,
        q,
        folder,
        class_ids=classes,
        date_from=parse_date(date_from) if date_from else None,
        date_to=parse_date(date_to) if date_to else None,
    )


# ---- pins -----------------------------------------------------------------------------------


class PinBody(BaseModel):
    node_id: str


class PinOrderBody(BaseModel):
    node_ids: list[str] = Field(max_length=200)


@router.get("/pins")
def list_pins(user: CurrentUser, db: Db) -> list[dict[str, Any]]:
    return pins.list_pins(db, user.id)


@router.post("/pins")
def add_pin(body: PinBody, user: CurrentUser, db: Db) -> list[dict[str, Any]]:
    pins.pin(db, user.id, body.node_id)
    db.commit()
    return pins.list_pins(db, user.id)


@router.delete("/pins/{node_id}")
def remove_pin(node_id: str, user: CurrentUser, db: Db) -> list[dict[str, Any]]:
    pins.unpin(db, user.id, node_id)
    db.commit()
    return pins.list_pins(db, user.id)


@router.put("/pins/order")
def order_pins(body: PinOrderBody, user: CurrentUser, db: Db) -> list[dict[str, Any]]:
    pins.reorder(db, user.id, body.node_ids)
    db.commit()
    return pins.list_pins(db, user.id)
