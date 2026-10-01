"""The file-browser tree: listing, creating, renaming, moving and copying items."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..errors import BadRequest, NotFound
from ..models import (
    BOOKMARK,
    FOLDER,
    NOTEBOOK,
    Bookmark,
    BookmarkPage,
    Node,
    Notebook,
    Page,
    new_id,
    utcnow,
)
from .common import (
    FOLDER_COLORS,
    ancestors,
    clean_name,
    descendant_ids,
    load_nodes,
    owned_folder_or_root,
    owned_node,
)
from .describe import describe_nodes


def list_folder(db: Session, user_id: str, folder_id: str | None) -> dict[str, Any]:
    folder = owned_folder_or_root(db, user_id, folder_id)
    parent_id = folder.id if folder else None
    nodes = list(
        db.scalars(
            select(Node)
            .where(
                Node.owner_id == user_id,
                Node.parent_id.is_(None) if parent_id is None else Node.parent_id == parent_id,
                Node.trashed_at.is_(None),
            )
            .order_by((Node.kind != FOLDER), func.lower(Node.name))
        )
    )
    return {
        "folder": describe_nodes(db, [folder])[0] if folder else None,
        "path": ancestors(db, folder.id) if folder else [],
        "items": describe_nodes(db, nodes),
    }


def folder_tree(db: Session, user_id: str) -> list[dict[str, Any]]:
    rows = db.execute(
        select(Node.id, Node.parent_id, Node.name, Node.color).where(
            Node.owner_id == user_id, Node.kind == FOLDER, Node.trashed_at.is_(None)
        )
    ).all()
    return [{"id": r.id, "parent_id": r.parent_id, "name": r.name, "color": r.color} for r in rows]


def get_node(db: Session, user_id: str, node_id: str) -> dict[str, Any]:
    node = owned_node(db, user_id, node_id, allow_trashed=True)
    item = describe_nodes(db, [node])[0]
    item["path"] = ancestors(db, node.id)
    return item


def create_folder(db: Session, user_id: str, parent_id: str | None, name: str, color: str | None = None) -> Node:
    parent = owned_folder_or_root(db, user_id, parent_id)
    if color is not None and color not in FOLDER_COLORS:
        raise BadRequest("Unknown folder color.", code="invalid_color")
    node = Node(
        owner_id=user_id,
        parent_id=parent.id if parent else None,
        kind=FOLDER,
        name=clean_name(name),
        color=color,
    )
    db.add(node)
    db.flush()
    return node


def update_node(
    db: Session,
    user_id: str,
    node_id: str,
    name: str | None = None,
    color: str | None = None,
    clear_color: bool = False,
) -> Node:
    node = owned_node(db, user_id, node_id)
    if name is not None:
        node.name = clean_name(name)
    if clear_color:
        node.color = None
    elif color is not None:
        if node.kind != FOLDER:
            raise BadRequest("Only folders can be colored.", code="invalid_color")
        if color not in FOLDER_COLORS:
            raise BadRequest("Unknown folder color.", code="invalid_color")
        node.color = color
    node.updated_at = utcnow()
    db.flush()
    return node


def _top_level(db: Session, user_id: str, ids: list[str]) -> list[Node]:
    """Owned live nodes for ``ids``, dropping any whose ancestor is also in the list."""
    wanted = list(dict.fromkeys(ids))
    nodes = [owned_node(db, user_id, i) for i in wanted]
    idset = set(wanted)
    result = []
    for node in nodes:
        path_ids = {a["id"] for a in ancestors(db, node.id)[:-1]}
        if not (path_ids & idset):
            result.append(node)
    return result


def move_nodes(db: Session, user_id: str, ids: list[str], target_id: str | None) -> int:
    target = owned_folder_or_root(db, user_id, target_id)
    target_path = {a["id"] for a in ancestors(db, target.id)} if target else set()
    moved = 0
    now = utcnow()
    for node in _top_level(db, user_id, ids):
        if node.id in target_path:
            raise BadRequest(
                f"“{node.name}” can't be moved into itself or one of its own folders.",
                code="move_into_self",
            )
        new_parent = target.id if target else None
        if node.parent_id != new_parent:
            node.parent_id = new_parent
            node.updated_at = now
            moved += 1
    db.flush()
    return moved


def copy_nodes(db: Session, user_id: str, ids: list[str], target_id: str | None) -> list[str]:
    """Deep-copy items into a folder. Returns the ids of the new top-level items.

    Notebook copies get new page rows that reference the same immutable sources. A bookmark
    copied together with its notebook points at the copy; one copied alone keeps pointing
    at the original notebook.
    """
    target = owned_folder_or_root(db, user_id, target_id)
    target_path = {a["id"] for a in ancestors(db, target.id)} if target else set()
    tops = _top_level(db, user_id, ids)
    for node in tops:
        if node.kind == FOLDER and node.id in target_path:
            raise BadRequest(f"“{node.name}” can't be copied into itself.", code="copy_into_self")

    all_ids = descendant_ids(db, [n.id for n in tops], live_only=True)
    nodes = {n.id: n for n in load_nodes(db, all_ids) if n.trashed_at is None}
    children: dict[str | None, list[Node]] = defaultdict(list)
    for n in nodes.values():
        children[n.parent_id].append(n)

    node_map: dict[str, str] = {}
    page_map: dict[str, str] = {}
    now = utcnow()
    new_tops: list[str] = []
    pending_bookmarks: list[tuple[Node, Node]] = []

    def clone(node: Node, parent_id: str | None, rename: bool) -> Node:
        name = node.name
        if rename:
            name = f"{name} (copy)"[:255]
        copy = Node(
            owner_id=user_id,
            parent_id=parent_id,
            kind=node.kind,
            name=name,
            color=node.color,
            created_at=now,
            updated_at=now,
        )
        db.add(copy)
        db.flush()
        node_map[node.id] = copy.id
        if node.kind == NOTEBOOK:
            db.add(Notebook(node_id=copy.id, rev=0, page_count=0))
            db.flush()
            pages = db.scalars(
                select(Page).where(Page.notebook_id == node.id, Page.deleted_at.is_(None)).order_by(Page.position)
            ).all()
            for i, page in enumerate(pages):
                new_page = Page(
                    id=new_id(),
                    notebook_id=copy.id,
                    position=i,
                    source_id=page.source_id,
                    source_index=page.source_index,
                    rotation=page.rotation,
                    created_at=now,
                )
                db.add(new_page)
                page_map[page.id] = new_page.id
            db.flush()
            nb = db.get(Notebook, copy.id)
            assert nb is not None
            nb.page_count = len(pages)
        elif node.kind == BOOKMARK:
            pending_bookmarks.append((node, copy))
        for child in children.get(node.id, []):
            clone(child, copy.id, False)
        return copy

    parent_for_new = target.id if target else None
    for node in tops:
        copy = clone(node, parent_for_new, rename=node.parent_id == parent_for_new)
        new_tops.append(copy.id)

    for original, copy in pending_bookmarks:
        bm = db.get(Bookmark, original.id)
        if bm is None:
            continue
        member_ids = db.scalars(select(BookmarkPage.page_id).where(BookmarkPage.bookmark_id == original.id)).all()
        if bm.notebook_id in node_map:
            new_nb = node_map[bm.notebook_id]
            db.add(Bookmark(node_id=copy.id, notebook_id=new_nb, rev=0))
            db.flush()
            for pid in member_ids:
                if pid in page_map:
                    db.add(BookmarkPage(bookmark_id=copy.id, page_id=page_map[pid], notebook_id=new_nb))
        else:
            db.add(Bookmark(node_id=copy.id, notebook_id=bm.notebook_id, rev=0))
            db.flush()
            for pid in member_ids:
                db.add(BookmarkPage(bookmark_id=copy.id, page_id=pid, notebook_id=bm.notebook_id))
    db.flush()
    return new_tops


def all_notebooks(db: Session, user_id: str) -> list[dict[str, Any]]:
    """Every live notebook, with its folder location (for pickers)."""
    nodes = list(
        db.scalars(
            select(Node)
            .where(Node.owner_id == user_id, Node.kind == NOTEBOOK, Node.trashed_at.is_(None))
            .order_by(func.lower(Node.name))
        )
    )
    folders = {f["id"]: f for f in folder_tree(db, user_id)}
    items = describe_nodes(db, nodes)
    for item in items:
        parts: list[str] = []
        parent_id, seen = item["parent_id"], set()
        while parent_id and parent_id in folders and parent_id not in seen:
            seen.add(parent_id)
            parts.append(folders[parent_id]["name"])
            parent_id = folders[parent_id]["parent_id"]
        item["location"] = " / ".join(reversed(parts))
    return items


def require_notebook(db: Session, user_id: str, node_id: str, allow_trashed: bool = False) -> tuple[Node, Notebook]:
    node = owned_node(db, user_id, node_id, NOTEBOOK, allow_trashed=allow_trashed)
    nb = db.get(Notebook, node.id)
    if nb is None:
        raise NotFound()
    return node, nb
