"""Regression tests for the search text pipeline and the page-text migration (group BE-6)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pikepdf
import pytest
from alembic import command
from pikepdf import Dictionary, Name
from sqlalchemy import text

from academia import config
from academia.db import init_engine, read_session, write_session
from academia.migrations import alembic_config, current_and_head, upgrade_head
from academia.models import Source
from academia.services import textindex
from academia.services.textindex import index_source, sources_needing_text
from academia.services.users import create_user
from conftest import page_texts, upload


def winansi_pdf(path: Path, texts: list[str]) -> Path:
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
    )
    for t in texts:
        pdf.add_blank_page(page_size=(400, 400))
        page = pdf.pages[-1]
        page.obj.Resources = Dictionary(Font=Dictionary(F1=font))
        page.obj.Contents = pdf.make_stream(b"BT /F1 12 Tf 20 200 Td (" + t.encode("cp1252") + b") Tj ET")
    pdf.save(path)
    return path


def contents(client, q: str) -> list[str]:  # noqa: ANN001
    r = client.get("/api/search", params={"q": q})
    assert r.status_code == 200, r.text
    return [c["name"] for c in r.json()["contents"]]


def text_layer_notebook(client, tmp_path: Path, monkeypatch, name: str, texts: list[str]) -> dict:  # noqa: ANN001
    """A notebook whose pages' text layers read ``texts`` (extraction is stubbed: any script)."""
    src = upload(client, winansi_pdf(tmp_path / f"{name}.pdf", [f"{name} {i}" for i in range(len(texts))]))
    with monkeypatch.context() as m:
        stub = SimpleNamespace(run=lambda _fn, _path, chunk, timeout: {i: texts[i] for i in chunk})
        m.setattr(textindex, "pool", stub)
        index_source(src["id"])
    return client.post("/api/notebooks", json={"name": name, "source_id": src["id"]}).json()


# ---- the query is folded exactly like the indexed text ---------------------------------


def test_sharp_s_found_end_to_end(client, tmp_path: Path):
    path = winansi_pdf(tmp_path / "de.pdf", ["Die Größe der Straße", "Café"])
    assert page_texts(path)[0] == "Die Größe der Straße"
    src = upload(client, path)
    index_source(src["id"])
    client.post("/api/notebooks", json={"name": "Physik", "source_id": src["id"]})
    assert contents(client, "der") == ["Physik"]
    assert contents(client, "Größe") == ["Physik"]
    assert contents(client, "straße") == ["Physik"]
    assert contents(client, "Strasse") == []  # exact words only, no spelling variants
    assert contents(client, "cafe") == ["Physik"]  # Latin accents are still folded


@pytest.mark.parametrize(
    ("word", "query"),
    [
        ("Новый", "Новый"),
        ("ёлка", "ЁЛКА"),
        ("Київ", "Київ"),
        ("Φυσική", "Φυσική"),
        ("λόγος", "ΛΌΓΟΣ"),
        ("한국어", "한국어"),
        ("がくせい", "がくせい"),
        ("ガイド", "ガイド"),
        ("x²", "x²"),
        ("ﬁnd", "find"),
        ("Ｆｕｌｌ", "full"),
    ],
)
def test_exact_word_from_text_layer_is_found(client, tmp_path: Path, monkeypatch, word: str, query: str):
    text_layer_notebook(client, tmp_path, monkeypatch, "Doc", [f"Text {word} hier"])
    assert contents(client, "hier") == ["Doc"]
    assert contents(client, query) == ["Doc"], word


# ---- words inside unspaced Chinese / Japanese / Thai text ---------------------------


def test_words_inside_unspaced_scripts(client, tmp_path: Path, monkeypatch):
    text_layer_notebook(client, tmp_path, monkeypatch, "Lecture", ["我们今天学习数学和物理", "Unicode文字コード"])
    text_layer_notebook(client, tmp_path, monkeypatch, "Tokyo", ["東京大学の講義ノート"])
    text_layer_notebook(client, tmp_path, monkeypatch, "Thai", ["ภาษาไทยง่ายมาก"])
    assert contents(client, "数学") == ["Lecture"]
    assert contents(client, "物理") == ["Lecture"]
    assert contents(client, "学习数学") == ["Lecture"]
    assert contents(client, "数理") == []  # the characters must be adjacent, in order
    assert contents(client, '"今天 学习"') == ["Lecture"]
    assert contents(client, "文字") == ["Lecture"]
    assert contents(client, "コード") == ["Lecture"]
    assert contents(client, "学") == ["Lecture", "Tokyo"]
    assert contents(client, "講義") == ["Tokyo"]
    assert contents(client, "ไทย") == ["Thai"]
    assert contents(client, "ง่าย") == ["Thai"]
    assert contents(client, "unicode") == ["Lecture"]


# ---- text that is only in the Trash is not found ----------------------------------------


def test_bookmark_of_trashed_notebook_not_in_contents(client, tmp_path: Path, monkeypatch):
    nb = text_layer_notebook(client, tmp_path, monkeypatch, "Thermo", ["Carnot cycle", "Second law"])
    pages = client.get(f"/api/notebooks/{nb['id']}").json()["pages"]
    client.post("/api/bookmarks", json={"name": "Mark", "notebook_id": nb["id"], "page_ids": [pages[0]["id"]]})
    assert sorted(contents(client, "carnot")) == ["Mark", "Thermo"]
    client.post("/api/nodes/trash", json={"ids": [nb["id"]]})
    assert contents(client, "carnot") == []
    client.post("/api/trash/restore", json={"ids": [nb["id"]]})
    assert sorted(contents(client, "carnot")) == ["Mark", "Thermo"]


# ---- databases migrated by the earlier (OCR) revision 0002 are repaired --------------

OCR_ERA_0002 = [
    """
    CREATE TABLE page_texts (
        id INTEGER NOT NULL, source_id VARCHAR(36) NOT NULL, idx INTEGER NOT NULL,
        embedded_text TEXT NOT NULL, embedded_done BOOLEAN NOT NULL, ocr_text TEXT NOT NULL,
        ocr_engine VARCHAR(64), ocr_rank INTEGER, ocr_failed_rank INTEGER, ocr_attempts INTEGER NOT NULL,
        lease_owner VARCHAR(64), lease_until DATETIME, updated_at DATETIME NOT NULL,
        CONSTRAINT pk_page_texts PRIMARY KEY (id),
        CONSTRAINT fk_page_texts_source_id_sources FOREIGN KEY(source_id) REFERENCES sources (id) ON DELETE CASCADE,
        CONSTRAINT uq_page_texts_source_id_idx UNIQUE (source_id, idx)
    )
    """,
    """
    CREATE TABLE pins (
        user_id VARCHAR(36) NOT NULL, node_id VARCHAR(36) NOT NULL, position INTEGER NOT NULL,
        created_at DATETIME NOT NULL,
        CONSTRAINT pk_pins PRIMARY KEY (user_id, node_id),
        CONSTRAINT fk_pins_node_id_nodes FOREIGN KEY(node_id) REFERENCES nodes (id) ON DELETE CASCADE,
        CONSTRAINT fk_pins_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
    )
    """,
    "CREATE VIRTUAL TABLE page_text_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')",
    "CREATE VIRTUAL TABLE page_text_vocab USING fts5vocab(page_text_fts, 'row')",
    """
    CREATE TRIGGER page_texts_ai AFTER INSERT ON page_texts BEGIN
        INSERT INTO page_text_fts(rowid, body) VALUES (new.id, new.embedded_text || ' ' || new.ocr_text);
    END
    """,
    """
    CREATE TRIGGER page_texts_ad AFTER DELETE ON page_texts BEGIN
        DELETE FROM page_text_fts WHERE rowid = old.id;
    END
    """,
    """
    CREATE TRIGGER page_texts_au AFTER UPDATE OF embedded_text, ocr_text ON page_texts BEGIN
        DELETE FROM page_text_fts WHERE rowid = old.id;
        INSERT INTO page_text_fts(rowid, body) VALUES (new.id, new.embedded_text || ' ' || new.ocr_text);
    END
    """,
]


def test_ocr_era_database_is_upgraded(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ACADEMIA_DATA_DIR", str(tmp_path / "old"))
    config.get_settings.cache_clear()
    try:
        engine = init_engine(config.get_settings().db_path)
        command.upgrade(alembic_config(), "0001")
        with engine.begin() as conn:
            for ddl in OCR_ERA_0002:
                conn.exec_driver_sql(ddl)
            conn.exec_driver_sql("UPDATE alembic_version SET version_num = '0002'")
        with write_session() as db:
            user, _ = create_user(db, "carol", password="correct horse battery")
            db.add(Source(id="s1", owner_id=user.id, sha256="0" * 64, byte_size=1, page_count=1))
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO page_texts (source_id, idx, embedded_text, embedded_done, ocr_text, ocr_attempts,"
                " updated_at) VALUES ('s1', 0, '', 1, 'eigenvalue', 1, '2026-09-30 00:00:00')"
            )

        upgrade_head()

        current, head = current_and_head()
        assert current == head
        with read_session() as db:
            cols = [r[1] for r in db.execute(text("PRAGMA table_info(page_texts)"))]
            assert cols == ["id", "source_id", "idx", "body", "updated_at"]
            names = set(db.scalars(text("SELECT name FROM sqlite_master")))
            assert "page_text_vocab" not in names
            assert {"page_texts_ai", "page_texts_ad", "page_texts_au"} <= names
            # Recognised handwriting is gone; the source's text layer is read again.
            hits = db.execute(text("SELECT rowid FROM page_text_fts WHERE page_text_fts MATCH 'eigenvalue'")).all()
            assert hits == []
        assert sources_needing_text() == ["s1"]
        with write_session() as db:
            db.execute(text("INSERT INTO page_texts (source_id, idx, body, updated_at) VALUES ('s1', 0, 'x', 0)"))
        with read_session() as db:
            assert db.execute(text("SELECT rowid FROM page_text_fts WHERE page_text_fts MATCH 'x'")).all()
    finally:
        config.get_settings.cache_clear()
