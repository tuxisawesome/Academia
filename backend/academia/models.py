"""Database schema.

The file browser is one tree (``nodes``) holding folders, notebooks and bookmarks.
A notebook is an ordered list of ``pages``; each page points at a page of an immutable
uploaded ``source`` PDF. A bookmark is a set of page ids of one notebook, so it keeps
pointing at the same pages when the notebook is moved or its pages are reordered.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

NAMING = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

FOLDER, NOTEBOOK, BOOKMARK = "folder", "notebook", "bookmark"
NODE_KINDS = (FOLDER, NOTEBOOK, BOOKMARK)


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return str(uuid.uuid4())


class UTCDateTime(TypeDecorator[datetime]):
    """Stores naive UTC in SQLite, returns timezone-aware UTC datetimes."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is not None:
            value = value.astimezone(UTC).replace(tzinfo=None)
        return value

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)
    type_annotation_map = {datetime: UTCDateTime()}


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(64, collation="NOCASE"), unique=True)
    display_name: Mapped[str] = mapped_column(String(128), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    disabled_at: Mapped[datetime | None]
    prefs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_login_at: Mapped[datetime | None]


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(default=utcnow)
    expires_at: Mapped[datetime]
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(512), default="")

    user: Mapped[User] = relationship(lazy="joined")


class Source(Base):
    """An uploaded PDF, stored once per user (deduplicated by content hash) and never modified."""

    __tablename__ = "sources"
    __table_args__ = (UniqueConstraint("owner_id", "sha256"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    sha256: Mapped[str] = mapped_column(String(64))
    original_filename: Mapped[str] = mapped_column(String(255), default="")
    byte_size: Mapped[int] = mapped_column(Integer)
    page_count: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    # Set when no page references the source any more; the file is deleted after a grace period.
    orphaned_at: Mapped[datetime | None] = mapped_column(index=True)


class SourcePage(Base):
    __tablename__ = "source_pages"

    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), primary_key=True)
    idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Displayed size in points, after the page's own /Rotate is applied.
    width_pt: Mapped[float] = mapped_column(Float)
    height_pt: Mapped[float] = mapped_column(Float)


class Node(Base):
    __tablename__ = "nodes"
    __table_args__ = (
        CheckConstraint(f"kind IN {NODE_KINDS!r}", name="kind"),
        CheckConstraint("length(name) BETWEEN 1 AND 255", name="name_length"),
        Index(
            "ix_nodes_live_children",
            "owner_id",
            "parent_id",
            sqlite_where=text("trashed_at IS NULL"),
        ),
        Index("ix_nodes_trash_root", "owner_id", "trash_root_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(255))
    color: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow)
    trashed_at: Mapped[datetime | None]
    # The node the user actually trashed; all of its descendants share this value.
    trash_root_id: Mapped[str | None] = mapped_column(String(36))


class Notebook(Base):
    __tablename__ = "notebooks"

    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), primary_key=True)
    # Incremented on every change to the page list; clients send it back to detect conflicts.
    rev: Mapped[int] = mapped_column(Integer, default=0)
    page_count: Mapped[int] = mapped_column(Integer, default=0)


class Page(Base):
    __tablename__ = "pages"
    __table_args__ = (
        UniqueConstraint("id", "notebook_id"),
        # NULL positions (deleted pages) never collide in a UNIQUE index.
        UniqueConstraint("notebook_id", "position"),
        CheckConstraint("rotation IN (0, 90, 180, 270)", name="rotation"),
        Index("ix_pages_deleted", "deleted_at", sqlite_where=text("deleted_at IS NOT NULL")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    notebook_id: Mapped[str] = mapped_column(ForeignKey("notebooks.node_id", ondelete="CASCADE"))
    position: Mapped[int | None] = mapped_column(Integer)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="RESTRICT"), index=True)
    source_index: Mapped[int] = mapped_column(Integer)
    rotation: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    deleted_at: Mapped[datetime | None]
    deleted_batch: Mapped[str | None] = mapped_column(String(36), index=True)
    deleted_position: Mapped[int | None] = mapped_column(Integer)


class Bookmark(Base):
    __tablename__ = "bookmarks"

    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), primary_key=True)
    notebook_id: Mapped[str] = mapped_column(ForeignKey("notebooks.node_id", ondelete="CASCADE"), index=True)
    rev: Mapped[int] = mapped_column(Integer, default=0)


class BookmarkPage(Base):
    __tablename__ = "bookmark_pages"
    __table_args__ = (
        # Guarantees a bookmark only ever references pages of a single notebook.
        ForeignKeyConstraint(["page_id", "notebook_id"], ["pages.id", "pages.notebook_id"], ondelete="CASCADE"),
        Index("ix_bookmark_pages_page", "page_id"),
    )

    bookmark_id: Mapped[str] = mapped_column(ForeignKey("bookmarks.node_id", ondelete="CASCADE"), primary_key=True)
    page_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    notebook_id: Mapped[str] = mapped_column(String(36))


class ReadingProgress(Base):
    __tablename__ = "reading_progress"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), primary_key=True)
    page_id: Mapped[str | None] = mapped_column(String(36))
    page_index: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="queued")
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str] = mapped_column(String(255), default="")
    result_path: Mapped[str | None] = mapped_column(String(1024))
    result_size: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(String(1024))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    finished_at: Mapped[datetime | None]
    expires_at: Mapped[datetime | None]


class Pin(Base):
    """A folder pinned to the sidebar (per user, ordered)."""

    __tablename__ = "pins"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class PageText(Base):
    """Text layer of one page of an uploaded PDF, extracted on the server for search.
    Never shown to users.

    A row exists once the page has been processed (``body`` is empty if the page has no
    text layer, e.g. scanned handwriting). The ``page_text_fts`` full-text index is kept in
    sync by triggers (see migration 0002). A future migration that alters this table in
    Alembic batch mode recreates the table, which drops those triggers: such a migration
    must create them again.
    """

    __tablename__ = "page_texts"
    __table_args__ = (UniqueConstraint("source_id", "idx"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"))
    idx: Mapped[int] = mapped_column(Integer)
    body: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(default=utcnow)
