#!/usr/bin/env python3
"""Local, valid HLS/direct fixtures. Never contacts a user profile or remote CDN."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import hashlib
import os
from pathlib import Path
import random
import resource
import socket
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import download
from jobs import JobManager, TERMINAL
from inspector import Inspector
from media_prepare import preview_gif
from platform_support import resolve_tool


def fixtures(root):
    ffmpeg = resolve_tool('ffmpeg')
    for kind, signal, codec in (
        ('video', 'testsrc2=size=320x180:rate=24', ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-an']),
        ('audio', 'sine=frequency=440:sample_rate=48000', ['-c:a', 'aac', '-b:a', '128k', '-vn'])):
        subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', signal, '-t', '12', *codec,
                        '-hls_time', '1', '-hls_list_size', '0', str(root / (kind + '.m3u8'))], check=True)
    (root / 'master.m3u8').write_text('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.42c00c",AUDIO="a"\nvideo.m3u8\n')
    subprocess.run([ffmpeg, '-v', 'error', '-i', str(root / 'video.m3u8'), '-i', str(root / 'audio.m3u8'),
                    '-map', '0:v', '-map', '1:a', '-c', 'copy', str(root / 'direct.mp4')], check=True)


class Network:
    def __init__(self, root, scenario):
        self.root, self.scenario = root, scenario
        self.lock = threading.Lock()
        self.requests, self.sent = Counter(), Counter()
        self.failures = Counter()
        self.active = self.peak = 0
        self.next_send = 0

    def send(self, handler, data, key):
        for offset in range(0, len(data), 16384):
            chunk = data[offset:offset + 16384]
            if self.scenario == 'bandwidth':
                with self.lock:
                    self.next_send = max(time.monotonic(), self.next_send) + len(chunk) / (512 * 1024)
                    delay = self.next_send - time.monotonic()
                time.sleep(delay)
            handler.wfile.write(chunk)
            handler.wfile.flush()
            with self.lock:
                self.sent[key] += len(chunk)


@contextmanager
def network(root, scenario):
    state = Network(root, scenario)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            key = self.path.split('?', 1)[0].lstrip('/')
            file = root / key
            if '/' in key or not file.is_file():
                self.send_error(404)
                return
            with state.lock:
                state.requests[key] += 1
                attempt = state.requests[key]
                state.active += 1
                state.peak = max(state.peak, state.active)
            try:
                if scenario == 'latency':
                    time.sleep(.08)
                segment = key.endswith('.ts')
                if segment and attempt == 1 and scenario in ('429', '503'):
                    code = int(scenario)
                    state.failures[str(code)] += 1
                    self.send_response(code)
                    self.send_header('Retry-After', '1')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                data = file.read_bytes()
                size = len(data)
                start = 0
                if self.headers.get('Range', '').startswith('bytes='):
                    start = int(self.headers['Range'][6:].split('-')[0])
                self.send_response(206 if start else 200)
                self.send_header('Content-Type', 'application/vnd.apple.mpegurl' if key.endswith('.m3u8') else 'video/mp4' if key.endswith('.mp4') else 'video/mp2t')
                self.send_header('ETag', '"fixture-v1"')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Length', str(size - start))
                if start:
                    self.send_header('Content-Range', f'bytes {start}-{size - 1}/{size}')
                self.end_headers()
                if segment and attempt == 1 and scenario == 'disconnect':
                    state.failures['disconnect'] += 1
                    state.send(self, data[start:(size + start) // 2], key)
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                state.send(self, data[start:], key)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with state.lock:
                    state.active -= 1

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def verify(path):
    info = json.loads(subprocess.check_output([resolve_tool('ffprobe'), '-v', 'error', '-show_entries',
        'stream=codec_type:format=duration', '-of', 'json', path], text=True))
    return {row['codec_type'] for row in info['streams']} == {'audio', 'video'} and float(info['format']['duration']) >= 11.9


def profile(root, count, preview):
    """Sample the harness + descendant tree, including ffmpeg grandchildren.

    Sampling includes the fixture server and misses between-sample peaks. It is
    deliberately confined to this harness, never a production monitor.
    """
    original = tempfile.TemporaryDirectory
    directories = []
    stopped = threading.Event()
    peak_rss = peak_disk = samples = 0
    def temporary(*args, **kwargs):
        result = original(*args, **kwargs)
        directories.append(Path(result.name))
        return result
    def sample():
        nonlocal peak_rss, peak_disk, samples
        while not stopped.is_set():
            result = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss='], capture_output=True, text=True)
            if result.returncode == 0:
                processes = [tuple(map(int, line.split())) for line in result.stdout.splitlines() if len(line.split()) == 3]
                descendants = {os.getpid()}
                while True:
                    expanded = descendants | {pid for pid, parent, rss in processes if parent in descendants}
                    if expanded == descendants: break
                    descendants = expanded
                # This includes the ps sampler as explicit monitoring overhead.
                peak_rss = max(peak_rss, sum(rss * 1024 for pid, parent, rss in processes if pid in descendants))
            size = 0
            paths = list(directories)
            for directory in (path for path in paths if not any(other != path and other in path.parents for other in paths)):
                for file in directory.rglob('*'):
                    try:
                        if file.is_file(): size += file.stat().st_size
                    except OSError: pass
            peak_disk = max(peak_disk, size)
            samples += 1
            stopped.wait(.1)
    thread = threading.Thread(target=sample, daemon=True)
    with patch('tempfile.TemporaryDirectory', side_effect=temporary):
        thread.start()
        try:
            row = run(root, 'latency', count, 16, 0, 'hls', preview=preview, analysis='warm')
        finally:
            stopped.set(); thread.join()
    return {**row, 'sampled_harness_tree_rss_bytes': peak_rss, 'sampled_workspace_bytes': peak_disk, 'resource_samples': samples}


def run(root, scenario, count, fragments, repeat, kind, preview=False, analysis='none', priority=True, temp_location='system'):
    with tempfile.TemporaryDirectory(prefix='viddow-benchmark-') as temporary, network(root, scenario) as (base, net):
        out = Path(temporary, 'out'); out.mkdir()
        trace = Path(temporary, 'trace.jsonl')
        stop = threading.Event()
        preview_pool = ThreadPoolExecutor(max_workers=1)
        with patch.dict(os.environ, {'VIDDOW_TRACE_FILE': str(trace), 'VIDDOW_TEMP_LOCATION': temp_location}):
            url = base + ('/master.m3u8' if kind == 'hls' else '/direct.mp4')
            manager = JobManager(workers=count, folder=str(out), fragment_budget=fragments * count)
            inspector = Inspector(scheduler=manager.scheduler if priority else None)
            def prepare():
                inspector.start(url, stream_kind='HLS')
                deadline = time.monotonic() + 40
                while inspector.snapshot()['status'] == 'running' and time.monotonic() < deadline:
                    time.sleep(.01)
                state = inspector.snapshot()
                if state['status'] != 'done':
                    raise RuntimeError('Local fixture analysis failed')
                result = state['result']
                return inspector.selection(state['id'], result['recommended_format_ids'], result['source_id'])
            cached = prepare() if analysis == 'warm' else None
            cpu_before = resource.getrusage(resource.RUSAGE_CHILDREN)
            started = time.monotonic()
            try:
                if analysis == 'cold':
                    cached = prepare()
                if preview:
                    if cached:
                        state = inspector.snapshot()
                        preview_future = preview_pool.submit(inspector.preview, state['id'], state['result']['source_id'])
                    else:
                        preview_future = preview_pool.submit(preview_gif, {'url': base + '/video.m3u8', 'headers': {}}, stop)
                manager.add([url] * count, **(cached[1] if cached else {}))
                deadline = time.monotonic() + 90
                while any(row['status'] not in TERMINAL for row in manager.snapshots()):
                    if time.monotonic() > deadline:
                        raise TimeoutError('fixture run exceeded 90s')
                    time.sleep(.01)
                rows = manager.snapshots()
                wall = time.monotonic() - started
            finally:
                manager.close()
                inspector.close()
                preview_pool.shutdown(wait=True)
        cpu_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        timings = [json.loads(line) for line in trace.read_text().splitlines() if json.loads(line)['event'] == 'download_timing']
        return dict(scenario=scenario, jobs=count, fragments=fragments, repeat=repeat, kind=kind,
                    preview=preview, analysis=analysis, priority=priority, temp_location=temp_location, elapsed_ms=round(wall * 1000),
                    valid=all(row['status'] == 'done' and verify(row['path']) for row in rows),
                    statuses=[row['status'] for row in rows], timings=timings,
                    requests=sum(net.requests.values()), peak_requests=net.peak,
                    response_bytes=sum(net.sent.values()), failures=dict(net.failures),
                    output_bytes=sum(p.stat().st_size for p in out.iterdir() if p.is_file()),
                    reaped_child_cpu_s=round(cpu_after.ru_utime + cpu_after.ru_stime - cpu_before.ru_utime - cpu_before.ru_stime, 3),
                    reaped_child_maxrss=cpu_after.ru_maxrss)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--scenarios', nargs='+', default=['normal', 'latency', 'bandwidth', '429', '503', 'disconnect'])
    parser.add_argument('--fragments', nargs='+', type=int, default=[2, 4, 8, 16])
    parser.add_argument('--jobs', nargs='+', type=int, default=[1, 2])
    parser.add_argument('--contention-only', action='store_true')
    parser.add_argument('--disk-only', action='store_true')
    parser.add_argument('--resources-only', action='store_true')
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    versions = {tool: subprocess.check_output([resolve_tool(tool), '--version' if tool == 'yt-dlp' else '-version'], text=True).splitlines()[0] for tool in ('yt-dlp', 'ffmpeg', 'ffprobe')}
    with tempfile.TemporaryDirectory(prefix='viddow-fixture-') as directory, args.output.open('w') as output:
        root = Path(directory)
        fixtures(root)
        output.write(json.dumps(dict(versions=versions, latency_ms=80, aggregate_bytes_per_second=512 * 1024,
                                    duration_s=12, seed=13, repeats=args.repeats,
                                    code_sha256={name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in ('download.py', 'download_recovery.py', 'download_runtime.py', 'jobs.py', 'inspector.py', 'work_scheduler.py', 'partial_store.py')})) + '\n'); output.flush()
        specialized = args.contention_only or args.disk_only or args.resources_only
        matrix = [] if specialized else [(s, n, f, r, 'hls') for r in range(args.repeats) for s in args.scenarios for n in args.jobs
                  for f in args.fragments]
        if not specialized:
            matrix += [('normal', n, 16, r, 'direct') for r in range(args.repeats) for n in args.jobs]
        random.Random(13).shuffle(matrix)
        for scenario, count, fragments, repeat, kind in matrix:
            row = run(root, scenario, count, fragments, repeat, kind)
            output.write(json.dumps(row) + '\n'); output.flush()
            print(f'{scenario} {kind} jobs={count} N={fragments} repeat={repeat}: {row["elapsed_ms"]} ms valid={row["valid"]}', flush=True)
        if args.contention_only:
            for repeat in range(args.repeats):
                for analysis in ('cold', 'warm'):
                    for preview in (False, True):
                        for priority in (False, True):
                            row = run(root, 'latency', 2, 16, repeat, 'hls', preview, analysis, priority)
                            output.write(json.dumps(row) + '\n'); output.flush()
                            print(f'contention {analysis} preview={preview} priority={priority}: {row["elapsed_ms"]} ms valid={row["valid"]}', flush=True)
        if args.disk_only:
            for repeat in range(args.repeats):
                for location in ('system', 'destination'):
                    row = run(root, 'normal', 2, 16, repeat, 'hls', temp_location=location)
                    output.write(json.dumps(row) + '\n'); output.flush()
                    print(f'disk {location}: {row["elapsed_ms"]} ms valid={row["valid"]}', flush=True)
        if args.resources_only:
            for count in (1, 2):
                for preview in (False, True):
                    row = profile(root, count, preview)
                    output.write(json.dumps(row) + '\n'); output.flush()
                    print(f'resources jobs={count} preview={preview}: valid={row["valid"]}', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
