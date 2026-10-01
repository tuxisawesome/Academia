from __future__ import annotations

import io
import json
import os
import time
import zipfile
from datetime import timedelta
from pathlib import Path

import pikepdf
from sqlalchemy import select, update

from academia.db import read_session, write_session
from academia.models import Page, Source, utcnow
from academia.services.export import safe_filename
from academia.services.maintenance import run_maintenance, trim_pdf_cache
from conftest import new_notebook, page_texts


def wait_export(client, job_id: str) -> dict:  # noqa: ANN001
    for _ in range(300):
        job = client.get(f"/api/exports/{job_id}").json()
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.1)
    raise AssertionError("export did not finish")


def test_safe_filename():
    assert safe_filename('a/b\\c:d*e?f"g<h>i|j') == "a_b_c_d_e_f_g_h_i_j"
    assert safe_filename("CON") == "_CON"
    assert safe_filename("  dots... ") == "dots"
    assert safe_filename("") == "Untitled"


def build_library(client, tmp_path: Path) -> dict:  # noqa: ANN001
    course = client.post("/api/folders", json={"name": "Course", "color": "teal"}).json()
    client.post("/api/folders", json={"name": "Empty"}).json()
    nb = new_notebook(client, tmp_path, pages=4, name="Lectures", parent_id=course["id"])
    new_notebook(client, tmp_path, pages=1, name="Lectures", parent_id=course["id"], label="z")
    ids = [p["id"] for p in nb["pages"]]
    bm = client.post(
        "/api/bookmarks",
        json={"name": "Key/pages", "notebook_id": nb["id"], "parent_id": course["id"], "page_ids": [ids[1], ids[3]]},
    ).json()
    return {"course": course, "nb": nb, "bm": bm}


def test_export_with_outlines_and_bookmark_pdfs(client, tmp_path: Path):
    lib = build_library(client, tmp_path)
    job = client.post("/api/exports", json={"embed_bookmarks": True, "bookmark_pdfs": True}).json()
    job = wait_export(client, job["id"])
    assert job["status"] == "done", job
    r = client.get(f"/api/exports/{job['id']}/download")
    assert r.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = sorted(zf.namelist())
    assert names == sorted(
        [
            "Academia/Course/",
            "Academia/Empty/",
            "Academia/Course/Lectures.pdf",
            "Academia/Course/Lectures (2).pdf",
            "Academia/Course/Key_pages.pdf",
            "Academia/manifest.json",
        ]
    )
    manifest = json.loads(zf.read("Academia/manifest.json"))
    bm_item = next(i for i in manifest["items"] if i["kind"] == "bookmark")
    assert bm_item["segments"] == [[2, 2], [4, 4]] and bm_item["notebook_id"] == lib["nb"]["id"]
    assert next(i for i in manifest["items"] if i["name"] == "Course")["color"] == "teal"

    lectures = [n for n in names if n.startswith("Academia/Course/Lectures")]
    outlines = {}
    for name in lectures:
        pdf = pikepdf.open(io.BytesIO(zf.read(name)))
        with pdf.open_outline() as ol:
            outlines[len(pdf.pages)] = [i.title for i in ol.root]
    assert outlines[4] == ["Key/pages"]
    assert page_texts(zf.read("Academia/Course/Key_pages.pdf")) == ["p2", "p4"]


def test_export_without_outlines(client, tmp_path: Path):
    build_library(client, tmp_path)
    job = wait_export(client, client.post("/api/exports", json={"embed_bookmarks": False}).json()["id"])
    zf = zipfile.ZipFile(io.BytesIO(client.get(f"/api/exports/{job['id']}/download").content))
    assert "Academia/Course/Key_pages.pdf" not in zf.namelist()
    for name in zf.namelist():
        if name.endswith(".pdf"):
            with pikepdf.open(io.BytesIO(zf.read(name))).open_outline() as ol:
                assert list(ol.root) == []


def test_export_isolated(client, other_client, tmp_path: Path):
    build_library(client, tmp_path)
    job = wait_export(client, client.post("/api/exports", json={}).json()["id"])
    assert other_client.get(f"/api/exports/{job['id']}").status_code == 404
    assert other_client.get(f"/api/exports/{job['id']}/download").status_code == 404


def test_maintenance_deferred_source_deletion(client, tmp_path: Path, data_dir: Path):
    nb = new_notebook(client, tmp_path, pages=2)
    client.post(f"/api/notebooks/{nb['id']}/pages/delete", json={"page_ids": [p["id"] for p in nb["pages"]]})
    run_maintenance()
    assert len(list((data_dir / "sources").rglob("*.pdf"))) == 1  # soft-deleted pages still reference it

    long_ago = utcnow() - timedelta(days=40)
    with write_session() as db:
        db.execute(update(Page).values(deleted_at=long_ago))
    run_maintenance()
    with read_session() as db:
        src = db.scalars(select(Source)).one()
        assert src.orphaned_at is not None
    assert len(list((data_dir / "sources").rglob("*.pdf"))) == 1  # grace period

    with write_session() as db:
        db.execute(update(Source).values(orphaned_at=long_ago))
    stats = run_maintenance()
    assert stats["sources_deleted"] == 1
    assert list((data_dir / "sources").rglob("*.pdf")) == []
    assert not any((data_dir / "thumbs").iterdir())


def test_maintenance_purges_old_trash(client, tmp_path: Path):
    f = client.post("/api/folders", json={"name": "Gone"}).json()
    client.post("/api/nodes/trash", json={"ids": [f["id"]]})
    assert run_maintenance()["trash_purged"] == 0
    with write_session() as db:
        from academia.models import Node

        db.execute(update(Node).values(trashed_at=utcnow() - timedelta(days=31)))
    assert run_maintenance()["trash_purged"] == 1
    assert client.get("/api/trash").json() == []


def test_trim_pdf_cache(data_dir: Path):
    cache = data_dir / "cache" / "pdf"
    cache.mkdir(parents=True, exist_ok=True)
    for i in range(5):
        p = cache / f"{i}.pdf"
        p.write_bytes(b"x" * 1000)
        os.utime(p, (time.time() - 100 + i, time.time() - 100 + i))
    assert trim_pdf_cache(2500) == 3
    assert sorted(p.name for p in cache.glob("*.pdf")) == ["3.pdf", "4.pdf"]
