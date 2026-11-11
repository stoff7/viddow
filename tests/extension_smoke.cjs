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
    if (request.url.includes('.m3u8')) {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<title>${request.url === '/other' ? 'Другая вкладка' : 'Урок по монтажу · тест Viddow'}</title><h1>Local extension test</h1>`);
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
      globalThis.__nativeSession = 0;
      globalThis.__nativeSettings = { workers: 2, output_dir: '/tmp/Viddow/Downloads' };
      const event = () => { const listeners = []; return { addListener: listener => listeners.push(listener), fire: value => listeners.forEach(listener => listener(value)) }; };
      chrome.runtime.connectNative = () => {
        if (globalThis.__nativeMode === 'throw') throw new Error('Native host not found');
        const port = { onMessage: event(), onDisconnect: event(), disconnect() { this.onDisconnect.fire(); },
          postMessage(message) {
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
              if (command === 'download') {
                const job = { id: ++globalThis.__nativeSequence, url: message.urls[0], name: message.name,
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
                else { globalThis.__nativeSettings = message.settings; result = message.settings; }
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
        tools: { yt_dlp: true, ffmpeg: true } });
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
    const panel = await openPanel(context, worker, source);
    await source.bringToFront();
    try { await panel.locator('#hostDot.online').waitFor({ timeout: 5000 }); }
    catch (error) {
      console.log('Panel diagnostic:', panel.url(), await panel.locator('body').innerText(),
        await worker.evaluate(() => chrome.storage.session.get(['host', 'nativeState'])));
      throw error;
    }
    await panel.waitForFunction(() => document.querySelector('#streamCount').textContent === '3');
    assert.equal(await panel.locator('.stream-card').count(), 3);
    assert.equal(await panel.locator('#addressCount').textContent(), 'Адресов: 4');
    await panel.screenshot({ path: path.join(artifacts, 'extension-streams.png'), fullPage: true });
    const master = panel.locator('.stream-card').filter({ has: panel.locator('select') });
    await master.locator('summary').click();
    await master.locator('select').selectOption(base + urls[0]);
    await master.getByRole('button', { name: 'Скачать', exact: true }).click();
    await panel.locator('.job.running').waitFor();
    const sent = await worker.evaluate(() => globalThis.__nativeCalls.findLast(message => message.command === 'download'));
    assert.equal(sent.urls[0], base + urls[0]);
    assert.equal(sent.source_kind, 'auto');
    await panel.getByRole('button', { name: 'Настройки', exact: true }).click();
    assert.equal(await panel.locator('#saveSettings').isDisabled(), true);
    await panel.locator('[data-view=jobs]').click();
    await panel.getByRole('button', { name: 'Отменить', exact: true }).click();
    await panel.locator('.job.cancelled').waitFor();
    await panel.getByRole('button', { name: 'Повторить', exact: true }).click();
    await panel.locator('.job.running').waitFor();
    await worker.evaluate(() => globalThis.__nativeFinish());
    await panel.locator('.job.done').waitFor();
    await panel.getByRole('button', { name: 'В Finder', exact: true }).click();
    assert.equal(await worker.evaluate(() => globalThis.__nativeCalls.at(-1).command), 'reveal');
    await panel.screenshot({ path: path.join(artifacts, 'extension-jobs.png'), fullPage: true });
    await panel.locator('[data-view=settings]').click();
    await panel.locator('#outputDir').fill('/tmp/Viddow/Saved');
    await panel.locator('#workers').selectOption('3');
    await panel.locator('#saveSettings').click();
    await panel.waitForFunction(() => document.querySelector('#message').textContent === 'Настройки сохранены');
    assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get('settings')), { settings: { workers: 3, output_dir: '/tmp/Viddow/Saved', youtube_browser: 'none' } });
    await panel.locator('#theme').click();
    await panel.screenshot({ path: path.join(artifacts, 'extension-settings-dark.png'), fullPage: true });
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.setViewportSize({ width: 320, height: 900 });
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    // Панель реагирует на другую активную вкладку, а общая очередь остаётся.
    const other = await context.newPage();
    await other.goto(base + '/other');
    await other.bringToFront();
    await panel.locator('[data-view=streams]').click();
    await panel.waitForFunction(() => document.querySelector('#tabTitle').textContent === 'Другая вкладка');
    assert.equal(await panel.locator('#streamsEmpty').isVisible(), true);
    await panel.locator('#manualUrl').fill(base + '/manual.mp4');
    await panel.locator('#manualUrl').press('Enter');
    await panel.locator('.job.running').waitFor();
    assert.equal(await worker.evaluate(() => globalThis.__nativeCalls.findLast(message => message.command === 'download').urls[0]), base + '/manual.mp4');
    await worker.evaluate(() => globalThis.__nativePort.disconnect());
    await panel.locator('#hostDot.offline').waitFor();
    assert.equal(await panel.locator('#hostError').isVisible(), true);
    const downloads = await worker.evaluate(() => globalThis.__nativeCalls.filter(message => message.command === 'download').length);
    const oldSession = await worker.evaluate(async () => (await chrome.storage.session.get('nativeState')).nativeState.session);
    for (const mode of ['throw', 'error', 'old', 'silent']) {
      await worker.evaluate(mode => { globalThis.__nativeMode = mode; }, mode);
      await panel.locator('#reconnect').click();
      await panel.locator('#hostDot.offline').waitFor();
      const host = await worker.evaluate(async () => (await chrome.storage.session.get('host')).host);
      assert.equal(host.status, 'offline');
      assert.match(host.error, mode === 'throw' ? /Помощник не подключён/ : mode === 'error' ? /Нет доступа к папке/ : mode === 'old' ? /несовместимый протокол/ : /не ответил/);
    }
    await worker.evaluate(() => { globalThis.__nativeMode = null; });
    await panel.locator('#reconnect').click(); await panel.locator('#hostDot.online').waitFor();
    const stale = await panel.evaluate(session => chrome.runtime.sendMessage({ type: 'clear', session }), oldSession);
    assert.equal(stale.ok, false);
    assert.match(stale.error, /Сессия/);
    assert.equal(await worker.evaluate(() => globalThis.__nativeCalls.filter(message => message.command === 'download').length), downloads);
    await panel.waitForFunction(() => document.querySelectorAll('.job.interrupted').length === 1);
    assert.equal(await panel.locator('#jobCount').textContent(), '3');
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('history'))).history.version, 1);

    // Неизвестная будущая схема не перезаписывается даже новыми задачами.
    const future = { version: 42, jobs: [], marker: 'leave-untouched' };
    await worker.evaluate(async value => { await chrome.storage.local.set({ history: value }); globalThis.__nativePort.disconnect(); }, future);
    await panel.locator('#hostDot.offline').waitFor();
    await panel.locator('#reconnect').click(); await panel.locator('#hostDot.online').waitFor();
    assert.match(await panel.locator('#historyStatus').textContent(), /более новой версией/);
    await panel.locator('[data-view=streams]').click(); await panel.locator('#manualUrl').fill(base + '/future.mp4'); await panel.locator('#manualUrl').press('Enter');
    await panel.locator('.job.running').waitFor();
    assert.deepEqual((await worker.evaluate(() => chrome.storage.local.get('history'))).history, future);

    // Миграция старого массива и пропуск повреждённой записи с диагностикой.
    const legacy = [{ id: 50, title: 'Legacy lesson', status: 'done', path: '/tmp/Viddow/legacy.mp4', source_page: base + '/other' }];
    await worker.evaluate(async value => { await chrome.storage.local.set({ history: value }); globalThis.__nativePort.disconnect(); }, legacy);
    await panel.locator('#hostDot.offline').waitFor(); await panel.locator('#reconnect').click(); await panel.locator('#hostDot.online').waitFor();
    const migrated = (await worker.evaluate(() => chrome.storage.local.get('history'))).history;
    assert.equal(migrated.version, 1); assert.equal(migrated.jobs[0].name, 'Legacy lesson');
    await worker.evaluate(async value => { await chrome.storage.local.set({ history: { version: 1, jobs: [null, ...value.jobs] } }); globalThis.__nativePort.disconnect(); }, migrated);
    await panel.locator('#hostDot.offline').waitFor(); await panel.locator('#reconnect').click();
    try { await panel.locator('#hostDot.online').waitFor({ timeout: 5000 }); }
    catch (error) {
      console.log('History UI diagnostic:', await panel.locator('body').innerText(), await panel.locator('#hostDot').getAttribute('class'), errors);
      console.log('History reconnect diagnostic:', await worker.evaluate(async () => ({
        stored: await chrome.storage.session.get(['host', 'historyStatus']),
        calls: globalThis.__nativeCalls.slice(-2), jobs: globalThis.__nativeJobs,
      })));
      throw error;
    }
    assert.match(await panel.locator('#historyStatus').textContent(), /повреждённые записи/);
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('history'))).history.jobs.length, 1);

    // Ошибка storage видна, не блокирует скачивание; новый итог повторяет запись.
    await worker.evaluate(() => {
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      globalThis.__historyWriteFails = true;
      chrome.storage.local.set = value => value.history && globalThis.__historyWriteFails
        ? Promise.reject(new Error('test storage error')) : original(value);
    });
    await panel.locator('[data-view=streams]').click(); await panel.locator('#manualUrl').fill(base + '/storage.mp4'); await panel.locator('#manualUrl').press('Enter');
    await panel.locator('.job.running').waitFor();
    assert.match(await panel.locator('#historyStatus.error').textContent(), /История не сохранена/);
    assert.equal(await panel.locator('#hostDot.online').isVisible(), true);
    await worker.evaluate(() => { globalThis.__historyWriteFails = false; globalThis.__nativeFinish(); });
    await panel.waitForFunction(() => !document.querySelector('#historyStatus').classList.contains('error'));
    const storedHistory = (await worker.evaluate(() => chrome.storage.local.get('history'))).history;
    assert.equal(storedHistory.jobs.at(-1).status, 'done');
    await worker.evaluate(() => globalThis.__nativeYoutubeError());
    await panel.locator('.job.error').getByRole('button', { name: 'Сеанс YouTube', exact: true }).click();
    await panel.locator('#youtubeBrowser').selectOption('vivaldi'); await panel.locator('#saveSettings').click();
    await panel.waitForFunction(() => document.querySelector('#message').textContent === 'Настройки сохранены');
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('settings'))).settings.youtube_browser, 'vivaldi');
    await panel.locator('[data-view=jobs]').click();
    await panel.locator('.job.error').getByRole('button', { name: 'Обновить ссылку', exact: true }).click();
    const freshYoutube = await worker.evaluate(() => globalThis.__nativeCalls.at(-1));
    assert.equal(freshYoutube.command, 'inspect'); assert.equal(freshYoutube.source_kind, 'page');
    assert.equal(freshYoutube.urls[0], 'https://www.youtube.com/watch?v=public_test');
    assert.deepEqual(errors, []);
    console.log('Extension smoke: PASS (capture, grouping, tabs, commands, settings, reconnect, history migration/corruption/future version/storage error)');
    console.log('Screenshots:', artifacts);
  } finally {
    if (context) await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
