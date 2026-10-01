from __future__ import annotations

from pathlib import Path

from sqlalchemy import func, select, text

from academia.db import read_session
from academia.models import PageText
from academia.services.textindex import index_source, sources_needing_text
from conftest import make_pdf, make_text_pdf, new_notebook, upload


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


def test_text_search_is_scoped_and_recursive(client, tmp_path: Path):
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
    assert lecture["location"] == "Chemistry"

    assert [c["name"] for c in search(client, "entropy", organic["id"])["contents"]] == ["Alkenes"]
    # Names: the folder itself is not part of its own results; subfolders are.
    assert [f["name"] for f in search(client, "organic", chem["id"])["files"]] == ["Organic"]
    assert search(client, "chemistry", chem["id"])["files"] == []
    # Prefix while typing, accent-insensitive, multiple words.
    assert [c["name"] for c in search(client, "kinet", chem["id"])["contents"]] == ["Lecture 1"]
    assert [c["name"] for c in search(client, "ENTROPY enthalpy")["contents"]] == ["Lecture 1"]


def test_numbers_narrow_the_search(client, tmp_path: Path):
    text_notebook(client, tmp_path, "Lectures", [f"Lecture {n}" for n in range(1, 13)])
    assert len(search(client, "lecture")["contents"][0]["matches"]) == 12
    assert [m["number"] for m in search(client, "lecture 7")["contents"][0]["matches"]] == [7]
    # Single letters are ignored rather than required.
    assert len(search(client, "lecture x")["contents"][0]["matches"]) == 12


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


def test_contents_are_private_and_never_returned(client, other_client, tmp_path: Path):
    nb = text_notebook(client, tmp_path, "Thermo", ["Carnot cycle", "Second law"])
    assert [c["name"] for c in search(client, "carnot")["contents"]] == ["Thermo"]
    # Only *which* pages match is reported; the page text itself never leaves the server.
    assert "Carnot" not in client.get("/api/search", params={"q": "carnot"}).text
    assert "Carnot" not in client.get(f"/api/notebooks/{nb['id']}").text
    assert search(other_client, "carnot")["contents"] == []


def test_phrases_and_pages_without_text(client, tmp_path: Path):
    text_notebook(client, tmp_path, "Laws", ["second law of thermodynamics", "the law, second edition"])
    assert [m["number"] for m in search(client, "second law")["contents"][0]["matches"]] == [1, 2]
    assert [m["number"] for m in search(client, '"second law"')["contents"][0]["matches"]] == [1]

    # Pages without a text layer (scans, handwriting) are recorded as empty and not re-read.
    src = upload(client, make_text_pdf(tmp_path / "scan.pdf", ["", ""]))
    assert index_source(src["id"]) == 2
    assert src["id"] not in sources_needing_text()
    assert index_source(src["id"]) == 0


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
