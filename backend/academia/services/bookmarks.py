"""Bookmarks: named selections of pages in one notebook."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..errors import BadRequest, Conflict, NotFound
from ..models import BOOKMARK, Bookmark, BookmarkPage, Node, Notebook, Page, utcnow
from .common import ancestors, chunks, clean_name, owned_folder_or_root, owned_node, segments, segments_label
from .describe import bookmark_members, node_base, page_json
from .pages import live_page_ids
from .tree import require_notebook


def require_bookmark(db: Session, user_id: str, node_id: str, allow_trashed: bool = False) -> tuple[Node, Bookmark]:
    node = owned_node(db, user_id, node_id, BOOKMARK, allow_trashed=allow_trashed)
    bm = db.get(Bookmark, node.id)
    if bm is None:
        raise NotFound()
    return node, bm


def _validated_pages(db: Session, notebook_id: str, page_ids: Sequence[str]) -> list[str]:
    live = set(live_page_ids(db, notebook_id))
    wanted = list(dict.fromkeys(page_ids))
    missing = [pid for pid in wanted if pid not in live]
    if missing:
        raise Conflict(
            "Some selected pages are no longer in the notebook. Please review your selection.",
            code="stale_pages",
        )
    return wanted


def create_bookmark(
    db: Session, user_id: str, parent_id: str | None, name: str, notebook_id: str, page_ids: Sequence[str]
) -> Node:
    parent = owned_folder_or_root(db, user_id, parent_id)
    nb_node, _nb = require_notebook(db, user_id, notebook_id)
    wanted = _validated_pages(db, nb_node.id, page_ids)
    node = Node(owner_id=user_id, parent_id=parent.id if parent else None, kind=BOOKMARK, name=clean_name(name))
    db.add(node)
    db.flush()
    db.add(Bookmark(node_id=node.id, notebook_id=nb_node.id, rev=0))
    db.flush()
    db.add_all(BookmarkPage(bookmark_id=node.id, page_id=pid, notebook_id=nb_node.id) for pid in wanted)
    db.flush()
    return node


def set_bookmark_pages(
    db: Session, user_id: str, bookmark_id: str, page_ids: Sequence[str], base_rev: int | None = None
) -> None:
    node, bm = require_bookmark(db, user_id, bookmark_id)
    if base_rev is not None and base_rev != bm.rev:
        raise Conflict("This bookmark was changed somewhere else. Please review it again.", code="stale_rev")
    nb_node = db.get(Node, bm.notebook_id)
    if nb_node is None or nb_node.trashed_at is not None:
        raise BadRequest("The notebook for this bookmark is in the Trash.", code="notebook_unavailable")
    wanted = _validated_pages(db, bm.notebook_id, page_ids)
    live = live_page_ids(db, bm.notebook_id)
    # Replace membership among live pages only; memberships of soft-deleted pages are kept
    # so undoing a page deletion restores them into this bookmark too.
    for part in chunks(live):
        db.execute(delete(BookmarkPage).where(BookmarkPage.bookmark_id == node.id, BookmarkPage.page_id.in_(part)))
    db.add_all(BookmarkPage(bookmark_id=node.id, page_id=pid, notebook_id=bm.notebook_id) for pid in wanted)
    bm.rev += 1
    node.updated_at = utcnow()
    db.flush()


def add_pages_to_bookmark(db: Session, user_id: str, bookmark_id: str, page_ids: Sequence[str]) -> None:
    node, bm = require_bookmark(db, user_id, bookmark_id)
    wanted = _validated_pages(db, bm.notebook_id, page_ids)
    existing = set(db.scalars(select(BookmarkPage.page_id).where(BookmarkPage.bookmark_id == node.id)))
    db.add_all(
        BookmarkPage(bookmark_id=node.id, page_id=pid, notebook_id=bm.notebook_id)
        for pid in wanted
        if pid not in existing
    )
    bm.rev += 1
    node.updated_at = utcnow()
    db.flush()


def bookmark_detail(db: Session, user_id: str, bookmark_id: str) -> dict[str, Any]:
    node, bm = require_bookmark(db, user_id, bookmark_id, allow_trashed=True)
    nb_node = db.get(Node, bm.notebook_id)
    nb = db.get(Notebook, bm.notebook_id)
    members = bookmark_members(db, [node.id]).get(node.id, [])
    runs = segments([p.position for p, _ in members if p.position is not None])
    data = node_base(node)
    data.update(
        {
            "rev": bm.rev,
            "path": ancestors(db, node.id),
            "notebook": {
                "id": bm.notebook_id,
                "name": nb_node.name if nb_node else "",
                "rev": nb.rev if nb else 0,
                "page_count": nb.page_count if nb else 0,
                "trashed": bool(nb_node is None or nb_node.trashed_at is not None),
            },
            "available": bool(nb_node is not None and nb_node.trashed_at is None),
            "page_ids": [p.id for p, _ in members],
            "pages": [{**page_json(p, sp), "number": (p.position or 0) + 1} for p, sp in members],
            "segments": runs,
            "label": segments_label(runs),
        }
    )
    return data


def bookmarks_pointing_at(db: Session, notebook_ids: Sequence[str]) -> list[str]:
    out: list[str] = []
    for part in chunks(list(notebook_ids)):
        out.extend(db.scalars(select(Bookmark.node_id).where(Bookmark.notebook_id.in_(part))))
    return out


def live_bookmark_pages(db: Session, bookmark_id: str) -> list[Page]:
    return [p for p, _ in bookmark_members(db, [bookmark_id]).get(bookmark_id, [])]
