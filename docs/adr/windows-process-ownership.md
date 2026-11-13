# Кандидат: назначение Windows Job Object при создании процесса

Статус: прототип, не принято для production до исполнения на Windows 11 x64.
Дата: 12 ноября 2026. Реализация: `prototypes/windows_job.py`.

## Требования

Владеть деревом до выполнения дочернего кода; сохранять владение после выхода
родителя; останавливать потомков при EOF/отмене/аварии host. Не наследовать job
handle, не использовать breakaway, taskkill по PID/имени, shell или приватные
атрибуты CPython. Не менять macOS session/killpg до проверки Windows-механизма.

## Выбор для эксперимента

Публичные `CreateProcessW`/`STARTUPINFOEXW` с `PROC_THREAD_ATTRIBUTE_JOB_LIST`,
один ненаследуемый неназванный job с `KILL_ON_JOB_CLOSE` на инструмент.
Назначение выполняется до запуска initial thread; описано в
[Microsoft Old New Thing](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812).
Поддержка атрибута начинается с Windows 10 согласно
[UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute);
первая целевая проверка проекта всё равно Windows 11 x64. Это не обещание Windows 10.

`stop()` сериализован lock, вызывает TerminateJobObject, ждёт ActiveProcesses == 0,
затем закрывает собственные handles. При таймауте сохраняет владение для retry и
не разрешает считать temp очищаемым. Уничтожение host закрывает последний job
handle средствами ОС. При ошибке создания нет fallback к обычному Popen.
Наследование nested job проверяется отдельно; ограничения browser job могут
привести к отказу запуска, а не разрешению запустить невладеемый процесс.

## Альтернативы и цена

Обычный Popen, затем AssignProcessToJobObject оставляет гонку выполнения.
CREATE_SUSPENDED + Assign + Resume устраняет гонку кода, но оставляет окно между
созданием и назначением, когда авария host может оставить suspended-сироту.
JOB_LIST устраняет эту последовательность из пользовательского кода.

Использован ctypes, без новой зависимости. Цена — явные WinAPI-структуры,
сигнатуры и lifecycle ресурсов. Небольшой изолированный прототип пока не реализует
Popen-интерфейс, env, pipes или production deadlines. `wait()` держит lock на
время ограниченного ожидания, поэтому не подходит для блокирующего ожидания в
будущем production watcher. Это необходимо изменить до интеграции. Если pipes и
handles заметно увеличат сложность, пересмотреть библиотеку/нативный launcher в
этом ADR; не переносить прототип напрямую в общий код ради формального покрытия.

## Приёмка

`tests/test_windows_job.py` исполняется только на Windows, без mocks:
родитель выходит до stop; leaf продолжает держать файл; два stop одновременно;
EOF и принудительный выход контроллера; nested job; cancel до/во время spawn;
повторные циклы не увеличивают число handles.

Ещё нужны удерживаемые pipes, отказ назначения, авария во время spawn и реальный
browser job. Сохранность готового файла и освобождение очереди проверяются уже
при интеграции. Пропуск тестов на macOS не считается доказательством WinAPI.
