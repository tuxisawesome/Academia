"""Periodic housekeeping, run by the ``academia-maint`` systemd timer (``academia maintenance``)."""

from __future__ import annotations

import logging
import shutil
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, exists, select, update

from ..config import get_settings
from ..db import read_session, write_session
from ..models import Job, Page, Session, Source, User, utcnow
from ..storage import data_dir, exports_dir, pdf_cache_dir, remove_source_files, tmp_dir
from .common import chunks
from .trash import mark_orphans, purge_expired

log = logging.getLogger(__name__)


def purge_deleted_pages(cutoff: datetime) -> int:
    with write_session() as db:
        rows = db.execute(
            select(Page.id, Page.source_id).where(Page.deleted_at.is_not(None), Page.deleted_at < cutoff)
        ).all()
        ids = [r.id for r in rows]
        for part in chunks(ids):
            db.execute(delete(Page).where(Page.id.in_(part)))
        mark_orphans(db, {r.source_id for r in rows})
        return len(ids)


def mark_unused_sources(cutoff: datetime) -> int:
    """Uploads that never made it into a notebook (e.g. an abandoned upload page)."""
    with write_session() as db:
        result = db.execute(
            update(Source)
            .where(
                Source.orphaned_at.is_(None), Source.created_at < cutoff, ~exists().where(Page.source_id == Source.id)
            )
            .values(orphaned_at=utcnow())
        )
        return result.rowcount or 0


def delete_orphaned_sources(cutoff: datetime) -> int:
    with write_session() as db:
        ids = list(
            db.scalars(
                select(Source.id).where(
                    Source.orphaned_at.is_not(None),
                    Source.orphaned_at < cutoff,
                    ~exists().where(Page.source_id == Source.id),
                )
            )
        )
        for part in chunks(ids):
            db.execute(delete(Source).where(Source.id.in_(part)))
    for sid in ids:
        remove_source_files(sid)
    return len(ids)


def remove_deleted_users_files(cutoff: datetime) -> int:
    """Uploads of deleted users, once they have been kept as long as other unused uploads.

    Their rows went with the user, so a marker next to each file says since when (see
    ``users.remove_files``). The files stay if a restored backup brought the upload back.
    """
    removed = 0
    for marker in (data_dir() / "sources").glob("*/*.deleted"):
        try:
            if marker.stat().st_mtime >= cutoff.timestamp():
                continue
        except FileNotFoundError:
            continue
        with read_session() as db:
            restored = db.get(Source, marker.stem) is not None
        if not restored:
            remove_source_files(marker.stem)
            removed += 1
        marker.unlink(missing_ok=True)
    return removed


def trim_pdf_cache(max_bytes: int, keep: Path | None = None) -> int:
    files = []
    for path in pdf_cache_dir().rglob("*.pdf"):
        try:
            st = path.stat()
        except FileNotFoundError:
            continue
        files.append((st.st_mtime, st.st_size, path))
    total = sum(size for _, size, _ in files)
    removed = 0
    for _, size, path in sorted(files):
        if total <= max_bytes:
            break
        if path == keep:
            continue
        path.unlink(missing_ok=True)
        total -= size
        removed += 1
    # Leftovers from interrupted builds.
    for part in pdf_cache_dir().rglob("*.part"):
        try:
            if part.stat().st_mtime < time.time() - 3600:
                part.unlink(missing_ok=True)
        except FileNotFoundError:  # a build finished and renamed it meanwhile
            continue
    return removed


def expire_exports(now: datetime) -> int:
    with write_session() as db:
        jobs = list(
            db.scalars(
                select(Job).where(
                    (Job.expires_at.is_not(None) & (Job.expires_at < now)) | (Job.created_at < now - timedelta(days=7))
                )
            )
        )
        for job in jobs:
            if job.result_path:
                Path(job.result_path).unlink(missing_ok=True)
            db.delete(job)
        return len(jobs)


def remove_orphaned_files() -> int:
    """Files nothing refers to any more: export archives whose job is gone (deleted users,
    interrupted exports), cached PDFs of deleted users, and leftovers of older versions."""
    # List before reading the ids: a file that exists already has its row committed.
    exports = list(exports_dir().glob("*")) if exports_dir().is_dir() else []
    cached = list(pdf_cache_dir().iterdir()) if pdf_cache_dir().is_dir() else []
    with read_session() as db:
        job_ids = set(db.scalars(select(Job.id)))
        user_ids = set(db.scalars(select(User.id)))
    removed = 0
    for path in exports:
        if path.is_file() and path.name.split(".", 1)[0] not in job_ids:
            path.unlink(missing_ok=True)
            removed += 1
    for path in cached:
        if path.is_dir():
            if path.name not in user_ids:
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
        else:  # from before the cache was kept per user
            path.unlink(missing_ok=True)
            removed += 1
    # Model files mirrored for the handwriting recognition that has been removed.
    models = data_dir() / "models"
    if models.is_dir():
        shutil.rmtree(models, ignore_errors=True)
        removed += 1
    return removed


def expire_sessions(now: datetime) -> int:
    with write_session() as db:
        return db.execute(delete(Session).where(Session.expires_at < now)).rowcount or 0


def clean_tmp(max_age_s: int = 86400) -> int:
    removed = 0
    cutoff = time.time() - max_age_s
    for path in tmp_dir().glob("*"):
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except FileNotFoundError:
            continue
    return removed


def run_maintenance() -> dict[str, Any]:
    s = get_settings()
    now = utcnow()
    stats: dict[str, Any] = {}
    with write_session() as db:
        stats["trash_purged"] = purge_expired(db, now - timedelta(days=s.trash_retention_days))
    stats["pages_purged"] = purge_deleted_pages(now - timedelta(days=s.deleted_pages_retention_days))
    stats["unused_sources_marked"] = mark_unused_sources(now - timedelta(days=1))
    stats["sources_deleted"] = delete_orphaned_sources(now - timedelta(days=s.orphan_source_grace_days))
    stats["deleted_users_files"] = remove_deleted_users_files(now - timedelta(days=s.orphan_source_grace_days))
    stats["cache_files_removed"] = trim_pdf_cache(s.pdf_cache_max_mb * 1024 * 1024)
    stats["exports_expired"] = expire_exports(now)
    stats["orphaned_files_removed"] = remove_orphaned_files()
    stats["sessions_expired"] = expire_sessions(now)
    stats["tmp_files_removed"] = clean_tmp()
    log.info("Maintenance: %s", stats)
    return stats


def backup_database(dest_dir: Path | None = None, keep: int = 14, label: str = "nightly") -> Path:
    """Consistent online copy of the SQLite database (safe while the app is running)."""
    s = get_settings()
    dest_dir = dest_dir or (data_dir() / "backups")
    dest_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = dest_dir / f"academia-{label}-{stamp}.db"
    src = sqlite3.connect(s.db_path)
    try:
        out = sqlite3.connect(dest)
        try:
            src.backup(out)
        finally:
            out.close()
    finally:
        src.close()
    if keep > 0:
        backups = sorted(dest_dir.glob(f"academia-{label}-*.db"))
        for old in backups[:-keep]:
            old.unlink(missing_ok=True)
    return dest
