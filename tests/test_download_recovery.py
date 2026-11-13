"""Real loopback recovery, with byte integrity and adversarial version/range changes."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import download
import download_recovery
from partial_store import PartsStore, digest


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = self.temporary.name
        self.data = bytes(range(256)) * 4096
        self.etag = '"v1"'
        self.disconnects = 0
        self.fail_code = None
        self.ignore_range = False
        self.bad_range = False
        self.ranges, self.sent, self.gets = [], 0, 0
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_HEAD(self): self.respond(True)
            def do_GET(self): self.respond(False)
            def respond(self, head):
                if not head:
                    owner.gets += 1
                if owner.fail_code:
                    self.send_response(owner.fail_code)
                    self.send_header('Retry-After', '0')
                    self.send_header('Content-Length', '0')
                    self.end_headers(); return
                offset = 0
                if self.headers.get('Range') and not head:
                    owner.ranges.append(self.headers['Range'])
                    if not owner.ignore_range:
                        offset = int(self.headers['Range'][6:].split('-')[0])
                self.send_response(206 if offset else 200)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('Content-Length', str(len(owner.data) - offset))
                if owner.etag:
                    self.send_header('ETag', owner.etag)
                if offset:
                    self.send_header('Content-Range', f'bytes {offset + int(owner.bad_range)}-{len(owner.data)-1}/{len(owner.data)}')
                self.end_headers()
                if head: return
                body = owner.data[offset:]
                if owner.disconnects:
                    owner.disconnects -= 1
                    body = body[:65536]
                    self.wfile.write(body); self.wfile.flush(); owner.sent += len(body)
                    self.connection.shutdown(socket.SHUT_RDWR); self.connection.close()
                else:
                    try:
                        self.wfile.write(body); owner.sent += len(body)
                    except (BrokenPipeError, ConnectionResetError): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_port}/video.mp4?token=private'
        self.trace = Path(self.folder, 'trace.jsonl')
        self.environment = patch.dict(os.environ, {'VIDDOW_TRACE_FILE': str(self.trace)})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.delay = patch('download_recovery.retry_delay', return_value=0)
        self.delay.start(); self.addCleanup(self.delay.stop)

    def fetch(self, cancel=None):
        return download.download(self.url, folder=self.folder, source_kind='direct',
                                 browser_headers={'Cookie': 'secret'}, progress=lambda *_: None, cancel=cancel)

    def failed_partial(self):
        self.disconnects = 3
        with self.assertRaises(Exception): self.fetch()
        parts = list((Path(self.folder) / '.viddow-parts').glob('*/payload.part'))
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0].stat().st_size, 3 * 65536)
        return parts[0]

    def test_in_task_recovery_transmits_only_missing_bytes(self):
        self.disconnects = 1
        saved = self.fetch()
        self.assertEqual(Path(saved).read_bytes(), self.data)
        self.assertEqual(self.sent, len(self.data))
        self.assertEqual(self.ranges, ['bytes=65536-'])

    def test_persistent_retry_in_another_python_process_and_redacted_metadata(self):
        part = self.failed_partial()
        state = part.with_name('state.json').read_text()
        self.assertNotIn('private', state); self.assertNotIn('secret', state); self.assertNotIn(self.url, state)
        result = subprocess.run([sys.executable, '-c',
            'import download,sys; print(download.download(sys.argv[1],folder=sys.argv[2],source_kind="direct",browser_headers={"Cookie":"secret"},progress=lambda *_:None))',
            self.url, self.folder], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Path(result.stdout.strip()).read_bytes(), self.data)
        self.assertEqual(self.sent, len(self.data))
        self.assertFalse(part.exists())
        self.assertNotIn('private', self.trace.read_text())
        self.assertNotIn('secret', self.trace.read_text())

    def test_changed_object_never_appends_old_bytes(self):
        self.failed_partial()
        self.etag = '"v2"'; self.data = b'changed' * 150000
        self.ranges.clear()
        self.assertEqual(Path(self.fetch()).read_bytes(), self.data)
        self.assertEqual(self.ranges, [])

    def test_200_instead_of_206_restarts_in_same_file_without_append(self):
        self.failed_partial(); self.ignore_range = True
        self.assertEqual(Path(self.fetch()).read_bytes(), self.data)

    def test_malformed_content_range_is_rejected_and_not_retained(self):
        part = self.failed_partial(); self.bad_range = True
        with self.assertRaisesRegex(RuntimeError, 'диапазон'): self.fetch()
        self.assertFalse(part.exists())
        self.assertFalse(list(Path(self.folder).glob('*.mp4')))

    def test_corrupt_local_prefix_restarts(self):
        part = self.failed_partial(); part.write_bytes(b'x' * part.stat().st_size)
        self.ranges.clear()
        self.assertEqual(Path(self.fetch()).read_bytes(), self.data)
        self.assertEqual(self.ranges, [])

    def test_crash_tail_after_durable_checkpoint_is_discarded(self):
        part = self.failed_partial()
        saved = part.stat().st_size
        with part.open('ab') as file: file.write(b'uncommitted crash tail')
        self.ranges.clear()
        self.assertEqual(Path(self.fetch()).read_bytes(), self.data)
        self.assertEqual(self.ranges, [f'bytes={saved}-'])

    def test_changed_auth_context_cannot_use_old_parts(self):
        self.failed_partial(); self.ranges.clear()
        result = download.download(self.url, folder=self.folder, source_kind='direct',
            browser_headers={'Cookie': 'different'}, progress=lambda *_: None)
        self.assertEqual(Path(result).read_bytes(), self.data)
        self.assertEqual(self.ranges, [])

    def test_weak_validator_is_not_persisted_or_used_for_range(self):
        self.etag = 'W/"v1"'; self.disconnects = 3
        with self.assertRaises(Exception): self.fetch()
        self.assertEqual(self.ranges, [])
        self.assertFalse(list((Path(self.folder) / '.viddow-parts').glob('*/payload.part')))

    def test_auth_failure_is_not_retried(self):
        self.fail_code = 403
        with self.assertRaises(Exception): self.fetch()
        self.assertEqual(self.gets, 1)
        self.assertFalse((Path(self.folder) / '.viddow-parts').exists())

    def test_cancel_interrupts_retry_wait_and_removes_partial(self):
        cancel = threading.Event()
        self.disconnects = 3
        def delay(*_): cancel.set(); return 30
        with patch('download_recovery.retry_delay', side_effect=delay):
            with self.assertRaises(download.Cancelled): self.fetch(cancel)
        self.assertFalse(list((Path(self.folder) / '.viddow-parts').glob('*/payload.part')))


class StoreTests(unittest.TestCase):
    def test_cleanup_never_removes_active_owner_and_enforces_quota(self):
        with tempfile.TemporaryDirectory() as folder:
            store = PartsStore(folder, quota=100)
            first, second = digest('first'), digest('second')
            with store.lease(first) as active:
                (active.path / 'payload.part').write_bytes(b'active')
                with store.lease(second) as other:
                    (other.path / 'payload.part').write_bytes(b'x' * 80)
                    other.retain = True
                store.cleanup(all_inactive=True)
                self.assertTrue(active.path.exists())
                self.assertFalse((store.root / second).exists())
            self.assertFalse((store.root / first).exists())

    def test_identical_active_requests_have_isolated_workspaces(self):
        with tempfile.TemporaryDirectory() as folder:
            store = PartsStore(folder)
            with store.lease(digest('same')) as first, store.lease(digest('same')) as second:
                self.assertNotEqual(first.path, second.path)
                self.assertFalse(second.persistent)
                (first.path / 'payload.part').write_bytes(b'first')
                store.cleanup(all_inactive=True)
                self.assertEqual((first.path / 'payload.part').read_bytes(), b'first')

    def test_root_symlink_is_never_followed(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as target:
            Path(folder, '.viddow-parts').symlink_to(target, target_is_directory=True)
            with self.assertRaises(OSError), PartsStore(folder).lease(digest('key')):
                self.fail('followed a symlink')
