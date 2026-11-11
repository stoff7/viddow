// Ловит HLS/DASH-плейлисты, которые запрашивает плеер, — как Video DownloadHelper:
// HTML не разбираем, смотрим сетевые ответы вкладки по Content-Type и адресу.
// Найденное хранится по вкладкам в storage.session: service worker засыпает и память теряет.
const STREAM_TYPE = /mpegurl|dash\+xml/i;
const STREAM_PATH = /\.(m3u8|mpd)$/i;
const MAX_PER_TAB = 30;

const key = (tabId) => `tab_${tabId}`;

// Заголовки, с которыми браузер запросил поток. Подписанные ссылки CDN бывают привязаны
// к User-Agent и Referer — ffmpeg должен прийти с теми же. Служебные не нужны.
const SKIP_HEADER = /^(range|accept-encoding|host|connection|content-length|if-.*)$/i;
const sentHeaders = new Map(); // requestId -> {имя: значение}, живёт до ответа

chrome.webRequest.onSendHeaders.addListener((details) => {
  if (details.tabId < 0) return;
  sentHeaders.set(details.requestId, Object.fromEntries(details.requestHeaders
    .filter((h) => h.value !== undefined && !SKIP_HEADER.test(h.name))
    .map((h) => [h.name, h.value])));
}, { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] },
// extraHeaders — без него Chrome не показывает Referer и Cookie
["requestHeaders", "extraHeaders"]);

chrome.webRequest.onErrorOccurred.addListener((details) => sentHeaders.delete(details.requestId),
  { urls: ["<all_urls>"] });

// Обработчики асинхронные и могут перемежаться — изменения хранилища выполняем строго по очереди.
// change получает текущий список и возвращает новый (или тот же — тогда ничего не пишем).
let chain = Promise.resolve();
function update(storageKey, change, afterWrite) {
  chain = chain.then(async () => {
    const value = (await chrome.storage.session.get(storageKey))[storageKey] || [];
    const next = change(value);
    if (next === value) return;
    await chrome.storage.session.set({ [storageKey]: next });
    await afterWrite?.(next);
  }).catch(console.error);
}

function updateTab(tabId, change) {
  update(key(tabId), change,
    (items) => chrome.action.setBadgeText({ tabId, text: items.length ? String(items.length) : "" }));
}

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const headers = sentHeaders.get(details.requestId);
  sentHeaders.delete(details.requestId);
  if (details.tabId < 0) return;
  if (details.type === "main_frame") { // новая страница — старые находки не нужны
    updateTab(details.tabId, (items) => (items.length ? [] : items));
    return;
  }
  const contentType = details.responseHeaders
    ?.find((h) => h.name.toLowerCase() === "content-type")?.value || "";
  const path = new URL(details.url).pathname;
  if (!STREAM_TYPE.test(contentType) && !STREAM_PATH.test(path)) return;

  const item = {
    url: details.url,
    kind: /dash|\.mpd$/i.test(contentType + path) ? "DASH" : "HLS",
    // origin фрейма, который запросил поток: плеер часто во iframe, и CDN проверяет именно его
    referer: details.initiator ? details.initiator + "/" : "",
    headers, // если service worker перезапускался между запросом и ответом — undefined, хватит referer
  };
  updateTab(details.tabId, (items) =>
    items.some((i) => i.url === item.url) || items.length >= MAX_PER_TAB ? items : [...items, item]);
}, { urls: ["<all_urls>"], types: ["main_frame", "xmlhttprequest", "media", "other"] }, ["responseHeaders"]);

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

// ── Загрузки ────────────────────────────────────────────────────────────────────────────────
// Качает native_host.py (download.py): браузер запускает его на каждую загрузку, сервер не нужен.
// Пока порт к хосту открыт, Chrome не усыпляет service worker. Состояние — в storage.session "jobs",
// его читает popup.
const HOST = "local.video_downloader"; // то же имя — в install_native_host.py
const MAX_JOBS = 30;
const ports = new Map(); // id загрузки -> порт к её хосту

const patchJob = (id, fields) =>
  update("jobs", (jobs) => jobs.map((j) => (j.id === id ? { ...j, ...fields } : j)));

function hostError(reason) {
  if (/not found|forbidden/i.test(reason)) {
    return "Хост не установлен — запустите в папке downloader: python3 install_native_host.py";
  }
  return reason || "загрузка прервалась";
}

function startDownload({ item, title, page }) {
  const id = crypto.randomUUID();
  update("jobs", (jobs) => [{ id, url: item.url, title, status: "running", fraction: null,
    label: "запуск…" }, ...jobs].slice(0, MAX_JOBS));

  const port = chrome.runtime.connectNative(HOST);
  ports.set(id, port);
  port.onMessage.addListener((msg) => {
    if (msg.type === "progress") patchJob(id, { fraction: msg.fraction, label: msg.label });
    else if (msg.type === "done") patchJob(id, { status: "done", fraction: 1, path: msg.path });
    else if (msg.type === "error") patchJob(id, { status: "error", error: msg.error });
  });
  // Хост закрывается и после done/error — тогда статус уже не running и ничего не меняем.
  port.onDisconnect.addListener(() => {
    ports.delete(id);
    const reason = chrome.runtime.lastError?.message;
    update("jobs", (jobs) => jobs.map((j) =>
      (j.id === id && j.status === "running" ? { ...j, status: "error", error: hostError(reason) } : j)));
  });
  // Имя файла делает download.nice_name() по сырому заголовку и адресу вкладки.
  port.postMessage({ type: "download", url: item.url, name: title, page,
    referer: item.referer, headers: item.headers });
}

function cancelDownload(id) {
  // закрытый порт закрывает stdin хоста — он остановит yt-dlp/ffmpeg и уберёт недокачанное
  ports.get(id)?.disconnect();
  ports.delete(id);
  patchJob(id, { status: "cancelled" });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "download") startDownload(msg);
  else if (msg.type === "cancel") cancelDownload(msg.id);
  else if (msg.type === "clear") update("jobs", (jobs) => jobs.filter((j) => j.status === "running"));
});
