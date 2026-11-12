// Classic bootstrap: catches failures even when popup.js cannot import or start.
(() => {
  let ready = false, failed = false;
  const $ = id => document.getElementById(id);
  const report = (event, error) => {
    const location = /\b(popup\.js|startup\.js|format-model\.mjs|history-model\.mjs|stream-model\.mjs):(\d+):(\d+)/.exec(error?.stack || '');
    const fields = { name: error?.name };
    if (location) Object.assign(fields, { file: location[1], line: Number(location[2]), column: Number(location[3]) });
    // Never forward the raw message/stack: either can contain private URLs.
    try { globalThis.chrome?.runtime?.sendMessage?.({ type: 'diagnostic', event, fields })?.catch(() => {}); }
    catch { /* Reporting must not recurse when the extension context is gone. */ }
  };
  async function readLog() {
    const response = await chrome.runtime.sendMessage({ type: 'diagnostics_read' });
    if (!response?.ok) throw new Error();
    const text = `Viddow ${response.result.version}\n` + (response.result.entries.map(row => {
      const { time, event, ...fields } = row;
      return `${new Date(time).toISOString()} ${event} ${JSON.stringify(fields)}`;
    }).join('\n') || 'Журнал пока пуст.');
    $('diagnosticLog').textContent = text;
    return text;
  }
  function showFailure() {
    if (!$('clientError')) return;
    $('clientError').hidden = false;
    $('clientError').textContent = `${ready ? 'Ошибка интерфейса.' : 'Ошибка запуска панели.'} Скопируйте журнал диагностики и перезагрузите панель.`;
    if (!ready) {
      $('hostStatus').textContent = 'Панель не запустилась';
      $('reconnect').hidden = false;
      $('reconnect').textContent = 'Перезагрузить панель';
      $('reconnect').onclick = () => location.reload();
    }
    const diagnostics = $('diagnostics');
    $('clientError').after(diagnostics);
    diagnostics.open = true;
    readLog().catch(() => { $('diagnosticLog').textContent = 'Не удалось прочитать журнал.'; });
  }
  function failure(error) {
    if (failed) return;
    failed = true;
    clearTimeout(watchdog);
    report('panel_error', error);
    showFailure();
  }
  window.addEventListener('error', event => failure(event.error || { name: 'Error', stack: `${event.filename}:${event.lineno}:${event.colno}` }));
  window.addEventListener('unhandledrejection', event => failure(event.reason));
  const watchdog = setTimeout(() => {
    if (!ready) { failed = true; report('panel_stalled'); showFailure(); }
  }, 20000);
  globalThis.viddowPanelReady = () => {
    ready = true;
    clearTimeout(watchdog);
    report('panel_ready');
  };
  document.addEventListener('DOMContentLoaded', () => {
    $('diagnostics').addEventListener('toggle', () => {
      if ($('diagnostics').open) readLog().catch(() => {});
    });
    $('refreshDiagnostics').onclick = () => readLog().catch(() => { $('diagnosticLog').textContent = 'Не удалось прочитать журнал.'; });
    $('copyDiagnostics').onclick = async () => {
      try { await navigator.clipboard.writeText(await readLog()); $('diagnosticHint').textContent = 'Журнал скопирован.'; }
      catch { $('diagnosticHint').textContent = 'Не удалось скопировать. Выделите текст журнала вручную.'; }
    };
    $('clearDiagnostics').onclick = async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'diagnostics_clear' });
        if (!response?.ok) throw new Error();
        await readLog(); $('diagnosticHint').textContent = 'Журнал очищен.';
      } catch { $('diagnosticHint').textContent = 'Не удалось очистить журнал.'; }
    };
    globalThis.chrome?.storage?.session?.onChanged?.addListener(changes => {
      if (changes.diagnosticLog && $('diagnostics').open) readLog().catch(() => {});
    });
    if (failed) showFailure();
  });
  report('panel_start');
})();
