#!/usr/bin/env python3
"""Native Messaging-хост для extension/: браузер сам запускает его на каждую загрузку — без server.py.

Протокол Chrome: сообщения в stdin/stdout, каждое — 4 байта длины (little-endian) + JSON.
    ← {"type": "download", "url", "name", "page", "referer", "headers"}
    → {"type": "progress", "fraction", "label"} … и в конце {"type": "done", "path"} или {"type": "error", "error"}
    ← {"type": "reveal", "path"} → показать готовый файл в Finder, ответ {"type": "ok"}
Расширение закрыло порт (отмена, браузер закрыт) → stdin закрывается → хост останавливает
yt-dlp/ffmpeg, а finally в download.py убирают недокачанное.

Регистрация в браузере: python3 install_native_host.py. Запускается через native_host.sh.
"""
import json
import os
import signal
import struct
import subprocess
import sys
import threading
import time
import urllib.parse

import download

OUT = sys.stdout.buffer
sys.stdout = sys.stderr  # stdout — канал сообщений: случайный print сломал бы протокол
SEND_EVERY = 0.25  # с; чаще слать прогресс незачем
send_lock = threading.Lock()
cancelled = threading.Event()


class Cancelled(Exception):
    pass


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    return json.loads(sys.stdin.buffer.read(length))


def send(message):
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    try:
        with send_lock:
            OUT.write(struct.pack("<I", len(data)) + data)
            OUT.flush()
    except BrokenPipeError:
        pass  # расширение уже закрыло порт


def stop_on_disconnect(own_group):
    """После первого сообщения расширение молчит, так что конец stdin — это отмена или закрытый браузер.

    Читаем дескриптор напрямую: буферизованный sys.stdin держит блокировку, и при выходе
    интерпретатор падал бы с «could not acquire lock … daemon threads».
    """
    while os.read(0, 65536):
        pass
    cancelled.set()  # прямую загрузку (urllib, в этом процессе) остановит колбэк progress
    if own_group:
        os.killpg(0, signal.SIGTERM)  # yt-dlp/ffmpeg и их дочерние процессы


def reveal(path):
    """Показать файл в Finder — только из папки загрузок, чужие пути не открываем."""
    path = os.path.realpath(path)
    if os.path.dirname(path) != os.path.realpath(download.DEFAULT_DIR) or not os.path.exists(path):
        raise ValueError("файла нет в папке загрузок")
    subprocess.run(["open", "-R", path], check=True)


def run_download(message):
    if urllib.parse.urlparse(message.get("url", "")).scheme not in ("http", "https"):
        raise ValueError("нужен адрес http:// или https://")
    last_sent = 0.0

    def progress(fraction, label):
        nonlocal last_sent
        if cancelled.is_set():
            raise Cancelled
        now = time.monotonic()
        if now - last_sent >= SEND_EVERY:
            last_sent = now
            send({"type": "progress", "fraction": fraction, "label": label})

    return download.download(message["url"], name=message.get("name") or None,
                             referer=message.get("referer") or None, progress=progress,
                             browser_headers=message.get("headers") or None,
                             page_url=message.get("page") or None)


def main():
    message = read_message()
    if not message:
        return
    try:
        if message.get("type") == "reveal":
            reveal(message.get("path", ""))
            send({"type": "ok"})
            return
        # Своя группа процессов: при отмене гасим её целиком, не задевая браузер.
        # Сам хост SIGTERM переживает (обработчик, а не SIG_IGN — тот унаследовали бы дети).
        try:
            os.setpgrp()
        except OSError:
            pass
        own_group = os.getpgrp() == os.getpid()
        signal.signal(signal.SIGTERM, lambda *_: None)
        threading.Thread(target=stop_on_disconnect, args=(own_group,), daemon=True).start()
        send({"type": "done", "path": run_download(message)})
    except Cancelled:
        pass
    except Exception as e:
        if not cancelled.is_set():
            send({"type": "error", "error": str(e)})


if __name__ == "__main__":
    main()
