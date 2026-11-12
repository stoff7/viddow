import { groupStreams } from './stream-model.mjs';
import { formatLabel, mainFormats, choiceProblem, durationLabel, qualityLabel, audioLabel, defaultChoice } from './format-model.mjs';
import { decodeHistory, offlineJobs } from './history-model.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag),
  className ? { className } : {}, text === undefined ? {} : { textContent: text });
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const STATUS = { queued: 'В очереди', running: 'Скачиваем', cancelling: 'Останавливаем…', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено', interrupted: 'Прервано' };
let tab = null, tabKey = '', items = [], state = { jobs: [], settings: {} }, online = false;
let filter = 'all', settingsDirty = false, refreshRevision = 0, hostRevision = 0;
let analysisKey = '', dismissedAnalysis = '', inspectPending = false, selectionPending = false;
let currentDownload = null;
let previewRevision = 0;
let pagePreview = null, previewKey = '', autoTimer = null, autoScheduledKey = '';
const automaticSources = new Set();
const choices = new Map(), cards = new Map();
const ownWindow = await chrome.windows.getCurrent();

async function send(message) {
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
}
document.querySelectorAll('[data-view]').forEach((button) => { button.onclick = () => view(button.dataset.view); });
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
  $('inspectPage').disabled = !online || analysing || !validUrl(tab?.url);
  $('inspectLink').disabled = !online || analysing;
  const reason = !online ? 'Подключите локальный помощник, чтобы продолжить.' : analysing ? 'Идёт подготовка. Дождитесь результата или отмените её.' : '';
  $('prepareHint').textContent = reason || (validUrl(tab?.url) ? 'Когда появится видео, подготовим качество и звук автоматически.' : 'Откройте страницу с видео в этой вкладке.');
  $('linkHint').textContent = reason;
  $('cancelAnalysis').disabled = !online || state.analysis?.status !== 'running';
  updateFormatChoice();
}
async function refreshTab() {
  const revision = ++refreshRevision;
  const [current] = await chrome.tabs.query({ active: true, windowId: ownWindow.id });
  const key = current ? `tab_${current.id}` : '';
  const stored = key ? await chrome.storage.session.get(key) : {};
  if (revision !== refreshRevision) return;
  tab = current; tabKey = key; items = stored[key] || [];
  $('tabTitle').textContent = tab?.title || 'Откройте страницу с видео';
  $('tabHost').textContent = hostOf(tab?.url);
  $('page').hidden = !validUrl(tab?.url);
  renderAnalysis(); controls(); renderStreams();
  refreshPreview();
}
function clearPreview() {
  $('pageThumbnail').hidden = true;
  $('pageThumbnail').removeAttribute('src');
  $('pageFacts').hidden = true;
  $('pageFacts').textContent = '';
}
async function refreshPreview() {
  const revision = ++previewRevision, current = tab;
  const key = `${current?.id}:${current?.url}`;
  if (key !== previewKey) { previewKey = key; pagePreview = null; clearPreview(); }
  if (!validUrl(current?.url) || $('currentPage').hidden) return;
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId: current.id, allFrames: true }, files: ['page-preview.js'] });
    if (revision !== previewRevision || current.id !== tab?.id || current.url !== tab?.url) return;
    const page = frames.find(frame => frame.frameId === 0)?.result;
    if (page?.url !== current.url) return;
    pagePreview = { ...page, hasPlayer: frames.some(frame => frame.result?.hasPlayer) };
    const players = frames.filter(frame => frame.result?.hasPlayer);
    // Several players may be unrelated videos/ads. Do not combine their data.
    const preview = players.length === 1 ? players[0].result : { ...page, duration: null, isLive: false };
    if (!players.length) Object.assign(preview, page);
    if (!preview.poster) { $('pageThumbnail').hidden = true; $('pageThumbnail').removeAttribute('src'); }
    if (preview.poster) {
      $('pageThumbnail').src = preview.poster;
      $('pageThumbnail').alt = preview.posterSource === 'player' ? 'Превью из плеера' : 'Изображение со страницы';
      $('pageThumbnail').hidden = false;
    }
    const facts = [];
    if (preview.isLive) facts.push('Прямой эфир по данным плеера');
    else if (preview.duration != null) facts.push(`${durationLabel({ duration: preview.duration })} · ${preview.durationSource === 'player' ? 'По данным плеера' : 'По данным страницы'}`);
    if (preview.poster && preview.posterSource === 'page') facts.push('Изображение со страницы');
    $('pageFacts').textContent = facts.join(' · ');
    $('pageFacts').hidden = !facts.length;
    maybeAutoInspect();
  } catch { /* Restricted/closed tabs can still use preparation and manual links. */ }
}
$('pageThumbnail').onerror = () => { $('pageThumbnail').hidden = true; };
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'page_preview_changed' && sender.tab?.id === tab?.id && !$('currentPage').hidden) refreshPreview();
});
function automaticSource() {
  if (!online || !state.session || !validUrl(tab?.url) || $('currentPage').hidden || inspectPending || selectionPending
      || ['running', 'cancelling'].includes(state.analysis?.status)) return '';
  if (!items.length && !(pagePreview?.hasPlayer || pagePreview?.hasVideoMetadata)) return '';
  const key = JSON.stringify([state.session, state.settings.youtube_browser, tab.id, tab.url]);
  return automaticSources.has(key) ? '' : key;
}
function maybeAutoInspect() {
  const key = automaticSource();
  if (key === autoScheduledKey) return;
  clearTimeout(autoTimer); autoScheduledKey = key;
  if (!key) return;
  autoTimer = setTimeout(() => {
    autoScheduledKey = '';
    if (automaticSource() !== key) return;
    automaticSources.add(key);
    inspect({ url: tab.url, source_kind: 'page' }, tab.title, tab.url, true);
  }, 600);
}
function added(result) {
  currentDownload = { session: state.session, id: result.ids?.[0] };
  notice('Добавлено в очередь.');
  renderCurrentDownload();
}
function renderCurrentDownload() {
  const job = currentDownload && currentDownload.session === state.session && state.jobs.find(job => job.id === currentDownload.id);
  $('currentDownload').hidden = !job;
  if (!job) return;
  $('currentDownloadTitle').textContent = job.name || filenameOf(job.url) || 'Загрузка';
  $('currentDownloadStatus').textContent = [STATUS[job.status], job.error || job.label].filter(Boolean).join(' · ');
  $('currentDownloadProgress').hidden = !ACTIVE.has(job.status);
  if (job.fraction == null) $('currentDownloadProgress').removeAttribute('value');
  else $('currentDownloadProgress').value = Math.max(0, Math.min(1, job.fraction));
}
$('openJobs').onclick = () => view('jobs');
async function start(item, title = '', page = '') {
  added(await send({ type: 'download', item, title, page }));
}
async function inspect(item, title = '', page = '', automatic = false) {
  inspectPending = true; controls(); notice('');
  try {
    const result = await send({ type: 'inspect', item, title, page, automatic, tabId: tab?.id,
      session: state.session, expected_analysis_id: state.analysis?.id || null });
    if (result.skipped) return;
    dismissedAnalysis = ''; renderAnalysis();
    if (!automatic) { view('streams'); $('analysisStatus').focus(); }
  } catch (error) { notice(error.message, true); }
  finally { inspectPending = false; controls(); renderStreams(); }
}
function selectedFormats() {
  const main = state.analysis?.result?.formats.find(format => format.id === $('videoFormat').value);
  const audio = main?.kind === 'video' && !$('silentVideo').checked
    ? [...$('audioFormats').querySelectorAll('input:checked')].map(input => input.value) : [];
  return { main, audio };
}
function updateFormatChoice() {
  const { main, audio } = selectedFormats();
  const problem = choiceProblem(main, audio, state.tools?.ffmpeg, $('silentVideo').checked);
  $('audioChoices').hidden = main?.kind !== 'video';
  $('downloadFormat').disabled = !online || state.analysis?.status !== 'done' || Boolean(problem) || selectionPending;
  $('formatDetails').textContent = main ? [formatLabel(main), ...audio.map(id => formatLabel(state.analysis.result.formats.find(format => format.id === id)))].join('\n') : '';
  $('formatHint').textContent = !online ? 'Подключите локальный помощник, чтобы скачать выбранное.' : problem || (main?.kind === 'combined' ? 'Звук уже встроен в этот формат.' : main?.kind === 'unknown'
    ? 'Состав дорожек не указан источником. Скачается выбранный формат.' : $('silentVideo').checked ? 'Будет сохранено видео без звука.' : main?.kind === 'audio' ? 'Будет сохранён только звук.' : 'Будут сохранены выбранные дорожки.');
}
function renderAnalysis() {
  const analysis = state.analysis;
  const visible = Boolean(analysis && `${state.session}:${analysis.id}` !== dismissedAnalysis);
  const running = ['running', 'cancelling'].includes(analysis?.status);
  const preparingPage = visible && running && analysis.url === tab?.url;
  $('analysisCard').hidden = !visible;
  $('analysisIdentity').hidden = preparingPage;
  $('currentPage').hidden = visible && !preparingPage;
  $('inspectPage').hidden = preparingPage;
  $('prepareHint').hidden = preparingPage;
  $('pageAlternative').hidden = !validUrl(tab?.url) || (visible && analysis.url !== tab?.url);
  if (!analysis) { analysisKey = ''; $('analysisResult').hidden = true; updateFormatChoice(); return; }
  const sourceUrl = new URL(analysis.url);
  $('analysisSource').textContent = sourceUrl.host + decoded(sourceUrl.pathname);
  $('analysisSource').title = sourceUrl.host + decoded(sourceUrl.pathname);
  $('analysisUrl').textContent = analysis.url;
  $('analysisContext').hidden = analysis.url === tab?.url;
  $('cancelAnalysis').hidden = !running;
  $('closeAnalysis').hidden = running;
  $('analysisStatus').textContent = analysis.status === 'running' ? 'Ищем видео и доступные варианты… Скачивание ещё не началось.' : analysis.status === 'cancelling'
    ? 'Останавливаем подготовку…' : analysis.status === 'error' ? analysis.error : analysis.status === 'cancelled' ? 'Подготовка отменена. Можно вернуться к текущей вкладке и попробовать снова.' : analysis.result?.formats?.length ? 'Проверьте качество и звук перед скачиванием.' : 'Источник не передал варианты. Можно скачать без выбора качества.';
  $('analysisStatus').classList.toggle('error', analysis.status === 'error');
  $('analysisDiagnostic').hidden = !analysis.error_detail || analysis.error_detail === analysis.error;
  $('analysisErrorDetail').textContent = analysis.error_detail || '';
  $('analysisResult').hidden = analysis.status !== 'done' || !analysis.result?.formats?.length;
  $('analysisFallback').hidden = running || (analysis.status === 'done' && Boolean(analysis.result?.formats?.length));
  const key = `${state.session}:${analysis.id}:${analysis.status}`;
  if (key !== analysisKey && analysis.status === 'done') {
    const result = analysis.result;
    $('videoTitle').textContent = result.title;
    $('videoTitle').title = result.title;
    $('videoFacts').textContent = durationLabel(result);
    $('videoThumbnail').hidden = !result.thumbnail;
    if (result.thumbnail) $('videoThumbnail').src = result.thumbnail;
    else $('videoThumbnail').removeAttribute('src');
    $('videoThumbnail').onerror = () => { $('videoThumbnail').hidden = true; };
    const defaults = defaultChoice(result.formats, state.tools?.ffmpeg);
    const formats = mainFormats(result.formats);
    const labels = formats.map(qualityLabel);
    $('videoFormat').replaceChildren(...formats.map((format, index) => {
      const label = labels[index];
      const option = el('option', '', labels.filter(value => value === label).length > 1 ? `${label} · ${format.id}` : label);
      option.value = format.id; option.selected = format.id === defaults.main; return option;
    }));
    $('silentVideo').checked = false;
    $('audioFormats').replaceChildren(...result.formats.filter(format => format.kind === 'audio').map(format => {
      const label = el('label', 'audio-option'), input = el('input');
      input.type = 'checkbox'; input.value = format.id; input.checked = defaults.audio.includes(format.id);
      input.onchange = () => { if (input.checked) $('silentVideo').checked = false; updateFormatChoice(); };
      label.append(input, el('span', '', `${audioLabel(format)}${result.formats.filter(item => item.kind === 'audio' && audioLabel(item) === audioLabel(format)).length > 1 ? ` · ${format.id}` : ''}`)); return label;
    }));
  }
  analysisKey = key;
  updateFormatChoice();
}
$('inspectPage').onclick = () => inspect({ url: tab.url, source_kind: 'page' }, tab.title, tab.url);
$('inspectLink').onclick = () => {
  const url = $('manualUrl').value.trim();
  if (!validUrl(url)) { notice('Нужен адрес http:// или https://', true); return; }
  inspect({ url });
};
$('cancelAnalysis').onclick = async () => {
  try { await send({ type: 'inspect_cancel', analysis_id: state.analysis.id, session: state.session }); }
  catch (error) { notice(error.message, true); }
};
$('closeAnalysis').onclick = () => { dismissedAnalysis = `${state.session}:${state.analysis.id}`; renderAnalysis(); refreshPreview(); $('inspectPage').focus(); };
$('chooseStream').onclick = () => { $('streamPicker').open = true; $('streamPicker').querySelector('summary').focus(); $('streamPicker').scrollIntoView({ block: 'start' }); };
$('videoFormat').onchange = () => { $('silentVideo').checked = false; updateFormatChoice(); };
$('silentVideo').onchange = () => {
  if ($('silentVideo').checked) $('audioFormats').querySelectorAll('input').forEach(input => { input.checked = false; });
  updateFormatChoice();
};
$('formatForm').onsubmit = async event => {
  event.preventDefault();
  const { main, audio } = selectedFormats();
  const problem = choiceProblem(main, audio, state.tools?.ffmpeg, $('silentVideo').checked);
  if (problem) { notice(problem, true); return; }
  selectionPending = true; controls();
  try {
    added(await send({ type: 'download_selection', analysis_id: state.analysis.id,
      format_ids: [main.id, ...audio], session: state.session }));
  } catch (error) { notice(error.message, true); }
  finally { selectionPending = false; controls(); }
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
  $('streamCount').textContent = groups.length;
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
    li.append(heading, el('div', 'stream-host', group.host), el('div', 'stream-path', decoded(group.path)), el('p', 'field-note', 'Качество и звук пока неизвестны'), analyse, actions, refresh, details);
    return li;
  }));
  if (focusedUrl) [...$('streams').querySelectorAll('button[data-url]')].find((button) => button.dataset.url === focusedUrl && button.dataset.action === focusedAction)?.focus({ preventScroll: true });
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
  root.append(title, source, format, status, bar, label, diagnostic, actions);
  return { root, title, source, format, status, label, diagnostic, detail, bar, fill, actions, actionKey: '' };
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
  const jobs = state.jobs;
  $('jobCount').textContent = jobs.length;
  const running = jobs.filter((job) => ['running', 'cancelling'].includes(job.status)).length;
  const queued = jobs.filter((job) => job.status === 'queued').length;
  $('queueSummary').textContent = running || queued ? `В работе: ${running} · В очереди: ${queued}` : 'Нет активных загрузок';
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
        await command('inspect_history'); dismissedAnalysis = ''; view('streams');
        notice('Проверяем исходную страницу. Подтвердите формат перед загрузкой.');
      }));
      if (job.status === 'done') {
        if (online && job.file_exists !== false) card.actions.append(action('В Finder', () => command('reveal')));
        if (job.path) card.actions.append(action('Копировать путь', () => copy(job.path)));
      }
    }
  });
  $('jobsEmpty').hidden = visible > 0;
  $('jobsEmpty').querySelector('h3').textContent = jobs.length ? 'В этом фильтре пока нет задач' : 'Здесь будут ваши загрузки';
  renderCurrentDownload(); controls();
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
  $('toolsStatus').textContent = state.tools ? `yt-dlp: ${state.tools.yt_dlp ? 'найден' : 'не найден'}. ffmpeg: ${state.tools.ffmpeg ? 'найден' : 'не найден'}.` : 'Подключите помощник, чтобы проверить инструменты.';
  const wasChoosing = $('currentPage').hidden;
  renderAnalysis(); renderJobs(); renderStreams();
  if (wasChoosing && !$('currentPage').hidden) refreshPreview();
}
function renderHost(host) {
  hostRevision++;
  online = host?.status === 'online';
  $('hostDot').className = `dot ${online ? 'online' : host?.status === 'offline' ? 'offline' : ''}`;
  $('hostStatus').textContent = online ? 'Загрузчик подключён' : host?.status === 'connecting' ? 'Подключаем загрузчик…' : 'Помощник недоступен';
  $('hostError').hidden = !host?.error;
  $('hostError').textContent = host?.error || '';
  $('reconnect').hidden = online || host?.status === 'connecting';
  controls(); renderJobs(); renderStreams();
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
$('page').onclick = async () => {
  const current = tab;
  $('page').dataset.busy = '1'; controls();
  try { await start({ url: current.url, source_kind: 'page' }, current.title, current.url); }
  catch (error) { notice(error.message, true); }
  finally { delete $('page').dataset.busy; controls(); }
};
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
chrome.tabs.onActivated.addListener((info) => { if (info.windowId === ownWindow.id) refreshTab(); });
chrome.tabs.onUpdated.addListener((id, changes) => { if (id === tab?.id && (changes.url || changes.title || changes.status)) refreshTab(); });
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[tabKey]) { items = changes[tabKey].newValue || []; renderStreams(); }
  if (changes.nativeState) renderState(changes.nativeState.newValue);
  if (changes.host) renderHost(changes.host.newValue);
  if (changes.historyStatus) renderHistoryStatus(changes.historyStatus.newValue);
});
const stored = await chrome.storage.session.get(['nativeState', 'host', 'historyStatus']);
const history = decodeHistory(preferences.history);
renderState(stored.nativeState || { jobs: offlineJobs(history.history), settings: preferences.settings || {} }); renderHost(stored.host);
renderHistoryStatus(stored.historyStatus || { warning: history.warning });
await refreshTab();
await connect();
globalThis.viddowPanelReady();
