import { rememberStream, groupStreams } from './stream-model.mjs';
import { decodeHistory, historyFromJobs } from './history-model.mjs';
import { recordDiagnostic, readDiagnostics, clearDiagnostics, diagnosticCode } from './diagnostics.mjs';

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
let autoInspectPending = false;
const automaticSources = new Set();
let lastAnalysis = '';
let historyWritable = true, lastHistory = '', historyWarning = '';
const pending = new Map();
async function persistHistory(state) {
  if (!historyWritable) return;
  const history = historyFromJobs(state.jobs);
  const encoded = JSON.stringify(history);
  if (encoded === lastHistory) return;
  try {
    await chrome.storage.local.set({ history });
    lastHistory = encoded;
    await chrome.storage.session.set({ historyStatus: { warning: historyWarning, error: '' } });
  } catch {
    await chrome.storage.session.set({ historyStatus: { warning: historyWarning,
      error: 'История не сохранена. Загрузки продолжаются; проверьте свободное место и хранилище расширения.' } });
  }
}
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
    recordDiagnostic('host_connect_start');
    await chain;
    const stored = await chrome.storage.local.get(['settings', 'history']);
    const settings = stored.settings || {};
    const decoded = decodeHistory(stored.history);
    historyWritable = decoded.writable; historyWarning = decoded.warning;
    lastHistory = JSON.stringify(stored.history);
    await chrome.storage.session.set({ historyStatus: { warning: historyWarning, error: '' } });
    await update('host', () => ({ status: 'connecting', error: null }));
    return new Promise((resolve, reject) => {
      const current = chrome.runtime.connectNative(HOST);
      port = current;
      let ready = false;
      const timeout = setTimeout(() => {
        recordDiagnostic('host_timeout');
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
        recordDiagnostic('host_disconnect', { code: diagnosticCode(reason) });
        if (!ready) reject(new Error(error));
        for (const [id, request] of pending) {
          recordDiagnostic('command_error', { command: request.command, code: 'connection_lost', elapsed_ms: Date.now() - request.started });
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
            if (message.protocol !== 2 || message.history_version !== 1 || typeof message.session !== 'string' || !message.session) {
              disconnected('Помощник использует несовместимый протокол. Обновите файлы проекта.');
              current.disconnect();
              return;
            }
            automaticSources.clear();
            session = message.session;
          } else if (!ready || message.session !== session) return;
          const saved = update('nativeState', () => message, persistHistory);
          const analysisKey = message.analysis ? `${message.analysis.id}:${message.analysis.status}` : '';
          if (lastAnalysis !== analysisKey) {
            lastAnalysis = analysisKey;
            recordDiagnostic('analysis_state', { status: message.analysis?.status || 'cleared' });
          }
          update('host', () => ({ status: 'online', error: null }));
          if (message.type === 'ready') {
            recordDiagnostic('host_ready');
            ready = true; clearTimeout(timeout); saved.then(resolve, reject);
          }
        } else if (message.type === 'reply') {
          const request = pending.get(message.request_id);
          if (!request) return;
          clearTimeout(request.timer); pending.delete(message.request_id);
          recordDiagnostic(message.ok ? 'command_ok' : 'command_error', { command: request.command,
            elapsed_ms: Date.now() - request.started, ...(!message.ok ? { code: diagnosticCode(message.error) } : {}) });
          chain.then(() => {
            if (message.ok) request.resolve(message.result);
            else request.reject(new Error(message.error));
          }, request.reject);
        } else if (message.type === 'error') {
          disconnected(message.error); current.disconnect();
        }
      });
      current.onDisconnect.addListener(() => disconnected(chrome.runtime.lastError?.message));
      current.postMessage({ type: 'session', settings, history: decoded.history.jobs });
    });
  })();
  try { return await connecting; }
  catch (error) {
    recordDiagnostic('host_connect_failed', { code: diagnosticCode(error.message) });
    await update('host', () => ({ status: 'offline', error: hostError(error.message) }));
    throw error;
  }
  finally { connecting = null; }
}
async function command(message) {
  await ensureHost();
  if (message.session && message.session !== session) throw new Error('Сессия загрузок изменилась. Добавьте ссылку заново.');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    recordDiagnostic('command_start', { command: message.command });
    const request_id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(request_id);
      recordDiagnostic('command_error', { command: message.command, code: 'timeout', elapsed_ms: Date.now() - started });
      reject(new Error('Ответ задерживается. Проверьте список загрузок перед повтором.'));
    }, 12000);
    pending.set(request_id, { resolve, reject, timer, started, command: message.command });
    try { port.postMessage({ ...message, session, request_id }); }
    catch (error) {
      clearTimeout(timer); pending.delete(request_id);
      recordDiagnostic('command_error', { command: message.command, code: 'connection_lost', elapsed_ms: Date.now() - started });
      reject(error);
    }
  });
}
async function handle(message) {
  if (message.type === 'diagnostic') { await recordDiagnostic(message.event, message.fields); return {}; }
  if (message.type === 'diagnostics_read') return { version: chrome.runtime.getManifest().version, entries: await readDiagnostics() };
  if (message.type === 'diagnostics_clear') { await clearDiagnostics(); return {}; }
  if (message.type === 'connect') { await ensureHost(); return {}; }
  if (message.type === 'download' || message.type === 'inspect') {
    const item = message.item;
    const request = { command: message.type, urls: [item.url], name: message.title || '',
      page: message.page || '', referer: item.referer || '', headers: item.headers || {},
      source_kind: item.source_kind || 'auto', stream_kind: item.kind || null };
    if (message.type !== 'inspect' || !message.automatic) return command(request);
    // Panels share one inspector. An automatic request must not replace a newer
    // source selected in another panel while this request was waiting.
    if (autoInspectPending) return { skipped: true };
    autoInspectPending = true;
    try {
      await ensureHost();
      await chain;
      const latest = (await chrome.storage.session.get('nativeState')).nativeState;
      const analysis = latest?.analysis;
      const key = JSON.stringify([session, latest?.settings?.youtube_browser, message.tabId, item.url]);
      if (message.session !== session || (analysis?.id || null) !== message.expected_analysis_id
          || ['running', 'cancelling'].includes(analysis?.status) || analysis?.url === item.url || automaticSources.has(key)) return { skipped: true };
      automaticSources.add(key);
      return await command({ ...request, session: message.session });
    } finally { autoInspectPending = false; }
  }
  if (message.type === 'download_selection') {
    return command({ command: 'download', analysis_id: message.analysis_id,
      format_ids: message.format_ids, session: message.session });
  }
  if (message.type === 'inspect_cancel') {
    return command({ command: 'inspect_cancel', analysis_id: message.analysis_id, session: message.session });
  }
  if (['cancel', 'retry', 'clear', 'reveal', 'inspect_history'].includes(message.type)) {
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
  if (message.type === 'page_preview_changed') return;
  handle(message).then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: error.message }));
  return true;
});
if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
