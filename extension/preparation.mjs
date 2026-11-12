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
    await this.publish(); this.observe();
  }
  cancel() {
    clearTimeout(this.timer); this.timer = null;
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
    if (['running', 'cancelling'].includes(analysis.status)) return;
    if (analysis.status === 'cancelled') { this.cancel(); await this.publish(); return; }
    const context = await this.io.context(current.tabId);
    if (!current.active || this.current !== current) return;
    if (!context || context.url !== current.page || context.documentToken !== current.documentToken
        || current.mediaKeys?.some(key => !(context.mediaKeys?.includes(key) || context.media?.some(media => media.key === key)))) {
      this.cancel(); await this.publish(); return;
    }
    if (analysis.status === 'done') {
      current.phase = 'done';
      if (current.download) {
        current.download = false;
        const ids = analysis.result?.recommended_format_ids;
        if (!ids?.length) current.phase = 'choose';
        else {
          const result = await this.io.download({ session: current.session, analysis_id: analysis.id,
            source_id: analysis.result.source_id, format_ids: ids });
          if (current.active && this.current === current) {
            current.phase = 'downloaded'; await this.io.downloaded(current, result);
          }
        }
      }
      await this.publish(); return;
    }
    if (analysis.status !== 'error' || analysis.error_code !== 'unsupported_source' || current.fallbackStarted) {
      current.phase = 'error'; current.download = false; await this.publish(); return;
    }
    const visible = new Set(context.documents);
    const items = await this.io.streams(current.tabId);
    if (!current.active || this.current !== current) return;
    const selected = current.selectedMediaKey ? context.media?.find(media => media.key === current.selectedMediaKey) : null;
    const eligible = item => {
      if (!item.documentId || !visible.has(item.documentId)) return false;
      if (!current.selectedMediaKey) return true;
      if (!selected || item.documentId !== selected.documentId || item.frameId !== selected.frameId) return false;
      if (/^https?:/.test(selected.src)) return item.url === selected.src;
      return context.media.filter(media => media.documentId === selected.documentId).length === 1;
    };
    const unique = new Map(items.filter(eligible)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).map(item => [streamKey(item), item]));
    const candidates = [...unique.values()].slice(0, 6);
    if (!candidates.length) { current.phase = 'waiting'; await this.publish(); return; }
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
    const result = await this.io.inspect({ session: current.session, urls: [current.page], page: current.page,
      name: current.title || '', source_kind: 'page', fallback_only: true, fallbacks: candidates.map(item => ({ urls: [item.url],
        name: current.title || '', headers: item.headers || {}, referer: item.referer || '', page: current.page, source_kind: 'auto', stream_kind: item.kind })) });
    if (!current.active || this.current !== current) { await this.io.cancel(result.analysis_id, current.session); return; }
    current.analysisId = result.analysis_id; await this.publish(); this.dirty = true;
  }
}
