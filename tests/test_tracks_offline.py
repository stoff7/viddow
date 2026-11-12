"""Real local ffmpeg/yt-dlp pipeline, no browser profile or network access."""
import json
import base64
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import download
from media_prepare import preview_gif, recommended, MAX_PREVIEW
from media_tracks import group_x_sources, probe_unknown
from inspector import normalize
from test_media_tracks import source


@unittest.skipUnless(all(shutil.which(tool) for tool in ('ffmpeg', 'ffprobe', 'yt-dlp')), 'media tools required')
class TracksOfflineTests(unittest.TestCase):
    def test_generic_split_hls_is_probed_muxed_and_previewed_with_real_tools(self):
        with tempfile.TemporaryDirectory(prefix='viddow-track-proof-') as directory:
            root = Path(directory)
            for kind in ('video', 'audio'):
                signal = 'testsrc2=size=320x180:rate=24' if kind == 'video' else 'sine=frequency=440:sample_rate=48000'
                codec = ['-c:v', 'libx264', '-preset', 'ultrafast', '-an'] if kind == 'video' else ['-c:a', 'aac', '-b:a', '128k', '-vn']
                subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', signal, '-t', '2', *codec,
                    '-hls_segment_type', 'fmp4', '-hls_time', '1', '-hls_list_size', '0',
                    '-hls_fmp4_init_filename', kind + '-init.mp4', str(root / (kind + '.m3u8'))], check=True, timeout=20)
                # yt-dlp only resolves relative segment URLs against HTTP(S).
                # Absolute file URLs keep this proof entirely offline.
                playlist = root / (kind + '.m3u8')
                text = re.sub(r'URI="([^"]+)"', lambda match: 'URI="' + (root / match[1]).as_uri() + '"', playlist.read_text())
                playlist.write_text('\n'.join((root / line).as_uri() if line and not line.startswith('#') else line for line in text.splitlines()) + '\n')
            members = []
            local = {}
            real_run = download.run_tool
            for kind in ('video', 'audio'):
                member = source('123', kind, 128 if kind == 'audio' else 0)
                local[member['url']] = root / (kind + '.m3u8')
                info = {'formats': [{'format_id': '0', 'url': member['url'], 'protocol': 'm3u8_native', 'ext': 'mp4'}]}
                def probe_local(command, receive, stop, **limits):
                    return real_run([*command[:-1], str(local[command[-1]])], receive, stop, **limits)
                with patch('media_tracks.download.run_tool', side_effect=probe_local):
                    probe_unknown(info, {}, threading.Event())
                self.assertEqual(normalize(info)['formats'][0]['kind'], kind)
                member['result'] = normalize(info)
                member['download_formats'] = [{**info['formats'][0], 'http_headers': {}}]
                members.append(member)
            grouped = group_x_sources(members)[0]
            ids = recommended(grouped['result'], ffmpeg=True)[1]
            self.assertEqual(len(ids), 2)
            def download_local(command, receive, stop, **controls):
                info_path = Path(command[command.index('--load-info-json') + 1])
                info = json.loads(info_path.read_text())
                for row in info['formats']:
                    row['url'] = local[row['url']].as_uri()
                info_path.write_text(json.dumps(info))
                local_command = [command[0], '--enable-file-urls', *command[1:]]
                try:
                    return real_run(local_command, receive, stop, **controls)
                except RuntimeError:
                    detail = subprocess.run([*local_command, '--verbose'], capture_output=True, text=True, timeout=15)
                    raise RuntimeError(detail.stderr[-6000:]) from None
            with patch('download.run_ytdlp_tool', side_effect=download_local):
                saved = download.download(grouped['url'], folder=str(root), name='selected', source_kind='auto',
                    stream_kind='HLS', format_ids=ids, prepared_info=grouped['download_info'], progress=lambda *_: None)
            final = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', saved]))
            self.assertEqual({row['codec_type'] for row in final['streams']}, {'video', 'audio'})
            def preview_local(command, receive, stop, **controls):
                command = list(command)
                command[command.index('-i') + 1] = str(root / 'video.m3u8')
                command[command.index('-protocol_whitelist') + 1] += ',file'
                # Local files have no HTTP protocol options.
                for option in ('-headers', '-rw_timeout'):
                    index = command.index(option)
                    del command[index:index + 2]
                try:
                    return real_run(command, receive, stop, **controls)
                except RuntimeError:
                    detail = subprocess.run(command, capture_output=True, text=True, timeout=15)
                    self.fail(detail.stderr)
            with patch('media_prepare.download.run_tool', side_effect=preview_local):
                image = preview_gif(grouped['preview_context'], threading.Event())
            self.assertTrue(image and image.startswith('data:image/gif;base64,'))
            self.assertLessEqual(len(image), MAX_PREVIEW)
            if os.environ.get('VIDDOW_TRACKS_ARTIFACTS'):
                artifacts = Path(os.environ['VIDDOW_TRACKS_ARTIFACTS']); artifacts.mkdir(parents=True, exist_ok=True)
                shutil.copy2(saved, artifacts / 'selected.mp4')
                (artifacts / 'preview.gif').write_bytes(base64.b64decode(image.split(',', 1)[1]))
                (artifacts / 'proof.json').write_text(json.dumps({'streams': final['streams'], 'preview_data_url_bytes': len(image)}))
