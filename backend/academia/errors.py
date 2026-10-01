"""Application errors, rendered as ``{"error": {"code", "message"}}`` JSON responses."""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    status = 400

    def __init__(self, message: str, code: str | None = None, status: int | None = None, **extra: Any) -> None:
        super().__init__(message)
        self.message = message
        self.code = code or self.__class__.__name__.removesuffix("Error").lower() or "error"
        if status is not None:
            self.status = status
        self.extra = extra


class BadRequest(AppError):
    status = 400


class Unauthorized(AppError):
    status = 401


class Forbidden(AppError):
    status = 403


class NotFound(AppError):
    status = 404

    def __init__(self, message: str = "Not found.", **kw: Any) -> None:
        super().__init__(message, code="not_found", **kw)


class Conflict(AppError):
    status = 409


class TooLarge(AppError):
    status = 413


class Unprocessable(AppError):
    status = 422


class TooManyRequests(AppError):
    status = 429
