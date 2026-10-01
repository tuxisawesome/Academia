"""Classes (courses) and page tags.

A page can be tagged with at most one date and any number of the user's classes. Tags are
not part of the PDF, so tagging leaves the notebook's ``rev`` (and its PDF) alone.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from ..errors import BadRequest, Conflict, NotFound, Unprocessable
from ..models import Class, Node, Page, PageClass, utcnow
from .bookmarks import validated_pages
from .common import FOLDER_COLORS, chunks, clean_name, owned_class_ids
from .tree import require_notebook

MAX_CLASSES = 500
MAX_CLASS_NAME = 80

_date_re = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def parse_date(value: str) -> date:
    """A ``YYYY-MM-DD`` calendar date between the years 1900 and 2200."""
    day = None
    if _date_re.fullmatch(value):
        try:
            day = date.fromisoformat(value)
        except ValueError:
            pass
    if day is None:
        raise Unprocessable("Dates must be real calendar dates written as YYYY-MM-DD.", code="invalid_date")
    if not 1900 <= day.year <= 2200:
        raise Unprocessable("Dates must be between the years 1900 and 2200.", code="invalid_date")
    return day


def _check_color(color: str | None) -> None:
    if color is not None and color not in FOLDER_COLORS:
        raise BadRequest("Unknown class color.", code="invalid_color")


def _clean_class_name(db: Session, user_id: str, name: str, class_id: str | None = None) -> str:
    """Validate a class name; names are unique per user regardless of case."""
    cleaned = clean_name(name, MAX_CLASS_NAME)
    folded = cleaned.casefold()
    rows = db.execute(select(Class.id, Class.name).where(Class.owner_id == user_id)).all()
    for other_id, other_name in rows:
        if other_id != class_id and other_name.casefold() == folded:
            raise Conflict(f"You already have a class called “{other_name}”.", code="duplicate_class")
    return cleaned


def owned_class(db: Session, user_id: str, class_id: str) -> Class:
    cls = db.get(Class, class_id)
    if cls is None or cls.owner_id != user_id:
        raise NotFound("That class could not be found.")
    return cls


def list_classes(db: Session, user_id: str) -> list[dict[str, Any]]:
    # Live pages of notebooks outside the Trash.
    counts = dict(
        db.execute(
            select(PageClass.class_id, func.count())
            .join(Class, Class.id == PageClass.class_id)
            .join(Page, Page.id == PageClass.page_id)
            .join(Node, Node.id == Page.notebook_id)
            .where(Class.owner_id == user_id, Page.deleted_at.is_(None), Node.trashed_at.is_(None))
            .group_by(PageClass.class_id)
        ).all()
    )
    classes = db.scalars(select(Class).where(Class.owner_id == user_id).order_by(Class.position, Class.name))
    return [
        {"id": c.id, "name": c.name, "color": c.color, "position": c.position, "page_count": counts.get(c.id, 0)}
        for c in classes
    ]


def class_json(db: Session, user_id: str, class_id: str) -> dict[str, Any]:
    return next(c for c in list_classes(db, user_id) if c["id"] == class_id)


def create_class(db: Session, user_id: str, name: str, color: str | None = None) -> Class:
    _check_color(color)
    cleaned = _clean_class_name(db, user_id, name)
    count = db.scalar(select(func.count()).select_from(Class).where(Class.owner_id == user_id)) or 0
    if count >= MAX_CLASSES:
        raise BadRequest(f"You can have at most {MAX_CLASSES} classes.", code="too_many_classes")
    last = db.scalar(select(func.max(Class.position)).where(Class.owner_id == user_id))
    cls = Class(
        owner_id=user_id,
        name=cleaned,
        color=color,
        position=0 if last is None else last + 1,
        created_at=utcnow(),
    )
    db.add(cls)
    db.flush()
    return cls


def update_class(
    db: Session,
    user_id: str,
    class_id: str,
    name: str | None = None,
    color: str | None = None,
    clear_color: bool = False,
) -> Class:
    cls = owned_class(db, user_id, class_id)
    if name is not None:
        cls.name = _clean_class_name(db, user_id, name, cls.id)
    if clear_color:
        cls.color = None
    elif color is not None:
        _check_color(color)
        cls.color = color
    db.flush()
    return cls


def delete_class(db: Session, user_id: str, class_id: str) -> None:
    cls = owned_class(db, user_id, class_id)
    # The pages' tags go with it (ON DELETE CASCADE).
    db.execute(delete(Class).where(Class.id == cls.id))
    db.expire_all()


def reorder(db: Session, user_id: str, class_ids: Sequence[str]) -> None:
    classes = {c.id: c for c in db.scalars(select(Class).where(Class.owner_id == user_id))}
    if len(class_ids) != len(classes) or set(class_ids) != set(classes):
        raise BadRequest("The class list changed. Please try again.", code="bad_order")
    for position, class_id in enumerate(class_ids):
        classes[class_id].position = position
    db.flush()


def tag_pages(
    db: Session,
    user_id: str,
    notebook_id: str,
    page_ids: Sequence[str],
    *,
    set_date: bool = False,
    day: date | None = None,
    add_classes: Sequence[str] = (),
    remove_classes: Sequence[str] = (),
) -> None:
    """Set or clear the date (when ``set_date``) and add or remove classes on live pages."""
    node, _nb = require_notebook(db, user_id, notebook_id, allow_trashed=True)
    if node.trashed_at is not None:
        raise Conflict("This notebook is in the Trash. Restore it to tag its pages.", code="trashed")
    wanted = validated_pages(db, node.id, page_ids)
    add = owned_class_ids(db, user_id, add_classes)
    remove = owned_class_ids(db, user_id, remove_classes)
    for part in chunks(wanted):
        if set_date:
            db.execute(
                update(Page).where(Page.id.in_(part)).values(tag_date=day).execution_options(synchronize_session=False)
            )
        if remove:
            db.execute(delete(PageClass).where(PageClass.page_id.in_(part), PageClass.class_id.in_(remove)))
        if add:
            db.execute(
                insert(PageClass).on_conflict_do_nothing(),
                [{"page_id": pid, "class_id": cid} for pid in part for cid in add],
            )
    db.expire_all()
