"""Regression tests: page undo order, version-pinned reader PDFs, upload file cleanup."""

from __future__ import annotations

import hashlib
import threading
import time
from datetime import timedelta
from pathlib import Path

import anyio
import anyio.from_thread
import anyio.to_thread
import pikepdf
import pytest
from sqlalchemy import select, update
from sqlalchemy.exc import OperationalError

from academia.api import files as files_api
from academia.db import read_session, write_session
from academia.models import Source, utcnow
from academia.services import maintenance
from academia.services import sources as sources_service
from academia.storage import data_dir, tmp_dir
from academia.workers import pdfops, pool
from conftest import make_pdf, new_notebook, page_texts, upload

# ---- undo restores pages between their original neighbours -----------------------


def _texts(client, nb_id: str) -> list[str]:  # noqa: ANN001
    r = client.get(f"/api/notebooks/{nb_id}/pdf")
    assert r.status_code == 200, r.text
    return page_texts(r.content)


def _delete(client, nb: dict, pids: list[str]) -> dict:  # noqa: ANN001
    r = client.post(f"/api/notebooks/{nb['id']}/pages/delete", json={"base_rev": nb["rev"], "page_ids": pids})
    assert r.status_code == 200, r.text
    return r.json()


def _undo(client, nb_id: str, batch: str) -> dict:  # noqa: ANN001
    r = client.post(f"/api/notebooks/{nb_id}/pages/undelete", json={"batch": batch})
    assert r.status_code == 200, r.text
    return r.json()


def test_undo_older_delete_after_newer_delete(client, tmp_path: Path):  # noqa: ANN001
    nb = new_notebook(client, tmp_path, pages=5)
    ids = [p["id"] for p in nb["pages"]]
    nb = _delete(client, nb, [ids[2]])
    batch_a = nb["deleted_batch"]
    nb = _delete(client, nb, [ids[0]])
    _undo(client, nb["id"], batch_a)
    assert _texts(client, nb["id"]) == ["p2", "p3", "p4", "p5"]


def test_undo_after_insert_at_start(client, tmp_path: Path):  # noqa: ANN001
    nb = new_notebook(client, tmp_path, pages=5)
    ids = [p["id"] for p in nb["pages"]]
    nb = _delete(client, nb, [ids[2]])
    batch = nb["deleted_batch"]
    extra = upload(client, make_pdf(tmp_path / "x.pdf", pages=2, label="x"))
    r = client.post(
        f"/api/notebooks/{nb['id']}/pages/insert",
        json={"base_rev": nb["rev"], "source_id": extra["id"], "at": "start"},
    )
    assert r.status_code == 200, r.text
    _undo(client, nb["id"], batch)
    assert _texts(client, nb["id"]) == ["x1", "x2", "p1", "p2", "p3", "p4", "p5"]


def test_undo_two_batches_oldest_first(client, tmp_path: Path):  # noqa: ANN001
    nb = new_notebook(client, tmp_path, pages=4)
    ids = [p["id"] for p in nb["pages"]]
    nb = _delete(client, nb, [ids[1]])
    b1 = nb["deleted_batch"]
    nb = _delete(client, nb, [ids[2]])
    b2 = nb["deleted_batch"]
    _undo(client, nb["id"], b1)
    _undo(client, nb["id"], b2)
    assert _texts(client, nb["id"]) == ["p1", "p2", "p3", "p4"]


def test_undo_after_reorder_follows_previous_page(client, tmp_path: Path):  # noqa: ANN001
    nb = new_notebook(client, tmp_path, pages=5)
    ids = [p["id"] for p in nb["pages"]]
    nb = _delete(client, nb, [ids[2]])  # p3 sat after p2
    batch = nb["deleted_batch"]
    order = [ids[3], ids[4], ids[0], ids[1]]  # p4 p5 p1 p2
    r = client.put(f"/api/notebooks/{nb['id']}/pages/order", json={"base_rev": nb["rev"], "page_ids": order})
    assert r.status_code == 200, r.text
    _undo(client, nb["id"], batch)
    assert _texts(client, nb["id"]) == ["p4", "p5", "p1", "p2", "p3"]


# ---- a digest-pinned reader URL never serves bytes of another PDF -------------------


def test_notebook_pdf_digest_pins_reader_url(client, tmp_path: Path):  # noqa: ANN001
    nb = new_notebook(client, tmp_path, pages=4, name="Algebra")
    digest = nb["pdf_digest"]
    url = f"/api/notebooks/{nb['id']}/pdf?d={digest}"
    r = client.get(url)
    assert r.status_code == 200
    assert r.headers["etag"] == f'"{digest}"'

    r = client.patch(f"/api/nodes/{nb['id']}", json={"name": "Linear algebra"})
    assert r.status_code == 200, r.text
    rr = client.get(url, headers={"Range": "bytes=100-200"})
    assert rr.status_code == 409
    assert rr.json()["error"]["code"] == "stale_rev"

    fresh = client.get(f"/api/notebooks/{nb['id']}").json()
    assert fresh["pdf_digest"] != digest
    assert client.get(f"/api/notebooks/{nb['id']}/pdf?d={fresh['pdf_digest']}").status_code == 200


def test_bookmark_pdf_digest_pins_reader_url(client, tmp_path: Path):  # noqa: ANN001
    nb = new_notebook(client, tmp_path, pages=6, name="Physics")
    ids = [p["id"] for p in nb["pages"]]
    bm = client.post("/api/bookmarks", json={"name": "Ch 1", "notebook_id": nb["id"], "page_ids": ids[:3]}).json()
    det = client.get(f"/api/bookmarks/{bm['id']}").json()
    url = f"/api/bookmarks/{bm['id']}/pdf?d={det['pdf_digest']}"
    r = client.get(url)
    assert r.status_code == 200
    assert r.headers["etag"] == f'"{det["pdf_digest"]}"'

    r = client.post(
        f"/api/notebooks/{nb['id']}/pages/rotate", json={"base_rev": nb["rev"], "page_ids": [ids[0]], "delta": 90}
    )
    assert r.status_code == 200, r.text
    assert client.get(url, headers={"Range": "bytes=100-200"}).status_code == 409

    det = client.get(f"/api/bookmarks/{bm['id']}").json()
    url = f"/api/bookmarks/{bm['id']}/pdf?d={det['pdf_digest']}"
    assert client.get(url).status_code == 200
    client.patch(f"/api/nodes/{bm['id']}", json={"name": "Chapter one"})
    assert client.get(url, headers={"Range": "bytes=100-200"}).status_code == 409


# ---- failed uploads leave no files in sources/ -------------------------------------


def _source_files() -> list[Path]:
    return sorted(p for p in (data_dir() / "sources").rglob("*") if p.is_file())


def _store(tmp_path: Path, name: str = "a.pdf"):  # noqa: ANN202
    pdf = make_pdf(tmp_path / name, pages=2)
    tmp = tmp_dir() / f"upload-{name}"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(pdf.read_bytes())
    return tmp, hashlib.sha256(pdf.read_bytes()).hexdigest(), pdf.stat().st_size


def test_upload_db_failure_removes_stored_file(client, tmp_path: Path, monkeypatch):  # noqa: ANN001
    user_id = client.get("/api/auth/me").json()["id"]
    tmp, sha, size = _store(tmp_path)

    def locked(*_a, **_k):  # noqa: ANN002, ANN003, ANN202
        raise OperationalError("INSERT", {}, Exception("database is locked"))

    monkeypatch.setattr(sources_service, "_describe", locked)
    with pytest.raises(OperationalError):
        sources_service.store_upload(user_id, tmp, sha, size, "a.pdf")
    assert _source_files() == []


def test_upload_timeout_leaves_no_source_file(client, tmp_path: Path, monkeypatch):  # noqa: ANN001
    user_id = client.get("/api/auth/me").json()["id"]
    tmp, sha, size = _store(tmp_path)

    def late(fn, *args, timeout=600):  # noqa: ANN001, ANN202
        fn(*args)  # the worker finishes the job after the caller gave up waiting
        raise TimeoutError

    monkeypatch.setattr(sources_service.pool, "run", late)
    with pytest.raises(TimeoutError):
        sources_service.store_upload(user_id, tmp, sha, size, "a.pdf")
    assert _source_files() == []


def test_ingest_failed_save_removes_part_file(tmp_path: Path, monkeypatch):  # noqa: ANN001
    pdf = make_pdf(tmp_path / "a.pdf", pages=2)
    dest = tmp_path / "out" / "x.pdf"

    def full(self, filename, *_a, **_k):  # noqa: ANN001, ANN002, ANN003, ANN202
        Path(filename).write_bytes(b"%PDF-partial")
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(pikepdf.Pdf, "save", full)
    with pytest.raises(OSError):
        pdfops.ingest(str(pdf), str(dest))
    assert list((tmp_path / "out").iterdir()) == []


# ---- re-upload racing the purge of its orphaned copy --------------------------------


def test_reupload_while_maintenance_deletes_orphan(client, tmp_path: Path, monkeypatch):  # noqa: ANN001
    pdf = make_pdf(tmp_path / "a.pdf", pages=2)
    first = upload(client, pdf)
    with write_session() as db:
        db.execute(update(Source).values(orphaned_at=utcnow() - timedelta(days=60)))

    real = sources_service.source_path
    fired: list[int] = []

    def racing(source_id: str) -> Path:
        if not fired:
            fired.append(maintenance.delete_orphaned_sources(utcnow()))
        return real(source_id)

    monkeypatch.setattr(sources_service, "source_path", racing)
    second = upload(client, pdf)
    assert fired == [1]
    assert second["id"] != first["id"]
    assert second["page_count"] == 2
    with read_session() as db:
        ids = list(db.scalars(select(Source.id)))
    assert ids == [second["id"]]
    assert _source_files() == [real(second["id"])]


def test_reupload_while_maintenance_deletes_orphan_being_measured(client, tmp_path: Path, monkeypatch):  # noqa: ANN001
    pdf = make_pdf(tmp_path / "a.pdf", pages=2)
    first = upload(client, pdf)
    with write_session() as db:
        db.execute(update(Source).values(orphaned_at=utcnow() - timedelta(days=60)))

    real = pool.run
    fired: list[int] = []

    def racing(fn, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        if fn is pdfops.page_sizes and not fired:
            fired.append(maintenance.delete_orphaned_sources(utcnow()))
        return real(fn, *args, **kwargs)

    monkeypatch.setattr(pool, "run", racing)
    second = upload(client, pdf)
    assert fired == [1]
    assert second["id"] != first["id"]
    assert second["page_count"] == 2
    assert _source_files() == [sources_service.source_path(second["id"])]


# ---- uploads waiting for PDF workers do not hold the shared thread pool -------------


def test_upload_does_not_hold_default_thread_tokens(client, tmp_path: Path, monkeypatch):  # noqa: ANN001
    seen: list[float] = []

    def fake(*_a, **_k):  # noqa: ANN002, ANN003, ANN202
        seen.append(
            anyio.from_thread.run_sync(lambda: anyio.to_thread.current_default_thread_limiter().borrowed_tokens)
        )
        return {"id": "x"}

    monkeypatch.setattr(files_api, "store_upload", fake)
    upload(client, make_pdf(tmp_path / "a.pdf", pages=1))
    assert seen == [0]


def test_concurrent_uploads_are_limited_to_pdf_workers(client, tmp_path: Path, monkeypatch):  # noqa: ANN001
    lock = threading.Lock()
    running = [0, 0]  # current, max

    def fake(*_a, **_k):  # noqa: ANN002, ANN003, ANN202
        with lock:
            running[0] += 1
            running[1] = max(running[1], running[0])
        time.sleep(0.2)
        with lock:
            running[0] -= 1
        return {"id": "x"}

    monkeypatch.setattr(files_api, "store_upload", fake)
    pdf = make_pdf(tmp_path / "a.pdf", pages=1)
    threads = [threading.Thread(target=upload, args=(client, pdf)) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert 1 <= running[1] <= 2


def test_pool_run_recovers_when_submit_finds_pool_broken(monkeypatch):  # noqa: ANN001
    from concurrent.futures.process import BrokenProcessPool

    from academia.workers import pool

    class Broken:
        def submit(self, *_a):  # noqa: ANN002, ANN202
            raise BrokenProcessPool("A child process terminated abruptly")

        def shutdown(self, *_a, **_k):  # noqa: ANN002, ANN003, ANN202
            pass

    monkeypatch.setattr(pool, "_pool", Broken())
    try:
        assert pool.run(abs, -3) == 3
    finally:
        pool.shutdown()  # the fresh pool run() had to start
