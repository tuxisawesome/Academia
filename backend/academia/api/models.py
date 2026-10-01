"""Mirror of the handwriting-recognition model files, for browsers.

Browsers run the recognition model themselves; they download its files from here rather
than from Hugging Face directly. That keeps the app's Content-Security-Policy strict
(``connect-src 'self'``), pins the exact model revision, and means each file is fetched
from the internet once per server. Files are downloaded on first request (streamed to the
browser while being saved) and served from disk afterwards. Only whitelisted repositories
at pinned revisions are allowed, so this is not an open proxy.
"""

from __future__ import annotations

import mimetypes
import os
import re
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse

from ..config import get_settings
from ..errors import AppError, NotFound
from ..models import new_id
from ..services.modelfiles import ALLOWED_MODELS, models_dir
from .deps import CurrentUser

router = APIRouter(tags=["models"])

_PATH_RE = re.compile(r"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$")
CHUNK = 1024 * 1024
IMMUTABLE = "private, max-age=31536000, immutable"


def _local_path(repo: str, revision: str, path: str) -> Path:
    return models_dir() / repo / revision / path


def _resolve_revision(repo: str, revision: str, path: str) -> str:
    """The pinned revision for this request. Some loaders (e.g. the tokenizer inside
    transformers.js' processor) ask for "main"; that is served as the pinned revision."""
    pinned = ALLOWED_MODELS.get(repo)
    if pinned is None or revision not in (pinned, "main"):
        raise NotFound()
    if not _PATH_RE.match(path) or ".." in path.split("/"):
        raise NotFound()
    return pinned


def _open_upstream(repo: str, revision: str, path: str):  # noqa: ANN202
    url = f"{get_settings().hf_endpoint.rstrip('/')}/{repo}/resolve/{revision}/{path}"
    request = urllib.request.Request(url, headers={"User-Agent": "Academia"})
    try:
        return urllib.request.urlopen(request, timeout=60)  # noqa: S310 - fixed, whitelisted host
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404):
            raise NotFound() from None
        raise AppError("Couldn't download the model file. Try again later.", code="upstream", status=502) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise AppError(
            "The server couldn't reach the model download site. Try again later.", code="upstream", status=502
        ) from None


def _stream_and_save(upstream, target: Path) -> Iterator[bytes]:  # noqa: ANN001
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(f"{target.name}.{new_id()}.part")
    complete = False
    try:
        with upstream, open(part, "wb") as fh:
            while True:
                chunk = upstream.read(CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
                yield chunk
        expected = upstream.headers.get("Content-Length")
        if expected is None or part.stat().st_size == int(expected):
            os.replace(part, target)
            complete = True
    finally:
        if not complete:
            part.unlink(missing_ok=True)


@router.get("/models/{owner}/{name}/resolve/{revision}/{path:path}")
async def model_file(owner: str, name: str, revision: str, path: str, _user: CurrentUser):
    repo = f"{owner}/{name}"
    revision = _resolve_revision(repo, revision, path)
    local = _local_path(repo, revision, path)
    media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if local.is_file():
        return FileResponse(local, media_type=media_type, headers={"Cache-Control": IMMUTABLE})
    upstream = await run_in_threadpool(_open_upstream, repo, revision, path)
    headers = {"Cache-Control": IMMUTABLE}
    if upstream.headers.get("Content-Length"):
        headers["Content-Length"] = upstream.headers["Content-Length"]
    return StreamingResponse(_stream_and_save(upstream, local), media_type=media_type, headers=headers)
