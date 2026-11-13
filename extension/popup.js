import { MediaCards } from './media-cards.mjs';
import { downloadCards } from './job-cards.mjs';
import { groupStreams } from './stream-model.mjs';
import { visibleMedia, selectMedia } from './media-model.mjs';
import { durationLabel } from './format-model.mjs';
import { decodeHistory, offlineJobs } from './history-model.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag),
  className ? { className } : {}, text === undefined ? {} : { textContent: text });
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const STATUS = { queued: 'В очереди', running: 'Скачиваем', cancelling: 'Останавливаем…', done: 'Скачано', error: 'Ошибка', cancelled: 'Отменено', interrupted: 'Прервано' };
let tab = null, tabKey = '', items = [], state = { jobs: [], settings: {} }, online = false;
let filter = 'all', settingsDirty = false, refreshRevision = 0, hostRevision = 0;
let inspectPending = false, selectionPending = false;
let preparationState = null, analysisOrigin = null, mediaJobs = {};
let completionSession = null, unreadCompleted = 0;
const completedSeen = new Set();
const videoPreviews = new Map(), videoPreviewPending = new Set();
let currentCandidates = [], imageWindowKeys = [], imageScrollTimer;
let previewRevision = 0, selectedMedia = null, previewDocument = null;
let pagePreview = null, previewKey = '', autoTimer = null, autoScheduledKey = '';
const automaticSources = new Set();
const choices = new Map(), cards = new Map();
const ownWindow = await chrome.windows.getCurrent();
let panelStopped = false, previewBusy = false, previewQueued = false, previewTimer = null, lastPreviewAt = 0;
function panelAlive() {
  if (panelStopped) return false;
  try { if (globalThis.chrome?.runtime?.id && chrome.scripting?.executeScript && chrome.tabs?.query) return true; }
  catch { /* Context can disappear synchronously during an extension reload. */ }
  panelStopped = true;
  clearTimeout(previewTimer); clearTimeout(autoTimer); clearTimeout(imageScrollTimer);
  previewRevision++;
  $('clientError').hidden = false;
  $('clientError').textContent = 'Расширение обновлено. Закройте и снова откройте панель.';
  return false;
}

async function send(message) {
  if (!panelAlive()) throw new Error('Откройте панель заново после обновления расширения.');
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Нет ответа от расширения. Перезагрузите его.');
  return response.result;
}
function notice(text, error = false) {
  $('message').hidden = !text;
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function view(name) {
  for (const section of ['streams', 'jobs', 'settings']) $(`${section}View`).hidden = section !== name;
  document.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === name)));
  if (name === 'jobs') { unreadCompleted = 0; renderCompletion(); }
}
document.querySelectorAll('[data-view]').forEach((button) => { button.onclick = () => view(button.dataset.view); });
$('openManual').onclick = () => { view('streams'); $('manualEntry').open = true; $('manualUrl').focus(); };
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme').setAttribute('aria-label', theme === 'dark' ? 'Светлая тема' : 'Тёмная тема');
}
const preferences = await chrome.storage.local.get(['theme', 'settings', 'history']);
setTheme(preferences.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('theme').onclick = async () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(theme);
  await chrome.storage.local.set({ theme });
};
function validUrl(value) {
  try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; }
}
function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }
function youtubePage(url) { try { return /(^|\.)youtube\.com$|^youtu\.be$/.test(new URL(url).hostname); } catch { return false; } }
function filenameOf(url) { try { return decoded(new URL(url).pathname.split('/').pop()); } catch { return ''; } }
function renderHistoryStatus(status) {
  $('historyStatus').textContent = [status?.warning, status?.error].filter(Boolean).join(' ');
  $('historyStatus').hidden = !$('historyStatus').textContent;
  $('historyStatus').classList.toggle('error', Boolean(status?.error));
}
function decoded(value) { try { return decodeURIComponent(value); } catch { return value; } }
function observed(item) {
  return item.lastSeen ? new Date(item.lastSeen).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}
function controls() {
  $('page').disabled = !online || !tab || !validUrl(tab.url) || Boolean($('page').dataset.busy);
  $('addLink').disabled = !online || Boolean($('linkForm').dataset.busy);
  const active = state.jobs.some((job) => ACTIVE.has(job.status));
  $('saveSettings').disabled = !online || active;
  $('settingsHint').textContent = active ? 'Настройки можно изменить, когда активные загрузки завершатся или будут отменены.' : '';
  $('clear').disabled = !online || !state.jobs.some((job) => !ACTIVE.has(job.status));
  const analysing = inspectPending || ['running', 'cancelling'].includes(state.analysis?.status);
  $('inspectPage').disabled = !online || inspectPending || !validUrl(tab?.url);
  $('inspectLink').disabled = !online || analysing;
  const reason = !online ? 'Подключите локальный помощник.' : analysing ? 'Определяем качество…' : '';
  $('prepareHint').textContent = reason;
  $('linkHint').textContent = reason;
  renderMediaCards();
}
async function refreshTab() {
  if (!panelAlive() || !Number.isInteger(ownWindow?.id)) return;
  const revision = ++refreshRevision;
  let current, stored;
  try {
    [current] = await chrome.tabs.query({ active: true, windowId: ownWindow.id });
    stored = current ? await chrome.storage.session.get(`tab_${current.id}`) : {};
  } catch (error) { if (panelAlive()) notice(error.message, true); return; }
  const key = current ? `tab_${current.id}` : '';
  if (revision !== refreshRevision) return;
  const changed = tab?.id !== current?.id || tab?.url !== current?.url;
  tab = current; tabKey = key; items = stored[key] || [];
  if (changed) { previewRevision++; selectedMedia = null; clearPreview(); }
  $('tabTitle').textContent = tab?.title || 'Откройте страницу с видео';
  $('tabHost').textContent = hostOf(tab?.url);
  $('page').hidden = !validUrl(tab?.url);
  renderAnalysis(); controls(); renderStreams();
  refreshPreview();
}
function clearPreview() {
  currentCandidates = [];
  renderStreamImages(); renderMediaCards();
}
function refreshPreview() {
  if (!panelAlive()) return;
  previewQueued = true;
  if (previewBusy || previewTimer || document.hidden) return;
  previewTimer = setTimeout(async () => {
    previewTimer = null;
    if (!panelAlive() || document.hidden) return;
    previewQueued = false; previewBusy = true; lastPreviewAt = Date.now();
    try { await collectPreview(); }
    finally { previewBusy = false; if (previewQueued) refreshPreview(); }
  }, Math.max(0, 300 - (Date.now() - lastPreviewAt)));
}
async function collectPreview() {
  const revision = ++previewRevision, current = tab;
  const key = `${current?.id}:${current?.url}`;
  if (key !== previewKey) { imageWindowKeys = []; previewKey = key; pagePreview = null; selectedMedia = null; previewDocument = null; clearPreview(); }
  if (!validUrl(current?.url)) { renderMediaCards(); return; }
  try {
    const target = { tabId: current.id, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['page-preview.js'] });
    const frames = await chrome.scripting.executeScript({ target, func: () => globalThis.__viddowReadPreview?.() });
    const initial = visibleMedia(current.id, frames);
    const initialChoice = selectMedia(initial, selectedMedia);
    // Bound transient images across the tab, and always include the selected video.
    const imageRequests = {};
    const inView = initial.filter(media => imageWindowKeys.includes(media.key));
    const imageWindow = [...new Map([...inView, ...initial].map(media => [media.key, media])).values()].slice(0, 6);
    for (const media of [...(initialChoice ? [initialChoice] : []), ...imageWindow]) {
      (imageRequests[media.documentToken] ||= []).push(media.id);
    }
    const latest = await chrome.scripting.executeScript({ target, func: requests => globalThis.__viddowReadPreview?.(true, requests), args: [imageRequests] });
    if (revision !== previewRevision || current.id !== tab?.id || current.url !== tab?.url) return;
    const page = frames.find(frame => frame.frameId === 0)?.result;
    if (page?.url !== current.url || !latest.some(frame => frame.frameId === 0 && frame.result?.documentToken === page.documentToken)) return;
    if (previewDocument && previewDocument !== page.documentToken) selectedMedia = null;
    previewDocument = page.documentToken;
    const candidates = visibleMedia(current.id, frames, latest);
    currentCandidates = candidates;
    const chosen = selectMedia(candidates, selectedMedia);
    if (chosen && selectedMedia?.url) selectedMedia = { key: chosen.key };
    pagePreview = { ...page, hasPlayer: candidates.length > 0 };
    renderMediaCards(); renderStreamImages();
    maybeAutoInspect();
  } catch { /* Restricted/closed documents keep explicit source selection and manual links usable. */ }
}
function renderStreamImages() {
  for (const card of $('streams').children) {
    const [url, frameId, documentId] = JSON.parse(card.dataset.sourceKey);
    const media = selectMedia(currentCandidates, { url, frameId, documentId });
    const image = media?.frameImage || media?.poster;
    const img = card.querySelector('.stream-thumbnail');
    img.hidden = !image; img.nextElementSibling.hidden = Boolean(image);
    if (image) { if (img.getAttribute('src') !== image) img.src = image; }
    else img.removeAttribute('src');
  }
}
document.addEventListener('scroll', () => {
  const bounds = $('mediaList').getBoundingClientRect();
  const keys = [...$('mediaList').children].filter(node => { const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight && rect.top < bounds.bottom; }).map(node => node.dataset.mediaKey).filter(Boolean);
  if (JSON.stringify(keys) === JSON.stringify(imageWindowKeys)) return;
  imageWindowKeys = keys; clearTimeout(imageScrollTimer);
  imageScrollTimer = setTimeout(() => refreshPreview(), 120);
}, { passive: true });
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'page_preview_changed' && sender?.tab?.id === tab?.id) refreshPreview();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && previewQueued) refreshPreview(); });
function automaticSource() {
  if (!online || !state.session || !validUrl(tab?.url) || inspectPending || selectionPending
      || ['running', 'cancelling'].includes(state.analysis?.status)) return '';
  if (!items.length && !(pagePreview?.hasPlayer || pagePreview?.hasVideoMetadata)) return '';
  if (currentCandidates.length > 1 && !selectMedia(currentCandidates, selectedMedia)) return '';
  const key = JSON.stringify([state.session, state.settings.youtube_browser, tab.id, tab.url]);
  return automaticSources.has(key) ? '' : key;
}
function maybeAutoInspect() {
  if (!panelAlive()) return;
  const key = automaticSource();
  if (key === autoScheduledKey) return;
  clearTimeout(autoTimer); autoScheduledKey = key;
  if (!key) return;
  autoTimer = setTimeout(async () => {
    autoScheduledKey = '';
    if (automaticSource() !== key) return;
    const scheduledTab = tab?.id, scheduledPage = tab?.url;
    const chosen = selectMedia(currentCandidates, selectedMedia);
    if (chosen && selectedMedia?.key !== chosen.key) {
      try { await choosePlayer(chosen.key); } catch (error) { notice(error.message, true); return; }
    }
    if (tab?.id !== scheduledTab || tab?.url !== scheduledPage || automaticSource() !== key) return;
    automaticSources.add(key);
    inspect({ url: tab.url, source_kind: 'page' }, tab.title, tab.url, true);
  }, 600);
}
function added() { renderMediaCards(); }
function renderCompletion() {
  if (completionSession !== state.session) { completionSession = state.session; completedSeen.clear(); unreadCompleted = 0; }
  const fresh = state.jobs.filter(job => job.status === 'done' && !job.restored && !completedSeen.has(job.id));
  for (const job of fresh) completedSeen.add(job.id);
  if (fresh.length) {
    if ($('jobsView').hidden) unreadCompleted += fresh.length;
    $('completionLive').textContent = fresh.map(job => `Скачано: ${job.path?.split(/[\\/]/).pop() || job.name || 'Видео'}`).join('. ');
  }
  $('completedCount').hidden = !unreadCompleted;
  $('completedCount').textContent = unreadCompleted ? `✓ ${unreadCompleted}` : '';
  $('completedCount').setAttribute('aria-label', `Новых завершённых загрузок: ${unreadCompleted}`);
}
const mediaCards = new MediaCards($('mediaList'), {
  error: text => notice(text, true), queue: () => view('jobs'),
  announce: text => { $('completionLive').textContent = text; },
  direct: async row => {
    const url = validUrl(row.url) ? row.url : row.prepareUrl;
    const item = items.find(item => item.url === url) || { url, source_kind: row.pageSource || url !== row.url ? 'page' : 'auto' };
    const result = await send({ type: 'download', item, title: row.title, page: row.page,
      cardOrigin: { cardKey: row.key, mediaKey: row.mediaKey, tabId: tab?.id, tabPage: tab?.url,
        page: row.page, documentToken: previewDocument, title: row.title }, session: row.session });
    added(result);
  },
  prepare: async (row, download) => {
    if (inspectPending || selectionPending) return;
    const tabId = tab?.id, page = tab?.url;
    selectionPending = true; controls();
    try {
      if (row.mediaKey) await choosePlayer(row.mediaKey);
      if (tab?.id !== tabId || tab?.url !== page) return;
      if (row.mediaKey && !currentCandidates.some(media => media.key === row.mediaKey)) return;
      const url = row.prepareUrl || row.url;
      const item = !row.mediaKey && !row.pageSource && items.find(item => item.url === url);
      await inspect(item || { url, source_kind: row.mediaKey || row.pageSource ? 'page' : 'auto' },
        row.title, row.page, false, download);
    } finally { selectionPending = false; controls(); }
  },
  cancel: row => send({ type: 'inspect_cancel', analysis_id: row.analysisId, session: row.session }),
  download: async (row, ids) => {
    selectionPending = true; controls();
    try {
      added(await send({ type: 'download_selection', analysis_id: row.analysisId, source_id: row.result.source_id || row.result.id,
        format_ids: ids, session: row.session, cardOrigin: { cardKey: row.key, mediaKey: row.mediaKey,
          tabId: tab?.id, page: row.page, tabPage: tab?.url, documentToken: previewDocument, title: row.title } }));
    } finally { selectionPending = false; controls(); }
  },
  job: (type, job, session) => send({ type, id: job.id, session }),
});
function renderMediaCards() {
  const analysis = state.analysis;
  const prep = preparationState && preparationState.session === state.session && preparationState.tabId === tab?.id
    && preparationState.page === tab?.url ? preparationState : null;
  const origin = prep && prep.analysisId === analysis?.id ? {
    ...analysisOrigin, session: prep.session, analysisId: prep.analysisId, tabId: prep.tabId, page: prep.page, tabPage: prep.page, sourceKind: 'page',
    mediaKey: prep.selectedMediaKey,
    cardKey: prep.selectedMediaKey || JSON.stringify(['page', prep.tabId, prep.page, prep.documentToken]),
  } : analysisOrigin;
  const belongs = Boolean(analysis && origin?.session === state.session && origin.analysisId === analysis.id && origin.tabId === tab?.id
    && (origin.tabPage || origin.page) === tab?.url && (!origin.mediaKey || currentCandidates.some(media => media.key === origin.mediaKey)));
  const rows = currentCandidates.map((media, index) => ({ key: media.key, mediaKey: media.key,
    selected: media.key === (selectedMedia?.key || prep?.selectedMediaKey),
    title: `Видео ${index + 1}`, image: media.frameImage || media.poster || '',
    duration: media.isLive ? 'Прямой эфир' : media.duration != null ? durationLabel(media) : '',
    url: media.src || tab.url, prepareUrl: tab.url, page: tab.url, jobs: [], session: state.session }));
  const owner = belongs && rows.find(row => row.key === origin.cardKey);
  const preparing = belongs && (['running', 'cancelling'].includes(analysis?.status)
    || ['waiting', 'recovering'].includes(prep?.phase));
  let sourceRows = [];
  if (belongs) {
    const result = analysis?.result;
    const videos = analysis?.status === 'done' && prep?.phase !== 'cancelled' && result?.formats?.length
      ? result.videos?.length ? result.videos : [result] : [];
    sourceRows = videos.map(video => {
      // The selected-player preparation already enforces its source boundary.
      // Batch members remain separate: their source_id cannot be collapsed into a player.
      const key = videos.length > 1 && (video.id || video.source_id) !== result.source_id
        ? `${origin.cardKey}:source:${video.id || video.source_id}` : origin.cardKey;
      const row = rows.find(item => item.key === key) || { key, title: origin.title || 'Видео', jobs: [], session: state.session };
      const cacheKey = `${state.session}:${analysis.id}:${video.id || video.source_id}`;
      Object.assign(row, { result: video, analysisId: analysis.id, title: video.title || row.title,
        image: videoPreviews.get(cacheKey) || row.image || video.thumbnail || '',
        duration: durationLabel(video), url: video.source_url || analysis.url, prepareUrl: origin.url || origin.page,
        page: origin.page, pageSource: origin.sourceKind === 'page',
        mediaKey: origin.mediaKey || null, pending: Boolean(prep?.downloadPending), preparing: Boolean(prep?.downloadPending) });
      if (!rows.includes(row)) rows.push(row);
      return row;
    });
    if (!sourceRows.length) {
      const row = owner || { key: origin.cardKey, title: origin.title || tab?.title || 'Видео',
        url: origin.url || analysis.url, prepareUrl: origin.url || origin.page, page: origin.page,
        pageSource: origin.sourceKind === 'page', jobs: [], session: state.session };
      Object.assign(row, { analysisId: analysis.id, preparing, pending: Boolean(prep?.downloadPending),
        error: prep?.error || (analysis.status === 'error' && !preparing ? analysis.error : ''), errorDetail: analysis.error_detail,
        note: prep?.phase === 'cancelled' || analysis.status === 'cancelled' ? 'Подготовка отменена' : '' });
      if (!rows.includes(row)) rows.push(row);
    }
    requestCardPreviews(videos, analysis);
  }
  const bindings = mediaJobs?.session === state.session ? mediaJobs.jobs || {} : {};
  const allJobs = downloadCards(state.jobs);
  for (const job of allJobs) {
    const binding = bindings[job.id];
    if (!binding || binding.tabId !== tab?.id || (binding.tabPage || binding.page) !== tab?.url) continue;
    if (binding.mediaKey && !currentCandidates.some(media => media.key === binding.mediaKey)) continue;
    if (!binding.mediaKey && binding.documentToken && binding.documentToken !== previewDocument) continue;
    if (!rows.some(row => row.key === binding.cardKey)) rows.push({ key: binding.cardKey, mediaKey: binding.mediaKey,
      title: job.name || binding.title || 'Видео', url: job.url, prepareUrl: binding.page, page: binding.page,
      pageSource: true, session: state.session, jobs: [] });
  }
  for (const row of rows) row.jobs = allJobs.filter(job => bindings[job.id]?.cardKey === row.key);
  const count = mediaCards.render(rows, { online, ffmpeg: state.tools?.ffmpeg, inspectPending: inspectPending || selectionPending });
  for (const [key, card] of mediaCards.cards) card.root.dataset.mediaKey = rows.find(row => row.key === key)?.mediaKey || '';
  $('mediaEmpty').hidden = count > 0;
  $('streamCount').textContent = count;
  $('pageAlternative').hidden = !validUrl(tab?.url);
}
function requestCardPreviews(videos, analysis) {
  // Keep the existing native preview cache and six-source preparation bound.
  for (const video of videos.slice(0, 6)) {
    const sourceId = video.id || video.source_id;
    if (!analysis.result?.videos?.length || !sourceId) continue;
    const session = state.session, key = `${session}:${analysis.id}:${sourceId}`;
    if (videoPreviews.has(key) || videoPreviewPending.has(key)) continue;
    videoPreviewPending.add(key);
    (async () => {
      try {
        const reply = await send({ type: 'preview', session, analysis_id: analysis.id, source_id: sourceId });
        if (session !== state.session || analysis.id !== state.analysis?.id || reply.source_id !== sourceId) return;
        videoPreviews.set(key, /^data:image\/gif;base64,[A-Za-z0-9+/=]+$/.test(reply.image || '') && reply.image.length <= 128 * 1024 ? reply.image : null);
      } catch { videoPreviews.set(key, null); }
      finally {
        videoPreviewPending.delete(key);
        while (videoPreviews.size > 12) videoPreviews.delete(videoPreviews.keys().next().value);
        if (session === state.session && analysis.id === state.analysis?.id) renderMediaCards();
      }
    })();
  }
}
async function start(item, title = '', page = '') {
  try { added(await send({ type: 'download', item, title, page })); view('jobs'); }
  catch (error) { notice(error.message, true); }
}
async function inspect(item, title = '', page = '', automatic = false, downloadAfterPrepare = false) {
  if (!automatic && item.kind) { selectedMedia = { url: item.url, frameId: item.frameId, documentId: item.documentId }; clearPreview(); refreshPreview(); }
  inspectPending = true; controls(); notice('');
  const selectedAtStart = selectedMedia?.key || null;
  try {
    const result = await send({ type: 'inspect', item, title, page, tabPage: tab?.url, automatic, downloadAfterPrepare, selectedMediaKey: item.source_kind === 'page' && item.url === tab?.url ? selectedMedia?.key || null : null, tabId: tab?.id,
      session: state.session, expected_analysis_id: state.analysis?.id || null });
    if (result.skipped) return;
    if ((selectedMedia?.key || null) !== selectedAtStart) return;
    renderAnalysis();
    if (!automatic) view('streams');
  } catch (error) { notice(error.message, true); }
  finally { inspectPending = false; controls(); renderStreams(); }
}
async function choosePlayer(key) {
  selectedMedia = { key };
  await send({ type: 'player_selection', tabId: tab?.id, key });
  renderMediaCards();
}
function renderAnalysis() { renderMediaCards(); }
$('inspectPage').onclick = () => { if (tab && validUrl(tab.url)) inspect({ url: tab.url, source_kind: 'page' }, tab.title, tab.url, false, true); };
$('inspectLink').onclick = () => {
  const url = $('manualUrl').value.trim();
  if (!validUrl(url)) { notice('Нужен адрес http:// или https://', true); return; }
  inspect({ url });
};
async function copy(text) {
  await navigator.clipboard.writeText(text);
  notice('Скопировано');
}
function renderStreams() {
  const groups = groupStreams(items);
  const open = new Set([...$('streams').querySelectorAll('details[open]')].map((node) => node.dataset.key));
  const focusedUrl = document.activeElement?.dataset?.url;
  const focusedAction = document.activeElement?.dataset?.action;
  $('foundCount').textContent = groups.length ? `(${groups.length})` : '';
  $('addressCount').textContent = items.length ? `Адресов: ${items.length}` : '';
  $('streamsEmpty').hidden = Boolean(groups.length);
  $('streams').replaceChildren(...groups.map((group, index) => {
    const chosen = choices.get(group.key);
    const item = group.items.find((entry) => entry.url === chosen) || group.items[0];
    const li = el('li', 'stream-card');
    const heading = el('div', 'stream-heading');
    heading.append(el('span', 'stream-name', `Поток ${index + 1}`));
    const path = el('div', 'stream-path', decoded(group.path));
    path.title = decoded(group.path);
    const button = el('button', 'text-button', 'Скачать без выбора качества');
    button.dataset.url = item.url; button.dataset.action = 'download';
    const active = state.jobs.find((job) => job.url === item.url && ACTIVE.has(job.status));
    button.disabled = !online || Boolean(active);
    if (active) button.textContent = STATUS[active.status];
    button.onclick = async () => {
      button.disabled = true;
      try { await start(item, tab?.title, tab?.url); }
      catch (error) { notice(error.message, true); button.disabled = !online; }
    };
    const actions = el('div', 'stream-actions');
    actions.append(button);
    const analyse = el('button', 'button wide', 'Подготовить поток');
    analyse.dataset.url = item.url; analyse.dataset.action = 'inspect';
    analyse.disabled = !online || inspectPending || ['running', 'cancelling'].includes(state.analysis?.status);
    analyse.onclick = () => inspect(item, tab?.title, tab?.url);
    const refresh = el('button', 'text-button', 'Обновить ссылку');
    refresh.hidden = !youtubePage(tab?.url);
    refresh.disabled = analyse.disabled;
    refresh.title = 'Заново получить форматы со страницы YouTube. Выберите формат перед скачиванием.';
    refresh.onclick = () => inspect({ url: tab.url, source_kind: 'page' }, tab.title, tab.url);
    const details = el('details', 'stream-detail');
    details.dataset.key = group.key;
    details.open = open.has(group.key);
    details.append(el('summary', '', group.items.length > 1 ? `Адреса и варианты · ${group.items.length}` : 'Полный адрес'));
    if (group.items.length > 1) {
      const select = el('select');
      select.setAttribute('aria-label', `Адрес потока ${decoded(group.path)}`);
      group.items.forEach((entry, index) => {
        const option = el('option', '', `${index === 0 ? 'Последний обнаруженный' : `Адрес ${index + 1}`} ${observed(entry)}`);
        option.value = entry.url; option.selected = entry.url === item.url;
        select.append(option);
      });
      select.onchange = () => { choices.set(group.key, select.value); renderStreams(); };
      details.append(select);
    }
    const fullUrl = el('code', '', item.url);
    const copyButton = el('button', 'text-button', 'Копировать адрес');
    copyButton.onclick = () => copy(item.url).catch(() => notice('Не удалось скопировать. Выделите полный адрес вручную.', true));
    details.append(fullUrl, copyButton);
    details.insertBefore(path, details.children[1]);
    details.insertBefore(el('div', 'stream-observed', [group.kind, observed(item) ? `Замечен в ${observed(item)}` : ''].filter(Boolean).join(' · ')), path);
    const image = el('img', 'stream-thumbnail'); image.alt = 'Изображение выбранного потока'; image.referrerPolicy = 'no-referrer';
    const missingImage = el('p', 'field-note', 'Картинка потока пока не подтверждена');
    image.onerror = () => { image.hidden = true; missingImage.hidden = false; };
    li.dataset.sourceKey = JSON.stringify([item.url, item.frameId, item.documentId]);
    li.append(image, missingImage, heading, el('div', 'stream-host', group.host), el('div', 'stream-path', decoded(group.path)), el('p', 'field-note', 'Качество и звук пока неизвестны'), analyse, actions, refresh, details);
    return li;
  }));
  if (focusedUrl) [...$('streams').querySelectorAll('button[data-url]')].find((button) => button.dataset.url === focusedUrl && button.dataset.action === focusedAction)?.focus({ preventScroll: true });
  renderStreamImages();
  maybeAutoInspect();
}
function makeJob(job) {
  const root = el('li', 'job'); root.dataset.id = job.id;
  const title = el('div', 'job-title'), source = el('div', 'job-source');
  const status = el('div', 'job-status'), label = el('div', 'job-label'), format = el('div', 'job-format');
  const diagnostic = el('details', 'explanation'), detail = el('code');
  diagnostic.append(el('summary', '', 'Техническая причина'), detail);
  diagnostic.hidden = true;
  const bar = el('div', 'bar'), fill = el('span'); bar.append(fill);
  bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
  const actions = el('div', 'job-actions');
  const attempts = el('details', 'explanation job-attempts'), attemptSummary = el('summary'), attemptList = el('ol');
  attempts.append(attemptSummary, attemptList); attempts.hidden = true;
  root.append(title, source, format, status, bar, label, diagnostic, attempts, actions);
  return { root, title, source, format, status, label, diagnostic, detail, bar, fill, actions, attempts, attemptSummary, attemptList, attemptKey: '', actionKey: '' };
}
function action(text, callback) {
  const button = el('button', 'text-button', text);
  button.onclick = async () => {
    button.disabled = true;
    try { await callback(); } catch (error) { notice(error.message, true); }
    finally { button.disabled = false; }
  };
  return button;
}
function renderJobs() {
  const jobs = downloadCards(state.jobs);
  $('jobCount').textContent = jobs.length;
  const running = jobs.filter((job) => ['running', 'cancelling'].includes(job.status)).length;
  const queued = jobs.filter((job) => job.status === 'queued').length;
  const completed = jobs.filter(job => job.status === 'done').length;
  const errors = jobs.filter(job => job.status === 'error').length;
  $('queueSummary').textContent = running || queued ? `В работе: ${running} · В очереди: ${queued}`
    : completed ? `Скачано: ${completed}${errors ? ` · Ошибки: ${errors}` : ''}` : 'Нет активных загрузок';
  $('workerCount').textContent = state.settings.workers ? `Лимит: ${state.settings.workers}` : '';
  const existing = new Set(jobs.map((job) => job.id));
  for (const [id, card] of cards) if (!existing.has(id)) { card.root.remove(); cards.delete(id); }
  let visible = 0;
  [...jobs].reverse().forEach((job, index) => {
    let card = cards.get(job.id);
    if (!card) { card = makeJob(job); cards.set(job.id, card); }
    if ($('jobs').children[index] !== card.root) $('jobs').insertBefore(card.root, $('jobs').children[index] || null);
    card.root.className = `job ${job.status}`;
    card.root.hidden = filter === 'active' ? !ACTIVE.has(job.status) : filter === 'done' && job.status !== 'done';
    if (!card.root.hidden) visible++;
    card.title.textContent = job.path ? job.path.split(/[\\/]/).pop() : job.name || filenameOf(job.url) || hostOf(job.url) || 'Видео';
    card.title.title = job.path || job.url;
    card.source.textContent = [hostOf(job.url), job.restored && job.created_at ? new Date(job.created_at).toLocaleString('ru') : ''].filter(Boolean).join(' · ');
    card.format.hidden = !job.format_ids?.length && !job.format_label;
    card.format.textContent = job.format_label || job.format_ids?.length ? `Выбрано: ${job.format_label || job.format_ids.join(' + ')}` : '';
    const percent = job.fraction == null ? null : Math.round(Math.max(0, Math.min(1, job.fraction)) * 100);
    card.status.textContent = STATUS[job.status] + (job.status === 'running' && percent !== null ? ` · ${percent}%` : '')
      + (job.status === 'done' && job.file_exists === false ? ' · файл не найден' : '');
    card.label.textContent = job.error || (ACTIVE.has(job.status) ? job.label : job.restored
      ? job.page_retry ? 'Для повтора получим свежие форматы со страницы. Загрузку нужно подтвердить.' : 'Ссылка загрузки не сохранена. Для повтора вставьте свежую ссылку.' : '');
    card.diagnostic.hidden = !job.error_detail || job.error_detail === job.error;
    card.detail.textContent = job.error_detail || '';
    card.attempts.hidden = !job.attempt_errors.length;
    card.attemptSummary.textContent = `Ошибки попытки · ${job.attempt_errors.length}`;
    const attemptKey = `${state.session}:${job.attempt_errors.map(row => row.id).join(',')}`;
    const renderAttemptErrors = () => {
      if (!card.attempts.open || card.attemptKey === attemptKey) return;
      card.attemptList.replaceChildren(...job.attempt_errors.map(row => {
        const item = el('li');
        item.append(el('p', '', `${row.created_at ? new Date(row.created_at).toLocaleString('ru') : `Задание ${row.id}`} · ${row.error || 'Не удалось скачать'}`));
        if (row.error_detail && row.error_detail !== row.error) item.append(el('code', '', row.error_detail));
        return item;
      }));
      card.attemptKey = attemptKey;
    };
    card.attempts.ontoggle = renderAttemptErrors;
    renderAttemptErrors();
    card.bar.hidden = !['running', 'cancelling'].includes(job.status);
    card.bar.classList.toggle('indeterminate', percent === null);
    card.bar.setAttribute('aria-label', `Скачивание ${card.title.textContent}`);
    if (percent === null) card.bar.removeAttribute('aria-valuenow');
    else card.bar.setAttribute('aria-valuenow', percent);
    card.fill.style.width = percent === null ? '' : `${percent}%`;
    const actionKey = `${state.session}:${job.status}:${online}:${job.path || ''}:${job.file_exists}:${job.restored}:${job.page_retry}:${job.error_code}`;
    if (card.actionKey !== actionKey) {
      card.actionKey = actionKey;
      card.actions.replaceChildren();
      const command = (type) => send({ type, id: job.id, session: state.session });
      if (online && ['queued', 'running'].includes(job.status)) card.actions.append(action('Отменить', () => command('cancel')));
      if (online && !job.restored && ['error', 'cancelled'].includes(job.status)) card.actions.append(action('Повторить', () => command('retry')));
      if (job.status === 'error' && job.error_code === 'authentication_required' && (youtubePage(job.url) || youtubePage(job.page))) {
        card.actions.append(action('Сеанс YouTube', async () => { view('settings'); $('youtubeBrowser').focus(); }));
      }
      if (online && ['error', 'cancelled'].includes(job.status) && !job.restored && validUrl(job.page)) {
        card.actions.append(action('Обновить ссылку', () => inspect({ url: job.page, source_kind: 'page' }, job.name || '', job.page)));
      }
      if (online && job.restored && job.page_retry) card.actions.append(action('Повторить со страницы', async () => {
        await send({ type: 'inspect_history', id: job.id, session: state.session, tabId: tab?.id, tabPage: tab?.url }); view('streams');
        notice('Проверяем исходную страницу. Подтвердите формат перед загрузкой.');
      }));
      if (job.status === 'done') {
        if (online && job.path && job.file_exists !== false) card.actions.append(action('Показать файл', () => command('reveal')));
        if (job.path) card.actions.append(action('Копировать путь', () => copy(job.path)));
      }
    }
  });
  $('jobsEmpty').hidden = visible > 0;
  $('jobsEmpty').querySelector('h3').textContent = jobs.length ? 'В этом фильтре пока нет задач' : 'Здесь будут ваши загрузки';
  controls();
}
function renderState(next) {
  state = next || { jobs: [], settings: {} };
  if (!settingsDirty) {
    $('outputDir').value = state.settings.output_dir || preferences.settings?.output_dir || '';
    $('workers').value = String(state.settings.workers || preferences.settings?.workers || 2);
    $('youtubeBrowser').value = state.settings.youtube_browser || preferences.settings?.youtube_browser || 'none';
  }
  const folder = state.settings.output_dir || '~/Downloads';
  $('folderLabel').textContent = folder.endsWith('/Downloads') ? 'Загрузки' : folder.split('/').filter(Boolean).pop();
  $('folderLabel').title = folder;
  $('toolsStatus').textContent = state.tools ? `Расширение ${chrome.runtime.getManifest().version}; помощник ${state.build?.version || 'версия неизвестна'}. yt-dlp: ${state.tools.yt_dlp ? 'найден' : 'не найден'}. ffmpeg: ${state.tools.ffmpeg ? 'найден' : 'не найден'}.` : 'Подключите помощник, чтобы проверить инструменты.';
  renderAnalysis(); renderJobs(); renderStreams(); renderCompletion();
}
function renderHost(host) {
  hostRevision++;
  online = host?.status === 'online';
  $('hostDot').className = `dot ${online ? 'online' : host?.status === 'offline' ? 'offline' : ''}`;
  $('hostStatus').textContent = online ? 'Подключён' : host?.status === 'connecting' ? 'Подключаем…' : 'Нет подключения';
  $('hostError').hidden = !host?.error;
  $('hostError').textContent = host?.error || '';
  $('reconnect').hidden = online || host?.status === 'connecting';
  controls(); renderJobs(); renderStreams(); renderCompletion();
}
async function connect() {
  renderHost({ status: 'connecting' });
  try {
    await send({ type: 'connect' });
    const revision = hostRevision;
    const storedHost = (await chrome.storage.session.get('host')).host;
    // Событие storage новее запроса чтения и не должно затираться его ответом.
    if (revision === hostRevision) renderHost(storedHost);
  }
  catch (error) { renderHost({ status: 'offline', error: error.message }); }
}
$('reconnect').onclick = connect;
$('page').onclick = () => { if (tab && validUrl(tab.url)) start({ url: tab.url, source_kind: 'page' }, tab.title, tab.url); };
$('linkForm').onsubmit = async (event) => {
  event.preventDefault();
  const url = $('manualUrl').value.trim();
  if (!validUrl(url)) { notice('Нужен адрес http:// или https://', true); return; }
  $('linkForm').dataset.busy = '1'; controls();
  try { await start({ url }); if ($('manualUrl').value.trim() === url) $('manualUrl').value = ''; }
  catch (error) { notice(error.message, true); }
  finally { delete $('linkForm').dataset.busy; controls(); }
};
$('clear').onclick = async () => {
  try { await send({ type: 'clear', session: state.session }); notice('Завершённые записи очищены. Файлы сохранены.'); }
  catch (error) { notice(error.message, true); }
};
$('settingsForm').oninput = () => { settingsDirty = true; };
$('settingsForm').onsubmit = async (event) => {
  event.preventDefault();
  $('saveSettings').disabled = true;
  try {
    const settings = await send({ type: 'configure', settings: { workers: Number($('workers').value), output_dir: $('outputDir').value.trim(), youtube_browser: $('youtubeBrowser').value } });
    settingsDirty = false;
    renderState({ ...state, settings });
    notice('Настройки сохранены');
  } catch (error) { notice(error.message, true); }
  finally { controls(); }
};
document.querySelectorAll('[data-filter]').forEach((button) => {
  button.onclick = () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((entry) => entry.setAttribute('aria-pressed', String(entry === button)));
    renderJobs();
  };
});
chrome.tabs.onActivated.addListener((info) => { if (info.windowId === ownWindow?.id) refreshTab(); });
chrome.tabs.onUpdated.addListener((id, changes) => { if (id === tab?.id && (changes.url || changes.title || changes.status)) refreshTab(); });
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[tabKey]) { items = changes[tabKey].newValue || []; renderStreams(); }
  if (changes.mediaJobs) { mediaJobs = changes.mediaJobs.newValue || {}; renderMediaCards(); }
  if (changes.analysisOrigin) { analysisOrigin = changes.analysisOrigin.newValue; renderMediaCards(); }
  if (changes.preparation) { preparationState = changes.preparation.newValue; renderAnalysis(); controls(); }
  if (changes.smartDownload) { const result = changes.smartDownload.newValue; if (result && tab && result.tabId === tab.id && result.session === state.session) added(result); }
  if (changes.nativeState) renderState(changes.nativeState.newValue);
  if (changes.host) renderHost(changes.host.newValue);
  if (changes.historyStatus) renderHistoryStatus(changes.historyStatus.newValue);
});
const stored = await chrome.storage.session.get(['nativeState', 'host', 'historyStatus', 'preparation', 'mediaJobs', 'analysisOrigin']);
preparationState = stored.preparation; mediaJobs = stored.mediaJobs || {}; analysisOrigin = stored.analysisOrigin;
const history = decodeHistory(preferences.history);
renderState(stored.nativeState || { jobs: offlineJobs(history.history), settings: preferences.settings || {} }); renderHost(stored.host);
renderHistoryStatus(stored.historyStatus || { warning: history.warning });
await refreshTab();
await connect();
globalThis.viddowPanelReady();
