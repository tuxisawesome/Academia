"""JSON shapes for nodes and pages as returned by the API."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import BOOKMARK, FOLDER, NOTEBOOK, Bookmark, BookmarkPage, Node, Notebook, Page, SourcePage
from .common import chunks, live_children_count, segments, segments_label, trashed_children_count


def page_json(page: Page, sp: SourcePage | None) -> dict[str, Any]:
    return {
        "id": page.id,
        "source_id": page.source_id,
        "index": page.source_index,
        "rotation": page.rotation,
        "width": sp.width_pt if sp else 612.0,
        "height": sp.height_pt if sp else 792.0,
    }


def node_base(node: Node) -> dict[str, Any]:
    return {
        "id": node.id,
        "kind": node.kind,
        "name": node.name,
        "color": node.color,
        "parent_id": node.parent_id,
        "created_at": node.created_at,
        "updated_at": node.updated_at,
        "trashed_at": node.trashed_at,
    }


def live_pages_with_sizes(db: Session, notebook_id: str) -> list[tuple[Page, SourcePage | None]]:
    rows = db.execute(
        select(Page, SourcePage)
        .outerjoin(
            SourcePage,
            (SourcePage.source_id == Page.source_id) & (SourcePage.idx == Page.source_index),
        )
        .where(Page.notebook_id == notebook_id, Page.deleted_at.is_(None))
        .order_by(Page.position)
    ).all()
    return [(r[0], r[1]) for r in rows]


def bookmark_members(db: Session, bookmark_ids: Sequence[str]) -> dict[str, list[tuple[Page, SourcePage | None]]]:
    """Live pages of each bookmark, in notebook order."""
    out: dict[str, list[tuple[Page, SourcePage | None]]] = defaultdict(list)
    for part in chunks(list(bookmark_ids)):
        rows = db.execute(
            select(BookmarkPage.bookmark_id, Page, SourcePage)
            .join(Page, Page.id == BookmarkPage.page_id)
            .outerjoin(
                SourcePage,
                (SourcePage.source_id == Page.source_id) & (SourcePage.idx == Page.source_index),
            )
            .where(BookmarkPage.bookmark_id.in_(part), Page.deleted_at.is_(None))
            .order_by(Page.position)
        ).all()
        for bid, page, sp in rows:
            out[bid].append((page, sp))
    return out


def describe_nodes(db: Session, nodes: Sequence[Node]) -> list[dict[str, Any]]:
    folder_ids = [n.id for n in nodes if n.kind == FOLDER and n.trashed_at is None]
    trashed_folder_ids = [n.id for n in nodes if n.kind == FOLDER and n.trashed_at is not None]
    nb_ids = [n.id for n in nodes if n.kind == NOTEBOOK]
    bm_ids = [n.id for n in nodes if n.kind == BOOKMARK]

    child_counts = live_children_count(db, folder_ids) if folder_ids else {}
    # A trashed folder has no live children; count the ones that come back when it is restored.
    if trashed_folder_ids:
        child_counts.update(trashed_children_count(db, trashed_folder_ids))

    notebooks: dict[str, Notebook] = {}
    covers: dict[str, dict[str, Any]] = {}
    for part in chunks(nb_ids):
        notebooks.update({nb.node_id: nb for nb in db.scalars(select(Notebook).where(Notebook.node_id.in_(part)))})
        rows = db.execute(
            select(Page, SourcePage)
            .outerjoin(
                SourcePage,
                (SourcePage.source_id == Page.source_id) & (SourcePage.idx == Page.source_index),
            )
            .where(Page.notebook_id.in_(part), Page.position == 0, Page.deleted_at.is_(None))
        ).all()
        covers.update({p.notebook_id: page_json(p, sp) for p, sp in rows})

    bookmarks: dict[str, Bookmark] = {}
    for part in chunks(bm_ids):
        bookmarks.update({b.node_id: b for b in db.scalars(select(Bookmark).where(Bookmark.node_id.in_(part)))})
    target_ids = list({b.notebook_id for b in bookmarks.values()})
    targets: dict[str, Node] = {}
    for part in chunks(target_ids):
        targets.update({n.id: n for n in db.scalars(select(Node).where(Node.id.in_(part)))})
    members = bookmark_members(db, bm_ids) if bm_ids else {}

    out: list[dict[str, Any]] = []
    for node in nodes:
        item = node_base(node)
        if node.kind == FOLDER:
            item["child_count"] = child_counts.get(node.id, 0)
        elif node.kind == NOTEBOOK:
            nb = notebooks.get(node.id)
            item["page_count"] = nb.page_count if nb else 0
            item["rev"] = nb.rev if nb else 0
            item["cover"] = covers.get(node.id)
        elif node.kind == BOOKMARK:
            bm = bookmarks.get(node.id)
            target = targets.get(bm.notebook_id) if bm else None
            pages = members.get(node.id, [])
            runs = segments([p.position for p, _ in pages if p.position is not None])
            item.update(
                {
                    "notebook_id": bm.notebook_id if bm else None,
                    "notebook_name": target.name if target else None,
                    "available": bool(target and target.trashed_at is None),
                    "page_count": len(pages),
                    "segments": runs,
                    "label": segments_label(runs),
                    "cover": page_json(*pages[0]) if pages else None,
                }
            )
        out.append(item)
    return out
