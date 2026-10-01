from __future__ import annotations

from pathlib import Path

from sqlalchemy import func, select, text

from academia.db import read_session
from academia.models import PageText
from academia.services.textindex import index_source
from conftest import make_pdf, make_text_pdf, new_notebook, upload

DEVICE = "device-0001-abcdef"
DEVICE2 = "device-0002-abcdef"


def text_notebook(client, tmp_path: Path, name: str, texts: list[str], parent_id=None) -> dict:  # noqa: ANN001
    src = upload(client, make_text_pdf(tmp_path / f"{name}.pdf", texts))
    index_source(src["id"])  # normally done in the background after upload
    nb = client.post("/api/notebooks", json={"name": name, "parent_id": parent_id, "source_id": src["id"]}).json()
    return client.get(f"/api/notebooks/{nb['id']}").json()


def search(client, q: str, folder: str | None = None) -> dict:  # noqa: ANN001
    params = {"q": q}
    if folder:
        params["in"] = folder
    r = client.get("/api/search", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def claim(client, rank: int = 10, limit: int = 8, device: str = DEVICE, engine: str = "test-engine") -> list[dict]:  # noqa: ANN001
    r = client.post("/api/ocr/claim", json={"device": device, "engine": engine, "rank": rank, "limit": limit})
    assert r.status_code == 200, r.text
    return r.json()["pages"]


def submit(client, items: list[dict], rank: int = 10, device: str = DEVICE, engine: str = "test-engine") -> int:  # noqa: ANN001
    r = client.post("/api/ocr/submit", json={"device": device, "engine": engine, "rank": rank, "items": items})
    assert r.status_code == 200, r.text
    return r.json()["stored"]


# ---- pins ---------------------------------------------------------------------------------


def test_pins(client, other_client, tmp_path: Path):
    a = client.post("/api/folders", json={"name": "Chemistry"}).json()
    b = client.post("/api/folders", json={"name": "Week 1", "parent_id": a["id"]}).json()
    nb = new_notebook(client, tmp_path, pages=1)
    assert client.get("/api/pins").json() == []
    client.post("/api/pins", json={"node_id": a["id"]})
    pins = client.post("/api/pins", json={"node_id": b["id"]}).json()
    assert [(p["name"], p["location"]) for p in pins] == [("Chemistry", "Library"), ("Week 1", "Chemistry")]
    client.post("/api/pins", json={"node_id": a["id"]})  # idempotent
    pins = client.put("/api/pins/order", json={"node_ids": [b["id"], a["id"]]}).json()
    assert [p["name"] for p in pins] == ["Week 1", "Chemistry"]
    assert client.post("/api/pins", json={"node_id": nb["id"]}).status_code == 400
    assert other_client.post("/api/pins", json={"node_id": a["id"]}).status_code == 404
    assert other_client.get("/api/pins").json() == []

    # Trashed folders drop out of the list; purging removes the pin for good.
    client.post("/api/nodes/trash", json={"ids": [a["id"]]})
    assert client.get("/api/pins").json() == []
    client.post("/api/trash/restore", json={"ids": [a["id"]]})
    assert len(client.get("/api/pins").json()) == 2
    pins = client.delete(f"/api/pins/{b['id']}").json()
    assert [p["name"] for p in pins] == ["Chemistry"]
    client.post("/api/nodes/trash", json={"ids": [a["id"]]})
    client.post("/api/trash/empty")
    with read_session() as db:
        assert db.execute(text("select count(*) from pins")).scalar() == 0


# ---- search: scope, files and contents ------------------------------------------------------


def test_embedded_text_search_is_scoped_and_recursive(client, tmp_path: Path):
    chem = client.post("/api/folders", json={"name": "Chemistry"}).json()
    organic = client.post("/api/folders", json={"name": "Organic", "parent_id": chem["id"]}).json()
    physics = client.post("/api/folders", json={"name": "Physics"}).json()
    text_notebook(client, tmp_path, "Lecture 1", ["Intro", "Entropy and enthalpy", "Kinetics"], chem["id"])
    text_notebook(client, tmp_path, "Alkenes", ["Entropy of mixing", "Benzene"], organic["id"])
    text_notebook(client, tmp_path, "Mechanics", ["Newton", "Entropy (statistical)"], physics["id"])

    everywhere = search(client, "entropy")
    assert everywhere["scope"] is None
    assert sorted(c["name"] for c in everywhere["contents"]) == ["Alkenes", "Lecture 1", "Mechanics"]

    in_chem = search(client, "entropy", chem["id"])
    assert in_chem["scope"] == {"id": chem["id"], "name": "Chemistry"}
    assert sorted(c["name"] for c in in_chem["contents"]) == ["Alkenes", "Lecture 1"]
    lecture = next(c for c in in_chem["contents"] if c["name"] == "Lecture 1")
    assert [m["number"] for m in lecture["matches"]] == [2]
    assert lecture["matches"][0]["exact"] is True
    assert lecture["location"] == "Chemistry"

    assert [c["name"] for c in search(client, "entropy", organic["id"])["contents"]] == ["Alkenes"]
    # Names: the folder itself is not part of its own results; subfolders are.
    assert [f["name"] for f in search(client, "organic", chem["id"])["files"]] == ["Organic"]
    assert search(client, "chemistry", chem["id"])["files"] == []
    # Prefix while typing, accent-insensitive, multiple words.
    assert [c["name"] for c in search(client, "kinet", chem["id"])["contents"]] == ["Lecture 1"]
    assert [c["name"] for c in search(client, "ENTROPY enthalpy")["contents"]] == ["Lecture 1"]


def test_bookmarks_in_contents(client, tmp_path: Path):
    folder = client.post("/api/folders", json={"name": "Marks"}).json()
    nb = text_notebook(client, tmp_path, "Notes", ["alpha", "beta", "gamma", "beta again"])
    client.post(
        "/api/bookmarks",
        json={"name": "Betas", "notebook_id": nb["id"], "parent_id": folder["id"], "page_ids": [nb["pages"][3]["id"]]},
    )
    result = search(client, "beta", folder["id"])
    assert [(c["name"], [(m["number"], m["open_page"]) for m in c["matches"]]) for c in result["contents"]] == [
        ("Betas", [(4, 1)])
    ]


# ---- handwriting recognition queue ----------------------------------------------------------


def test_recognition_queue_and_fuzzy_search(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=3, name="Handwritten")
    pages = claim(client)
    assert {(p["source_id"], p["index"]) for p in pages} == {(nb["pages"][0]["source_id"], i) for i in range(3)}
    assert claim(client, device=DEVICE2) == []  # leased to the first device
    src = pages[0]["source_id"]
    stored = submit(
        client,
        [
            {"source_id": src, "index": 0, "text": "Thermodynamcis — second law, entropy"},
            {"source_id": src, "index": 1, "text": "Carnot cycle"},
            {"source_id": src, "index": 2, "error": "model crashed"},
        ],
    )
    assert stored == 2
    assert client.get("/api/ocr/status", params={"rank": 10}).json() == {"total": 3, "read": 2, "remaining": 1}

    # The misspelled word is still found, as a non-exact match.
    result = search(client, "thermodynamics")
    assert [c["name"] for c in result["contents"]] == ["Handwritten"]
    match = result["contents"][0]["matches"][0]
    assert match["number"] == 1 and match["exact"] is False
    assert search(client, "carnot")["contents"][0]["matches"][0]["exact"] is True
    # The recognised text is never sent back.
    assert "Thermodynamcis" not in client.get("/api/search", params={"q": "thermodynamics"}).text
    assert "Carnot" not in client.get(f"/api/notebooks/{nb['id']}").text

    # Failed pages are retried until they've failed three times.
    for _ in range(2):
        retry = claim(client)
        assert [(p["index"]) for p in retry] == [2]
        submit(client, [{"source_id": src, "index": 2, "error": "again"}])
    assert claim(client) == []
    # A better engine re-reads everything (including the failed page)...
    assert len(claim(client, rank=20, engine="better")) == 3
    # ...but a weaker one never overwrites a better result.
    submit(client, [{"source_id": src, "index": 1, "text": "Carnot heat engine"}], rank=20, engine="better")
    submit(client, [{"source_id": src, "index": 1, "text": "garbage"}], rank=5, engine="weak")
    assert search(client, "garbage")["contents"] == []
    assert search(client, "engine")["contents"][0]["name"] == "Handwritten"


def test_unread_pages_reported_and_other_users_isolated(client, other_client, tmp_path: Path):
    folder = client.post("/api/folders", json={"name": "F"}).json()
    nb = new_notebook(client, tmp_path, pages=2, parent_id=folder["id"])
    assert search(client, "anything", folder["id"])["unread_pages"] == 2
    src = nb["pages"][0]["source_id"]
    assert other_client.post(
        "/api/ocr/submit",
        json={"device": DEVICE2, "engine": "x", "rank": 50, "items": [{"source_id": src, "index": 0, "text": "hack"}]},
    ).json() == {"stored": 0}
    assert claim(other_client, device=DEVICE2) == []
    assert search(other_client, "p1")["contents"] == []
    assert other_client.get(f"/api/sources/{src}/file").status_code == 404


def test_rotation_hint_and_source_file(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=2)
    first = nb["pages"][0]
    client.post(
        f"/api/notebooks/{nb['id']}/pages/rotate", json={"base_rev": nb["rev"], "page_ids": [first["id"]], "delta": 90}
    )
    pages = {p["index"]: p for p in claim(client)}
    assert pages[0]["rotation"] == 90 and pages[1]["rotation"] == 0
    r = client.get(f"/api/sources/{first['source_id']}/file", headers={"Range": "bytes=0-7"})
    assert r.status_code == 206 and r.content.startswith(b"%PDF")
    assert "immutable" in r.headers["cache-control"]


def test_text_removed_with_source(client, tmp_path: Path):
    src = upload(client, make_pdf(tmp_path / "gone.pdf", pages=2))
    index_source(src["id"])
    nb = client.post("/api/notebooks", json={"name": "Gone", "source_id": src["id"]}).json()
    with read_session() as db:
        assert db.scalar(select(func.count()).select_from(PageText)) == 2
    client.post("/api/nodes/trash", json={"ids": [nb["id"]]})
    client.post("/api/trash/empty")
    from datetime import timedelta

    from sqlalchemy import update

    from academia.db import write_session
    from academia.models import Source, utcnow
    from academia.services.maintenance import run_maintenance

    with write_session() as db:
        db.execute(update(Source).values(orphaned_at=utcnow() - timedelta(days=60)))
    run_maintenance()
    with read_session() as db:
        assert db.scalar(select(func.count()).select_from(PageText)) == 0
        assert db.execute(text("select count(*) from page_text_fts")).scalar() == 0


def test_reset_requeues_but_keeps_text(client, tmp_path: Path):
    new_notebook(client, tmp_path, pages=1, name="Again")
    page = claim(client)[0]
    submit(client, [{"source_id": page["source_id"], "index": 0, "text": "photosynthesis"}])
    assert claim(client) == []
    assert client.post("/api/ocr/reset").json() == {"queued": 1}
    assert len(claim(client)) == 1
    assert search(client, "photosynthesis")["contents"][0]["name"] == "Again"
