"""The Academia web application: JSON API under ``/api`` plus the built frontend."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy import text
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .api.deps import set_session_cookie
from .config import build_info, get_settings
from .db import get_engine, init_engine, read_session
from .errors import AppError
from .migrations import upgrade_head
from .services.export import fail_interrupted_jobs
from .services.textindex import text_indexer
from .services.thumbs import prewarmer
from .storage import ensure_dirs
from .workers import pool

log = logging.getLogger("academia")

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# Largest request body of an API call. FastAPI reads and parses a JSON body before it checks
# who is signed in, so without a limit anyone could make the server hold any amount of data.
# The largest real body, a notebook's whole page order, takes about 40 bytes per page. PDF
# uploads stream to disk instead and have their own limit (max_upload_mb).
MAX_BODY_BYTES = 2 * 1024 * 1024
UPLOAD_PATH = "/api/sources"
BODY_TOO_LARGE = "This request is too large."

CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)


def _limit_body(receive: Receive) -> Receive:
    """``receive`` that fails with 413 once the body passes MAX_BODY_BYTES.

    This also covers chunked bodies, which have no Content-Length to check up front.
    """
    received = 0

    async def limited() -> Message:
        nonlocal received
        message = await receive()
        if message["type"] == "http.request":
            received += len(message.get("body", b""))
            if received > MAX_BODY_BYTES:
                # FastAPI passes an HTTPException raised while it reads the body on to the handler.
                raise StarletteHTTPException(413, BODY_TOO_LARGE)
        return message

    return limited


class GuardMiddleware:
    """Rejects cross-origin state-changing API requests (CSRF) and oversized request bodies,
    and adds common headers.

    It also sends the session cookie again, with a fresh lifetime, when the request renewed
    the session (see ``deps._load_session``).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.version = build_info()["build_id"]

    @staticmethod
    def _origin_ok(headers: Headers) -> bool:
        # Browsers say whether a request comes from a page of the same origin. Unlike comparing
        # Origin with Host, this also works behind a proxy that rewrites the Host header.
        if headers.get("sec-fetch-site") == "same-origin":
            return True
        origin = headers.get("origin") or headers.get("referer")
        if not origin:
            return False
        extra = get_settings().extra_origins
        parts = urlsplit(origin)
        if f"{parts.scheme}://{parts.netloc}" in extra:
            return True
        return parts.netloc.lower() == (headers.get("host") or "").lower()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope["path"]
        unsafe = path.startswith("/api/") and scope["method"] not in SAFE_METHODS
        if unsafe and not self._origin_ok(Headers(scope=scope)):
            response = JSONResponse(
                {"error": {"code": "bad_origin", "message": "Request blocked: unexpected origin."}},
                status_code=403,
            )
            await response(scope, receive, send)
            return
        if unsafe and path != UPLOAD_PATH:
            length = Headers(scope=scope).get("content-length", "")
            if length.isdigit() and int(length) > MAX_BODY_BYTES:
                await _error(413, "too_large", BODY_TOO_LARGE)(scope, receive, send)
                return
            receive = _limit_body(receive)

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-App-Version"] = self.version
                headers.setdefault("X-Content-Type-Options", "nosniff")
                headers.setdefault("Referrer-Policy", "same-origin")
                headers.setdefault("X-Frame-Options", "DENY")
                headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
                headers.setdefault("Content-Security-Policy", CSP)
                if path.startswith("/api/"):
                    headers.setdefault("Cache-Control", "no-store")
                renewed = scope.get("state", {}).get("renew_session")
                if renewed and message["status"] != 401:
                    cookie = Response()
                    set_session_cookie(cookie, renewed, secure=scope["scheme"] == "https")
                    headers.append("set-cookie", cookie.headers["set-cookie"])
            await send(message)

        await self.app(scope, receive, send_wrapper)


def _error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, **extra}}, status_code=status)


def _register_errors(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(_request: Request, exc: AppError) -> JSONResponse:
        return _error(exc.status, exc.code, exc.message, **exc.extra)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(p) for p in first.get("loc", [])[1:])
        message = first.get("msg", "Invalid request.")
        return _error(422, "validation", f"{field}: {message}" if field else message)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed", 413: "too_large"}.get(exc.status_code, "http_error")
        return _error(exc.status_code, code, str(exc.detail))


def _mount_frontend(app: FastAPI) -> None:
    dist = get_settings().frontend_dist

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def frontend(full_path: str) -> Any:
        if full_path.startswith("api/") or full_path == "api":
            return _error(404, "not_found", "Not found.")
        root = dist.resolve()
        index = root / "index.html"
        if full_path:
            try:
                candidate = (root / full_path).resolve()
                found = candidate.is_relative_to(root) and candidate.is_file()
            except (OSError, ValueError):
                # A name no file can have, e.g. with a NUL byte or longer than the system allows.
                found = False
            if found:
                if full_path.startswith("assets/"):
                    cache = "public, max-age=31536000, immutable"
                elif full_path.startswith(("pdfjs/", "fonts/", "icons/")):
                    cache = "public, max-age=86400"
                else:
                    cache = "no-cache"
                headers = {"Cache-Control": cache}
                if full_path == "sw.js":
                    headers["Service-Worker-Allowed"] = "/"
                return FileResponse(candidate, headers=headers)
            if Path(full_path).suffix and not full_path.endswith(".html"):
                return _error(404, "not_found", "Not found.")
        if not index.is_file():
            return JSONResponse(
                {"error": {"code": "frontend_missing", "message": "The frontend has not been built."}},
                status_code=503,
            )
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


def create_app() -> FastAPI:
    settings = get_settings()
    ensure_dirs()
    init_engine(settings.db_path)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        upgrade_head()
        fail_interrupted_jobs()
        prewarmer.start()
        text_indexer.start(backfill=True)
        yield
        text_indexer.stop()
        prewarmer.stop()
        pool.shutdown()

    app = FastAPI(
        title="Academia",
        version=build_info()["version"],
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    _register_errors(app)

    from .api import admin, auth, files, nodes, notebooks, search

    for module in (auth, admin, nodes, notebooks, files, search):
        app.include_router(module.router, prefix="/api")

    @app.api_route("/api/health", methods=["GET", "HEAD"], tags=["meta"])
    def health() -> dict[str, Any]:
        info = build_info()
        db_ok = True
        try:
            with read_session() as db:
                db.execute(text("SELECT 1"))
        except Exception:  # noqa: BLE001
            db_ok = False
        return {"status": "ok" if db_ok else "degraded", "db": db_ok, **info}

    _mount_frontend(app)
    app.add_middleware(GuardMiddleware)
    get_engine()
    return app
