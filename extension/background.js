import { VideoPreparation } from './preparation.mjs';
import { pageContext } from './page-context.mjs';
import { rememberStream, groupStreams, storedTabGeneration } from './stream-model.mjs';
import { decodeHistory, historyFromJobs } from './history-model.mjs';
import { recordDiagnostic, readDiagnostics, clearDiagnostics, diagnosticCode, setDiagnosticSink } from './diagnostics.mjs';

const HOST = 'local.video_downloader';
const STREAM_TYPE = /mpegurl|dash\+xml/i;
const STREAM_PATH = /\.(m3u8|mpd)$/i;
const SKIP_HEADER = /^(range|accept-encoding|host|connection|content-length|if-.*)$/i;
const sentHeaders = new Map();
const tabGenerations = new Map(), requestGenerations = new Map();
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
    chrome.action.setBadgeText({ tabId, text: items.length ? String(groupStreams(items).length) : '' })).then(items => { preparation.observe(); return items; });
}
chrome.webRequest.onSendHeaders.addListener((details) => {
  if (details.tabId < 0) return;
  sentHeaders.set(details.requestId, Object.fromEntries((details.requestHeaders || [])
    .filter((header) => header.value !== undefined && !SKIP_HEADER.test(header.name))
    .map((header) => [header.name, header.value])));
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onErrorOccurred.addListener((details) => { sentHeaders.delete(details.requestId); requestGenerations.delete(details.requestId); }, { urls: ['<all_urls>'] });
chrome.webRequest.onBeforeRedirect.addListener((details) => sentHeaders.delete(details.requestId), { urls: ['<all_urls>'] });
chrome.webRequest.onHeadersReceived.addListener((details) => {
  const headers = sentHeaders.get(details.requestId);
  sentHeaders.delete(details.requestId);
  const generation = requestGenerations.get(details.requestId);
  requestGenerations.delete(details.requestId);
  if (details.tabId < 0 || !generation || generation !== tabGenerations.get(details.tabId)) return;
  const contentType = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-type')?.value || '';
  const path = new URL(details.url).pathname;
  if (details.statusCode >= 400 || (!STREAM_TYPE.test(contentType) && !STREAM_PATH.test(path))) return;
  const item = { url: details.url, kind: /dash|\.mpd$/i.test(contentType + path) ? 'DASH' : 'HLS',
    referer: details.initiator && /^https?:/.test(details.initiator) ? details.initiator + '/' : '',
    traceId: crypto.randomUUID().replaceAll('-', ''), tabGeneration: generation, frameId: details.frameId, documentId: details.documentId,
    parentFrameId: details.parentFrameId, headers, lastSeen: details.timeStamp || Date.now() };
  updateTab(details.tabId, (items) => generation === tabGenerations.get(details.tabId) ? rememberStream(items, item) : items).then(items => {
    const source = items.find(entry => entry.url === item.url && entry.documentId === item.documentId);
    if (source) recordDiagnostic('stream_seen', { source_tag: source.traceId, document_tag: source.documentId, frame_id: source.frameId, tab_id: details.tabId, kind: source.kind, candidates_count: items.length });
  });
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['responseHeaders']);
// Чистим до запросов нового документа, чтобы поздний ответ навигации не удалял новые потоки.
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0) return;
  if (details.type === 'main_frame' || !tabGenerations.has(details.tabId)) {
    if (preparation.current?.tabId === details.tabId) { preparation.cancel(); preparation.publish(); }
    tabGenerations.set(details.tabId, crypto.randomUUID());
    updateTab(details.tabId, () => []);
  }
  requestGenerations.set(details.requestId, tabGenerations.get(details.tabId));
}, { urls: ['<all_urls>'], types: ['main_frame', 'xmlhttprequest', 'media', 'other'] });
chrome.webRequest.onCompleted.addListener(details => requestGenerations.delete(details.requestId), { urls: ['<all_urls>'] });
chrome.tabs.onRemoved.addListener((tabId) => {
  if (preparation.current?.tabId === tabId) { preparation.cancel(); preparation.publish(); }
  tabGenerations.delete(tabId);
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
            previewRequests.clear();
            preparation.cancel(); preparation.publish();
            session = message.session;
            readDiagnostics().then(entries => entries.forEach(forwardTrace));
          } else if (!ready || message.session !== session) return;
          const saved = update('nativeState', () => message, persistHistory);
          const analysisKey = message.analysis ? `${message.analysis.id}:${message.analysis.status}` : '';
          if (lastAnalysis !== analysisKey) {
            lastAnalysis = analysisKey;
            recordDiagnostic('analysis_state', { status: message.analysis?.status || 'cleared' });
            saved.then(() => preparation.observe());
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
    }, message.command === 'preview' ? 30000 : 12000);
    pending.set(request_id, { resolve, reject, timer, started, command: message.command });
    try { port.postMessage({ ...message, session, request_id }); }
    catch (error) {
      clearTimeout(timer); pending.delete(request_id);
      recordDiagnostic('command_error', { command: message.command, code: 'connection_lost', elapsed_ms: Date.now() - started });
      reject(error);
    }
  });
}
const forwardedTrace = new Set();
function forwardTrace(entry) {
  if (!port || !session) return;
  const key = JSON.stringify(entry);
  if (forwardedTrace.has(key)) return;
  port.postMessage({ type: 'trace', event: entry.event, fields: entry });
  forwardedTrace.add(key);
  while (forwardedTrace.size > 400) forwardedTrace.delete(forwardedTrace.values().next().value);
}
setDiagnosticSink(forwardTrace);
async function tabContext(tabId) {
  if (!tabGenerations.has(tabId)) {
    const stored = (await chrome.storage.session.get(key(tabId)))[key(tabId)] || [];
    // A navigation/request may have initialized the newer epoch while storage
    // was being read. Never overwrite that event with a cached older value.
    if (!tabGenerations.has(tabId)) tabGenerations.set(tabId, storedTabGeneration(stored) || crypto.randomUUID());
  }
  const generation = tabGenerations.get(tabId);
  const context = await pageContext(tabId);
  if (!context || generation !== tabGenerations.get(tabId)) return null;
  return { ...context, tabGeneration: generation };
}
const preparation = new VideoPreparation({
  state: async () => (await chrome.storage.session.get('nativeState')).nativeState,
  context: tabContext,
  trace: recordDiagnostic,
  streams: async tabId => (await chrome.storage.session.get(key(tabId)))[key(tabId)] || [],
  inspect: request => command({ command: 'inspect', ...request }),
  download: request => command({ command: 'download', ...request }),
  cancel: (analysis_id, session) => command({ command: 'inspect_cancel', analysis_id, session }),
  publish: value => chrome.storage.session.set({ preparation: value }),
  downloaded: (current, result) => chrome.storage.session.set({ smartDownload: {
    tabId: current.tabId, session: current.session, ids: result.ids, token: crypto.randomUUID() } }),
});
chrome.tabs.onActivated.addListener(info => preparation.clearIntent(info.tabId));
const previewRequests = new Map();
async function startInspection(request, message, context) {
  preparation.cancel(); await preparation.publish();
  const result = await command(request);
  if (message.item.source_kind === 'page' && context) {
    await preparation.begin({ tabId: message.tabId, page: message.item.url,
      documentToken: context.documentToken, mediaKeys: message.selectedMediaKey ? [message.selectedMediaKey] : context.mediaKeys, selectedMediaKey: message.selectedMediaKey || null, title: message.title || '', session, analysisId: result.analysis_id, download: Boolean(message.downloadAfterPrepare) });
  }
  return result;
}
async function handle(message) {
  if (message.type === 'diagnostic') { await recordDiagnostic(message.event, message.fields); return {}; }
  if (message.type === 'diagnostics_read') return { version: chrome.runtime.getManifest().version, entries: await readDiagnostics() };
  if (message.type === 'diagnostics_clear') { await clearDiagnostics(); return {}; }
  if (message.type === 'connect') { await ensureHost(); return {}; }
  if (message.type === 'preview') {
    const previewKey = JSON.stringify([message.session, message.analysis_id, message.source_id]);
    if (!previewRequests.has(previewKey)) {
      const pendingPreview = command({ command: 'preview', session: message.session,
        analysis_id: message.analysis_id, source_id: message.source_id }).catch(error => { previewRequests.delete(previewKey); throw error; });
      previewRequests.set(previewKey, pendingPreview);
      while (previewRequests.size > 12) previewRequests.delete(previewRequests.keys().next().value);
    }
    return previewRequests.get(previewKey);
  }
  if (message.type === 'download' || message.type === 'inspect') {
    const item = message.item;
    const request = { command: message.type, urls: [item.url], name: message.title || '',
      page: message.page || '', referer: item.referer || '', headers: item.headers || {},
      source_kind: item.source_kind || 'auto', stream_kind: item.kind || null };
    if (message.type !== 'inspect') return command(request);
    let context = null;
    if (item.source_kind === 'page' && Number.isInteger(message.tabId)) {
      const started = Date.now(); recordDiagnostic('page_context_start');
      context = await tabContext(message.tabId);
      recordDiagnostic(context ? 'page_context_ready' : 'page_context_unavailable', { elapsed_ms: Date.now() - started });
    }
    if (context && context.url !== item.url) { if (message.automatic) return { skipped: true }; context = null; }
    if (message.downloadAfterPrepare && context && await preparation.requestDownload({ tabId: message.tabId,
      page: item.url, session: message.session, selectedMediaKey: message.selectedMediaKey || null, documentToken: context.documentToken })) return { pending_download: true };
    if (!message.automatic) return startInspection(request, message, context);
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
      return await startInspection({ ...request, session: message.session }, message, context);
    } finally { autoInspectPending = false; }
  }
  if (message.type === 'download_selection') {
    return command({ command: 'download', analysis_id: message.analysis_id,
      format_ids: message.format_ids, source_id: message.source_id, session: message.session });
  }
  if (message.type === 'inspect_cancel') {
    preparation.cancel(); await preparation.publish();
    return command({ command: 'inspect_cancel', analysis_id: message.analysis_id, session: message.session });
  }
  if (['cancel', 'retry', 'clear', 'reveal', 'inspect_history'].includes(message.type)) {
    if (message.type === 'inspect_history') { preparation.cancel(); await preparation.publish(); }
    return command({ command: message.type, id: message.id, session: message.session });
  }
  if (message.type === 'configure') {
    preparation.cancel(); await preparation.publish();
    const settings = await command({ command: 'configure', settings: message.settings });
    await chrome.storage.local.set({ settings });
    return settings;
  }
  throw new Error('Неизвестная команда');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'page_preview_changed') { preparation.observe(); return; }
  handle(message).then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: error.message }));
  return true;
});
if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
