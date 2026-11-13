# Windows 11 x64: комплект для личной проверки

14 ноября 2026. Установщик **реально собран на Windows**, скачан с GitHub Actions
и сохранён локально. Версия: **3.5.0-test.1**, неподписанный тестовый пакет.

- Комплект: `dist/Viddow-Windows-x64-test-3.5.0-test.1.zip`.
- Установщик: `dist/windows/Viddow-Setup-3.5.0-test.1-windows-x64.exe`.
- SHA-256 установщика: `0722ebd91743bbfa6ceb78f5515b9ff12a19fb092200a15665d13e58d167f0f7`.
- Manifest компонентов/файлов: `dist/windows/components.json`.
- Инструкция: `packaging/windows/WINDOWS-TEST.md` и копия в комплекте.
- Сборка: [Actions run 43518987319](https://github.com/stoff7/viddow/actions/runs/43518987319).
- Код проверенного executable: `699f7dcc17b2aa08ae73f06d71e681b934d2c68d`,
  ветка `build/windows-installer-test`. Main, теги и существующие релизы не менялись.

## Состав

PyInstaller onedir с Python 3.12.10; yt-dlp 2026.10.26 (официальный standalone
Windows x64, Chrome impersonation подтверждён), FFmpeg/ffprobe LGPL shared
n8.1.3-35-gf1acb0a266-20261113, Deno 2.9.8. Inno Setup 6.4.3 устанавливает
для текущего пользователя. Runtime и все инструменты включены; первый запуск
не скачивает исполняемые компоненты. Расширение входит отдельным ZIP и ставится
пользователем через страницу расширений Chrome/Edge.

Точные URL и SHA-256 скачанных executable-архивов закреплены в
`packaging/windows/components.lock.json`; фактические runtime-файлы и их SHA-256 —
в components.json. Лицензии находятся в установленной папке `licenses`.
Фактическая сборочная Python-среда записана в build-environment.txt; транзитивные
pip-зависимости пока записываются после сборки, а не полностью закреплены входным
requirements с хешами. Побитовая воспроизводимость installer не заявляется.

## Проверено

Windows Server 2025 x64 в disposable GitHub Actions runner:

- 35 тестов прошли, один пропущен по платформе. Реальные WinAPI-проверки
  прототипа и рабочего JobProcess: nested job, родитель вышел раньше потомка,
  EOF/аварийный выход контроллера, одновременный stop, отмена при создании,
  отсутствие роста handles после прогрева, pipes/Unicode/env, неблокирующий wait.
- Именно собранный installer: per-user silent install, кириллица/пробелы/% в пути;
  integrity-check всего payload. Замена при активном host отклоняется.
- Установленный frozen host: native binary stdio, ready/session v2/history v1,
  reply/state и чистый выход по EOF. PATH очищен до System32, неверный dev override
  не влияет на комплектный resolver. Это не заменяет чистую Windows без build tools.
- Прямой MP4; HLS с раздельными видео/аудио, загрузка через комплектный yt-dlp,
  объединение комплектным FFmpeg. ffprobe подтверждает обе дорожки и длительность.
- Повторная установка/repair; намеренно повреждённый Deno выявляется проверкой,
  полный installer восстанавливает его. Uninstall снимает свои записи обоих
  браузеров и сохраняет скачанный файл.
- Все контрольные суммы CI-артефактов повторно проверены после скачивания на macOS.

На macOS: адресный набор общих функций — **60 passed, 7 Windows skips**;
`git diff --check` прошёл. Полный suite и macOS browser smoke не выполнялись.

## Что остаётся проверить на Windows 11 пользователя

Реальное подключение Chrome/Edge через connectNative, запуск внутри browser job,
отсутствие мигающих окон, Explorer, перенесённая Downloads, ошибки ACL/места,
история после перезапуска расширения и отмена именно из панели. Установка на
чистую Windows без Python/FFmpeg пока не выполнялась. Не проверены внешний CDN,
личные cookies, внешние/сетевые диски. Windows persistence/resume остаётся выключен.

Выпуск предназначен для личной проверки, не для публичного распространения.
Публичный выпуск требует полной платформенной приёмки, signing и архивирования
соответствующих исходников FFmpeg/связанных библиотек. Автоматическое обновление
и транзакционный rollback между несколькими версиями не приняты; для этой версии
поддержан повторный полный installer. Завершайте загрузки перед изменением установки.

Исходные журналы CI, install/active-host logs, verification.txt, manifest и SHA256SUMS
включены в комплект. Источники технических решений и требования зафиксированы в
[ADR](adr/windows-bundled-installer.md).
