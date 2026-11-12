export const DIAGNOSTIC_LIMIT = 200;
const EVENTS = new Set(['panel_start', 'panel_ready', 'panel_error', 'panel_stalled', 'host_connect_start',
  'host_ready', 'host_disconnect', 'host_connect_failed', 'host_timeout', 'command_start', 'command_ok', 'command_error', 'analysis_state', 'page_context_start', 'page_context_ready', 'page_context_unavailable', 'stream_seen', 'prepare_begin', 'prepare_result', 'prepare_candidate', 'prepare_candidates', 'prepare_waiting', 'prepare_batch_start', 'prepare_download', 'prepare_cancelled']);
const COMMANDS = new Set(['inspect', 'preview', 'inspect_cancel', 'inspect_history', 'download', 'cancel', 'retry', 'clear', 'configure', 'reveal']);
const NAMES = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'DOMException']);
const FILES = new Set(['popup.js', 'startup.js', 'background.js', 'format-model.mjs', 'history-model.mjs', 'stream-model.mjs', 'diagnostics.mjs']);
const CODES = new Set(['host_not_found', 'timeout', 'protocol_mismatch', 'connection_lost', 'command_failed', 'unsupported_source', 'embedded_source_error', 'analysis_timeout', 'network', 'access_denied', 'source_unavailable', 'visible_document', 'current_generation', 'hidden_document', 'stale_generation', 'missing_scope', 'explicit_mismatch', 'no_streams', 'excluded_streams', 'missing_context']);
const STATUSES = new Set(['running', 'cancelling', 'cancelled', 'done', 'error', 'cleared', 'page', 'waiting', 'blocked', 'recovering', 'choose', 'downloaded']);

// Only fixed event names and explicitly allowed fields may leave the caller.
// Error messages, URLs, titles, paths, headers and request bodies are excluded.
export function diagnosticEntry(event, fields = {}, time = Date.now()) {
  if (!EVENTS.has(event)) return null;
  if (!fields || typeof fields !== 'object') fields = {};
  const entry = { time, event };
  for (const [key, allowed] of [['command', COMMANDS], ['name', NAMES], ['file', FILES], ['code', CODES], ['status', STATUSES]]) {
    if (allowed.has(fields[key])) entry[key] = fields[key];
  }
  for (const key of ['line', 'column', 'elapsed_ms', 'candidates_count', 'eligible_count', 'visible_count', 'hidden_count', 'unbound_count', 'rejected_count', 'formats_count', 'tab_id', 'source_index', 'jobs_count', 'job_id']) {
    if (Number.isSafeInteger(fields[key]) && fields[key] >= 0 && fields[key] <= 86400000) entry[key] = fields[key];
  }
  if (Number.isSafeInteger(fields.frame_id) && fields.frame_id >= -1 && fields.frame_id <= 1000000000) entry.frame_id = fields.frame_id;
  for (const key of ['analysis_tag', 'source_tag', 'candidate_tag', 'document_tag']) if (typeof fields[key] === 'string' && /^[a-fA-F0-9-]{8,64}$/.test(fields[key])) entry[key] = fields[key];
  if (['HLS', 'DASH'].includes(fields.kind)) entry.kind = fields.kind;
  return entry;
}

export function diagnosticCode(reason = '') {
  if (/not found|forbidden|not registered|не подключён/i.test(reason)) return 'host_not_found';
  if (/timeout|не ответил|задерживается/i.test(reason)) return 'timeout';
  if (/протокол/i.test(reason)) return 'protocol_mismatch';
  return 'command_failed';
}

let writes = Promise.resolve(), sink = null;
export function setDiagnosticSink(value) { sink = value; }
export async function readDiagnostics() {
  await writes;
  const stored = (await chrome.storage.session.get('diagnosticLog')).diagnosticLog;
  return Array.isArray(stored) ? stored.filter(row => row && Number.isSafeInteger(row.time))
    .map(row => diagnosticEntry(row.event, row, row.time)).filter(Boolean).slice(-DIAGNOSTIC_LIMIT) : [];
}
export function recordDiagnostic(event, fields) {
  const entry = diagnosticEntry(event, fields);
  if (!entry) return Promise.resolve();
  console.info('[Viddow]', entry);
  const operation = writes.then(async () => {
    const stored = (await chrome.storage.session.get('diagnosticLog')).diagnosticLog;
    const previous = Array.isArray(stored) ? stored.filter(row => row && Number.isSafeInteger(row.time))
      .map(row => diagnosticEntry(row.event, row, row.time)).filter(Boolean) : [];
    await chrome.storage.session.set({ diagnosticLog: [...previous, entry].slice(-DIAGNOSTIC_LIMIT) });
    try { sink?.(entry); } catch { /* The native connection may have closed. */ }
  });
  writes = operation.catch(() => console.warn('[Viddow] diagnostic_storage_failed'));
  return writes;
}

export function clearDiagnostics() {
  const operation = writes.then(() => chrome.storage.session.remove('diagnosticLog'));
  writes = operation.catch(() => console.warn('[Viddow] diagnostic_storage_failed'));
  return operation;
}
