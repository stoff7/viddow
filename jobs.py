"""Очередь загрузок для HTTP и Native Messaging. Заголовки не входят в публичный снимок."""
import itertools
import os
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

import download
from diagnostics import describe_error

ACTIVE = {"queued", "running", "cancelling"}
TERMINAL = {"done", "error", "cancelled", "interrupted"}


class Conflict(ValueError):
    pass


@dataclass
class Job:
    id: int
    url: str
    options: dict
    status: str = "queued"
    fraction: Optional[float] = None
    label: str = "В очереди"
    path: Optional[str] = None
    error: Optional[str] = None
    cancel: threading.Event = field(default_factory=threading.Event)
    restored: bool = False
    created_at: int = field(default_factory=lambda: int(time.time() * 1000))
    error_code: Optional[str] = None
    error_detail: Optional[str] = None

    def snapshot(self):
        return {"id": self.id, "url": self.url, "name": self.options.get("name"),
                "status": self.status, "fraction": self.fraction, "label": self.label,
                "error_code": self.error_code, "error_detail": self.error_detail,
                "path": self.path, "error": self.error,
                "format_ids": list(self.options.get("format_ids") or []),
                "format_label": self.options.get("format_label"),
                "page": self.options.get("page") or (self.url if self.options.get("source_kind") == "page" else None),
                "page_retry": self.options.get("page_retry", False),
                "restored": self.restored, "created_at": self.created_at,
                "source_origin": self.options.get("source_origin"),
                "http_status": self.options.get("http_status"),
                "file_exists": bool(self.path and os.path.isfile(self.path)) if self.status == "done" else None}


class JobManager:
    def __init__(self, workers=2, folder=download.DEFAULT_DIR, runner=None, max_pending=200):
        self.workers = workers
        self.folder = folder
        self.runner = runner or download.download
        self.max_pending = max_pending
        self._lock = threading.RLock()
        self._jobs = {}
        self._ids = itertools.count(1)
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="download")
        self._closed = False

    def restore_history(self, records):
        """Восстанавливает только записи: ни одна не поступает в executor."""
        from contracts import valid_url
        with self._lock:
            if self._jobs or not isinstance(records, list):
                raise ValueError("История восстанавливается только в пустую очередь")
            for row in records:
                if not isinstance(row, dict) or type(row.get("id")) is not int or not 0 < row["id"] < 2 ** 53:
                    raise ValueError("Неверный ID записи истории")
                if row["id"] in self._jobs or row.get("status") not in ACTIVE | TERMINAL:
                    raise ValueError("Неверное состояние записи истории")
                page = row.get("page")
                if page and not valid_url(page):
                    raise ValueError("Неверная исходная страница истории")
                if page:
                    parsed = urllib.parse.urlsplit(page)
                    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
                    identity = parsed.hostname in {"youtube.com", "www.youtube.com", "m.youtube.com"} and parsed.path == "/watch" and len(query) == 1 and query[0][0] == "v"
                    if parsed.username or parsed.password or parsed.fragment or (parsed.query and not identity):
                        raise ValueError("Небезопасная исходная страница истории")
                origin = row.get("source_origin") or ""
                if origin and not valid_url(origin):
                    raise ValueError("Неверный источник истории")
                path = row.get("path")
                if path is not None and (not isinstance(path, str) or not os.path.isabs(path) or "\x00" in path):
                    raise ValueError("Неверный путь файла истории")
                status = "interrupted" if row["status"] in ACTIVE else row["status"]
                code = row.get("http_status")
                error = f"HTTP {code}. Ошибка в предыдущей сессии." if type(code) is int and 400 <= code <= 599 else "Ошибка в предыдущей сессии. Получите свежую ссылку со страницы."
                job = Job(row["id"], page or origin, {"name": row.get("name") or "Видео", "page": page,
                    "page_retry": bool(page and row.get("page_retry") is True), "format_label": row.get("format_label"),
                    "http_status": code, "source_origin": origin}, status=status, path=path if status == "done" else None,
                    error=error if status == "error" else None, restored=True,
                    created_at=row.get("created_at", 0), fraction=1 if status == "done" else None)
                self._jobs[job.id] = job
            self._ids = itertools.count(max(self._jobs, default=0) + 1)

    def add(self, urls, **options):
        with self._lock:
            if self._closed:
                raise Conflict("Сервер останавливается")
            pending = sum(job.status in ACTIVE for job in self._jobs.values())
            if pending + len(urls) > self.max_pending:
                raise Conflict("Очередь заполнена. Дождитесь завершения загрузок.")
            ids = []
            for url in urls:
                job = Job(next(self._ids), url, {**options, "headers": dict(options.get("headers") or {})})
                if options.get("format_ids"):
                    job.options["format_ids"] = list(options["format_ids"])
                self._jobs[job.id] = job
                self._executor.submit(self._run, job)
                ids.append(job.id)
            return ids

    def snapshots(self):
        with self._lock:
            return [job.snapshot() for job in self._jobs.values()]

    def cancel(self, job_id):
        with self._lock:
            job = self._jobs[job_id]
            if job.status in ACTIVE:
                job.cancel.set()
                job.status = "cancelled" if job.status == "queued" else "cancelling"
                job.label = "Отменено" if job.status == "cancelled" else "Останавливаем загрузку…"
            return job.snapshot()

    def retry(self, job_id, *, cookie_browser=None):
        with self._lock:
            job = self._jobs[job_id]
            if job.restored:
                raise Conflict("Для старой записи получите свежие форматы со страницы")
            if job.status not in {"error", "cancelled"}:
                raise Conflict("Повтор доступен только после ошибки или отмены")
            options = {**job.options}
            if cookie_browser is not None:
                options["cookie_browser"] = cookie_browser
            return self.add([job.url], **options)[0]

    def clear(self):
        with self._lock:
            self._jobs = {key: job for key, job in self._jobs.items() if job.status not in TERMINAL}

    def configure(self, workers, folder):
        """Меняем настройки только между загрузками, сохраняя завершённые записи."""
        with self._lock:
            if self._closed or any(job.status in ACTIVE for job in self._jobs.values()):
                raise Conflict("Настройки можно изменить после завершения или отмены активных загрузок")
            previous = self._executor
            self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="download")
            self.workers, self.folder = workers, folder
        previous.shutdown(wait=True, cancel_futures=True)

    def _run(self, job):
        with self._lock:
            if job.cancel.is_set():
                return
            job.status, job.label = "running", "Подготовка…"

        def progress(fraction, label):
            download.check_cancel(job.cancel)
            with self._lock:
                if job.status == "running":
                    job.fraction = max(0, min(1, fraction)) if fraction is not None else None
                    job.label = label

        try:
            selection = {"format_ids": list(job.options["format_ids"])} if job.options.get("format_ids") else {}
            if job.options.get("stream_kind"):
                selection["stream_kind"] = job.options["stream_kind"]
            if job.options.get("cookie_browser"):
                selection["cookie_browser"] = job.options["cookie_browser"]
            path = self.runner(job.url, folder=self.folder, name=job.options.get("name"),
                               referer=job.options.get("referer"), progress=progress,
                               browser_headers=job.options.get("headers"),
                               page_url=job.options.get("page"), cancel=job.cancel,
                               source_kind=job.options.get("source_kind", "auto"), **selection)
            with self._lock:
                # Возвращённый путь означает готовый файл, даже если отмена пришла на финише.
                job.path, job.status, job.fraction, job.label = path, "done", 1, "Сохранено"
        except Exception as error:
            with self._lock:
                if isinstance(error, download.Cancelled) or job.cancel.is_set():
                    job.status, job.label, job.error = "cancelled", "Отменено", None
                else:
                    job.status, job.label = "error", "Не удалось скачать"
                    job.error_code, job.error = describe_error(error)
                    job.error_detail = str(error)[:16384]

    def close(self):
        with self._lock:
            self._closed = True
            for job in self._jobs.values():
                self.cancel(job.id)
        self._executor.shutdown(wait=True, cancel_futures=True)
