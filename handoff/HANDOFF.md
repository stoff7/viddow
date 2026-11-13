# Viddow: оптимизации поверх сохранённого Windows-порта

Обновлено 13 ноября 2026. Начать с
[отчёта сессии](../docs/session-report-2026-11-13-download-optimization.md) и
[контракта](../docs/download-optimization-contract.md).
Исходный план сохранён в [download-optimization.md](download-optimization.md);
[предыдущий вход](archive/handoff-before-optimization-implementation-2026-11-13.md).

## Git и сохранность

- Ветка feat/download-workspace, интеграционная main. До работы HEAD 0e0a2ec.
- ecb1292 отдельно сохраняет исходный Windows-порт и общие platform fixes.
  Все 30 файлов этого коммита побайтно сверены с исходным SHA-256 снимком.
- Следующий локальный коммит содержит оптимизации, контракты, тесты и результаты.
  Проверить git log/status: пользовательские изменения могли появиться позже.
- .agents/, skills-lock.json и handoff/experiments/ не добавлялись и не удалялись.
- Main, тег v3.4.0, remote refs не менялись. Push/merge/release/install не было.
- Исходный дополнительный tar/patch/manifest:
  /tmp/viddow-before-download-optimization-1794561615035683000/.

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

## Оставшаяся работа и ограничения

1. HLS/DASH между исполнениями не восстанавливаются. Пока не доказана версия
   всех сегментов/init data и безопасность нового manifest, запускать отдельно.
2. Windows persistence отключён до ACL/process-ownership acceptance. Реальная
   Windows 11 x64, Known Folder, Explorer и integration Job Object не проверены.
3. Измерить реальные большие/долгие загрузки, внешний диск, ENOSPC во время mux.
   Малый локальный fixture не доказывает отсутствие регрессий на CDN.
4. Для HTTP auto без известного файлового расширения сохранён прежний save-путь;
   для восстановления можно явно использовать source_kind=direct.
5. Не считать fragment budget точным TCP cap или общекомпьютерным лимитом.

Пользователь просил тесты завершающим этапом и Markdown-отчёт. Не читать личные
cookies ради проверок, не трогать текущие загрузки и не обещать ускорение без
замеров. Подробности Windows: [windows-development](windows-development.md).
