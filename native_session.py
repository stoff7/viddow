"""Одна очередь для всех вкладок расширения через постоянный Native Messaging-канал."""
import os
from concurrent.futures import ThreadPoolExecutor
from platform_support import tool_status
import subprocess
import threading
import uuid
from pathlib import Path

import download
from contracts import download_options
from jobs import JobManager
from inspector import Inspector
from trace_log import trace_event
from diagnostics import describe_error
from source_auth import cookie_browser_from


def settings_from(value):
    if not isinstance(value, dict):
        raise ValueError("Настройки должны быть объектом")
    workers = value.get("workers", 2)
    folder = value.get("output_dir") or download.DEFAULT_DIR
    if type(workers) is not int or not 1 <= workers <= 8:
        raise ValueError("Число загрузок должно быть от 1 до 8")
    if not isinstance(folder, str) or "\x00" in folder:
        raise ValueError("Неверная папка сохранения")
    folder = Path(folder).expanduser()
    if not folder.is_absolute():
        raise ValueError("Укажите полный путь к папке, например ~/Downloads")
    if folder.exists() and not folder.is_dir():
        raise ValueError("Путь указывает на файл, а не папку")
    return workers, str(folder.resolve())


class Session:
    def __init__(self, settings, send, manager_factory=JobManager, history=None):
        workers, folder = settings_from(settings)
        self.youtube_browser = cookie_browser_from(settings.get("youtube_browser", "none"))
        self.manager = manager_factory(workers=workers, folder=folder)
        self.send = send
        self.id = uuid.uuid4().hex
        self.inspector = Inspector(scheduler=self.manager.scheduler)
        self._previews = ThreadPoolExecutor(max_workers=2, thread_name_prefix="media-preview")
        self._publish_lock = threading.Lock()
        self._selection_lock = threading.Lock()
        self._selection_jobs = {}
        self.manager.restore_history(history or [])

    def state(self):
        jobs = self.manager.snapshots()
        with self._selection_lock:
            for job in jobs:
                source = self._selection_jobs.get(job['id'])
                if source and job['status'] == 'error' and job['error_code'] in {'expired_link', 'access_denied', 'authentication_required', 'source_unavailable'}:
                    self.inspector.reject_source(*source)
        return {"type": "state", "session": self.id, "jobs": jobs,
                "history_version": 1,
                "settings": {"workers": self.manager.workers, "output_dir": self.manager.folder, "youtube_browser": self.youtube_browser},
                "tools": tool_status(),
                "analysis": self.inspector.snapshot()}

    def handle(self, message):
        request_id = message.get("request_id")
        try:
            if message.get("session") != self.id:
                raise ValueError("Сессия загрузок изменилась. Обновите список задач.")
            command = message.get("command")
            result = {}
            trace_event("command_start", command=command, analysis_tag=message.get("analysis_id"), source_tag=message.get("source_id"))
            if command == "download":
                trace_event("download_requested", analysis_tag=message.get("analysis_id"), source_tag=message.get("source_id"))
                if message.get("analysis_id") is not None:
                    self.state()  # Reject a source whose last completed attempt lost access.
                    urls, options = self.inspector.selection(message["analysis_id"], message.get("format_ids"), message.get("source_id"))
                else:
                    urls, options = download_options(message)
                    if self.youtube_browser != "none":
                        options["cookie_browser"] = self.youtube_browser
                result = {"ids": self.manager.add(urls, **options)}
                if message.get('analysis_id'):
                    source_id = message.get('source_id') or self.inspector.snapshot()['result']['source_id']
                    with self._selection_lock:
                        for job_id in result['ids']:
                            self._selection_jobs[job_id] = (message['analysis_id'], source_id)
                trace_event("download_queued", jobs_count=len(result["ids"]), job_id=result["ids"][0] if result["ids"] else 0)
            elif command == "inspect":
                urls, options = download_options(message)
                if len(urls) != 1:
                    raise ValueError("Для анализа выберите один адрес")
                if self.youtube_browser != "none":
                    options["cookie_browser"] = self.youtube_browser
                candidates = message.get('fallbacks', [])
                if not isinstance(candidates, list) or len(candidates) > 6:
                    raise ValueError('Допускается до 6 видео для подготовки')
                fallbacks = []
                for item in candidates:
                    candidate_urls, candidate_options = download_options(item)
                    if len(candidate_urls) != 1 or candidate_options.get('stream_kind') not in ('HLS', 'DASH'):
                        raise ValueError('Для подготовки нужен один HLS/DASH источник')
                    candidate_options['_trace_tag'] = item.get('trace_tag')
                    fallbacks.append({'url': candidate_urls[0], 'options': candidate_options})
                fallback_only = message.get('fallback_only', False)
                if type(fallback_only) is not bool or fallback_only and not fallbacks:
                    raise ValueError('Нет видео для запасной подготовки')
                result = self.inspector.start(urls[0], fallbacks=fallbacks, fallback_only=fallback_only, **options)
            elif command == 'preview':
                identifier, source_id = message.get('analysis_id'), message.get('source_id')
                if not isinstance(identifier, str) or not isinstance(source_id, str):
                    raise ValueError('Нужны ID анализа и видео')
                future = self._previews.submit(self.inspector.preview, identifier, source_id)
                def respond(done):
                    try:
                        self.send({'type': 'reply', 'request_id': request_id, 'ok': True, 'result': done.result()})
                    except Exception as error:
                        trace_event('preview_error', analysis_tag=identifier, source_tag=source_id, code=describe_error(error)[0])
                        self.send({'type': 'reply', 'request_id': request_id, 'ok': False, 'error': 'Превью недоступно для этого видео.'})
                future.add_done_callback(respond)
                return
            elif command == "inspect_cancel":
                identifier = message.get("analysis_id")
                if not isinstance(identifier, str):
                    raise ValueError("Нужен ID анализа")
                self.inspector.stop(identifier)
            elif command == "inspect_history":
                job_id = message.get("id")
                if type(job_id) is not int:
                    raise ValueError("Неверный номер задачи")
                job = next((row for row in self.manager.snapshots() if row["id"] == job_id), None)
                if not job or not job["restored"] or not job["page"] or not job["page_retry"]:
                    raise ValueError("Исходная страница не сохранена. Вставьте свежую ссылку.")
                result = self.inspector.start(job["page"], source_kind="page", name=job["name"], page=job["page"], headers={}, cookie_browser=self.youtube_browser)
            elif command in ("cancel", "retry", "reveal"):
                job_id = message.get("id")
                if type(job_id) is not int:
                    raise ValueError("Неверный номер задачи")
                if command == "cancel":
                    result = self.manager.cancel(job_id)
                elif command == "retry":
                    job = next((row for row in self.manager.snapshots() if row['id'] == job_id), None)
                    if job and job['format_ids'] and job['error_code'] in {'expired_link', 'access_denied', 'authentication_required', 'source_unavailable'}:
                        raise ValueError('Источник отклонил прежние форматы. Получите свежие форматы со страницы.')
                    result = {"id": self.manager.retry(job_id, cookie_browser=self.youtube_browser)}
                else:
                    job = next((job for job in self.manager.snapshots() if job["id"] == job_id), None)
                    if not job or job["status"] != "done" or not job["path"] or not os.path.isfile(job["path"]):
                        raise ValueError("Готовый файл не найден")
                    # Путь берётся только из результата загрузки, а не из сообщения браузера.
                    subprocess.run(["open", "-R", job["path"]], check=True, timeout=10)
            elif command == "clear":
                self.manager.clear()
            elif command == 'clear_incomplete':
                from partial_store import PartsStore
                result = {'removed': PartsStore(self.manager.folder).cleanup(all_inactive=True)}
            elif command == "configure":
                workers, folder = settings_from(message.get("settings"))
                browser = cookie_browser_from(message["settings"].get("youtube_browser", "none"))
                self.manager.configure(workers, folder)
                if browser != self.youtube_browser:
                    self.inspector.invalidate()
                self.youtube_browser = browser
                result = self.state()["settings"]
            else:
                raise ValueError("Неизвестная команда")
            # Снимок перед reply позволяет worker сохранить историю до подтверждения UI.
            with self._publish_lock:
                self.send(self.state())
            trace_event("command_ok", command=command)
            self.send({"type": "reply", "request_id": request_id, "ok": True, "result": result})
        except Exception as error:
            trace_event("command_error", command=message.get("command"), code=describe_error(error)[0])
            self.send({"type": "reply", "request_id": request_id, "ok": False,
                       "error": "Задача не найдена" if isinstance(error, KeyError) else str(error)})

    def run(self, read):
        stopped = threading.Event()

        def report():
            previous = None
            while not stopped.is_set():
                with self._publish_lock:
                    current = self.state()
                    if current != previous:
                        self.send(current)
                        previous = current
                stopped.wait(0.25)

        trace_event("host_ready")
        self.send({**self.state(), "type": "ready", "protocol": 2})
        reporter = threading.Thread(target=report, daemon=True)
        reporter.start()
        try:
            while True:
                message = read()
                if message is None:
                    break
                if isinstance(message, dict):
                    if message.get('type') == 'trace':
                        trace_event(message.get('event'), message.get('fields'), origin='extension')
                    else:
                        self.handle(message)
        finally:
            trace_event("host_disconnect")
            stopped.set()
            reporter.join()
            self.inspector.stop()
            try:
                self.manager.close()
            finally:
                self.inspector.close()
                self._previews.shutdown(wait=True, cancel_futures=True)
