"""Per-execution measurements and fixed fragment shares; no source context is logged."""
from contextvars import ContextVar
from functools import wraps
import os
import time
import uuid

from trace_log import trace_event

CURRENT = ContextVar('download_attempt', default=None)
DEFAULT_FRAGMENT_BUDGET = 32


def fragment_budget(value=None):
    if value is None:
        value = os.environ.get('VIDDOW_FRAGMENT_BUDGET', str(DEFAULT_FRAGMENT_BUDGET))
    if isinstance(value, str) and value.isascii() and value.isdecimal():
        value = int(value)
    if type(value) is not int or not 1 <= value <= 64:
        raise ValueError('VIDDOW_FRAGMENT_BUDGET: требуется целое число от 1 до 64')
    return value


def fragment_share(budget, workers):
    return min(16, budget // min(workers, budget))


class Attempt:
    def __init__(self, *, queued=None, attempt_tag=None, fragments=None):
        self.started = time.monotonic()
        self.queued = self.started if queued is None else queued
        self.attempt_tag = attempt_tag or uuid.uuid4().hex
        self.run_tag = uuid.uuid4().hex
        self.fragments = fragments if fragments is not None else min(16, fragment_budget())
        self.first = self.finishing = None
        self.observed_bytes = 0
        self._tracks = {}

    def __enter__(self):
        self.token = CURRENT.set(self)
        return self

    def bytes(self, done, track='direct'):
        if not isinstance(done, (int, float)) or done <= 0:
            return
        if self.first is None:
            self.first = time.monotonic()
        # Tool progress is a cumulative high-water mark, not wire/retry bytes.
        previous = self._tracks.get(track, 0)
        self.observed_bytes += max(0, int(done) - previous)
        self._tracks[track] = max(previous, int(done))

    def finish_transfer(self):
        if self.first is not None and self.finishing is None:
            self.finishing = time.monotonic()

    def __exit__(self, kind, error, traceback):
        end = time.monotonic()
        ms = lambda delta: max(0, int(delta * 1000))
        fields = dict(attempt_tag=self.attempt_tag, run_tag=self.run_tag,
                      elapsed_ms=ms(end - self.queued), queue_ms=ms(self.started - self.queued),
                      fragment_workers=self.fragments,
                      status='done' if error is None else 'cancelled' if kind.__name__ == 'Cancelled' else 'error')
        if self.first is not None:
            fields.update(first_byte_ms=ms(self.first - self.queued),
                          preparation_ms=ms(self.first - self.started),
                          transfer_ms=ms((self.finishing or end) - self.first),
                          observed_bytes=self.observed_bytes)
        if self.finishing is not None:
            fields['finishing_ms'] = ms(end - self.finishing)
        try:
            trace_event('download_timing', **fields)
        finally:
            CURRENT.reset(self.token)


def measured(function):
    @wraps(function)
    def wrapper(*args, **kwargs):
        if CURRENT.get() is not None:
            return function(*args, **kwargs)
        with Attempt():
            return function(*args, **kwargs)
    return wrapper


def observed_bytes(done, track='direct'):
    if attempt := CURRENT.get():
        attempt.bytes(done, track)


def finishing():
    if attempt := CURRENT.get():
        attempt.finish_transfer()


def fragments():
    attempt = CURRENT.get()
    return attempt.fragments if attempt else min(16, fragment_budget())
