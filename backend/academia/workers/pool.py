"""Process pool for PDF work.

Uses the ``forkserver`` start method: forking the multi-threaded web server process
directly is unsafe.

A call whose caller stops waiting is dropped if it has not started yet. A started call
runs under a deadline, so a call stuck in pdfium cannot hold a worker for good: its worker
is killed. A dead worker (that, or e.g. a pdfium segfault on a hostile file) breaks the
pool; it is recreated, and the calls that were in it are retried once, each in a process
of its own, so the call that broke the pool cannot fail everyone else's calls again.

To bound the memory workers hold on to, a pool is replaced after a number of calls. The
pool does this itself: ``max_tasks_per_child`` can leave a pool without any workers on
CPython 3.13 releases that lack the fix for gh-115634.
"""

from __future__ import annotations

import multiprocessing
import signal
import threading
import weakref
from collections.abc import Callable
from concurrent.futures import Future, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from multiprocessing.context import BaseContext
from typing import Any, TypeVar

from ..config import get_settings

T = TypeVar("T")

# Calls a pool takes per worker before a fresh pool replaces it.
CALLS_PER_WORKER = 200
# How much longer than its caller waits a call may run before its worker is killed.
DEADLINE_GRACE = 5.0

_pool: ProcessPoolExecutor | None = None
_pool_calls_left = 0
_pool_lock = threading.Lock()
# Retried calls running at once, each in a process of its own.
_alone_slots = threading.BoundedSemaphore(2)


def _context() -> BaseContext:
    ctx = multiprocessing.get_context("forkserver")
    ctx.set_forkserver_preload(["academia.workers.pdfops", "academia.workers.pool", "pikepdf", "PIL.Image"])
    return ctx


def _call(fn: Callable[..., T], args: tuple[Any, ...], deadline: float | None) -> T:
    """Runs in a worker: ``fn(*args)``, ending the worker process if that takes longer than
    ``deadline`` seconds (the default action of SIGALRM works even inside pdfium)."""
    if deadline is not None:
        signal.setitimer(signal.ITIMER_REAL, deadline)
    try:
        return fn(*args)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


def _submit(fn: Callable[..., T], *args: Any) -> tuple[ProcessPoolExecutor, Future[T]]:
    global _pool, _pool_calls_left
    with _pool_lock:
        for _attempt in range(2):
            if _pool is None:
                workers = max(1, get_settings().pdf_workers)
                _pool = ProcessPoolExecutor(max_workers=workers, mp_context=_context())
                _pool_calls_left = CALLS_PER_WORKER * workers
            pool = _pool
            try:
                future = pool.submit(fn, *args)
            except BrokenProcessPool:
                # Broken by calls this one had no part in: a fresh pool will do.
                _pool = None
                pool.shutdown(wait=False, cancel_futures=True)
                continue
            _pool_calls_left -= 1
            if _pool_calls_left <= 0:
                # Retired: the calls it holds still run, then its workers exit.
                _pool = None
                pool.shutdown(wait=False)
            return pool, future
    raise RuntimeError("unreachable")


def _reset(broken: ProcessPoolExecutor) -> None:
    global _pool
    with _pool_lock:
        if _pool is broken:
            _pool = None
    broken.shutdown(wait=False, cancel_futures=True)


def submit(fn: Callable[..., T], *args: Any) -> Future[T]:
    return _submit(fn, *args)[1]


def run(fn: Callable[..., T], *args: Any, timeout: float | None = 600) -> T:
    """Run ``fn(*args)`` in a worker process and wait for the result."""
    deadline = None if timeout is None else timeout + DEADLINE_GRACE
    pool, future = _submit(_call, fn, args, deadline)
    try:
        return future.result(timeout=timeout)
    except TimeoutError:
        future.cancel()  # succeeds if it has not started, and then it never will
        raise
    except BrokenProcessPool:
        _reset(pool)
    # This call may be the one that broke the pool, so it must not share a process again.
    if not _alone_slots.acquire(timeout=timeout):  # the slots may be held by long calls
        raise TimeoutError
    try:
        alone = ProcessPoolExecutor(max_workers=1, mp_context=_context())
        try:
            return alone.submit(_call, fn, args, deadline).result(timeout=timeout)
        finally:
            alone.shutdown(wait=False, cancel_futures=True)
    finally:
        _alone_slots.release()


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
