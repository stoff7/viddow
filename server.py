#!/usr/bin/env python3
"""Локальный интерфейс Viddow. HTTP-контракт: docs/first-improvements.md."""
import argparse
import json
import re
from platform_support import tool_status
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import download
from jobs import Conflict, JobManager
from contracts import valid_url, download_options

ROOT = Path(__file__).resolve().parent
STATIC = {
    "/": ("video-links.html", "text/html; charset=utf-8"),
    "/web/app.css": ("web/app.css", "text/css; charset=utf-8"),
    "/web/app.js": ("web/app.js", "text/javascript; charset=utf-8"),
    "/web/extractor.js": ("web/extractor.js", "text/javascript; charset=utf-8"),
}
MAX_SIZE = 20 * 1024 * 1024
MAX_BODY = 256 * 1024
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}


class Server(ThreadingHTTPServer):
    def __init__(self, address, manager):
        self.jobs = manager
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    def local_only(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host in ALLOWED_HOSTS:
            return True
        self.reply(403, "Forbidden")
        return False

    def do_GET(self):
        if not self.local_only():
            return
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path in STATIC:
            file, content_type = STATIC[parsed.path]
            return self.reply(200, (ROOT / file).read_bytes(), content_type)
        if parsed.path == "/fetch":
            return self.fetch(urllib.parse.parse_qs(parsed.query).get("url", [""])[0])
        if parsed.path == "/health":
            return self.json_reply(200, {"tools": tool_status(),
                                         "output_dir": self.server.jobs.folder,
                                         "workers": self.server.jobs.workers})
        if parsed.path == "/jobs":
            return self.json_reply(200, self.server.jobs.snapshots())
        self.reply(404, "Not found")

    def do_POST(self):
        if not self.local_only():
            return
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            return self.reply(403, "Forbidden")
        if self.headers.get_content_type() != "application/json":
            return self.reply(415, "Нужен JSON")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.reply(413, "Запрос слишком большой")
            if length <= 0:
                raise ValueError("Нужен JSON-объект")
            self.connection.settimeout(10)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Нужен JSON-объект")
            path = urllib.parse.urlsplit(self.path).path
            if path == "/download":
                urls, options = download_options(body)
                return self.json_reply(200, {"ids": self.server.jobs.add(urls, **options)})
            if path == "/jobs/clear":
                self.server.jobs.clear()
                return self.json_reply(200, {"ok": True})
            if path == '/partials/clear':
                from partial_store import PartsStore
                return self.json_reply(200, {'removed': PartsStore(self.server.jobs.folder).cleanup(all_inactive=True)})
            match = re.fullmatch(r"/jobs/(\d+)/(cancel|retry)", path)
            if match:
                job_id, action = int(match[1]), match[2]
                if action == "cancel":
                    return self.json_reply(200, self.server.jobs.cancel(job_id))
                return self.json_reply(200, {"id": self.server.jobs.retry(job_id)})
            self.reply(404, "Not found")
        except KeyError:
            self.reply(404, "Задача не найдена")
        except Conflict as error:
            self.reply(409, str(error))
        except (ValueError, TypeError) as error:
            self.reply(400, str(error) or "Неверный запрос")
        except TimeoutError:
            self.reply(408, "Истекло время получения запроса")

    def fetch(self, url):
        if not valid_url(url):
            return self.reply(400, "Нужен адрес http:// или https://")
        request = urllib.request.Request(url, headers={
            "User-Agent": download.USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "ru,en;q=0.8",
        })
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read(MAX_SIZE + 1)
                charset = response.headers.get_content_charset() or "utf-8"
                final_url = response.url
        except urllib.error.HTTPError as error:
            error.close()
            return self.reply(502, f"Сайт ответил {error.code} {error.reason}")
        except Exception as error:
            return self.reply(502, f"Не удалось загрузить: {error}")
        if len(body) > MAX_SIZE:
            return self.reply(413, "Страница больше 20 МБ")
        try:
            text = body.decode(charset, errors="replace")
        except LookupError:
            text = body.decode("utf-8", errors="replace")
        safe_url = urllib.parse.quote(final_url, safe=":/?#[]@!$&'()*+,;=%~")
        self.reply(200, text, "text/plain; charset=utf-8", {"X-Final-Url": safe_url})

    def json_reply(self, code, value):
        return self.reply(code, json.dumps(value, ensure_ascii=False), "application/json; charset=utf-8")

    def reply(self, code, body, content_type="text/plain; charset=utf-8", headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    parser = argparse.ArgumentParser(description="Viddow — локальный загрузчик видео")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=2,
                        help="одновременные загрузки, от 1 до 8 (по умолчанию 2)")
    parser.add_argument("-o", "--output", default=download.DEFAULT_DIR, help="папка сохранения")
    args = parser.parse_args()
    manager = JobManager(args.workers, folder=str(Path(args.output).expanduser().resolve()))
    try:
        with Server(("127.0.0.1", args.port), manager) as server:
            url = f"http://127.0.0.1:{server.server_port}/"
            print(f"Viddow: {url}  (остановить — Ctrl+C)")
            if not args.no_browser:
                webbrowser.open(url)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                print("\nОстанавливаем загрузки…")
    finally:
        manager.close()


if __name__ == "__main__":
    main()
