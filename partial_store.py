"""Private bounded partials, separate from ephemeral extractor JSON and history.

Persistent reuse is currently POSIX-only: Windows ACL/process ownership acceptance
must precede persistence there. Locks protect parts from other hosts and cleanup.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import uuid

try:
    import fcntl
except ImportError:
    fcntl = None

MAX_BYTES = 5 * 1024**3
MAX_AGE = 7 * 86400
MAX_ENTRIES = 128


def digest(value):
    if not isinstance(value, bytes):
        value = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(value).hexdigest()


def file_digest(path):
    value = hashlib.sha256()
    with open(path, 'rb') as file:
        while chunk := file.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


class Lease:
    def __init__(self, path, persistent):
        self.path, self.persistent = path, persistent
        self.retain = False

    def read(self):
        file = self.path / 'state.json'
        try:
            if file.is_symlink() or file.stat().st_size > 65536:
                return None
            value = json.loads(file.read_text())
            if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1
                    or type(value.get('size')) is not int or not 0 < value['size'] < 2**63
                    or type(value.get('saved')) is not int or not 0 <= value['saved'] <= value['size']
                    or any(not isinstance(value.get(key), str) or not re.fullmatch('[a-f0-9]{64}', value[key]) for key in ('object', 'checksum'))):
                return None
            return {key: value[key] for key in ('version', 'size', 'saved', 'object', 'checksum')}
        except (OSError, ValueError):
            return None

    def write(self, state):
        temporary = self.path / 'state.new'
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), 0o600), 'w') as file:
            json.dump({'version': 1, **state}, file, separators=(',', ':'))
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(self.path / 'state.json')
        os.utime(self.path, None)

    def reset(self):
        for file in self.path.iterdir():
            if file.is_symlink() or file.is_file():
                file.unlink()
            elif file.is_dir():
                shutil.rmtree(file)


class PartsStore:
    def __init__(self, folder, *, quota=MAX_BYTES, max_age=MAX_AGE):
        self.root = Path(folder) / '.viddow-parts'
        self.quota, self.max_age = quota, max_age

    def _prepare(self):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        stat = self.root.lstat()
        if self.root.is_symlink() or not self.root.is_dir():
            raise OSError('Небезопасный каталог незавершённых загрузок')
        if hasattr(os, 'getuid') and (stat.st_uid != os.getuid() or stat.st_mode & 0o077):
            raise PermissionError('Каталог незавершённых загрузок должен быть доступен только владельцу')

    @contextmanager
    def _lock(self, key):
        directory_fd = os.open(self.root / '.directory.lock', os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        fd = None
        owned = False
        try:
            fcntl.flock(directory_fd, fcntl.LOCK_EX)
            try:
                fd = os.open(self.root / (key + '.lock'), os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    owned = True
                except BlockingIOError:
                    pass
            finally:
                fcntl.flock(directory_fd, fcntl.LOCK_UN)
            yield owned
        finally:
            if owned:
                fcntl.flock(directory_fd, fcntl.LOCK_EX)
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                    (self.root / (key + '.lock')).unlink()
                finally:
                    fcntl.flock(directory_fd, fcntl.LOCK_UN)
            if fd is not None:
                os.close(fd)
            os.close(directory_fd)

    def discard(self, key):
        if fcntl is None or not self.root.exists():
            return
        self._prepare()
        with self._lock(key) as owned:
            path = self.root / key
            if owned and path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)

    @contextmanager
    def lease(self, key):
        if not re.fullmatch('[a-f0-9]{64}', key):
            raise ValueError('Invalid partial key')
        if fcntl is None or os.environ.get('VIDDOW_PERSIST_PARTS', '1') == '0':
            with tempfile.TemporaryDirectory(prefix='viddow-work-') as tmp:
                yield Lease(Path(tmp), False)
            return
        self._prepare()
        self.cleanup()
        with self._lock(key) as owned:
            if not owned:
                # An identical concurrent request must not share mutable bytes.
                with self.lease(digest(uuid.uuid4().hex)) as duplicate:
                    duplicate.persistent = False
                    yield duplicate
                return
            path = self.root / key
            if path.is_symlink():
                raise OSError('Небезопасный каталог частей')
            path.mkdir(mode=0o700, exist_ok=True)
            stat = path.stat()
            if hasattr(os, 'getuid') and (stat.st_uid != os.getuid() or stat.st_mode & 0o077):
                raise PermissionError('Каталог частей должен быть доступен только владельцу')
            lease = Lease(path, True)
            try:
                yield lease
            finally:
                size = sum(file.stat().st_size for file in path.rglob('*') if file.is_file() and not file.is_symlink())
                if not lease.retain or size > self.quota:
                    shutil.rmtree(path)
        self.cleanup()

    def cleanup(self, *, all_inactive=False):
        if fcntl is None or not self.root.exists():
            return 0
        self._prepare()
        entries = []
        for path in self.root.iterdir():
            if re.fullmatch('[a-f0-9]{64}', path.name) and path.is_dir() and not path.is_symlink():
                entries.append((path.stat().st_mtime, path))
        entries.sort(reverse=True)
        total, kept, removed = 0, 0, 0
        for modified, path in entries:
            with self._lock(path.name) as owned:
                if not owned or not path.exists():
                    continue
                size = sum(file.stat().st_size for file in path.rglob('*') if file.is_file() and not file.is_symlink())
                if all_inactive or time.time() - modified > self.max_age or total + size > self.quota or kept >= MAX_ENTRIES:
                    shutil.rmtree(path); removed += 1
                else:
                    total += size; kept += 1
        return removed
