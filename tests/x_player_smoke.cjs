// Real extension/DOM binding; native commands are intercepted, no X account.
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright');
const { extensionPath, openPanel } = require('./extension_browser.cjs');
const groups = ['2119187441865109504', '2120833987295801344', '2120022956982038529'];
async function waitUntil(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(label);
}
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'viddow-x-selection-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: false, viewport: null,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><title>Local X feed fixture</title>${groups.map((id, i) => `<video style="width:200px;height:120px" poster="https://pbs.twimg.com/amplify_video_thumb/${id}/img/cover.jpg"></video>`).join('')}
      <script>document.querySelectorAll('video').forEach((video,i)=>{video.src=URL.createObjectURL(new Blob());Object.defineProperty(video,'duration',{value:[70,30,276][i]});});</script>` }));
    await context.route('https://pbs.twimg.com/**', route => route.fulfill({ contentType: 'image/svg+xml', body:
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="blue"/></svg>' }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      const event = () => { const callbacks = []; return { addListener: fn => callbacks.push(fn), fire: value => callbacks.forEach(fn => fn(value)) }; };
      globalThis.__calls = []; globalThis.__jobs = []; globalThis.__analysis = null;
      const snapshot = () => ({ type: 'state', session: 'x-fixture', jobs: globalThis.__jobs, analysis: globalThis.__analysis,
        settings: { workers: 1, output_dir: '/tmp/Viddow/X' }, tools: { yt_dlp: true, ffmpeg: true } });
      globalThis.__publish = value => { globalThis.__analysis = value; globalThis.__port.onMessage.fire(snapshot()); };
      chrome.runtime.connectNative = () => {
        const port = { onMessage: event(), onDisconnect: event(), postMessage(message) {
          if (message.type === 'trace') return;
          if (message.type === 'session') { setTimeout(() => this.onMessage.fire({ ...snapshot(), type: 'ready', protocol: 2, history_version: 1 }), 0); return; }
          globalThis.__calls.push(message);
          let result = {};
          if (message.command === 'inspect') {
            globalThis.__analysis = { id: 'analysis-' + globalThis.__calls.length, url: message.urls[0], status: 'running' };
            result.analysis_id = globalThis.__analysis.id;
          }
          if (message.command === 'download') { globalThis.__jobs.push({ id: 1, status: 'done', name: 'Chosen X video', url: 'https://x.com/', path: '/tmp/chosen.mp4' }); result.ids = [1]; }
          setTimeout(() => { this.onMessage.fire(snapshot()); this.onMessage.fire({ type: 'reply', request_id: message.request_id, ok: true, result }); }, 0);
        } };
        globalThis.__port = port; return port;
      };
    });
    const source = await context.newPage(); await source.goto('https://x.com/');
    const panel = await openPanel(context, worker, source);
    const preparation = () => worker.evaluate(async () => (await chrome.storage.session.get('preparation')).preparation);
    await panel.locator('#hostDot.online').waitFor();
    const [tab] = await worker.evaluate(async () => chrome.tabs.query({ url: 'https://x.com/*' }));
    const [frame] = await worker.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => null }), tab.id);
    await worker.evaluate(async ({ groups, tabId, documentId }) => chrome.storage.session.set({ ['tab_' + tabId]:
      groups.flatMap((id, i) => Array.from({ length: i === 0 ? 3 : 5 }, (_, j) => ({
        url: `https://video.twimg.com/amplify_video/${id}/pl/${j}.m3u8?tag=full`, kind: 'HLS',
        frameId: 0, documentId, headers: { 'X-Player': String(i) }, lastSeen: j }))) }), { groups, tabId: tab.id, documentId: frame.documentId });
    await panel.waitForFunction(() => document.querySelectorAll('.player-option').length === 3);
    await panel.locator('.player-option').nth(0).click();
    await panel.locator('#inspectPage').click();
    await waitUntil(async () => { const value = await preparation(); return value?.downloadPending && JSON.parse(value.selectedMediaKey)[3] === 1; }, 'First player intent not registered');
    await worker.evaluate(() => globalThis.__publish({ ...globalThis.__analysis, status: 'error', error_code: 'unsupported_source', error: 'Unsupported URL' }));
    await waitUntil(async () => (await preparation())?.phase === 'recovering', 'First player did not recover');
    // Switching while the batch is being discovered clears the first intent.
    await panel.locator('.player-option').nth(1).click();
    await waitUntil(async () => !(await preparation())?.downloadPending, 'Old player intent survived selection change');
    assert.equal(await worker.evaluate(() => globalThis.__calls.filter(value => value.command === 'download').length), 0);
    await panel.locator('#inspectPage').click();
    await waitUntil(async () => { const value = await preparation(); return value?.downloadPending && JSON.parse(value.selectedMediaKey)[3] === 2; }, 'Second player intent not registered');
    await worker.evaluate(() => globalThis.__publish({ ...globalThis.__analysis, status: 'error', error_code: 'unsupported_source', error: 'Unsupported URL' }));
    await waitUntil(async () => (await preparation())?.phase === 'recovering', 'Second player did not recover');
    let batch;
    const deadline = Date.now() + 15000;
    while (!batch && Date.now() < deadline) {
      batch = await worker.evaluate(() => globalThis.__calls.findLast(value => value.command === 'inspect' && value.fallback_only
        && value.fallbacks.every(source => source.urls[0].includes('/2120833987295801344/'))));
      if (!batch) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(batch, JSON.stringify(await worker.evaluate(async () => ({ calls: globalThis.__calls, state: await chrome.storage.session.get(['preparation', 'nativeState', 'diagnosticLog']) }))));
    assert.equal(batch.fallbacks.length, 5);
    assert.ok(batch.fallbacks.every(value => value.urls[0].includes('/2120833987295801344/') && value.headers['X-Player'] === '1'));
    await worker.evaluate(() => globalThis.__publish({ ...globalThis.__analysis, status: 'done', result: { source_id: 'chosen-player-two', recommended_format_ids: ['720'], formats: [] } }));
    await waitUntil(async () => (await preparation())?.phase === 'downloaded', 'Selected player was not downloaded');
    const downloads = await worker.evaluate(() => globalThis.__calls.filter(value => value.command === 'download'));
    assert.equal(downloads.length, 1); assert.equal(downloads[0].source_id, 'chosen-player-two');
    console.log('PASS X selected player: real DOM poster binding, three blob players, thirteen streams, selection change cancels old intent, exact group and one download');
  } finally {
    await context?.close(); fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
