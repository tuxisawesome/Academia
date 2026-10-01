"""Uploads, thumbnails, reading progress and exports."""

from __future__ import annotations

import hashlib
from typing import Any

import anyio
import anyio.to_thread
from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from starlette.requests import ClientDisconnect

from ..config import get_settings
from ..db import read_session
from ..errors import BadRequest, NotFound, TooLarge
from ..models import ReadingProgress, Source, new_id, utcnow
from ..services import export as export_service
from ..services.common import owned_node
from ..services.sources import store_upload
from ..services.thumbs import ensure_thumb
from ..storage import tmp_dir
from .deps import CurrentUser, Db

router = APIRouter(tags=["files"])


def _ingest_limiter(request: Request) -> anyio.CapacityLimiter:
    # Uploads wait for one of the few PDF workers. They queue here instead of in the
    # shared thread pool, so a burst of uploads cannot starve every other request.
    state = request.app.state
    limiter = getattr(state, "ingest_limiter", None)
    if limiter is None:
        limiter = state.ingest_limiter = anyio.CapacityLimiter(max(1, get_settings().pdf_workers))
    return limiter


@router.post("/sources")
async def upload_source(
    request: Request, user: CurrentUser, filename: str = Query(default="", max_length=500)
) -> dict[str, Any]:
    """Upload a PDF as the raw request body (``Content-Type: application/pdf``)."""
    limit = get_settings().max_upload_bytes
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise TooLarge(f"PDFs can be at most {limit // (1024 * 1024)} MB.", code="too_large")
    tmp = tmp_dir() / f"upload-{new_id()}.pdf"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    head = b""
    try:
        with open(tmp, "wb") as fh:
            async for chunk in request.stream():
                if not chunk:
                    continue
                size += len(chunk)
                if size > limit:
                    raise TooLarge(f"PDFs can be at most {limit // (1024 * 1024)} MB.", code="too_large")
                if len(head) < 1024:
                    head += chunk[: 1024 - len(head)]
                digest.update(chunk)
                fh.write(chunk)
        if size == 0:
            raise BadRequest("The uploaded file is empty.", code="empty_upload")
        if b"%PDF" not in head:
            raise BadRequest("That file is not a PDF.", code="not_pdf")
        return await anyio.to_thread.run_sync(
            store_upload, user.id, tmp, digest.hexdigest(), size, filename, limiter=_ingest_limiter(request)
        )
    except ClientDisconnect:
        raise BadRequest("The upload was interrupted.", code="upload_interrupted") from None
    finally:
        tmp.unlink(missing_ok=True)


@router.get("/thumbs/{source_id}/{idx}")
def thumbnail(source_id: str, idx: int, user: CurrentUser, w: int = Query(default=400, ge=1, le=4000)) -> FileResponse:
    with read_session() as db:
        src = db.get(Source, source_id)
        if src is None or src.owner_id != user.id or not (0 <= idx < src.page_count):
            raise NotFound()
    path = ensure_thumb(source_id, idx, w)
    return FileResponse(
        path, media_type="image/webp", headers={"Cache-Control": "private, max-age=31536000, immutable"}
    )


class ProgressBody(BaseModel):
    page_id: str | None = None
    page_index: int = Field(default=0, ge=0)


@router.get("/progress/{node_id}")
def get_progress(node_id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    owned_node(db, user.id, node_id, ("notebook", "bookmark"))
    row = db.scalar(
        select(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.node_id == node_id)
    )
    if row is None:
        return {"page_id": None, "page_index": 0, "updated_at": None}
    return {"page_id": row.page_id, "page_index": row.page_index, "updated_at": row.updated_at}


@router.put("/progress/{node_id}")
def put_progress(node_id: str, body: ProgressBody, user: CurrentUser, db: Db) -> dict[str, bool]:
    owned_node(db, user.id, node_id, ("notebook", "bookmark"))
    row = db.get(ReadingProgress, (user.id, node_id))
    if row is None:
        row = ReadingProgress(user_id=user.id, node_id=node_id)
        db.add(row)
    row.page_id = body.page_id
    row.page_index = body.page_index
    row.updated_at = utcnow()
    db.commit()
    return {"ok": True}


class ExportBody(BaseModel):
    embed_bookmarks: bool = True
    bookmark_pdfs: bool = False


@router.post("/exports")
def start_export(body: ExportBody, user: CurrentUser) -> dict[str, Any]:
    return export_service.start_export(user.id, body.embed_bookmarks, body.bookmark_pdfs)


@router.get("/exports")
def list_exports(user: CurrentUser) -> list[dict[str, Any]]:
    return export_service.latest_jobs(user.id)


@router.get("/exports/{job_id}")
def export_status(job_id: str, user: CurrentUser) -> dict[str, Any]:
    return export_service.job_json(export_service.get_job(user.id, job_id))


@router.get("/exports/{job_id}/download")
def export_download(
    job_id: str, user: CurrentUser, tz: str | None = Query(default=None, max_length=64)
) -> FileResponse:
    path, filename = export_service.export_file(user.id, job_id, tz)
    return FileResponse(
        path, media_type="application/zip", filename=filename, headers={"Cache-Control": "private, no-store"}
    )
