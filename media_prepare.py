"""Bounded recommendation and first-frames preview; no queue or persistent storage."""
import base64
import os
import shutil
import tempfile
import time

import download

MAX_PREVIEW = 128 * 1024


def recommended(result, ffmpeg=None):
    ffmpeg = bool(shutil.which('ffmpeg')) if ffmpeg is None else ffmpeg
    formats = result['formats']
    audio = [row for row in formats if row['kind'] == 'audio']
    main = [row for row in formats if row['kind'] != 'audio'] or audio

    def rank(row):
        sound = row['kind'] in ('combined', 'audio') or row['kind'] == 'video' and ffmpeg and len(audio) == 1
        video_class = 2 if row['kind'] in ('combined', 'video') else 1 if row['kind'] == 'unknown' else 0
        def number(key):
            value = row.get(key)
            return value if type(value) in (int, float) and value > 0 else 0
        return (video_class, bool(sound), number('height'), number('width'), number('tbr'), number('fps'))

    best = max(main, key=rank)
    ids = [best['id']]
    if best['kind'] == 'video':
        if not ffmpeg or len(audio) != 1:
            ids = []  # Do not silently pick a language or remove sound.
        else:
            ids.append(audio[0]['id'])
    return best, ids, rank(best)


def preview_gif(context, cancel):
    """Read a short beginning, never the whole download; cap time, frames and output."""
    executable = shutil.which('ffmpeg')
    if not executable or not context:
        return None
    deadline = time.monotonic() + 8

    class Stop:
        def is_set(self):
            return cancel.is_set() or time.monotonic() >= deadline

    with tempfile.TemporaryDirectory(prefix='viddow-preview-') as temporary:
        path = os.path.join(temporary, 'preview.gif')
        headers = ''.join(f'{key}: {value}\r\n' for key, value in context['headers'].items())
        command = [executable, '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
                   '-rw_timeout', '5000000', '-probesize', '1048576', '-analyzeduration', '1000000',
                   '-headers', headers, '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-i', context['url'], '-t', '2', '-an',
                   '-vf', "fps=4,scale=320:180:force_original_aspect_ratio=decrease", '-frames:v', '8',
                   '-fs', str(MAX_PREVIEW), path]
        try:
            download.run_tool(command, lambda _: None, Stop())
            download.check_cancel(cancel)
            with open(path, 'rb') as image:
                data = image.read(MAX_PREVIEW + 1)
            if not data.startswith((b'GIF87a', b'GIF89a')) or len(data) > MAX_PREVIEW:
                return None
            encoded = 'data:image/gif;base64,' + base64.b64encode(data).decode('ascii')
            return encoded if len(encoded) <= MAX_PREVIEW else None
        except (download.Cancelled, OSError, RuntimeError):
            return None
