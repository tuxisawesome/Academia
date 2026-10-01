"""Runtime configuration, read from environment variables (prefix ``ACADEMIA_``).

In production these come from ``/etc/academia/academia.env`` via the systemd unit.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ACADEMIA_", extra="ignore")

    data_dir: Path = Field(default=REPO_DIR / "data")
    frontend_dist: Path = Field(default=REPO_DIR / "frontend" / "dist")

    # Maximum size of a single uploaded PDF.
    max_upload_mb: int = 1024
    # Assembled-PDF cache is trimmed (least recently used first) to this size.
    pdf_cache_max_mb: int = 4096
    # Worker processes for PDF assembly and thumbnail rendering.
    pdf_workers: int = 2

    session_days: int = 30
    trash_retention_days: int = 30
    deleted_pages_retention_days: int = 7
    orphan_source_grace_days: int = 21
    export_ttl_hours: int = 24

    # Extra origins allowed to make state-changing requests (besides same-host).
    extra_origins: list[str] = Field(default_factory=list)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "db" / "academia.db"

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def build_info() -> dict[str, str]:
    """Version metadata written by the release build (``release.json`` at the repo root)."""
    info = {"version": "1.0.0", "commit": "dev", "build_id": "dev"}
    path = REPO_DIR / "release.json"
    if path.is_file():
        try:
            info.update({k: str(v) for k, v in json.loads(path.read_text()).items()})
        except (OSError, ValueError):
            pass
    return info
