#!/usr/bin/env python3
"""Скачивает видео и файлы по ссылкам и сохраняет их в «Загрузки».

Использование:
    python3 download.py URL [URL ...] [-o ПАПКА] [-n ИМЯ] [--referer АДРЕС]

Способ выбирается по ответу сервера:
    прямой файл (MP4, ZIP…)      — качается сам, только стандартная библиотека;
    HLS/DASH (.m3u8, .mpd)       — yt-dlp качает кусочки параллельно (без него — ffmpeg, медленнее);
    страница с плеером (YouTube…) — ссылку на видео достаёт yt-dlp.

По умолчанию файлы кладутся в ~/Downloads. Те же функции использует server.py,
чтобы качать со страницы video-links.html: прогресс отдаётся через колбэк progress.
"""
import argparse
import glob
import itertools
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from email.message import Message

CHUNK_SIZE = 64 * 1024
DEFAULT_DIR = os.path.expanduser("~/Downloads")
BAR_WIDTH = 30
# как у обычного браузера — CDN часто отказывают urllib и ffmpeg с их собственным User-Agent
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
STREAM_EXT = (".m3u8", ".mpd")
# application/vnd.apple.mpegurl, application/x-mpegURL, application/dash+xml
STREAM_TYPES = ("mpegurl", "dash")
CONCURRENT_FRAGMENTS = 16
FILE_EXT = (".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v", ".mp3", ".m4a", ".wav",
            ".ogg", ".zip", ".pdf", ".gz", ".tar", ".7z", ".ts")


class Cancelled(Exception):
    """Загрузка отменена владельцем задачи."""


def check_cancel(cancel):
    if cancel is not None and cancel.is_set():
        raise Cancelled("Загрузка отменена")


def draw(fraction, label):
    """Прогресс в терминале: [██████░░░░]  42%  label, перерисовывая одну строку.

    fraction — доля от 0 до 1 или None, если размер заранее неизвестен.
    """
    if fraction is None:
        line = f"  {label}"
    else:
        fraction = max(0.0, min(fraction, 1.0))
        filled = int(fraction * BAR_WIDTH)
        line = f"  [{'█' * filled}{'░' * (BAR_WIDTH - filled)}] {fraction * 100:3.0f}%  {label}"
    print(f"\r{line}\x1b[K", end="", file=sys.stderr, flush=True)


def megabytes(done, total=None):
    return f"{done / 1e6:.1f} / {total / 1e6:.1f} МБ" if total else f"{done / 1e6:.1f} МБ"


def clock(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def number(text):
    """Число из вывода ffmpeg/yt-dlp, где вместо значения бывает N/A или NA."""
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def numbered(stem, text):
    """«15 серия», «15-я серия», «Серия 15» — совпадение для слова с основой stem (номер — group 1 или 2).

    Сначала ищем «число слово» (как пишут русские сайты), иначе «слово число».
    """
    return re.search(rf"(\d+)(?:-?[а-яё]{{1,2}})?\s*{stem}[а-яё]*|{stem}[а-яё]*\s*(\d+)", text, re.I)


def nice_name(title, page_url=None):
    """Имя файла из заголовка страницы: без рекламы сайта, серии — в одном формате.

    «Смотреть 15 серия 2 сезон 2 часть Реинкарнация безработного На Jut Su» (jut.su)
        -> «Реинкарнация безработного — 2 сезон, 15 серия»
    «Как поймать щуку - YouTube» (youtube.com) -> «Как поймать щуку»
    Хвост « на Сайт» / « - Сайт» убирается, только если это и правда сайт из page_url.
    """
    letters = lambda s: re.sub(r"[\W_]", "", s.lower())
    name = re.sub(r"^\s*(смотреть(\s+онлайн)?|watch)\s+", "", title, flags=re.I)
    host = (urllib.parse.urlparse(page_url or "").hostname or "").removeprefix("www.")
    sites = {letters(host), letters(host.rpartition(".")[0])} - {""}  # jut.su -> jutsu, jut
    tail = re.search(r"\s+(?:на|on|[-–—|·])\s+([^-–—|·]+)$", name, re.I)
    if tail and letters(tail.group(1)) in sites:
        name = name[:tail.start()]
    name = re.sub(r"\s+", " ", name).strip() or title
    if not numbered("сери", name):
        return name  # не серия — оставляем заголовок как есть, только без рекламы сайта

    # сезон и часть вынимаем первыми: в «Сезон 2 Серия 5» двойка — номер сезона, а не серии
    found, show = {}, name
    for stem in ("сезон", "част", "сери"):
        found[stem] = numbered(stem, show)
        if found[stem]:
            show = show.replace(found[stem].group(0), " ", 1)
    show = re.sub(r"\s+", " ", show).strip(" -–—|·,.")
    number = lambda m: m.group(1) or m.group(2)
    label = (f"{number(found['сезон'])} сезон, " if found["сезон"] else "") + f"{number(found['сери'])} серия"
    return f"{show} — {label}" if show else label


def clean_name(name):
    """Убрать символы, недопустимые в именах файлов, и попытки выйти из папки."""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(". ")
    return name or "download"


def filename_from(response):
    """Имя файла из Content-Disposition, иначе из последнего сегмента URL (после редиректов)."""
    msg = Message()
    msg["content-disposition"] = response.headers.get("Content-Disposition", "")
    name = msg.get_filename()
    if not name:
        path = urllib.parse.urlparse(response.url).path
        name = urllib.parse.unquote(os.path.basename(path))
    return clean_name(name)


def reserve(folder, name, any_ext=False):
    """Свободное имя: file.zip, иначе file (1).zip… Возвращает путь и создаёт пустой «путь.part».

    .part создаётся атомарно (O_EXCL) — параллельные загрузки с одним именем не возьмут один файл:
    занятым считается и готовый файл, и тот, что ещё качается.
    any_ext=True — расширение потом выберет yt-dlp: путь без расширения, занято любое «имя.*».
    """
    os.makedirs(folder, exist_ok=True)
    stem, ext = (name, "") if any_ext else os.path.splitext(name)
    for i in itertools.count():
        path = os.path.join(folder, (f"{stem} ({i})" if i else stem) + ext)
        if glob.glob(glob.escape(path) + ".*") if any_ext else os.path.exists(path):
            continue
        try:
            os.close(os.open(path + ".part", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o666))
            return path
        except FileExistsError:
            continue


def remove_part(part):
    if os.path.exists(part):
        os.remove(part)


def stop_process(process):
    """Останавливаем только собственный процесс и его группу, включая ffmpeg из yt-dlp."""
    def send(sig):
        try:
            if os.name == "posix":
                os.killpg(process.pid, sig)
            elif process.poll() is None:
                process.terminate() if sig == signal.SIGTERM else process.kill()
        except ProcessLookupError:
            pass

    send(signal.SIGTERM)
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    # Родитель мог выйти раньше дочерних процессов; завершаем оставшуюся группу.
    send(signal.SIGKILL if os.name == "posix" else signal.SIGTERM)
    process.wait()


def run_tool(command, on_line, cancel=None, max_line_chars=None):
    """Запускает ffmpeg/yt-dlp: stdout построчно в on_line, при ошибке — последняя строка stderr."""
    check_cancel(cancel)
    with tempfile.TemporaryFile("w+") as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True,
                                   start_new_session=os.name == "posix")
        finished = threading.Event()

        def watch():
            while not finished.wait(0.1):
                if cancel is not None and cancel.is_set():
                    stop_process(process)
                    return

        watcher = threading.Thread(target=watch, daemon=True) if cancel is not None else None
        if watcher:
            watcher.start()
        try:
            for line in iter(lambda: process.stdout.readline(max_line_chars or -1), ""):
                check_cancel(cancel)
                if max_line_chars and len(line) >= max_line_chars:
                    raise ValueError("Метаданные слишком большие")
                on_line(line.strip())
            process.wait()
        finally:
            finished.set()
            if watcher:
                watcher.join()
            if process.poll() is None:
                stop_process(process)
            process.stdout.close()
        check_cancel(cancel)
        if process.returncode:
            errors.seek(0)
            lines = [line for line in errors.read().splitlines() if line.strip()]
            reason = lines[-1] if lines else f"код выхода {process.returncode}"
            raise RuntimeError(f"{os.path.basename(command[0])}: {reason}")


def request_headers(referer, browser_headers):
    """Наш User-Agent и Referer, поверх — настоящие заголовки браузера, если их прислало расширение.

    Подписанные ссылки CDN бывают привязаны к User-Agent браузера: с чужим отвечают 410.
    """
    headers = {"User-Agent": USER_AGENT}
    if referer:
        headers["Referer"] = referer
    headers.update(browser_headers or {})
    return headers


def download(url, folder=DEFAULT_DIR, name=None, referer=None, progress=draw, browser_headers=None,
             page_url=None, cancel=None, source_kind="auto", format_ids=None, stream_kind=None):
    """Смотрит, что отдал сервер, и выбирает способ — как расширения по заголовкам ответа.

    name — заголовок страницы или своё имя; приводится к nice_name() по адресу страницы
    (page_url, иначе referer).
    """
    check_cancel(cancel)
    if source_kind not in ("auto", "page", "direct"):
        raise ValueError("Неизвестный тип ссылки")
    if name:
        name = nice_name(name, page_url or referer)
    if format_ids:
        from contracts import format_ids_from
        format_ids = format_ids_from(format_ids)
        if not shutil.which("yt-dlp"):
            raise RuntimeError("Для выбора качества нужен yt-dlp: brew install yt-dlp")
        if len(format_ids) > 1 and not shutil.which("ffmpeg"):
            raise RuntimeError("Для объединения видео и звука нужен ffmpeg: brew install ffmpeg")
        headers = request_headers(referer, browser_headers) if source_kind != "page" else {
            **({"Referer": referer} if referer else {}), **(browser_headers or {})}
        return run_ytdlp(url, folder, name, headers, progress,
                         stream=source_kind != "page" and (bool(stream_kind) or urllib.parse.urlparse(url).path.lower().endswith(STREAM_EXT)),
                         cancel=cancel, format_ids=format_ids)
    if source_kind == "page":
        return download_page(url, folder, name, referer, progress, browser_headers, cancel)
    headers = request_headers(referer, browser_headers)
    url_path = urllib.parse.urlparse(url).path.lower()
    if source_kind == "auto" and (stream_kind or url_path.endswith(STREAM_EXT)):
        return download_stream(url, folder, name, headers, progress, cancel)

    request = urllib.request.Request(url, headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        error.close()
        check_cancel(cancel)
        if (source_kind == "auto" and error.code in (401, 403, 405, 429)
                and not url_path.endswith(FILE_EXT) and shutil.which("yt-dlp")):
            return download_page(url, folder, name, referer, progress, browser_headers, cancel)
        raise
    with response:
        check_cancel(cancel)
        content_type = response.headers.get_content_type()
        if source_kind == "direct":
            return save(response, folder, name, progress, cancel)
        if any(t in content_type for t in STREAM_TYPES):
            final_url = response.url
        elif content_type in ("text/html", "application/xhtml+xml"):
            final_url = None
        else:
            return save(response, folder, name, progress, cancel)
    if final_url:
        return download_stream(final_url, folder, name, headers, progress, cancel)
    return download_page(url, folder, name, referer, progress, browser_headers, cancel)


def save(response, folder, name, progress, cancel=None):
    """Прямой файл: пишем кусками в .part, по готовности переименовываем."""
    filename = filename_from(response)
    if name:
        filename = clean_name(name) + os.path.splitext(filename)[1]
    total = int(response.headers.get("Content-Length") or 0)
    path = reserve(folder, filename)
    part = path + ".part"
    done = 0
    try:
        with open(part, "wb") as f:
            while chunk := response.read(CHUNK_SIZE):
                check_cancel(cancel)
                f.write(chunk)
                done += len(chunk)
                progress(done / total if total else None, megabytes(done, total))
        check_cancel(cancel)
        if total and done != total:
            raise RuntimeError("Соединение прервалось: файл получен не полностью")
        os.replace(part, path)
    except BaseException:
        remove_part(part)
        raise
    return path


def stream_duration(url, headers, cancel=None):
    """Длительность потока в секундах — чтобы считать проценты. У трансляций её нет."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    lines = []
    try:
        run_tool([ffprobe, "-v", "error", "-rw_timeout", "30000000", "-headers", headers,
                  "-show_entries", "format=duration", "-of", "csv=p=0", url], lines.append, cancel)
    except RuntimeError:
        return None
    return number(lines[-1]) if lines else None


def download_stream(url, folder, name, headers, progress, cancel=None):
    """HLS/DASH: yt-dlp качает кусочки параллельно (быстро), без него — ffmpeg по одному (медленно)."""
    # имя из адреса бывает длинным токеном — обрезаем
    name = name or os.path.splitext(urllib.parse.unquote(os.path.basename(urllib.parse.urlparse(url).path)))[0][:80]
    if shutil.which("yt-dlp"):
        return run_ytdlp(url, folder, name, headers, progress, stream=True, cancel=cancel)
    return download_stream_ffmpeg(url, folder, name, headers, progress, cancel)


def download_stream_ffmpeg(url, folder, name, headers, progress, cancel=None):
    """ffmpeg сам берёт лучшее качество и склеивает кусочки в MP4, но качает их по одному
    и берёт только одну звуковую дорожку."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("для HLS/DASH нужен yt-dlp или ffmpeg: brew install yt-dlp ffmpeg")
    path = reserve(folder, clean_name(name) + ".mp4")
    part = path + ".part"
    # ffmpeg шлёт эти заголовки и на плейлист, и на каждый кусочек
    headers = "".join(f"{key}: {value}\r\n" for key, value in headers.items())
    duration = None
    info = {}

    def on_line(line):
        # -progress pipe:1: блоки строк key=value, каждый заканчивается строкой progress=…
        key, _, value = line.partition("=")
        info[key] = value
        if key != "progress":
            return
        seconds = (number(info.get("out_time_us")) or 0) / 1e6
        size = megabytes(number(info.get("total_size")) or 0)
        if duration:
            # последний отчёт чуть короче полной длительности — по progress=end рисуем 100%
            fraction = 1 if value == "end" else seconds / duration
            progress(fraction, f"{clock(seconds)} / {clock(duration)}  {size}")
        else:
            progress(None, f"{clock(seconds)}  {size}")

    try:
        progress(None, "подготовка…")
        duration = stream_duration(url, headers, cancel)
        run_tool([ffmpeg, "-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-nostats",
                  "-progress", "pipe:1", "-rw_timeout", "30000000", "-headers", headers, "-i", url,
                  "-c", "copy", "-f", "mp4", part], on_line, cancel)
        check_cancel(cancel)
        os.replace(part, path)
    except BaseException:
        remove_part(part)
        raise
    return path


def download_page(url, folder, name, referer, progress, browser_headers=None, cancel=None):
    """Страница с плеером: видео не лежит по ссылке, его находит yt-dlp."""
    if not shutil.which("yt-dlp"):
        raise RuntimeError("это страница, а не файл — для неё нужен yt-dlp: brew install yt-dlp")
    # Не навязываем наш User-Agent, но сохраняем явно переданный браузерный контекст.
    headers = {"Referer": referer} if referer else {}
    headers.update(browser_headers or {})
    return run_ytdlp(url, folder, name, headers, progress, cancel=cancel)


def run_ytdlp(url, folder, name, headers, progress, stream=False, cancel=None, format_ids=None):
    """yt-dlp с параллельной загрузкой кусочков потока и заданными заголовками.

    stream=True — ссылка на поток, пойманная в браузере:
      * лучшее видео и ВСЕ звуковые дорожки (в DASH/HLS это обычно разные озвучки: без этого
        yt-dlp берёт одну «лучшую», и нужный язык теряется);
      * --impersonate chrome: TLS-соединение как у Chrome. Часть CDN (VK) отличает программы
        от браузера по «отпечатку» TLS и отвечает 403 даже с настоящими заголовками.
    Для страниц (YouTube и т.п.) не включаем: там десятки аудиоформатов одного языка,
    а клиента под сайт yt-dlp подбирает сам.
    """
    path = reserve(folder, clean_name(name), any_ext=True) if name else None
    # % в шаблоне yt-dlp — подстановка, поэтому в своём имени его удваиваем
    template = (os.path.basename(path).replace("%", "%%") if path else "%(title)s") + ".%(ext)s"

    def on_line(line):
        done, total, fragment, fragments = map(number, (line.split() + [None] * 4)[:4])
        if done is None:
            return
        if total:
            progress(done / total, megabytes(done, total))
        elif fragments:
            # HLS/DASH: общий размер yt-dlp только прикидывает и оценка скачет — считаем по кускам
            progress(fragment / fragments, f"{megabytes(done)}  кусок {fragment:.0f} из {fragments:.0f}")
        else:
            progress(None, megabytes(done))

    with tempfile.TemporaryDirectory() as tmp:
        # stdout занят строками прогресса — итоговый путь yt-dlp пишет в файл
        saved_to = os.path.join(tmp, "path")
        command = [shutil.which("yt-dlp"), "--no-playlist", "--no-overwrites", "--quiet", "--progress", "--newline",
                   "--socket-timeout", "30",
                   "--progress-template",
                   "download:%(progress.downloaded_bytes)s %(progress.total_bytes)s "
                   "%(progress.fragment_index)s %(progress.fragment_count)s",
                   # кусочки HLS/DASH качаются параллельно — в этом весь выигрыш в скорости
                   "--concurrent-fragments", str(CONCURRENT_FRAGMENTS),
                   "--merge-output-format", "mp4/mkv",
                   # сотни кусочков и промежуточные дорожки — во временную папку, а не в «Загрузки»;
                   # она удаляется вместе с tmp, даже если загрузка упала
                   "-P", folder, "-P", f"temp:{tmp}",
                   "-o", template, "--print-to-file", "after_move:filepath", saved_to]
        if format_ids:
            command += ["--ignore-config", "-f", "+".join(f"all[format_id='{identifier}']" for identifier in format_ids),
                        "--audio-multistreams"]
            if shutil.which("ffmpeg"):
                # Нужны языковые метки, но не сырой infojson с URL/заголовками.
                command += ["--embed-metadata", "--no-embed-info-json", "--no-embed-chapters"]
        elif stream:
            # «/b» — запасной вариант, если отдельных аудиоформатов нет (звук внутри видео)
            command += ["-f", "bv*+mergeall[vcodec=none]/b", "--audio-multistreams"]
        if stream:
            command += ["--impersonate", "chrome"]
        for key, value in headers.items():
            command += ["--add-headers", f"{key}:{value}"]
        try:
            check_cancel(cancel)
            progress(None, "подготовка…")
            # видео и звук часто качаются отдельно — тогда полоса пройдёт дважды
            try:
                run_tool(command + ["--", url], on_line, cancel)
            except Cancelled:
                # after_move уже мог зафиксировать готовый файл перед отменой.
                if os.path.isfile(saved_to):
                    with open(saved_to, encoding="utf-8") as saved:
                        completed = saved.read().strip()
                    if os.path.isfile(completed):
                        return completed
                raise
            except RuntimeError as e:
                if "Unsupported URL" in str(e):
                    raise RuntimeError("yt-dlp не знает этот сайт: запустите видео в плеере "
                                       "и скачайте пойманный поток (.m3u8/.mpd)") from None
                raise
            with open(saved_to, encoding="utf-8") as f:
                return f.read().strip()
        finally:
            if path:
                remove_part(path + ".part")  # пустая метка из reserve()


def main():
    parser = argparse.ArgumentParser(description="Скачать видео и файлы по ссылкам.")
    parser.add_argument("urls", nargs="+", metavar="URL",
                        help="ссылка на файл, поток .m3u8/.mpd или страницу с видео")
    parser.add_argument("-o", "--output", default=DEFAULT_DIR,
                        help=f"папка для сохранения (по умолчанию {DEFAULT_DIR})")
    parser.add_argument("-n", "--name", help="имя файла без расширения")
    parser.add_argument("--referer",
                        help="страница, на которой нашлось видео — многие CDN без неё отвечают 403")
    parser.add_argument("-A", "--user-agent",
                        help="User-Agent браузера, где играло видео — подписанные ссылки к нему привязаны (иначе 410)")
    parser.add_argument("--source-kind", choices=("auto", "page", "direct"), default="auto",
                        help="тип ссылки: auto, страница page или прямой файл direct")
    args = parser.parse_args()
    browser_headers = {"User-Agent": args.user_agent} if args.user_agent else None

    failed = 0
    for url in args.urls:
        print(f"↓ {url}", file=sys.stderr)
        try:
            if urllib.parse.urlparse(url).scheme not in ("http", "https"):
                raise ValueError("нужен адрес http:// или https://")
            path = download(url, args.output, args.name, args.referer, browser_headers=browser_headers,
                            source_kind=args.source_kind)
            print(file=sys.stderr)  # закончить строку с полосой
            print(f"✓ {path}")
        except KeyboardInterrupt:
            print("\nПрервано.", file=sys.stderr)
            return 130
        except Exception as e:
            print(f"\n✗ {url}: {e}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
