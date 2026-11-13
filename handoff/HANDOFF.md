# Viddow: установщик со встроенными инструментами

Обновлено 14 ноября 2026. Новый запрос: пользователь не должен отдельно
устанавливать Python, yt-dlp и ffmpeg. Следующей сессии начать с
[bundled-installer.md](bundled-installer.md).
Дополнение пользователя: нужен также **Windows-установщик для личной проверки**.
Для этой задачи начать с [windows-installer.md](windows-installer.md).
Целевой путь: расширение → установка помощника Viddow → скачивание.
Первый вариант — полный пакет, без скачивания зависимостей при первом запуске.
Упаковщик и формат установщика ещё не выбраны; это план, реализации нет.

## Git и сохранность

- Ветка feat/download-workspace, интеграционная main, HEAD до Windows-дополнения 1d97e07.
- ecb1292 сохраняет Windows-порт; f7d11e3 — оптимизации и direct HTTP recovery.
- Tracked-дерево чистое. .agents/, skills-lock.json, handoff/experiments/ untracked,
  принадлежат пользователю: не включать автоматически, не удалять.
- Тег v3.4.0 и main не менять. Удалённые refs/релиз сейчас не перепроверялись.
  Коммит handoff отдельно; push/merge/release/install не выполняются этой задачей.

## Приоритет и границы

- Сохранить существующий native-host, очередь, UI и движки под капотом.
  Не переносить ffmpeg в браузер и не вводить облачный сервис/daemon.
- Уже есть platform_support.py с поиском bin/ и единым resolver: использовать
  его, но проверить пути в упакованном runtime, а не полагаться на __file__ вслепую.
- Windows 11 x64 у пользователя доступна; теперь он хочет проверить именно установщик. Job Object ещё
  прототип, production-отмена дерева, Known Folder/Explorer/ACL требуют завершения.
  Не упаковывать это как готовый Windows-продукт без платформенной приёмки.
- Windows-тестовый установщик теперь самостоятельный приоритет: не ждать выпуска
  macOS-пакета. Закрыть его runtime-блокеры и собрать на Windows; локальная macOS
  не подтверждает работоспособность Windows executable.
- Расширение устанавливается отдельно; стабильный extension ID и allowed_origins
  должны быть определены. Не обещать автоматическую установку расширения в браузер.

## Следующие действия

1. Описать состав/раскладку пакета и выбрать runtime по короткому прототипу.
2. Сделать воспроизводимую сборку host + yt-dlp + ffmpeg/ffprobe и необходимых
   компонентов, с закреплёнными версиями, происхождением, хешами и лицензиями.
3. Проверить native stdio и реальное video+audio без Python/Homebrew/PATH пользователя.
4. Добавить install/repair/uninstall и понятный путь подключения из расширения;
   затем проверить чистую машину, обновление, откат и сохранность загрузок.
5. Только после приёмки готовить подписанные платформенные артефакты и публикацию
   по отдельной просьбе. Независимые обновления yt-dlp — последующая стадия.

## Реализовано

- download_runtime.py: monotonic queue/first bytes/transfer/finishing/total,
  непрозрачные attempt/run IDs. Unknown не заменяется выдуманным retry/TCP count.
- JobManager: VIDDOW_FRAGMENT_BUDGET 1..64, default 32; статическая доля до 16
  на активную задачу, активных не более min(workers,budget). Без рестартов yt-dlp.
- WorkScheduler: скачивания не ждут GIF, одна optional background-операция,
  конечная отсрочка 2 с, FIFO и cancel. Native Inspector разделяет scheduler
  с manager. Контекст после access/expiry/source error требует свежего анализа.
- Direct HTTP: до 3 GET, ограниченное recovery wait, Retry-After, отмена ожидания.
  Strong ETag + length + SHA-256 + HEAD + корректный Range/If-Range.
- partial_store.py: приватные POSIX parts на диске результата, flock, изоляция
  совпавших запросов, checkpoint, TTL 7 дней, квота 5 ГиБ / 128 inactive записей.
  Cancel очищает части, после запуска нет автозагрузок. Pause не добавлен.
- Удаление inactive: CLI --clear-incomplete, native clear_incomplete,
  локальный POST /partials/clear. Пустой root с .directory.lock может остаться.
- Streams: существующие yt-dlp retries/backoff/abort-on-unavailable-fragments,
  60 с без наблюдаемого прогресса до postprocess, без внешнего умножения retries.
  VIDDOW_TEMP_LOCATION=system|destination, default system.
- Resolver, DEVNULL, UTF-8, no-replace finalization и Windows framing сохранены.
  Windows Job Object остаётся прототипом.

## Проверено

- Адресный завершающий набор: 118 тестов, 113 passed и 5 Windows skips по ОС.
  Полная команда в отчёте; полный suite и browser smoke не выполнялись.
- 162 корректных локальных benchmark-сценария, ffprobe проверяет video+audio
  и длительность. 100 initial + 28 final policy + 34 contention/disk/resources.
- Реальное уменьшение повторной передачи direct подтверждено между разными
  Python-процессами: 196608 сохранённых + 851968 новых = 1048576 байт.
- git diff --check и py_compile прошли. Число ранних 54 тестов не суммировать.
- Меньший fragment default не выбран: ошибки/latency медленнее при 2/4/8.
  Статистическая performance acceptance по 2 повторам и реальным CDN не закрыта.
  Ресурсный монитор есть только в локальном harness.

## Ограничения прежних работ

Direct resume подтверждён на POSIX; HLS/DASH persistence и Windows persistence
не реализованы. Реальные CDN/долгие файлы/внешний диск не прошли полную приёмку.
Результаты выше исторические, в текущей сессии проверялись документы и Git;
тесты приложения/сборка не запускались.

Проверки делать завершающим этапом, не после каждой правки. Личные cookies
ради тестов не читать; текущие загрузки и пользовательские профили не затрагивать.
[Отчёт оптимизации](../docs/session-report-2026-11-13-download-optimization.md),
[контракт](../docs/download-optimization-contract.md),
[Windows](windows-development.md), [аудит Windows](windows-audit.md),
[предыдущий вход](archive/handoff-before-bundled-installer-2026-11-14.md).
