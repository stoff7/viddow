"""Bounded recovery for the existing direct HTTP path; strict object validation."""
from datetime import datetime, timezone
from contextlib import closing, nullcontext
from email.utils import parsedate_to_datetime
import http.client
import hashlib
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import time
import urllib.error
import urllib.request

from download_runtime import CURRENT, observed_bytes, finishing
from partial_store import PartsStore, digest, file_digest
from trace_log import trace_event

ATTEMPTS = 3
RECOVERY_SECONDS = 60
TRANSIENT = {408, 429, 500, 502, 503, 504}


class NeedsRouting(Exception):
    """A filename-looking URL actually returned a page or manifest."""


def trace_recovery(recovery, **fields):
    attempt = CURRENT.get()
    tags = {'attempt_tag': attempt.attempt_tag, 'run_tag': attempt.run_tag} if attempt else {}
    trace_event('recovery_state', recovery=recovery, **tags, **fields)


def retry_delay(error, attempt):
    value = error.headers.get('Retry-After') if isinstance(error, urllib.error.HTTPError) else None
    try:
        delay = float(value)
    except (TypeError, ValueError):
        try:
            delay = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            delay = 2 ** attempt
    return max(0., delay)


def wait_retry(error, attempt, deadline, cancel):
    from download import check_cancel
    delay = retry_delay(error, attempt)
    if time.monotonic() + delay > deadline:
        return False
    check_cancel(cancel)
    if cancel is not None:
        cancel.wait(delay)
        check_cancel(cancel)
    else:
        time.sleep(delay)
    return True


def transient(error):
    if isinstance(error, urllib.error.HTTPError):
        return error.code in TRANSIENT
    if isinstance(error, urllib.error.URLError):
        return isinstance(error.reason, (socket.timeout, ConnectionError)) and not isinstance(error.reason, ssl.SSLError)
    return isinstance(error, (socket.timeout, ConnectionError, http.client.IncompleteRead)) and not isinstance(error, ssl.SSLError)


def identity(response, headers):
    etag = response.headers.get('ETag', '')
    size = response.headers.get('Content-Length', '')
    # Weak validators, unknown length and content coding are never appendable.
    if not re.fullmatch(r'"[^"\x00-\x20\x7f]*"', etag) or not size.isdecimal() or response.headers.get('Content-Encoding', 'identity') != 'identity':
        return None
    return dict(object=digest([response.url, etag, int(size), headers]), size=int(size))


def download_direct(url, folder, name, headers, progress, cancel, *, auto=False):
    from download import (Cancelled, CHUNK_SIZE, check_cancel, filename_from, clean_name, reserve,
                          remove_part, finalize_file, complete_download_metadata, megabytes)
    def check_type(response):
        if auto:
            content_type = response.headers.get_content_type()
            if content_type in ('text/html', 'application/xhtml+xml') or any(value in content_type for value in ('mpegurl', 'dash')):
                raise NeedsRouting()

    key = digest(['direct-v1', url, headers])
    initial = None
    prefetched_failures = 0
    deadline = None
    if not PartsStore(folder).root.exists():
        # Preserve the old no-files-on-HTTP-error behavior. A failed first request
        # is retried below without having created a persistent workspace.
        try:
            initial = urllib.request.urlopen(urllib.request.Request(url, headers={**headers, 'Accept-Encoding': 'identity'}), timeout=30)
            try:
                check_type(initial)
            except NeedsRouting:
                initial.close()
                raise
        except Exception as error:
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            if not transient(error):
                raise
            prefetched_failures = 1
            deadline = time.monotonic() + RECOVERY_SECONDS
            if not wait_retry(error, 0, deadline, cancel):
                raise
    with (closing(initial) if initial is not None else nullcontext()), PartsStore(folder).lease(key) as lease:
        part = lease.path / 'payload.part'
        state = lease.read()
        if part.is_symlink():
            lease.reset(); state = None
        offset = state.get('saved', 0) if state and part.is_file() else 0
        if type(offset) is not int or offset < 0:
            offset = 0; state = None
        if offset and part.stat().st_size > offset:
            with open(part, 'r+b') as file:
                file.truncate(offset)  # Discard bytes after the last durable checkpoint.
        if offset and (offset >= state.get('size', 0) or part.stat().st_size != offset or state.get('checksum') != file_digest(part)):
            lease.reset(); state = None; offset = 0
        path = reservation = None
        try:
            for attempt in range(prefetched_failures, ATTEMPTS):
                check_cancel(cancel)
                try:
                    request_headers = {**headers, 'Accept-Encoding': 'identity'}
                    valid = None
                    if offset and state:
                        # HEAD supplies the fresh validator; persisted state contains hashes only.
                        try:
                            with urllib.request.urlopen(urllib.request.Request(url, headers=request_headers, method='HEAD'), timeout=30) as head:
                                valid = identity(head, headers)
                                if valid == {k: state[k] for k in ('object', 'size')}:
                                    request_headers.update(Range=f'bytes={offset}-', **{'If-Range': head.headers['ETag']})
                                else:
                                    valid = None
                        except urllib.error.HTTPError as error:
                            if error.code not in (405, 501):
                                raise
                            error.close()
                    response = initial or urllib.request.urlopen(urllib.request.Request(url, headers=request_headers), timeout=30)
                    initial = None
                    with response:
                        check_type(response)
                        if offset and valid:
                            expected = f'bytes {offset}-{state["size"] - 1}/{state["size"]}'
                            if (response.status != 206 or response.headers.get('Content-Range') != expected
                                    or response.headers.get('Content-Encoding', 'identity') != 'identity'
                                    or digest([response.url, response.headers.get('ETag'), state['size'], headers]) != state['object']
                                    or int(response.headers.get('Content-Length', '-1')) != state['size'] - offset):
                                # A 200 is a fresh object, never an append. Reopen without Range.
                                lease.reset(); state = None; offset = 0
                                if response.status == 206:
                                    raise RuntimeError('Сервер вернул неверный диапазон; части не использованы')
                                valid = None
                        if not valid:
                            lease.reset(); offset = 0
                            state = identity(response, headers)
                            if response.status != 200:
                                raise RuntimeError('Сервер вернул неожиданный диапазон')
                        if path is None:
                            filename = filename_from(response)
                            if name:
                                filename = clean_name(name) + os.path.splitext(filename)[1]
                            path = reservation = reserve(folder, filename)
                        total = state['size'] if state else int(response.headers.get('Content-Length') or 0)
                        needed = max(0, total - offset)
                        # A second copy is not needed on this volume; allow mux/copy headroom elsewhere.
                        if needed and shutil.disk_usage(folder).free < needed:
                            raise OSError(28, 'Недостаточно свободного места для загрузки')
                        trace_recovery('resumed' if offset else 'fresh', reused_bytes=offset)
                        checksum = hashlib.sha256()
                        if offset:
                            with open(part, 'rb') as previous:
                                while chunk := previous.read(1024 * 1024):
                                    checksum.update(chunk)
                        checkpoint = offset
                        if state:
                            lease.write({**state, 'saved': offset, 'checksum': checksum.hexdigest()})
                        with open(part, 'ab' if offset else 'wb') as output:
                            while True:
                                check_cancel(cancel)
                                try:
                                    chunk = response.read(CHUNK_SIZE)
                                except http.client.IncompleteRead as error:
                                    chunk = error.partial
                                    if chunk:
                                        output.write(chunk); checksum.update(chunk); offset += len(chunk); observed_bytes(offset)
                                    raise
                                if not chunk:
                                    break
                                output.write(chunk); checksum.update(chunk); offset += len(chunk)
                                observed_bytes(offset)
                                progress(offset / total if total else None, megabytes(offset, total))
                                if state and offset - checkpoint >= 8 * 1024 * 1024:
                                    output.flush(); os.fsync(output.fileno())
                                    lease.write({**state, 'saved': offset, 'checksum': checksum.hexdigest()})
                                    checkpoint = offset
                            output.flush()
                            os.fsync(output.fileno())
                        if total and offset != total:
                            raise http.client.IncompleteRead(b'', max(0, total - offset))
                        check_cancel(cancel)
                        finishing()
                        # POSIX store is on the destination volume. Windows uses an ephemeral
                        # workspace; copying to our reserved sibling preserves exclusive finalization.
                        if part.stat().st_dev == Path(folder).stat().st_dev:
                            os.replace(part, path + '.part')
                        else:
                            shutil.copyfile(part, path + '.part')
                        path = finalize_file(path + '.part', path, cancel)
                        complete_download_metadata(path, response.url, headers.get('Referer'))
                        return path
                except Exception as error:
                    if isinstance(error, urllib.error.HTTPError):
                        error.close()
                    if isinstance(error, Cancelled) or not transient(error):
                        raise
                    if state and part.is_file() and 0 < part.stat().st_size < state['size']:
                        state = {**state, 'saved': part.stat().st_size, 'checksum': file_digest(part)}
                        lease.write(state)
                    else:
                        lease.reset(); state = None; offset = 0
                    deadline = deadline or time.monotonic() + RECOVERY_SECONDS
                    if attempt == ATTEMPTS - 1 or not wait_retry(error, attempt, deadline, cancel):
                        raise
        except BaseException as error:
            if not isinstance(error, Cancelled) and transient(error) and state and part.is_file() and 0 < part.stat().st_size < state['size']:
                lease.write({**state, 'saved': part.stat().st_size, 'checksum': file_digest(part)})
                lease.retain = lease.persistent
                trace_recovery('retained')
            raise
        finally:
            if initial is not None:
                initial.close()
            if reservation:
                remove_part(reservation + '.part')
