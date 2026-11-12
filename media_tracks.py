"""Private track evidence and grouping for one proven X media ID."""
import copy
import json
import re
import shutil
import time
import urllib.parse
import uuid

import download
from contracts import valid_url
from media_prepare import recommended
from trace_log import trace_event


def x_media_key(url):
    parsed = urllib.parse.urlsplit(url)
    match = re.match(r'^/(amplify_video|ext_tw_video)/(\d+)/', parsed.path)
    return match.groups() if parsed.scheme == 'https' and parsed.hostname == 'video.twimg.com' and match else None


def probe_unknown(info, headers, cancel):
    rows = info.get('formats') or [info]
    if len(rows) != 1 or (rows[0].get('vcodec') is not None and rows[0].get('acodec') is not None) or not valid_url(rows[0].get('url')):
        return
    executable = shutil.which('ffprobe')
    if not executable:
        return
    lines = []
    deadline = time.monotonic() + 3
    class Stop:
        def is_set(self):
            return cancel.is_set() or time.monotonic() >= deadline
    trace_event('probe_start')
    try:
        download.run_tool([executable, '-v', 'error', '-rw_timeout', '3000000',
            '-probesize', '1048576', '-analyzeduration', '1000000',
            '-headers', ''.join(f'{key}: {value}\r\n' for key, value in headers.items()),
            '-show_entries', 'stream=codec_type,codec_name,width,height,channels,bit_rate', '-of', 'json',
            rows[0]['url']], lines.append, Stop(), max_line_chars=65536)
        data = json.loads('\n'.join(lines))
        streams = data.get('streams', [])
        video = next((row for row in streams if row.get('codec_type') == 'video'), None)
        audio = next((row for row in streams if row.get('codec_type') == 'audio'), None)
        if not video and not audio:
            trace_event('probe_error')
            return
        row = rows[0]
        row.update(vcodec=video.get('codec_name') if video else 'none', acodec=audio.get('codec_name') if audio else 'none')
        if video:
            for key in ('width', 'height'):
                if type(video.get(key)) is int:
                    row[key] = video[key]
        if audio:
            row['audio_channels'] = audio.get('channels')
            bitrate = download.number(audio.get('bit_rate'))
            if bitrate:
                row['abr'] = bitrate / 1000
        trace_event('probe_done', video_count=int(bool(video)), audio_count=int(bool(audio)))
    except (OSError, RuntimeError, ValueError):
        download.check_cancel(cancel)
        trace_event('probe_error')
    except download.Cancelled:
        download.check_cancel(cancel)
        trace_event('probe_error', code='analysis_timeout')


def private_formats(info, headers):
    # Only downloader metadata is carried, never yt-dlp command/config fields.
    keys = ('format_id', 'url', 'manifest_url', 'protocol', 'ext', 'vcodec', 'acodec',
        'width', 'height', 'fps', 'abr', 'tbr', 'language', 'audio_channels', 'format_note')
    return [{**{key: row[key] for key in keys if key in row},
             'http_headers': {**(info.get('http_headers') or {}), **(row.get('http_headers') or {}), **headers}}
            for row in info.get('formats') or [info] if valid_url(row.get('url'))]


def group_x_sources(sources):
    groups, other = {}, []
    for source in sources:
        key = x_media_key(source['url'])
        if key and source.get('download_formats'):
            groups.setdefault(key, []).append(source)
        else:
            other.append(source)
    for key, members in groups.items():
        representative = max(members, key=lambda source: recommended(source['result'])[2])
        formats, routes = [], []
        for source in members:
            for item in source['result']['formats']:
                raw = next((row for row in source['download_formats'] if str(row.get('format_id')) == item['id']), None)
                if not raw or x_media_key(raw['url']) != key:
                    continue
                identifier = f'f{len(formats)}'
                formats.append({**item, 'id': identifier})
                routes.append({**raw, 'format_id': identifier})
        if not formats:
            other.extend(members)
            continue
        # X exposes bitrate variants of the original soundtrack. Languages and
        # channel layouts remain separate; no such inference is used elsewhere.
        audio = {}
        layouts = {}
        for item in formats:
            if item['kind'] == 'audio' and item.get('audio_channels'):
                layouts.setdefault(item.get('language'), set()).add(item['audio_channels'])
        def audio_rank(item):
            return download.number(item.get('abr')) or download.number(item.get('tbr')) or 0
        for item in formats:
            if item['kind'] == 'audio':
                known = layouts.get(item.get('language'), set())
                channels = item.get('audio_channels') or (next(iter(known)) if len(known) == 1 else None)
                identity = (item.get('language'), channels)
                old = audio.get(identity)
                if old is None or audio_rank(item) > audio_rank(old):
                    audio[identity] = item
        formats = [item for item in formats if item['kind'] != 'audio' or item in audio.values()][:300]
        allowed = {item['id'] for item in formats}
        routes = [row for row in routes if row['format_id'] in allowed]
        source = {**representative, 'result': {**representative['result'], 'formats': formats}}
        source['download_info'] = {'id': uuid.uuid4().hex, 'title': source['result']['title'],
            '_type': 'video', 'extractor': 'generic', 'extractor_key': 'Generic',
            'formats': copy.deepcopy(routes)}
        best, _, _ = recommended(source['result'])
        raw = next(row for row in routes if row['format_id'] == best['id'])
        source['preview_context'] = {'url': raw['url'], 'headers': raw['http_headers']} if best['kind'] in ('video', 'combined') else None
        other.append(source)
    return other
