"""Searchable page text: each uploaded PDF's own text layer, extracted on the server.

The text lands in ``page_texts`` and the ``page_text_fts`` index and is only used by search;
it is never shown to users. Pages without a text layer (scans, handwriting) simply have no
searchable text.
"""

from __future__ import annotations

import logging
import queue
import threading

from sqlalchemy import func, select

from ..db import read_session, write_session
from ..models import PageText, Source, utcnow
from ..storage import source_path
from ..workers import pdfops, pool

log = logging.getLogger(__name__)

BATCH = 32


def index_source(source_id: str) -> int:
    """Extract and store the text layer of every page of a source. Returns pages indexed."""
    with read_session() as db:
        src = db.get(Source, source_id)
        if src is None:
            return 0
        page_count = src.page_count
        done = set(db.scalars(select(PageText.idx).where(PageText.source_id == source_id)))
    todo = [i for i in range(page_count) if i not in done]
    path = source_path(source_id)
    if not todo or not path.exists():
        return 0
    indexed = 0
    for start in range(0, len(todo), BATCH):
        chunk = todo[start : start + BATCH]
        texts = pool.run(pdfops.extract_text, str(path), chunk, timeout=300)
        with write_session() as db:
            if db.get(Source, source_id) is None:
                return indexed
            have = set(db.scalars(select(PageText.idx).where(PageText.source_id == source_id, PageText.idx.in_(chunk))))
            now = utcnow()
            db.add_all(
                PageText(source_id=source_id, idx=idx, body=texts.get(idx, ""), updated_at=now)
                for idx in chunk
                if idx not in have
            )
        indexed += len(chunk)
    return indexed


def sources_needing_text() -> list[str]:
    """Sources with pages whose text layer hasn't been extracted yet (oldest first)."""
    with read_session() as db:
        done = dict(db.execute(select(PageText.source_id, func.count()).group_by(PageText.source_id)).all())
        rows = db.execute(
            select(Source.id, Source.page_count).where(Source.orphaned_at.is_(None)).order_by(Source.created_at)
        ).all()
        return [sid for sid, count in rows if done.get(sid, 0) < count]


class TextIndexer:
    """Background thread that extracts text layers of new (and not yet indexed) uploads."""

    def __init__(self) -> None:
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread: threading.Thread | None = None

    def start(self, backfill: bool = True) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, args=(backfill,), name="text-index", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        if self._thread is not None:
            self._queue.put(None)
            self._thread.join(timeout=5)
            self._thread = None

    def enqueue(self, source_id: str) -> None:
        if self._thread is not None:
            self._queue.put(source_id)

    def _run(self, backfill: bool) -> None:
        if backfill:
            try:
                for sid in sources_needing_text():
                    self._queue.put(sid)
            except Exception:  # noqa: BLE001
                log.exception("Could not list sources for text indexing")
        while True:
            sid = self._queue.get()
            if sid is None:
                return
            try:
                index_source(sid)
            except Exception:  # noqa: BLE001 - best effort; retried at next start
                log.exception("Text extraction failed for %s", sid)


text_indexer = TextIndexer()
