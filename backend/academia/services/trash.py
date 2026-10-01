"""Recycle Bin: trash, restore and permanent deletion.

Trashing marks a node and all of its live descendants with ``trashed_at`` and
``trash_root_id`` (the id of the node the user trashed), so a restore brings back exactly
that batch. Purging deletes the nodes; bookmarks elsewhere that point at a purged notebook
are deleted too. Uploaded source files that are no longer referenced are only *marked*
orphaned here and deleted by maintenance after a grace period, so an older database
backup never refers to files that are already gone.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import delete, exists, func, select, update
from sqlalchemy.orm import Session

from ..errors import NotFound
from ..models import NOTEBOOK, Node, Page, Source, utcnow
from .bookmarks import bookmarks_pointing_at
from .common import ancestors, chunks, descendant_ids, owned_node
from .describe import describe_nodes


def trash_nodes(db: Session, user_id: str, ids: Sequence[str]) -> int:
    wanted = list(dict.fromkeys(ids))
    nodes = [owned_node(db, user_id, i) for i in wanted]
    idset = set(wanted)
    now = utcnow()
    count = 0
    for node in nodes:
        # Skip items whose ancestor is also being trashed; they go along with it.
        if {a["id"] for a in ancestors(db, node.id)[:-1]} & idset:
            continue
        subtree = descendant_ids(db, [node.id], live_only=True)
        for part in chunks(subtree):
            db.execute(
                update(Node)
                .where(Node.id.in_(part), Node.trashed_at.is_(None))
                .values(trashed_at=now, trash_root_id=node.id)
                .execution_options(synchronize_session=False)
            )
        count += 1
    db.expire_all()
    return count


def notebook_dependents(db: Session, user_id: str, ids: Sequence[str]) -> dict[str, Any]:
    """Bookmarks outside the selection that point at notebooks inside it."""
    subtree = set(descendant_ids(db, [owned_node(db, user_id, i).id for i in ids], live_only=True))
    nb_ids = list(db.scalars(select(Node.id).where(Node.id.in_(list(subtree)), Node.kind == NOTEBOOK)))
    outside = [b for b in bookmarks_pointing_at(db, nb_ids) if b not in subtree]
    live_outside = (
        list(db.scalars(select(Node.id).where(Node.id.in_(outside), Node.trashed_at.is_(None)))) if outside else []
    )
    return {"bookmarks_elsewhere": len(live_outside)}


def list_trash(db: Session, user_id: str) -> list[dict[str, Any]]:
    roots = list(
        db.scalars(
            select(Node)
            .where(Node.owner_id == user_id, Node.trashed_at.is_not(None), Node.trash_root_id == Node.id)
            .order_by(Node.trashed_at.desc())
        )
    )
    items = describe_nodes(db, roots)
    for item, node in zip(items, roots, strict=True):
        count = db.scalar(select(func.count()).select_from(Node).where(Node.trash_root_id == node.id))
        item["item_count"] = count or 1
        parent_path = ancestors(db, node.parent_id) if node.parent_id else []
        item["original_location"] = " / ".join(p["name"] for p in parent_path) or "Library"
    return items


def restore(db: Session, user_id: str, ids: Sequence[str]) -> int:
    count = 0
    for root_id in dict.fromkeys(ids):
        node = db.get(Node, root_id)
        if node is None or node.owner_id != user_id or node.trash_root_id != node.id:
            # Not (or no longer) a trash root, e.g. an item trashed together with its folder.
            continue
        if node.parent_id is not None:
            parent = db.get(Node, node.parent_id)
            if parent is None or parent.trashed_at is not None:
                node.parent_id = None
        db.flush()
        db.execute(
            update(Node)
            .where(Node.owner_id == user_id, Node.trash_root_id == root_id)
            .values(trashed_at=None, trash_root_id=None)
            .execution_options(synchronize_session=False)
        )
        count += 1
    if count == 0:
        raise NotFound("That item is no longer in the Trash.")
    db.expire_all()
    return count


def _source_ids_of_notebooks(db: Session, notebook_ids: Sequence[str]) -> set[str]:
    out: set[str] = set()
    for part in chunks(list(notebook_ids)):
        out.update(db.scalars(select(Page.source_id).where(Page.notebook_id.in_(part)).distinct()))
    return out


def mark_orphans(db: Session, source_ids: Sequence[str] | set[str], now: datetime | None = None) -> int:
    """Stamp sources that no page references any more."""
    now = now or utcnow()
    marked = 0
    for part in chunks(list(source_ids)):
        result = db.execute(
            update(Source)
            .where(
                Source.id.in_(part),
                Source.orphaned_at.is_(None),
                ~exists().where(Page.source_id == Source.id),
            )
            .values(orphaned_at=now)
            .execution_options(synchronize_session=False)
        )
        marked += result.rowcount or 0
    return marked


def purge_roots(db: Session, root_ids: Sequence[str], user_id: str | None = None) -> int:
    """Permanently delete trashed batches (all nodes sharing each ``trash_root_id``)."""
    node_ids: list[str] = []
    for part in chunks(list(root_ids)):
        stmt = select(Node.id).where(Node.trash_root_id.in_(part), Node.trashed_at.is_not(None))
        if user_id is not None:
            stmt = stmt.where(Node.owner_id == user_id)
        node_ids.extend(db.scalars(stmt))
    if not node_ids:
        return 0
    nb_ids = []
    for part in chunks(node_ids):
        nb_ids.extend(db.scalars(select(Node.id).where(Node.id.in_(part), Node.kind == NOTEBOOK)))
    sources = _source_ids_of_notebooks(db, nb_ids)
    # Bookmarks anywhere that point at a purged notebook would be left dangling.
    dangling = [b for b in bookmarks_pointing_at(db, nb_ids) if b not in set(node_ids)]
    for part in chunks(dangling):
        db.execute(delete(Node).where(Node.id.in_(part)).execution_options(synchronize_session=False))
    for part in chunks(node_ids):
        db.execute(delete(Node).where(Node.id.in_(part)).execution_options(synchronize_session=False))
    mark_orphans(db, sources)
    db.expire_all()
    return len(set(root_ids))


def purge(db: Session, user_id: str, ids: Sequence[str] | None = None) -> int:
    """Purge the given trash roots, or the whole Trash when ``ids`` is None."""
    if ids is None:
        ids = list(
            db.scalars(
                select(Node.id).where(
                    Node.owner_id == user_id, Node.trashed_at.is_not(None), Node.trash_root_id == Node.id
                )
            )
        )
    return purge_roots(db, ids, user_id=user_id)


def purge_expired(db: Session, cutoff: datetime) -> int:
    roots = list(
        db.scalars(
            select(Node.id).where(Node.trashed_at.is_not(None), Node.trash_root_id == Node.id, Node.trashed_at < cutoff)
        )
    )
    return purge_roots(db, roots)
