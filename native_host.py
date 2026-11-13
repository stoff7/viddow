#!/usr/bin/env python3
"""Native Messaging-хост расширения: браузер запускает один процесс на канал, без server.py.

Протокол Chrome: сообщения в stdin/stdout, каждое — 4 байта длины (little-endian) + JSON.
Session v2 (основная панель):
    ← {"type": "session", "settings": {"workers": 2, "output_dir": "~/Downloads"}, "history": [...]}
    → {"type": "ready", "protocol": 2, "history_version": 1, "session", "jobs", "settings", "tools"}
    ← {"command": "download|inspect|inspect_cancel|inspect_history|cancel|retry|clear|configure|reveal", "request_id", "session", ...}
    → {"type": "reply", "request_id", "ok", "result" | "error"}
    → {"type": "state", "session", "jobs", "settings", "tools"} при изменении состояния
Команды требуют актуальный session ID. Очередь общая для вкладок расширения,
постоянная безопасная история принадлежит расширению (chrome.storage.local).
Восстановленные записи не запускаются. Закрытие панели не закрывает канал фонового процесса.

Совместимые одиночные команды (прежний клиент, отдельный канал на действие):
    ← {"type": "download", "url", "name", "page", "referer", "headers"}
    → {"type": "progress", "fraction", "label"} … и в конце {"type": "done", "path"} или {"type": "error", "error"}
    ← {"type": "reveal", "path"} → показать готовый файл в Finder, ответ {"type": "ok"}
Расширение закрыло порт (браузер закрыт/расширение перезагружено) → EOF → хост останавливает
yt-dlp/ffmpeg, а finally в download.py убирают недокачанное.

Отдельный inspect публикует state.analysis, не занимая очередь загрузок.
Отмена отдельной задачи/анализа session v2 не закрывает канал. Полный контракт:
docs/extension-control.md. Регистрация: python3 install_native_host.py; запуск через native_host.sh.
"""
import json
import os
import struct
import subprocess
import sys
import threading
import time
import urllib.parse

import download
import native_protocol

native_protocol.configure_stdio()
OUT = sys.stdout.buffer
sys.stdout = sys.stderr  # stdout — канал сообщений: случайный print сломал бы протокол
SEND_EVERY = 0.25  # с; чаще слать прогресс незачем
send_lock = threading.Lock()
cancelled = threading.Event()


def read_message():
    return native_protocol.read_message(sys.stdin.buffer)


def send(message):
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    try:
        with send_lock:
            OUT.write(struct.pack("<I", len(data)) + data)
            OUT.flush()
    except BrokenPipeError:
        pass  # расширение уже закрыло порт


def stop_on_disconnect():
    """После первого сообщения расширение молчит, так что конец stdin — это отмена или закрытый браузер.

    Читаем дескриптор напрямую: буферизованный sys.stdin держит блокировку, и при выходе
    интерпретатор падал бы с «could not acquire lock … daemon threads».
    """
    while os.read(0, 65536):
        pass
    cancelled.set()  # Общее ядро останавливает свою группу yt-dlp/ffmpeg и удаляет временные файлы.


def reveal(path):
    """Показать файл в Finder — только из папки загрузок, чужие пути не открываем."""
    path = os.path.realpath(path)
    if os.path.dirname(path) != os.path.realpath(download.DEFAULT_DIR) or not os.path.exists(path):
        raise ValueError("файла нет в папке загрузок")
    from platform_support import reveal_file
    reveal_file(path)


def run_download(message):
    if urllib.parse.urlparse(message.get("url", "")).scheme not in ("http", "https"):
        raise ValueError("нужен адрес http:// или https://")
    last_sent = 0.0

    def progress(fraction, label):
        nonlocal last_sent
        if cancelled.is_set():
            raise download.Cancelled
        now = time.monotonic()
        if now - last_sent >= SEND_EVERY:
            last_sent = now
            send({"type": "progress", "fraction": fraction, "label": label})

    return download.download(message["url"], name=message.get("name") or None,
                             referer=message.get("referer") or None, progress=progress,
                             browser_headers=message.get("headers") or None,
                             page_url=message.get("page") or None, cancel=cancelled,
                             source_kind=message.get("source_kind", "auto"))


def main():
    message = read_message()
    if not message:
        return
    try:
        if message.get("type") == "session":
            from native_session import Session
            Session(message.get("settings") or {}, send, history=message.get("history")).run(read_message)
            return
        if message.get("type") == "reveal":
            reveal(message.get("path", ""))
            send({"type": "ok"})
            return
        threading.Thread(target=stop_on_disconnect, daemon=True).start()
        send({"type": "done", "path": run_download(message)})
    except download.Cancelled:
        pass
    except Exception as e:
        if not cancelled.is_set():
            send({"type": "error", "error": str(e)})


if __name__ == "__main__":
    main()
