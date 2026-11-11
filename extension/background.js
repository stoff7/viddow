import { rememberStream, groupStreams } from './stream-model.mjs';

const HOST = 'local.video_downloader';
const STREAM_TYPE = /mpegurl|dash\+xml/i;
const STREAM_PATH = /\.(m3u8|mpd)$/i;
const SKIP_HEADER = /^(range|accept-encoding|host|connection|content-length|if-.*)$/i;
const sentHeaders = new Map();
const key = (tabId) => `tab_${tabId}`;
let chain = Promise.resolve();
function update(storageKey, change, afterWrite) {
  const operation = chain.then(async () => {
    const value = (await chrome.storage.session.get(storageKey))[storageKey];
    const next = change(value);
    await chrome.storage.session.set({ [storageKey]: next });
    await afterWrite?.(next);
    return next;
  });
  chain = operation.catch(console.error);
  return operation;
}
function updateTab(tabId, change) {
  return update(key(tabId), (value) => change(value || []), (items) =>
    chrome.action.setBadgeText({ tabId, text: items.length ? String(groupStreams(items).length) : '' }));
}
chrome.webRequest.onSendHeaders.addListener((details) => {
  if (details.tabId < 0) return;
  sentHeaders.set(details.requestId, Object.fromEntries((details.requestHeaders || [])
    .filter((header) => header.value !== undefined && !SKIP_HEADER.test(header.name))
    .map((header) => [header.name, header.value])));
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onErrorOccurred.addListener((details) => sentHeaders.delete(details.requestId), { urls: ['<all_urls>'] });
chrome.webRequest.onBeforeRedirect.addListener((details) => sentHeaders.delete(details.requestId), { urls: ['<all_urls>'] });
chrome.webRequest.onHeadersReceived.addListener((details) => {
  const headers = sentHeaders.get(details.requestId);
  sentHeaders.delete(details.requestId);
  if (details.tabId < 0) return;
  const contentType = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-type')?.value || '';
  const path = new URL(details.url).pathname;
  if (details.statusCode >= 400 || (!STREAM_TYPE.test(contentType) && !STREAM_PATH.test(path))) return;
  const item = { url: details.url, kind: /dash|\.mpd$/i.test(contentType + path) ? 'DASH' : 'HLS',
    referer: details.initiator && /^https?:/.test(details.initiator) ? details.initiator + '/' : '',
    headers, lastSeen: details.timeStamp || Date.now() };
  updateTab(details.tabId, (items) => rememberStream(items, item));
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['responseHeaders']);
// Чистим до запросов нового документа, чтобы поздний ответ навигации не удалял новые потоки.
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId >= 0) updateTab(details.tabId, () => []);
}, { urls: ['<all_urls>'], types: ['main_frame'] });
chrome.tabs.onRemoved.addListener((tabId) => {
  chain = chain.then(() => chrome.storage.session.remove(key(tabId))).catch(console.error);
});

// Один хост хранит очередь всех вкладок. Он живёт независимо от открытого UI.
let port = null, connecting = null, session = null;
const pending = new Map();
function hostError(reason) {
  if (/not found|forbidden|not registered/i.test(reason || '')) {
    return 'Помощник не подключён. Выполните в папке проекта: python3 install_native_host.py';
  }
  return reason || 'Связь с загрузчиком прервалась. Подключитесь снова.';
}
async function ensureHost() {
  if (connecting) return connecting;
  if (port && session) return;
  connecting = (async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await update('host', () => ({ status: 'connecting', error: null }));
    return new Promise((resolve, reject) => {
      const current = chrome.runtime.connectNative(HOST);
      port = current;
      let ready = false;
      const timeout = setTimeout(() => {
        disconnected('Помощник не ответил. Проверьте его установку.');
        current.disconnect();
      }, 10000);
      let ended = false;
      const disconnected = (reason) => {
        if (ended) return;
        ended = true;
        clearTimeout(timeout);
        if (port === current) { port = null; session = null; }
        const error = hostError(reason);
        if (!ready) reject(new Error(error));
        for (const [id, request] of pending) {
          clearTimeout(request.timer); request.reject(new Error(error)); pending.delete(id);
        }
        update('host', () => ({ status: 'offline', error }));
        update('nativeState', (state) => state ? { ...state, jobs: state.jobs.map((job) =>
          ['queued', 'running', 'cancelling'].includes(job.status)
            ? { ...job, status: 'error', error: 'Загрузчик отключён. Добавьте ссылку заново после подключения.' } : job),
          analysis: state.analysis && ['running', 'cancelling'].includes(state.analysis.status)
            ? { ...state.analysis, status: 'error', error: 'Загрузчик отключён. Запросите качество заново.' } : state.analysis } : null);
      };
      current.onMessage.addListener((message) => {
        if (ended) return;
        if (message.type === 'ready' || message.type === 'state') {
          if (message.type === 'ready') {
            if (message.protocol !== 2 || typeof message.session !== 'string' || !message.session) {
              disconnected('Помощник использует несовместимый протокол. Обновите файлы проекта.');
              current.disconnect();
              return;
            }
            session = message.session;
          } else if (!ready || message.session !== session) return;
          update('nativeState', () => message);
          update('host', () => ({ status: 'online', error: null }));
          if (message.type === 'ready') {
            ready = true; clearTimeout(timeout); resolve();
          }
        } else if (message.type === 'reply') {
          const request = pending.get(message.request_id);
          if (!request) return;
          clearTimeout(request.timer); pending.delete(message.request_id);
          if (message.ok) request.resolve(message.result);
          else request.reject(new Error(message.error));
        } else if (message.type === 'error') {
          disconnected(message.error); current.disconnect();
        }
      });
      current.onDisconnect.addListener(() => disconnected(chrome.runtime.lastError?.message));
      current.postMessage({ type: 'session', settings });
    });
  })();
  try { return await connecting; }
  catch (error) {
    await update('host', () => ({ status: 'offline', error: hostError(error.message) }));
    throw error;
  }
  finally { connecting = null; }
}
async function command(message) {
  await ensureHost();
  if (message.session && message.session !== session) throw new Error('Сессия загрузок изменилась. Добавьте ссылку заново.');
  return new Promise((resolve, reject) => {
    const request_id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(request_id);
      reject(new Error('Ответ задерживается. Проверьте список загрузок перед повтором.'));
    }, 12000);
    pending.set(request_id, { resolve, reject, timer });
    try { port.postMessage({ ...message, session, request_id }); }
    catch (error) { clearTimeout(timer); pending.delete(request_id); reject(error); }
  });
}
async function handle(message) {
  if (message.type === 'connect') { await ensureHost(); return {}; }
  if (message.type === 'download' || message.type === 'inspect') {
    const item = message.item;
    return command({ command: message.type, urls: [item.url], name: message.title || '',
      page: message.page || '', referer: item.referer || '', headers: item.headers || {},
      source_kind: item.source_kind || 'auto', stream_kind: item.kind || null });
  }
  if (message.type === 'download_selection') {
    return command({ command: 'download', analysis_id: message.analysis_id,
      format_ids: message.format_ids, session: message.session });
  }
  if (message.type === 'inspect_cancel') {
    return command({ command: 'inspect_cancel', analysis_id: message.analysis_id, session: message.session });
  }
  if (['cancel', 'retry', 'clear', 'reveal'].includes(message.type)) {
    return command({ command: message.type, id: message.id, session: message.session });
  }
  if (message.type === 'configure') {
    const settings = await command({ command: 'configure', settings: message.settings });
    await chrome.storage.local.set({ settings });
    return settings;
  }
  throw new Error('Неизвестная команда');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  handle(message).then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: error.message }));
  return true;
});
if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
