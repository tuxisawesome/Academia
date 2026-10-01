"""Regression tests for export, maintenance and housekeeping fixes (group BE-4)."""

from __future__ import annotations

import io
import json
import pathlib
import time
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import update

from academia.db import read_session, write_session
from academia.models import Job
from academia.services.export import _estimate_bytes, fail_interrupted_jobs, safe_filename
from academia.services.maintenance import run_maintenance, trim_pdf_cache
from academia.storage import export_path, source_path
from conftest import new_notebook


def wait_export(client, job_id: str) -> dict:  # noqa: ANN001
    for _ in range(300):
        job = client.get(f"/api/exports/{job_id}").json()
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.1)
    raise AssertionError("export did not finish")


def run_export(client, **options: bool) -> dict:  # noqa: ANN001
    job = client.post("/api/exports", json={"embed_bookmarks": True, **options}).json()
    return wait_export(client, job["id"])


def user_id(client, username: str) -> str:  # noqa: ANN001
    return next(u["id"] for u in client.get("/api/admin/users").json() if u["username"] == username)


def files_under(path: Path) -> list[str]:
    return sorted(str(p.relative_to(path)) for p in path.rglob("*") if p.is_file())


# ---- deleting a user removes their exports and cached PDFs --------------------------


def test_delete_user_removes_export_zips(client, other_client, data_dir: Path, tmp_path: Path):
    new_notebook(other_client, tmp_path, pages=3, name="Bob private")
    job = run_export(other_client)
    assert job["status"] == "done", job
    assert files_under(data_dir / "exports")

    r = client.delete(f"/api/admin/users/{user_id(client, 'bob')}")
    assert r.status_code == 200, r.text
    assert files_under(data_dir / "exports") == []


def test_delete_user_removes_cached_pdfs(client, other_client, data_dir: Path, tmp_path: Path):
    alice_nb = new_notebook(client, tmp_path, pages=2, name="Alice notes")
    assert client.get(f"/api/notebooks/{alice_nb['id']}/pdf").status_code == 200
    nb = new_notebook(other_client, tmp_path, pages=3, name="Bob private")
    assert other_client.get(f"/api/notebooks/{nb['id']}/pdf").status_code == 200
    assert len(list((data_dir / "cache" / "pdf").rglob("*.pdf"))) == 2

    r = client.delete(f"/api/admin/users/{user_id(client, 'bob')}")
    assert r.status_code == 200, r.text
    run_maintenance()

    assert len(list((data_dir / "cache" / "pdf").rglob("*.pdf"))) == 1  # only Alice's
    assert client.get(f"/api/notebooks/{alice_nb['id']}/pdf").status_code == 200


def test_maintenance_removes_orphaned_export_files(client, data_dir: Path, tmp_path: Path):
    new_notebook(client, tmp_path, pages=1)
    job = run_export(client)
    assert job["status"] == "done", job
    exports = data_dir / "exports"
    (exports / "0d6f4b53-0000-4000-8000-000000000000.zip").write_bytes(b"orphan")
    (exports / "0d6f4b53-0000-4000-8000-000000000001.zip.part").write_bytes(b"orphan")
    run_maintenance()
    assert files_under(exports) == [f"{job['id']}.zip"]
    assert client.get(f"/api/exports/{job['id']}/download").status_code == 200


# ---- an export interrupted by a restart leaves no .zip.part --------------------------


def test_interrupted_export_part_file_is_removed(client, data_dir: Path):
    uid = user_id(client, "alice")
    with write_session() as db:
        job = Job(owner_id=uid, kind="export", status="running", params={})
        db.add(job)
        db.flush()
        job_id = job.id
    part = export_path(job_id).with_suffix(".zip.part")
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(b"partial")
    fail_interrupted_jobs()
    assert not part.exists()
    with read_session() as db:
        assert db.get(Job, job_id).status == "failed"


# ---- the manifest matches the ZIP; one broken notebook doesn't fail all -------


def test_manifest_paths_only_for_written_entries(client, tmp_path: Path):
    kept = new_notebook(client, tmp_path, pages=2, name="Kept")
    empty = client.post("/api/notebooks", json={"name": "Empty notebook"}).json()
    client.post("/api/bookmarks", json={"name": "No pages yet", "notebook_id": kept["id"], "page_ids": []})
    doomed = new_notebook(client, tmp_path, pages=2, name="Doomed", label="d")
    client.post(
        "/api/bookmarks",
        json={"name": "Points into trash", "notebook_id": doomed["id"], "page_ids": [doomed["pages"][0]["id"]]},
    )
    assert client.post("/api/nodes/trash", json={"ids": [doomed["id"]]}).status_code == 200

    job = run_export(client, bookmark_pdfs=True)
    assert job["status"] == "done", job
    zf = zipfile.ZipFile(io.BytesIO(client.get(f"/api/exports/{job['id']}/download").content))
    names = set(zf.namelist())
    manifest = json.loads(zf.read("Academia/manifest.json"))
    by_name = {item["name"]: item for item in manifest["items"]}
    assert by_name["Kept"]["path"] == "Academia/Kept.pdf"
    for item in manifest["items"]:
        assert item["path"] is None or item["path"] in names, item
    assert by_name["Empty notebook"]["path"] is None
    assert by_name["No pages yet"]["path"] is None
    assert by_name["Points into trash"]["path"] is None
    assert empty["id"] == by_name["Empty notebook"]["id"]


def test_export_skips_a_broken_notebook(client, tmp_path: Path):
    bad = new_notebook(client, tmp_path, pages=2, name="Bad", label="b")
    new_notebook(client, tmp_path, pages=2, name="Good", label="g")
    source_path(bad["pages"][0]["source_id"]).write_bytes(b"")

    job = run_export(client)
    assert job["status"] == "done", job
    assert "Bad" in (job["error"] or "")
    zf = zipfile.ZipFile(io.BytesIO(client.get(f"/api/exports/{job['id']}/download").content))
    assert "Academia/Good.pdf" in zf.namelist()
    assert "Academia/Bad.pdf" not in zf.namelist()
    manifest = json.loads(zf.read("Academia/manifest.json"))
    bad_item = next(i for i in manifest["items"] if i["name"] == "Bad")
    assert bad_item["path"] is None and bad_item["error"]


# ---- the free-space estimate counts every copy -------------------------------------


def test_estimate_counts_each_notebook_copy(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=4, name="Scan")
    for _ in range(3):
        assert client.post("/api/nodes/copy", json={"ids": [nb["id"]], "target_id": None}).status_code == 200
    with read_session() as db:
        from academia.models import Source

        size = db.get(Source, nb["pages"][0]["source_id"]).byte_size
        estimate = _estimate_bytes(db, user_id(client, "alice"), False) - 64 * 1024 * 1024
    assert estimate >= 4 * size


# ---- export file names ------------------------------------------------------


def test_safe_filename_limits_utf8_bytes():
    name = safe_filename("線形代数学講義ノート" * 25)
    assert len(f"{name} (99).pdf".encode()) <= 255
    assert name.startswith("線形代数学")
    assert safe_filename("x" * 300) == "x" * 150


def test_safe_filename_no_leading_dot():
    assert not safe_filename(".NET").startswith(".")
    assert not safe_filename(".NET Core lecture").startswith(".")
    assert safe_filename("...") == "Untitled"


# ---- the .part sweep tolerates a build finishing concurrently -----------------------


def test_trim_pdf_cache_tolerates_vanishing_part(data_dir: Path, monkeypatch):
    cache = data_dir / "cache" / "pdf" / "someone"
    cache.mkdir(parents=True)
    (cache / "abc.pdf.123.part").write_bytes(b"x")
    (cache.parent / "def.pdf.123.part").write_bytes(b"x")

    def racing(original):  # noqa: ANN001, ANN202
        def glob(self, pattern, **kwargs):  # noqa: ANN001, ANN003, ANN202
            found = list(original(self, pattern, **kwargs))
            for p in found:
                if p.name.endswith(".part"):
                    p.unlink(missing_ok=True)  # the build renamed it into place
            return iter(found)

        return glob

    monkeypatch.setattr(pathlib.Path, "glob", racing(pathlib.Path.glob))
    monkeypatch.setattr(pathlib.Path, "rglob", racing(pathlib.Path.rglob))
    assert trim_pdf_cache(10**9) == 0


# ---- leftovers of the removed handwriting-model feature ---------------------------


def test_maintenance_removes_old_model_files(data_dir: Path):
    rev = data_dir / "models" / "onnx-community" / "Qwen3.5-2B-ONNX-OPT" / "2ea7886f"
    rev.mkdir(parents=True)
    (rev / "model.onnx").write_bytes(b"x" * 1000)
    run_maintenance()
    assert not (data_dir / "models").exists()


# ---- the export file name uses the user's local date ------------------------------


def test_export_filename_uses_client_timezone(client, tmp_path: Path):
    new_notebook(client, tmp_path, pages=1)
    job = run_export(client)
    assert job["status"] == "done", job
    with write_session() as db:
        db.execute(update(Job).where(Job.id == job["id"]).values(created_at=datetime(2026, 10, 1, 1, 0, tzinfo=UTC)))
    url = f"/api/exports/{job['id']}/download"
    r = client.get(url, params={"tz": "America/New_York"})
    assert r.status_code == 200
    assert "2026-09-30" in r.headers["content-disposition"]
    r = client.get(url, params={"tz": "Australia/Sydney"})
    assert "2026-10-01" in r.headers["content-disposition"]
    r = client.get(url, params={"tz": "Not/AZone"})
    assert r.status_code == 200 and "2026-10-01" in r.headers["content-disposition"]
    assert client.get(url).status_code == 200
