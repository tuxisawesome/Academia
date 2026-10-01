"""Export all of a user's data as a ZIP of PDFs mirroring the folder tree."""

from __future__ import annotations

import errno
import json
import logging
import os
import re
import threading
import unicodedata
import uuid
import zipfile
from collections import defaultdict
from concurrent.futures import CancelledError
from datetime import timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from ..config import get_settings
from ..db import read_session, write_session
from ..errors import BadRequest, NotFound
from ..models import BOOKMARK, FOLDER, NOTEBOOK, BookmarkPage, Job, Node, Page, Source, utcnow
from ..storage import export_path, free_bytes, pdf_cache_path, source_path, tmp_dir
from ..workers import pdfops, pool
from .bookmarks import require_bookmark
from .common import segments, unwanted_in_name
from .describe import bookmark_members
from .pdfbuild import bookmark_spec, notebook_spec, spec_digest

log = logging.getLogger(__name__)

EXPORT = "export"
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def safe_filename(name: str, limit: int = 150) -> str:
    """A file name that is valid on Windows, macOS and Linux, and not hidden.

    ``limit`` is in UTF-8 bytes: Linux and macOS allow at most 255 bytes per name.
    """
    name = unicodedata.normalize("NFC", name or "")
    name = "".join("_" if (unwanted_in_name(c) or c in '<>:"/\\|?*') else c for c in name)
    name = re.sub(r"\s+", " ", name).strip(". ")
    if not name:
        name = "Untitled"
    if name.split(".")[0].upper() in _RESERVED:
        name = f"_{name}"
    return name.encode()[:limit].decode(errors="ignore").rstrip(". ") or "Untitled"


def job_json(job: Job) -> dict[str, Any]:
    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "progress": job.progress,
        "total": job.total,
        "message": job.message,
        "error": job.error,
        "params": job.params,
        "size": job.result_size,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
        "expires_at": job.expires_at,
    }


def start_export(user_id: str, embed_bookmarks: bool, bookmark_pdfs: bool) -> dict[str, Any]:
    with write_session() as db:
        running = db.scalar(
            select(Job).where(Job.owner_id == user_id, Job.kind == EXPORT, Job.status.in_(("queued", "running")))
        )
        if running is not None:
            return job_json(running)
        job = Job(
            owner_id=user_id,
            kind=EXPORT,
            status="queued",
            params={"embed_bookmarks": embed_bookmarks, "bookmark_pdfs": bookmark_pdfs},
            message="Preparing…",
        )
        db.add(job)
        db.flush()
        data = job_json(job)
        job_id = job.id
    threading.Thread(target=run_export, args=(job_id,), name=f"export-{job_id[:8]}", daemon=True).start()
    return data


def get_job(user_id: str, job_id: str) -> Job:
    with read_session() as db:
        job = db.get(Job, job_id)
        if job is None or job.owner_id != user_id or job.kind != EXPORT:
            raise NotFound("Export not found.")
        return job


def latest_jobs(user_id: str, limit: int = 5) -> list[dict[str, Any]]:
    with read_session() as db:
        jobs = db.scalars(
            select(Job).where(Job.owner_id == user_id, Job.kind == EXPORT).order_by(Job.created_at.desc()).limit(limit)
        )
        return [job_json(j) for j in jobs]


def _update(job_id: str, **values: Any) -> bool:
    """Returns False if the job no longer exists (its owner was deleted)."""
    with write_session() as db:
        job = db.get(Job, job_id)
        if job is None:
            return False
        for key, value in values.items():
            setattr(job, key, value)
        return True


def _plan(db, user_id: str, bookmark_pdfs: bool) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:  # noqa: ANN001
    nodes = list(db.scalars(select(Node).where(Node.owner_id == user_id, Node.trashed_at.is_(None))))
    by_parent: dict[str | None, list[Node]] = defaultdict(list)
    for n in nodes:
        by_parent[n.parent_id].append(n)
    order = {FOLDER: 0, NOTEBOOK: 1, BOOKMARK: 2}
    entries: list[dict[str, Any]] = []
    manifest_items: list[dict[str, Any]] = []
    bm_ids = [n.id for n in nodes if n.kind == BOOKMARK]
    members = bookmark_members(db, bm_ids) if bm_ids else {}
    from ..models import Bookmark

    bookmarks = (
        {b.node_id: b for b in db.scalars(select(Bookmark).where(Bookmark.node_id.in_(bm_ids)))} if bm_ids else {}
    )

    def walk(parent_id: str | None, prefix: str) -> None:
        used: set[str] = set()
        for node in sorted(by_parent.get(parent_id, []), key=lambda n: (order[n.kind], n.name.casefold())):
            base = safe_filename(node.name)
            ext = "" if node.kind == FOLDER else ".pdf"
            candidate, k = base, 2
            while (candidate + ext).casefold() in used:
                candidate = f"{base} ({k})"
                k += 1
            used.add((candidate + ext).casefold())
            path = f"{prefix}{candidate}{ext}"
            item: dict[str, Any] = {
                "id": node.id,
                "kind": node.kind,
                "name": node.name,
                "parent_id": node.parent_id,
                "color": node.color,
                "created_at": node.created_at.isoformat(),
                "updated_at": node.updated_at.isoformat(),
                "path": None,
            }
            if node.kind == FOLDER:
                item["path"] = path + "/"
                entries.append({"kind": FOLDER, "id": node.id, "path": path + "/"})
                manifest_items.append(item)
                walk(node.id, path + "/")
                continue
            if node.kind == NOTEBOOK:
                item["path"] = path
                entries.append({"kind": NOTEBOOK, "id": node.id, "path": path})
            else:
                bm = bookmarks.get(node.id)
                pages = members.get(node.id, [])
                runs = segments([p.position for p, _ in pages if p.position is not None])
                item["notebook_id"] = bm.notebook_id if bm else None
                item["segments"] = runs
                if bookmark_pdfs:
                    item["path"] = path
                    entries.append({"kind": BOOKMARK, "id": node.id, "path": path})
            manifest_items.append(item)

    walk(None, "Academia/")
    return entries, manifest_items


def _estimate_bytes(db, user_id: str, bookmark_pdfs: bool) -> int:  # noqa: ANN001
    """Roughly the size of the archive: each exported page costs its share of its source file,
    once per notebook (copies share sources) and once more per bookmark PDF it is in."""
    share = func.coalesce(func.sum(Source.byte_size * 1.0 / func.max(Source.page_count, 1)), 0)
    total = (
        db.scalar(
            select(share)
            .select_from(Page)
            .join(Source, Source.id == Page.source_id)
            .join(Node, Node.id == Page.notebook_id)
            .where(Node.owner_id == user_id, Node.trashed_at.is_(None), Page.deleted_at.is_(None))
        )
        or 0
    )
    if bookmark_pdfs:
        total += (
            db.scalar(
                select(share)
                .select_from(BookmarkPage)
                .join(Page, Page.id == BookmarkPage.page_id)
                .join(Source, Source.id == Page.source_id)
                .join(Node, Node.id == BookmarkPage.bookmark_id)
                .where(Node.owner_id == user_id, Node.trashed_at.is_(None), Page.deleted_at.is_(None))
            )
            or 0
        )
    return int(total * 1.1) + 64 * 1024 * 1024


def _write_pdf(zf: zipfile.ZipFile, job_id: str, user_id: str, spec: dict[str, Any], arcname: str) -> bool:
    """Add the PDF for ``spec`` to the archive. Returns False if it can't be built (e.g. a damaged
    source file), so that one broken notebook doesn't stop the rest of the export."""
    cached = pdf_cache_path(user_id, spec_digest(spec))
    if cached.exists():
        zf.write(cached, arcname)
        return True
    # A unique name: a build that timed out may still finish later and must not land on the
    # file of the next entry.
    tmp = tmp_dir() / f"export-{job_id}-{uuid.uuid4().hex}.pdf"
    resolved = dict(spec)
    resolved["pages"] = [[str(source_path(s)), i, r] for s, i, r in spec["pages"]]
    try:
        try:
            pool.run(pdfops.assemble, resolved, str(tmp))
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, CancelledError) or (
                isinstance(exc, OSError) and exc.errno in (errno.ENOSPC, errno.EDQUOT)
            ):
                raise  # the disk is full or the server is stopping: the whole export fails
            log.exception("Export %s: could not build %s", job_id, arcname)
            return False
        zf.write(tmp, arcname)
        return True
    finally:
        tmp.unlink(missing_ok=True)


def run_export(job_id: str) -> None:
    settings = get_settings()
    final = export_path(job_id)
    part = final.with_suffix(".zip.part")
    try:
        with read_session() as db:
            job = db.get(Job, job_id)
            if job is None:
                return
            user_id = job.owner_id
            embed = bool(job.params.get("embed_bookmarks", True))
            bookmark_pdfs = bool(job.params.get("bookmark_pdfs", False))
            entries, manifest_items = _plan(db, user_id, bookmark_pdfs)
            needed = _estimate_bytes(db, user_id, bookmark_pdfs)
        final.parent.mkdir(parents=True, exist_ok=True)
        if free_bytes(final.parent) < needed:
            raise BadRequest(
                f"Not enough free disk space on the server for this export (about {needed // (1024 * 1024)} MB needed)."
            )
        files = [e for e in entries if e["kind"] != FOLDER]
        _update(job_id, status="running", total=len(files), progress=0, message="Building PDFs…")

        items = {item["id"]: item for item in manifest_items}
        failed: list[str] = []
        done = 0
        with zipfile.ZipFile(part, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            for entry in entries:
                if entry["kind"] == FOLDER:
                    zf.writestr(zipfile.ZipInfo(entry["path"]), b"")
                    continue
                with read_session() as db:
                    try:
                        if entry["kind"] == NOTEBOOK:
                            _, spec = notebook_spec(db, user_id, entry["id"], with_outline=embed)
                        else:
                            require_bookmark(db, user_id, entry["id"])
                            _, _, spec = bookmark_spec(db, user_id, entry["id"], with_outline=embed)
                    except NotFound:
                        spec = None
                # The manifest only gives paths of files that are in the archive.
                item = items[entry["id"]]
                if not spec or not spec["pages"]:
                    item["path"] = None  # empty, or a bookmark into a notebook in the Trash
                elif not _write_pdf(zf, job_id, user_id, spec, entry["path"]):
                    item["path"] = None
                    item["error"] = "The PDF could not be built."
                    failed.append(entry["path"].removeprefix("Academia/"))
                done += 1
                _update(job_id, progress=done, message=f"Added {entry['path'].removeprefix('Academia/')}"[:250])
            manifest = {
                "format": "academia-export",
                "version": 1,
                "exported_at": utcnow().isoformat(),
                "options": {"embed_bookmarks": embed, "bookmark_pdfs": bookmark_pdfs},
                "items": manifest_items,
            }
            zf.writestr(
                "Academia/manifest.json",
                json.dumps(manifest, ensure_ascii=False, indent=2),
                compress_type=zipfile.ZIP_DEFLATED,
            )
        os.replace(part, final)
        now = utcnow()
        updated = _update(
            job_id,
            status="done",
            message="Ready to download.",
            error=f"Not included (could not be built): {', '.join(failed)}"[:1000] if failed else None,
            result_path=str(final),
            result_size=final.stat().st_size,
            finished_at=now,
            expires_at=now + timedelta(hours=settings.export_ttl_hours),
        )
        if not updated:
            final.unlink(missing_ok=True)  # the user was deleted meanwhile
    except Exception as exc:  # noqa: BLE001
        log.exception("Export %s failed", job_id)
        part.unlink(missing_ok=True)
        message = getattr(exc, "message", None) or "The export failed. Please try again."
        _update(job_id, status="failed", error=str(message)[:1000], message="Failed.", finished_at=utcnow())


def export_file(user_id: str, job_id: str, tz: str | None = None) -> tuple[Path, str]:
    """The archive and its download name, dated in the user's time zone ``tz`` (IANA name)."""
    job = get_job(user_id, job_id)
    if job.status != "done" or not job.result_path or not Path(job.result_path).exists():
        raise NotFound("This export is no longer available.")
    created = job.created_at
    try:
        created = created.astimezone(ZoneInfo(tz)) if tz else created
    except (KeyError, ValueError, OSError):  # unknown or malformed zone name: keep UTC
        pass
    stamp = created.strftime("%Y-%m-%d")
    return Path(job.result_path), f"Academia export {stamp}.zip"


def fail_interrupted_jobs() -> None:
    with write_session() as db:
        for job in db.scalars(select(Job).where(Job.status.in_(("queued", "running")))):
            job.status = "failed"
            job.error = "Interrupted by a server restart. Please start the export again."
            job.finished_at = utcnow()
            export_path(job.id).with_suffix(".zip.part").unlink(missing_ok=True)
