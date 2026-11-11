import threading
import time
import unittest

import download
from jobs import Conflict, JobManager


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Состояние не наступило до таймаута")


class JobTests(unittest.TestCase):
    def manager(self, **kwargs):
        manager = JobManager(**kwargs)
        self.addCleanup(manager.close)
        return manager

    def test_limit_fifo_and_queued_cancel(self):
        started, releases, lock = [], {}, threading.Lock()

        def runner(url, cancel, **kwargs):
            with lock:
                started.append(url)
                releases[url] = threading.Event()
            while not releases[url].wait(0.01):
                download.check_cancel(cancel)
            return "/tmp/" + url

        manager = self.manager(workers=2, runner=runner)
        ids = manager.add(["one", "two", "three", "four"])
        wait_for(lambda: len(started) == 2)
        self.assertEqual(set(started), {"one", "two"})
        self.assertEqual([job["status"] for job in manager.snapshots()], ["running", "running", "queued", "queued"])
        self.assertEqual(manager.cancel(ids[2])["status"], "cancelled")
        releases["one"].set()
        wait_for(lambda: len(started) == 3)
        self.assertEqual(started[2], "four")

    def test_cancel_keeps_slot_until_runner_exits(self):
        entered, cancelled, release, second = (threading.Event() for _ in range(4))

        def runner(url, cancel, **kwargs):
            if url == "first":
                entered.set()
                cancel.wait(3)
                cancelled.set()
                release.wait(3)
                download.check_cancel(cancel)
            second.set()
            return "/tmp/second"

        manager = self.manager(workers=1, runner=runner)
        ids = manager.add(["first", "second"])
        self.assertTrue(entered.wait(1))
        self.assertEqual(manager.cancel(ids[0])["status"], "cancelling")
        self.assertTrue(cancelled.wait(1))
        self.assertFalse(second.is_set())
        self.assertEqual(manager.snapshots()[1]["status"], "queued")
        release.set()
        self.assertTrue(second.wait(1))
        wait_for(lambda: manager.snapshots()[0]["status"] == "cancelled")

    def test_retry_preserves_options_and_hides_headers(self):
        attempts = []

        def runner(url, **kwargs):
            attempts.append((url, kwargs))
            if len(attempts) == 1:
                raise RuntimeError("temporary error")
            return "/tmp/saved.mp4"

        manager = self.manager(runner=runner)
        first = manager.add(["https://example.com/watch"], name="Title", headers={"Cookie": "private"},
                            source_kind="page", referer="https://example.com/")[0]
        wait_for(lambda: manager.snapshots()[0]["status"] == "error")
        self.assertNotIn("private", str(manager.snapshots()))
        second = manager.retry(first)
        self.assertNotEqual(first, second)
        wait_for(lambda: manager.snapshots()[1]["status"] == "done")
        self.assertEqual(attempts[1][1]["browser_headers"], {"Cookie": "private"})
        self.assertEqual(attempts[1][1]["source_kind"], "page")
        with self.assertRaises(Conflict):
            manager.retry(second)
        self.assertEqual(manager.cancel(second)["status"], "done")
        manager.clear()
        self.assertEqual(manager.snapshots(), [])

    def test_capacity_is_atomic_and_clear_preserves_active(self):
        def runner(url, cancel, **kwargs):
            cancel.wait(3)
            download.check_cancel(cancel)

        manager = self.manager(workers=1, runner=runner, max_pending=2)
        manager.add(["one"])
        with self.assertRaises(Conflict):
            manager.add(["two", "three"])
        self.assertEqual(len(manager.snapshots()), 1)
        manager.clear()
        self.assertEqual(len(manager.snapshots()), 1)
        manager.close()
        with self.assertRaises(Conflict):
            manager.add(["closed"])
        self.assertEqual(manager.snapshots()[0]["status"], "cancelled")

    def test_completed_file_wins_cancellation_at_finish(self):
        entered = threading.Event()

        def runner(url, cancel, **kwargs):
            entered.set()
            cancel.wait(3)
            return "/tmp/already-finished.mp4"

        manager = self.manager(runner=runner)
        job = manager.add(["video"])[0]
        entered.wait(1)
        manager.cancel(job)
        wait_for(lambda: manager.snapshots()[0]["status"] == "done")
        self.assertEqual(manager.snapshots()[0]["path"], "/tmp/already-finished.mp4")


if __name__ == "__main__":
    unittest.main()
