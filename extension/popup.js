import { groupStreams } from './stream-model.mjs';
import { formatLabel, mainFormats, choiceProblem, durationLabel } from './format-model.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag),
  className ? { className } : {}, text === undefined ? {} : { textContent: text });
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const STATUS = { queued: 'В очереди', running: 'Скачиваем', cancelling: 'Останавливаем…', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено' };
let tab = null, tabKey = '', items = [], state = { jobs: [], settings: {} }, online = false;
let filter = 'all', settingsDirty = false, refreshRevision = 0;
let analysisKey = '', dismissedAnalysis = '', inspectPending = false, selectionPending = false;
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
const preferences = await chrome.storage.local.get(['theme', 'settings']);
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
  $('inspectPage').hidden = !validUrl(tab?.url);
  $('inspectPage').disabled = !online || analysing || !validUrl(tab?.url);
  $('inspectLink').disabled = !online || analysing;
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
  controls(); renderStreams();
}
async function start(item, title = '', page = '') {
  await send({ type: 'download', item, title, page });
  notice('Добавлено в очередь. Скачивание продолжится, если закрыть панель.');
  view('jobs');
}
async function inspect(item, title = '', page = '') {
  inspectPending = true; controls(); notice('');
  try {
    await send({ type: 'inspect', item, title, page });
    dismissedAnalysis = ''; view('streams');
  } catch (error) { notice(error.message, true); }
  finally { inspectPending = false; controls(); }
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
  $('formatHint').textContent = problem || (main?.kind === 'combined' ? 'Звук уже встроен в этот формат.' : main?.kind === 'unknown'
    ? 'Состав дорожек не указан источником. Скачается выбранный формат.' : $('silentVideo').checked ? 'Будет сохранено видео без звука.' : 'Будут сохранены выбранные дорожки.');
}
function renderAnalysis() {
  const analysis = state.analysis;
  $('analysisCard').hidden = !analysis || analysis.id === dismissedAnalysis;
  if (!analysis) { analysisKey = ''; return; }
  $('analysisSource').textContent = analysis.url;
  const running = ['running', 'cancelling'].includes(analysis.status);
  $('cancelAnalysis').hidden = !running;
  $('closeAnalysis').hidden = running;
  $('analysisStatus').textContent = analysis.status === 'running' ? 'Получаем метаданные… Загрузка ещё не началась.' : analysis.status === 'cancelling'
    ? 'Останавливаем анализ…' : analysis.status === 'error' ? analysis.error : analysis.status === 'cancelled' ? 'Анализ отменён.' : 'Выберите формат перед скачиванием.';
  $('analysisStatus').classList.toggle('error', analysis.status === 'error');
  $('analysisResult').hidden = analysis.status !== 'done';
  const key = `${analysis.id}:${analysis.status}`;
  if (key !== analysisKey && analysis.status === 'done') {
    const result = analysis.result;
    $('videoTitle').textContent = result.title;
    const kind = result.hls_kind === 'master' ? 'HLS: главный плейлист' : result.hls_kind === 'media' ? 'HLS: медиа-плейлист' : '';
    $('videoFacts').textContent = [durationLabel(result), kind].filter(Boolean).join(' · ');
    $('videoThumbnail').hidden = !result.thumbnail;
    if (result.thumbnail) $('videoThumbnail').src = result.thumbnail;
    else $('videoThumbnail').removeAttribute('src');
    $('videoThumbnail').onerror = () => { $('videoThumbnail').hidden = true; };
    $('videoFormat').replaceChildren(...mainFormats(result.formats).map(format => {
      const option = el('option', '', formatLabel(format)); option.value = format.id; return option;
    }));
    $('silentVideo').checked = false;
    $('audioFormats').replaceChildren(...result.formats.filter(format => format.kind === 'audio').map(format => {
      const label = el('label', 'audio-option'), input = el('input');
      input.type = 'checkbox'; input.value = format.id;
      input.onchange = () => { if (input.checked) $('silentVideo').checked = false; updateFormatChoice(); };
      label.append(input, el('span', '', formatLabel(format))); return label;
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
$('closeAnalysis').onclick = () => { dismissedAnalysis = state.analysis.id; renderAnalysis(); };
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
    await send({ type: 'download_selection', analysis_id: state.analysis.id,
      format_ids: [main.id, ...audio], session: state.session });
    notice('Выбранный формат добавлен в очередь.'); view('jobs');
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
  $('streamCount').textContent = groups.length;
  $('addressCount').textContent = items.length ? `Адресов: ${items.length}` : '';
  $('streamsEmpty').hidden = Boolean(groups.length);
  $('streams').replaceChildren(...groups.map((group) => {
    const chosen = choices.get(group.key);
    const item = group.items.find((entry) => entry.url === chosen) || group.items[0];
    const li = el('li', 'stream-card');
    const heading = el('div', 'stream-heading');
    heading.append(el('span', 'badge', group.kind), el('span', 'stream-name', decoded(group.path.split('/').pop()) || 'Плейлист'));
    const path = el('div', 'stream-path', decoded(group.path));
    path.title = decoded(group.path);
    const button = el('button', 'button primary', 'Скачать');
    button.dataset.url = item.url;
    const active = state.jobs.find((job) => job.url === item.url && ACTIVE.has(job.status));
    button.disabled = !online || Boolean(active);
    if (active) button.textContent = STATUS[active.status];
    button.onclick = async () => {
      button.disabled = true;
      try { await start(item, tab?.title, tab?.url); }
      catch (error) { notice(error.message, true); button.disabled = !online; }
    };
    const actions = el('div', 'stream-actions');
    actions.append(el('span', 'stream-observed', observed(item) ? `Замечен в ${observed(item)}` : 'Обнаружен на вкладке'), button);
    const analyse = el('button', 'text-button', 'Качество и звук');
    analyse.disabled = !online || inspectPending || ['running', 'cancelling'].includes(state.analysis?.status);
    analyse.onclick = () => inspect(item, tab?.title, tab?.url);
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
    li.append(heading, el('div', 'stream-host', group.host), path, actions, analyse, details);
    return li;
  }));
  if (focusedUrl) [...$('streams').querySelectorAll('button[data-url]')].find((button) => button.dataset.url === focusedUrl)?.focus({ preventScroll: true });
}
function makeJob(job) {
  const root = el('li', 'job'); root.dataset.id = job.id;
  const title = el('div', 'job-title'), source = el('div', 'job-source');
  const status = el('div', 'job-status'), label = el('div', 'job-label'), format = el('div', 'job-format');
  const bar = el('div', 'bar'), fill = el('span'); bar.append(fill);
  bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
  const actions = el('div', 'job-actions');
  root.append(title, source, format, status, bar, label, actions);
  return { root, title, source, format, status, label, bar, fill, actions, actionKey: '' };
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
    card.title.textContent = job.path ? job.path.split(/[\\/]/).pop() : job.name || decoded(new URL(job.url).pathname.split('/').pop()) || hostOf(job.url);
    card.title.title = job.path || job.url;
    card.source.textContent = hostOf(job.url);
    card.format.hidden = !job.format_ids?.length;
    card.format.textContent = job.format_ids?.length ? `Выбрано: ${job.format_label || job.format_ids.join(' + ')}` : '';
    const percent = job.fraction == null ? null : Math.round(Math.max(0, Math.min(1, job.fraction)) * 100);
    card.status.textContent = STATUS[job.status] + (job.status === 'running' && percent !== null ? ` · ${percent}%` : '');
    card.label.textContent = job.error || (ACTIVE.has(job.status) ? job.label : '');
    card.bar.hidden = !['running', 'cancelling'].includes(job.status);
    card.bar.classList.toggle('indeterminate', percent === null);
    card.bar.setAttribute('aria-label', `Скачивание ${card.title.textContent}`);
    if (percent === null) card.bar.removeAttribute('aria-valuenow');
    else card.bar.setAttribute('aria-valuenow', percent);
    card.fill.style.width = percent === null ? '' : `${percent}%`;
    const actionKey = `${state.session}:${job.status}:${online}:${job.path || ''}`;
    if (card.actionKey !== actionKey) {
      card.actionKey = actionKey;
      card.actions.replaceChildren();
      const command = (type) => send({ type, id: job.id, session: state.session });
      if (online && ['queued', 'running'].includes(job.status)) card.actions.append(action('Отменить', () => command('cancel')));
      if (online && ['error', 'cancelled'].includes(job.status)) card.actions.append(action('Повторить', () => command('retry')));
      if (job.status === 'done') {
        if (online) card.actions.append(action('В Finder', () => command('reveal')));
        card.actions.append(action('Копировать путь', () => copy(job.path)));
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
  }
  const folder = state.settings.output_dir || '~/Downloads';
  $('folderLabel').textContent = folder.endsWith('/Downloads') ? 'Загрузки' : folder.split('/').filter(Boolean).pop();
  $('folderLabel').title = folder;
  $('toolsStatus').textContent = state.tools ? `yt-dlp: ${state.tools.yt_dlp ? 'найден' : 'не найден'}. ffmpeg: ${state.tools.ffmpeg ? 'найден' : 'не найден'}.` : 'Подключите помощник, чтобы проверить инструменты.';
  renderAnalysis(); renderJobs(); renderStreams();
}
function renderHost(host) {
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
    renderHost((await chrome.storage.session.get('host')).host);
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
    const settings = await send({ type: 'configure', settings: { workers: Number($('workers').value), output_dir: $('outputDir').value.trim() } });
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
});
const stored = await chrome.storage.session.get(['nativeState', 'host']);
renderState(stored.nativeState); renderHost(stored.host);
await refreshTab();
await connect();
