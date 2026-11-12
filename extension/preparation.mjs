import { canRecoverPageError } from './source-policy.mjs';
import { streamKey } from './stream-model.mjs';

// One shared preparation per native inspector. No panel owns the fallback chain.
export class VideoPreparation {
  constructor(io) { this.io = io; this.current = null; this.running = false; this.dirty = false; this.timer = null; }
  async publish() {
    const value = this.current;
    await this.io.publish(value ? { tabId: value.tabId, page: value.page, documentToken: value.documentToken,
      session: value.session, analysisId: value.analysisId, phase: value.phase, downloadPending: value.download, error: value.error || '' } : null);
  }
  async begin(value) {
    this.cancel();
    this.current = { ...value, active: true, fallbackStarted: false, phase: 'page' };
    this.io.trace?.('prepare_begin', { tab_id: value.tabId, analysis_tag: value.analysisId });
    await this.publish(); this.observe();
  }
  cancel() {
    clearTimeout(this.timer); this.timer = null;
    if (this.current?.active) this.io.trace?.('prepare_cancelled', { analysis_tag: this.current.analysisId });
    if (this.current) { this.current.active = false; this.current.download = false; this.current.phase = 'cancelled'; }
  }
  async requestDownload(value) {
    const current = this.current;
    if (!current?.active || ['cancelled', 'error', 'downloaded', 'choose'].includes(current.phase) || current.tabId !== value.tabId || current.page !== value.page
        || current.session !== value.session || current.documentToken !== value.documentToken
        || (current.selectedMediaKey || null) !== (value.selectedMediaKey || null)) return false;
    current.download = true;
    if (current.phase === 'done') current.phase = 'ready';
    await this.publish(); this.observe(); return true;
  }
  async clearIntent(tabId) {
    if (this.current && this.current.tabId !== tabId) { this.current.download = false; await this.publish(); }
  }
  observe() {
    this.dirty = true;
    if (this.running) return;
    this.running = true;
    const owner = this.current;
    this.progress().catch(() => {
      if (this.current === owner && owner?.active) { this.current.download = false; this.current.phase = 'error'; this.current.error = 'Не удалось подготовить или добавить видео в очередь. Попробуйте скачать ещё раз.'; return this.publish(); }
    }).finally(() => { this.running = false; if (this.dirty) this.observe(); });
  }
  async progress() {
    this.dirty = false;
    const current = this.current;
    if (!current?.active || ['done', 'downloaded', 'choose', 'cancelled', 'error'].includes(current.phase)) return;
    const state = await this.io.state();
    if (!current.active || this.current !== current) return;
    if (state?.session !== current.session || state.analysis?.id !== current.analysisId) return;
    const analysis = state.analysis;
    this.io.trace?.('prepare_result', { analysis_tag: analysis.id, status: analysis.status, code: analysis.error_code });
    if (['running', 'cancelling'].includes(analysis.status)) return;
    if (analysis.status === 'cancelled') { this.cancel(); await this.publish(); return; }
    const context = await this.io.context(current.tabId);
    if (!current.active || this.current !== current) return;
    if (!context || context.url !== current.page || context.documentToken !== current.documentToken
        || context.domAvailable !== false && current.mediaKeys?.some(key => !(context.mediaKeys?.includes(key) || context.media?.some(media => media.key === key)))) {
      this.cancel(); await this.publish(); return;
    }
    if (analysis.status === 'done') {
      current.phase = 'done';
      if (current.download) {
        current.download = false;
        const ids = analysis.result?.recommended_format_ids;
        if (!ids?.length) current.phase = 'choose';
        else {
          this.io.trace?.('prepare_download', { analysis_tag: analysis.id, source_tag: analysis.result.source_id });
          const result = await this.io.download({ session: current.session, analysis_id: analysis.id,
            source_id: analysis.result.source_id, format_ids: ids });
          if (current.active && this.current === current) {
            current.phase = 'downloaded'; await this.io.downloaded(current, result);
          }
        }
      }
      await this.publish(); return;
    }
    if (!canRecoverPageError(current.page, analysis) || current.fallbackStarted) {
      current.phase = 'error'; current.download = false; await this.publish(); return;
    }
    const visible = new Set(context.documents);
    const hidden = new Set(context.hiddenDocuments || []);
    const items = await this.io.streams(current.tabId);
    if (!current.active || this.current !== current) return;
    const selected = current.selectedMediaKey ? context.media?.find(media => media.key === current.selectedMediaKey) : null;
    const decisions = items.map((item, index) => {
      let code;
      if (item.tabGeneration && context.tabGeneration && item.tabGeneration !== context.tabGeneration) code = 'stale_generation';
      else if (item.documentId && hidden.has(item.documentId)) code = 'hidden_document';
      else if (item.documentId && visible.has(item.documentId)) code = 'visible_document';
      else if (item.tabGeneration && item.tabGeneration === context.tabGeneration) code = 'current_generation';
      else code = 'missing_scope';
      let eligible = code === 'visible_document' || code === 'current_generation';
      if (eligible && current.selectedMediaKey) {
        const matches = selected && item.documentId === selected.documentId && item.frameId === selected.frameId &&
          (/^https?:/.test(selected.src) ? item.url === selected.src : context.media.filter(media => media.documentId === selected.documentId).length === 1);
        if (!matches) { eligible = false; code = 'explicit_mismatch'; }
      }
      this.io.trace?.('prepare_candidate', { analysis_tag: analysis.id, source_tag: item.traceId, source_index: index,
        document_tag: item.documentId, frame_id: item.frameId, code });
      return { item, code, eligible };
    });
    const unique = new Map(decisions.filter(value => value.eligible).map(value => value.item)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).map(item => [streamKey(item), item]));
    const candidates = [...unique.values()].slice(0, 6);
    this.io.trace?.('prepare_candidates', { analysis_tag: analysis.id, candidates_count: items.length,
      eligible_count: candidates.length, visible_count: decisions.filter(value => value.code === 'visible_document').length, hidden_count: decisions.filter(value => value.code === 'hidden_document').length,
      unbound_count: decisions.filter(value => value.code === 'current_generation').length,
      rejected_count: decisions.filter(value => !value.eligible).length });
    if (!candidates.length) {
      current.phase = items.length ? 'blocked' : 'waiting';
      current.error = items.length ? decisions.every(value => value.code === 'hidden_document')
        ? 'Видео обнаружено. Доступный адрес относится к скрытому плееру.'
        : decisions.every(value => value.code === 'stale_generation')
          ? 'Видео обнаружено. Найденный адрес относится к прежнему открытию страницы.'
          : decisions.every(value => value.code === 'explicit_mismatch')
            ? 'Видео обнаружено. Найденный адрес не связан с выбранным плеером.'
            : 'Видео обнаружено, но пока не удалось подтвердить актуальность найденного адреса для этой страницы.' : '';
      if (items.length) current.download = false;
      this.io.trace?.('prepare_waiting', { analysis_tag: analysis.id, candidates_count: items.length, code: items.length ? 'excluded_streams' : 'no_streams' });
      await this.publish(); return;
    }
    current.error = '';
    if (current.phase !== 'recovering') {
      current.phase = 'recovering'; await this.publish();
      this.timer = setTimeout(() => { this.timer = null; this.observe(); }, 350);
      return;
    }
    // A batch starts once after a short discovery window. There is no retry loop.
    if (this.timer) return;
    const latest = await this.io.state();
    if (!current.active || this.current !== current || latest.session !== current.session || latest.analysis?.id !== analysis.id) return;
    current.fallbackStarted = true;
    this.io.trace?.('prepare_batch_start', { analysis_tag: analysis.id, candidates_count: candidates.length });
    const result = await this.io.inspect({ session: current.session, urls: [current.page], page: current.page,
      name: current.title || '', source_kind: 'page', fallback_only: true, fallbacks: candidates.map(item => ({ urls: [item.url],
        trace_tag: item.traceId, name: current.title || '', headers: item.headers || {}, referer: item.referer || '', page: current.page, source_kind: 'auto', stream_kind: item.kind })) });
    if (!current.active || this.current !== current) { await this.io.cancel(result.analysis_id, current.session); return; }
    current.analysisId = result.analysis_id; await this.publish(); this.dirty = true;
  }
}
