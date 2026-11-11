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
  for (const [name, size] of [['low', '160x90'], ['high', '320x180']]) {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:r=10`, '-t', '1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-hls_time', '1', '-hls_list_size', '0', path.join(media, `${name}.m3u8`)]);
  }
  for (const [name, frequency] of [['ru', 440], ['en', 880]]) {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`, '-t', '1',
      '-c:a', 'aac', '-vn', '-hls_time', '1', '-hls_list_size', '0', path.join(media, `${name}.m3u8`)]);
  }
  const video = fs.readFileSync(path.join(media, 'video.mp4'));
  const requests = [];
  let historyGeneration = 1;
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
    if (url.pathname === '/inspect-slow.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); response.flushHeaders();
      const timer = setTimeout(() => response.end('#EXTM3U\n#EXT-X-ENDLIST\n'), 20000);
      response.on('close', () => clearTimeout(timer)); return;
    }
    let body, type;
    if (url.pathname.endsWith('.mp4')) { body = video; type = 'video/mp4'; }
    else if (url.pathname === '/quality/master.m3u8') {
      body = Buffer.from('#EXTM3U\n'
        + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Russian",LANGUAGE="ru",DEFAULT=YES,AUTOSELECT=YES,URI="/ru.m3u8"\n'
        + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="/en.m3u8"\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=160x90,CODECS="avc1.42c00b",AUDIO="audio"\n/low.m3u8\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.42c00c",AUDIO="audio"\n/high.m3u8\n');
      type = 'application/vnd.apple.mpegurl';
    } else if (url.pathname.endsWith('master.m3u8')) {
      body = Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=50000,RESOLUTION=64x64\n/media.m3u8\n');
      type = 'application/vnd.apple.mpegurl';
    } else if (/^\/(media|low|high|ru|en)(\d+\.ts|\.m3u8)$/.test(url.pathname)) {
      body = fs.readFileSync(path.join(media, url.pathname.slice(1)));
      type = url.pathname.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl';
    } else {
      const title = url.pathname === '/other' ? 'Другая вкладка' : url.pathname === '/window2' ? 'Второе окно' : 'Локальное видео';
      body = Buffer.from(`<title>${title}</title><h1>${title}</h1><video src="${url.pathname === '/slowpage' ? '/slow.mp4' : url.pathname === '/historywatch' ? `/video.mp4?token=history-generation-${historyGeneration}` : '/video.mp4'}" preload="none" controls></video>`);
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
    const launch = () => chromium.launchPersistentContext(profile, {
      headless: false, viewport: null, colorScheme: 'light',
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: ['--no-proxy-server', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    context = await launch();
    context.setDefaultTimeout(12000);
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
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
    assert.equal(await panel.getByRole('button', { name: 'В Finder', exact: true }).isVisible(), true);
    // Finder — настольное приложение пользователя. В обычном прогоне не открываем
    // окна; протокол reveal покрыт Python-тестом с подменой subprocess.run.
    if (process.env.VIDDOW_TEST_FINDER === '1') {
      await panel.getByRole('button', { name: 'В Finder', exact: true }).click();
      assert.equal(await panel.locator('#message.error').count(), 0);
    }

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

    // Этап 4: никаких запросов анализа до клика; точное качество + две озвучки.
    assert.equal((await state()).analysis, null);
    assert.equal(requests.some(request => request.path === '/quality/master.m3u8'), false);
    await panel.locator('[data-view=streams]').click();
    await panel.locator('#manualUrl').fill(base + '/quality/master.m3u8');
    await panel.locator('#inspectLink').click();
    await panel.locator('#analysisResult').waitFor();
    const analysis = (await state()).analysis;
    assert.equal(analysis.status, 'done');
    assert.equal(analysis.result.hls_kind, 'master');
    assert.equal((await state()).jobs.length, 3);
    const low = analysis.result.formats.find(format => format.height === 90 && format.kind === 'video');
    const ru = analysis.result.formats.find(format => format.language === 'ru' && format.kind === 'audio');
    const en = analysis.result.formats.find(format => format.language === 'en' && format.kind === 'audio');
    assert.ok(low && ru && en, JSON.stringify(analysis.result));
    await panel.locator('#videoFormat').selectOption(low.id);
    await panel.locator(`#audioFormats input[value="${ru.id}"]`).check();
    await panel.locator(`#audioFormats input[value="${en.id}"]`).check();
    await panel.setViewportSize({ width: 320, height: 900 });
    for (const theme of ['light', 'dark']) {
      if (await panel.locator('html').getAttribute('data-theme') !== theme) await panel.locator('#theme').click();
      assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await panel.locator('#analysisCard').scrollIntoViewIfNeeded();
      await panel.screenshot({ path: path.join(artifacts, `quality-${theme}-320.png`) });
    }
    // Переход по вкладке не подменяет источник завершённого анализа.
    await source.goto(base + '/other');
    await panel.waitForFunction(() => document.querySelector('#tabTitle').textContent === 'Другая вкладка');
    await panel.locator('#downloadFormat').click();
    await waitUntil(async () => (await state()).jobs.length === 4 && ['done', 'error'].includes((await state()).jobs[3].status), 'Selected format timeout', 20000);
    const selected = (await state()).jobs[3];
    assert.equal(selected.status, 'done', JSON.stringify(selected));
    assert.deepEqual(selected.format_ids, [low.id, ...analysis.result.formats.filter(format => [ru.id, en.id].includes(format.id)).map(format => format.id)]);
    assert.equal(selected.url, base + '/quality/master.m3u8');
    const tracks = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', selected.path], { encoding: 'utf8' })).streams;
    assert.equal(tracks.find(track => track.codec_type === 'video').height, 90);
    assert.equal(tracks.find(track => track.codec_type === 'video').width, 160);
    const audioTracks = tracks.filter(track => track.codec_type === 'audio');
    assert.equal(audioTracks.length, 2, JSON.stringify(tracks));
    assert.deepEqual(audioTracks.map(track => track.tags.language).sort(), ['eng', 'rus']);
    // Media HLS не получает выдуманных альтернатив/классификации по имени.
    await panel.locator('[data-view=streams]').click();
    await panel.locator('#manualUrl').fill(base + '/low.m3u8'); await panel.locator('#inspectLink').click();
    await waitUntil(async () => (await state()).analysis.status === 'done' && (await state()).analysis.id !== analysis.id, 'Media analysis');
    assert.equal((await state()).analysis.result.hls_kind, 'media');
    assert.equal((await state()).analysis.result.formats.length, 1);
    assert.equal((await send(panel, { type: 'download_selection', analysis_id: analysis.id, format_ids: [low.id], session: initialSession })).ok, false);
    await panel.locator('#manualUrl').fill(base + '/inspect-slow.m3u8'); await panel.locator('#inspectLink').click();
    await panel.locator('#cancelAnalysis').waitFor();
    assert.equal((await state()).analysis.status, 'running');
    // Команда download отвечает сразу, даже пока yt-dlp анализа ждёт сервер.
    await add(base + '/during-analysis.mp4');
    await waitUntil(async () => (await state()).jobs.some(job => job.url.endsWith('/during-analysis.mp4') && job.status === 'done'), 'Analysis blocked downloads');
    await panel.locator('[data-view=streams]').click(); await panel.locator('#cancelAnalysis').click();
    await waitUntil(async () => (await state()).analysis.status === 'cancelled', 'Analysis cancellation');
    await panel.locator('#manualUrl').fill(base + '/missing.mp4'); await panel.locator('#inspectLink').click();
    await panel.locator('#analysisStatus.error').waitFor();
    assert.equal(await panel.locator('#addLink').isEnabled(), true);
    assert.equal(await panel.locator('#page').isEnabled(), true);
    await source.goto(base + '/watch');
    console.log('PASS quality selection: exact 160×90 + Russian/English by ffprobe; media/master, stale analysis, cancellation, error, parallel download');

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
    if (process.env.VIDDOW_TEST_FINDER === '1') {
      assert.equal((await send(panel, { type: 'reveal', id: 1, session: initialSession })).ok, true);
    }
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

    // История результата и приватного прямого URL перед настоящим перезапуском.
    const historyPage = base + '/historywatch';
    assert.equal((await send(panel, { type: 'download', item: { url: historyPage, source_kind: 'page',
      headers: { Cookie: 'private-history-cookie', Authorization: 'Bearer private-history-auth' } },
      title: 'History lesson', page: historyPage })).ok, true);
    await waitUntil(async () => (await state()).jobs.some(job => job.url === historyPage && job.status === 'done'), 'History page download');
    const historical = (await state()).jobs.find(job => job.url === historyPage);
    await add(base + '/signed.mp4?signature=private-history-token');
    await waitUntil(async () => (await state()).jobs.some(job => job.url.includes('/signed.mp4') && job.status === 'done'), 'Signed fixture download');
    const signedSaved = (await state()).jobs.find(job => job.url.includes('/signed.mp4')).path;
    await add(base + '/missing.mp4?token=private-history-error');
    await waitUntil(async () => (await state()).jobs.some(job => job.status === 'error'), 'History error result');

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
    const interruptedId = (await state()).jobs.find(job => job.status === 'running').id;
    const beforeRestartSession = (await state()).session;
    const persisted = (await worker.evaluate(() => chrome.storage.local.get('history'))).history;
    assert.equal(persisted.version, 1);
    for (const secret of ['private-history-cookie', 'private-history-auth', 'private-history-token', 'private-history-error', 'history-generation-1']) {
      assert.equal(JSON.stringify(persisted).includes(secret), false, secret);
    }
    assert.deepEqual(errors, []);
    await context.close(); context = null;
    await waitUntil(() => [...hostPids, ...toolPids].every(pid => !alive(pid)), 'Native host or yt-dlp survived browser EOF');
    assert.equal(fs.readdirSync(newOutput).some(file => file.endsWith('.part')), false);
    console.log('PASS real host exits on browser close and removes partial files');

    // Тот же профиль, новый браузер и хост. Отсутствующий файл не теряет запись.
    fs.unlinkSync(historical.path); historyGeneration = 2;
    context = await launch(); context.setDefaultTimeout(12000);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const reopenedSource = await context.newPage(); await reopenedSource.goto(base + '/other');
    const beforeOpen = requests.length;
    panel = await openPanel(context, worker, reopenedSource); await panel.locator('#hostDot.online').waitFor();
    const restored = await state();
    assert.notEqual(restored.session, beforeRestartSession);
    assert.equal(restored.jobs.length, persisted.jobs.length);
    assert.equal(restored.jobs.every(job => job.restored), true);
    assert.equal(restored.jobs.find(job => job.id === interruptedId).status, 'interrupted');
    assert.equal(restored.jobs.find(job => job.id === historical.id).file_exists, false);
    assert.equal(restored.jobs.some(job => ['running', 'queued', 'cancelling'].includes(job.status)), false);
    assert.equal(requests.slice(beforeOpen).some(request => /\.mp4|\/historywatch|\/slowpage/.test(request.path)), false);
    assert.equal(restored.settings.output_dir, fs.realpathSync(newOutput)); assert.equal(restored.settings.workers, 2);
    assert.equal(await panel.locator('html').getAttribute('data-theme'), 'dark');
    await panel.locator('[data-view=jobs]').click();
    const oldCard = panel.locator(`.job[data-id="${historical.id}"]`);
    assert.match(await oldCard.locator('.job-status').textContent(), /файл не найден/);
    assert.equal(await oldCard.getByRole('button', { name: 'В Finder', exact: true }).count(), 0);
    const retryStart = requests.length;
    await oldCard.getByRole('button', { name: 'Повторить со страницы', exact: true }).click();
    await panel.locator('#analysisResult').waitFor();
    assert.equal((await state()).analysis.url, historyPage);
    assert.equal(requests.slice(retryStart).filter(request => request.path === '/historywatch').every(request => !request.headers.cookie && !request.headers.authorization), true);
    await panel.locator('#downloadFormat').click();
    await waitUntil(async () => (await state()).jobs.some(job => !job.restored && job.status === 'done'), 'Fresh history retry', 20000);
    assert.equal(requests.slice(retryStart).some(request => request.path === '/video.mp4?token=history-generation-2'), true);
    assert.equal(requests.slice(retryStart).some(request => request.path === '/video.mp4?token=history-generation-1'), false);
    const freshJob = (await state()).jobs.find(job => !job.restored && job.status === 'done');
    assert.ok(freshJob.id > Math.max(...persisted.jobs.map(job => job.id)));
    await panel.setViewportSize({ width: 320, height: 900 });
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.screenshot({ path: path.join(artifacts, 'history-restored-320.png') });
    await panel.locator('#clear').click();
    await waitUntil(async () => !(await state()).jobs.length, 'History clear');
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('history'))).history.jobs.length, 0);
    assert.ok(fs.existsSync(freshJob.path)); assert.ok(fs.existsSync(signedSaved));
    assert.deepEqual(errors, []);
    console.log('PASS real browser restart: done/error/interrupted, settings, missing file, fresh page retry, no secrets, clear preserves files');
    console.log('Native extension smoke: PASS; screenshots:', artifacts);
  } finally {
    if (context) await context.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
