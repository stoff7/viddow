"""Явный ограниченный анализ источника. Сырые URL форматов/заголовки не публикуются."""
import copy
from concurrent.futures import ThreadPoolExecutor, as_completed
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
from source_auth import is_youtube, ytdlp_auth_args
from diagnostics import describe_error
from media_prepare import recommended, preview_gif
from trace_log import trace_event

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
        if "fps" in item and (not isinstance(item["fps"], (int, float)) or not 0 < item["fps"] <= 240):
            item.pop("fps")
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
    timeout = options.get("_timeout", timeout)
    deadline = time.monotonic() + timeout

    class Stop:
        def is_set(self):
            return cancel.is_set() or time.monotonic() >= deadline

    stop = Stop()
    headers = download.request_headers(options.get("referer"), options.get("headers")) if options.get("source_kind") != "page" and not is_youtube(url) else {
        **({"Referer": options["referer"]} if options.get("referer") else {}), **(options.get("headers") or {})}
    stream = options.get("source_kind") != "page" and (bool(options.get("stream_kind")) or urllib.parse.urlsplit(url).path.lower().endswith(download.STREAM_EXT))
    command = [executable, "--ignore-config", "--no-playlist", "--simulate", "--dump-single-json",
               "--no-check-formats", "--no-warnings", "--socket-timeout", "10", "--retries", "0"]
    command += ytdlp_auth_args(url, options.get("cookie_browser", "none"))
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
        download.run_ytdlp_tool(command + ["--", url], collect, stop, max_line_chars=MAX_JSON)
        if not lines:
            raise ValueError("Источник не вернул метаданные")
        info = json.loads(lines[0])
        result = normalize(info)
        # Bounded manifest classification for explicit or automatically prepared sources.
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
        if options.get('_preview_context'):
            best, _, _ = recommended(result)
            rows = info.get('formats') or [info]
            row = next((row for row in rows if str(row.get('format_id')) == best['id']), {})
            if best['kind'] in ('combined', 'video', 'unknown') and valid_url(row.get('url')):
                context_headers = {**(info.get('http_headers') or {}), **(row.get('http_headers') or {}), **headers}
                result['_preview'] = {'url': row['url'], 'headers': context_headers}
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
        self._sources = {}
        self._fallbacks = []
        self._fallback_only = False

    def start(self, url, fallbacks=None, fallback_only=False, **options):
        with self._lock:
            if self._state and self._state["status"] in ("running", "cancelling"):
                raise ValueError("Анализ уже идёт. Дождитесь результата или отмените его.")
            self._cancel.set()
            self._cancel = threading.Event()
            self._sources = {}
            self._fallbacks = copy.deepcopy(fallbacks or [])[:6]
            self._fallback_only = fallback_only
            self._options = copy.deepcopy(options)
            self._state = {"id": uuid.uuid4().hex, "url": url, "page": options.get("page") or url, "status": "running", "result": None, "error": None}
            trace_event("analysis_start", analysis_tag=self._state["id"], candidates_count=len(self._fallbacks), status="running")
            self._thread = threading.Thread(target=self._run, args=(url,), name="inspect", daemon=True)
            self._thread.start()
            return {"analysis_id": self._state["id"]}

    def _analyze(self, url, options):
        started = time.monotonic()
        trace_event('candidate_start', analysis_tag=self._state['id'], source_tag=options.get('_trace_tag'))
        try:
            result = self.inspect(url, {**options, '_preview_context': True}, self._cancel)
        except Exception as error:
            trace_event('candidate_error', analysis_tag=self._state['id'], source_tag=options.get('_trace_tag'), code=describe_error(error)[0], elapsed_ms=int((time.monotonic() - started) * 1000))
            raise
        trace_event('candidate_done', analysis_tag=self._state['id'], source_tag=options.get('_trace_tag'), formats_count=len(result.get('formats', [])), elapsed_ms=int((time.monotonic() - started) * 1000))
        context = result.pop('_preview', None)
        if options.get('stream_kind') and options.get('name'):
            result['title'] = options['name'][:512]
        source = {'url': url, 'options': options, 'result': result, 'preview_context': context,
                  'preview_lock': threading.Lock(), 'preview_done': False, 'preview': None}
        return source

    def _run(self, url):
        try:
            sources = []
            if not self._fallback_only:
                try:
                    sources = [self._analyze(url, self._options)]
                except Exception as error:
                    if describe_error(error)[0] != 'unsupported_source' or not self._fallbacks:
                        raise
            if not sources:
                # Each candidate has its own context, timeout and failure. Never merge by title/path.
                def analyze(item):
                    options = {**self._options, **item['options'], '_timeout': 12}
                    return self._analyze(item['url'], options)
                with ThreadPoolExecutor(max_workers=2, thread_name_prefix='media-candidate') as pool:
                    futures = [pool.submit(analyze, item) for item in self._fallbacks]
                    for future in as_completed(futures):
                        download.check_cancel(self._cancel)
                        try:
                            sources.append(future.result())
                        except download.Cancelled:
                            raise
                        except Exception:
                            pass  # One expired or unsupported candidate must not hide another video.
                if not sources:
                    raise ValueError('Найденные видео пока недоступны. Откройте нужное видео на странице.')
            sources.sort(key=lambda source: (recommended(source['result'])[2], source['url']), reverse=True)
            private, public = {}, []
            for source in sources:
                identifier = uuid.uuid4().hex
                private[identifier] = source
                _, ids, _ = recommended(source['result'])
                public.append({**source['result'], 'id': identifier, 'source_url': source['url'], 'recommended_format_ids': ids})
            selected = public[0]
            result = {**selected, 'source_id': selected['id'], 'videos': public}
            while len(json.dumps(result).encode('utf-8')) > 512 * 1024 and len(public) > 1:
                private.pop(public.pop()['id'])
            if len(json.dumps(result).encode('utf-8')) > 512 * 1024:
                raise ValueError('Метаданные видео слишком большие для панели')
            with self._lock:
                download.check_cancel(self._cancel)
                self._sources = private
                self._state.update(status='done', result=result, url=sources[0]['url'])
                trace_event('analysis_done', analysis_tag=self._state['id'], source_tag=selected['id'], candidate_tag=sources[0]['options'].get('_trace_tag'), candidates_count=len(public), status='done')
        except Exception as error:
            with self._lock:
                cancelled = self._cancel.is_set() or isinstance(error, download.Cancelled)
                code, message = describe_error(error)
                trace_event('analysis_cancelled' if cancelled else 'candidate_error', analysis_tag=self._state['id'], code=code, status='cancelled' if cancelled else 'error')
                self._state.update(status='cancelled' if cancelled else 'error', error=None if cancelled else message,
                                   error_code=None if cancelled else code, error_detail=None if cancelled else str(error)[:16384])

    def preview(self, identifier, source_id):
        with self._lock:
            if not self._state or self._state['id'] != identifier or self._state['status'] != 'done' or source_id not in self._sources:
                raise ValueError('Выбранное видео изменилось.')
            source, cancel = self._sources[source_id], self._cancel
        with source['preview_lock']:
            download.check_cancel(cancel)
            if not source['preview_done']:
                started = time.monotonic()
                trace_event('preview_start', analysis_tag=identifier, source_tag=source_id)
                source['preview'] = preview_gif(source['preview_context'], cancel)
                source['preview_done'] = True
                trace_event('preview_done' if source['preview'] else 'preview_error', analysis_tag=identifier, source_tag=source_id, bytes_count=len(source['preview'] or ''), elapsed_ms=int((time.monotonic() - started) * 1000))
            download.check_cancel(cancel)
            return {'analysis_id': identifier, 'source_id': source_id, 'image': source['preview']}

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

    def invalidate(self):
        """Смена контекста: старый выбор недействителен, текущий анализ отменяется."""
        with self._lock:
            self._cancel.set()
            self.stop()
            # До выхода worker сохраняем cancelling: новый анализ не должен
            # заменить его state/options/cancel, пока тот ещё может их читать.
            if not self._state or self._state["status"] != "cancelling":
                self._state = None
                self._options = None

    def selection(self, identifier, value, source_id=None):
        with self._lock:
            if not self._state or self._state["id"] != identifier or self._state["status"] != "done":
                raise ValueError("Анализ изменился или ещё не завершён. Запросите качество заново.")
            ids = format_ids_from(value)
            if not ids:
                raise ValueError("Выберите формат")
            source_id = source_id or self._state['result']['source_id']
            source = self._sources.get(source_id)
            if not source:
                raise ValueError('Выбранного видео нет в результате анализа')
            formats = {item["id"]: item for item in source['result']['formats']}
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
            options = copy.deepcopy(source["options"])
            options.update(format_ids=ids, format_label=" · ".join([quality, *audio]),
                           name=options.get("name") or source["result"]["title"])
            options.pop("_timeout", None)
            options.pop("_trace_tag", None)
            return [source["url"]], options

    def close(self):
        self._cancel.set()
        self.stop()
        if self._thread:
            self._thread.join()
