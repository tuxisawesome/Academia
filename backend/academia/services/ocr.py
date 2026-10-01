"""Handwriting recognition queue. The recognition itself runs in the user's browser.

A browser asks for a few pages (``claim``), renders them from the original PDF, runs its
recognition model and sends the text back (``submit``). Claimed pages are leased to that
device for a while so several open tabs or devices don't read the same pages. Each engine
has a quality ``rank``; a page is only re-read by an engine ranked higher than the one that
read it, so a weaker device never overwrites a better result.

The recognised text is only ever written here and used by search; no endpoint returns it.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from datetime import UTC, timedelta
from typing import Any

from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from ..errors import BadRequest
from ..models import Page, PageText, Source, SourcePage, utcnow
from ..workers.pdfops import MAX_PAGE_TEXT
from .common import chunks
from .textindex import ensure_rows

LEASE = timedelta(minutes=10)
MAX_ATTEMPTS = 3
MAX_CLAIM = 16

_ws = re.compile(r"\s+")


def sql_datetime(value) -> str:  # noqa: ANN001
    """A UTC datetime in the format SQLAlchemy stores in SQLite (for raw SQL comparisons)."""
    return value.astimezone(UTC).replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S.%f")


def clean_text(value: str) -> str:
    value = unicodedata.normalize("NFC", value or "")
    value = "".join(ch if unicodedata.category(ch)[0] != "C" else " " for ch in value)
    return _ws.sub(" ", value).strip()[:MAX_PAGE_TEXT]


_CANDIDATES = text(
    """
    SELECT p.source_id AS source_id, p.source_index AS idx, MAX(s.created_at) AS created
    FROM pages p
    JOIN sources s ON s.id = p.source_id
    JOIN nodes n ON n.id = p.notebook_id
    LEFT JOIN page_texts t ON t.source_id = p.source_id AND t.idx = p.source_index
    WHERE s.owner_id = :uid
      AND p.deleted_at IS NULL
      AND n.trashed_at IS NULL
      AND (
        t.id IS NULL
        OR (
          (t.ocr_rank IS NULL OR t.ocr_rank < :rank)
          AND NOT (t.ocr_failed_rank = :rank AND t.ocr_attempts >= :max_attempts)
          AND (t.lease_until IS NULL OR t.lease_until < :now OR t.lease_owner = :device)
        )
      )
    GROUP BY p.source_id, p.source_index
    ORDER BY created DESC, p.source_index
    LIMIT :limit
    """
)


def claim(db: Session, user_id: str, device: str, engine: str, rank: int, limit: int = 4) -> list[dict[str, Any]]:
    """Lease up to ``limit`` pages that this engine should read. Newest uploads first."""
    if not device or not engine:
        raise BadRequest("Missing device or engine.")
    limit = max(1, min(MAX_CLAIM, limit))
    now = utcnow()
    rows = db.execute(
        _CANDIDATES,
        {
            "uid": user_id,
            "rank": rank,
            "max_attempts": MAX_ATTEMPTS,
            "now": sql_datetime(now),
            "device": device,
            "limit": limit,
        },
    ).all()
    out: list[dict[str, Any]] = []
    for r in rows:
        src = db.get(Source, r.source_id)
        if src is None:
            continue
        ensure_rows(db, src.id, src.page_count)
        row = db.scalar(select(PageText).where(PageText.source_id == src.id, PageText.idx == r.idx))
        if row is None:
            continue
        row.lease_owner = device
        row.lease_until = now + LEASE
        size = db.get(SourcePage, (src.id, r.idx))
        # Pages turned sideways in a notebook are read the way the user sees them.
        rotations = Counter(
            db.scalars(
                select(Page.rotation).where(
                    Page.source_id == src.id, Page.source_index == r.idx, Page.deleted_at.is_(None)
                )
            )
        )
        out.append(
            {
                "source_id": src.id,
                "index": r.idx,
                "rotation": rotations.most_common(1)[0][0] if rotations else 0,
                "width": size.width_pt if size else 612.0,
                "height": size.height_pt if size else 792.0,
            }
        )
    db.flush()
    return out


def submit(db: Session, user_id: str, device: str, engine: str, rank: int, items: list[dict[str, Any]]) -> int:
    """Store recognised text (or failures) for pages this user owns. Returns pages stored."""
    stored = 0
    now = utcnow()
    for item in items:
        src = db.get(Source, item.get("source_id"))
        idx = item.get("index")
        if src is None or src.owner_id != user_id or not isinstance(idx, int) or not 0 <= idx < src.page_count:
            continue
        ensure_rows(db, src.id, src.page_count)
        row = db.scalar(select(PageText).where(PageText.source_id == src.id, PageText.idx == idx))
        if row is None:
            continue
        if row.lease_owner == device:
            row.lease_owner = None
            row.lease_until = None
        if item.get("error"):
            if row.ocr_failed_rank != rank:
                row.ocr_failed_rank = rank
                row.ocr_attempts = 0
            row.ocr_attempts += 1
            continue
        if row.ocr_rank is not None and row.ocr_rank > rank:
            continue  # a better engine already read this page
        row.ocr_text = clean_text(item.get("text", ""))
        row.ocr_engine = engine[:64]
        row.ocr_rank = rank
        row.ocr_failed_rank = None
        row.ocr_attempts = 0
        row.updated_at = now
        stored += 1
    db.flush()
    return stored


def status(db: Session, user_id: str, rank: int | None = None) -> dict[str, int]:
    """How many of the user's pages have been read (by an engine of at least ``rank``)."""
    total_q = text(
        """
        SELECT COUNT(*) FROM (
          SELECT DISTINCT p.source_id, p.source_index
          FROM pages p JOIN sources s ON s.id = p.source_id JOIN nodes n ON n.id = p.notebook_id
          WHERE s.owner_id = :uid AND p.deleted_at IS NULL AND n.trashed_at IS NULL
        )
        """
    )
    read_q = text(
        """
        SELECT COUNT(*) FROM (
          SELECT DISTINCT p.source_id, p.source_index
          FROM pages p JOIN sources s ON s.id = p.source_id JOIN nodes n ON n.id = p.notebook_id
          JOIN page_texts t ON t.source_id = p.source_id AND t.idx = p.source_index
          WHERE s.owner_id = :uid AND p.deleted_at IS NULL AND n.trashed_at IS NULL
            AND t.ocr_rank IS NOT NULL AND t.ocr_rank >= :rank
        )
        """
    )
    total = db.execute(total_q, {"uid": user_id}).scalar() or 0
    done = db.execute(read_q, {"uid": user_id, "rank": rank if rank is not None else 0}).scalar() or 0
    return {"total": int(total), "read": int(done), "remaining": int(total) - int(done)}


def reset(db: Session, user_id: str) -> int:
    """Queue all of the user's pages to be read again (the old text stays searchable until then)."""
    owned = select(Source.id).where(Source.owner_id == user_id).scalar_subquery()
    result = db.execute(
        update(PageText)
        .where(PageText.source_id.in_(owned))
        .values(ocr_rank=None, ocr_failed_rank=None, ocr_attempts=0, lease_owner=None, lease_until=None)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0


def unread_pages_in(db: Session, notebook_ids: list[str]) -> int:
    """Pages of these notebooks that no engine has read yet."""
    unread: set[tuple[str, int]] = set()
    for part in chunks(notebook_ids):
        rows = db.execute(
            select(Page.source_id, Page.source_index)
            .outerjoin(PageText, (PageText.source_id == Page.source_id) & (PageText.idx == Page.source_index))
            .where(Page.notebook_id.in_(part), Page.deleted_at.is_(None), PageText.ocr_rank.is_(None))
        ).all()
        unread.update((r[0], r[1]) for r in rows)
    return len(unread)
