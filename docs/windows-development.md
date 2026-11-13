# Windows: первый технический этап

12 ноября 2026. Целевая машина первой проверки — Windows 11 x64 (есть у
пользователя). В рабочей сессии доступна только macOS. Код ниже **ещё не
подтверждает поддержку Windows**; публичного установщика и Windows-релиза нет.
macOS launcher, очередь, media-логика, история и установка по умолчанию сохранены.

Продолжение без Windows-машины: общий resolver уже интегрирован, прямой файл и
ffmpeg фиксируются без перезаписи при позднем конфликте; stdin/UTF-8 инструментов
явно заданы. [Контракт, границы и результаты 71 теста на macOS](platform-tools-and-publication.md).
Windows Job Object всё ещё не интегрирован; Downloads/Explorer/ACL/логи ожидают
следующих этапов.

## Что подготовлено

- `install_native_host.py` выбирает Windows до обращения к macOS-профилям.
  Фактические ID передаются через повторяемый `--extension-id`; формат `[a-p]{32}`.
- `windows_native_install.py` создаёт локальные manifest/launcher в
  `windows-native/` (ignored), регистрирует HKCU Chrome/Edge, без администратора
  и изменения PATH. Используется 32-bit registry view; HKCU Software не следует
  вручную подменять на `Software\WOW6432Node`.
- Повторная установка обновляет свою регистрацию. Чужой manifest вызывает ошибку
  до записи файлов. Uninstall снимает только своё default value и удаляет пустой
  ключ, сохраняя остальные значения/подключи. История и загрузки не удаляются.
  Сбой доступа между записями двух браузеров может оставить частичную регистрацию;
  после устранения причины повторить ту же команду.
- Технический `.cmd` фиксирует `sys.executable` установщика (CPython 3.11+
  `python.exe`), передаёт `%*`, включает UTF-8 и не печатает в stdout.
  Это промежуточный launcher, не выбранная упаковка. Работа `.cmd`, скрытие окна,
  кодовая страница без консоли, кириллица и политика direct-executable host требуют
  реального Chrome/Edge. При проблемах заменить launcher нативным exe; не выбирать
  `pythonw`, который может лишить host stdin/stdout. Пути с `%`/кавычками запрещены.
- `native_protocol.py` включает Windows binary mode, читает полностью header/payload,
  различает чистый EOF и оборванный frame, принимает только UTF-8 JSON-объект.
  Лимит приложения остался 1 МиБ. Общий host использует этот reader на обеих ОС.
- `prototypes/windows_job.py` — изолированный WinAPI-кандидат, **не подключён к
  `download.run_tool`**. Выбор и границы: [ADR](adr/windows-process-ownership.md).

## Проверка на Windows 11 x64

Использовать отдельного Windows-пользователя или VM. `--user-data-dir` изолирует
профиль браузера, но не HKCU-регистрацию; установщик отвергает этот флаг на Windows.
Не запускать регистрацию в профиле с работающими загрузками. Перед переносом
изменений дождаться завершения загрузок macOS; здесь приложение не переустанавливалось.

В PowerShell из корня копии проекта, с установленным CPython 3.11+:

```powershell
python -m unittest discover -s tests -p test_windows_port.py -v
python -m unittest discover -s tests -p test_windows_job.py -v
```

Первый файл проверяет framing/ID/launcher и контракт registry с подменённым API,
не реальные ключи. Второй использует **настоящий WinAPI**: ранний выход родителя,
одновременный stop, EOF и аварийный выход контроллера, nested job, отмена до/во
время spawn и стабильное число handles. Проверка живости — по process handle,
освобождения файла — через unlink. Leaf сам завершается через 30 секунд на случай
сбоя эксперимента. Используются только временные файлы и безвредный Python.

После прохождения process-прототипа загрузить `extension/` через «Load unpacked»
в Chrome и Edge, скопировать реальные ID (они могут различаться):

```powershell
python install_native_host.py --extension-id <CHROME_ID> --extension-id <EDGE_ID>
# Либо отдельный браузер:
python install_native_host.py --browser chrome --extension-id <CHROME_ID>
# Снятие регистрации текущей папки, также допускает --browser:
python install_native_host.py --uninstall
```

Заменить `<…>` значениями; угловые скобки не вводить. Python должен быть именно
тем runtime, который будет оставаться на месте: launcher сохраняет его абсолютный
путь. При переносе проекта/удалении Python требуется новая регистрация. При
переносе сначала снять старую регистрацию из старой папки. Обновление регистрации
не закрывает запущенные host, но перезагрузка расширения прерывает его сеанс.

В каждом браузере подтвердить ready/state/reply и несколько команд настройки,
переподключение, EOF, кириллицу и пробелы в пути проекта и runtime. Отдельно проверить
неверный ID, удалённый launcher/runtime и обрыв frame. Тест framing на Python
**не заменяет** связь браузер→host. Реальные загрузки пока не принимать:
production `run_tool` всё ещё использует прежнюю Windows-отмену только родителя.

## Следующая граница

Сначала исполнить оба прототипа на Windows. Для B ещё добавить реальные pipes:
потомок удерживает stdout/temp; ошибка назначения job; сбой host во время spawn;
cancel watcher/finally; запуск из настоящего browser job. Простой nested job
тест не воспроизводит все ограничения браузерного job. После этого минимально
подключить владельца в `run_tool`, сохранив POSIX session/killpg и callbacks.

Resolver/дочерние зависимости yt-dlp, UTF-8/DEVNULL и два прежних os.replace уже
исправлены отдельной общей частью. Далее — Known Folder Downloads, Explorer,
ACL prepared JSON и пользовательские логи; Windows-поведение общих изменений
всё ещё требует исполнения. UI/очередь не переделывать. Упаковка — после реальных
загрузок/отмены и macOS-регрессии.

Официальные контракты, сверенные перед реализацией:
[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging).

## Выполненные проверки этого этапа

На macOS прошли 6 тестов `test_windows_port.py` (framing и контракты установки)
и 5 существующих `test_native_session.py` (настоящий Python-host, локальная загрузка,
очередь, отмена, EOF, legacy-команды). Для session-fixture sandbox запрещал bind
на 127.0.0.1; адресный прогон вне sandbox разрешён и завершился успешно.
`test_windows_job.py`: 5 пропусков по ОС, не успешная проверка Windows.
Полный набор, браузеры и Windows не запускались; установщик не применялся к
пользовательским профилям. `git diff --check` прошёл.
