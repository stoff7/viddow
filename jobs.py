"""Очередь загрузок для HTTP и Native Messaging. Заголовки не входят в публичный снимок."""
import itertools
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

import download

ACTIVE = {"queued", "running", "cancelling"}
TERMINAL = {"done", "error", "cancelled"}


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

    def snapshot(self):
        return {"id": self.id, "url": self.url, "name": self.options.get("name"),
                "status": self.status, "fraction": self.fraction, "label": self.label,
                "path": self.path, "error": self.error,
                "format_ids": list(self.options.get("format_ids") or []),
                "format_label": self.options.get("format_label")}


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

    def retry(self, job_id):
        with self._lock:
            job = self._jobs[job_id]
            if job.status not in {"error", "cancelled"}:
                raise Conflict("Повтор доступен только после ошибки или отмены")
            return self.add([job.url], **job.options)[0]

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
                    job.status, job.label, job.error = "error", "Не удалось скачать", str(error)

    def close(self):
        with self._lock:
            self._closed = True
            for job in self._jobs.values():
                self.cancel(job.id)
        self._executor.shutdown(wait=True, cancel_futures=True)
