from __future__ import annotations

import functools
import threading
from collections.abc import Iterator
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from academia import config
from academia.services.modelfiles import ALLOWED_MODELS, models_dir, prune_models

REPO = "onnx-community/Qwen3.5-0.8B-ONNX-OPT"
REV = ALLOWED_MODELS[REPO]


@pytest.fixture
def fake_hub(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A local HTTP server standing in for huggingface.co."""
    hub = tmp_path / "hub"
    files = hub / REPO / "resolve" / REV
    (files / "onnx").mkdir(parents=True)
    (files / "config.json").write_text('{"model_type": "qwen3_5"}')
    (files / "onnx" / "vision_encoder_q4f16.onnx_data").write_bytes(b"x" * 3_000_000)
    handler = functools.partial(QuietHandler, directory=str(hub))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("ACADEMIA_HF_ENDPOINT", f"http://127.0.0.1:{server.server_address[1]}")
    config.get_settings.cache_clear()
    yield hub
    server.shutdown()


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args) -> None:  # noqa: ANN002
        pass


def url(path: str, repo: str = REPO, rev: str = REV) -> str:
    return f"/api/models/{repo}/resolve/{rev}/{path}"


def test_model_files_are_mirrored(client, fake_hub: Path):
    r = client.get(url("config.json"))
    assert r.status_code == 200 and r.json() == {"model_type": "qwen3_5"}
    assert (models_dir() / REPO / REV / "config.json").is_file()
    big = client.get(url("onnx/vision_encoder_q4f16.onnx_data"))
    assert big.status_code == 200 and len(big.content) == 3_000_000
    assert "immutable" in big.headers["cache-control"]
    # Second request is served from disk, even without the upstream.
    (fake_hub / REPO / "resolve" / REV / "config.json").unlink()
    again = client.get(url("onnx/vision_encoder_q4f16.onnx_data"), headers={"Range": "bytes=0-9"})
    assert again.status_code == 206 and again.content == b"x" * 10
    assert client.get(url("config.json")).status_code == 200


def test_only_whitelisted_models(client, fake_hub: Path, anon):
    assert client.get(url("config.json", repo="evil/model")).status_code == 404
    assert client.get(url("config.json", rev="0123456789")).status_code == 404
    # "main" is served as the pinned revision (some loaders don't pass the revision through).
    assert client.get(url("config.json", rev="main")).json() == {"model_type": "qwen3_5"}
    assert client.get(url("missing.json")).status_code == 404
    assert client.get(url("onnx/../../secret")).status_code == 404
    assert anon.get(url("config.json")).status_code == 401


def test_prune_old_revisions(client, fake_hub: Path):
    client.get(url("config.json"))
    old = models_dir() / REPO / "0ld-revision"
    old.mkdir(parents=True)
    (old / "config.json").write_text("{}")
    assert prune_models() == 1
    assert not old.exists() and (models_dir() / REPO / REV / "config.json").exists()
