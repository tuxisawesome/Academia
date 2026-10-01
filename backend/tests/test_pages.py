from __future__ import annotations

from pathlib import Path

from conftest import make_pdf, new_notebook, page_texts, upload


def texts(client, nb_id: str) -> list[str]:
    r = client.get(f"/api/notebooks/{nb_id}/pdf")
    assert r.status_code == 200, r.text
    return page_texts(r.content)


def test_create_and_upload(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=4)
    assert nb["page_count"] == 4
    assert [p["index"] for p in nb["pages"]] == [0, 1, 2, 3]
    assert nb["pages"][0]["width"] == 300 and nb["pages"][0]["height"] == 400
    assert texts(client, nb["id"]) == ["p1", "p2", "p3", "p4"]


def test_upload_dedupes_same_file(client, tmp_path: Path):
    path = make_pdf(tmp_path / "a.pdf", pages=2)
    a = upload(client, path)
    b = upload(client, path)
    assert a["id"] == b["id"]


def test_upload_rejections(client, tmp_path: Path):
    r = client.post("/api/sources", content=b"hello world", headers={"Content-Type": "application/pdf"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "not_pdf"
    r = client.post("/api/sources", content=b"", headers={"Content-Type": "application/pdf"})
    assert r.status_code == 400
    broken = b"%PDF-1.7\n" + b"garbage " * 50
    r = client.post("/api/sources", content=broken, headers={"Content-Type": "application/pdf"})
    assert r.status_code == 422
    locked = make_pdf(tmp_path / "locked.pdf", user_password="secret", owner_password="owner")
    r = client.post("/api/sources", content=locked.read_bytes(), headers={"Content-Type": "application/pdf"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "encrypted"


def test_owner_password_only_is_accepted(client, tmp_path: Path):
    path = make_pdf(tmp_path / "owner.pdf", pages=2, owner_password="owner")
    src = upload(client, path)
    assert src["page_count"] == 2


def test_insert_positions(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=3)
    extra = upload(client, make_pdf(tmp_path / "x.pdf", pages=2, label="x"))
    first = nb["pages"][0]["id"]

    r = client.post(
        f"/api/notebooks/{nb['id']}/pages/insert",
        json={"base_rev": nb["rev"], "source_id": extra["id"], "at": "after", "after_page_id": first},
    )
    assert r.status_code == 200, r.text
    nb = r.json()
    assert texts(client, nb["id"]) == ["p1", "x1", "x2", "p2", "p3"]
    assert len(nb["inserted_page_ids"]) == 2

    r = client.post(
        f"/api/notebooks/{nb['id']}/pages/insert", json={"base_rev": nb["rev"], "source_id": extra["id"], "at": "start"}
    )
    nb = r.json()
    assert texts(client, nb["id"]) == ["x1", "x2", "p1", "x1", "x2", "p2", "p3"]

    r = client.post(
        f"/api/notebooks/{nb['id']}/pages/insert", json={"base_rev": nb["rev"], "source_id": extra["id"], "at": "end"}
    )
    nb = r.json()
    assert texts(client, nb["id"])[-2:] == ["x1", "x2"]
    assert nb["page_count"] == 9


def test_stale_rev_conflict(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=3)
    ids = [p["id"] for p in nb["pages"]]
    r = client.put(f"/api/notebooks/{nb['id']}/pages/order", json={"base_rev": nb["rev"], "page_ids": ids[::-1]})
    assert r.status_code == 200
    r = client.put(f"/api/notebooks/{nb['id']}/pages/order", json={"base_rev": nb["rev"], "page_ids": ids})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "stale_rev"
    r = client.get(f"/api/notebooks/{nb['id']}/pdf", params={"rev": nb["rev"]})
    assert r.status_code == 409


def test_reorder_rotate_delete_undo(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=5)
    ids = [p["id"] for p in nb["pages"]]
    order = [ids[4], ids[0], ids[1], ids[2], ids[3]]
    nb = client.put(f"/api/notebooks/{nb['id']}/pages/order", json={"base_rev": nb["rev"], "page_ids": order}).json()
    assert texts(client, nb["id"]) == ["p5", "p1", "p2", "p3", "p4"]

    r = client.put(f"/api/notebooks/{nb['id']}/pages/order", json={"base_rev": nb["rev"], "page_ids": order[:4]})
    assert r.status_code == 409

    nb = client.post(
        f"/api/notebooks/{nb['id']}/pages/rotate", json={"base_rev": nb["rev"], "page_ids": [ids[0]], "delta": 90}
    ).json()
    assert next(p for p in nb["pages"] if p["id"] == ids[0])["rotation"] == 90
    nb = client.post(
        f"/api/notebooks/{nb['id']}/pages/rotate", json={"base_rev": nb["rev"], "page_ids": [ids[0]], "delta": -90}
    ).json()
    assert next(p for p in nb["pages"] if p["id"] == ids[0])["rotation"] == 0

    r = client.post(
        f"/api/notebooks/{nb['id']}/pages/delete", json={"base_rev": nb["rev"], "page_ids": [ids[1], ids[4]]}
    )
    nb = r.json()
    batch = nb["deleted_batch"]
    assert texts(client, nb["id"]) == ["p1", "p3", "p4"]
    assert nb["page_count"] == 3

    nb = client.post(f"/api/notebooks/{nb['id']}/pages/undelete", json={"batch": batch}).json()
    assert texts(client, nb["id"]) == ["p5", "p1", "p2", "p3", "p4"]
    r = client.post(f"/api/notebooks/{nb['id']}/pages/undelete", json={"batch": batch})
    assert r.status_code == 404


def test_bookmark_follows_pages(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=6)
    ids = [p["id"] for p in nb["pages"]]
    folder = client.post("/api/folders", json={"name": "Marks"}).json()
    r = client.post(
        "/api/bookmarks",
        json={"name": "Ch 1", "notebook_id": nb["id"], "parent_id": folder["id"], "page_ids": [ids[1], ids[2], ids[4]]},
    )
    assert r.status_code == 200, r.text
    bm = r.json()
    assert bm["segments"] == [[2, 3], [5, 5]]
    assert bm["label"] == "pp. 2–3, 5"

    # Insert a PDF between p2 and p3 and add the new pages to the bookmark.
    extra = upload(client, make_pdf(tmp_path / "ins.pdf", pages=2, label="n"))
    nb = client.post(
        f"/api/notebooks/{nb['id']}/pages/insert",
        json={
            "base_rev": nb["rev"],
            "source_id": extra["id"],
            "at": "after",
            "after_page_id": ids[1],
            "add_to_bookmarks": [bm["id"]],
        },
    ).json()
    detail = client.get(f"/api/bookmarks/{bm['id']}").json()
    assert detail["segments"] == [[2, 5], [7, 7]]

    # Moving the notebook doesn't affect the bookmark.
    other = client.post("/api/folders", json={"name": "Elsewhere"}).json()
    assert client.post("/api/nodes/move", json={"ids": [nb["id"]], "target_id": other["id"]}).status_code == 200
    r = client.get(f"/api/bookmarks/{bm['id']}/pdf")
    assert page_texts(r.content) == ["p2", "n1", "n2", "p3", "p5"]

    # Deleting a bookmarked page removes it; undo restores it into the bookmark.
    nb = client.post(
        f"/api/notebooks/{nb['id']}/pages/delete", json={"base_rev": nb["rev"], "page_ids": [ids[4]]}
    ).json()
    assert client.get(f"/api/bookmarks/{bm['id']}").json()["segments"] == [[2, 5]]
    client.post(f"/api/notebooks/{nb['id']}/pages/undelete", json={"batch": nb["deleted_batch"]})
    assert client.get(f"/api/bookmarks/{bm['id']}").json()["segments"] == [[2, 5], [7, 7]]

    # Notebook detail lists the bookmark.
    nb = client.get(f"/api/notebooks/{nb['id']}").json()
    assert [b["name"] for b in nb["bookmarks"]] == ["Ch 1"]


def test_bookmark_edit_and_validation(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=4)
    other = new_notebook(client, tmp_path, pages=2, name="Other", label="o")
    ids = [p["id"] for p in nb["pages"]]
    r = client.post(
        "/api/bookmarks", json={"name": "Bad", "notebook_id": nb["id"], "page_ids": [other["pages"][0]["id"]]}
    )
    assert r.status_code == 409
    bm = client.post("/api/bookmarks", json={"name": "B", "notebook_id": nb["id"], "page_ids": [ids[0]]}).json()
    r = client.put(f"/api/bookmarks/{bm['id']}/pages", json={"page_ids": [ids[3], ids[1]]})
    assert r.status_code == 200
    assert r.json()["segments"] == [[2, 2], [4, 4]]
    assert r.json()["page_ids"] == [ids[1], ids[3]]
    r = client.post(f"/api/bookmarks/{bm['id']}/pages/add", json={"page_ids": [ids[2]]})
    assert r.json()["segments"] == [[2, 4]]
    r = client.put(f"/api/bookmarks/{bm['id']}/pages", json={"page_ids": []})
    assert r.json()["label"] == "No pages"
    assert client.get(f"/api/bookmarks/{bm['id']}/pdf").status_code == 409


def test_progress(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=3)
    assert client.get(f"/api/progress/{nb['id']}").json()["page_id"] is None
    pid = nb["pages"][2]["id"]
    assert client.put(f"/api/progress/{nb['id']}", json={"page_id": pid, "page_index": 2}).status_code == 200
    assert client.get(f"/api/progress/{nb['id']}").json() == {
        "page_id": pid,
        "page_index": 2,
        "updated_at": client.get(f"/api/progress/{nb['id']}").json()["updated_at"],
    }
