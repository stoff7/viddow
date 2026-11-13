"""Technical per-user Windows registration; never imported by the downloader.

No PATH edits, downloads, public installer or automatic registry takeover.
"""
import json
import os
from pathlib import Path
import re
import sys

HOST_NAME = "local.video_downloader"
REGISTRY_PATHS = {
    "chrome": rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}",
    "edge": rf"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}",
}


def validate_extension_ids(values):
    if not values or any(not re.fullmatch(r"[a-p]{32}", value) for value in values):
        raise ValueError("Нужен фактический --extension-id из chrome://extensions или edge://extensions: 32 буквы a–p")
    return list(dict.fromkeys(values))


def launcher_text(python, script):
    # cmd expands percent even inside quotes. Delayed expansion is disabled.
    for path in (python, script):
        if any(character in str(path) for character in '%"\r\n'):
            raise ValueError('Путь launcher не должен содержать %, кавычки или перевод строки')
    return ('@echo off\r\nsetlocal DisableDelayedExpansion\r\n'
            '@chcp 65001 >nul\r\n'
            f'"{python}" -E -s -X utf8 -u "{script}" %*\r\n'
            'exit /b %errorlevel%\r\n')


def _registered(registry, key_path):
    try:
        with registry.OpenKey(registry.HKEY_CURRENT_USER, key_path, 0,
                              registry.KEY_READ | registry.KEY_WOW64_32KEY) as key:
            return registry.QueryValueEx(key, "")[0]
    except FileNotFoundError:
        return None


def _same_path(first, second):
    return isinstance(first, str) and os.path.normcase(os.path.abspath(first)) == os.path.normcase(os.path.abspath(second))


def install(root, ids, browsers, *, uninstall=False):
    import winreg
    root = Path(root).resolve(strict=True)
    manifest_path = root / "windows-native" / (HOST_NAME + ".json")
    targets = [REGISTRY_PATHS[browser] for browser in dict.fromkeys(browsers)]
    # Preflight every browser before touching files or registry. A different
    # installation must be explicitly unregistered using its own installer.
    for key in targets:
        existing = _registered(winreg, key)
        if existing is not None and not _same_path(existing, manifest_path):
            raise ValueError(f"Другая регистрация {key}: {existing}. Сначала снимите её из прежней установки")
    if uninstall:
        for key in targets:
            if _same_path(_registered(winreg, key), manifest_path):
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0,
                                    winreg.KEY_SET_VALUE | winreg.KEY_WOW64_32KEY) as handle:
                    winreg.DeleteValue(handle, "")
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0,
                                    winreg.KEY_READ | winreg.KEY_WOW64_32KEY) as handle:
                    subkeys, values, _ = winreg.QueryInfoKey(handle)
                if not subkeys and not values:
                    winreg.DeleteKeyEx(winreg.HKEY_CURRENT_USER, key, winreg.KEY_WOW64_32KEY, 0)
                # Preserve any other values/subkeys, including third-party ones.
        print("Регистрация этой установки снята; файлы и история сохранены")
        return
    ids = validate_extension_ids(ids)
    python = Path(sys.executable).resolve(strict=True)
    if python.name.lower() != "python.exe" or sys.version_info < (3, 11):
        raise ValueError("Для прототипа запустите установщик через CPython 3.11+ python.exe (не pythonw/py launcher)")
    script = (root / "native_host.py").resolve(strict=True)
    launcher = manifest_path.parent / "native_host.cmd"
    text = launcher_text(python, script)
    manifest = {"name": HOST_NAME, "description": "Viddow development host",
                "path": str(launcher), "type": "stdio",
                "allowed_origins": [f"chrome-extension://{item}/" for item in ids]}
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_bytes(text.encode("utf-8"))
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    for key in targets:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key, 0,
                                winreg.KEY_SET_VALUE | winreg.KEY_WOW64_32KEY) as handle:
            winreg.SetValueEx(handle, "", 0, winreg.REG_SZ, str(manifest_path))
    print(f"Техническая регистрация HKCU: {', '.join(dict.fromkeys(browsers))}")
    print("Windows-порт ещё не прошёл приёмку. Не запускайте реальные загрузки до проверки дерева процессов.")
