"""Понятные коды причин. Сырые детали доступны только в текущей сессии."""
import errno
import re
import urllib.error


def describe_error(error):
    raw = str(error)
    lower = raw.lower()
    code = error.code if isinstance(error, urllib.error.HTTPError) else None
    match = re.search(r"HTTP(?:\s+Error)?[:\s]+([45]\d\d)", raw, re.I)
    code = code or (int(match[1]) if match else None)
    if "not a bot" in lower or "confirm you’re" in lower or "confirm you're" in lower:
        return "authentication_required", "YouTube просит подтвердить сеанс. Откройте ролик в браузере с выполненным входом, затем выберите этот браузер в Настройках → Сеанс YouTube и повторите загрузку."
    if any(word in lower for word in ("failed to decrypt", "cookies database", "keychain")):
        return "browser_session_unavailable", "Не удалось прочитать сеанс выбранного браузера. Проверьте профиль с выполненным входом и системный доступ к хранилищу браузера."
    if "drm" in lower:
        return "drm", "Источник защищён DRM. Этот загрузчик не поддерживает его скачивание."
    if any(word in lower for word in ("sign in", "login required", "log in", "authentication required", "cookies are required")):
        return "authentication_required", "Сайт требует входа. Откройте видео в браузере и используйте поток с актуальным контекстом запроса. Для YouTube выберите сеанс браузера в настройках."
    if "expired" in lower or "истек" in lower or "истёк" in lower:
        return "expired_link", (f"HTTP {code}: " if code else "") + "Ссылка истекла. Снова откройте исходную страницу и получите свежий адрес потока."
    if isinstance(error, PermissionError) or isinstance(error, OSError) and error.errno in (errno.EACCES, errno.EROFS):
        return "destination_permission", "Нет доступа к папке сохранения. Выберите доступную папку и повторите загрузку."
    if isinstance(error, OSError) and error.errno == errno.ENOSPC:
        return "destination_full", "В папке сохранения закончилось свободное место. Освободите место и повторите загрузку."
    if isinstance(error, OSError) and not isinstance(error, urllib.error.URLError) and error.errno in (errno.ENOENT, errno.ENOTDIR):
        return "destination_unavailable", "Папка сохранения недоступна или исчезла. Выберите доступную папку и повторите загрузку."
    if code in (401, 403):
        return "access_denied", f"HTTP {code}: сайт отклонил доступ. Откройте видео в браузере и получите свежий поток с его заголовками."
    if code in (404, 410):
        return "source_unavailable", f"HTTP {code}: источник удалён, недоступен или ссылка больше не действует."
    if code == 429:
        return "rate_limited", "HTTP 429: сайт ограничил число запросов. Подождите перед повтором."
    if "no supported javascript runtime" in lower or "ejs" in lower and "not" in lower:
        return "missing_dependency", "Для извлечения YouTube нужен совместимый JavaScript runtime и компоненты yt-dlp. Установите Deno: brew install deno; проверьте обновление yt-dlp."
    if "brew install" in lower:
        return "missing_dependency", raw
    if "unsupported url" in lower or "не знает этот сайт" in lower:
        return "unsupported_source", "Источник не поддерживается извлекателем. Запустите видео в браузере и выберите найденный HLS/DASH-поток."
    if isinstance(error, TimeoutError) and raw.startswith("Анализ"):
        return "analysis_timeout", raw
    if "curl: (28)" in lower:
        return "network_timeout", "Сервер видео не ответил вовремя. Нажмите «Обновить ссылку», чтобы получить форматы с исходной страницы, или снова запустите видео в браузере. Таймаут не подтверждает, что ссылка истекла."
    if "curl: (35)" in lower or "ssl_connect" in lower or "ssl_error_syscall" in lower:
        return "network_tls", "Не удалось установить защищённое соединение с сервером видео. Откройте видео в браузере и получите свежий поток. Если оно воспроизводится, а загрузка снова падает, возможна разница сетевого маршрута браузера и загрузчика."
    if isinstance(error, (TimeoutError, urllib.error.URLError)) or any(word in lower for word in ("timed out", "unable to download webpage", "connection reset", "could not resolve")):
        return "network", "Не удалось связаться с источником. Проверьте подключение и доступность видео в браузере."
    return "download_error", raw
