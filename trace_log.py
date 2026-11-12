"""Small redacted journal shared by the extension and native downloader."""
import json
import os
import re
import threading
import time
from pathlib import Path

try:
    import fcntl
except ImportError:
    fcntl = None

DEFAULT_PATH = Path(__file__).resolve().parent / 'logs' / 'viddow.jsonl'
MAX_BYTES = 512 * 1024
_LOCK = threading.Lock()
EVENTS = frozenset('''panel_start panel_ready panel_error panel_stalled host_connect_start host_ready
host_disconnect host_connect_failed host_timeout command_start command_ok command_error analysis_state
page_context_start page_context_ready page_context_unavailable stream_seen prepare_begin prepare_result
prepare_candidate prepare_candidates prepare_waiting prepare_batch_start prepare_download prepare_cancelled
analysis_start candidate_start candidate_done candidate_error analysis_done analysis_cancelled preview_start
preview_done preview_error download_requested download_queued job_start job_done job_error job_cancelled
process_start process_done process_error probe_start probe_done probe_error'''.split())
CODES = frozenset('''host_not_found timeout protocol_mismatch connection_lost command_failed unsupported_source
embedded_source_error analysis_timeout network_timeout network_tls network authentication_required browser_session_unavailable drm
expired_link destination_permission destination_full destination_unavailable access_denied source_unavailable
rate_limited missing_dependency download_error visible_document current_generation hidden_document stale_generation
missing_scope explicit_mismatch player_media_id no_streams excluded_streams missing_context preview_too_large preview_no_video'''.split())
COUNTS = frozenset('''elapsed_ms candidates_count eligible_count visible_count hidden_count unbound_count
rejected_count formats_count bytes_count jobs_count job_id tab_id source_index line column video_count audio_count unknown_count'''.split())
IDS = frozenset(('analysis_tag', 'source_tag', 'candidate_tag', 'document_tag', 'attempt_tag'))
ENUMS = {
    'command': frozenset('inspect preview inspect_cancel inspect_history download cancel retry clear configure reveal'.split()),
    'status': frozenset('running cancelling cancelled done error cleared page waiting blocked recovering choose downloaded'.split()),
    'kind': frozenset(('HLS', 'DASH')),
    'tool': frozenset(('ffmpeg', 'ffprobe', 'yt-dlp', 'python', 'python3')),
    'name': frozenset('Error TypeError ReferenceError SyntaxError RangeError DOMException'.split()),
    'file': frozenset(('popup.js', 'startup.js', 'background.js', 'preparation.mjs', 'page-context.mjs',
        'media-model.mjs', 'format-model.mjs', 'history-model.mjs', 'stream-model.mjs', 'diagnostics.mjs')),
}


def clean_event(event, fields=None, origin='native'):
    if not isinstance(event, str) or event not in EVENTS:
        return None
    fields = fields if isinstance(fields, dict) else {}
    row = {'time': int(time.time() * 1000), 'origin': 'extension' if origin == 'extension' else 'native', 'event': event}
    for key in COUNTS:
        value = fields.get(key)
        if type(value) is int and 0 <= value <= 10**9:
            row[key] = value
    if type(fields.get('frame_id')) is int and -1 <= fields['frame_id'] <= 10**9:
        row['frame_id'] = fields['frame_id']
    for key in IDS:
        value = fields.get(key)
        if isinstance(value, str) and re.fullmatch(r'[a-fA-F0-9-]{8,64}', value):
            row[key] = value
    for key, values in ENUMS.items():
        if isinstance(fields.get(key), str) and fields[key] in values:
            row[key] = fields[key]
    if isinstance(fields.get('code'), str) and fields['code'] in CODES:
        row['code'] = fields['code']
    value = fields.get('time')
    if type(value) is int and 0 <= value <= 10**15:
        row['client_time'] = value
    return row


def trace_event(event, fields=None, origin='native', **values):
    row = clean_event(event, {**(fields if isinstance(fields, dict) else {}), **values}, origin)
    if row is None:
        return
    path = Path(os.environ.get('VIDDOW_TRACE_FILE') or DEFAULT_PATH)
    try:
        with _LOCK:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.with_suffix(path.suffix + '.lock').open('a') as lock:
                if fcntl:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    if path.exists() and path.stat().st_size >= MAX_BYTES:
                        path.replace(path.with_suffix(path.suffix + '.1'))
                    with path.open('a', encoding='utf-8') as output:
                        output.write(json.dumps(row, ensure_ascii=True, separators=(',', ':')) + '\n')
                finally:
                    if fcntl:
                        fcntl.flock(lock, fcntl.LOCK_UN)
    except OSError:
        pass  # Diagnostics must never break preparation or a download.
