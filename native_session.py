"""Одна очередь для всех вкладок расширения через постоянный Native Messaging-канал."""
import os
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

import download
from contracts import download_options
from jobs import JobManager
from inspector import Inspector
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
        self.inspector = Inspector()
        self._publish_lock = threading.Lock()
        self.manager.restore_history(history or [])

    def state(self):
        return {"type": "state", "session": self.id, "jobs": self.manager.snapshots(),
                "history_version": 1,
                "settings": {"workers": self.manager.workers, "output_dir": self.manager.folder, "youtube_browser": self.youtube_browser},
                "tools": {"yt_dlp": bool(shutil.which("yt-dlp")), "ffmpeg": bool(shutil.which("ffmpeg"))},
                "analysis": self.inspector.snapshot()}

    def handle(self, message):
        request_id = message.get("request_id")
        try:
            if message.get("session") != self.id:
                raise ValueError("Сессия загрузок изменилась. Обновите список задач.")
            command = message.get("command")
            result = {}
            if command == "download":
                if message.get("analysis_id") is not None:
                    urls, options = self.inspector.selection(message["analysis_id"], message.get("format_ids"))
                else:
                    urls, options = download_options(message)
                    if self.youtube_browser != "none":
                        options["cookie_browser"] = self.youtube_browser
                result = {"ids": self.manager.add(urls, **options)}
            elif command == "inspect":
                urls, options = download_options(message)
                if len(urls) != 1:
                    raise ValueError("Для анализа выберите один адрес")
                if self.youtube_browser != "none":
                    options["cookie_browser"] = self.youtube_browser
                result = self.inspector.start(urls[0], **options)
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
                    result = {"id": self.manager.retry(job_id, cookie_browser=self.youtube_browser)}
                else:
                    job = next((job for job in self.manager.snapshots() if job["id"] == job_id), None)
                    if not job or job["status"] != "done" or not job["path"] or not os.path.isfile(job["path"]):
                        raise ValueError("Готовый файл не найден")
                    # Путь берётся только из результата загрузки, а не из сообщения браузера.
                    subprocess.run(["open", "-R", job["path"]], check=True, timeout=10)
            elif command == "clear":
                self.manager.clear()
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
            self.send({"type": "reply", "request_id": request_id, "ok": True, "result": result})
        except Exception as error:
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

        self.send({**self.state(), "type": "ready", "protocol": 2})
        reporter = threading.Thread(target=report, daemon=True)
        reporter.start()
        try:
            while True:
                message = read()
                if message is None:
                    break
                if isinstance(message, dict):
                    self.handle(message)
        finally:
            stopped.set()
            reporter.join()
            self.inspector.stop()
            try:
                self.manager.close()
            finally:
                self.inspector.close()
