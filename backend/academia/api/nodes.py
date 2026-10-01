"""File-browser endpoints: listing, folders, rename/color, move, copy, trash, search."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from ..services import trash as trash_service
from ..services import tree
from ..services.describe import describe_nodes
from .deps import CurrentUser, Db

router = APIRouter(tags=["library"])


class FolderBody(BaseModel):
    parent_id: str | None = None
    name: str = Field(max_length=1000)
    color: str | None = None


class NodePatch(BaseModel):
    name: str | None = Field(default=None, max_length=1000)
    color: str | None = None
    clear_color: bool = False


class IdsBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=5000)


class TargetBody(IdsBody):
    target_id: str | None = None


@router.get("/nodes")
def list_nodes(user: CurrentUser, db: Db, parent: str | None = Query(default=None)) -> dict[str, Any]:
    return tree.list_folder(db, user.id, parent)


@router.get("/nodes/{node_id}")
def get_node(node_id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    return tree.get_node(db, user.id, node_id)


@router.get("/tree")
def folder_tree(user: CurrentUser, db: Db) -> list[dict[str, Any]]:
    return tree.folder_tree(db, user.id)


@router.post("/folders")
def create_folder(body: FolderBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    node = tree.create_folder(db, user.id, body.parent_id, body.name, body.color)
    data = describe_nodes(db, [node])[0]
    db.commit()
    return data


@router.patch("/nodes/{node_id}")
def update_node(node_id: str, body: NodePatch, user: CurrentUser, db: Db) -> dict[str, Any]:
    node = tree.update_node(db, user.id, node_id, name=body.name, color=body.color, clear_color=body.clear_color)
    data = describe_nodes(db, [node])[0]
    db.commit()
    return data


@router.post("/nodes/move")
def move(body: TargetBody, user: CurrentUser, db: Db) -> dict[str, int]:
    moved = tree.move_nodes(db, user.id, body.ids, body.target_id)
    db.commit()
    return {"moved": moved}


@router.post("/nodes/copy")
def copy(body: TargetBody, user: CurrentUser, db: Db) -> dict[str, list[str]]:
    ids = tree.copy_nodes(db, user.id, body.ids, body.target_id)
    db.commit()
    return {"ids": ids}


@router.post("/nodes/trash-check")
def trash_check(body: IdsBody, user: CurrentUser, db: Db) -> dict[str, Any]:
    """What else is affected if these items are trashed (bookmarks pointing into them)."""
    return trash_service.notebook_dependents(db, user.id, body.ids)


@router.post("/nodes/trash")
def trash(body: IdsBody, user: CurrentUser, db: Db) -> dict[str, int]:
    count = trash_service.trash_nodes(db, user.id, body.ids)
    db.commit()
    return {"trashed": count}


@router.get("/trash")
def list_trash(user: CurrentUser, db: Db) -> list[dict[str, Any]]:
    return trash_service.list_trash(db, user.id)


@router.post("/trash/restore")
def restore(body: IdsBody, user: CurrentUser, db: Db) -> dict[str, int]:
    count = trash_service.restore(db, user.id, body.ids)
    db.commit()
    return {"restored": count}


@router.post("/trash/purge")
def purge(body: IdsBody, user: CurrentUser, db: Db) -> dict[str, int]:
    count = trash_service.purge(db, user.id, body.ids)
    db.commit()
    return {"purged": count}


@router.post("/trash/empty")
def empty_trash(user: CurrentUser, db: Db) -> dict[str, int]:
    count = trash_service.purge(db, user.id, None)
    db.commit()
    return {"purged": count}
