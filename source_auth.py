"""Явно выбранный сеанс только для YouTube. Cookie-файлы не экспортируются."""
from platform_support import resolve_tool
import urllib.parse

COOKIE_BROWSERS = {"none", "vivaldi", "chrome", "chromium", "firefox", "edge", "brave", "safari", "opera"}


def cookie_browser_from(value):
    if not isinstance(value, str) or value not in COOKIE_BROWSERS:
        raise ValueError("Выберите браузер для сеанса YouTube или «Не использовать»")
    return value


def is_youtube(url):
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host in {"youtube.com", "youtu.be", "youtube-nocookie.com"} or host.endswith(".youtube.com") or host.endswith(".youtube-nocookie.com")


def ytdlp_auth_args(url, cookie_browser="none"):
    cookie_browser_from(cookie_browser)
    if not is_youtube(url):
        return []
    args = []
    deno = resolve_tool("deno")
    node = None if deno else resolve_tool("node")
    if deno or node:
        args += ["--no-js-runtimes", "--js-runtimes", f"deno:{deno}" if deno else f"node:{node}"]
    if cookie_browser != "none":
        # --no-cookies отменяет экспорт из внешнего config. Jar живёт в yt-dlp,
        # домены cookies обрабатывает его штатный cookie jar.
        args += ["--cookies-from-browser", cookie_browser, "--no-cookies", "--no-cache-dir"]
    return args
