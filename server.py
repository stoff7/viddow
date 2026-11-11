#!/usr/bin/env python3
"""Локальный сервер для video-links.html: отдаёт страницу, загружает HTML по адресу и качает видео.

Браузер сам не может прочитать чужой сайт (CORS), поэтому страница просит
сервер: GET /fetch?url=... -> текст HTML, итоговый адрес в заголовке X-Final-Url.

Скачивание — тоже через сервер, функциями из download.py, в ~/Downloads:
    POST /download {"urls": [...], "name": "...", "referer": "...", "headers": {...}, "page": "..."}
        -> {"ids": [...]}
    (name — заголовок страницы, page — её адрес: по ним download.nice_name() делает имя файла;
    headers — заголовки браузера, если нужны)
    GET  /jobs -> [{"id", "url", "status", "fraction", "label", "path", "error"}, ...]
Каждая ссылка качается сразу, параллельно с остальными; страница опрашивает /jobs и рисует прогресс.

Использование:
    python3 server.py [--port 8765]

Слушает только 127.0.0.1. Только стандартная библиотека.
"""
import argparse
import itertools
import json
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import download

PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "video-links.html")
MAX_SIZE = 20 * 1024 * 1024
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
# как у обычного браузера — иначе часть сайтов отдаёт заглушку вместо страницы
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
MAX_URLS = 50

JOBS = {}  # id -> состояние загрузки; пишет поток этой загрузки, читает /jobs
NEXT_ID = itertools.count(1)


def run_job(job, name, referer, browser_headers, page_url):
    """Каждая загрузка — в своём потоке, сразу, без очереди. Одинаковые имена не столкнутся:
    download.reserve() занимает имя файла атомарно."""
    job["status"] = "running"

    def progress(fraction, label):
        job["fraction"], job["label"] = fraction, label

    try:
        job["path"] = download.download(job["url"], name=name, referer=referer, progress=progress,
                                        browser_headers=browser_headers, page_url=page_url)
        job["status"], job["fraction"] = "done", 1
    except Exception as e:
        job["status"], job["error"] = "error", str(e)


class Handler(BaseHTTPRequestHandler):
    def local_only(self):
        """Защита от DNS rebinding: отвечаем только на обращения к самому localhost."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host in ALLOWED_HOSTS:
            return True
        self.reply(403, "Forbidden")
        return False

    def do_GET(self):
        if not self.local_only():
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            with open(PAGE, "rb") as f:
                return self.reply(200, f.read(), "text/html; charset=utf-8")
        if parsed.path == "/fetch":
            return self.fetch(urllib.parse.parse_qs(parsed.query).get("url", [""])[0])
        if parsed.path == "/jobs":
            jobs = [{"id": job_id, **job} for job_id, job in list(JOBS.items())]
            return self.reply(200, json.dumps(jobs, ensure_ascii=False), "application/json; charset=utf-8")
        self.reply(404, "Not found")

    def do_POST(self):
        if not self.local_only():
            return
        if urllib.parse.urlparse(self.path).path != "/download":
            return self.reply(404, "Not found")
        # Защита от чужих сайтов: форма с другого сайта не может прислать JSON без
        # CORS-preflight (а его мы не разрешаем), и Origin у неё будет чужой.
        # (extension/ качает через native_host.py, а не через этот сервер.)
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            return self.reply(403, "Forbidden")
        if self.headers.get_content_type() != "application/json":
            return self.reply(415, "Нужен JSON")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            urls = body["urls"]
            if not (isinstance(urls, list) and 0 < len(urls) <= MAX_URLS and all(
                    isinstance(u, str) and urllib.parse.urlparse(u).scheme in ("http", "https")
                    for u in urls)):
                raise ValueError
            # заголовки браузера от расширения; переводы строк запрещены — уйдут в -headers ffmpeg
            browser_headers = body.get("headers") or {}
            if not (isinstance(browser_headers, dict) and all(
                    isinstance(k, str) and isinstance(v, str) and not re.search(r"[\r\n]", k + v)
                    for k, v in browser_headers.items())):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self.reply(400, f"Нужен список из 1–{MAX_URLS} адресов http:// или https://"
                                   " и заголовки строками")

        ids = []
        for url in urls:
            job_id = next(NEXT_ID)
            JOBS[job_id] = {"url": url, "status": "queued", "fraction": None,
                            "label": "запуск…", "path": None, "error": None}
            threading.Thread(target=run_job, daemon=True, args=(
                JOBS[job_id], body.get("name") or None, body.get("referer") or None,
                browser_headers, body.get("page") or None)).start()
            ids.append(job_id)
        self.reply(200, json.dumps({"ids": ids}), "application/json")

    def fetch(self, url):
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            return self.reply(400, "Нужен адрес http:// или https://")
        request = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "ru,en;q=0.8",
        })
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read(MAX_SIZE + 1)
                charset = response.headers.get_content_charset() or "utf-8"
                final_url = response.url
        except urllib.error.HTTPError as e:
            return self.reply(502, f"Сайт ответил {e.code} {e.reason}")
        except Exception as e:
            return self.reply(502, f"Не удалось загрузить: {e}")
        if len(body) > MAX_SIZE:
            return self.reply(413, "Страница больше 20 МБ")

        try:
            text = body.decode(charset, errors="replace")
        except LookupError:
            text = body.decode("utf-8", errors="replace")
        # заголовки только ASCII — кириллицу в адресе кодируем, страница раскодирует
        safe_url = urllib.parse.quote(final_url, safe=":/?#[]@!$&'()*+,;=%~")
        self.reply(200, text, "text/plain; charset=utf-8", {"X-Final-Url": safe_url})

    def reply(self, code, body, content_type="text/plain; charset=utf-8", headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Сервер для video-links.html")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Открыто: {url}  (остановить — Ctrl+C)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")


if __name__ == "__main__":
    main()
