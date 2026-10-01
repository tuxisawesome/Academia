"""Regression tests for the library tree, the Trash, item descriptions and item names."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from sqlalchemy import event

from academia.db import get_engine, write_session
from academia.models import BOOKMARK, FOLDER, NOTEBOOK, Bookmark, Node, Notebook, new_id
from academia.services.export import safe_filename
from conftest import new_notebook, page_texts


def names(client, parent=None) -> list[str]:  # noqa: ANN001
    params = {"parent": parent} if parent else {}
    return sorted(i["name"] for i in client.get("/api/nodes", params=params).json()["items"])


def owner_of(node_id: str) -> str:
    with write_session() as db:
        node = db.get(Node, node_id)
        assert node is not None
        return node.owner_id


def limit_sql_variables(limit: int) -> None:
    """From now on, let each statement bind at most ``limit`` values (999 is SQLite's
    historical default; the bundled SQLite of the deployed Python allows 32766)."""

    def on_checkout(dbapi_conn, _record, _proxy) -> None:  # noqa: ANN001
        dbapi_conn.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, limit)

    event.listen(get_engine(), "checkout", on_checkout)


def test_purging_a_folder_keeps_items_trashed_separately_from_inside_it(client, tmp_path: Path):
    a = client.post("/api/folders", json={"name": "A"}).json()
    nb = new_notebook(client, tmp_path, pages=3, name="N", parent_id=a["id"])
    sub = client.post("/api/folders", json={"name": "S", "parent_id": a["id"]}).json()
    client.post("/api/folders", json={"name": "T", "parent_id": sub["id"]})
    bm = client.post(
        "/api/bookmarks", json={"name": "B", "notebook_id": nb["id"], "page_ids": [p["id"] for p in nb["pages"][:2]]}
    ).json()
    client.post("/api/nodes/trash", json={"ids": [nb["id"]]})
    client.post("/api/nodes/trash", json={"ids": [sub["id"]]})
    client.post("/api/nodes/trash", json={"ids": [a["id"]]})
    assert sorted(t["name"] for t in client.get("/api/trash").json()) == ["A", "N", "S"]

    # Only A was chosen: N and S stay in the Trash (their folder is gone, so they now belong
    # to the Library), and the bookmark elsewhere keeps pointing at N.
    assert client.post("/api/trash/purge", json={"ids": [a["id"]]}).json() == {"purged": 1}
    trash = client.get("/api/trash").json()
    assert sorted((t["name"], t["item_count"], t["original_location"]) for t in trash) == [
        ("N", 1, "Library"),
        ("S", 2, "Library"),
    ]
    detail = client.get(f"/api/bookmarks/{bm['id']}")
    assert detail.status_code == 200 and detail.json()["available"] is False

    r = client.post("/api/trash/restore", json={"ids": [nb["id"], sub["id"]]})
    assert r.json() == {"restored": 2}
    assert names(client) == ["B", "N", "S"]
    assert names(client, sub["id"]) == ["T"]
    assert client.get(f"/api/bookmarks/{bm['id']}").json()["available"] is True
    assert page_texts(client.get(f"/api/bookmarks/{bm['id']}/pdf").content) == ["p1", "p2"]


def test_trash_check_on_a_large_folder(client):
    folder = client.post("/api/folders", json={"name": "Big"}).json()
    owner = owner_of(folder["id"])
    notebooks = [
        Node(id=new_id(), owner_id=owner, parent_id=folder["id"], kind=NOTEBOOK, name="N") for _ in range(1000)
    ]
    marks = [Node(id=new_id(), owner_id=owner, kind=BOOKMARK, name="B") for _ in range(1000)]
    with write_session() as db:
        db.add_all(notebooks + marks)
        db.flush()
        db.add_all(Notebook(node_id=n.id) for n in notebooks)
        db.flush()
        db.add_all(Bookmark(node_id=b.id, notebook_id=n.id) for b, n in zip(marks, notebooks, strict=True))

    limit_sql_variables(999)
    r = client.post("/api/nodes/trash-check", json={"ids": [folder["id"]]})
    assert r.status_code == 200 and r.json() == {"bookmarks_elsewhere": 1000}
    assert client.post("/api/nodes/trash", json={"ids": [folder["id"]]}).json() == {"trashed": 1}


def test_trashed_folder_counts_the_items_restored_with_it(client):
    a = client.post("/api/folders", json={"name": "A"}).json()
    kids = [client.post("/api/folders", json={"name": n, "parent_id": a["id"]}).json() for n in ("X", "Y", "Z")]
    client.post("/api/nodes/trash", json={"ids": [kids[2]["id"]]})
    client.post("/api/nodes/trash", json={"ids": [a["id"]]})

    # Z was trashed on its own before A, so restoring A brings back X and Y only.
    assert client.get(f"/api/nodes/{a['id']}").json()["child_count"] == 2
    trash = {t["name"]: t for t in client.get("/api/trash").json()}
    assert (trash["A"]["child_count"], trash["A"]["item_count"]) == (2, 3)
    assert trash["Z"]["child_count"] == 0

    client.post("/api/trash/restore", json={"ids": [a["id"]]})
    assert client.get(f"/api/nodes/{a['id']}").json()["child_count"] == 2


def test_names_keep_joiners_tag_characters_and_new_emoji(client):
    kept = [
        "\u06a9\u062a\u0627\u0628\u200c\u0647\u0627",  # Persian "books", spelled with a zero-width non-joiner
        "Coding \U0001f469\u200d\U0001f4bb",  # an emoji zero-width-joiner sequence
        "Trip \U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f",  # flag of England
        "Exams \U0001fae9",  # an emoji newer than the Unicode tables of Python 3.13
    ]
    for name in kept:
        r = client.post("/api/folders", json={"name": name})
        assert r.status_code == 200 and r.json()["name"] == name
        assert safe_filename(name) == name
    # Controls and other invisible format characters are still dropped.
    assert client.post("/api/folders", json={"name": "a\u202eb\u200bc\x07d\ufffe\U0010ffff"}).json()["name"] == "abcd"
    for invisible in ("\u200d", " \u200c \u200d ", "\U000e0067\U000e007f"):
        r = client.post("/api/folders", json={"name": invisible})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_name"


def test_moving_a_folder_into_a_deeply_nested_descendant_is_refused(client):
    top = client.post("/api/folders", json={"name": "L1"}).json()
    owner = owner_of(top["id"])
    chain = [top["id"]]
    with write_session() as db:
        for depth in range(2, 261):
            node = Node(id=new_id(), owner_id=owner, parent_id=chain[-1], kind=FOLDER, name=f"L{depth}")
            db.add(node)
            chain.append(node.id)

    r = client.post("/api/nodes/move", json={"ids": [top["id"]], "target_id": chain[-1]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "move_into_self"
    r = client.post("/api/nodes/copy", json={"ids": [top["id"]], "target_id": chain[-1]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "copy_into_self"
    assert names(client) == ["L1"]
    assert len(client.get("/api/tree").json()) == 260


def test_bulk_actions_on_more_than_5000_items(client):
    target = client.post("/api/folders", json={"name": "Target"}).json()
    owner = owner_of(target["id"])
    ids = [new_id() for _ in range(5001)]
    with write_session() as db:
        db.add_all(Node(id=i, owner_id=owner, kind=FOLDER, name=f"F{n}") for n, i in enumerate(ids))

    # Select all in a folder holding more than 5000 items, then Delete (or Cut and Paste).
    assert client.post("/api/nodes/trash-check", json={"ids": ids}).json() == {"bookmarks_elsewhere": 0}
    assert client.post("/api/nodes/move", json={"ids": ids, "target_id": target["id"]}).json() == {"moved": 5001}
    assert client.post("/api/nodes/trash", json={"ids": ids}).json() == {"trashed": 5001}
    assert client.post("/api/trash/purge", json={"ids": ids}).json() == {"purged": 5001}
    assert client.get("/api/trash").json() == []
