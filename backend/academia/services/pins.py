"""Folders pinned to the sidebar, like Explorer's Quick access."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..errors import BadRequest
from ..models import FOLDER, Node, Pin, utcnow
from .common import ancestors, owned_node

MAX_PINS = 100


def list_pins(db: Session, user_id: str) -> list[dict[str, Any]]:
    rows = db.execute(
        select(Node, Pin.position)
        .join(Pin, Pin.node_id == Node.id)
        .where(Pin.user_id == user_id, Node.trashed_at.is_(None))
        .order_by(Pin.position, Pin.created_at)
    ).all()
    out = []
    for node, _pos in rows:
        path = ancestors(db, node.id)
        out.append(
            {
                "id": node.id,
                "name": node.name,
                "color": node.color,
                "parent_id": node.parent_id,
                "location": " / ".join(p["name"] for p in path[:-1]) or "Library",
            }
        )
    return out


def pin(db: Session, user_id: str, node_id: str) -> None:
    node = owned_node(db, user_id, node_id)
    if node.kind != FOLDER:
        raise BadRequest("Only folders can be pinned.", code="not_a_folder")
    if db.get(Pin, (user_id, node.id)) is not None:
        return
    count = db.scalar(select(func.count()).select_from(Pin).where(Pin.user_id == user_id)) or 0
    if count >= MAX_PINS:
        raise BadRequest(f"You can pin at most {MAX_PINS} folders.", code="too_many_pins")
    last = db.scalar(select(func.max(Pin.position)).where(Pin.user_id == user_id))
    db.add(Pin(user_id=user_id, node_id=node.id, position=(last or 0) + 1, created_at=utcnow()))
    db.flush()


def unpin(db: Session, user_id: str, node_id: str) -> None:
    db.execute(delete(Pin).where(Pin.user_id == user_id, Pin.node_id == node_id))


def reorder(db: Session, user_id: str, node_ids: Sequence[str]) -> None:
    pins = {p.node_id: p for p in db.scalars(select(Pin).where(Pin.user_id == user_id))}
    ordered = [i for i in dict.fromkeys(node_ids) if i in pins]
    ordered += [i for i in sorted(pins, key=lambda i: pins[i].position) if i not in ordered]
    for position, node_id in enumerate(ordered, start=1):
        pins[node_id].position = position
    db.flush()


def pinned_ids(db: Session, user_id: str) -> set[str]:
    return set(db.scalars(select(Pin.node_id).where(Pin.user_id == user_id)))
