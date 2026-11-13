"""One optional background operation per host; downloads never wait for GIFs."""
from contextlib import contextmanager
from collections import deque
import threading
import time


class WorkScheduler:
    def __init__(self, max_deferral=2.):
        self.max_deferral = max_deferral
        self._condition = threading.Condition()
        self._downloads = 0
        self._background = False
        self._waiters = deque()

    @contextmanager
    def foreground(self):
        with self._condition:
            self._downloads += 1
        try:
            yield
        finally:
            with self._condition:
                self._downloads -= 1
                self._condition.notify_all()

    @contextmanager
    def background(self, cancel):
        # A finite deferral preserves background progress during long downloads.
        deadline = time.monotonic() + self.max_deferral
        ticket = object()
        with self._condition:
            self._waiters.append(ticket)
            try:
                while self._background or self._waiters[0] is not ticket or self._downloads and time.monotonic() < deadline:
                    if cancel.is_set():
                        from download import Cancelled
                        raise Cancelled('Подготовка отменена')
                    self._condition.wait(.05)
                if cancel.is_set():
                    from download import Cancelled
                    raise Cancelled('Подготовка отменена')
                self._waiters.popleft()
                self._background = True
            except BaseException:
                self._waiters.remove(ticket)
                self._condition.notify_all()
                raise
        try:
            yield
        finally:
            with self._condition:
                self._background = False
                self._condition.notify_all()
