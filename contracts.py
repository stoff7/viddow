"""Проверка запросов загрузки для HTTP и Native Messaging."""
import re
import urllib.parse

MAX_URLS = 50


def format_ids_from(value):
    if value is None:
        return []
    if not (isinstance(value, list) and 1 <= len(value) <= 9 and all(
            isinstance(item, str) and re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", item) for item in value)
            and len(set(value)) == len(value)):
        raise ValueError("Выберите от 1 до 9 разных ID форматов без выражений yt-dlp")
    return list(value)


def valid_url(value):
    if not isinstance(value, str) or re.search(r"[\r\n\x00]", value):
        return False
    try:
        parsed = urllib.parse.urlsplit(value)
        return parsed.scheme in ("http", "https") and bool(parsed.hostname)
    except ValueError:
        return False


def download_options(body):
    urls = body.get("urls")
    if not (isinstance(urls, list) and 0 < len(urls) <= MAX_URLS and all(map(valid_url, urls))):
        raise ValueError(f"Нужен список из 1–{MAX_URLS} адресов http:// или https://")
    headers = body.get("headers", {})
    if not (isinstance(headers, dict) and all(
            isinstance(k, str) and isinstance(v, str) and k and not re.search(r"[\r\n\x00]", k + v)
            for k, v in headers.items())):
        raise ValueError("Заголовки должны быть строками без переводов строк")
    options = {"headers": headers, "source_kind": body.get("source_kind", "auto")}
    if body.get("stream_kind") is not None:
        if body["stream_kind"] not in ("HLS", "DASH"):
            raise ValueError("Неизвестный тип потока")
        options["stream_kind"] = body["stream_kind"]
    if body.get("format_ids") is not None:
        options["format_ids"] = format_ids_from(body["format_ids"])
    if options["source_kind"] not in ("auto", "page", "direct"):
        raise ValueError("Неизвестный тип ссылки")
    for key in ("name", "referer", "page"):
        value = body.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"Поле {key} должно быть строкой")
        if value and key != "name" and not valid_url(value):
            raise ValueError(f"Поле {key} должно содержать HTTP(S)-адрес")
        options[key] = value or None
    return urls, options
