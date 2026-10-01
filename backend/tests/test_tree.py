from __future__ import annotations

from pathlib import Path

from conftest import new_notebook, page_texts


def names(client, parent=None) -> list[str]:  # noqa: ANN001
    params = {"parent": parent} if parent else {}
    return sorted(i["name"] for i in client.get("/api/nodes", params=params).json()["items"])


def test_folders_and_listing(client, tmp_path: Path):
    a = client.post("/api/folders", json={"name": "  Physics   101 ", "color": "navy"}).json()
    assert a["name"] == "Physics 101" and a["color"] == "navy"
    b = client.post("/api/folders", json={"name": "Week 1", "parent_id": a["id"]}).json()
    nb = new_notebook(client, tmp_path, pages=2, parent_id=b["id"])
    listing = client.get("/api/nodes", params={"parent": b["id"]}).json()
    assert [p["name"] for p in listing["path"]] == ["Physics 101", "Week 1"]
    item = listing["items"][0]
    assert item["kind"] == "notebook" and item["page_count"] == 2
    assert item["cover"]["index"] == 0
    root = client.get("/api/nodes").json()
    assert root["folder"] is None
    assert root["items"][0]["child_count"] == 1
    tree = client.get("/api/tree").json()
    assert {f["name"] for f in tree} == {"Physics 101", "Week 1"}
    detail = client.get(f"/api/nodes/{nb['id']}").json()
    assert [p["name"] for p in detail["path"]] == ["Physics 101", "Week 1", "Notes"]

    assert client.post("/api/folders", json={"name": "   "}).status_code == 400
    assert client.post("/api/folders", json={"name": "x", "color": "hotpink"}).status_code == 400


def test_rename_and_color(client, tmp_path: Path):
    f = client.post("/api/folders", json={"name": "A"}).json()
    r = client.patch(f"/api/nodes/{f['id']}", json={"name": "B", "color": "olive"})
    assert r.json()["name"] == "B" and r.json()["color"] == "olive"
    r = client.patch(f"/api/nodes/{f['id']}", json={"clear_color": True})
    assert r.json()["color"] is None
    nb = new_notebook(client, tmp_path, pages=1)
    assert client.patch(f"/api/nodes/{nb['id']}", json={"color": "olive"}).status_code == 400


def test_move_rules(client):
    a = client.post("/api/folders", json={"name": "A"}).json()
    b = client.post("/api/folders", json={"name": "B", "parent_id": a["id"]}).json()
    c = client.post("/api/folders", json={"name": "C", "parent_id": b["id"]}).json()
    r = client.post("/api/nodes/move", json={"ids": [a["id"]], "target_id": c["id"]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "move_into_self"
    r = client.post("/api/nodes/move", json={"ids": [a["id"]], "target_id": a["id"]})
    assert r.status_code == 400
    r = client.post("/api/nodes/move", json={"ids": [c["id"], b["id"]], "target_id": None})
    assert r.json()["moved"] == 1  # c travels with b
    assert names(client) == ["A", "B"]
    assert names(client, b["id"]) == ["C"]


def test_copy_repoints_bookmarks(client, tmp_path: Path):
    folder = client.post("/api/folders", json={"name": "Course"}).json()
    nb = new_notebook(client, tmp_path, pages=4, parent_id=folder["id"])
    ids = [p["id"] for p in nb["pages"]]
    inside = client.post(
        "/api/bookmarks", json={"name": "In", "notebook_id": nb["id"], "parent_id": folder["id"], "page_ids": ids[1:3]}
    ).json()
    outside = client.post("/api/bookmarks", json={"name": "Out", "notebook_id": nb["id"], "page_ids": [ids[0]]}).json()

    r = client.post("/api/nodes/copy", json={"ids": [folder["id"]], "target_id": None})
    assert r.status_code == 200
    new_folder = r.json()["ids"][0]
    items = {i["name"]: i for i in client.get("/api/nodes", params={"parent": new_folder}).json()["items"]}
    assert set(items) == {"Notes", "In"}
    assert client.get("/api/nodes").json()["items"][0]["name"] in {"Course", "Course (copy)"}
    new_bm = client.get(f"/api/bookmarks/{items['In']['id']}").json()
    assert new_bm["notebook"]["id"] == items["Notes"]["id"] != nb["id"]
    assert new_bm["segments"] == [[2, 3]]

    # Copying a bookmark alone keeps pointing at the original notebook.
    r = client.post("/api/nodes/copy", json={"ids": [outside["id"]], "target_id": folder["id"]})
    alone = client.get(f"/api/bookmarks/{r.json()['ids'][0]}").json()
    assert alone["notebook"]["id"] == nb["id"]

    # The copied notebook's pages are independent.
    copy_nb = client.get(f"/api/notebooks/{items['Notes']['id']}").json()
    client.post(
        f"/api/notebooks/{copy_nb['id']}/pages/delete",
        json={"base_rev": copy_nb["rev"], "page_ids": [copy_nb["pages"][0]["id"]]},
    )
    assert client.get(f"/api/notebooks/{nb['id']}").json()["page_count"] == 4
    assert client.get(f"/api/bookmarks/{inside['id']}").json()["segments"] == [[2, 3]]

    r = client.post("/api/nodes/copy", json={"ids": [folder["id"]], "target_id": folder["id"]})
    assert r.status_code == 400


def test_search_names(client, tmp_path: Path):
    f = client.post("/api/folders", json={"name": "Maths"}).json()
    new_notebook(client, tmp_path, pages=1, name="Linear Algebra", parent_id=f["id"])
    new_notebook(client, tmp_path, pages=1, name="100% done_ok", label="q")
    files = client.get("/api/search", params={"q": "algebra"}).json()["files"]
    assert [(r["name"], r["location"]) for r in files] == [("Linear Algebra", "Maths")]
    assert [r["name"] for r in client.get("/api/search", params={"q": "100%"}).json()["files"]] == ["100% done_ok"]
    assert client.get("/api/search", params={"q": "_"}).json()["files"][0]["name"] == "100% done_ok"


def test_trash_restore_purge(client, tmp_path: Path, data_dir: Path):
    folder = client.post("/api/folders", json={"name": "Old"}).json()
    sub = client.post("/api/folders", json={"name": "Sub", "parent_id": folder["id"]}).json()
    nb = new_notebook(client, tmp_path, pages=3, parent_id=sub["id"])
    bm = client.post(
        "/api/bookmarks", json={"name": "Elsewhere", "notebook_id": nb["id"], "page_ids": [nb["pages"][0]["id"]]}
    ).json()

    check = client.post("/api/nodes/trash-check", json={"ids": [folder["id"]]}).json()
    assert check == {"bookmarks_elsewhere": 1}
    assert client.post("/api/nodes/trash", json={"ids": [folder["id"], sub["id"]]}).json() == {"trashed": 1}
    assert names(client) == ["Elsewhere"]
    trash = client.get("/api/trash").json()
    assert [(t["name"], t["item_count"], t["original_location"]) for t in trash] == [("Old", 3, "Library")]
    items = {i["name"]: i for i in client.get("/api/nodes").json()["items"]}
    assert items["Elsewhere"]["available"] is False
    assert client.get(f"/api/notebooks/{nb['id']}/pdf").status_code == 404
    assert client.get(f"/api/nodes?parent={sub['id']}").status_code == 404

    client.post("/api/trash/restore", json={"ids": [folder["id"]]})
    assert names(client) == ["Elsewhere", "Old"]
    items = {i["name"]: i for i in client.get("/api/nodes").json()["items"]}
    assert items["Elsewhere"]["available"] is True
    assert page_texts(client.get(f"/api/bookmarks/{bm['id']}/pdf").content) == ["p1"]

    client.post("/api/nodes/trash", json={"ids": [folder["id"]]})
    assert client.post("/api/trash/purge", json={"ids": [folder["id"]]}).json() == {"purged": 1}
    assert client.get("/api/trash").json() == []
    # The bookmark elsewhere pointed at the purged notebook, so it's gone too.
    assert names(client) == []
    # The source file is only marked orphaned; maintenance deletes it later.
    assert len(list((data_dir / "sources").rglob("*.pdf"))) == 1


def test_restore_when_parent_gone(client):
    a = client.post("/api/folders", json={"name": "A"}).json()
    b = client.post("/api/folders", json={"name": "B", "parent_id": a["id"]}).json()
    client.post("/api/nodes/trash", json={"ids": [b["id"]]})
    client.post("/api/nodes/trash", json={"ids": [a["id"]]})
    client.post("/api/trash/restore", json={"ids": [b["id"]]})
    assert names(client) == ["B"]
    client.post("/api/trash/empty")
    assert client.get("/api/trash").json() == []


def test_all_notebooks(client, tmp_path: Path):
    f = client.post("/api/folders", json={"name": "Maths"}).json()
    new_notebook(client, tmp_path, pages=1, name="B", parent_id=f["id"])
    new_notebook(client, tmp_path, pages=2, name="a", label="q")
    items = client.get("/api/notebooks").json()
    assert [(i["name"], i["location"], i["page_count"]) for i in items] == [("a", "", 2), ("B", "Maths", 1)]
