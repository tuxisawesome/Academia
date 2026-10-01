"""Programmatic Alembic helpers (used at startup, by the CLI and by tests)."""

from __future__ import annotations

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory

from .config import BACKEND_DIR
from .db import get_engine


def alembic_config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    return cfg


def upgrade_head() -> None:
    command.upgrade(alembic_config(), "head")


def current_and_head() -> tuple[str | None, str | None]:
    script = ScriptDirectory.from_config(alembic_config())
    with get_engine().connect() as conn:
        current = MigrationContext.configure(conn).get_current_revision()
    return current, script.get_current_head()
