# Проверка привязки метаданных и изображений

12 ноября 2026. Контракт: [media-identity.md](media-identity.md).

## Подтверждено

- 21 тест models/page-preview/streams/formats/diagnostics прошёл.
- Синтаксис background.js/popup.js и `git diff --check` проверены.
- `tests/media_identity_smoke.cjs` прошёл с настоящими scripting/isolated worlds,
  webRequest и SIDE_PANEL. Два loopback-порта, временный профиль, native отключён,
  внешние HTTP-запросы блокируются. Проверены скрытый предок, вложенный cross-origin
  iframe, два видимых плеера, два video одного документа, поздний результат серии
  и документа, сохранение явного выбора. frameId/documentId настоящего сетевого
  запроса сверены с DOM; запрос manifest в том же фрейме не считается соответствием.
- Та же проверка получает настоящую duration из локальных MP4 (2/4 секунды),
  настоящий зелёный/синий JPEG из canvas, CORS fallback на poster, сохраняет
  paused/currentTime. Лента из 30 video без poster: выбран 30-й, кадр показан,
  картинки видимых кандидатов загружены при прокрутке. Снимки 320 px (светлая)
  и 400 px (тёмная), без горизонтального переполнения, просмотрены в ходе работы.
- `tests/extension_smoke.cjs` прошёл после правок: захват потоков, группировка,
  вкладки, команды, качество, очередь, история, offline/reconnect, две панели,
  автоанализ/дедупликация, старт с историей, диагностика, 320/400 px.
  Этот smoke подменяет native-порт.

Снимки: `/tmp/viddow-media-identity/feed-320-light.png`,
`/tmp/viddow-media-identity/feed-400-dark.png`, `/tmp/viddow-media-stage1/`.

## Повторение

```sh
node --test tests/test_media_model.mjs tests/test_page_preview.cjs tests/test_streams.mjs tests/test_formats.mjs tests/test_diagnostics.mjs
NODE_PATH=/tmp/viddow-browser-check/node_modules CHROMIUM_PATH='/Users/staslisicin/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' node tests/media_identity_smoke.cjs
```

Команда старого smoke и параметры окружения: [commands.md](../handoff/commands.md).
Новый тест не требует ffmpeg: небольшие MP4 уже находятся в фикстуре.

## Что остаётся

Полный набор, реальный native-анализ/скачивание, настоящий X и выбранная серия
на внешнем сайте не проверялись. Blob/MSE не сопоставляется с manifest по одному
frameId: картинки DOM-кандидатов доступны независимо от такого сопоставления,
а неподтверждённая картинка потока остаётся неизвестной. Точная привязка такого
потока и перенос подтверждённых изображений в результат native-анализа требуют
следующего этапа. Анализ без thumbnail пока не получает автоматически DOM-картинку.

Нет кадра/постера — показывается подписанная заглушка. Обещать реальную картинку
для любого сетевого запроса без доказанного соответствия невозможно. Это остаётся
явным ограничением, а не поводом показывать общий постер страницы.
