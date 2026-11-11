"""Явный ограниченный анализ источника. Сырые URL форматов/заголовки не публикуются."""
import copy
import json
import math
import re
import shutil
import threading
import time
import urllib.parse
import urllib.request
import uuid

import download
from contracts import format_ids_from, valid_url

TIMEOUT = 30
MAX_JSON = 8 * 1024 * 1024
MAX_MANIFEST = 1024 * 1024


def hls_kind(text):
    lines = text.lstrip("\ufeff").splitlines()
    if not lines or lines[0].strip() != "#EXTM3U":
        return "unknown"
    if any(line.startswith(("#EXT-X-STREAM-INF:", "#EXT-X-I-FRAME-STREAM-INF:", "#EXT-X-MEDIA:")) for line in lines):
        return "master"
    if any(line.startswith(("#EXTINF:", "#EXT-X-TARGETDURATION:", "#EXT-X-PART:")) for line in lines):
        return "media"
    return "unknown"


def normalize(info):
    if not isinstance(info, dict) or info.get("_type") in ("playlist", "multi_video"):
        raise ValueError("Выберите отдельное видео, а не плейлист")
    rows = info.get("formats") or ([info] if info.get("format_id") else [])
    formats, seen = [], set()
    for row in rows:
        identifier = str(row.get("format_id", ""))
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", identifier) or identifier in seen or row.get("has_drm"):
            continue
        video, audio = row.get("vcodec"), row.get("acodec")
        if video == audio == "none":
            continue
        kind = "audio" if video == "none" else "video" if audio == "none" and video else (
            "combined" if video and audio else "unknown")
        item = {"id": identifier, "kind": kind}
        for key in ("ext", "width", "height", "fps", "vcodec", "acodec", "language", "audio_channels", "abr", "tbr", "filesize", "filesize_approx", "format_note"):
            value = row.get(key)
            if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                if isinstance(value, str) or math.isfinite(value):
                    item[key] = value[:240] if isinstance(value, str) else value
        formats.append(item)
        seen.add(identifier)
    if not formats:
        raise ValueError("Нет доступных форматов. Можно попробовать обычное скачивание.")
    if len(formats) > 300:
        raise ValueError("Больше 300 форматов: выберите конкретный поток или скачайте без анализа")
    thumbnail = info.get("thumbnail")
    duration = info.get("duration")
    result = {"title": str(info.get("title") or "Видео")[:512],
              "thumbnail": thumbnail if valid_url(thumbnail) and len(thumbnail) <= 16384 else None,
              "duration": duration if type(duration) in (int, float) and math.isfinite(duration) and duration >= 0 else None,
              "is_live": bool(info.get("is_live")),
              "hls_kind": "unknown", "formats": formats}
    if len(json.dumps(result).encode("utf-8")) > 256 * 1024:
        raise ValueError("Метаданные слишком большие для панели. Выберите конкретный поток.")
    return result


def inspect_source(url, options, cancel, timeout=TIMEOUT):
    executable = shutil.which("yt-dlp")
    if not executable:
        raise RuntimeError("Для анализа нужен yt-dlp: brew install yt-dlp")
    deadline = time.monotonic() + timeout

    class Stop:
        def is_set(self):
            return cancel.is_set() or time.monotonic() >= deadline

    stop = Stop()
    headers = download.request_headers(options.get("referer"), options.get("headers")) if options.get("source_kind") != "page" else {
        **({"Referer": options["referer"]} if options.get("referer") else {}), **(options.get("headers") or {})}
    stream = options.get("source_kind") != "page" and (bool(options.get("stream_kind")) or urllib.parse.urlsplit(url).path.lower().endswith(download.STREAM_EXT))
    command = [executable, "--ignore-config", "--no-playlist", "--simulate", "--dump-single-json",
               "--no-check-formats", "--no-warnings", "--socket-timeout", "10", "--retries", "0"]
    if stream:
        command += ["--impersonate", "chrome"]
    for key, value in headers.items():
        command += ["--add-headers", f"{key}:{value}"]
    lines = []

    def collect(line):
        if len(line.encode("utf-8")) > MAX_JSON:
            raise ValueError("Метаданные слишком большие")
        lines.append(line)
        if len(lines) > 1:
            raise ValueError("Ожидалось одно видео")

    try:
        download.run_tool(command + ["--", url], collect, stop, max_line_chars=MAX_JSON)
        if not lines:
            raise ValueError("Источник не вернул метаданные")
        result = normalize(json.loads(lines[0]))
        # Отдельный ограниченный GET разрешён только явным анализом пользователя.
        if stream and (options.get("stream_kind") == "HLS" or urllib.parse.urlsplit(url).path.lower().endswith(".m3u8")):
            download.check_cancel(stop)
            try:
                remaining = max(.1, min(1, deadline - time.monotonic()))
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=remaining) as response:
                    data = bytearray()
                    while len(data) <= MAX_MANIFEST:
                        download.check_cancel(stop)
                        chunk = response.read1(min(65536, MAX_MANIFEST + 1 - len(data)))
                        if not chunk:
                            break
                        data.extend(chunk)
                if len(data) <= MAX_MANIFEST:
                    result["hls_kind"] = hls_kind(data.decode("utf-8", errors="replace"))
            except (OSError, ValueError):
                # Некоторые CDN требуют TLS impersonation: не угадываем тип по имени.
                result["hls_kind"] = "unknown"
        download.check_cancel(stop)
        return result
    except download.Cancelled:
        if cancel.is_set():
            raise
        raise TimeoutError("Анализ занял больше 30 секунд. Можно скачать без анализа.") from None


class Inspector:
    def __init__(self, inspect=inspect_source):
        self.inspect = inspect
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._thread = None
        self._state = None
        self._options = None

    def start(self, url, **options):
        with self._lock:
            if self._state and self._state["status"] in ("running", "cancelling"):
                raise ValueError("Анализ уже идёт. Дождитесь результата или отмените его.")
            self._cancel = threading.Event()
            self._options = copy.deepcopy(options)
            self._state = {"id": uuid.uuid4().hex, "url": url, "status": "running", "result": None, "error": None}
            self._thread = threading.Thread(target=self._run, args=(url,), name="inspect", daemon=True)
            self._thread.start()
            return {"analysis_id": self._state["id"]}

    def _run(self, url):
        try:
            result = self.inspect(url, self._options, self._cancel)
            with self._lock:
                download.check_cancel(self._cancel)
                self._state.update(status="done", result=result)
        except Exception as error:
            with self._lock:
                cancelled = self._cancel.is_set() or isinstance(error, download.Cancelled)
                self._state.update(status="cancelled" if cancelled else "error", error=None if cancelled else str(error))

    def snapshot(self):
        with self._lock:
            return copy.deepcopy(self._state)

    def stop(self, identifier=None):
        with self._lock:
            if identifier is not None and (not self._state or self._state["id"] != identifier):
                raise ValueError("Анализ изменился. Обновите карточку.")
            if self._state and self._state["status"] in ("running", "cancelling"):
                self._cancel.set()
                self._state["status"] = "cancelling"

    def selection(self, identifier, value):
        with self._lock:
            if not self._state or self._state["id"] != identifier or self._state["status"] != "done":
                raise ValueError("Анализ изменился или ещё не завершён. Запросите качество заново.")
            ids = format_ids_from(value)
            if not ids:
                raise ValueError("Выберите формат")
            formats = {item["id"]: item for item in self._state["result"]["formats"]}
            if any(identifier not in formats for identifier in ids):
                raise ValueError("Выбранного формата нет в результате анализа")
            chosen = [formats[identifier] for identifier in ids]
            if len(ids) > 1:
                if chosen[0]["kind"] != "video" or any(item["kind"] != "audio" for item in chosen[1:]):
                    raise ValueError("Отдельный звук можно добавить только к видео без звука")
                if not shutil.which("ffmpeg"):
                    raise ValueError("Для объединения видео и звука нужен ffmpeg: brew install ffmpeg")
            first = chosen[0]
            quality = "Только звук" if first["kind"] == "audio" else f"{first['height']}p" if first.get("height") else first["id"]
            audio = [item.get("language") or item.get("format_note") or item["id"] for item in chosen if item["kind"] == "audio"]
            if not audio:
                audio = ["без звука"] if first["kind"] == "video" else ["со звуком"] if first["kind"] == "combined" else ["состав дорожек неизвестен"]
            options = copy.deepcopy(self._options)
            options.update(format_ids=ids, format_label=" · ".join([quality, *audio]),
                           name=options.get("name") or self._state["result"]["title"])
            return [self._state["url"]], options

    def close(self):
        self.stop()
        if self._thread:
            self._thread.join()
