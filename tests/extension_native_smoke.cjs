// Настоящие sidePanel → connectNative → Python → файл. Только временный профиль.
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { extensionPath, openPanel } = require('./extension_browser.cjs');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
  throw new Error(message);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'viddow-native-browser-'));
  const profile = path.join(temporary, 'profile');
  const output = path.join(temporary, 'Downloads');
  const media = path.join(temporary, 'media');
  const artifacts = process.env.VIDDOW_ARTIFACTS || path.join(os.tmpdir(), 'viddow-native-check');
  for (const folder of [output, media, artifacts]) fs.mkdirSync(folder, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=64x64:r=10',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(media, 'video.mp4')]);
  execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(media, 'video.mp4'), '-c', 'copy',
    '-hls_time', '1', '-hls_list_size', '0', path.join(media, 'media.m3u8')]);
  const video = fs.readFileSync(path.join(media, 'video.mp4'));
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    requests.push({ path: request.url, headers: request.headers });
    if (url.pathname === '/missing.mp4' || url.pathname === '/denied.mp4') {
      response.writeHead(url.pathname === '/missing.mp4' ? 404 : 403); response.end(); return;
    }
    if (url.pathname === '/slow.mp4') {
      const chunk = Buffer.alloc(65536, 1), count = 400;
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': chunk.length * count });
      let sent = 0;
      const timer = setInterval(() => { response.write(chunk); if (++sent === count) { clearInterval(timer); response.end(); } }, 30);
      response.on('close', () => clearInterval(timer)); return;
    }
    let body, type;
    if (url.pathname.endsWith('.mp4')) { body = video; type = 'video/mp4'; }
    else if (url.pathname.endsWith('master.m3u8')) {
      body = Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=50000,RESOLUTION=64x64\n/media.m3u8\n');
      type = 'application/vnd.apple.mpegurl';
    } else if (url.pathname === '/media.m3u8' || url.pathname === '/media0.ts') {
      body = fs.readFileSync(path.join(media, url.pathname.slice(1)));
      type = url.pathname.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl';
    } else {
      const title = url.pathname === '/other' ? 'Другая вкладка' : url.pathname === '/window2' ? 'Второе окно' : 'Локальное видео';
      body = Buffer.from(`<title>${title}</title><h1>${title}</h1><video src="${url.pathname === '/slowpage' ? '/slow.mp4' : '/video.mp4'}" preload="none" controls></video>`);
      type = 'text/html; charset=utf-8';
    }
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  let context;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    execFileSync('python3', ['install_native_host.py', '--user-data-dir', profile], { cwd: root });
    const manifestPath = path.join(profile, 'NativeMessagingHosts/local.video_downloader.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    assert.equal(manifest.path, path.join(root, 'native_host.sh'));
    // Обёртка только записывает PID, затем exec запускает неизменённый реальный хост.
    const wrapper = path.join(temporary, 'record-host.sh'), pidsFile = path.join(temporary, 'host-pids');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(pidsFile)}\nexec ${quote(manifest.path)}\n`, { mode: 0o755 });
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, path: wrapper }));
    context = await chromium.launchPersistentContext(profile, {
      headless: false, viewport: null, colorScheme: 'light',
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: ['--no-proxy-server', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    context.setDefaultTimeout(12000);
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.ok(manifest.allowed_origins.includes(`chrome-extension://${new URL(worker.url()).host}/`));
    await worker.evaluate(settings => chrome.storage.local.set({ settings }), { workers: 1, output_dir: output });
    const state = () => worker.evaluate(async () => (await chrome.storage.session.get('nativeState')).nativeState);
    const send = (page, message) => page.evaluate(message => chrome.runtime.sendMessage(message), message);
    const source = await context.newPage(); await source.goto(base + '/watch');
    let panel = await openPanel(context, worker, source);
    await panel.locator('#hostDot.online').waitFor();
    assert.equal((await state()).settings.workers, 1);
    assert.equal((await state()).tools.yt_dlp, true);
    assert.equal((await state()).tools.ffmpeg, true);
    const initialSession = (await state()).session;
    const add = async (url, current = panel) => {
      await current.locator('[data-view=streams]').click();
      await current.locator('#manualUrl').fill(url); await current.locator('#manualUrl').press('Enter');
      await current.locator('#jobsView').waitFor();
    };
    await add(base + '/video.mp4');
    await panel.locator('.job.done').waitFor();
    const saved = (await state()).jobs[0].path;
    assert.deepEqual(fs.readFileSync(saved), video);
    console.log('PASS real sidePanel → native host → MP4 (byte comparison)');
    await panel.getByRole('button', { name: 'В Finder', exact: true }).click();
    assert.equal(await panel.locator('#message.error').count(), 0);

    // Настоящий yt-dlp: явная команда страницы, поддерживаемая generic extractor.
    await panel.locator('[data-view=streams]').click(); await panel.locator('#page').click();
    await waitUntil(async () => (await state()).jobs.length === 2 && (await state()).jobs[1].status === 'done', 'yt-dlp page: ' + JSON.stringify(await state()));
    assert.deepEqual(fs.readFileSync((await state()).jobs[1].path), video);

    // Полный выбранный URL, разные пути и свежие браузерные заголовки.
    const urls = ['/lesson/master.m3u8?token=one', '/lesson/master.m3u8?token=two', '/other/master.m3u8'];
    await source.evaluate(async urls => {
      for (const url of urls) await fetch(url, { headers: { 'X-Viddow': 'old' } });
      await fetch(urls[0], { headers: { 'X-Viddow': 'fresh' } });
    }, urls);
    await panel.locator('[data-view=streams]').click();
    await panel.waitForFunction(() => document.querySelector('#addressCount').textContent === 'Адресов: 3');
    assert.equal(await panel.locator('.stream-card').count(), 2);
    const group = panel.locator('.stream-card').filter({ has: panel.locator('select') });
    await group.locator('summary').click(); await group.locator('select').selectOption(base + urls[0]);
    const before = requests.length;
    await group.getByRole('button', { name: 'Скачать', exact: true }).click();
    await waitUntil(async () => (await state()).jobs.length === 3 && ['done', 'error'].includes((await state()).jobs[2].status), 'HLS timeout');
    assert.equal((await state()).jobs[2].status, 'done', JSON.stringify((await state()).jobs[2]));
    assert.ok(requests.slice(before).some(request => request.path === urls[0] && request.headers['x-viddow'] === 'fresh'));
    const hlsPath = (await state()).jobs[2].path;
    assert.match(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', hlsPath], { encoding: 'utf8' }), /64,64/);
    console.log('PASS actual yt-dlp page and HLS with selected query and fresh headers');

    await add(base + '/slow.mp4');
    await panel.locator('.job.running').waitFor();
    await panel.waitForFunction(() => Number(document.querySelector('.job.running [role=progressbar]').getAttribute('aria-valuenow')) > 0);
    await add(base + '/slow.mp4?waiting=1'); await panel.locator('.job.queued').waitFor();
    assert.equal((await state()).jobs.filter(job => job.status === 'running').length, 1);
    const queued = (await state()).jobs.find(job => job.status === 'queued');
    await panel.locator('.job.queued').getByRole('button', { name: 'Отменить' }).click();
    await panel.locator(`.job[data-id="${queued.id}"].cancelled`).waitFor();
    assert.equal(requests.some(request => request.path.includes('waiting=1')), false);
    const refused = await send(panel, { type: 'configure', settings: { workers: 3, output_dir: output } });
    assert.equal(refused.ok, false);
    assert.equal((await state()).settings.workers, 1);

    // Закрытие UI не закрывает канал: PID, сессия, прогресс и очередь сохраняются.
    const running = (await state()).jobs.find(job => job.status === 'running');
    await panel.evaluate(async () => chrome.sidePanel.close({ windowId: (await chrome.windows.getCurrent()).id }));
    await waitUntil(async () => (await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }))).length === 0, 'Panel did not close');
    assert.equal((await state()).session, initialSession);
    panel = await openPanel(context, worker, source); await panel.locator('#hostDot.online').waitFor();
    await panel.locator('[data-view=jobs]').click();
    await panel.locator(`.job[data-id="${running.id}"].running`).waitFor();
    await panel.locator('.job.running').getByRole('button', { name: 'Отменить' }).click();
    await panel.locator(`.job[data-id="${running.id}"].cancelled`).waitFor();
    await panel.locator(`.job[data-id="${running.id}"]`).getByRole('button', { name: 'Повторить' }).click();
    await panel.locator('.job.running').waitFor();
    await panel.locator('.job.running').getByRole('button', { name: 'Отменить' }).click();
    await waitUntil(async () => (await state()).jobs.every(job => !['running', 'queued', 'cancelling'].includes(job.status)), 'Cancellation timeout');
    assert.equal(fs.readdirSync(output).some(file => file.endsWith('.part')), false);

    const other = await context.newPage(); await other.goto(base + '/other'); await other.bringToFront();
    await panel.waitForFunction(() => document.querySelector('#tabTitle').textContent === 'Другая вкладка');
    await other.goto(base + '/watch');
    await panel.waitForFunction(() => document.querySelector('#tabTitle').textContent === 'Локальное видео');
    const [secondSource] = await Promise.all([context.waitForEvent('page'), worker.evaluate(url => chrome.windows.create({ url }), base + '/window2')]);
    await secondSource.waitForLoadState();
    const secondPanel = await openPanel(context, worker, secondSource);
    await secondPanel.waitForFunction(() => document.querySelector('#tabTitle').textContent === 'Второе окно');
    assert.equal(await panel.locator('#tabTitle').textContent(), 'Локальное видео');
    assert.equal(await secondPanel.locator('#jobCount').textContent(), String((await state()).jobs.length));
    assert.equal((await state()).session, initialSession);
    console.log('PASS queue limit, progress, queued cancel, retry, panel reopen, two windows');

    const newOutput = path.join(temporary, 'New folder');
    await panel.locator('[data-view=settings]').click();
    await panel.locator('#outputDir').fill(newOutput); await panel.locator('#workers').selectOption('2');
    await panel.locator('#saveSettings').click();
    await panel.waitForFunction(() => document.querySelector('#message').textContent === 'Настройки сохранены');
    await add(base + '/new.mp4');
    await waitUntil(async () => (await state()).jobs.some(job => job.url.endsWith('/new.mp4') && job.status === 'done'), 'New folder download');
    const newSaved = (await state()).jobs.find(job => job.url.endsWith('/new.mp4')).path;
    assert.equal(path.dirname(newSaved), fs.realpathSync(newOutput)); assert.ok(fs.existsSync(saved));
    assert.equal((await send(panel, { type: 'reveal', id: 1, session: initialSession })).ok, true);
    for (const name of ['missing', 'denied']) {
      await add(base + `/${name}.mp4`);
      await waitUntil(async () => (await state()).jobs.some(job => job.url.endsWith(`/${name}.mp4`) && job.status === 'error'), name + ' error missing');
    }
    // Шесть снимков реальной панели: три раздела × две темы, ширина 320 px.
    await panel.setViewportSize({ width: 320, height: 900 });
    for (const theme of ['light', 'dark']) {
      if (await panel.locator('html').getAttribute('data-theme') !== theme) await panel.locator('#theme').click();
      for (const view of ['streams', 'jobs', 'settings']) {
        await panel.locator(`[data-view=${view}]`).click();
        await panel.evaluate(() => scrollTo(0, 0));
        assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await panel.screenshot({ path: path.join(artifacts, `${view}-${theme}-320.png`) });
      }
    }
    await panel.locator('[data-view=jobs]').click();
    await panel.locator('#clear').click();
    await waitUntil(async () => !(await state()).jobs.length, 'Clear did not finish');
    assert.ok(fs.existsSync(saved)); assert.ok(fs.existsSync(newSaved));

    // Настоящий разрыв порта и отсутствие регистрации, без изменения профиля пользователя.
    const firstPid = Number(fs.readFileSync(pidsFile, 'utf8').trim());
    fs.renameSync(manifestPath, manifestPath + '.disabled');
    process.kill(firstPid, 'SIGTERM');
    await panel.locator('#hostDot.offline').waitFor();
    await panel.locator('#reconnect').click(); await panel.locator('#hostDot.offline').waitFor();
    assert.match(await panel.locator('#hostError').textContent(), /install_native_host.py/);
    fs.renameSync(manifestPath + '.disabled', manifestPath);
    await panel.locator('#reconnect').click(); await panel.locator('#hostDot.online').waitFor();
    await waitUntil(async () => (await state()).session !== initialSession, 'Native session did not change');
    assert.equal((await state()).jobs.length, 0);
    const stale = await send(panel, { type: 'clear', session: initialSession });
    assert.equal(stale.ok, false);
    assert.equal((await state()).settings.output_dir, fs.realpathSync(newOutput));
    console.log('PASS actual missing host, reconnect, persisted settings, no automatic restart');

    // EOF должен остановить не только хост, но и реальный yt-dlp в его группе.
    await other.goto(base + '/slowpage'); await other.bringToFront();
    await panel.waitForFunction(() => document.querySelector('#tabTitle').textContent === 'Локальное видео');
    await panel.locator('[data-view=streams]').click(); await panel.locator('#page').click();
    await panel.locator('.job.running').waitFor();
    await waitUntil(() => fs.readdirSync(newOutput).some(file => file.endsWith('.part')), 'No partial file');
    const hostPids = fs.readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number);
    assert.equal(hostPids.length, 2);
    const descendants = () => {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
      return rows.filter(([, parent]) => parent === hostPids[1]).map(([pid]) => pid);
    };
    await waitUntil(() => descendants().length > 0, 'yt-dlp did not start');
    const toolPids = descendants();
    assert.deepEqual(errors, []);
    await context.close(); context = null;
    await waitUntil(() => [...hostPids, ...toolPids].every(pid => !alive(pid)), 'Native host or yt-dlp survived browser EOF');
    assert.equal(fs.readdirSync(newOutput).some(file => file.endsWith('.part')), false);
    console.log('PASS real host exits on browser close and removes partial files');
    console.log('Native extension smoke: PASS; screenshots:', artifacts);
  } finally {
    if (context) await context.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
