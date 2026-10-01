from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from fastapi.testclient import TestClient
from pikepdf import Dictionary, Name

from academia import config
from academia.db import init_engine, write_session
from academia.security import login_limiter
from academia.services.users import create_user
from academia.workers import pool

ORIGIN = "http://testserver"
PASSWORD = "correct horse battery"


def make_pdf(
    path: Path,
    pages: int = 3,
    size: tuple[float, float] = (300, 400),
    label: str = "p",
    rotate: dict[int, int] | None = None,
    owner_password: str | None = None,
    user_password: str | None = None,
) -> Path:
    """A PDF whose page i shows the text f"{label}{i+1}"."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica))
    for i in range(pages):
        pdf.add_blank_page(page_size=size)
        page = pdf.pages[-1]
        page.obj.Resources = Dictionary(Font=Dictionary(F1=font))
        page.obj.Contents = pdf.make_stream(f"BT /F1 24 Tf 30 {size[1] / 2} Td ({label}{i + 1}) Tj ET".encode())
        if rotate and i in rotate:
            page.obj.Rotate = rotate[i]
    kwargs: dict[str, Any] = {}
    if owner_password or user_password:
        kwargs["encryption"] = pikepdf.Encryption(owner=owner_password or "", user=user_password or "")
    pdf.save(path, **kwargs)
    return path


def make_text_pdf(path: Path, texts: list[str], size: tuple[float, float] = (300, 400)) -> Path:
    """A PDF with one page per string, each showing that text."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica))
    for text in texts:
        pdf.add_blank_page(page_size=size)
        page = pdf.pages[-1]
        page.obj.Resources = Dictionary(Font=Dictionary(F1=font))
        safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        page.obj.Contents = pdf.make_stream(f"BT /F1 12 Tf 20 {size[1] / 2} Td ({safe}) Tj ET".encode())
    pdf.save(path)
    return path


def page_texts(pdf_bytes_or_path: bytes | Path) -> list[str]:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_bytes_or_path)
    try:
        out = []
        for i in range(len(doc)):
            page = doc[i]
            text = page.get_textpage().get_text_range().strip()
            out.append(text)
            page.close()
        return out
    finally:
        doc.close()


@pytest.fixture(scope="session")
def template_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("template")
    mp = pytest.MonkeyPatch()
    mp.setenv("ACADEMIA_DATA_DIR", str(root))
    config.get_settings.cache_clear()
    init_engine(config.get_settings().db_path)
    from academia.migrations import upgrade_head

    upgrade_head()
    engine = init_engine(config.get_settings().db_path)
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    engine.dispose()
    mp.undo()
    config.get_settings.cache_clear()
    return root / "db" / "academia.db"


@pytest.fixture(scope="session", autouse=True)
def _shutdown_pool() -> Iterator[None]:
    yield
    pool.shutdown()


@pytest.fixture
def data_dir(tmp_path: Path, template_db: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "data"
    (root / "db").mkdir(parents=True)
    shutil.copy(template_db, root / "db" / "academia.db")
    monkeypatch.setenv("ACADEMIA_DATA_DIR", str(root))
    monkeypatch.setenv("ACADEMIA_FRONTEND_DIST", str(tmp_path / "dist"))
    config.get_settings.cache_clear()
    login_limiter.reset()
    init_engine(config.get_settings().db_path)
    yield root
    config.get_settings.cache_clear()


@pytest.fixture
def app(data_dir: Path):
    from academia.main import create_app

    return create_app()


def _client(app) -> TestClient:  # noqa: ANN001
    return TestClient(app, base_url=ORIGIN, headers={"Origin": ORIGIN})


@pytest.fixture
def anon(app) -> Iterator[TestClient]:  # noqa: ANN001
    with _client(app) as client:
        yield client


def add_user(username: str, admin: bool = False, must_change: bool = False) -> str:
    with write_session() as db:
        user, _ = create_user(db, username, password=PASSWORD, is_admin=admin, must_change=must_change)
        return user.id


def login(client: TestClient, username: str, password: str = PASSWORD) -> dict[str, Any]:
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def client(app) -> Iterator[TestClient]:  # noqa: ANN001
    """Signed in as the admin 'alice'."""
    add_user("alice", admin=True)
    with _client(app) as c:
        login(c, "alice")
        yield c


@pytest.fixture
def other_client(app, client) -> Iterator[TestClient]:  # noqa: ANN001
    """A second, non-admin user 'bob' (in a separate cookie jar)."""
    add_user("bob")
    with _client(app) as c:
        login(c, "bob")
        yield c


def upload(client: TestClient, path: Path, filename: str | None = None) -> dict[str, Any]:
    r = client.post(
        "/api/sources",
        params={"filename": filename or path.name},
        content=path.read_bytes(),
        headers={"Content-Type": "application/pdf"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def new_notebook(
    client: TestClient, tmp_path: Path, pages: int = 5, name: str = "Notes", parent_id=None, label: str = "p"
) -> dict[str, Any]:  # noqa: ANN001
    src = upload(client, make_pdf(tmp_path / f"{name}-{label}-{pages}.pdf", pages=pages, label=label))
    r = client.post("/api/notebooks", json={"name": name, "parent_id": parent_id, "source_id": src["id"]})
    assert r.status_code == 200, r.text
    detail = client.get(f"/api/notebooks/{r.json()['id']}").json()
    return detail
