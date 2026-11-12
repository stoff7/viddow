# Windows: аудит платформенных зависимостей и контракт адаптера

12 ноября 2026. Проверенная база: `d2fd8c4`, ветка `feat/download-workspace`,
версия 3.4.0. Этап 1 [плана](windows-plan.md): статический аудит кода и официальных
контрактов. Реализация Windows не начата; совместимость не подтверждена.

## Область и ограничения

Прочитаны Python-модули загрузчика, native-host/установщик, README, manifest,
платформенные участки расширения, журнал, тесты и инструкции выпуска.
Проверены tracked-файлы: отдельного build/release-скрипта, CI Windows,
манифеста Python-зависимостей и Windows launcher в репозитории нет.
Опубликованный ZIP и удалённое состояние Git не проверялись.

Первый предлагаемый охват остаётся Windows x64 + Chrome/Edge. Минимальная версия
Windows, доступная тестовая машина и версии комплектных инструментов ещё не
определены. Это открытые требования, а не обещанная поддержка Windows 10/11.

Инварианты: session v2/history v1, отдельная веб-очередь, явный повтор,
отсутствие daemon, приватность контекста и сохранение готовых файлов остаются
общими. Не менять пользовательские профили, PATH, текущие загрузки или файлы
релиза в рамках аудита. Не добавлять framework, shell-запуск инструментов,
глобальное завершение процессов по имени или обязательные права администратора.

## Проверенные места

P0 — блокирует Windows native-путь или корректную отмену; P1 — требуется до
приёмки Windows; P2 — диагностика/удобство. Строки относятся к базе аудита.
Наблюдения о коде проверены статически; проявление на Windows не воспроизводилось.

| Приоритет | Место | Наблюдение и требуемое изменение |
| --- | --- | --- |
| P0 | `install_native_host.py:19–69` | `~/Library/Application Support`, каталоги профилей, chmod и `.sh` вместо Windows registry/launcher. На Windows скрипт не выполняет нужную регистрацию; добавить явное ветвление по ОС до записи файлов. |
| P0 | `install_native_host.py:31–45`, `extension/manifest.json` | ID вычисляется из пути; публичного `key` в manifest нет. Нельзя переносить macOS ID на Windows. Для dev принимать фактический ID расширения, проверять `[a-p]{32}`; публичную identity определить отдельно. |
| P0 | `native_host.sh:1–4` | `/bin/sh`, Homebrew PATH и `python3`. Требуется Windows launcher с предсказуемым runtime, сохранёнными stdio и передачей аргументов браузера. |
| P0 | `download.py:173–243` | POSIX session/killpg; Windows-ветка terminate/kill касается только родителя. Потомок может удерживать pipe/временные файлы, блокировать чтение и освобождение очереди. Владеть всем деревом до выполнения дочернего кода. |
| P1 | `native_host.py:37–71` | `.buffer` и UTF-8 уже используются; явной Windows-инициализации CRT binary mode нет. Это пробел проверки launcher/runtime, а не доказанное повреждение байтов в CPython. `pythonw` нельзя считать готовым решением скрытого окна: stdio могут отсутствовать. |
| P1 | `native_host.py:44–51` | Чтение одного `read(length)` не проверяет полноту payload. В Windows-проверки канала включить короткое/оборванное чтение и несколько сообщений. Собственный входной лимит 1 МиБ строже браузерного; менять его ради ОС не требуется. |
| P1 | `download.py:38,280,552`, `native_session.py:19–33`, `server.py:156` | Downloads вычисляется как `~/Downloads`, default аргумента фиксируется при импорте. Получать Windows Known Folder при необходимости; явная папка приоритетна и не должна зависеть от успешного получения системной. Валидатор уже использует `Path`, но пример пути в ошибке macOS. |
| P1 | `native_session.py:127–132`, `native_host.py:75–80` | Два вызова `open -R`. Session уже проверяет done/существование и берёт путь из job. Legacy ограничен родителем DEFAULT_DIR, но сравнивает строки без Windows-нормализации регистра. Сохранить обе границы доступа, делегировать только системный reveal. |
| P1 | `download.py:131–166,337–356,441–454` | Фильтр убирает запрещённые символы и крайние точки/пробелы, но не Windows device names (`CON`, `NUL.txt`, `COM1` и т. п.) и длину компонента. Проверить итоговое имя с расширением, не только пользовательский stem. Имена из title yt-dlp проходят его собственную обработку; проверить оба пути. |
| P1 | `download.py:148–166,356,423` | `.part` резервируется через O_EXCL; существующий final проверяется отдельно. `os.replace` может заменить файл, появившийся после проверки. Это общий риск гонки, не только Windows: фиксировать итоговый файл без перезаписи, выбирать новое имя при конфликте. Регистронезависимость проверять на реальной ФС, не самодельным lower(). |
| P1 | `download.py:200–202,481–543`, `media_prepare.py:52–80` | TemporaryFile/TemporaryDirectory не требуют замены сами по себе. Но cleanup после отмены безопасен только после остановки всех потомков. Проверить locked/read-only файлы и временный диск, отличный от Downloads; ошибка cleanup не должна скрывать исходную или удалять готовое. |
| P1 | `download.py:515` | `0600` prepared JSON не доказывает Windows ACL. Нужны приватный пользовательский temp, проверка наследования ACL, удаление после успеха/ошибки/отмены. В JSON есть чувствительный сетевой контекст. |
| P1 | `download.py:200–202`, `inspector.py:110–121` | subprocess stdout и stderr-temp читаются с кодировкой по умолчанию. JSON, кириллица и сообщения бинарников могут декодироваться неверно. Согласовать UTF-8 с инструментом; для JSON строгий разбор, для диагностического stderr допускается replacement. UTF-8 самого native JSON этого не исправляет. |
| P1 | `download.py:201` | stdin инструментов не задан, наследуется от host. Native stdin принадлежит протоколу; запускать инструменты с DEVNULL. Не наследовать протокольный stdout/stderr; скрывать окна, сохраняя pipe и владение деревом. |
| P1 | `download.py`, `inspector.py:88,321`, `media_prepare.py:16,43`, `media_tracks.py:26`, `source_auth.py:24`, `native_session.py:52`, `server.py:54` | Прямой `shutil.which` распределён по 7 модулям. Наличие инструмента в state и реальный запуск должны использовать один resolver. Также yt-dlp самостоятельно ищет ffmpeg/ffprobe и Deno/Node: недостаточно заменить только первый executable в argv. |
| P1 | `source_auth.py:5–28`, `download.py:500–521`, `inspector.py:101–106` | Safari предлагается независимо от ОС; нет проверки доступности браузерного сеанса на Windows. Cookies только по явному выбору; DPAPI/блокировка базы/возможности установленного yt-dlp требуют отдельной проверки без личных cookies. `--impersonate chrome` требует подходящей сборки. |
| P1 | `trace_log.py:9–12,69–89` | fcntl имеет fallback, импорт Windows не блокирует. Но без fcntl остаётся только threading.Lock одного процесса: несколько host/server могут одновременно писать/ротировать журнал. Предпочесть раздельные файлы сеансов или небольшой Windows lock; сбой журнала остаётся best effort. |
| P1 | `trace_log.py:14`, `download.py:198`, `trace_log.py:36` | Журнал рядом с исходниками не годится для произвольной установки в read-only каталог. Путь перенести в пользовательский data/log каталог; `yt-dlp.exe`/`ffmpeg.exe` нормализовать к логическим именам allowlist, иначе поле tool теряется. |
| P2 | `diagnostics.py:35–38`, ошибки `download.py`/`inspector.py`, `extension/format-model.mjs:45` | Команды brew и классификация missing_dependency по строке `brew install`. Ввести платформенную подсказку и устойчивый код ошибки, сохранить текущее внешнее поле tools. Учесть missing executable отдельно от пропавшей папки назначения. |
| P2 | `extension/popup.js:568–569`, `extension/history-model.mjs:64`, `web/app.js:80` | Разбор пути только через `/` или проверка `/Downloads`; Windows-путь будет показываться неверно. В других карточках уже есть `/[\\/]/`. Это пути ФС; не заменять разделители в URL. |
| P2 | `extension/background.js:105`, `extension/popup.html:49–53` | Диагностика предлагает python3/установочный скрипт и macOS-инструкции. Учитывать Windows в инструкции отсутствующего host ещё до ready. Текущие основные кнопки уже «Показать файл», Finder в smoke — устаревший селектор. |

`macos_metadata.py:48–59` уже защищён `sys.platform != 'darwin'`, ошибки best effort.
На Windows osascript не вызывается: переписывать этот модуль ради переноса не нужно.
`jobs.py:212–217` и `native_session.py:181–192` уже передают cancel при EOF и ждут
worker/analysis/preview; исправление должно находиться на границе запуска процессов,
а не в новой Windows-очереди. Сетевое чтение по-прежнему может ждать таймаут.

## Контракт реализации (ещё не код)

Минимальная граница — `platform_support.py`; Windows детали можно вынести в
закрытый модуль, если WinAPI делает файл слишком большим. Не создавать иерархию
платформенных сервисов. Регистрация, упаковщик и media-логика остаются отдельно.

| Операция | Контракт |
| --- | --- |
| `default_download_dir() -> str` | Абсолютный путь; macOS сохраняет поведение. Windows использует SHGetKnownFolderPath/FOLDERID_Downloads, учитывает перенаправление. Ошибка даёт понятный запрос выбрать папку, без молчаливой записи в выдуманный каталог. Вызывать только без явного output_dir. |
| `resolve_tool(name) -> str | None` | Только известные логические имена yt-dlp/ffmpeg/ffprobe/deno/node. Приоритет: явно настроенный абсолютный путь → комплектный bin → допустимый системный PATH. Неверный явный путь даёт ошибку, не тихий fallback. Не искать в cwd и не исполнять cmd/bat как инструменты. Возвращать абсолютный путь. macOS сохраняет доступ к Homebrew. |
| окружение инструментов | Один набор разрешённых путей для фактического запуска и tools в state. В child env/argv передать также ffmpeg location и JS runtime для yt-dlp; проверить ffprobe рядом с ffmpeg. Менять только окружение дочернего процесса, не глобальный PATH. Версии/возможности проверять при подготовке пакета, не сетевым обновлением во время задачи. |
| `reveal_file(path) -> None` | Принимает проверенный абсолютный путь существующего файла, не произвольную команду. Авторизация по done job/legacy-папке остаётся у вызывающего. macOS open -R; Windows Shell API выделяет файл. Без shell=True, только по клику, ограниченное время/понятная ошибка. |
| `spawn_tool(argv, ...)` → владелец процесса | Владелец хранит Popen-совместимый доступ к stdout/wait/poll и ресурс дерева. stdin DEVNULL, изолированные pipes, явная кодировка, без консольного окна. Запуск либо полностью устанавливает владение, либо останавливает созданный процесс и возвращает ошибку. |
| `owner.stop()` / закрытие ресурса | Идемпотентны, потокобезопасны при гонке watcher/finally, завершают всё своё дерево даже после выхода родителя; дожидаются остановки до удаления temp. POSIX сохраняет session/killpg. Windows кандидат — Job Object без breakaway, kill-on-close и назначение до запуска дочернего кода. |

`run_tool` сохраняет callbacks, idle deadlines, проверку cancel и семантику ошибок;
делегирует только запуск/остановку/ресурсы. Его используют download, inspect,
preview и probe, поэтому один корректный путь покрывает все четыре.
Создать Job Object после обычного Popen недостаточно: потомок может родиться раньше
назначения. Способ атомарного владения (suspended launch/назначение при создании),
совместимость с browser job и handles требуют отдельного Windows прототипа.
`CREATE_NEW_PROCESS_GROUP` и `taskkill` по одному PID не принимать как доказательство
владения деревом при раннем выходе родителя. Не использовать приватные CPython
атрибуты handles без отдельного обоснования и проверки выбранной версии runtime.

Санация имени остаётся частью общего download-кода с небольшим Windows-правилом;
резервирование/финализация — отдельная локальная функция без перезаписи. Каталог
журнала входит в системные пути. Native binary stdio и registry остаются в bootstrap/
installer: общий загрузчик не должен импортировать winreg или менять stdio host.
Новых Python-пакетов аудит не требует; если stdlib/ctypes заметно усложняет надёжный
запуск, выбор зависимости оформить отдельным решением до реализации.

## Проверенные внешние контракты и решения проекта

- Native Messaging: Chrome документирует UTF-8 с 32-битной длиной в native byte
  order, лимит host→browser 1 МиБ, Windows binary I/O и аргумент origin/
  parent-window. Для x64 текущий `<I` подходит; launcher не должен писать в stdout.
  Registry Chrome: `HKCU\Software\Google\Chrome\NativeMessagingHosts\local.video_downloader`,
  default REG_SZ — абсолютный путь manifest. [Официальный Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
- Для Edge использовать собственный
  `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\local.video_downloader`.
  Edge описывает поиск HKCU перед HKLM, 32-bit view перед 64-bit и fallback в
  Chromium/Chrome. На fallback не полагаться; не создавать вручную HKCU WOW6432Node.
  IDs из разных магазинов перечислять явно. [Официальный Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging).
- Решение проекта: установка через winreg в HKCU, без elevation; явные registry
  views через API, не склейку строк WOW6432Node. Проверить оба представления и
  конфликтующие старые записи; повторная установка не плодит регистрации,
  удаление касается только принадлежащих этой установке значений. Manifest path и
  host path делать абсолютными, хотя Windows допускает относительный host path.
  `--user-data-dir` на Windows не обеспечивает изоляции HKCU-регистрации: Windows
  smoke требует отдельного пользователя/VM или сохранения и восстановления ключей.
- Downloads: [SHGetKnownFolderPath](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shgetknownfolderpath)
  и [FOLDERID_Downloads](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid).
  Кандидат reveal — [SHOpenFolderAndSelectItems](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenfolderandselectitems),
  который выделяет объекты через Shell; COM/PIDL lifecycle проверить в реализации.
- Владение деревом: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
  описывает наследование job потомками и nested jobs;
  [JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
  завершает процессы при закрытии последнего handle. Handle не должен утекать
  в потомков; корректность внезапного выхода host проверить отдельно от EOF.
- [Правила Windows-имён](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
  включают device names, конечные точки/пробелы и ограничения регистра/длины.
- [Python subprocess](https://docs.python.org/3/library/subprocess.html)
  описывает зависимость text-mode от кодировки; [Python stdio](https://docs.python.org/3.13/library/sys.html#sys.stdin)
  отдельно предупреждает об отсутствующих потоках у pythonw/GUI. Не выбирать
  упаковку только по отсутствию видимого окна.
- [Текущие зависимости yt-dlp](https://github.com/yt-dlp/yt-dlp#dependencies)
  описывают curl_cffi для impersonation, JS runtime/EJS и Python 3.11+ для
  поддерживаемого исходного варианта на момент чтения раздела. Перед фиксацией
  пакета повторно сверить конкретный релиз: документация upstream меняется.
  README Viddow обещает Python 3.9+ для собственного кода — это не доказательство
  совместимости выбранной версии yt-dlp/runtime. В аудит не входит их обновление.

## Проверки следующего этапа и порядок работ

1. Технический host: явный extension ID и абсолютные пути, регистрация HKCU
   Chrome/Edge, binary stdio в выбранном runtime; повтор install/uninstall,
   пробелы/кириллица в пути, отрицательные случаи ID/path. Удаление/обновление
   не затрагивает загрузки и историю. Публичный installer пока не выбирать.
2. Минимальный адаптер: единый поиск всех инструментов/дочерних зависимостей,
   Known Folder, reveal; сохранить session/history payload. Затем владение
   процессами, temp/ACL, безопасные имена и финализация без перезаписи.
3. Точечные проверки контрактов resolver/папок/имён/stdio с временными каталогами;
   Windows integration: родитель породил потомка и вышел, отмена до/после spawn,
   cancel watcher одновременно с finally, EOF и аварийный выход host,
   заблокированные файлы, поздняя отмена после after_move. Нужны ноль потомков,
   закрытые handles/файлы и свободное место в очереди. Не только mock terminate.
4. Обновить Python/browser fixtures: `test_cancellation_kills_descendants`
   сейчас POSIX-only; `os.kill(pid, 0)` в тестах требует Windows-замены безопасной
   проверкой handle. Native smoke использует macOS profile registration, ps,
   python3, which, shell wrapper и Finder-селекторы. Не запускать как переносимый.
   Mock smoke также содержит старые UI-селекторы. Согласовать актуальный набор
   проверок в конце реализации, не запускать полный набор после каждой правки.
5. Реальные Chrome и Edge на чистой Windows, затем macOS регрессия, затем
   пакет с закреплёнными версиями/лицензиями/происхождением инструментов. Проверять
   распространяемый пакет, а не только исходный Python. ARM64/Linux вне охвата.

В этой сессии тесты, syntax-check, сборка, приложение и браузеры не запускались;
проверялись исходники, git и первичные источники. Выполнена только проверка
оформления diff. Windows/пакет/реальные браузеры остаются внешней проверкой.
Личные cookies, журналы загрузок и содержимое пользовательских профилей не читались.
