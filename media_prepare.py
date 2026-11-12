"""Bounded recommendation and first-frames preview; no queue or persistent storage."""
import base64
import os
import shutil
import tempfile
import time

import download
from diagnostics import describe_error
from trace_log import trace_event

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
    if best['kind'] in ('unknown', 'audio'):
        ids = []  # A video click must never silently become an audio download.
    elif best['kind'] == 'video':
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
                   '-headers', headers, '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-t', '2', '-i', context['url'], '-t', '2', '-an',
                   '-vf', "fps=4,scale=160:90:force_original_aspect_ratio=decrease,split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=bayer:bayer_scale=5", '-frames:v', '8',
                   '-fs', str(MAX_PREVIEW), path]
        try:
            download.run_tool(command, lambda _: None, Stop())
            download.check_cancel(cancel)
            with open(path, 'rb') as image:
                data = image.read(MAX_PREVIEW + 1)
            if not data.startswith((b'GIF87a', b'GIF89a')) or len(data) > MAX_PREVIEW:
                trace_event('preview_error', code='preview_too_large' if len(data) > MAX_PREVIEW else 'preview_no_video', bytes_count=len(data))
                return None
            encoded = 'data:image/gif;base64,' + base64.b64encode(data).decode('ascii')
            if len(encoded) > MAX_PREVIEW:
                trace_event('preview_error', code='preview_too_large', bytes_count=len(encoded))
                return None
            return encoded
        except (download.Cancelled, OSError, RuntimeError) as error:
            trace_event('preview_error', code=describe_error(error)[0])
            return None
