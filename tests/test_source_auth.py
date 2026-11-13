import errno
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest.mock import patch
from pathlib import Path

import download
from diagnostics import describe_error
from inspector import inspect_source
from jobs import JobManager
from native_session import Session
from source_auth import cookie_browser_from, ytdlp_auth_args


class SourceAuthTests(unittest.TestCase):
    @patch('download.resolve_tool', return_value='yt-dlp')
    def test_preparation_reports_elapsed_time_and_stops_after_first_bytes(self, which):
        updates = []
        with tempfile.TemporaryDirectory() as folder:
            saved = Path(folder, 'video.mp4'); saved.write_bytes(b'file')
            def tool(command, on_line, cancel, on_idle):
                with patch('download.time.monotonic', return_value=102): on_idle()
                on_line('3 10 1 2')
                with patch('download.time.monotonic', return_value=105): on_idle()
                Path(command[command.index('--print-to-file') + 2]).write_text(str(saved))
                self.assertEqual(command[command.index('--retries') + 1], '1')
                self.assertIn('--abort-on-unavailable-fragments', command)
            with patch('download.time.monotonic', return_value=100), patch('download.run_tool', side_effect=tool):
                download.run_ytdlp('https://example.com/video', folder, 'video', {}, lambda fraction, label: updates.append((fraction, label)))
        self.assertIn('2 с', updates[1][1]); self.assertEqual(updates[-1][0], .3)
        self.assertFalse(any('5 с' in label for _, label in updates))

    def test_idle_callback_failure_stops_process(self):
        def fail(): raise RuntimeError('idle callback failed')
        start = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'idle callback failed'):
            download.run_tool([sys.executable, '-c', 'import time; time.sleep(10)'], lambda _: None, on_idle=fail)
        self.assertLess(time.monotonic() - start, 3)

    @patch('source_auth.resolve_tool', return_value=None)
    def test_browser_session_is_explicit_scoped_and_never_exports_cookie_file(self, which):
        self.assertEqual(ytdlp_auth_args('https://www.youtube.com/watch?v=test'), [])
        args = ytdlp_auth_args('https://www.youtube.com/watch?v=test', 'vivaldi')
        self.assertEqual(args[args.index('--cookies-from-browser') + 1], 'vivaldi')
        self.assertIn('--no-cookies', args); self.assertNotIn('--cookies', args)
        for url in ('https://youtube.com.evil.example/watch', 'https://x.com/a/status/1', 'https://googlevideo.com/stream'):
            self.assertEqual(ytdlp_auth_args(url, 'vivaldi'), [])
        for value in ('vivaldi:../../profile', '--exec', None, ['vivaldi']):
            with self.subTest(value=value), self.assertRaises(ValueError):
                cookie_browser_from(value)

    @patch('source_auth.resolve_tool', side_effect=lambda tool: '/usr/local/bin/node' if tool == 'node' else None)
    def test_available_node_is_enabled_for_youtube_only(self, which):
        self.assertEqual(ytdlp_auth_args('https://youtu.be/test'), ['--no-js-runtimes', '--js-runtimes', 'node:/usr/local/bin/node'])
        self.assertEqual(ytdlp_auth_args('https://example.com/watch'), [])

    @patch('download.resolve_tool', return_value='yt-dlp')
    @patch('download.run_ytdlp', return_value='/tmp/video.mp4')
    def test_download_and_selected_formats_propagate_explicit_session(self, tool, which):
        url = 'https://www.youtube.com/watch?v=test'
        download.download(url, source_kind='page', cookie_browser='vivaldi')
        self.assertEqual(tool.call_args.kwargs['cookie_browser'], 'vivaldi')
        download.download(url, format_ids=['137', '140'], cookie_browser='vivaldi')
        self.assertEqual(tool.call_args.kwargs['cookie_browser'], 'vivaldi')
        self.assertEqual(tool.call_args.kwargs['format_ids'], ['137', '140'])

    @patch('inspector.resolve_tool', return_value='yt-dlp')
    def test_analysis_uses_session_but_never_returns_it_in_metadata(self, which):
        def inspect(command, collect, cancel, **limits):
            self.assertEqual(command[command.index('--cookies-from-browser') + 1], 'vivaldi')
            self.assertIn('--no-cookies', command)
            self.assertNotIn('--cookies', command)
            collect(json.dumps({'title': 'Video', 'format_id': 'http', 'http_headers': {'Cookie': 'private'}}))
        with patch('inspector.download.run_tool', side_effect=inspect):
            result = inspect_source('https://youtu.be/test', {'cookie_browser': 'vivaldi'}, threading.Event())
        self.assertNotIn('private', str(result)); self.assertNotIn('cookie', str(result))

    def test_retry_uses_new_browser_choice_without_mutating_original_job(self):
        attempts = []
        def runner(url, **options):
            attempts.append(options)
            raise RuntimeError("[youtube] Sign in to confirm you’re not a bot")
        manager = JobManager(runner=runner)
        self.addCleanup(manager.close)
        first = manager.add(['https://youtu.be/test'], format_ids=['137', '140'])[0]
        deadline = time.monotonic() + 3
        while manager.snapshots()[0]['status'] != 'error' and time.monotonic() < deadline:
            time.sleep(.01)
        manager.retry(first, cookie_browser='vivaldi')
        while len(attempts) < 2 and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertNotIn('cookie_browser', attempts[0])
        self.assertEqual(attempts[1]['cookie_browser'], 'vivaldi')
        self.assertEqual(attempts[1]['format_ids'], ['137', '140'])
        self.assertEqual(manager.snapshots()[0]['error_code'], 'authentication_required')
        self.assertIn('Сеанс YouTube', manager.snapshots()[0]['error'])

    def test_settings_default_to_anonymous_and_reject_unknown_browser(self):
        with tempfile.TemporaryDirectory() as folder:
            sent = []; session = Session({'output_dir': folder}, sent.append)
            self.addCleanup(session.manager.close); self.addCleanup(session.inspector.close)
            self.assertEqual(session.state()['settings']['youtube_browser'], 'none')
            session.handle({'command': 'configure', 'session': session.id,
                            'settings': {'output_dir': folder, 'youtube_browser': 'vivaldi'}})
            self.assertTrue(sent[-1]['ok']); self.assertEqual(sent[-1]['result']['youtube_browser'], 'vivaldi')
            session.handle({'command': 'configure', 'session': session.id,
                            'settings': {'output_dir': folder, 'youtube_browser': '--exec'}})
            self.assertFalse(sent[-1]['ok']); self.assertEqual(session.youtube_browser, 'vivaldi')

    def test_browser_change_rejects_old_selection_and_new_analysis_uses_current_choice(self):
        for browser in ('none', 'chrome'):
            with self.subTest(browser=browser), tempfile.TemporaryDirectory() as folder:
                sent = []
                session = Session({'output_dir': folder, 'youtube_browser': 'vivaldi'}, sent.append)
                self.addCleanup(session.manager.close); self.addCleanup(session.inspector.close)
                contexts = []

                def inspect(url, options, cancel):
                    contexts.append(options.copy())
                    return {'title': 'Video', 'formats': [{'id': 'http', 'kind': 'combined'}]}

                session.inspector.inspect = inspect
                def command(name, **values):
                    session.handle({'command': name, 'session': session.id, **values})
                    return sent[-1]

                command('inspect', urls=['https://youtu.be/test'])
                session.inspector._thread.join(1)
                old_id = session.state()['analysis']['id']
                settings = {'output_dir': folder, 'youtube_browser': 'vivaldi', 'workers': 3}
                self.assertTrue(command('configure', settings=settings)['ok'])
                self.assertEqual(session.state()['analysis']['id'], old_id)
                with patch.object(session.manager, 'configure', side_effect=ValueError('Очередь занята')):
                    self.assertFalse(command('configure', settings={**settings, 'youtube_browser': browser})['ok'])
                self.assertEqual(session.state()['analysis']['id'], old_id)
                self.assertTrue(command('configure', settings={**settings, 'youtube_browser': browser})['ok'])
                # Общий state публикуется до reply: все панели получают сброс анализа.
                self.assertIsNone(sent[-2]['analysis'])
                with patch.object(session.manager, 'add', return_value=[1]) as add:
                    # Сообщение из другой панели с прежним ID также отвергается.
                    self.assertFalse(command('download', analysis_id=old_id, format_ids=['http'])['ok'])
                    add.assert_not_called()
                    self.assertTrue(command('inspect', urls=['https://youtu.be/test'])['ok'])
                    session.inspector._thread.join(1)
                    new_id = session.state()['analysis']['id']
                    self.assertNotEqual(new_id, old_id)
                    self.assertTrue(command('download', analysis_id=new_id, format_ids=['http'])['ok'])
                    self.assertEqual(add.call_args.kwargs.get('cookie_browser', 'none'), browser)
                self.assertEqual([options.get('cookie_browser', 'none') for options in contexts], ['vivaldi', browser])

    def test_browser_change_cancels_running_analysis_and_rejects_late_result(self):
        for fails in (False, True):
            with self.subTest(fails=fails), tempfile.TemporaryDirectory() as folder:
                entered, release = threading.Event(), threading.Event()
                sent = []
                session = Session({'output_dir': folder, 'youtube_browser': 'vivaldi'}, sent.append)
                self.addCleanup(session.manager.close); self.addCleanup(session.inspector.close)
                self.addCleanup(release.set)
                cancellations = []

                def inspect(url, options, cancel):
                    cancellations.append(cancel)
                    entered.set()
                    if not release.wait(3):
                        raise RuntimeError('Test did not release analysis')
                    if fails:
                        raise RuntimeError('Late extractor failure')
                    return {'title': 'Video', 'formats': [{'id': 'http', 'kind': 'combined'}]}

                session.inspector.inspect = inspect
                session.handle({'command': 'inspect', 'session': session.id, 'urls': ['https://youtu.be/test']})
                self.assertTrue(entered.wait(1))
                old_id = session.state()['analysis']['id']
                session.handle({'command': 'configure', 'session': session.id,
                                'settings': {'output_dir': folder, 'youtube_browser': 'none'}})
                self.assertTrue(sent[-1]['ok'])
                self.assertTrue(cancellations[0].is_set())
                self.assertEqual(sent[-2]['analysis']['status'], 'cancelling')
                with patch.object(session.manager, 'add') as add:
                    for finished in (False, True):
                        if finished:
                            release.set()
                            session.inspector._thread.join(1)
                            self.assertEqual(session.state()['analysis']['status'], 'cancelled')
                            self.assertIsNone(session.state()['analysis']['result'])
                        session.handle({'command': 'download', 'session': session.id,
                                        'analysis_id': old_id, 'format_ids': ['http']})
                        self.assertFalse(sent[-1]['ok'])
                    add.assert_not_called()
                session.handle({'command': 'inspect', 'session': session.id, 'urls': ['https://youtu.be/test']})
                self.assertTrue(sent[-1]['ok'])
                session.inspector._thread.join(1)
                self.assertFalse(cancellations[1].is_set())


class DiagnosticTests(unittest.TestCase):
    def test_denied_expired_and_login_are_distinct(self):
        samples = [(RuntimeError('[youtube] Sign in to confirm you’re not a bot'), 'authentication_required'),
                   (RuntimeError('HTTP Error 403: Forbidden'), 'access_denied'),
                   (RuntimeError('HTTP Error 403: token expired'), 'expired_link'),
                   (RuntimeError('HTTP Error 404: Not Found'), 'source_unavailable'),
                   (RuntimeError('HTTP Error 429'), 'rate_limited'),
                   (RuntimeError('Unsupported URL'), 'unsupported_source'),
                   (RuntimeError('DRM protected'), 'drm')]
        for error, expected in samples:
            with self.subTest(error=error):
                self.assertEqual(describe_error(error)[0], expected)

    def test_folder_and_network_errors_are_distinct(self):
        samples = [(PermissionError(errno.EACCES, 'denied'), 'destination_permission'),
                   (OSError(errno.EROFS, 'readonly'), 'destination_permission'),
                   (OSError(errno.ENOSPC, 'full'), 'destination_full'),
                   (FileNotFoundError(errno.ENOENT, 'gone'), 'destination_unavailable'),
                   (urllib.error.URLError('DNS failed'), 'network'),
                   (RuntimeError('Failed to perform, curl: (28) Connection timed out after 30002 milliseconds'), 'network_timeout'),
                   (RuntimeError('brew install yt-dlp'), 'missing_dependency')]
        for error, expected in samples:
            with self.subTest(error=error):
                self.assertEqual(describe_error(error)[0], expected)


if __name__ == '__main__':
    unittest.main()
