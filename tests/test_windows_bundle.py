import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import platform_support
import windows_bundle


class BundleResolutionTests(unittest.TestCase):
    def test_bundle_never_uses_path_or_overrides(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(platform_support, 'BUNDLED', True), patch.object(platform_support, 'BIN_DIR', Path(folder)), patch.dict(os.environ, {'VIDDOW_FFMPEG': sys.executable}):
                with self.assertRaises(platform_support.ToolConfigurationError):
                    platform_support.resolve_tool('ffmpeg')
                self.assertIsNone(platform_support.resolve_tool('node'))

    def test_integrity_rejects_corruption(self):
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'tool').write_bytes(b'good')
            (root / 'components.json').write_text(json.dumps({'files': [{'path': 'tool', 'sha256': hashlib.sha256(b'good').hexdigest()}]}))
            windows_bundle.verify(root)
            (root / 'tool').write_bytes(b'bad')
            with self.assertRaises(ValueError):
                windows_bundle.verify(root)


@unittest.skipUnless(os.name == 'nt', 'Real Windows handles required')
class WindowsProductionProcessTests(unittest.TestCase):
    def test_pipes_unicode_environment_and_exit_code(self):
        from windows_process import JobProcess
        with tempfile.TemporaryFile('w+', encoding='utf-8') as errors:
            owner = JobProcess([sys.executable, '-c', 'import os,sys;print(os.environ["VIDDOW_TEST"]);print("error",file=sys.stderr)'], stderr=errors, env={**os.environ, 'VIDDOW_TEST': 'кириллица % пробелы', 'PYTHONIOENCODING': 'utf-8'})
            try:
                self.assertEqual(owner.stdout.read().strip(), 'кириллица % пробелы')
                self.assertEqual(owner.wait(timeout=5), 0)
                errors.seek(0)
                self.assertIn('error', errors.read())
            finally:
                owner.stop()
                owner.stdout.close()

    def test_stop_interrupts_wait_and_releases_pipe(self):
        from windows_process import JobProcess
        import threading
        owner = JobProcess([sys.executable, '-c', 'import time;time.sleep(60)'])
        thread = threading.Thread(target=owner.wait)
        thread.start()
        try:
            owner.stop()
            thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(owner.stdout.read(), '')
        finally:
            owner.stop()
            owner.stdout.close()


if os.name == 'nt':
    import test_windows_job as job_tests
    from windows_process import JobProcess

    class ProductionJobTreeTests(job_tests.WindowsJobTests):
        """Run the same orphan/crash/nested/concurrent-stop acceptance on production."""
        def setUp(self):
            self.owner_patch = patch.object(job_tests, 'JobProcess', JobProcess)
            self.env_patch = patch.dict(os.environ, {'VIDDOW_TEST_JOB_IMPLEMENTATION': 'production'})
            self.owner_patch.start()
            self.env_patch.start()
            self.addCleanup(self.owner_patch.stop)
            self.addCleanup(self.env_patch.stop)

        def test_handles_do_not_grow(self):
            import ctypes as c
            from ctypes import wintypes as w
            def count():
                value = w.DWORD()
                job_tests.checked(job_tests.HandleCount(job_tests.CurrentProcess(), c.byref(value)))
                return value.value
            before = count()
            for _ in range(12):
                owner = JobProcess([sys.executable, '-c', 'pass'])
                try:
                    self.assertEqual(owner.wait(timeout=5), 0)
                finally:
                    owner.stop()
                    owner.stdout.close()
            self.assertLessEqual(count(), before + 1)
