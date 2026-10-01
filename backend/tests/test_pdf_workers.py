"""Regression tests: the PDF worker pool, PDF operations, the assembled-PDF cache and thumbnails."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import operator
import os
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from decimal import Decimal
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from pikepdf import Array, Name, String
from PIL import Image
from sqlalchemy import select

from academia import config
from academia.db import read_session
from academia.models import User
from academia.services import pdfbuild, thumbs
from academia.storage import pdf_cache_path, source_path, thumb_path
from academia.workers import pdfops, pool
from conftest import make_pdf, new_notebook, upload


@pytest.fixture
def one_worker(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    pool.shutdown()
    monkeypatch.setenv("ACADEMIA_PDF_WORKERS", "1")
    config.get_settings.cache_clear()
    yield
    pool.shutdown()


# ---- worker pool -----------------------------------------------------------------------


def test_pool_keeps_serving_after_a_burst_of_calls(data_dir: Path):
    """Replacing worn workers must never leave the pool without any."""
    pool.shutdown()
    try:
        with ThreadPoolExecutor(40) as threads:  # e.g. the page grid loading its thumbnails
            list(threads.map(lambda _: pool.run(time.sleep, 0.02, timeout=60), range(40)))
        for i in range(500):
            assert pool.run(operator.add, i, 1, timeout=10) == i + 1
    except TimeoutError:
        if pool._pool is not None:
            pool._reset(pool._pool)  # a stalled pool cannot be shut down cleanly
        raise


def test_call_that_overruns_its_timeout_does_not_keep_its_worker(one_worker: None):
    """A timed-out call (e.g. hung in pdfium) must not occupy its worker for good."""
    with pytest.raises(TimeoutError):
        pool.run(time.sleep, 25, timeout=1)
    started = time.monotonic()
    assert pool.run(abs, -5, timeout=10) == 5
    assert time.monotonic() - started < 9


def test_timed_out_call_that_never_started_is_dropped(one_worker: None, tmp_path: Path):
    """Nobody waits for the result any more, so the call must not run later."""
    marker = tmp_path / "ran"
    with ThreadPoolExecutor(3) as threads:
        busy = [threads.submit(pool.run, time.sleep, 1.5, timeout=60) for _ in range(3)]
        time.sleep(0.5)
        with pytest.raises(TimeoutError):
            pool.run(os.mkdir, str(marker), timeout=0.5)
        for future in busy:
            future.result()
    assert pool.run(abs, -1) == 1  # everything submitted before has been dealt with by now
    assert not marker.exists()


def test_call_that_crashes_its_worker_does_not_fail_other_calls(data_dir: Path):
    """A crash breaks the pool once; the other calls caught up in it still succeed."""
    pool.shutdown()
    with ThreadPoolExecutor(2) as threads:  # both workers up, as on a server in use
        list(threads.map(lambda _: pool.run(time.sleep, 0.3), range(2)))
    with ThreadPoolExecutor(4) as threads:
        # Its worker dies in the middle of the call, as on a segfault in pdfium.
        crash = threads.submit(pool.run, os.system, "sleep 0.3; kill -KILL $PPID")
        time.sleep(0.05)
        others = [threads.submit(pool.run, time.sleep, 1.0) for _ in range(3)]
        with pytest.raises(BrokenProcessPool):
            crash.result()
        assert [other.result() for other in others] == [None, None, None]


def test_retry_after_a_crash_waits_no_longer_than_its_caller(data_dir: Path):
    """A call to be retried alone must not wait for a free slot beyond its timeout."""
    for _ in range(2):  # both slots taken, e.g. by long builds being retried
        assert pool._alone_slots.acquire(timeout=0)
    try:
        with ThreadPoolExecutor(1) as threads:
            started = time.monotonic()
            crash = threads.submit(pool.run, os.system, "kill -KILL $PPID", timeout=2)
            with pytest.raises(TimeoutError):
                crash.result(timeout=30)
            assert time.monotonic() - started < 15
    finally:
        pool._alone_slots.release()
        pool._alone_slots.release()


# ---- thumbnails ------------------------------------------------------------------------


def test_concurrent_renders_of_the_same_thumbnails_do_not_collide(client, tmp_path: Path):
    """Two workers rendering the same thumbnail must not share a temporary file."""
    sid = upload(client, make_pdf(tmp_path / "a.pdf", pages=12))["id"]
    for rnd in range(5):
        items = [(i, 200, f"{thumb_path(sid, i, 200)}.{rnd}") for i in range(12)]
        renders = [pool.submit(pdfops.render_thumbnails, str(source_path(sid)), items) for _ in range(2)]
        for render in renders:
            assert render.result(timeout=120) == 12


def test_thumbnails_requested_during_the_prewarm_never_fail(client, tmp_path: Path, caplog: pytest.LogCaptureFixture):
    """The page grid asks for the very thumbnails the prewarmer is rendering."""
    caplog.set_level(logging.ERROR, logger="academia.services.thumbs")
    sid = upload(client, make_pdf(tmp_path / "big.pdf", pages=48))["id"]
    with ThreadPoolExecutor(6) as threads:
        statuses = list(
            threads.map(lambda i: client.get(f"/api/thumbs/{sid}/{i}", params={"w": 400}).status_code, range(48))
        )
    assert statuses == [200] * 48
    thumbs.prewarmer.stop()  # lets it finish this upload
    assert [r.getMessage() for r in caplog.records if "pre-render failed" in r.getMessage()] == []


def test_empty_thumbnail_left_by_a_crash_is_rendered_again(client, tmp_path: Path):
    """An empty thumbnail must not be served (browsers keep thumbnails for a year)."""
    thumbs.prewarmer.stop()
    sid = upload(client, make_pdf(tmp_path / "t.pdf", pages=1))["id"]
    path = thumb_path(sid, 0, 400)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    r = client.get(f"/api/thumbs/{sid}/0", params={"w": 400})
    assert r.status_code == 200
    assert Image.open(io.BytesIO(r.content)).width == 400


# ---- uploads ---------------------------------------------------------------------------


def rotations_after_rotating(client, source_id: str) -> list[int]:  # noqa: ANN001
    """Rotate every page of a new notebook made from the source by 90° and read back /Rotate."""
    nb = client.post("/api/notebooks", json={"name": "Rotated", "source_id": source_id}).json()
    nb = client.get(f"/api/notebooks/{nb['id']}").json()
    ids = [p["id"] for p in nb["pages"]]
    nb = client.post(
        f"/api/notebooks/{nb['id']}/pages/rotate", json={"base_rev": nb["rev"], "page_ids": ids, "delta": 90}
    ).json()
    pdf = pikepdf.open(io.BytesIO(client.get(f"/api/notebooks/{nb['id']}/pdf").content))
    return [int(p.obj.get("/Rotate", 0)) for p in pdf.pages]


@pytest.mark.parametrize("value", [Name("/Foo"), String("90"), Array([90])], ids=["name", "string", "array"])
def test_upload_with_a_non_numeric_rotate_is_accepted(client, tmp_path: Path, value: Any):
    """Pdfium and pdf.js read such a /Rotate as 0; it must not fail the upload."""
    src = upload(client, make_pdf(tmp_path / "odd.pdf", pages=2, rotate={1: value}))
    assert (src["pages"][1]["width"], src["pages"][1]["height"]) == (300, 400)
    with pikepdf.open(source_path(src["id"])) as pdf:
        assert pdf.pages[1].obj.Rotate == 0
    assert rotations_after_rotating(client, src["id"]) == [90, 90]


def test_real_valued_rotate_survives_rotating_the_page(client, tmp_path: Path):
    """/Rotate 90.0 turns the page by 90°, also once the page is rotated in the app."""
    src = upload(client, make_pdf(tmp_path / "real.pdf", pages=2, rotate={1: Decimal("90.0")}))
    assert (src["pages"][1]["width"], src["pages"][1]["height"]) == (400, 300)
    assert rotations_after_rotating(client, src["id"]) == [90, 180]


def test_real_valued_rotate_in_a_source_stored_by_an_older_release(client, tmp_path: Path):
    """Sources stored before uploads were normalised keep their /Rotate 90.0."""
    src = upload(client, make_pdf(tmp_path / "plain.pdf", pages=2))
    make_pdf(source_path(src["id"]), pages=2, rotate={1: Decimal("90.0")})
    assert rotations_after_rotating(client, src["id"]) == [90, 180]


def test_page_size_is_the_crop_box_clipped_to_the_media_box(client, tmp_path: Path):
    """The stored size must be what pdfium and pdf.js draw, or thumbnails are distorted."""
    path = make_pdf(tmp_path / "crop.pdf", pages=2)  # MediaBox 300 x 400
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        pdf.pages[0].obj.CropBox = Array([-50, -100, 350, 700])  # reaches past the MediaBox
        pdf.pages[1].obj.CropBox = Array([10, 20, 160, 220])
        pdf.save(path)
    src = upload(client, path)
    assert [(p["width"], p["height"]) for p in src["pages"]] == [(300, 400), (150, 200)]


def test_stored_and_built_pdfs_reach_the_disk_before_they_get_their_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """After a crash or power loss, a stored upload or a cached PDF is complete or absent."""
    flushed: list[str] = []
    renamed: list[tuple[str, str, int]] = []
    real_fsync, real_replace = os.fsync, os.replace

    def fsync(fd: int) -> None:
        flushed.append(os.readlink(f"/proc/self/fd/{fd}"))
        real_fsync(fd)

    def replace(src: str, dst: str) -> None:
        renamed.append((os.path.realpath(src), os.path.realpath(dst), len(flushed)))
        real_replace(src, dst)

    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "replace", replace)
    stored = tmp_path / "sources" / "ab" / "abc.pdf"
    pdfops.ingest(str(make_pdf(tmp_path / "upload.pdf")), str(stored))
    built = tmp_path / "cache" / "pdf" / "abc.pdf"
    pdfops.assemble({"title": "T", "pages": [[str(stored), 0, 0]], "outline": [], "labels": None}, str(built))
    for dest in (stored, built):
        part, at = next((src, at) for src, dst, at in renamed if dst == os.path.realpath(dest))
        assert part in flushed[:at]  # its content first,
        assert os.path.realpath(dest.parent) in flushed[at:]  # then its name


# ---- assembled-PDF cache ---------------------------------------------------------------


def test_pdfs_cached_by_an_older_release_are_not_served(client, tmp_path: Path):
    """What a cached PDF contains depends on the code that built it, not just on its spec."""
    nb = new_notebook(client, tmp_path, pages=2)
    with read_session() as db:
        user_id = db.scalar(select(User.id).where(User.username == "alice"))
        _node, spec = pdfbuild.notebook_spec(db, user_id, nb["id"], with_outline=False)
    # The previous release named cached files by the hash of the spec alone.
    canonical = json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    stale = pdf_cache_path(user_id, hashlib.sha256(canonical.encode()).hexdigest())
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_bytes(b"%PDF-1.7 built by an older release")
    r = client.get(f"/api/notebooks/{nb['id']}/pdf")
    assert r.status_code == 200
    assert len(pikepdf.open(io.BytesIO(r.content)).pages) == 2


def test_building_a_pdf_keeps_the_cache_within_its_limit(
    client, tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    """The cache limit also holds between the nightly maintenance runs."""
    monkeypatch.setenv("ACADEMIA_PDF_CACHE_MAX_MB", "1")
    config.get_settings.cache_clear()
    with read_session() as db:
        user_id = db.scalar(select(User.id).where(User.username == "alice"))
    cache = data_dir / "cache" / "pdf"
    (cache / user_id).mkdir(parents=True, exist_ok=True)
    for i in range(3):  # built earlier, e.g. for since-edited versions of notebooks
        old = cache / user_id / f"{i:064x}.pdf"
        old.write_bytes(b"x" * 400_000)
        os.utime(old, (time.time() - 600 + i, time.time() - 600 + i))
    nb = new_notebook(client, tmp_path, pages=2)
    r = client.get(f"/api/notebooks/{nb['id']}/pdf")
    assert r.status_code == 200
    files = list(cache.rglob("*.pdf"))
    assert sum(f.stat().st_size for f in files) <= 1024 * 1024
    assert pdf_cache_path(user_id, r.headers["etag"].strip('"')) in files
