import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import trace_log


class TraceLogTests(unittest.TestCase):
    def test_only_fixed_events_and_fields_enter_the_local_file(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {'VIDDOW_TRACE_FILE': str(Path(temporary, 'trace.jsonl'))}):
            trace_log.trace_event('prepare_candidate', {'code': 'current_generation', 'source_tag': 'a' * 32,
                'url': 'https://private.test/?token=secret', 'headers': {'Cookie': 'secret'}, 'message': 'raw secret',
                'analysis_tag': 'https://private.test/', 'frame_id': -1}, origin='extension')
            trace_log.trace_event(['not-an-event'])
            trace_log.trace_event('https://private.test/')
            rows = Path(temporary, 'trace.jsonl').read_text().splitlines()
            self.assertEqual(len(rows), 1)
            row = json.loads(rows[0])
            self.assertEqual(row['code'], 'current_generation')
            self.assertEqual(row['source_tag'], 'a' * 32)
            self.assertEqual(row['frame_id'], -1)
            self.assertNotIn('private', rows[0])
            self.assertNotIn('secret', rows[0])

    def test_rotation_is_bounded_and_a_failed_journal_does_not_break_work(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {'VIDDOW_TRACE_FILE': str(Path(temporary, 'trace.jsonl'))}), patch.object(trace_log, 'MAX_BYTES', 180):
            for _ in range(30):
                trace_log.trace_event('job_done', job_id=1)
            path = Path(temporary, 'trace.jsonl')
            self.assertLessEqual(path.stat().st_size, 300)
            self.assertTrue(path.with_suffix('.jsonl.1').exists())
            with patch.dict(os.environ, {'VIDDOW_TRACE_FILE': str(path / 'cannot-write')}):
                trace_log.trace_event('job_done', job_id=2)


if __name__ == '__main__':
    unittest.main()
