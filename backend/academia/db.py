"""SQLite engine and session factories.

Reads run in ordinary deferred transactions (WAL lets them proceed alongside a writer).
Writes use ``BEGIN IMMEDIATE`` so they take the write lock up front and wait on
``busy_timeout`` instead of failing with SQLITE_BUSY when upgrading a read lock.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

_engine: Engine | None = None
_read_factory: sessionmaker[Session] | None = None
_write_factory: sessionmaker[Session] | None = None


def _configure(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_conn, _record):  # noqa: ANN001
        # Let SQLAlchemy (not pysqlite) decide when transactions begin.
        dbapi_conn.isolation_level = None
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

    @event.listens_for(engine, "begin")
    def _on_begin(conn):  # noqa: ANN001
        if conn.get_execution_options().get("academia_write"):
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        else:
            conn.exec_driver_sql("BEGIN")


def init_engine(db_path: Path) -> Engine:
    """(Re)initialise the global engine for ``db_path``."""
    global _engine, _read_factory, _write_factory
    if _engine is not None:
        _engine.dispose()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 5},
        pool_size=10,
        max_overflow=20,
    )
    _configure(engine)
    _engine = engine
    _read_factory = sessionmaker(bind=engine, expire_on_commit=False)
    _write_factory = sessionmaker(bind=engine.execution_options(academia_write=True), expire_on_commit=False)
    return engine


def get_engine() -> Engine:
    if _engine is None:
        from .config import get_settings

        init_engine(get_settings().db_path)
    assert _engine is not None
    return _engine


def _factories() -> tuple[sessionmaker[Session], sessionmaker[Session]]:
    get_engine()
    assert _read_factory is not None and _write_factory is not None
    return _read_factory, _write_factory


@contextmanager
def read_session() -> Iterator[Session]:
    factory, _ = _factories()
    with factory() as session:
        yield session


@contextmanager
def write_session() -> Iterator[Session]:
    """A session whose transaction holds the SQLite write lock. Commits on success."""
    _, factory = _factories()
    with factory() as session:
        try:
            yield session
            session.commit()
        except BaseException:
            session.rollback()
            raise
