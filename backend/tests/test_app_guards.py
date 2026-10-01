"""Regression tests for app wiring, sessions, user administration and the CLI (group BE-5b)."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import tracemalloc
from contextlib import closing
from datetime import timedelta
from pathlib import Path

import pikepdf
import pytest
from pydantic import ValidationError
from sqlalchemy import event, select
from typer.testing import CliRunner

from academia import cli, config
from academia.api.notebooks import BookmarkBody, BookmarkPagesBody, InsertBody, OrderBody, PagesBody, RotateBody
from academia.db import get_engine, read_session, write_session
from academia.models import Session, Source, User, utcnow
from academia.services.maintenance import backup_database, run_maintenance
from academia.services.thumbs import prewarmer
from academia.storage import source_path, thumb_dir
from conftest import ORIGIN, PASSWORD, add_user, new_notebook, page_texts, upload

MiB = 1024 * 1024

# Request bodies are limited before FastAPI reads and parses them (that happens before
# the sign-in check).


def _ids_body(size: int) -> bytes:
    return ('{"ids":[' + ",".join(['"ab"'] * (size // 5)) + "]}").encode()


def test_oversized_anonymous_body_is_refused_unread(anon):
    r = anon.post("/api/nodes/trash", content=_ids_body(3 * MiB), headers={"Content-Type": "application/json"})
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "too_large"
    # Not even parsed: invalid JSON gets the same answer instead of a JSON decode error.
    r = anon.post("/api/auth/login", content=b"{" * (3 * MiB), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_streamed_body_is_cut_off_at_the_limit(app):
    chunk = b'"ab",' * (MiB // 5)
    calls = 0

    async def receive():
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"type": "http.request", "body": b'{"ids":[', "more_body": True}
        if calls <= 9:
            return {"type": "http.request", "body": chunk, "more_body": True}
        return {"type": "http.request", "body": b'"ab"]}', "more_body": False}

    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/auth/login",
        "raw_path": b"/api/auth/login",
        "root_path": "",
        "query_string": b"",
        # Chunked: no Content-Length to check up front.
        "headers": [(b"host", b"testserver"), (b"origin", ORIGIN.encode()), (b"content-type", b"application/json")],
        "client": ("10.0.0.1", 1234),
        "server": ("testserver", 80),
    }
    asyncio.run(asyncio.wait_for(app(scope, receive, send), 60))
    assert sent[0]["status"] == 413
    assert json.loads(b"".join(m.get("body", b"") for m in sent[1:]))["error"]["code"] == "too_large"
    assert calls <= 4


def _big_pdf(path: Path, size: int) -> Path:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 400))
    pdf.pages[0].obj.Contents = pdf.make_stream(b"%" + b"x" * size + b"\n")
    pdf.save(path, compress_streams=False)
    return path


def test_normal_bodies_and_large_uploads_still_work(client, tmp_path: Path):
    r = client.post("/api/folders", json={"name": "Big request", "padding": "x" * (3 * MiB // 2)})
    assert r.status_code == 200, r.text
    big = _big_pdf(tmp_path / "big.pdf", 3 * MiB)
    assert upload(client, big)["page_count"] == 1


def test_invalid_page_list_is_rejected_without_an_error_per_item(client, tmp_path: Path):
    """Within the limit, a signed-in user's list of invalid items must not become one
    validation error object per item (about 500 bytes each)."""
    nb = new_notebook(client, tmp_path, pages=2)
    body = ('{"page_ids":[' + ",".join(["0"] * 250_000) + "]}").encode()
    tracemalloc.start()
    try:
        r = client.put(
            f"/api/notebooks/{nb['id']}/pages/order", content=body, headers={"Content-Type": "application/json"}
        )
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert r.status_code == 422
    assert r.json()["error"]["message"] == "page_ids.0: Input should be a valid string"
    assert peak < 32 * MiB


@pytest.mark.parametrize(
    ("model", "data"),
    [
        (InsertBody, {"source_id": "s", "add_to_bookmarks": [0] * 100}),
        (OrderBody, {"page_ids": [0] * 100}),
        (PagesBody, {"page_ids": [0] * 100}),
        (RotateBody, {"page_ids": [0] * 100, "delta": 90}),
        (BookmarkBody, {"name": "b", "notebook_id": "n", "page_ids": [0] * 100}),
        (BookmarkPagesBody, {"page_ids": [0] * 100}),
    ],
)
def test_page_id_lists_stop_at_the_first_invalid_item(model, data):
    with pytest.raises(ValidationError) as exc:
        model.model_validate(data)
    assert len(exc.value.errors()) == 1


# Renewing a session is bookkeeping and must not fail the request.


def _age_sessions() -> None:
    with write_session() as db:
        for session in db.scalars(select(Session)):
            session.last_seen_at = utcnow() - timedelta(minutes=11)


def test_session_renewal_gives_way_to_a_long_write(client):
    engine = get_engine()

    @event.listens_for(engine, "connect")
    def _short_busy_timeout(dbapi_conn, _record):  # noqa: ANN001
        dbapi_conn.execute("PRAGMA busy_timeout=100")

    engine.dispose()
    _age_sessions()
    writer = sqlite3.connect(config.get_settings().db_path, isolation_level=None)
    try:
        writer.execute("BEGIN IMMEDIATE")
        r = client.get("/api/nodes")
        assert r.status_code == 200, r.text
        assert r.headers.get("set-cookie") is None
    finally:
        writer.execute("ROLLBACK")
        writer.close()
    # Once the database is free again, the next request renews the session.
    r = client.get("/api/nodes")
    assert r.status_code == 200
    assert r.headers.get("set-cookie")
    with read_session() as db:
        assert utcnow() - db.scalars(select(Session)).one().last_seen_at < timedelta(minutes=1)


# `academia reset-password` changes the password only.


def test_cli_reset_password_keeps_a_disabled_account_disabled(client, anon):
    uid = add_user("bob")
    assert client.patch(f"/api/admin/users/{uid}", json={"disabled": True}).status_code == 200
    r = CliRunner().invoke(cli.app, ["reset-password", "bob", "--password", "a brand new password"])
    assert r.exit_code == 0, r.output
    assert "academia enable bob" in r.output
    with read_session() as db:
        assert db.get(User, uid).disabled_at is not None
    r = anon.post("/api/auth/login", json={"username": "bob", "password": "a brand new password"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "disabled"


# The SPA fallback for paths no file can have.


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>Academia</title>")
    return root


@pytest.mark.parametrize("path", ["/%00", "/" + "a" * 300, "/assets/" + "a" * 300])
def test_spa_fallback_for_impossible_paths(anon, dist, path):
    r = anon.get(path)
    assert r.status_code == 200 and "Academia" in r.text
    assert "default-src 'self'" in r.headers["content-security-policy"]


@pytest.mark.parametrize("path", ["/%00.js", "/assets/" + "a" * 300 + ".js"])
def test_impossible_asset_paths_are_not_found(anon, dist, path):
    r = anon.get(path)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


# Display names can't carry terminal control sequences.

OSC_52 = "\x1b]52;c;ZWNobyBwd25lZA==\x07"


def test_display_names_drop_control_characters(client, other_client):
    r = other_client.patch("/api/me/profile", json={"display_name": f"{OSC_52}Bob\u202e \t Builder"})
    assert r.status_code == 200, r.text
    assert r.json()["display_name"] == "]52;c;ZWNobyBwd25lZA==Bob Builder"
    r = client.post("/api/admin/users", json={"username": "carl", "display_name": "\x1b[2K\x1b[1ACarl"})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["display_name"] == "[2K[1ACarl"
    r = client.patch(f"/api/admin/users/{r.json()['user']['id']}", json={"display_name": "Carl\x9b\x00 K\u200d"})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["display_name"] == "Carl K\u200d"
    with read_session() as db:
        names = set(db.scalars(select(User.display_name)))
    assert not any(ch in name for name in names for ch in "\x1b\x07\x9b\x00\u202e")


def test_cli_list_users_escapes_control_characters(data_dir):
    uid = add_user("bob")
    with write_session() as db:  # stored before display names were cleaned
        db.get(User, uid).display_name = f"{OSC_52}Bob"
    r = CliRunner().invoke(cli.app, ["list-users"])
    assert r.exit_code == 0, r.output
    assert "\x1b" not in r.output and "\x07" not in r.output
    assert "\\x1b]52;c;ZWNobyBwd25lZA==\\x07Bob" in r.output


# Behind a proxy that rewrites Host, the browser's Sec-Fetch-Site still identifies the
# app's own requests.

PROXIED = {"Host": "127.0.0.1:8080", "Origin": "https://academia.example.com"}


def test_same_origin_requests_pass_behind_a_host_rewriting_proxy(anon):
    add_user("carol")
    headers = {**PROXIED, "Sec-Fetch-Site": "same-origin"}
    r = anon.post("/api/auth/login", json={"username": "carol", "password": PASSWORD}, headers=headers)
    assert r.status_code == 200, r.text
    r = anon.post("/api/folders", json={"name": "Notes"}, headers=headers)
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("site", ["cross-site", "same-site", "none", None])
def test_other_requests_still_need_a_matching_origin(client, site):
    headers = dict(PROXIED)
    if site:
        headers["Sec-Fetch-Site"] = site
    r = client.post("/api/folders", json={"name": "Notes"}, headers=headers)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "bad_origin"
    headers = {"Origin": "https://evil.example", "Sec-Fetch-Site": site or "cross-site"}
    assert client.post("/api/folders", json={"name": "Notes"}, headers=headers).status_code == 403


# A deleted user's PDFs are kept for the grace period, like other unused uploads.


def _sources_of(user_id: str) -> list[str]:
    with read_session() as db:
        return list(db.scalars(select(Source.id).where(Source.owner_id == user_id)))


def test_backup_from_before_a_user_deletion_restores_with_its_pdfs(client, other_client, tmp_path, monkeypatch):
    nb = new_notebook(other_client, tmp_path, pages=2)
    bob_id = other_client.get("/api/auth/me").json()["id"]
    [sid] = _sources_of(bob_id)
    backup = backup_database(keep=0, label="test")
    assert client.delete(f"/api/admin/users/{bob_id}").status_code == 200
    assert source_path(sid).exists()

    # Restore the backup (SQLite's backup API can write into the live database).
    with closing(sqlite3.connect(backup)) as src, closing(sqlite3.connect(config.get_settings().db_path)) as dst:
        src.backup(dst)
    assert page_texts(other_client.get(f"/api/notebooks/{nb['id']}/pdf").content) == ["p1", "p2"]

    # Maintenance leaves the files of uploads that are in use again.
    monkeypatch.setenv("ACADEMIA_ORPHAN_SOURCE_GRACE_DAYS", "0")
    config.get_settings.cache_clear()
    assert run_maintenance()["deleted_users_files"] == 0
    assert list(source_path(sid).parent.iterdir()) == [source_path(sid)]
    assert page_texts(other_client.get(f"/api/notebooks/{nb['id']}/pdf").content) == ["p1", "p2"]


def test_deleted_users_pdfs_are_removed_after_the_grace_period(client, other_client, tmp_path, monkeypatch):
    new_notebook(other_client, tmp_path, pages=2)
    bob_id = other_client.get("/api/auth/me").json()["id"]
    [sid] = _sources_of(bob_id)
    assert other_client.get(f"/api/thumbs/{sid}/0").status_code == 200
    prewarmer.stop()  # so that no background rendering recreates the thumbnails removed below
    assert client.delete(f"/api/admin/users/{bob_id}").status_code == 200
    assert run_maintenance()["deleted_users_files"] == 0
    assert source_path(sid).exists() and thumb_dir(sid).exists()

    monkeypatch.setenv("ACADEMIA_ORPHAN_SOURCE_GRACE_DAYS", "0")
    config.get_settings.cache_clear()
    assert run_maintenance()["deleted_users_files"] == 1
    assert not source_path(sid).exists()
    assert not thumb_dir(sid).exists()
    assert list(source_path(sid).parent.iterdir()) == []


# An extra `academia backup` must not prune the nightly backups.


def test_cli_backup_keeps_the_nightly_backups(data_dir):
    backups = data_dir / "backups"
    backups.mkdir(exist_ok=True)
    nightly = [backups / f"academia-nightly-200001{day:02d}-024500.db" for day in range(1, 15)]
    for path in nightly:
        path.write_bytes(b"")
    r = CliRunner().invoke(cli.app, ["backup"])
    assert r.exit_code == 0, r.output
    made = Path(r.stdout.strip().splitlines()[-1])
    assert made.parent == backups and made.name.startswith("academia-manual-")
    assert all(path.exists() for path in nightly)
    # The nightly timer passes its label and retention explicitly.
    r = CliRunner().invoke(cli.app, ["backup", "--label", "nightly", "--keep", "14"])
    assert r.exit_code == 0, r.output
    assert not nightly[0].exists()
    assert len(list(backups.glob("academia-nightly-*.db"))) == 14
    assert made.exists()
