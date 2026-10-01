"""Process pool for PDF work.

Uses the ``forkserver`` start method: forking the multi-threaded web server process
directly is unsafe. A crashed worker (e.g. a pdfium segfault on a hostile file) breaks the
pool; it is recreated and the call retried once.
"""

from __future__ import annotations

import multiprocessing
import threading
import weakref
from collections.abc import Callable
from concurrent.futures import Future, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from typing import Any, TypeVar

from ..config import get_settings

T = TypeVar("T")

_pool: ProcessPoolExecutor | None = None
_pool_lock = threading.Lock()


def _get_pool() -> ProcessPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            ctx = multiprocessing.get_context("forkserver")
            ctx.set_forkserver_preload(["academia.workers.pdfops", "pikepdf", "PIL.Image"])
            _pool = ProcessPoolExecutor(
                max_workers=max(1, get_settings().pdf_workers),
                mp_context=ctx,
                max_tasks_per_child=200,
            )
        return _pool


def _reset(broken: ProcessPoolExecutor) -> None:
    global _pool
    with _pool_lock:
        if _pool is broken:
            _pool = None
    broken.shutdown(wait=False, cancel_futures=True)


def submit(fn: Callable[..., T], *args: Any) -> Future[T]:
    return _get_pool().submit(fn, *args)


def run(fn: Callable[..., T], *args: Any, timeout: float | None = 600) -> T:
    """Run ``fn(*args)`` in a worker process and wait for the result."""
    for attempt in range(2):
        pool = _get_pool()
        try:
            return pool.submit(fn, *args).result(timeout=timeout)
        except BrokenProcessPool:
            _reset(pool)
            if attempt:
                raise
    raise RuntimeError("unreachable")


def shutdown() -> None:
    global _pool
    with _pool_lock:
        pool, _pool = _pool, None
    if pool is not None:
        pool.shutdown(wait=True, cancel_futures=True)


class KeyedLocks:
    """One lock per key, so the same file is never built twice at once."""

    def __init__(self) -> None:
        self._locks: weakref.WeakValueDictionary[str, threading.Lock] = weakref.WeakValueDictionary()
        self._guard = threading.Lock()

    def get(self, key: str) -> threading.Lock:
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock
