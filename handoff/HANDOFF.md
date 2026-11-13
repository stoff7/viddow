# Viddow: Windows-установщик готов к личной проверке

Обновлено 14 ноября 2026. Установщик 3.5.0-test.1 реально собран на Windows.
Следующий приоритет — **приёмка установленного пакета на Windows 11 x64 пользователя**,
а не повторная реализация упаковки. [Шаги и границы](windows-installer-acceptance.md).
Сообщение пользователя «сделал» не содержит результатов этой приёмки;
не считать реальные Chrome/Edge уже проверенными.

## Git и артефакт

- Текущая ветка build/windows-installer-test, интеграционная main.
  До этого handoff HEAD `2a6c5ca` (отчёт), executable собран из `699f7dc`.
- Локальный tracking origin/build/windows-installer-test совпадает по status;
  fetch/удалённая проверка в текущей сессии не выполнялись. Один worktree.
- Tracked-дерево чистое до handoff; untracked .agents/, handoff/experiments/,
  skills-lock.json принадлежат пользователю. Не добавлять/удалять автоматически.
- Установщик: dist/windows/Viddow-Setup-3.5.0-test.1-windows-x64.exe (~132 МиБ).
  SHA-256 повторно проверен сейчас и совпал с отчётом:
  0722ebd91743bbfa6ceb78f5515b9ff12a19fb092200a15665d13e58d167f0f7.
- dist/windows/Viddow-extension.zip, components.json, SHA256SUMS.txt и журналы есть.
- Расхождение с отчётом: общий dist/Viddow-Windows-x64-test-3.5.0-test.1.zip
  сейчас отсутствует; сохранился только .zip.sha256. Не давать ссылку на отсутствующий
  ZIP. При необходимости собрать новый комплект и пересчитать его hash.
- Main/тег v3.4.0/релизы не менять. Пакет личный тестовый, публичного выпуска нет.

## Что реализовано

- PyInstaller onedir (Python 3.12.10), Inno Setup 6.4.3 per-user; комплектные
  yt-dlp 2026.10.26, ffmpeg/ffprobe LGPL shared, Deno 2.9.8.
  Первый запуск не скачивает executable; Python/PATH пользователя не нужны.
- Frozen resolver берёт свои компоненты и игнорирует dev overrides/global PATH;
  payload проверяется хешами. Install/repair/uninstall и регистрация HKCU Chrome/Edge.
- Production JobProcess с creation-time JOB_LIST/HANDLE_LIST, kill-on-close,
  pipes/env/Unicode и остановкой потомков; это уже не только прототип.
- Windows Known Folder Downloads, Shell reveal и пользовательские логи реализованы;
  реальное поведение рабочего стола требует приёмки ниже.
- Install root версионирован, manifest отдельно; замена при активном host отклоняется.
  Повторный installer ремонтирует ту же версию. Транзакционное обновление нескольких
  версий и автоматический updater не приняты.
- Расширение ставится вручную из ZIP, установщик принимает фактические ID браузеров.
  История/очередь/компактная панель/оптимизации сохранены. macOS bundle не делался.

## Подтверждённые проверки и ограничения

По [отчёту](../docs/windows-test-installer-report.md) и сохранённым CI-материалам:
- Windows Server 2025 x64: 35 passed, 1 skipped; реальный WinAPI/process lifecycle.
- Именно installer: silent install, Unicode/пробелы/%, integrity, запрет busy replace,
  frozen host framing/EOF, MP4, HLS video+audio через комплектные tools, repair
  повреждённого Deno, uninstall сохраняет скачанный файл.
- macOS: 60 passed, 7 Windows skips; полный suite/browser smoke не выполнялись.
- [CI run](https://github.com/stoff7/viddow/actions/runs/43518987319) из отчёта;
  его удалённое состояние сейчас не проверялось. Прогоны заново не запускались.
- В текущей сессии прочитаны Git, отчёт/ADR/инструкция, перечислены артефакты и
  проверен hash EXE. Никакой установки, браузерных тестов или публикации не было.
- CI с очищенным PATH не заменяет чистую Windows 11 без build tools.
- Windows/HLS-DASH persistence остаются выключены/не реализованы соответственно.
  Реальные CDN, внешние диски и долгие загрузки отдельно не приняты.

## Следующие действия

1. Следовать [WINDOWS-TEST.md](../packaging/windows/WINDOWS-TEST.md): установить
   расширение в постоянную папку, передать ID в installer, проверить подключение.
2. Проверить Chrome и Edge: правильный ролик со звуком, прогресс/успех, отмена
   из панели, EOF браузера, история, Explorer и перенесённая Downloads.
3. При ошибке читать пользовательские обезличенные логи и связать попытку с версией
   пакета. Не заменять проверяемый EXE незаметно новой сборкой.
4. Зафиксировать результат в acceptance-документе: ОС/браузер, hash, сценарий,
   факт, ошибка/лог. Закрывать пункты только по доказательству.
5. После личной приёмки — отдельное решение о публичном выпуске, signing,
   исходниках компонентов/лицензиях, зависимостях сборки и обновлении.

## Договорённости и источники

Не мешать текущим загрузкам; finish/close браузеры перед install/repair/uninstall.
Личные cookies ради тестов не читать, защиту Windows не отключать. Explorer только
по действию пользователя. Тесты завершающим этапом, не после каждой правки.
[ADR](../docs/adr/windows-bundled-installer.md), [отчёт](../docs/windows-test-installer-report.md),
[прежний план](windows-installer.md), [общая упаковка](bundled-installer.md),
[архив входа](archive/handoff-before-windows-installer-acceptance-2026-11-14.md).
