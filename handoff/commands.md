# Команды и особенности среды

Все команды выполнять из `/Users/staslisicin/Projects/downloader`.

Актуальные результаты: [verification.md](../docs/verification.md).

## Сначала состояние

```sh
git status --short --branch
git diff --cached --name-only
git diff --stat
git worktree list
```

После завершения этапов 1–3 код и тесты сохраняются в рабочей ветке.
Проверяйте также `git status` и untracked-файлы, а не только diff.

## Python и чистота изменений

```sh
python3 -m unittest discover -s tests -v
python3 -m py_compile download.py jobs.py contracts.py native_host.py native_session.py install_native_host.py server.py
node --input-type=module --check < extension/background.js
node --input-type=module --check < extension/popup.js
node --check web/app.js
node --check web/extractor.js
node --test tests/test_streams.mjs
git diff --check
```

Тесты HTTP открывают временные loopback-серверы. В этой сессии sandbox блокировал
bind с `Operation not permitted`; успешный запуск выполнялся через
`exec_command(sandbox_permissions="require_escalated")`. Это ограничение среды,
не повод переписывать сервер или отключать интеграционные тесты.

Для отдельного теста, без превращения tests в пакет:

```sh
PYTHONPATH=tests:. python3 -m unittest test_server.HttpTests.test_input_and_origin_validation -v
PYTHONPATH=tests:. python3 -m unittest test_native_session -v
```

## Браузерные проверки

Playwright установлен отдельно от проекта: `/tmp/viddow-browser-check/node_modules`.
Доступный проверенный Chromium:

```text
/Users/staslisicin/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

```sh
NODE_PATH=/tmp/viddow-browser-check/node_modules \
CHROMIUM_PATH='/Users/staslisicin/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
VIDDOW_ARTIFACTS=/tmp/viddow-extension-check \
node tests/extension_smoke.cjs
```

```sh
NODE_PATH=/tmp/viddow-browser-check/node_modules \
CHROMIUM_PATH='/Users/staslisicin/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
VIDDOW_ARTIFACTS=/tmp/viddow-ui-check \
node tests/browser_smoke.cjs
```

Третий smoke использует настоящий Native Messaging, yt-dlp, ffmpeg и ffprobe:

```sh
NODE_PATH=/tmp/viddow-browser-check/node_modules \
CHROMIUM_PATH='/Users/staslisicin/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
VIDDOW_ARTIFACTS=/tmp/viddow-native-check \
node tests/extension_native_smoke.cjs
```

Расширение проверяется в видимом окне современного Chromium и настоящем
SIDE_PANEL. Все три запуска требовали разрешений для браузера/локальной сети.
Если временные зависимости пропали, проверить наличие перед установкой:

```sh
npm install --prefix /tmp/viddow-browser-check --no-package-lock --no-audit --no-fund playwright
```

Не добавлять Playwright в runtime приложения. Если существующий Chromium
недоступен, установить браузер через Playwright и опустить CHROMIUM_PATH.

## Проверенные ловушки

- В тестовом Chromium навигация на localhost сначала зависала. Проверка
  заработала с `--no-proxy-server`; этот аргумент добавлен во все три smoke-теста.
  Пользовательские настройки прокси не менялись.
- На macOS `/var/...` и `/private/var/...` могут обозначать одну папку.
  `settings_from()` возвращает `Path.resolve()`. Проверять канонический путь,
  а не исходную строку. Native-тест уже исправлен с учётом этого.
- Имя `Sample <script>` корректно сохраняется как `Sample _script_.mp4`:
  тест должен учитывать очистку символов файловой системы, а не ждать `<`/`>`.
- Не копировать browser test результат на полный native-путь: в extension_smoke
  порт подменён. `test_native_session.py` проверяет протокол отдельно, а
  `extension_native_smoke.cjs` — полный реальный путь панели.
- Снимок полной страницы после прокрутки может сместить fixed-элементы на снимке.
  Для обзорного снимка сначала прокрутить к top=0 без анимации.

## Ручной запуск

```sh
python3 server.py --no-browser --port 8766 --workers 2 -o /tmp/viddow-manual-downloads
```

Для расширения HTTP-сервер не нужен. После проверки обновить распакованное
расширение на странице управления расширениями выбранного браузера. Его путь
не менялся, имя native-хоста осталось `local.video_downloader`. Наличие регистрации
хоста в конкретном пользовательском браузере не проверено; установка при необходимости:

```sh
python3 install_native_host.py
```

Установщик пишет настройки в профили найденных Chromium-браузеров пользователя.
Для автоматических тестов используется отдельный профиль. Установщик поддерживает
`--user-data-dir /tmp/viddow-test-profile`: регистрация записывается только туда.
Native-smoke выполняет такую установку сам и удаляет профиль после проверки.
Не устанавливать хост во все пользовательские профили «на всякий случай».
