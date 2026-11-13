import json
import io
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import download
from contracts import format_ids_from
from inspector import Inspector, hls_kind, inspect_source, normalize
from jobs import JobManager
from media_prepare import recommended
from native_session import Session


def wait_for(predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.01)
    raise AssertionError("Анализ не изменил состояние")


INFO = {"title": "Test <video>", "is_live": True, "duration": None,
        "thumbnail": "https://example.com/cover.jpg", "http_headers": {"Cookie": "private-context"},
        "formats": [
            {"format_id": "v90", "height": 90, "vcodec": "avc1", "acodec": "none", "url": "https://private.example/video"},
            {"format_id": "v180", "height": 180, "vcodec": "avc1", "acodec": "none"},
            {"format_id": "ru", "vcodec": "none", "acodec": "aac", "language": "ru"},
            {"format_id": "en", "vcodec": "none", "acodec": "aac", "language": "en"},
            {"format_id": "mux", "height": 90, "vcodec": "avc1", "acodec": "aac"},
            {"format_id": "mystery"}]}


class InspectorTests(unittest.TestCase):
    def inspector(self, inspect=lambda *_: normalize(INFO)):
        inspector = Inspector(inspect)
        self.addCleanup(inspector.close)
        return inspector

    def test_hls_kind_uses_contents_including_single_variant_master(self):
        self.assertEqual(hls_kind('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmedia.m3u8'), 'master')
        self.assertEqual(hls_kind('\ufeff#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5\n0.ts'), 'media')
        self.assertEqual(hls_kind('#EXTM3U\n#EXT-X-PART:DURATION=1,URI="0.ts"'), 'media')
        self.assertEqual(hls_kind('<html>master.m3u8</html>'), 'unknown')
        self.assertEqual(hls_kind('#EXTM3U'), 'unknown')

    @patch('inspector.resolve_tool', return_value='yt-dlp')
    @patch('inspector.urllib.request.urlopen')
    def test_captured_content_type_analyzes_hls_without_filename_extension(self, request, which):
        request.return_value = io.BytesIO(b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmedia.m3u8')
        def metadata(command, on_line, stop, **limits):
            self.assertIn('--simulate', command)
            self.assertIn('--impersonate', command)
            on_line(json.dumps(INFO))
        with patch('inspector.download.run_tool', side_effect=metadata):
            result = inspect_source('https://example.com/manifest?token=full',
                                    {'stream_kind': 'HLS', 'headers': {'Cookie': 'context'}}, threading.Event())
        self.assertEqual(result['hls_kind'], 'master')
        sent = request.call_args.args[0]
        self.assertEqual(sent.full_url, 'https://example.com/manifest?token=full')
        self.assertEqual(sent.get_header('Cookie'), 'context')

    def test_metadata_preserves_unknowns_languages_and_excludes_private_fields(self):
        result = normalize(INFO)
        self.assertEqual([f['kind'] for f in result['formats']], ['video', 'video', 'audio', 'audio', 'combined', 'unknown'])
        self.assertEqual([f.get('language') for f in result['formats'][2:4]], ['ru', 'en'])
        self.assertIsNone(result['duration'])
        self.assertTrue(result['is_live'])
        self.assertNotIn('private-context', json.dumps(result))
        self.assertNotIn('private.example', json.dumps(result))
        self.assertIsNone(normalize({'format_id': 'one', 'thumbnail': 'javascript:alert(1)'})['thumbnail'])

    def test_selector_expressions_duplicates_and_empty_selection_are_rejected(self):
        for value in ([], ['v+ru'], ['v/other'], ['v[height=90]'], ['v', 'v'], ['--exec'], 'v90'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                format_ids_from(value)

    def test_selection_freezes_context_rejects_foreign_ids_and_requires_merger(self):
        inspector = self.inspector()
        headers = {'Cookie': 'original'}
        identifier = inspector.start('https://example.com/master.m3u8?token=full', headers=headers)['analysis_id']
        headers['Cookie'] = 'changed'
        wait_for(lambda: inspector.snapshot()['status'] == 'done')
        with patch('inspector.resolve_tool', return_value='ffmpeg'):
            urls, options = inspector.selection(identifier, ['v90', 'ru', 'en'])
            self.assertEqual(urls, ['https://example.com/master.m3u8?token=full'])
            self.assertEqual(options['headers'], {'Cookie': 'original'})
            self.assertEqual(options['format_ids'], ['v90', 'ru', 'en'])
            self.assertEqual(options['format_label'], '90p · ru · en')
        with patch('inspector.resolve_tool', return_value=None), self.assertRaisesRegex(ValueError, 'ffmpeg'):
            inspector.selection(identifier, ['v90', 'ru'])
        for ids in (['not-observed'], ['mux', 'ru'], ['ru', 'en'], ['v90', 'v180']):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                inspector.selection(identifier, ids)
        with self.assertRaises(ValueError):
            inspector.selection('old-analysis', ['v90'])
        inspector.start('https://example.com/other')
        with self.assertRaises(ValueError):
            inspector.selection(identifier, ['v90'])

    @patch('inspector.resolve_tool', return_value=sys.executable)
    def test_metadata_timeout_and_cancel_stop_real_subprocess(self, which):
        real_run = download.run_tool
        for timed_out in (True, False):
            cancel, pids = threading.Event(), []

            def run(command, on_line, stop, **limits):
                def ready(line):
                    pids.append(int(line))
                    if not timed_out:
                        cancel.set()
                real_run([sys.executable, '-u', '-c', 'import os,time; print(os.getpid()); time.sleep(10)'], ready, stop)

            start = time.monotonic()
            with patch('inspector.download.run_tool', side_effect=run):
                with self.assertRaises(TimeoutError if timed_out else download.Cancelled):
                    inspect_source('https://example.com/watch', {}, cancel, timeout=.15)
            self.assertLess(time.monotonic() - start, 3)
            for pid in pids:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    def test_analysis_failure_does_not_block_queue_or_native_commands(self):
        with tempfile.TemporaryDirectory() as folder:
            sent = []
            session = Session({'output_dir': folder}, sent.append,
                              manager_factory=lambda **options: JobManager(runner=lambda *_a, **_k: '/tmp/done.mp4', **options))
            self.addCleanup(session.manager.close)
            session.inspector = self.inspector(lambda *_: (_ for _ in ()).throw(RuntimeError('HTTP 403 expired')))
            session.handle({'command': 'inspect', 'session': session.id, 'urls': ['https://example.com/watch']})
            wait_for(lambda: session.inspector.snapshot()['status'] == 'error')
            self.assertIn('403', session.inspector.snapshot()['error'])
            session.handle({'command': 'download', 'session': session.id, 'urls': ['https://example.com/video.mp4']})
            self.assertTrue(sent[-1]['ok'])
            wait_for(lambda: session.manager.snapshots()[0]['status'] == 'done')

    def test_eof_cancels_analysis_without_blocking_commands(self):
        entered = threading.Event()

        def inspect(url, options, cancel):
            entered.set()
            cancel.wait(3)
            download.check_cancel(cancel)

        with tempfile.TemporaryDirectory() as folder:
            session = Session({'output_dir': folder}, lambda _: None)
            session.inspector = self.inspector(inspect)
            result = session.inspector.start('https://example.com/watch')
            self.assertTrue(entered.wait(1))
            with self.assertRaises(ValueError):
                session.inspector.start('https://example.com/other')
            with self.assertRaises(ValueError):
                session.inspector.stop('old-analysis')
            session.handle({'command': 'download', 'session': 'stale', 'urls': ['https://example.com/video.mp4']})
            self.assertEqual(session.manager.snapshots(), [])
            session.run(lambda: None)
            self.assertEqual(session.inspector.snapshot()['id'], result['analysis_id'])
            self.assertEqual(session.inspector.snapshot()['status'], 'cancelled')

    def test_fallback_batch_ranks_known_video_and_keeps_source_format_context(self):
        calls, active, peak, lock = [], 0, 0, threading.Lock()
        def inspect(url, options, cancel):
            nonlocal active, peak
            with lock:
                calls.append(url); active += 1; peak = max(peak, active)
            try:
                if url.endswith('/page'):
                    raise RuntimeError('yt-dlp: ERROR: Unsupported URL')
                time.sleep(.03)
                if url.endswith('/bad'):
                    raise RuntimeError('HTTP 403')
                if url.endswith('/unknown'):
                    return normalize({'format_id': 'mystery'})
                return normalize({'title': 'Best video', 'formats': [
                    {'format_id': '921', 'height': 720, 'fps': 22500, 'vcodec': 'avc1', 'acodec': 'aac'}]})
            finally:
                with lock:
                    active -= 1
        inspector = self.inspector(inspect)
        alternatives = [{'url': 'https://cdn.test/' + name, 'options': {'headers': {'Cookie': name}, 'source_kind': 'auto', 'stream_kind': 'HLS'}} for name in ['unknown', 'good', 'bad']]
        identifier = inspector.start('https://site.test/page', fallbacks=alternatives, source_kind='page')['analysis_id']
        wait_for(lambda: inspector.snapshot()['status'] == 'done')
        state = inspector.snapshot()
        self.assertLessEqual(peak, 2)
        self.assertEqual(calls.count('https://site.test/page'), 1)
        self.assertEqual(state['url'], 'https://cdn.test/good')
        result = state['result']
        self.assertEqual(result['recommended_format_ids'], ['921'])
        self.assertNotIn('fps', result['formats'][0])
        self.assertNotIn('Cookie', json.dumps(state))
        urls, options = inspector.selection(identifier, ['921'], result['source_id'])
        self.assertEqual(urls, ['https://cdn.test/good'])
        self.assertEqual(options['headers'], {'Cookie': 'good'})
        other = next(video for video in result['videos'] if video['id'] != result['source_id'])
        with self.assertRaises(ValueError):
            inspector.selection(identifier, ['921'], other['id'])
        self.assertEqual(inspector.selection(identifier, ['mystery'], other['id'])[0], ['https://cdn.test/unknown'])

    def test_recommendation_prefers_video_and_a_sound_choice_that_can_be_downloaded(self):
        mux = {'id': '720', 'kind': 'combined', 'height': 720}
        split = {'id': '1080', 'kind': 'video', 'height': 1080}
        audio = {'id': 'ru', 'kind': 'audio'}
        self.assertEqual(recommended({'formats': [mux, split, audio]}, ffmpeg=True)[1], ['1080', 'ru'])
        self.assertEqual(recommended({'formats': [mux, split, audio, {**audio, 'id': 'en'}]}, ffmpeg=True)[1], ['720'])
        self.assertEqual(recommended({'formats': [mux, split, audio]}, ffmpeg=False)[1], ['720'])
        self.assertGreater(recommended({'formats': [mux]}, ffmpeg=True)[2], recommended({'formats': [audio]}, ffmpeg=True)[2])

    def test_native_preview_does_not_block_queue_and_images_are_only_in_reply(self):
        entered, release = threading.Event(), threading.Event()
        with tempfile.TemporaryDirectory() as folder:
            sent = []
            session = Session({'output_dir': folder}, sent.append,
                manager_factory=lambda **options: JobManager(runner=lambda *_a, **_k: '/tmp/done.mp4', **options))
            self.addCleanup(session.manager.close)
            self.addCleanup(session._previews.shutdown)
            self.addCleanup(release.set)
            session.inspector = self.inspector()
            identifier = session.inspector.start('https://source.test/video')['analysis_id']
            wait_for(lambda: session.inspector.snapshot()['status'] == 'done')
            source_id = session.inspector.snapshot()['result']['source_id']
            def preview(*_):
                entered.set(); release.wait(2)
                return {'image': 'data:image/gif;base64,R0lGODlh'}
            with patch.object(session.inspector, 'preview', side_effect=preview):
                session.handle({'command': 'preview', 'request_id': 'preview', 'session': session.id,
                    'analysis_id': identifier, 'source_id': source_id})
                self.assertTrue(entered.wait(1))
                session.handle({'command': 'download', 'request_id': 'download', 'session': session.id,
                    'urls': ['https://source.test/video.mp4']})
                self.assertTrue(any(row.get('request_id') == 'download' and row.get('ok') for row in sent))
                self.assertFalse(any(row.get('request_id') == 'preview' for row in sent))
                self.assertNotIn('data:image', json.dumps(session.state()))
                release.set()
                wait_for(lambda: any(row.get('request_id') == 'preview' for row in sent))

    def test_embedded_youtube_error_is_not_presented_as_the_parent_page_login_requirement(self):
        def fail(*_):
            raise RuntimeError('yt-dlp: ERROR: [youtube] fixture: Sign in to confirm you are not a bot')
        inspector = self.inspector(fail)
        inspector.start('https://anime.test/episode', source_kind='page')
        wait_for(lambda: inspector.snapshot()['status'] == 'error')
        self.assertEqual(inspector.snapshot()['error_code'], 'embedded_source_error')
        self.assertNotIn('YouTube просит подтвердить сеанс', inspector.snapshot()['error'])
        inspector.start('https://www.youtube.com/watch?v=fixture', source_kind='page')
        wait_for(lambda: inspector.snapshot()['status'] == 'error')
        self.assertEqual(inspector.snapshot()['error_code'], 'authentication_required')

    def test_supplied_hls_fallback_is_used_after_an_embedded_extractor_auth_failure(self):
        def inspect(url, options, cancel):
            if url == 'https://anime.test/episode':
                raise RuntimeError('yt-dlp: ERROR: [youtube] fixture: Sign in to confirm you are not a bot')
            return normalize(INFO)
        inspector = self.inspector(inspect)
        inspector.start('https://anime.test/episode', source_kind='page',
            fallbacks=[{'url': 'https://cdn.test/master.m3u8?token=whole', 'options': {'source_kind': 'auto', 'stream_kind': 'HLS'}}])
        wait_for(lambda: inspector.snapshot()['status'] == 'done')
        self.assertEqual(inspector.snapshot()['url'], 'https://cdn.test/master.m3u8?token=whole')

    def test_cancel_batch_does_not_publish_late_candidates_or_fallback_again(self):
        entered = threading.Event()
        def inspect(url, options, cancel):
            entered.set(); cancel.wait(2); download.check_cancel(cancel)
        inspector = self.inspector(inspect)
        identifier = inspector.start('https://page.test/', fallback_only=True,
            fallbacks=[{'url': 'https://cdn.test/video', 'options': {}}])['analysis_id']
        self.assertTrue(entered.wait(1)); inspector.stop(identifier)
        wait_for(lambda: inspector.snapshot()['status'] == 'cancelled')
        self.assertIsNone(inspector.snapshot()['result'])

    def test_preview_is_single_flight_private_and_invalidated_by_new_analysis(self):
        def inspect(*_):
            result = normalize(INFO); result['_preview'] = {'url': 'https://private.test/frame', 'headers': {'Cookie': 'secret'}}
            return result
        inspector = self.inspector(inspect)
        identifier = inspector.start('https://page.test/')['analysis_id']
        wait_for(lambda: inspector.snapshot()['status'] == 'done')
        source_id = inspector.snapshot()['result']['source_id']
        with patch('inspector.preview_gif', return_value='data:image/gif;base64,R0lGODlh') as preview:
            self.assertTrue(inspector.preview(identifier, source_id)['image'])
            self.assertTrue(inspector.preview(identifier, source_id)['image'])
            preview.assert_called_once()
        self.assertNotIn('data:image', json.dumps(inspector.snapshot()))
        self.assertNotIn('private.test', json.dumps(inspector.snapshot()))
        inspector.start('https://other.test/')
        with self.assertRaises(ValueError):
            inspector.preview(identifier, source_id)

    @patch('inspector.resolve_tool', return_value=None)
    @patch('inspector.urllib.request.urlopen')
    def test_missing_extractor_does_not_contact_source(self, request, which):
        with self.assertRaisesRegex(RuntimeError, 'brew install yt-dlp'):
            inspect_source('https://example.com/master.m3u8', {}, threading.Event())
        request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
