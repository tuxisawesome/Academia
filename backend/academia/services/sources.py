"""Storing uploaded PDFs."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..db import read_session, write_session
from ..errors import Unprocessable
from ..models import Source, SourcePage, new_id
from ..storage import remove_source_files, source_path, tmp_dir
from ..workers import pdfops, pool
from .textindex import text_indexer
from .thumbs import prewarmer

log = logging.getLogger(__name__)


def _describe(src: Source, sizes: list[tuple[float, float]]) -> dict[str, Any]:
    return {
        "id": src.id,
        "filename": src.original_filename,
        "page_count": src.page_count,
        "byte_size": src.byte_size,
        "pages": [{"index": i, "width": w, "height": h} for i, (w, h) in enumerate(sizes)],
    }


def _sizes(db, source_id: str) -> list[tuple[float, float]]:  # noqa: ANN001
    rows = db.execute(
        select(SourcePage.width_pt, SourcePage.height_pt)
        .where(SourcePage.source_id == source_id)
        .order_by(SourcePage.idx)
    ).all()
    return [(r[0], r[1]) for r in rows]


def _store_sizes(db, source_id: str, sizes: list[tuple[float, float]]) -> list[tuple[float, float]]:  # noqa: ANN001
    """Correct the stored page sizes of a source to ``sizes``, just measured from its file.
    Returns the stored sizes."""
    rows = list(db.scalars(select(SourcePage).where(SourcePage.source_id == source_id).order_by(SourcePage.idx)))
    for row in rows:
        if row.idx < len(sizes) and (row.width_pt, row.height_pt) != tuple(sizes[row.idx]):
            row.width_pt, row.height_pt = sizes[row.idx]
    return [(row.width_pt, row.height_pt) for row in rows]


def remeasure(source_id: str) -> None:
    """Measure the pages of a stored upload again and correct their stored sizes.

    Older releases stored the size of the raw CropBox, which is not what viewers show when it
    reaches past the MediaBox, so such pages were drawn distorted.
    """
    sizes = pool.run(pdfops.page_sizes, str(source_path(source_id)))
    with write_session() as db:
        _store_sizes(db, source_id, sizes)


def _ingest(tmp: Path, out: Path) -> dict[str, Any]:
    try:
        return pool.run(pdfops.ingest, str(tmp), str(out))
    except pdfops.PdfError as exc:
        raise Unprocessable(exc.message, code=exc.code) from None


def _place(out: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(out, dest)


def store_upload(user_id: str, tmp: Path, sha256: str, size: int, filename: str) -> dict[str, Any]:
    """Validate and store an uploaded file (already streamed to ``tmp``).

    Identical files uploaded again by the same user reuse the stored copy, whose pages are
    measured again (see ``remeasure``). The worker writes the validated copy into the tmp
    directory (swept by maintenance); it is moved into ``sources/`` only together with its
    database row, so a failed or timed-out upload never leaves an untracked file there.
    """
    filename = (filename or "").strip()[:255]
    with read_session() as db:
        existing = db.scalar(select(Source).where(Source.owner_id == user_id, Source.sha256 == sha256))
        existing_id = existing.id if existing is not None else None
    out = tmp_dir() / f"ingest-{new_id()}.pdf"
    try:
        info: dict[str, Any] | None = None
        if existing_id is not None:
            if source_path(existing_id).exists():
                # The upload has the same bytes as the file stored back then; measuring it does not
                # depend on maintenance leaving the stored copy alone in the meantime.
                sizes = pool.run(pdfops.page_sizes, str(tmp))
            else:
                # The stored file went missing (e.g. restored from an old backup); store it again.
                info = _ingest(tmp, out)
                sizes = info["sizes"]
            with write_session() as db:
                src = db.get(Source, existing_id)
                if src is not None:
                    if info is not None:
                        _place(out, source_path(existing_id))
                    src.orphaned_at = None
                    # The startup backfill skips unused uploads and missing files: its text may not
                    # be indexed yet.
                    text_indexer.enqueue(existing_id)
                    return _describe(src, _store_sizes(db, existing_id, sizes))
            # Maintenance deleted the unused stored copy in the meantime; store the file anew.
        if info is None:
            info = _ingest(tmp, out)
        return _store_new(user_id, sha256, filename, out, info)
    finally:
        out.unlink(missing_ok=True)


def _store_new(user_id: str, sha256: str, filename: str, out: Path, info: dict[str, Any]) -> dict[str, Any]:
    source_id = new_id()
    dest = source_path(source_id)
    sizes = [tuple(s) for s in info["sizes"]]
    _place(out, dest)
    try:
        with write_session() as db:
            src = Source(
                id=source_id,
                owner_id=user_id,
                sha256=sha256,
                original_filename=filename,
                byte_size=dest.stat().st_size,
                page_count=info["page_count"],
            )
            db.add(src)
            db.flush()
            db.add_all(
                SourcePage(source_id=source_id, idx=i, width_pt=w, height_pt=h) for i, (w, h) in enumerate(sizes)
            )
            db.flush()
            result = _describe(src, sizes)  # type: ignore[arg-type]
    except IntegrityError:
        # The same file was stored concurrently; use that copy.
        remove_source_files(source_id)
        with read_session() as db:
            other = db.scalar(select(Source).where(Source.owner_id == user_id, Source.sha256 == sha256))
            if other is None:
                raise
            return _describe(other, _sizes(db, other.id))
    except BaseException:
        remove_source_files(source_id)
        raise
    prewarmer.enqueue(source_id, info["page_count"])
    text_indexer.enqueue(source_id)
    return result
