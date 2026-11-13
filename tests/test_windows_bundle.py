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
            owner = JobProcess([sys.executable, '-c', 'import os,sys;print(os.environ["VIDDOW_TEST"]);print("error",file=sys.stderr)'], stderr=errors, env={**os.environ, 'VIDDOW_TEST': 'кириллица % пробелы'})
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
