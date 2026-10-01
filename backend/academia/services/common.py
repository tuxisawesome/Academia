"""Helpers shared by the services: ownership checks, tree queries, serialization."""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable, Sequence
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..errors import BadRequest, NotFound
from ..models import Node

FOLDER_COLORS = (
    "oxblood",
    "terracotta",
    "ochre",
    "olive",
    "forest",
    "teal",
    "slate",
    "navy",
    "plum",
    "graphite",
)

CHUNK = 500


def chunks(items: Sequence[Any], size: int = CHUNK) -> Iterable[Sequence[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def clean_name(name: str) -> str:
    """Validate a user-supplied item name."""
    cleaned = "".join(ch for ch in unicodedata.normalize("NFC", name or "") if unicodedata.category(ch)[0] != "C")
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        raise BadRequest("Please enter a name.", code="invalid_name")
    if len(cleaned) > 255:
        raise BadRequest("Names can be at most 255 characters long.", code="invalid_name")
    return cleaned


def owned_node(
    db: Session,
    user_id: str,
    node_id: str | None,
    kinds: tuple[str, ...] | str | None = None,
    allow_trashed: bool = False,
) -> Node:
    if not node_id:
        raise NotFound()
    node = db.get(Node, node_id)
    if node is None or node.owner_id != user_id:
        raise NotFound()
    if isinstance(kinds, str):
        kinds = (kinds,)
    if kinds and node.kind not in kinds:
        raise NotFound()
    if node.trashed_at is not None and not allow_trashed:
        raise NotFound("This item is in the Trash.")
    return node


def owned_folder_or_root(db: Session, user_id: str, folder_id: str | None) -> Node | None:
    if folder_id in (None, "", "root"):
        return None
    return owned_node(db, user_id, folder_id, "folder")


def ancestors(db: Session, node_id: str) -> list[dict[str, Any]]:
    """Path from the root down to (and including) ``node_id``."""
    rows = db.execute(
        text(
            """
            WITH RECURSIVE anc(id, parent_id, name, kind, color, depth) AS (
                SELECT id, parent_id, name, kind, color, 0 FROM nodes WHERE id = :id
                UNION ALL
                SELECT n.id, n.parent_id, n.name, n.kind, n.color, anc.depth + 1
                FROM nodes n JOIN anc ON n.id = anc.parent_id
                WHERE anc.depth < 256
            )
            SELECT id, name, kind, color FROM anc ORDER BY depth DESC
            """
        ),
        {"id": node_id},
    ).all()
    return [{"id": r.id, "name": r.name, "kind": r.kind, "color": r.color} for r in rows]


def descendant_ids(db: Session, root_ids: Sequence[str], live_only: bool = False) -> list[str]:
    """``root_ids`` plus every node below them."""
    if not root_ids:
        return []
    live = "AND n.trashed_at IS NULL" if live_only else ""
    out: list[str] = []
    for part in chunks(list(root_ids)):
        params = {f"r{i}": v for i, v in enumerate(part)}
        placeholders = ", ".join(f":r{i}" for i in range(len(part)))
        rows = db.execute(
            text(
                f"""
                WITH RECURSIVE d(id) AS (
                    SELECT id FROM nodes WHERE id IN ({placeholders})
                    UNION
                    SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id WHERE 1=1 {live}
                )
                SELECT id FROM d
                """
            ),
            params,
        ).scalars()
        out.extend(rows)
    return list(dict.fromkeys(out))


def segments(positions: Sequence[int]) -> list[list[int]]:
    """Group sorted 0-based positions into 1-based inclusive ``[start, end]`` runs."""
    runs: list[list[int]] = []
    for pos in positions:
        n = pos + 1
        if runs and runs[-1][1] == n - 1:
            runs[-1][1] = n
        else:
            runs.append([n, n])
    return runs


def segments_label(runs: Sequence[Sequence[int]]) -> str:
    if not runs:
        return "No pages"
    parts = [f"{a}" if a == b else f"{a}–{b}" for a, b in runs]
    single = len(runs) == 1 and runs[0][0] == runs[0][1]
    return ("p. " if single else "pp. ") + ", ".join(parts)


def live_children_count(db: Session, folder_ids: Sequence[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for part in chunks(list(folder_ids)):
        rows = db.execute(
            text(
                f"""SELECT parent_id, count(*) AS c FROM nodes
                    WHERE parent_id IN ({", ".join(f":p{i}" for i in range(len(part)))})
                      AND trashed_at IS NULL GROUP BY parent_id"""
            ),
            {f"p{i}": v for i, v in enumerate(part)},
        ).all()
        counts.update({r.parent_id: r.c for r in rows})
    return counts


def load_nodes(db: Session, ids: Sequence[str]) -> list[Node]:
    result: list[Node] = []
    for part in chunks(list(ids)):
        result.extend(db.scalars(select(Node).where(Node.id.in_(part))))
    return result
