"""Assembled PDFs for notebooks and bookmarks, cached by the hash of what goes into them.

A *spec* lists the title, the (source, page, rotation) of every page, the outline and the
page labels. Its SHA-256, together with the version of the code that assembles it, names
the cached file, so a cached PDF never changes after it is written (safe for HTTP range
requests), identical content is built once, and there is no invalidation to get wrong. The
cache is trimmed by least-recent use after each build and by the nightly maintenance. Each
user's files live in their own directory, which is removed together with the user.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Node
from ..storage import pdf_cache_path, source_path
from ..workers import pdfops, pool
from .bookmarks import live_bookmark_pages, require_bookmark
from .common import segments
from .maintenance import trim_pdf_cache
from .pages import notebook_bookmarks
from .tree import require_notebook

_locks = pool.KeyedLocks()


def _range_title(a: int, b: int) -> str:
    return f"Page {a}" if a == b else f"Pages {a}–{b}"


def notebook_spec(db: Session, user_id: str, notebook_id: str, with_outline: bool) -> tuple[Node, dict[str, Any]]:
    from sqlalchemy import select

    from ..models import Page

    node, _nb = require_notebook(db, user_id, notebook_id)
    pages = db.execute(
        select(Page.source_id, Page.source_index, Page.rotation)
        .where(Page.notebook_id == node.id, Page.deleted_at.is_(None))
        .order_by(Page.position)
    ).all()
    outline: list[dict[str, Any]] = []
    if with_outline:
        for bm in notebook_bookmarks(db, node.id):
            runs = bm["segments"]
            if not runs:
                continue
            item: dict[str, Any] = {"title": bm["name"], "page": runs[0][0] - 1, "children": []}
            if len(runs) > 1:
                item["children"] = [{"title": _range_title(a, b), "page": a - 1} for a, b in runs]
            outline.append(item)
    spec = {
        "title": node.name,
        "pages": [[r.source_id, r.source_index, r.rotation] for r in pages],
        "outline": outline,
        "labels": None,
    }
    return node, spec


def bookmark_spec(db: Session, user_id: str, bookmark_id: str, with_outline: bool) -> tuple[Node, Node, dict[str, Any]]:
    node, bm = require_bookmark(db, user_id, bookmark_id)
    nb_node, _ = require_notebook(db, user_id, bm.notebook_id)
    pages = live_bookmark_pages(db, node.id)
    runs = segments([p.position for p in pages if p.position is not None])
    labels: list[list[int]] = []
    outline: list[dict[str, Any]] = []
    k = 0
    for a, b in runs:
        labels.append([k, a])
        if with_outline:
            outline.append({"title": _range_title(a, b), "page": k, "children": []})
        k += b - a + 1
    spec = {
        "title": f"{node.name} — {nb_node.name}",
        "pages": [[p.source_id, p.source_index, p.rotation] for p in pages],
        "outline": outline,
        "labels": labels,
    }
    return node, nb_node, spec


def spec_digest(spec: dict[str, Any]) -> str:
    keyed = [pdfops.ASSEMBLE_VERSION, spec]
    canonical = json.dumps(keyed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def ensure_pdf(owner_id: str, spec: dict[str, Any]) -> tuple[Path, str]:
    """Return the cached PDF for ``spec``, building it in a worker process if needed."""
    digest = spec_digest(spec)
    path = pdf_cache_path(owner_id, digest)
    if not path.exists():
        with _locks.get(digest):
            if not path.exists():
                resolved = dict(spec)
                resolved["pages"] = [[str(source_path(sid)), idx, rot] for sid, idx, rot in spec["pages"]]
                pool.run(pdfops.assemble, resolved, str(path))
                # Each edit of a notebook adds a PDF, so the size limit must hold between nightly trims too.
                trim_pdf_cache(get_settings().pdf_cache_max_mb * 1024 * 1024, keep=path)
    try:
        os.utime(path)  # recency for cache trimming
    except OSError:
        pass
    return path, digest
