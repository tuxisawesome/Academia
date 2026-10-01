"""Locations of files in the data directory."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from .config import get_settings

THUMB_WIDTHS = (200, 400, 800)


def data_dir() -> Path:
    return get_settings().data_dir


def ensure_dirs() -> None:
    root = data_dir()
    for sub in ("db", "sources", "thumbs", "cache/pdf", "exports", "tmp", "backups"):
        (root / sub).mkdir(parents=True, exist_ok=True)


def tmp_dir() -> Path:
    return data_dir() / "tmp"


def source_path(source_id: str) -> Path:
    return data_dir() / "sources" / source_id[:2] / f"{source_id}.pdf"


def thumb_dir(source_id: str) -> Path:
    return data_dir() / "thumbs" / source_id


def thumb_path(source_id: str, idx: int, width: int) -> Path:
    return thumb_dir(source_id) / f"{idx}-{width}.webp"


def pdf_cache_dir() -> Path:
    return data_dir() / "cache" / "pdf"


def pdf_cache_path(digest: str) -> Path:
    return pdf_cache_dir() / f"{digest}.pdf"


def export_path(job_id: str) -> Path:
    return data_dir() / "exports" / f"{job_id}.zip"


def remove_source_files(source_id: str) -> None:
    try:
        source_path(source_id).unlink()
    except FileNotFoundError:
        pass
    shutil.rmtree(thumb_dir(source_id), ignore_errors=True)


def free_bytes(path: Path) -> int:
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize
