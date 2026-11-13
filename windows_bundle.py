"""Installed bundle integrity and transactional, owned HKCU registration."""
import hashlib
import json
import os
from pathlib import Path
import sys
from windows_native_install import HOST_NAME, REGISTRY_PATHS, validate_extension_ids


def verify(root):
    manifest = json.loads((root / 'components.json').read_text(encoding='utf-8'))
    for item in manifest['files']:
        path = root / item['path']
        actual = None
        if path.is_file():
            with path.open('rb') as file:
                actual = hashlib.file_digest(file, 'sha256').hexdigest()
        if actual != item['sha256']:
            raise ValueError(f"Повреждён компонент {item['path']}. Повторите установку Viddow.")
    return manifest


def register(root, pairs):
    import winreg as reg
    entries = {}
    for pair in pairs:
        browser, extension_id = pair.split('=', 1)
        if browser not in REGISTRY_PATHS:
            raise ValueError('Неизвестный браузер')
        entries[browser] = validate_extension_ids([extension_id])[0]
    folder = root.parent / 'native'
    folder.mkdir(exist_ok=True)
    snapshots = []
    # Check both views, including entries that shadow our own 32-bit registration.
    for browser in entries:
        target = folder / f'{browser}.json'
        registered = False
        for view in (reg.KEY_WOW64_32KEY, reg.KEY_WOW64_64KEY):
            try:
                with reg.OpenKey(reg.HKEY_CURRENT_USER, REGISTRY_PATHS[browser], 0, reg.KEY_READ | view) as key:
                    value = reg.QueryValueEx(key, '')[0]
                if os.path.normcase(os.path.abspath(value)) != os.path.normcase(str(target)):
                    raise ValueError(f'{browser}: уже зарегистрирован другой помощник: {value}')
                if view == reg.KEY_WOW64_32KEY:
                    registered = True
            except FileNotFoundError:
                pass
        snapshots.append((browser, target, target.read_bytes() if target.exists() else None, registered))
    written = []
    try:
        for browser, target, previous, registered in snapshots:
            content = {'name': HOST_NAME, 'description': 'Viddow Windows test helper',
                       'type': 'stdio', 'path': str(root / 'ViddowHost.exe'),
                       'allowed_origins': [f'chrome-extension://{entries[browser]}/']}
            pending = target.with_suffix('.new')
            pending.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(pending, target)
            written.append((browser, target, previous, registered))
            with reg.CreateKeyEx(reg.HKEY_CURRENT_USER, REGISTRY_PATHS[browser], 0,
                                 reg.KEY_SET_VALUE | reg.KEY_WOW64_32KEY) as key:
                reg.SetValueEx(key, '', 0, reg.REG_SZ, str(target))
    except BaseException:
        for browser, target, previous, registered in reversed(written):
            if previous is not None:
                target.write_bytes(previous)
            else:
                target.unlink(missing_ok=True)
            if not registered:
                _unregister_value(reg, browser, target)
        raise


def _unregister_value(reg, browser, target):
    try:
        with reg.OpenKey(reg.HKEY_CURRENT_USER, REGISTRY_PATHS[browser], 0,
                         reg.KEY_QUERY_VALUE | reg.KEY_SET_VALUE | reg.KEY_WOW64_32KEY) as key:
            if os.path.normcase(os.path.abspath(reg.QueryValueEx(key, '')[0])) == os.path.normcase(str(target)):
                reg.DeleteValue(key, '')
    except FileNotFoundError:
        pass


def unregister(root):
    import winreg as reg
    for browser in REGISTRY_PATHS:
        target = root.parent / 'native' / f'{browser}.json'
        if not target.exists():
            continue
        content = json.loads(target.read_text(encoding='utf-8'))
        if Path(content.get('path', '')).parent != root:
            continue  # A newer/other version owns the registration.
        _unregister_value(reg, browser, target)
        target.unlink()


def manage(root, args):
    try:
        if args[0] == '--unregister':
            unregister(root)
        else:
            verify(root)
            if args[0] == '--register':
                register(root, args[1:])
        return 0
    except Exception as error:
        # Used by the installer only; never mixed with native protocol stdout.
        log = Path(os.environ['LOCALAPPDATA']) / 'Viddow' / 'logs'
        log.mkdir(parents=True, exist_ok=True)
        (log / 'installer-error.txt').write_text(str(error), encoding='utf-8')
        print(str(error), file=sys.stderr)
        return 1
