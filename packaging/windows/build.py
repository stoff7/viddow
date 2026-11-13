"""Run on Windows x64. All executable downloads are pinned and hash-checked."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

REPO = Path(__file__).resolve().parents[2]
os.chdir(REPO)
LOCK = json.loads(Path('packaging/windows/components.lock.json').read_text())
CACHE = REPO / 'build' / 'windows-downloads'
BUNDLE = REPO / 'dist' / 'ViddowHost'
OUT = REPO / 'dist' / 'windows'


def run(*argv):
    subprocess.run(list(map(str, argv)), check=True)


def download(url, path, sha256=None):
    if not path.exists():
        with urllib.request.urlopen(url, timeout=120) as source, path.open('wb') as target:
            shutil.copyfileobj(source, target)
    actual = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
    if sha256 and actual != sha256:
        raise ValueError(f'Hash mismatch: {path.name}: {actual}')
    return actual


def main():
    if sys.platform != 'win32' or sys.version.split()[0] != LOCK['python']:
        raise RuntimeError(f"Build requires Windows Python {LOCK['python']}")
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    run(sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--console',
        '--name', 'ViddowHost', '--paths', REPO, 'packaging/windows/entry.py')
    bindir = BUNDLE / 'bin'
    licenses = BUNDLE / 'licenses'
    bindir.mkdir(exist_ok=True)
    licenses.mkdir(exist_ok=True)
    for item in LOCK['components']:
        archive = CACHE / item['url'].split('/')[-1]
        download(item['url'], archive, item['sha256'])
        if item['kind'] == 'exe':
            shutil.copy2(archive, bindir / 'yt-dlp.exe')
        elif item['kind'] in ('zip', 'ffmpeg'):
            dest = CACHE / item['name']
            if dest.exists():
                shutil.rmtree(dest)
            with zipfile.ZipFile(archive) as z:
                z.extractall(dest)
            if item['kind'] == 'zip':
                shutil.copy2(dest / 'deno.exe', bindir / 'deno.exe')
            else:
                upstream = next(dest.iterdir())
                for path in (upstream / 'bin').iterdir():
                    if path.suffix.lower() in ('.exe', '.dll'):
                        shutil.copy2(path, bindir / path.name)
                for path in upstream.iterdir():
                    if path.name != 'bin':
                        target = licenses / ('ffmpeg-' + path.name)
                        if path.is_dir():
                            shutil.copytree(path, target, dirs_exist_ok=True)
                        else:
                            shutil.copy2(path, target)
        else:
            inno = CACHE / 'inno'
            run(archive, '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', f'/DIR={inno}')
    # Preserve license texts at exact upstream release revisions. Record their hashes too.
    notices = {
        'yt-dlp-LICENSE.txt': 'https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.10.26/LICENSE',
        'yt-dlp-THIRD_PARTY_LICENSES.txt': 'https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.10.26/THIRD_PARTY_LICENSES.txt',
        'deno-LICENSE.md': 'https://raw.githubusercontent.com/denoland/deno/v2.9.8/LICENSE.md',
        'PyInstaller-COPYING.txt': 'https://raw.githubusercontent.com/pyinstaller/pyinstaller/v6.16.0/COPYING.txt',
        'Inno-Setup-LICENSE.txt': 'https://raw.githubusercontent.com/jrsoftware/issrc/is-6_4_3/license.txt',
    }
    for name, url in notices.items():
        download(url, licenses / name)
    shutil.copy2(Path(sys.base_prefix) / 'LICENSE.txt', licenses / 'Python-LICENSE.txt')
    (licenses / 'SOURCE-LOCATIONS.txt').write_text(
        'Personal, unsigned test build. No public release.\n'
        'FFmpeg sources: https://github.com/FFmpeg/FFmpeg/tree/f1acb0a266\n'
        'Build recipes and dependency sources: https://github.com/FFmpeg-Builds/FFmpeg-Builds\n'
        'Upstream build archive and complete notices are included in this directory.\n'
        'Before public redistribution: archive matching corresponding sources of FFmpeg and its linked libraries.\n'
        'Shared FFmpeg DLLs are replaceable; no application linking or modifications.\n', encoding='utf-8')
    commands = {'yt-dlp': ['--version'], 'ffmpeg': ['-version'], 'ffprobe': ['-version'], 'deno': ['--version']}
    versions = {}
    for name, args in commands.items():
        versions[name] = subprocess.check_output([str(bindir / (name + '.exe')), *args], text=True, encoding='utf-8')
    impersonation = subprocess.check_output([str(bindir / 'yt-dlp.exe'), '--ignore-config', '--list-impersonate-targets'], text=True, encoding='utf-8')
    if 'chrome' not in impersonation.lower():
        raise RuntimeError('Bundled yt-dlp does not provide Chrome impersonation')
    (OUT / 'tool-capabilities.txt').write_text(json.dumps(versions, indent=2) + '\n' + impersonation, encoding='utf-8')
    files = [{'path': path.relative_to(BUNDLE).as_posix(), 'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()}
             for path in sorted(BUNDLE.rglob('*')) if path.is_file()]
    manifest = {**LOCK, 'source_commit': os.environ.get('GITHUB_SHA', 'local'), 'architecture': 'windows-x64',
                'actual_versions': versions, 'files': files}
    (BUNDLE / 'components.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    shutil.copy2(BUNDLE / 'components.json', OUT / 'components.json')
    run(BUNDLE / 'ViddowHost.exe', '--check')
    run(CACHE / 'inno' / 'ISCC.exe', f'/DAppVersion={LOCK["version"]}', 'packaging/windows/Viddow.iss')
    shutil.copy2('packaging/windows/WINDOWS-TEST.md', OUT)
    shutil.make_archive(str(OUT / 'Viddow-extension'), 'zip', REPO / 'extension')
    (OUT / 'build-environment.txt').write_text(subprocess.check_output([sys.executable, '-m', 'pip', 'freeze'], text=True), encoding='utf-8')
    write_checksums()


def write_checksums():
    sums = [f'{hashlib.file_digest(path.open("rb"), "sha256").hexdigest()}  {path.name}'
            for path in sorted(OUT.iterdir()) if path.is_file() and path.name != 'SHA256SUMS.txt']
    (OUT / 'SHA256SUMS.txt').write_text('\n'.join(sums) + '\n', encoding='utf-8')


if __name__ == '__main__':
    if sys.argv[1:] == ['--checksums-only']:
        write_checksums()
    else:
        main()
