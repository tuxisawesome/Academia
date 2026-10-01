"""Alembic environment: migrations run against the configured SQLite database."""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context

from academia.db import get_engine
from academia.models import Base, UTCDateTime

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logging", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


# Full-text search tables are created with raw SQL (FTS5); Alembic must not try to manage them.
UNMANAGED_PREFIXES = ("page_text_fts",)


def include_name(name, type_, parent_names):  # noqa: ANN001, ANN201
    return not (type_ == "table" and name and name.startswith(UNMANAGED_PREFIXES))


def render_item(type_, obj, autogen_context):  # noqa: ANN001, ANN201
    # Keep migrations independent of application classes.
    if type_ == "type" and isinstance(obj, UTCDateTime):
        return "sa.DateTime()"
    return False


def run_migrations_offline() -> None:
    context.configure(
        url=str(get_engine().url),
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = get_engine()
    with engine.connect() as connection:
        # Foreign keys must be off while batch migrations recreate tables. The PRAGMA is sent
        # on the raw DBAPI connection because it is ignored inside a transaction.
        raw = connection.connection.driver_connection
        raw.execute("PRAGMA foreign_keys=OFF")
        try:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                render_as_batch=True,
                compare_type=True,
                render_item=render_item,
                include_name=include_name,
            )
            with context.begin_transaction():
                context.run_migrations()
            if connection.in_transaction():
                connection.commit()
        finally:
            raw.execute("PRAGMA foreign_keys=ON")


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
