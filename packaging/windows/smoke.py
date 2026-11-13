"""Exercise the real installer and installed host in the disposable CI user's HKCU."""
import functools
import http.server
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / 'dist/windows'
SETUP = next(OUT.glob('Viddow-Setup-*.exe'))
VERSION = json.loads((OUT / 'components.json').read_text())['version']
REPORT = []


def run(args, **kwargs):
    subprocess.run(list(map(str, args)), check=True, timeout=180, **kwargs)


def send(host, message):
    data = json.dumps(message).encode()
    host.stdin.write(struct.pack('<I', len(data)) + data)
    host.stdin.flush()


def read_messages(host, messages):
    try:
        while prefix := host.stdout.read(4):
            length, = struct.unpack('<I', prefix)
            assert 0 < length <= 1024 * 1024
            messages.put(json.loads(host.stdout.read(length)))
    except Exception as error:
        messages.put(error)


def wait_message(messages, match):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        message = messages.get(timeout=max(0.1, deadline - time.monotonic()))
        if isinstance(message, Exception):
            raise message
        if match(message):
            return message
    raise TimeoutError('Native message timeout')


def main():
    with tempfile.TemporaryDirectory(prefix='Viddow-проверка % ') as temporary:
        root = Path(temporary)
        install = root / 'Установка с пробелами'
        output = root / 'Видео'
        output.mkdir()
        setup_args = [SETUP, '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', f'/DIR={install}', '/ChromeID=' + 'a' * 32, '/EdgeID=' + 'b' * 32, f'/LOG={OUT / "installer-smoke.log"}']
        run(setup_args)
        host_exe = install / VERSION / 'ViddowHost.exe'
        bin_dir = host_exe.parent / 'bin'
        env = {**os.environ, 'PATH': str(Path(os.environ['SystemRoot']) / 'System32'), 'VIDDOW_FFMPEG': r'C:\missing-global-tool.exe'}
        run([host_exe, '--check'], env=env)
        REPORT.append('PASS: silent per-user install, Cyrillic/spaces/percent path, payload integrity, isolated tool resolution')
        run([bin_dir / 'ffmpeg.exe', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'mpeg4', '-c:a', 'aac', root / 'sample.mp4'])
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        host = subprocess.Popen([host_exe, 'chrome-extension://' + 'a' * 32 + '/'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        messages = queue.Queue()
        threading.Thread(target=read_messages, args=(host, messages), daemon=True).start()
        try:
            send(host, {'type': 'session', 'settings': {'output_dir': str(output)}})
            ready = wait_message(messages, lambda row: row.get('type') == 'ready')
            assert ready['protocol'] == 2 and ready['history_version'] == 1
            assert ready['tools']['yt_dlp'] and ready['tools']['ffmpeg']
            session = ready['session']
            send(host, {'command': 'download', 'request_id': 'download', 'session': session,
                        'url': f'http://127.0.0.1:{server.server_port}/sample.mp4', 'name': 'Проверка видео'})
            reply = wait_message(messages, lambda row: row.get('request_id') == 'download')
            assert reply['ok'], reply
            done = wait_message(messages, lambda row: any(job['status'] in ('done', 'error') for job in row.get('jobs', [])))
            job = done['jobs'][0]
            assert job['status'] == 'done', job
            saved = Path(job['path'])
            probe = json.loads(subprocess.check_output([bin_dir / 'ffprobe.exe', '-v', 'error', '-show_streams', '-of', 'json', saved]))
            assert {'video', 'audio'} <= {row['codec_type'] for row in probe['streams']}
            REPORT.append('PASS: installed native stdio ready/session v2/history v1/reply/state, MP4 with video+audio')
        finally:
            host.stdin.close()
            host.wait(timeout=15)
            host.stdout.close()
            stderr = host.stderr.read().decode('utf-8', errors='replace')
            host.stderr.close()
            server.shutdown()
            server.server_close()
        assert host.returncode == 0, stderr
        REPORT.append('PASS: native EOF exits cleanly')
        run(setup_args)
        assert saved.is_file()
        REPORT.append('PASS: repeat install/repair preserves downloaded file')
        # Deliberate corruption fails closed and is repaired by the full installer.
        tool = bin_dir / 'deno.exe'
        tool.write_bytes(b'broken')
        assert subprocess.run([host_exe, '--check'], env=env).returncode != 0
        run(setup_args)
        run([host_exe, '--check'], env=env)
        REPORT.append('PASS: corrupted tool detected; full installer restores payload')
        run([install / 'unins000.exe', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'])
        assert saved.is_file()
        import winreg
        from windows_native_install import REGISTRY_PATHS
        for key_path in REGISTRY_PATHS.values():
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ | winreg.KEY_WOW64_32KEY) as key:
                    try:
                        winreg.QueryValueEx(key, '')
                    except FileNotFoundError:
                        continue
                    raise AssertionError('Registry registration remains after uninstall')
            except FileNotFoundError:
                pass
        REPORT.append('PASS: uninstall unregisters both browsers and preserves downloaded file')
    REPORT.extend(['NOT TESTED: real Chrome/Edge browser handshake and nested browser job, Windows 11 desktop UI/Explorer, clean machine without build tools, external CDN/cookies/network disks.',
                   'Real installer tested on Windows Server 2025 Actions x64; this does not certify Windows 11 acceptance.'])
    (OUT / 'verification.txt').write_text('\n'.join(REPORT), encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    finally:
        (OUT / 'smoke-progress.txt').write_text('\n'.join(REPORT), encoding='utf-8')
