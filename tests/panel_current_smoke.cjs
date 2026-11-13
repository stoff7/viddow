// Реальное расширение и webRequest в отдельном профиле. Native-порт подменён;
// настоящий протокол и скачивания проверяются test_native_session.py.
const assert = require('node:assert/strict');
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { extensionPath, openPanel } = require('./extension_browser.cjs');

(async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/poster.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#3e7656"/></svg>');
    } else if (request.url.includes('.m3u8')) {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`${request.url === '/' ? '<meta property="og:type" content="video.other"><meta property="og:image" content="/poster.svg"><meta property="video:duration" content="125">' : ''}<title>${request.url === '/other' ? 'Другая вкладка' : 'Урок по монтажу · тест Viddow'}</title><h1>Local extension test</h1>`);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'viddow-extension-profile-'));
  const artifacts = process.env.VIDDOW_ARTIFACTS || path.join(os.tmpdir(), 'viddow-extension-check');
  fs.mkdirSync(artifacts, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false, viewport: null, colorScheme: 'light',
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: ['--no-proxy-server', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.equal((await worker.evaluate(() => chrome.sidePanel.getPanelBehavior())).openPanelOnActionClick, true);
    assert.equal((await worker.evaluate(() => chrome.sidePanel.getOptions({}))).path, 'popup.html');
    await worker.evaluate(() => {
      globalThis.__nativeCalls = [];
      globalThis.__nativeJobs = [];
      globalThis.__nativeSequence = 0;
      globalThis.__nativeAnalysis = null;
      globalThis.__nativeSession = 0;
      globalThis.__nativeSettings = { workers: 2, output_dir: '/tmp/Viddow/Downloads' };
      const event = () => { const listeners = []; return { addListener: listener => listeners.push(listener), fire: value => listeners.forEach(listener => listener(value)) }; };
      chrome.runtime.connectNative = () => {
        if (globalThis.__nativeMode === 'throw') throw new Error('Native host not found');
        const port = { onMessage: event(), onDisconnect: event(), disconnect() { this.onDisconnect.fire(); },
          postMessage(message) {
            if (message.type === 'trace') return;
            globalThis.__nativeCalls.push(message);
            setTimeout(() => {
              if (message.type === 'session') {
                if (globalThis.__nativeMode === 'silent') return;
                if (globalThis.__nativeMode === 'error') { this.onMessage.fire({ type: 'error', error: 'Нет доступа к папке' }); return; }
                globalThis.__nativeSession++;
                globalThis.__nativeJobs = (message.history || []).map(job => ({ ...job, restored: true,
                  url: job.page || job.source_origin, status: ['running', 'queued', 'cancelling'].includes(job.status) ? 'interrupted' : job.status }));
                globalThis.__nativeSequence = Math.max(globalThis.__nativeSequence, ...globalThis.__nativeJobs.map(job => job.id));
                this.onMessage.fire({ ...snapshot(), type: 'ready', protocol: globalThis.__nativeMode === 'old' ? 1 : 2, history_version: 1 });
                return;
              }
              const command = message.command;
              let result = {}, error = null;
              if (command === 'inspect') {
                globalThis.__nativeAnalysis = { id: 'analysis-' + message.request_id, url: message.urls[0], status: 'running', result: null };
                result = { analysis_id: globalThis.__nativeAnalysis.id };
              } else if (command === 'inspect_cancel') {
                globalThis.__nativeAnalysis.status = 'cancelled';
              } else if (command === 'download') {
                const job = { id: ++globalThis.__nativeSequence, url: message.analysis_id ? globalThis.__nativeAnalysis.url : message.urls[0], name: message.name,
                  format_ids: message.format_ids,
                  page: message.page || (message.source_kind === 'page' ? message.urls[0] : null),
                  status: 'running', fraction: .32, label: '3.2 / 10 МБ', path: null, error: null };
                globalThis.__nativeJobs.push(job); result = { ids: [job.id] };
              } else if (command === 'cancel') {
                globalThis.__nativeJobs.find(job => job.id === message.id).status = 'cancelled';
              } else if (command === 'retry') {
                const previous = globalThis.__nativeJobs.find(job => job.id === message.id);
                globalThis.__nativeJobs.push({ ...previous, id: ++globalThis.__nativeSequence, status: 'running', error: null });
              } else if (command === 'clear') {
                globalThis.__nativeJobs = globalThis.__nativeJobs.filter(job => ['running', 'queued', 'cancelling'].includes(job.status));
              } else if (command === 'configure') {
                if (globalThis.__nativeJobs.some(job => job.status === 'running')) error = 'Очередь занята';
                else { globalThis.__nativeSettings = message.settings; result = message.settings; globalThis.__nativeAnalysis = null; }
              }
              this.onMessage.fire(snapshot());
              this.onMessage.fire({ type: 'reply', request_id: message.request_id, ok: !error, result, error });
            }, 10);
          } };
        globalThis.__nativePort = port;
        return port;
      };
      const snapshot = () => ({ type: 'state', session: 'test-' + globalThis.__nativeSession,
        jobs: structuredClone(globalThis.__nativeJobs), settings: { ...globalThis.__nativeSettings },
        analysis: structuredClone(globalThis.__nativeAnalysis), tools: { yt_dlp: true, ffmpeg: true } });
      globalThis.__publishAnalysis = value => { globalThis.__nativeAnalysis = value; globalThis.__nativePort.onMessage.fire(snapshot()); };
      globalThis.__nativeFinish = () => {
        const job = globalThis.__nativeJobs.findLast(job => job.status === 'running');
        job.status = 'done'; job.fraction = 1; job.path = '/tmp/Viddow/Downloads/lesson.mp4';
        globalThis.__nativePort.onMessage.fire(snapshot());
      };
      globalThis.__nativeYoutubeError = () => {
        globalThis.__nativeJobs.push({ id: ++globalThis.__nativeSequence,
          url: 'https://www.youtube.com/watch?v=public_test', page: 'https://www.youtube.com/watch?v=public_test',
          name: 'YouTube test', status: 'error', error_code: 'authentication_required',
          error: 'YouTube просит подтвердить сеанс.', error_detail: '[youtube] Sign in to confirm you’re not a bot', path: null });
        globalThis.__nativePort.onMessage.fire(snapshot());
      };
    });
    const source = await context.newPage();
    await source.goto(base);
    const urls = ['/lesson/master.m3u8?token=one', '/lesson/master.m3u8?token=two', '/lesson/index-f1-v1-a1.m3u8', '/other/master.m3u8'];
    await source.evaluate(async urls => { for (const url of urls) await fetch(url); }, urls);
    // Extension reload clears session state but retains completed history.
    await worker.evaluate(async origin => chrome.storage.local.set({ history: { version: 1, jobs: [{ id: 1, name: 'Previous download', status: 'done', path: '/tmp/previous.mp4', source_origin: origin, created_at: 1 }] } }), base);
    const panel = await openPanel(context, worker, source);
    await source.bringToFront();
    try { await panel.locator('#hostDot.online').waitFor({ timeout: 5000 }); }
    catch (error) {
      console.log('Panel diagnostic:', panel.url(), await panel.locator('body').innerText(),
        await worker.evaluate(() => chrome.storage.session.get(['host', 'nativeState'])), errors);
      throw error;
    }
    context.setDefaultTimeout(10000);
    await panel.locator('[data-view=jobs]').click();
    await panel.locator('.job.done').waitFor();
    await panel.locator('#clear').click();
    await panel.locator('[data-view=streams]').click();
    await worker.evaluate(() => globalThis.__publishAnalysis({ ...globalThis.__nativeAnalysis, status: 'done', result: { title: 'Карточка тестового видео', source_id: 'test-source', formats: [{ id: 'combined', kind: 'combined', height: 720 }] } }));
    await panel.locator('.media-card').first().waitFor();
    for (const width of [320, 400]) {
      await panel.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await panel.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await panel.screenshot({ path: path.join(artifacts, `cards-${theme}-${width}.png`) });
      }
    }
    await panel.locator('#openManual').click();
    await panel.locator('#manualUrl').fill(base + '/manual.mp4');
    await panel.locator('#manualUrl').press('Enter');
    await panel.locator('.job.running').waitFor();
    await panel.getByRole('button', {name: 'Отменить', exact: true}).click();
    await panel.locator('.job.cancelled').waitFor();
    await panel.getByRole('button', {name: 'Повторить', exact: true}).click();
    await panel.locator('.job.running').waitFor();
    await worker.evaluate(() => globalThis.__nativeFinish());
    await panel.locator('.job.done').waitFor();
    await panel.getByRole('button', {name: 'Показать файл', exact: true}).click();
    assert.equal(await worker.evaluate(() => globalThis.__nativeCalls.some(row => row.command === 'reveal')), true);
    await worker.evaluate(() => globalThis.__nativePort.disconnect());
    await panel.locator('#hostDot.offline').waitFor();
    await panel.locator('#reconnect').click();
    await panel.locator('#hostDot.online').waitFor();
    await panel.locator('.job.done').waitFor();
    assert.deepEqual(errors, []);
    console.log('Current panel smoke PASS: cards, 320/400 light/dark, manual download, cancel/retry, completion/reveal, reconnect/history. Native port mocked.');
  } finally {
    if (context) await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
