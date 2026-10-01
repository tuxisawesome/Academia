"""Search, sidebar pins, and the handwriting-recognition queue used by browsers."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..db import read_session
from ..errors import NotFound
from ..models import Source
from ..services import ocr, pins
from ..services import search as search_service
from ..storage import source_path
from .deps import CurrentUser, Db

router = APIRouter(tags=["search"])


# ---- search --------------------------------------------------------------------------------


@router.get("/search")
def search(
    user: CurrentUser,
    db: Db,
    q: str = Query(default="", max_length=200),
    folder: str | None = Query(default=None, alias="in"),
) -> dict[str, Any]:
    return search_service.search(db, user.id, q, folder)


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


# ---- handwriting recognition queue -------------------------------------------------------


class ClaimBody(BaseModel):
    device: str = Field(min_length=8, max_length=64)
    engine: str = Field(min_length=1, max_length=64)
    rank: int = Field(ge=1, le=1000)
    limit: int = Field(default=4, ge=1, le=ocr.MAX_CLAIM)


class ResultItem(BaseModel):
    source_id: str
    index: int
    text: str = Field(default="", max_length=400_000)
    error: str | None = Field(default=None, max_length=500)


class SubmitBody(BaseModel):
    device: str = Field(min_length=8, max_length=64)
    engine: str = Field(min_length=1, max_length=64)
    rank: int = Field(ge=1, le=1000)
    items: list[ResultItem] = Field(max_length=ocr.MAX_CLAIM)


@router.post("/ocr/claim")
def claim_pages(body: ClaimBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    pages = ocr.claim(db, user.id, body.device, body.engine, body.rank, body.limit)
    db.commit()
    return {"pages": pages}


@router.post("/ocr/submit")
def submit_pages(body: SubmitBody, user: CurrentUser, db: Db) -> dict[str, int]:
    stored = ocr.submit(db, user.id, body.device, body.engine, body.rank, [i.model_dump() for i in body.items])
    db.commit()
    return {"stored": stored}


@router.post("/ocr/reset")
def reset_reading(user: CurrentUser, db: Db) -> dict[str, int]:
    count = ocr.reset(db, user.id)
    db.commit()
    return {"queued": count}


@router.get("/ocr/status")
def reading_status(user: CurrentUser, db: Db, rank: int | None = Query(default=None, ge=1)) -> dict[str, int]:
    return ocr.status(db, user.id, rank)


@router.get("/sources/{source_id}/file")
def source_file(source_id: str, user: CurrentUser) -> FileResponse:
    """The original uploaded PDF, for rendering pages in the browser (recognition)."""
    with read_session() as db:
        src = db.get(Source, source_id)
        if src is None or src.owner_id != user.id:
            raise NotFound()
    path = source_path(source_id)
    if not path.exists():
        raise NotFound()
    return FileResponse(
        path, media_type="application/pdf", headers={"Cache-Control": "private, max-age=31536000, immutable"}
    )
