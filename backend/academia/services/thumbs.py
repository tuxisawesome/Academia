"""Page thumbnails (WebP), rendered on demand and pre-rendered after uploads."""

from __future__ import annotations

import logging
import queue
import threading
from pathlib import Path

from ..errors import NotFound
from ..storage import THUMB_WIDTHS, source_path, thumb_path
from ..workers import pdfops, pool

log = logging.getLogger(__name__)
_locks = pool.KeyedLocks()

PREWARM_WIDTH = 400
PREWARM_BATCH = 16


def snap_width(width: int) -> int:
    for w in THUMB_WIDTHS:
        if width <= w:
            return w
    return THUMB_WIDTHS[-1]


def _rendered(path: Path) -> bool:
    # An empty file is what a crash right after rendering can leave behind.
    try:
        return path.stat().st_size > 0
    except OSError:
        return False


def ensure_thumb(source_id: str, idx: int, width: int) -> Path:
    width = snap_width(width)
    path = thumb_path(source_id, idx, width)
    if _rendered(path):
        return path
    with _locks.get(f"{source_id}:{idx}:{width}"):
        if not _rendered(path):
            src = source_path(source_id)
            if not src.exists():
                raise NotFound()
            pool.run(pdfops.render_thumbnails, str(src), [(idx, width, str(path))], timeout=120)
    if not _rendered(path):
        raise NotFound()
    return path


class Prewarmer:
    """Renders thumbnails for new uploads in the background, one small batch at a time,
    so on-demand thumbnail requests are never stuck behind a long pre-render."""

    def __init__(self) -> None:
        self._queue: queue.Queue[tuple[str, int] | None] = queue.Queue()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="thumb-prewarm", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        if self._thread is not None:
            self._queue.put(None)
            self._thread.join(timeout=5)
            self._thread = None

    def enqueue(self, source_id: str, page_count: int) -> None:
        if self._thread is not None:
            self._queue.put((source_id, page_count))

    def _run(self) -> None:
        while True:
            job = self._queue.get()
            if job is None:
                return
            source_id, count = job
            src = source_path(source_id)
            todo = [
                (i, PREWARM_WIDTH, str(thumb_path(source_id, i, PREWARM_WIDTH)))
                for i in range(count)
                if not thumb_path(source_id, i, PREWARM_WIDTH).exists()
            ]
            for start in range(0, len(todo), PREWARM_BATCH):
                if not src.exists():
                    break
                try:
                    pool.run(pdfops.render_thumbnails, str(src), todo[start : start + PREWARM_BATCH], timeout=300)
                except Exception:  # noqa: BLE001 - best effort
                    log.exception("Thumbnail pre-render failed for %s", source_id)
                    break


prewarmer = Prewarmer()
