#!/usr/bin/env python3
"""Регистрирует native_host в браузерах на Chromium, чтобы extension/ качал без server.py.

Использование:
    python3 install_native_host.py

macOS по умолчанию сохраняет ID из пути. Windows требует фактический
--extension-id из страницы расширений и CPython 3.11+ python.exe.
Windows — технический прототип, инструкции: docs/windows-development.md.
"""
import hashlib
import argparse
import json
import os
import stat
import sys

HOST_NAME = "local.video_downloader"  # то же имя — в extension/background.js
HERE = os.path.dirname(os.path.abspath(__file__))
SUPPORT = os.path.expanduser("~/Library/Application Support")
# папки профилей браузеров; хост регистрируем в тех, что установлены
BROWSERS = {
    "Vivaldi": "Vivaldi",
    "Google Chrome": "Google/Chrome",
    "Chromium": "Chromium",
    "Яндекс Браузер": "Yandex/YandexBrowser",
    "Brave": "BraveSoftware/Brave-Browser",
    "Microsoft Edge": "Microsoft Edge",
}


def extension_id(path):
    """Как Chromium: первые 32 hex-цифры sha256 от пути, цифры 0–f → буквы a–p."""
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-data-dir", help="Зарегистрировать хост только в указанном каталоге данных браузера")
    parser.add_argument("--extension-id", action="append", help="Фактический ID расширения; можно повторить для Chrome/Edge")
    parser.add_argument("--browser", choices=("chrome", "edge"), action="append", help="Windows: целевой браузер (по умолчанию оба)")
    parser.add_argument("--uninstall", action="store_true", help="Windows: снять только регистрацию этой папки")
    args = parser.parse_args()
    if sys.platform == "win32":
        from windows_native_install import install
        if args.user_data_dir:
            parser.error("--user-data-dir не изолирует HKCU Windows; используйте отдельного пользователя/VM")
        try:
            install(HERE, args.extension_id or [], args.browser or ["chrome", "edge"], uninstall=args.uninstall)
        except (ValueError, OSError) as error:
            parser.error(str(error))
        return 0
    if sys.platform != "darwin":
        parser.error("Поддерживается macOS; Windows-путь находится в разработке")
    if args.browser or args.uninstall:
        parser.error("--browser/--uninstall пока предназначены только для Windows")
    from windows_native_install import validate_extension_ids
    ids = validate_extension_ids(args.extension_id) if args.extension_id else [extension_id(os.path.join(HERE, "extension"))]
    ext_id = ids[0]
    wrapper = os.path.join(HERE, "native_host.sh")
    for script in (wrapper, os.path.join(HERE, "native_host.py")):
        os.chmod(script, os.stat(script).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    manifest = {
        "name": HOST_NAME,
        "description": "Video Links Catcher: скачивание через download.py",
        "path": wrapper,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{item}/" for item in ids],
    }

    installed = []
    targets = {"Тестовый профиль": os.path.abspath(os.path.expanduser(args.user_data_dir))} if args.user_data_dir else {
        title: os.path.join(SUPPORT, folder) for title, folder in BROWSERS.items()}
    for title, profile in targets.items():
        if not args.user_data_dir and not os.path.isdir(profile):
            continue
        hosts = os.path.join(profile, "NativeMessagingHosts")
        os.makedirs(hosts, exist_ok=True)
        with open(os.path.join(hosts, HOST_NAME + ".json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        installed.append(title)

    if not installed:
        print("Не нашёл ни одного браузера на Chromium в", SUPPORT)
        return 1
    print(f"Хост {HOST_NAME} зарегистрирован: {', '.join(installed)}")
    print(f"Расширение: {ext_id}  (папка {os.path.join(HERE, 'extension')})")
    print("Обновите расширение кнопкой ⟳ на странице расширений — и можно качать.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
