"""Real WinAPI integration tests. Never substitute mocks or os.kill(pid, 0)."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "windows_process_tree.py"

if os.name == "nt":
    import ctypes as c
    from ctypes import wintypes as w
    from prototypes.windows_job import JobProcess, api, checked, CloseHandle, WaitForSingleObject
    OpenProcess = api("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
    HandleCount = api("GetProcessHandleCount", w.BOOL, w.HANDLE, c.POINTER(w.DWORD))
    CurrentProcess = api("GetCurrentProcess", w.HANDLE)


@unittest.skipUnless(os.name == "nt", "Requires real Windows Job Objects")
class WindowsJobTests(unittest.TestCase):
    def await_file(self, path):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if path.exists() and (path.suffix != ".pid" or path.read_text()):
                return
            time.sleep(0.02)
        self.fail(f"Fixture did not become ready: {path.name}")

    def leaf_handle(self, folder):
        marker = Path(folder, "leaf.pid")
        self.await_file(marker)
        return checked(OpenProcess(0x00100000, False, int(marker.read_text())))  # SYNCHRONIZE

    def assert_leaf_stopped(self, handle, folder):
        try:
            self.assertEqual(WaitForSingleObject(handle, 5000), 0)
            Path(folder, "locked.tmp").unlink()  # leaf released its file
        finally:
            checked(CloseHandle(handle))

    def test_parent_exits_before_concurrent_stop(self):
        with tempfile.TemporaryDirectory() as folder:
            owner = JobProcess([sys.executable, str(FIXTURE), "parent", folder])
            try:
                self.assertEqual(owner.wait(), 0)
                leaf = self.leaf_handle(folder)
                errors = []
                def stop():
                    try:
                        owner.stop()
                    except BaseException as error:
                        errors.append(error)
                threads = [threading.Thread(target=stop) for _ in range(2)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(8)
                    self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assert_leaf_stopped(leaf, folder)
            finally:
                owner.stop()

    def test_eof_and_abrupt_host_exit_kill_orphan(self):
        for crash in (False, True):
            with self.subTest(crash=crash), tempfile.TemporaryDirectory() as folder:
                controller = subprocess.Popen([sys.executable, str(FIXTURE), "controller", folder],
                                              stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
                try:
                    self.await_file(Path(folder, "controller.ready"))
                    leaf = self.leaf_handle(folder)
                    if crash:
                        controller.kill()
                    controller.stdin.close()
                    controller.wait(timeout=8)
                    self.assert_leaf_stopped(leaf, folder)
                finally:
                    if controller.poll() is None:
                        controller.kill()
                        controller.wait()
                    controller.stdin.close()

    def test_nested_job(self):
        with tempfile.TemporaryDirectory() as folder:
            outer = JobProcess([sys.executable, str(FIXTURE), "nested", folder])
            try:
                self.await_file(Path(folder, "controller.ready"))
                leaf = self.leaf_handle(folder)
                outer.stop()
                self.assert_leaf_stopped(leaf, folder)
            finally:
                outer.stop()

    def test_cancel_before_and_during_spawn(self):
        class CancelDuringSpawn:
            calls = 0
            def is_set(self):
                self.calls += 1
                return self.calls >= 2
        for cancel in (threading.Event(), CancelDuringSpawn()):
            if isinstance(cancel, threading.Event):
                cancel.set()
            with self.assertRaises(InterruptedError):
                JobProcess([sys.executable, "-c", "import time; time.sleep(30)"], cancel=cancel)

    def test_handles_do_not_grow(self):
        def count():
            value = w.DWORD()
            checked(HandleCount(CurrentProcess(), c.byref(value)))
            return value.value
        before = count()
        for _ in range(12):
            owner = JobProcess([sys.executable, "-c", "pass"])
            try:
                self.assertEqual(owner.wait(), 0)
            finally:
                owner.stop()
        self.assertLessEqual(count(), before + 1)


if __name__ == "__main__":
    unittest.main()
