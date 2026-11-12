import tempfile
import threading
import time
import unittest
from pathlib import Path

from inspector import Inspector, normalize
from jobs import Conflict, JobManager
from native_session import Session


def record(identifier=9, status='done', **fields):
    return {'id': identifier, 'name': 'Lesson', 'status': status, 'path': None,
            'page': 'https://site.example/watch/9', 'page_retry': True,
            'source_origin': 'https://cdn.example', 'created_at': 123,
            'format_label': '90p · ru', 'http_status': None, **fields}


def wait_for(predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.01)
    raise AssertionError('Нет ожидаемого состояния истории')


class HistoryTests(unittest.TestCase):
    def manager(self, **options):
        manager = JobManager(**options)
        self.addCleanup(manager.close)
        return manager

    def test_restore_never_runs_jobs_and_reserves_ids(self):
        called = threading.Event()
        manager = self.manager(runner=lambda *_a, **_k: called.set())
        manager.restore_history([record(9), record(10, 'running'), record(11, 'queued'), record(12, 'cancelling'), record(13, 'cancelled')])
        self.assertFalse(called.is_set())
        self.assertEqual([job['status'] for job in manager.snapshots()], ['done', 'interrupted', 'interrupted', 'interrupted', 'cancelled'])
        for job in manager.snapshots():
            self.assertTrue(job['restored'])
            self.assertEqual(job['format_ids'], [])
            self.assertEqual(job['created_at'], 123)
        self.assertEqual(manager.add(['https://example.com/video.mp4']), [14])

    def test_restore_keeps_shared_attempt_ids_but_does_not_guess_for_legacy_rows(self):
        identity = 'a' * 32
        manager = self.manager()
        manager.restore_history([record(1, 'error', attempt_id=identity), record(2, 'error', attempt_id=identity),
                                 record(3, 'error'), record(4, 'error')])
        rows = manager.snapshots()
        self.assertEqual(rows[0]['attempt_id'], rows[1]['attempt_id'])
        self.assertNotEqual(rows[2]['attempt_id'], rows[3]['attempt_id'])

    def test_missing_file_and_clear_preserve_files_and_active_tasks(self):
        with tempfile.TemporaryDirectory() as folder:
            saved = Path(folder, 'saved.mp4'); saved.write_bytes(b'completed')
            manager = self.manager(runner=lambda url, cancel, **_: cancel.wait(1))
            manager.restore_history([record(1, path=str(saved)), record(2, path=str(Path(folder, 'missing.mp4'))), record(3, 'error', http_status=403)])
            self.assertEqual([job['file_exists'] for job in manager.snapshots()[:2]], [True, False])
            self.assertIn('403', manager.snapshots()[2]['error'])
            active = manager.add(['https://example.com/video.mp4'])[0]
            manager.clear()
            self.assertTrue(saved.exists())
            self.assertEqual([job['id'] for job in manager.snapshots()], [active])

    def test_restored_retry_cannot_reuse_a_saved_download_address_or_formats(self):
        manager = self.manager()
        manager.restore_history([record(status='error', url='https://cdn.example/?token=old', headers={'Cookie': 'secret'}, format_ids=['old-id'])])
        with self.assertRaisesRegex(Conflict, 'свежие'):
            manager.retry(9)
        job = manager.snapshots()[0]
        self.assertNotIn('secret', str(job)); self.assertNotIn('token=old', str(job))
        self.assertEqual(job['format_ids'], [])

    def test_history_repeat_gets_new_metadata_without_old_context(self):
        calls, messages = [], []
        with tempfile.TemporaryDirectory() as folder:
            session = Session({'output_dir': folder}, messages.append,
                              history=[record(status='interrupted', headers={'Cookie': 'old-secret'}, format_ids=['old'])],
                              manager_factory=lambda **options: JobManager(runner=lambda *_a, **_k: '/tmp/new.mp4', **options))
            self.addCleanup(session.manager.close)
            def inspect(url, options, cancel):
                calls.append((url, options))
                return normalize({'title': 'Fresh lesson', 'formats': [{'format_id': 'fresh', 'vcodec': 'avc1', 'acodec': 'aac', 'height': 180}]})
            session.inspector = Inspector(inspect)
            self.addCleanup(session.inspector.close)
            session.handle({'command': 'inspect_history', 'id': 9, 'session': 'old-session'})
            self.assertFalse(messages[-1]['ok']); self.assertEqual(calls, [])
            session.handle({'command': 'inspect_history', 'id': 9, 'session': session.id})
            self.assertTrue(messages[-1]['ok'])
            wait_for(lambda: session.inspector.snapshot()['status'] == 'done')
            self.assertEqual(calls[0][0], 'https://site.example/watch/9')
            self.assertEqual(calls[0][1]['headers'], {})
            self.assertEqual(calls[0][1]['source_kind'], 'page')
            self.assertNotIn('old', str(calls))
            session.handle({'command': 'download', 'analysis_id': session.inspector.snapshot()['id'], 'format_ids': ['fresh'], 'session': session.id})
            self.assertTrue(messages[-1]['ok'])
            wait_for(lambda: session.manager.snapshots()[-1]['status'] == 'done')
            self.assertEqual(session.manager.snapshots()[-1]['format_ids'], ['fresh'])
            self.assertEqual(session.manager.snapshots()[0]['status'], 'interrupted')

    def test_unsafe_or_missing_source_cannot_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            session = Session({'output_dir': folder}, lambda _: None, history=[record(page=None, page_retry=False)])
            self.addCleanup(session.manager.close); self.addCleanup(session.inspector.close)
            messages = []; session.send = messages.append
            session.handle({'command': 'inspect_history', 'id': 9, 'session': session.id})
            self.assertFalse(messages[-1]['ok']); self.assertIn('свежую ссылку', messages[-1]['error'])
        for fields in ({'page': 'https://site.example/watch?token=secret'}, {'page': 'file:///private'}, {'path': 'relative'}, {'id': True}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.manager().restore_history([record(**fields)])


if __name__ == '__main__':
    unittest.main()
