from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>Academia</title>")
    (root / "assets" / "app-abc123.js").write_text("console.log(1)")
    (root / "sw.js").write_text("// sw")
    return root


def test_spa_serving(anon, dist):
    r = anon.get("/")
    assert r.status_code == 200 and "Academia" in r.text
    assert r.headers["cache-control"] == "no-cache"
    assert "default-src 'self'" in r.headers["content-security-policy"]

    r = anon.get("/f/some-folder/deep/link")
    assert r.status_code == 200 and "Academia" in r.text  # client-side route

    r = anon.get("/assets/app-abc123.js")
    assert r.status_code == 200
    assert "immutable" in r.headers["cache-control"]

    r = anon.get("/sw.js")
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers["service-worker-allowed"] == "/"

    assert anon.get("/assets/missing.js").status_code == 404
    assert anon.get("/api/nope").status_code == 404
    assert anon.head("/").status_code == 200
    assert anon.head("/api/health").status_code == 200


def test_no_path_traversal(anon, dist, tmp_path: Path):
    (tmp_path / "secret.txt").write_text("secret")
    r = anon.get("/..%2Fsecret.txt")
    assert "secret" not in r.text
    r = anon.get("/assets/..%2F..%2Fsecret.txt")
    assert "secret" not in r.text
