"""Notebook and bookmark endpoints, including PDF downloads."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..db import read_session
from ..errors import Conflict
from ..services import bookmarks as bm_service
from ..services import pages as pages_service
from ..services.describe import describe_nodes
from ..services.export import safe_filename
from ..services.pdfbuild import bookmark_spec, ensure_pdf, notebook_spec, spec_digest
from ..services.tree import all_notebooks, require_notebook
from .deps import CurrentUser, Db

router = APIRouter(tags=["notebooks"])


class NotebookBody(BaseModel):
    parent_id: str | None = None
    name: str = Field(max_length=1000)
    source_id: str | None = None


# The id lists below have no length limit (a notebook can have any number of pages), so they
# stop at their first invalid item (fail_fast): one error object per item would let a request
# of a few MB take hundreds of MB of memory.


class InsertBody(BaseModel):
    base_rev: int | None = None
    source_id: str
    at: Literal["start", "end", "after"] = "end"
    after_page_id: str | None = None
    add_to_bookmarks: list[str] = Field(default_factory=list, fail_fast=True)


class OrderBody(BaseModel):
    base_rev: int | None = None
    page_ids: list[str] = Field(fail_fast=True)


class PagesBody(BaseModel):
    base_rev: int | None = None
    page_ids: list[str] = Field(min_length=1, fail_fast=True)


class RotateBody(PagesBody):
    delta: Literal[90, 180, 270, -90]


class UndeleteBody(BaseModel):
    batch: str


class BookmarkBody(BaseModel):
    parent_id: str | None = None
    name: str = Field(max_length=1000)
    notebook_id: str
    page_ids: list[str] = Field(default_factory=list, fail_fast=True)


class BookmarkPagesBody(BaseModel):
    page_ids: list[str] = Field(fail_fast=True)
    base_rev: int | None = None


def _pdf_response(path, digest: str, filename: str, download: bool) -> FileResponse:  # noqa: ANN001
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=filename,
        content_disposition_type="attachment" if download else "inline",
        headers={"ETag": f'"{digest}"', "Cache-Control": "private, no-cache"},
    )


def _check_digest(spec: dict[str, Any], d: str | None) -> None:
    # The reader pins its URL to the digest of the PDF it opened and keeps fetching byte
    # ranges from it; answer with 409 rather than slices of a different file.
    if d is not None and d != spec_digest(spec):
        raise Conflict("This document has changed. Reloading…", code="stale_rev")


def _notebook_detail(db, user_id: str, notebook_id: str) -> dict[str, Any]:  # noqa: ANN001
    data = pages_service.notebook_detail(db, user_id, notebook_id)
    # Digest of the reader PDF (its ETag), for the reader's `?d=` URL.
    data["pdf_digest"] = (
        spec_digest(notebook_spec(db, user_id, notebook_id, with_outline=False)[1])
        if data["trashed_at"] is None
        else None
    )
    return data


def _bookmark_detail(db, user_id: str, bookmark_id: str) -> dict[str, Any]:  # noqa: ANN001
    data = bm_service.bookmark_detail(db, user_id, bookmark_id)
    data["pdf_digest"] = (
        spec_digest(bookmark_spec(db, user_id, bookmark_id, with_outline=False)[2])
        if data["trashed_at"] is None and data["available"]
        else None
    )
    return data


# ---- notebooks -------------------------------------------------------------------------


@router.post("/notebooks")
def create_notebook(body: NotebookBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    node = pages_service.create_notebook(db, user.id, body.parent_id, body.name, body.source_id)
    data = describe_nodes(db, [node])[0]
    db.commit()
    return data


@router.get("/notebooks")
def list_notebooks(user: CurrentUser, db: Db) -> list[dict[str, Any]]:
    return all_notebooks(db, user.id)


@router.get("/notebooks/{notebook_id}")
def notebook_detail(notebook_id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    return _notebook_detail(db, user.id, notebook_id)


def _detail_after(db, user_id: str, notebook_id: str) -> dict[str, Any]:  # noqa: ANN001
    db.commit()
    with read_session() as fresh:
        return _notebook_detail(fresh, user_id, notebook_id)


@router.post("/notebooks/{notebook_id}/pages/insert")
def insert_pages(notebook_id: str, body: InsertBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    new_ids = pages_service.insert_source(
        db,
        user.id,
        notebook_id,
        body.base_rev,
        body.source_id,
        at=body.at,
        after_page_id=body.after_page_id,
        add_to_bookmarks=body.add_to_bookmarks,
    )
    detail = _detail_after(db, user.id, notebook_id)
    detail["inserted_page_ids"] = new_ids
    return detail


@router.put("/notebooks/{notebook_id}/pages/order")
def reorder_pages(notebook_id: str, body: OrderBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    pages_service.reorder(db, user.id, notebook_id, body.base_rev, body.page_ids)
    return _detail_after(db, user.id, notebook_id)


@router.post("/notebooks/{notebook_id}/pages/rotate")
def rotate_pages(notebook_id: str, body: RotateBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    pages_service.rotate(db, user.id, notebook_id, body.base_rev, body.page_ids, body.delta)
    return _detail_after(db, user.id, notebook_id)


@router.post("/notebooks/{notebook_id}/pages/delete")
def delete_pages(notebook_id: str, body: PagesBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    batch = pages_service.delete_pages(db, user.id, notebook_id, body.base_rev, body.page_ids)
    detail = _detail_after(db, user.id, notebook_id)
    detail["deleted_batch"] = batch
    return detail


@router.post("/notebooks/{notebook_id}/pages/undelete")
def undelete_pages(notebook_id: str, body: UndeleteBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    pages_service.undelete(db, user.id, notebook_id, body.batch)
    return _detail_after(db, user.id, notebook_id)


@router.get("/notebooks/{notebook_id}/pdf")
def notebook_pdf(
    notebook_id: str,
    user: CurrentUser,
    variant: Literal["reader", "download"] = "reader",
    rev: int | None = Query(default=None),
    d: str | None = Query(default=None, max_length=64),
) -> FileResponse:
    with read_session() as db:
        _node, nb = require_notebook(db, user.id, notebook_id)
        if rev is not None and rev != nb.rev:
            raise Conflict("This notebook has changed. Reloading…", code="stale_rev", rev=nb.rev)
        node, spec = notebook_spec(db, user.id, notebook_id, with_outline=variant == "download")
        name = node.name
    _check_digest(spec, d)
    if not spec["pages"]:
        raise Conflict("This notebook has no pages yet.", code="empty")
    path, digest = ensure_pdf(user.id, spec)
    return _pdf_response(path, digest, f"{safe_filename(name)}.pdf", variant == "download")


# ---- bookmarks -------------------------------------------------------------------------


@router.post("/bookmarks")
def create_bookmark(body: BookmarkBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    node = bm_service.create_bookmark(db, user.id, body.parent_id, body.name, body.notebook_id, body.page_ids)
    data = describe_nodes(db, [node])[0]
    db.commit()
    return data


@router.get("/bookmarks/{bookmark_id}")
def bookmark_detail(bookmark_id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    return _bookmark_detail(db, user.id, bookmark_id)


@router.put("/bookmarks/{bookmark_id}/pages")
def set_bookmark_pages(bookmark_id: str, body: BookmarkPagesBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    bm_service.set_bookmark_pages(db, user.id, bookmark_id, body.page_ids, body.base_rev)
    db.commit()
    with read_session() as fresh:
        return _bookmark_detail(fresh, user.id, bookmark_id)


@router.post("/bookmarks/{bookmark_id}/pages/add")
def add_bookmark_pages(bookmark_id: str, body: BookmarkPagesBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    bm_service.add_pages_to_bookmark(db, user.id, bookmark_id, body.page_ids)
    db.commit()
    with read_session() as fresh:
        return _bookmark_detail(fresh, user.id, bookmark_id)


@router.get("/bookmarks/{bookmark_id}/pdf")
def bookmark_pdf(
    bookmark_id: str,
    user: CurrentUser,
    variant: Literal["reader", "download"] = "reader",
    d: str | None = Query(default=None, max_length=64),
) -> FileResponse:
    with read_session() as db:
        node, nb_node, spec = bookmark_spec(db, user.id, bookmark_id, with_outline=variant == "download")
        filename = f"{safe_filename(nb_node.name, 80)} - {safe_filename(node.name, 80)}.pdf"
    _check_digest(spec, d)
    if not spec["pages"]:
        raise Conflict("This bookmark has no pages selected.", code="empty")
    path, digest = ensure_pdf(user.id, spec)
    return _pdf_response(path, digest, filename, variant == "download")
