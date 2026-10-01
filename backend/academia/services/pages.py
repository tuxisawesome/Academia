"""Notebook page list operations: insert, reorder, rotate, delete (soft) and undo.

Every operation computes the new ordered list of live page ids and then renumbers
positions in two passes so the UNIQUE(notebook_id, position) index is never violated
mid-update. Each change bumps the notebook's ``rev``; clients send the rev they last saw
(``base_rev``) and receive 409 if someone else changed the notebook in the meantime.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..errors import BadRequest, Conflict, NotFound
from ..models import (
    BOOKMARK,
    NOTEBOOK,
    Bookmark,
    BookmarkPage,
    Node,
    Notebook,
    Page,
    Source,
    new_id,
    utcnow,
)
from .common import ancestors, chunks, clean_name, owned_folder_or_root, segments, segments_label
from .describe import live_pages_with_sizes, node_base, page_json
from .tree import require_notebook


def check_rev(nb: Notebook, base_rev: int | None) -> None:
    if base_rev is not None and base_rev != nb.rev:
        raise Conflict(
            "This notebook was changed somewhere else. It has been reloaded — please try again.",
            code="stale_rev",
            rev=nb.rev,
        )


def live_page_ids(db: Session, notebook_id: str) -> list[str]:
    return list(
        db.scalars(
            select(Page.id).where(Page.notebook_id == notebook_id, Page.deleted_at.is_(None)).order_by(Page.position)
        )
    )


def apply_order(db: Session, notebook_id: str, ordered_ids: Sequence[str]) -> None:
    db.flush()
    # Pass 1: move every live position out of the way (0..n-1 -> -1..-n).
    db.execute(
        update(Page)
        .where(Page.notebook_id == notebook_id, Page.position.is_not(None))
        .values(position=-(Page.position + 1))
        .execution_options(synchronize_session=False)
    )
    # Pass 2: write final positions.
    if ordered_ids:
        db.execute(
            update(Page),
            [{"id": pid, "position": i} for i, pid in enumerate(ordered_ids)],
        )
    db.expire_all()


def _bump(db: Session, node: Node, nb: Notebook, page_count: int, bookmark_ids: Sequence[str] = ()) -> None:
    now = utcnow()
    nb.rev += 1
    nb.page_count = page_count
    node.updated_at = now
    for part in chunks(list(dict.fromkeys(bookmark_ids))):
        db.execute(
            update(Bookmark)
            .where(Bookmark.node_id.in_(part))
            .values(rev=Bookmark.rev + 1)
            .execution_options(synchronize_session=False)
        )
        db.execute(
            update(Node).where(Node.id.in_(part)).values(updated_at=now).execution_options(synchronize_session=False)
        )
    db.flush()


def _bookmarks_touching(db: Session, page_ids: Sequence[str]) -> list[str]:
    out: list[str] = []
    for part in chunks(list(page_ids)):
        out.extend(db.scalars(select(BookmarkPage.bookmark_id).where(BookmarkPage.page_id.in_(part)).distinct()))
    return list(dict.fromkeys(out))


def notebook_bookmarks(db: Session, notebook_id: str) -> list[dict[str, Any]]:
    """Live bookmarks that point into this notebook, with their live pages."""
    bm_nodes = db.execute(
        select(Node, Bookmark)
        .join(Bookmark, Bookmark.node_id == Node.id)
        .where(Bookmark.notebook_id == notebook_id, Node.trashed_at.is_(None))
    ).all()
    if not bm_nodes:
        return []
    members: dict[str, list[tuple[str, int]]] = {n.id: [] for n, _ in bm_nodes}
    rows = db.execute(
        select(BookmarkPage.bookmark_id, Page.id, Page.position)
        .join(Page, Page.id == BookmarkPage.page_id)
        .where(BookmarkPage.notebook_id == notebook_id, Page.deleted_at.is_(None))
        .order_by(Page.position)
    ).all()
    for bid, pid, pos in rows:
        if bid in members:
            members[bid].append((pid, pos))
    out = []
    for node, bm in bm_nodes:
        pages = members[node.id]
        runs = segments([pos for _, pos in pages])
        out.append(
            {
                "id": node.id,
                "name": node.name,
                "parent_id": node.parent_id,
                "rev": bm.rev,
                "page_ids": [pid for pid, _ in pages],
                "segments": runs,
                "label": segments_label(runs),
                "first_position": pages[0][1] if pages else None,
            }
        )
    out.sort(key=lambda b: (b["first_position"] is None, b["first_position"] or 0, b["name"].lower()))
    return out


def notebook_detail(db: Session, user_id: str, notebook_id: str) -> dict[str, Any]:
    node, nb = require_notebook(db, user_id, notebook_id, allow_trashed=True)
    data = node_base(node)
    data.update(
        {
            "rev": nb.rev,
            "page_count": nb.page_count,
            "path": ancestors(db, node.id),
            "pages": [page_json(p, sp) for p, sp in live_pages_with_sizes(db, node.id)],
            "bookmarks": notebook_bookmarks(db, node.id),
        }
    )
    return data


def create_notebook(db: Session, user_id: str, parent_id: str | None, name: str, source_id: str | None = None) -> Node:
    parent = owned_folder_or_root(db, user_id, parent_id)
    node = Node(owner_id=user_id, parent_id=parent.id if parent else None, kind=NOTEBOOK, name=clean_name(name))
    db.add(node)
    db.flush()
    nb = Notebook(node_id=node.id, rev=0, page_count=0)
    db.add(nb)
    db.flush()
    if source_id:
        insert_source(db, user_id, node.id, None, source_id, at="end")
    return node


def owned_source(db: Session, user_id: str, source_id: str) -> Source:
    src = db.get(Source, source_id)
    if src is None or src.owner_id != user_id:
        raise NotFound("That upload could not be found. Please upload the file again.")
    return src


def insert_source(
    db: Session,
    user_id: str,
    notebook_id: str,
    base_rev: int | None,
    source_id: str,
    at: str = "end",
    after_page_id: str | None = None,
    add_to_bookmarks: Sequence[str] = (),
) -> list[str]:
    """Insert every page of an uploaded source. Returns the new page ids."""
    node, nb = require_notebook(db, user_id, notebook_id)
    check_rev(nb, base_rev)
    src = owned_source(db, user_id, source_id)
    ids = live_page_ids(db, node.id)
    if at == "start":
        k = 0
    elif at == "end":
        k = len(ids)
    elif at == "after":
        if after_page_id not in ids:
            raise BadRequest("The page to insert after no longer exists.", code="invalid_position")
        k = ids.index(after_page_id) + 1
    else:
        raise BadRequest("Unknown insert position.", code="invalid_position")

    now = utcnow()
    new_pages = [
        Page(
            id=new_id(),
            notebook_id=node.id,
            position=None,
            source_id=src.id,
            source_index=i,
            rotation=0,
            created_at=now,
        )
        for i in range(src.page_count)
    ]
    db.add_all(new_pages)
    db.flush()
    new_ids = [p.id for p in new_pages]
    order = ids[:k] + new_ids + ids[k:]
    apply_order(db, node.id, order)

    touched: list[str] = []
    for bm_id in dict.fromkeys(add_to_bookmarks):
        bm_node = db.get(Node, bm_id)
        bm = db.get(Bookmark, bm_id)
        if (
            bm_node is None
            or bm is None
            or bm_node.owner_id != user_id
            or bm_node.kind != BOOKMARK
            or bm.notebook_id != node.id
        ):
            raise BadRequest("A selected bookmark does not belong to this notebook.", code="invalid_bookmark")
        db.add_all(BookmarkPage(bookmark_id=bm_id, page_id=pid, notebook_id=node.id) for pid in new_ids)
        touched.append(bm_id)
    if src.orphaned_at is not None:
        src.orphaned_at = None
    node, nb = require_notebook(db, user_id, notebook_id)
    _bump(db, node, nb, len(order), touched)
    return new_ids


def reorder(db: Session, user_id: str, notebook_id: str, base_rev: int | None, page_ids: Sequence[str]) -> None:
    node, nb = require_notebook(db, user_id, notebook_id)
    check_rev(nb, base_rev)
    ids = live_page_ids(db, node.id)
    if len(page_ids) != len(ids) or set(page_ids) != set(ids):
        raise Conflict("The page list changed while you were editing. Please try again.", code="stale_rev", rev=nb.rev)
    apply_order(db, node.id, list(page_ids))
    node, nb = require_notebook(db, user_id, notebook_id)
    _bump(db, node, nb, len(ids))


def _validate_subset(ids: Sequence[str], live: Sequence[str]) -> list[str]:
    wanted = list(dict.fromkeys(ids))
    if not wanted:
        raise BadRequest("No pages selected.", code="no_pages")
    liveset = set(live)
    if any(pid not in liveset for pid in wanted):
        raise Conflict("Some selected pages no longer exist. Please try again.", code="stale_rev")
    return wanted


def rotate(
    db: Session, user_id: str, notebook_id: str, base_rev: int | None, page_ids: Sequence[str], delta: int
) -> None:
    if delta % 90 != 0:
        raise BadRequest("Pages can only be rotated in steps of 90°.", code="invalid_rotation")
    node, nb = require_notebook(db, user_id, notebook_id)
    check_rev(nb, base_rev)
    ids = live_page_ids(db, node.id)
    wanted = _validate_subset(page_ids, ids)
    for part in chunks(wanted):
        for page in db.scalars(select(Page).where(Page.id.in_(part))):
            page.rotation = (page.rotation + delta) % 360
    _bump(db, node, nb, len(ids), _bookmarks_touching(db, wanted))


def delete_pages(db: Session, user_id: str, notebook_id: str, base_rev: int | None, page_ids: Sequence[str]) -> str:
    """Soft-delete pages. Returns a batch id that ``undelete`` accepts."""
    node, nb = require_notebook(db, user_id, notebook_id)
    check_rev(nb, base_rev)
    ids = live_page_ids(db, node.id)
    wanted = _validate_subset(page_ids, ids)
    batch = new_id()
    now = utcnow()
    for part in chunks(wanted):
        for page in db.scalars(select(Page).where(Page.id.in_(part))):
            page.deleted_at = now
            page.deleted_batch = batch
            page.deleted_position = page.position
            page.position = None
    db.flush()
    gone = set(wanted)
    remaining = [pid for pid in ids if pid not in gone]
    apply_order(db, node.id, remaining)
    node, nb = require_notebook(db, user_id, notebook_id)
    _bump(db, node, nb, len(remaining), _bookmarks_touching(db, wanted))
    return batch


def undelete(db: Session, user_id: str, notebook_id: str, batch: str) -> None:
    node, nb = require_notebook(db, user_id, notebook_id)
    pages = list(
        db.scalars(
            select(Page)
            .where(Page.notebook_id == node.id, Page.deleted_batch == batch, Page.deleted_at.is_not(None))
            .order_by(Page.deleted_position)
        )
    )
    if not pages:
        raise NotFound("Those pages can no longer be restored.")
    order = live_page_ids(db, node.id)
    for page in pages:
        pos = page.deleted_position if page.deleted_position is not None else len(order)
        order.insert(min(pos, len(order)), page.id)
        page.deleted_at = None
        page.deleted_batch = None
        page.deleted_position = None
    db.flush()
    apply_order(db, node.id, order)
    node, nb = require_notebook(db, user_id, notebook_id)
    _bump(db, node, nb, len(order), _bookmarks_touching(db, [p.id for p in pages]))
