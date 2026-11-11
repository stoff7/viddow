// Единственная постоянная проекция: полные адреса/заголовки остаются в session.
const STATUSES = new Set(['queued', 'running', 'cancelling', 'done', 'error', 'cancelled', 'interrupted']);
const YOUTUBE = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const MEDIA = /\.(?:m3u8|mpd|mp4|mkv|webm|mov|m4v|mp3|m4a|aac|ts)$/i;

export function safeOrigin(value) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin : ''; }
  catch { return ''; }
}
export function pageReference(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || MEDIA.test(url.pathname)) return { page: null, retry: false };
    const query = [...url.searchParams];
    const identity = YOUTUBE.has(url.hostname) && url.pathname === '/watch' && query.length === 1
      && query[0][0] === 'v' && /^[A-Za-z0-9_-]{1,80}$/.test(query[0][1]);
    const page = url.origin + url.pathname + (identity ? `?v=${encodeURIComponent(query[0][1])}` : '');
    return { page, retry: !url.username && !url.password && !url.hash && (!query.length || identity) };
  } catch { return { page: null, retry: false }; }
}
function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  if (/\b(?:cookie|authorization|token|signature|credential)\s*[:=]|\bbearer\s+\S+/i.test(value)) return fallback || '[скрыто]';
  return value
    .replace(/https?:\/\/\S+/gi, '[ссылка]')
    .replace(/[\x00-\x1f]/g, ' ').slice(0, 512);
}
function normalize(row, legacy = false) {
  if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.id) || row.id < 1 || !STATUSES.has(row.status)) return null;
  const source = pageReference(row.page ?? (legacy ? row.source_page : null));
  const path = row.status === 'done' && typeof row.path === 'string' && row.path.startsWith('/') && !/[\x00\r\n]/.test(row.path) ? row.path : null;
  return { id: row.id, name: safeText(row.name ?? (legacy ? row.title : null), 'Видео') || 'Видео',
    status: row.status, path, page: source.page,
    page_retry: source.retry && (legacy || row.page_retry === true),
    source_origin: safeOrigin(row.source_origin),
    created_at: Number.isSafeInteger(row.created_at) && row.created_at >= 0 ? row.created_at : 0,
    format_label: safeText(row.format_label),
    http_status: Number.isInteger(row.http_status) && row.http_status >= 400 && row.http_status <= 599 ? row.http_status : null };
}
export function decodeHistory(value) {
  if (value === undefined) return { history: { version: 1, jobs: [] }, warning: '', writable: true };
  if (value && Number.isInteger(value.version) && value.version > 1) return {
    history: { version: 1, jobs: [] }, writable: false,
    warning: 'История создана более новой версией Viddow. Она сохранена без изменений; запись истории временно отключена.' };
  const legacy = Array.isArray(value);
  const rows = legacy ? value : value?.version === 1 && Array.isArray(value.jobs) ? value.jobs : null;
  if (!rows) return { history: { version: 1, jobs: [] }, writable: true,
    warning: 'История повреждена и не восстановлена. Новые записи будут сохранены.' };
  const jobs = [], seen = new Set();
  let invalid = 0;
  for (const row of rows) {
    const next = normalize(row, legacy);
    if (!next || seen.has(next.id)) { invalid++; continue; }
    jobs.push(next); seen.add(next.id);
  }
  return { history: { version: 1, jobs }, writable: true,
    warning: invalid ? `Пропущены повреждённые записи истории: ${invalid}. Остальные восстановлены.` : '' };
}
export function historyFromJobs(jobs) {
  const rows = jobs.map(job => {
    const source = pageReference(job.page);
    const http = typeof job.error === 'string' ? /HTTP(?:\s+Error)?[:\s]+([45]\d\d)\b/i.exec(job.error) : null;
    return { id: job.id, name: job.name || job.path?.split('/').pop() || 'Видео', status: job.status,
      page: source.page, page_retry: source.retry && (!job.restored || job.page_retry === true),
      source_origin: safeOrigin(job.source_origin || job.url), path: job.path,
      created_at: job.created_at, format_label: job.format_label,
      http_status: http ? Number(http[1]) : job.http_status };
  });
  return decodeHistory({ version: 1, jobs: rows }).history;
}
export function offlineJobs(history) {
  return history.jobs.map(row => ({ ...row, restored: true, url: row.page || row.source_origin,
    status: ['queued', 'running', 'cancelling'].includes(row.status) ? 'interrupted' : row.status,
    format_ids: [], fraction: row.status === 'done' ? 1 : null,
    error: row.status === 'error' ? row.http_status ? `HTTP ${row.http_status}. Ошибка в предыдущей сессии.` : 'Ошибка в предыдущей сессии.' : null }));
}
