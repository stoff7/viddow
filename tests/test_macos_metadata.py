import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from macos_metadata import _origin, complete_download_metadata


class MetadataTests(unittest.TestCase):
    def test_metadata_excludes_private_url_parts(self):
        self.assertEqual(_origin('https://user:password@cdn.example:8443/path?token=secret#id'),
                         'https://cdn.example:8443/')
        self.assertEqual(_origin('https://[::1]:9000/path'), 'https://[::1]:9000/')
        for url in ('file:///private/file', 'https://example:wrong/', None):
            self.assertEqual(_origin(url), '')

    @patch('macos_metadata.sys.platform', 'linux')
    @patch('macos_metadata.subprocess.run')
    def test_other_platforms_do_not_invoke_macos(self, run):
        complete_download_metadata('video.mp4', 'https://example.com/')
        run.assert_not_called()

    @unittest.skipUnless(sys.platform == 'darwin', 'public macOS URL API')
    def test_inherited_quarantine_is_completed_without_removing_protection(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'video.mp4'
            path.write_bytes(b'media fixture')
            digest = hashlib.sha256(path.read_bytes()).digest()
            subprocess.run(['xattr', '-w', 'com.apple.quarantine',
                            '0083;6af480d5;Vivaldi;', str(path)], check=True)
            complete_download_metadata(path, 'https://cdn.example/file?token=private')
            value = subprocess.check_output(['xattr', '-p', 'com.apple.quarantine', str(path)], text=True)
            flags, _, _, event = value.strip().split(';')
            self.assertTrue(int(flags, 16) & 1, 'quarantine retained')
            self.assertFalse(int(flags, 16) & 0x40, 'must not approve opening on behalf of user')
            self.assertTrue(event, 'system registered download event')
            self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), digest)

    @unittest.skipUnless(sys.platform == 'darwin', 'public macOS URL API')
    def test_unquarantined_file_stays_unquarantined(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'video.mp4'
            path.write_bytes(b'media fixture')
            # Temporary test files outside a browser have no quarantine context.
            before = subprocess.check_output(['xattr', str(path)], text=True)
            if 'com.apple.quarantine' in before.splitlines():
                self.skipTest('test process inherited quarantine')
            complete_download_metadata(path, 'https://example.com/')
            after = subprocess.check_output(['xattr', str(path)], text=True)
            self.assertNotIn('com.apple.quarantine', after.splitlines())
