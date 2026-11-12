import copy
import json
import threading
import unittest
from unittest.mock import patch

from inspector import Inspector, normalize
from media_prepare import recommended
from media_tracks import group_x_sources, probe_unknown
from test_inspector import wait_for


def source(media_id, kind, bitrate=0, language=None):
    path = 'avc1/1280x720' if kind == 'video' else f'mp4a/{bitrate * 1000}'
    url = f'https://video.twimg.com/amplify_video/{media_id}/pl/{path}/track.m3u8?secret=full'
    raw = {'format_id': '0', 'url': url, 'protocol': 'm3u8_native', 'ext': 'mp4',
        'vcodec': 'h264' if kind == 'video' else 'none', 'acodec': 'none' if kind == 'video' else 'aac',
        'height': 720 if kind == 'video' else None, 'abr': bitrate, 'language': language,
        'http_headers': {'X-Track': kind + str(bitrate)}}
    return {'url': url, 'options': {'headers': raw['http_headers'], 'source_kind': 'auto', 'stream_kind': 'HLS'},
        'result': normalize({'title': 'Chosen', 'formats': [raw]}), 'download_formats': [raw],
        'preview_context': None, 'preview_lock': threading.Lock(), 'preview_done': False, 'preview': None}


class MediaTracksTests(unittest.TestCase):
    def test_unknown_and_audio_cannot_satisfy_automatic_video_intent(self):
        for kind in ('audio', 'unknown'):
            self.assertEqual(recommended({'formats': [{'id': '0', 'kind': kind}]})[1], [])

    def test_probe_distinguishes_generic_hls_audio_and_video_without_url_guessing(self):
        for kind in ('audio', 'video'):
            info = {'formats': [{'format_id': '0', 'url': 'https://cdn.test/signed', 'vcodec': None, 'acodec': None}]}
            def run(command, receive, stop, **limits):
                self.assertIn('Cookie: private\r\n', command)
                self.assertEqual(command[command.index('-probesize') + 1], '1048576')
                receive(json.dumps({'streams': [{'codec_type': kind, 'codec_name': 'h264' if kind == 'video' else 'aac', 'width': 1280, 'height': 720}]}))
            with patch('media_tracks.shutil.which', return_value='ffprobe'), patch('media_tracks.download.run_tool', side_effect=run):
                probe_unknown(info, {'Cookie': 'private'}, threading.Event())
            self.assertEqual(normalize(info)['formats'][0]['kind'], kind)

    def test_same_x_media_groups_tracks_and_keeps_exact_per_track_context_private(self):
        original = [source('123', 'video'), source('123', 'audio', 32), source('123', 'audio', 128), source('456', 'video')]
        grouped = group_x_sources(original)
        self.assertEqual(len(grouped), 2)
        chosen = next(row for row in grouped if '/123/' in row['url'])
        self.assertEqual([row['kind'] for row in chosen['result']['formats']], ['video', 'audio'])
        self.assertEqual(len(recommended(chosen['result'], ffmpeg=True)[1]), 2)
        routes = chosen['download_info']['formats']
        self.assertTrue(all('/123/' in row['url'] and '?secret=full' in row['url'] for row in routes))
        self.assertEqual(routes[1]['http_headers'], {'X-Track': 'audio128'})
        self.assertEqual(chosen['preview_context']['headers'], {'X-Track': 'video0'})
        self.assertNotIn('secret', json.dumps(chosen['result']))

    def test_languages_are_not_silently_chosen_and_other_hosts_do_not_merge(self):
        grouped = group_x_sources([source('123', 'video'), source('123', 'audio', 128, 'ru'), source('123', 'audio', 128, 'en')])
        self.assertEqual(recommended(grouped[0]['result'], ffmpeg=True)[1], [])
        other = source('123', 'audio', 128)
        other['url'] = other['url'].replace('video.twimg.com', 'video.twimg.com.evil')
        self.assertEqual(len(group_x_sources([source('123', 'video'), other])), 2)

    def test_inspector_publishes_one_video_and_freezes_selected_private_info(self):
        sources = [source('123', 'video'), source('123', 'audio', 128)]
        def inspect(url, options, cancel):
            row = next(row for row in sources if row['url'] == url)
            return {**copy.deepcopy(row['result']), '_download_formats': copy.deepcopy(row['download_formats'])}
        inspector = Inspector(inspect)
        try:
            identifier = inspector.start('https://x.com/', fallback_only=True, source_kind='page',
                fallbacks=[{'url': row['url'], 'options': row['options']} for row in sources])['analysis_id']
            wait_for(lambda: inspector.snapshot()['status'] != 'running')
            snapshot = inspector.snapshot()
            self.assertEqual(snapshot['status'], 'done')
            result = snapshot['result']
            self.assertEqual(len(result['videos']), 1)
            self.assertNotIn('X-Track', json.dumps(snapshot))
            _, options = inspector.selection(identifier, result['recommended_format_ids'])
            self.assertEqual(len(options['prepared_info']['formats']), 2)
            self.assertNotIn('webpage_url', options['prepared_info'], 'prepared downloads must not silently re-extract a parent URL')
            options['prepared_info']['formats'].clear()
            self.assertEqual(len(inspector.selection(identifier, result['recommended_format_ids'])[1]['prepared_info']['formats']), 2)
        finally:
            inspector.close()
