import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import download
from download_runtime import Attempt, fragment_budget, fragment_share, observed_bytes, finishing, fragments
from jobs import JobManager
from test_jobs import wait_for


class RuntimeTests(unittest.TestCase):
    def test_monotonic_stages_and_no_synthetic_retry_or_wire_bytes(self):
        with patch('download_runtime.time.monotonic', side_effect=[11., 12., 15., 16.]), patch('download_runtime.trace_event') as trace:
            with Attempt(queued=10., fragments=4, attempt_tag='a' * 32):
                observed_bytes(0)
                observed_bytes(100, 'video')
                observed_bytes(80, 'video')
                observed_bytes(120, 'video')
                observed_bytes(50, 'audio')
                finishing()
        row = trace.call_args.kwargs
        self.assertEqual({key: row[key] for key in ('queue_ms', 'preparation_ms', 'transfer_ms', 'finishing_ms', 'elapsed_ms')},
                         dict(queue_ms=1000, preparation_ms=1000, transfer_ms=3000, finishing_ms=1000, elapsed_ms=6000))
        self.assertEqual(row['observed_bytes'], 170)
        self.assertNotIn('retries', row)
        self.assertNotIn('bytes_count', row)

    def test_no_bytes_stays_unknown_and_error_is_redacted(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'VIDDOW_TRACE_FILE': temp + '/trace'}):
            with self.assertRaises(RuntimeError), Attempt():
                raise RuntimeError('https://secret.test/?token=private')
            raw = Path(temp, 'trace').read_text()
        row = json.loads(raw)
        self.assertNotIn('first_byte_ms', row)
        self.assertNotIn('transfer_ms', row)
        self.assertNotIn('secret', raw)
        self.assertEqual(row['status'], 'error')

    def test_fixed_shares_and_slots_survive_cancel_failure_and_configure(self):
        entered, release = threading.Event(), threading.Event()
        seen = []
        def runner(url, cancel, **_):
            seen.append((url, fragments()))
            if url == 'first':
                entered.set(); release.wait(3); download.check_cancel(cancel)
            if url == 'fail':
                raise RuntimeError('failure')
            return '/tmp/done'
        manager = JobManager(workers=3, fragment_budget=2, runner=runner)
        try:
            ids = manager.add(['first', 'fail', 'third'])
            self.assertTrue(entered.wait(1))
            wait_for(lambda: any(url == 'third' for url, _ in seen))
            manager.cancel(ids[0]); release.set()
            wait_for(lambda: all(row['status'] in ('done', 'error', 'cancelled') for row in manager.snapshots()))
            self.assertEqual(seen, [('first', 1), ('fail', 1), ('third', 1)])
            manager.configure(1, '/tmp')
            manager.add(['fourth'])
            wait_for(lambda: manager.snapshots()[-1]['status'] == 'done')
            self.assertEqual(seen[-1], ('fourth', 2))
        finally:
            release.set(); manager.close()

    def test_budget_rejects_invalid_configuration_and_never_exceeds_total(self):
        for value in (True, 0, -1, 65, '1.5', 'bad'):
            with self.assertRaises(ValueError):
                fragment_budget(value)
        for budget in range(1, 65):
            for workers in range(1, 9):
                self.assertLessEqual(fragment_share(budget, workers) * min(budget, workers), budget)
