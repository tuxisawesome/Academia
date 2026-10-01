"""Classes, page tags (a date and classes) and the search filters that use them."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from alembic import command
from sqlalchemy import event, func, select, text

from academia import config
from academia.db import get_engine, init_engine, read_session, write_session
from academia.migrations import alembic_config, current_and_head, upgrade_head
from academia.models import PageClass
from academia.services.textindex import index_source
from conftest import make_text_pdf, new_notebook, upload


def make_class(client, name: str, color: str | None = None) -> dict[str, Any]:  # noqa: ANN001
    r = client.post("/api/classes", json={"name": name, "color": color})
    assert r.status_code == 200, r.text
    return r.json()


def tag(client, nb_id: str, page_ids: list[str], **body: Any):  # noqa: ANN001, ANN201
    return client.post(f"/api/notebooks/{nb_id}/pages/tags", json={"page_ids": page_ids, **body})


def tags(detail: dict[str, Any]) -> list[tuple[str | None, list[str]]]:
    return [(p["date"], p["class_ids"]) for p in detail["pages"]]


def text_notebook(client, tmp_path: Path, name: str, texts: list[str], parent_id=None) -> dict:  # noqa: ANN001
    src = upload(client, make_text_pdf(tmp_path / f"{name}.pdf", texts))
    index_source(src["id"])  # normally done in the background after upload
    nb = client.post("/api/notebooks", json={"name": name, "parent_id": parent_id, "source_id": src["id"]}).json()
    return client.get(f"/api/notebooks/{nb['id']}").json()


def search(client, q: str = "", folder: str | None = None, **params: Any) -> dict[str, Any]:  # noqa: ANN001
    r = client.get("/api/search", params={"q": q, "in": folder, **params})
    assert r.status_code == 200, r.text
    return r.json()


def matches(result: dict[str, Any]) -> list[tuple[str, list[int]]]:
    return sorted((c["name"], [m["number"] for m in c["matches"]]) for c in result["contents"])


# ---- migration ---------------------------------------------------------------------------


def test_schema_at_head_matches_the_models(data_dir):
    command.check(alembic_config())  # raises if the models need another migration
    with read_session() as db:
        cols = [r[1] for r in db.execute(text("PRAGMA table_info(pages)"))]
        assert cols[-1] == "tag_date"


def test_upgrade_from_0003_keeps_pages(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ACADEMIA_DATA_DIR", str(tmp_path / "old"))
    config.get_settings.cache_clear()
    try:
        engine = init_engine(config.get_settings().db_path)
        command.upgrade(alembic_config(), "0003")
        with engine.begin() as conn:
            for sql in [
                "INSERT INTO users (id, username, display_name, password_hash, is_admin, must_change_password,"
                " prefs, created_at) VALUES ('u1', 'carol', '', 'x', 0, 0, '{}', '2026-09-30 00:00:00')",
                "INSERT INTO sources (id, owner_id, sha256, original_filename, byte_size, page_count, created_at)"
                " VALUES ('s1', 'u1', 'aa', 'a.pdf', 1, 1, '2026-09-30 00:00:00')",
                "INSERT INTO nodes (id, owner_id, kind, name, created_at, updated_at)"
                " VALUES ('n1', 'u1', 'notebook', 'Old', '2026-09-30 00:00:00', '2026-09-30 00:00:00')",
                "INSERT INTO notebooks (node_id, rev, page_count) VALUES ('n1', 3, 1)",
                "INSERT INTO pages (id, notebook_id, position, source_id, source_index, rotation, created_at)"
                " VALUES ('p1', 'n1', 0, 's1', 0, 90, '2026-09-30 00:00:00')",
            ]:
                conn.exec_driver_sql(sql)

        upgrade_head()

        current, head = current_and_head()
        assert current == head == "0004"
        with write_session() as db:
            assert db.execute(text("SELECT id, rotation, tag_date FROM pages")).all() == [("p1", 90, None)]
            db.execute(
                text(
                    "INSERT INTO classes (id, owner_id, name, position, created_at)"
                    " VALUES ('c1', 'u1', 'Chemistry', 0, '2026-10-01 00:00:00')"
                )
            )
            db.execute(text("INSERT INTO page_classes (page_id, class_id) VALUES ('p1', 'c1')"))
            db.execute(text("UPDATE pages SET tag_date = '2026-10-01'"))

        # Downgrading drops the tags and keeps everything else.
        command.downgrade(alembic_config(), "0003")
        with read_session() as db:
            assert db.execute(text("SELECT id, rotation FROM pages")).all() == [("p1", 90)]
            names = set(db.scalars(text("SELECT name FROM sqlite_master")))
            assert not names & {"classes", "page_classes"}
            assert "ix_pages_deleted" in names
        upgrade_head()
    finally:
        config.get_settings.cache_clear()


# ---- classes -----------------------------------------------------------------------------


def test_class_crud_and_validation(client):
    assert client.get("/api/classes").json() == []
    chem = make_class(client, "  Organic‮   Chemistry ", "teal")
    assert chem == {"id": chem["id"], "name": "Organic Chemistry", "color": "teal", "position": 0, "page_count": 0}
    bio = make_class(client, "Biology")
    assert bio["color"] is None and bio["position"] == 1

    r = client.post("/api/classes", json={"name": "ORGANIC chemistry"})
    assert r.status_code == 409
    assert r.json()["error"] == {
        "code": "duplicate_class",
        "message": "You already have a class called “Organic Chemistry”.",
    }
    # Case folding beyond ASCII.
    make_class(client, "Straße")
    assert client.post("/api/classes", json={"name": "STRASSE"}).json()["error"]["code"] == "duplicate_class"
    assert client.post("/api/classes", json={"name": "   "}).status_code == 400
    assert client.post("/api/classes", json={"name": "x" * 81}).json()["error"]["code"] == "invalid_name"
    assert client.post("/api/classes", json={"name": "x" * 80}).status_code == 200
    assert client.post("/api/classes", json={"name": "Art", "color": "hotpink"}).status_code == 400

    r = client.patch(f"/api/classes/{bio['id']}", json={"name": "Biology II", "color": "olive"})
    assert r.json()["name"] == "Biology II" and r.json()["color"] == "olive"
    r = client.patch(f"/api/classes/{bio['id']}", json={"clear_color": True})
    assert r.json()["color"] is None and r.json()["name"] == "Biology II"
    # Renaming to a different case of its own name is fine; to another class's name is not.
    assert client.patch(f"/api/classes/{bio['id']}", json={"name": "biology ii"}).json()["name"] == "biology ii"
    r = client.patch(f"/api/classes/{bio['id']}", json={"name": "organic chemistry"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_class"
    assert client.patch(f"/api/classes/{bio['id']}", json={"color": "hotpink"}).status_code == 400

    assert client.delete(f"/api/classes/{bio['id']}").json() == {"ok": True}
    assert client.delete(f"/api/classes/{bio['id']}").status_code == 404
    assert client.patch(f"/api/classes/{bio['id']}", json={"name": "x"}).status_code == 404
    assert [c["name"] for c in client.get("/api/classes").json()] == ["Organic Chemistry", "Straße", "x" * 80]


def test_class_limit(client):
    with write_session() as db:
        user_id = db.scalar(text("SELECT id FROM users WHERE username = 'alice'"))
        db.execute(
            text(
                "INSERT INTO classes (id, owner_id, name, position, created_at)"
                " VALUES (:id, :uid, :name, :pos, '2026-10-01 00:00:00')"
            ),
            [{"id": f"c{i}", "uid": user_id, "name": f"Class {i}", "pos": i} for i in range(500)],
        )
    r = client.post("/api/classes", json={"name": "One more"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "too_many_classes"


def test_class_order(client):
    a, b, c = (make_class(client, n) for n in ("A", "B", "C"))
    r = client.put("/api/classes/order", json={"class_ids": [c["id"], a["id"], b["id"]]})
    assert [(x["name"], x["position"]) for x in r.json()] == [("C", 0), ("A", 1), ("B", 2)]
    assert [x["name"] for x in client.get("/api/classes").json()] == ["C", "A", "B"]
    for bad in ([a["id"], b["id"]], [a["id"], b["id"], c["id"], "nope"], [a["id"], a["id"], b["id"]]):
        r = client.put("/api/classes/order", json={"class_ids": bad})
        assert r.status_code == 400 and r.json()["error"]["code"] == "bad_order"
    # A new class goes at the end.
    assert make_class(client, "D")["position"] == 3


def test_classes_are_private(client, other_client, tmp_path: Path):
    mine = make_class(client, "Physics")
    assert other_client.get("/api/classes").json() == []
    # Each user has their own namespace.
    theirs = make_class(other_client, "Physics")
    assert other_client.patch(f"/api/classes/{mine['id']}", json={"name": "Mine"}).status_code == 404
    assert other_client.delete(f"/api/classes/{mine['id']}").status_code == 404
    r = other_client.put("/api/classes/order", json={"class_ids": [mine["id"]]})
    assert r.json()["error"]["code"] == "bad_order"

    nb = new_notebook(client, tmp_path, pages=2)
    r = tag(client, nb["id"], [nb["pages"][0]["id"]], add_classes=[theirs["id"]])
    assert r.status_code == 404
    r = tag(client, nb["id"], [nb["pages"][0]["id"]], remove_classes=[theirs["id"]])
    assert r.status_code == 404
    # Nor can anyone tag someone else's pages.
    assert tag(other_client, nb["id"], [nb["pages"][0]["id"]], date="2026-10-01").status_code == 404
    r = other_client.get("/api/search", params={"class": mine["id"]})
    assert r.status_code == 404

    # Deleting a user deletes their classes and tags.
    bob_nb = new_notebook(other_client, tmp_path, pages=1, name="Bob")
    tag(other_client, bob_nb["id"], [bob_nb["pages"][0]["id"]], add_classes=[theirs["id"]])
    bob = next(u for u in client.get("/api/admin/users").json() if u["username"] == "bob")
    assert client.delete(f"/api/admin/users/{bob['id']}").status_code == 200
    with read_session() as db:
        assert db.execute(text("SELECT id FROM classes")).scalars().all() == [mine["id"]]
        assert db.scalar(select(func.count()).select_from(PageClass)) == 0


# ---- tagging -----------------------------------------------------------------------------


def test_tag_pages(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=4)
    ids = [p["id"] for p in nb["pages"]]
    chem, bio, math = (make_class(client, n) for n in ("Chemistry", "Biology", "Math"))
    assert tags(nb) == [(None, [])] * 4

    r = tag(client, nb["id"], ids[:2], date="2026-09-14", add_classes=[bio["id"], chem["id"]])
    assert r.status_code == 200, r.text
    detail = r.json()
    # Class ids are in the user's class order.
    assert tags(detail) == [("2026-09-14", [chem["id"], bio["id"]])] * 2 + [(None, [])] * 2
    # Tags are not part of the PDF: the rev and the reader PDF stay the same.
    assert detail["rev"] == nb["rev"] and detail["pdf_digest"] == nb["pdf_digest"]
    assert client.get(f"/api/notebooks/{nb['id']}/pdf", params={"rev": nb["rev"], "d": nb["pdf_digest"]}).is_success

    # Partial updates: leaving out the date keeps each page's own; classes are added/removed.
    detail = tag(client, nb["id"], ids[1:3], add_classes=[math["id"]], remove_classes=[chem["id"]]).json()
    assert tags(detail) == [
        ("2026-09-14", [chem["id"], bio["id"]]),
        ("2026-09-14", [bio["id"], math["id"]]),
        (None, [math["id"]]),
        (None, []),
    ]
    # Adding a class a page already has is fine; null clears the date.
    detail = tag(client, nb["id"], ids, date=None, add_classes=[math["id"]]).json()
    assert [d for d, _ in tags(detail)] == [None] * 4
    assert [len(c) for _, c in tags(detail)] == [3, 2, 1, 1]
    # A new date for every page, classes untouched.
    detail = tag(client, nb["id"], ids, date="2024-02-29").json()
    assert {d for d, _ in tags(detail)} == {"2024-02-29"}
    assert [len(c) for _, c in tags(detail)] == [3, 2, 1, 1]

    # The class order follows reordering the classes.
    client.put("/api/classes/order", json={"class_ids": [math["id"], bio["id"], chem["id"]]})
    detail = client.get(f"/api/notebooks/{nb['id']}").json()
    assert detail["pages"][0]["class_ids"] == [math["id"], bio["id"], chem["id"]]
    counts = {c["name"]: c["page_count"] for c in client.get("/api/classes").json()}
    assert counts == {"Chemistry": 1, "Biology": 2, "Math": 4}
    assert detail["rev"] == nb["rev"]


def test_tag_validation(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=2)
    other = new_notebook(client, tmp_path, pages=1, name="Other", label="o")
    ids = [p["id"] for p in nb["pages"]]
    for bad in ("2026-02-30", "2026-13-01", "26-10-01", "2026-1-1", "1899-12-31", "2201-01-01", "today", ""):
        r = tag(client, nb["id"], ids, date=bad)
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_date", bad
    assert tag(client, nb["id"], ids, date="1900-01-01").status_code == 200
    assert tag(client, nb["id"], ids, date="2200-12-31").status_code == 200
    assert tag(client, nb["id"], []).status_code == 422
    assert tag(client, nb["id"], ["x"] * 5001).json()["error"]["code"] == "too_many_items"
    assert tag(client, nb["id"], ids, add_classes=["nope"]).status_code == 404

    # Pages of another notebook, unknown or deleted pages: the selection is stale.
    r = tag(client, nb["id"], [ids[0], other["pages"][0]["id"]], date="2026-10-01")
    assert r.status_code == 409 and r.json()["error"]["code"] == "stale_pages"
    deleted = client.post(f"/api/notebooks/{nb['id']}/pages/delete", json={"page_ids": [ids[1]]}).json()
    r = tag(client, nb["id"], [ids[1]], date="2026-10-01")
    assert r.status_code == 409 and r.json()["error"]["code"] == "stale_pages"
    # Nothing was changed by the failed requests.
    assert tags(deleted) == [("2200-12-31", [])]

    # Notebooks in the Trash can't be tagged.
    client.post("/api/nodes/trash", json={"ids": [nb["id"]]})
    r = tag(client, nb["id"], [ids[0]], date="2026-10-01")
    assert r.status_code == 409 and r.json()["error"]["code"] == "trashed"
    assert tag(client, "nope", [ids[0]], date="2026-10-01").status_code == 404


def test_tags_in_details_covers_and_bookmarks(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=3)
    ids = [p["id"] for p in nb["pages"]]
    chem = make_class(client, "Chemistry")
    bm = client.post("/api/bookmarks", json={"name": "Ch 1", "notebook_id": nb["id"], "page_ids": ids[1:]}).json()
    assert bm["cover"]["class_ids"] == [] and bm["cover"]["date"] is None
    tag(client, nb["id"], ids[:2], date="2026-09-01", add_classes=[chem["id"]])

    detail = client.get(f"/api/bookmarks/{bm['id']}").json()
    assert [(p["number"], p["date"], p["class_ids"]) for p in detail["pages"]] == [
        (2, "2026-09-01", [chem["id"]]),
        (3, None, []),
    ]
    items = {i["name"]: i for i in client.get("/api/nodes").json()["items"]}
    assert items["Notes"]["cover"]["date"] == "2026-09-01"
    assert items["Notes"]["cover"]["class_ids"] == [chem["id"]]
    assert items["Ch 1"]["cover"]["class_ids"] == [chem["id"]]

    # Tagging through a bookmark is tagging its pages in their notebook; the bookmark is unchanged.
    nb_detail = tag(client, nb["id"], detail["page_ids"], date="2026-09-02").json()
    assert [p["date"] for p in nb_detail["pages"]] == ["2026-09-01", "2026-09-02", "2026-09-02"]
    after = client.get(f"/api/bookmarks/{bm['id']}").json()
    assert after["rev"] == detail["rev"] and after["pdf_digest"] == detail["pdf_digest"]
    assert [p["date"] for p in after["pages"]] == ["2026-09-02", "2026-09-02"]


def test_tags_load_in_one_query_per_response(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=6)
    ids = [p["id"] for p in nb["pages"]]
    chem, bio = make_class(client, "Chemistry"), make_class(client, "Biology")
    tag(client, nb["id"], ids, date="2026-09-01", add_classes=[chem["id"], bio["id"]])
    bm = client.post("/api/bookmarks", json={"name": "Ch 1", "notebook_id": nb["id"], "page_ids": ids[1:]}).json()

    statements: list[str] = []

    def record(conn, cursor, statement, *args) -> None:  # noqa: ANN001
        statements.append(statement)

    event.listen(get_engine(), "before_cursor_execute", record)
    try:
        for url in (f"/api/notebooks/{nb['id']}", f"/api/bookmarks/{bm['id']}", "/api/nodes"):
            statements.clear()
            assert client.get(url).is_success
            assert sum("page_classes" in s for s in statements) == 1, url
    finally:
        event.remove(get_engine(), "before_cursor_execute", record)


def test_copy_keeps_tags(client, tmp_path: Path):
    folder = client.post("/api/folders", json={"name": "Course"}).json()
    nb = new_notebook(client, tmp_path, pages=3, parent_id=folder["id"])
    ids = [p["id"] for p in nb["pages"]]
    chem, bio = make_class(client, "Chemistry"), make_class(client, "Biology")
    tag(client, nb["id"], ids[:2], date="2026-09-01", add_classes=[chem["id"], bio["id"]])
    tag(client, nb["id"], [ids[2]], add_classes=[bio["id"]])
    original = client.get(f"/api/notebooks/{nb['id']}").json()

    new_id = client.post("/api/nodes/copy", json={"ids": [folder["id"]], "target_id": None}).json()["ids"][0]
    copy_nb = client.get("/api/nodes", params={"parent": new_id}).json()["items"][0]
    copy = client.get(f"/api/notebooks/{copy_nb['id']}").json()
    assert {p["id"] for p in copy["pages"]}.isdisjoint(ids)
    assert tags(copy) == tags(original)
    assert {c["name"]: c["page_count"] for c in client.get("/api/classes").json()} == {"Chemistry": 4, "Biology": 6}

    # The copies are tagged independently.
    tag(client, copy["id"], [copy["pages"][0]["id"]], date=None, remove_classes=[chem["id"]])
    assert tags(client.get(f"/api/notebooks/{nb['id']}").json()) == tags(original)


def test_deleted_pages_keep_tags_and_class_delete_removes_them(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=3)
    ids = [p["id"] for p in nb["pages"]]
    chem, bio = make_class(client, "Chemistry"), make_class(client, "Biology")
    tag(client, nb["id"], ids, date="2026-09-01", add_classes=[chem["id"], bio["id"]])

    deleted = client.post(f"/api/notebooks/{nb['id']}/pages/delete", json={"page_ids": ids[:2]}).json()
    assert {c["name"]: c["page_count"] for c in client.get("/api/classes").json()} == {"Chemistry": 1, "Biology": 1}
    restored = client.post(f"/api/notebooks/{nb['id']}/pages/undelete", json={"batch": deleted["deleted_batch"]})
    assert tags(restored.json()) == [("2026-09-01", [chem["id"], bio["id"]])] * 3

    # Pages of a notebook in the Trash are not counted, and come back tagged.
    client.post("/api/nodes/trash", json={"ids": [nb["id"]]})
    assert {c["page_count"] for c in client.get("/api/classes").json()} == {0}
    client.post("/api/trash/restore", json={"ids": [nb["id"]]})
    assert {c["page_count"] for c in client.get("/api/classes").json()} == {3}

    client.delete(f"/api/classes/{chem['id']}")
    detail = client.get(f"/api/notebooks/{nb['id']}").json()
    assert tags(detail) == [("2026-09-01", [bio["id"]])] * 3

    # Purging the notebook removes its tags.
    client.post("/api/nodes/trash", json={"ids": [nb["id"]]})
    client.post("/api/trash/empty")
    with read_session() as db:
        assert db.scalar(select(func.count()).select_from(PageClass)) == 0
    assert client.get("/api/classes").json()[0]["page_count"] == 0


# ---- search filters ------------------------------------------------------------------------


def test_search_by_class_and_date(client, tmp_path: Path):
    chem_dir = client.post("/api/folders", json={"name": "Chemistry"}).json()
    lab = text_notebook(client, tmp_path, "Lab", ["entropy", "kinetics", "entropy again", "titration"], chem_dir["id"])
    notes = text_notebook(client, tmp_path, "Notes", ["entropy", "cells"])
    chem, bio, math = (make_class(client, n) for n in ("Chemistry", "Biology", "Math"))
    lab_ids = [p["id"] for p in lab["pages"]]
    tag(client, lab["id"], lab_ids[:2], date="2026-09-01", add_classes=[chem["id"]])
    tag(client, lab["id"], lab_ids[2:], date="2026-09-08", add_classes=[bio["id"]])
    tag(client, notes["id"], [notes["pages"][0]["id"]], add_classes=[chem["id"]])
    tag(client, notes["id"], [notes["pages"][1]["id"]], date="2026-09-05")
    bm = client.post(
        "/api/bookmarks", json={"name": "Entropy pages", "notebook_id": lab["id"], "page_ids": [lab_ids[2]]}
    ).json()

    # No filters: unchanged, plus the (empty) filters.
    plain = search(client, "entropy")
    assert plain["filters"] == {"classes": [], "from": None, "to": None}
    assert matches(plain) == [("Entropy pages", [3]), ("Lab", [1, 3]), ("Notes", [1])]
    assert search(client)["contents"] == [] and search(client)["files"] == []

    # Any of the classes, with an empty query: every tagged page, with its tags.
    result = search(client, **{"class": [chem["id"]]})
    assert result["filters"] == {"classes": [chem["id"]], "from": None, "to": None}
    assert matches(result) == [("Lab", [1, 2]), ("Notes", [1])]
    lab_hit = next(c for c in result["contents"] if c["name"] == "Lab")
    assert lab_hit["matches"][0]["class_ids"] == [chem["id"]] and lab_hit["matches"][0]["date"] == "2026-09-01"
    assert lab_hit["match_count"] == 2 and lab_hit["matches"][1]["open_page"] == 2
    result = search(client, **{"class": [chem["id"], bio["id"]]})
    assert matches(result) == [("Entropy pages", [3]), ("Lab", [1, 2, 3, 4]), ("Notes", [1])]
    assert next(c for c in result["contents"] if c["name"] == "Entropy pages")["matches"][0]["open_page"] == 1
    assert search(client, **{"class": [math["id"]]})["contents"] == []

    # Files: notebooks and bookmarks with a matching page (and whose name matches q); no folders.
    assert sorted(f["name"] for f in result["files"]) == ["Entropy pages", "Lab", "Notes"]
    assert [f["name"] for f in search(client, "lab", **{"class": [bio["id"]]})["files"]] == ["Lab"]
    assert search(client, "chemistry", **{"class": [chem["id"]]})["files"] == []
    assert [f["name"] for f in search(client, "chemistry")["files"]] == ["Chemistry"]

    # With a query: pages that match both.
    assert matches(search(client, "entropy", **{"class": [chem["id"]]})) == [("Lab", [1]), ("Notes", [1])]
    assert matches(search(client, "kinetics", **{"class": [bio["id"]]})) == []

    # Date ranges are inclusive; pages without a date never match.
    assert matches(search(client, **{"from": "2026-09-05"})) == [
        ("Entropy pages", [3]),
        ("Lab", [3, 4]),
        ("Notes", [2]),
    ]
    assert matches(search(client, to="2026-09-05")) == [("Lab", [1, 2]), ("Notes", [2])]
    result = search(client, **{"from": "2026-09-01", "to": "2026-09-01"})
    assert result["filters"] == {"classes": [], "from": "2026-09-01", "to": "2026-09-01"}
    assert matches(result) == [("Lab", [1, 2])]
    assert matches(search(client, "entropy", **{"from": "2026-01-01"})) == [("Entropy pages", [3]), ("Lab", [1, 3])]
    assert matches(search(client, **{"class": [chem["id"]], "from": "2026-01-01"})) == [("Lab", [1, 2])]
    assert matches(search(client, **{"from": "2026-10-01", "to": "2026-09-01"})) == []

    # Scope: the folder and everything below it.
    assert matches(search(client, folder=chem_dir["id"], **{"class": [chem["id"]]})) == [("Lab", [1, 2])]

    # Trashed items never appear, nor do bookmarks into a trashed notebook.
    client.post("/api/nodes/trash", json={"ids": [lab["id"]]})
    result = search(client, **{"class": [chem["id"], bio["id"]]})
    assert matches(result) == [("Notes", [1])]
    assert [f["name"] for f in result["files"]] == ["Notes"]
    assert bm["id"] not in {f["id"] for f in result["files"]}


def test_search_filter_validation(client, other_client, tmp_path: Path):
    chem = make_class(client, "Chemistry")
    for bad in ({"from": "2026-02-30"}, {"to": "yesterday"}, {"from": "3000-01-01"}):
        r = client.get("/api/search", params=bad)
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_date"
    assert client.get("/api/search", params={"class": "nope"}).status_code == 404
    assert other_client.get("/api/search", params={"class": chem["id"]}).status_code == 404
    assert other_client.get("/api/search", params={"q": "x", "class": chem["id"]}).status_code == 404
    # Repeated ids count once.
    assert search(client, **{"class": [chem["id"], chem["id"]]})["filters"]["classes"] == [chem["id"]]


def test_search_filters_respect_limits(client, tmp_path: Path, monkeypatch):
    from academia.services import search as search_service

    monkeypatch.setattr(search_service, "MAX_PAGES_PER_RESULT", 2)
    nb = new_notebook(client, tmp_path, pages=5)
    chem = make_class(client, "Chemistry")
    tag(client, nb["id"], [p["id"] for p in nb["pages"]], add_classes=[chem["id"]])
    hit = search(client, **{"class": [chem["id"]]})["contents"][0]
    assert hit["match_count"] == 5 and [m["number"] for m in hit["matches"]] == [1, 2]
