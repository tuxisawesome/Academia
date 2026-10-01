"""Model files mirrored for in-browser handwriting recognition (see ``api/models.py``)."""

from __future__ import annotations

import shutil
from pathlib import Path

from ..storage import data_dir

# Repository -> pinned revision. Keep in sync with frontend/src/features/recognition/engine.ts.
ALLOWED_MODELS: dict[str, str] = {
    "onnx-community/Qwen3.5-2B-ONNX-OPT": "2ea7886f48b926aca97de8b0e041ffca7e3ebaa9",
    "onnx-community/Qwen3.5-0.8B-ONNX-OPT": "fafab72d87a9e6be3925b38caf48286d2838f2d0",
}


def models_dir() -> Path:
    return data_dir() / "models"


def prune_models() -> int:
    """Delete downloaded files of models/revisions no longer in use (e.g. after an update)."""
    root = models_dir()
    removed = 0
    if not root.is_dir():
        return 0
    for owner in (p for p in root.iterdir() if p.is_dir()):
        for name in (p for p in owner.iterdir() if p.is_dir()):
            repo = f"{owner.name}/{name.name}"
            for rev in (p for p in name.iterdir() if p.is_dir()):
                if ALLOWED_MODELS.get(repo) != rev.name:
                    shutil.rmtree(rev, ignore_errors=True)
                    removed += 1
    return removed
