// Unsupported HTML -> real yt-dlp candidate batch -> GIF -> one-button download.
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
async function waitFor(fn, title, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error(title);
}
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'viddow-auto-native-'));
  const profile = path.join(temp, 'profile'), output = path.join(temp, 'Downloads'); fs.mkdirSync(output);
  const requests = [], errors = []; let context, server;
  const artifacts = process.env.VIDDOW_ARTIFACTS || '/tmp/viddow-auto-native'; fs.mkdirSync(artifacts, { recursive: true });
  try {
    for (const [name, size, color] of [['high', '1280x720', 'blue'], ['unknown', '160x90', 'green']]) {
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=24`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264',
        '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-g', '24', '-hls_time', '1',
        '-hls_list_size', '0', path.join(temp, `${name}.m3u8`)]);
    }
    let base;
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://fixture'); requests.push({ path: request.url, headers: request.headers });
      let data, type = 'text/html; charset=utf-8';
      if (['/', '/early', '/second'].includes(url.pathname)) {
        data = '<!doctype html><title>Выбранная серия</title><video style="width:320px;height:180px" controls></video><script src="/app.js"></script>';
      } else if (url.pathname === '/app.js') {
        type = 'application/javascript'; data = `window.discover = async () => { await Promise.all(['unknown', 'high'].map(name => fetch('/'+name+'/master.m3u8?token='+name, {headers: {'X-Video':name}}))); document.querySelector('video').poster='/poster.svg'; }; if(location.pathname!='/early') discover();`;
      } else if (url.pathname === '/poster.svg') {
        type = 'image/svg+xml'; data = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>';
      } else if (/^\/(high|unknown)\/master.m3u8$/.test(url.pathname)) {
        const name = url.pathname.split('/')[1]; type = 'application/vnd.apple.mpegurl';
        data = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=921000' + (name === 'high' ? ',RESOLUTION=1280x720,FRAME-RATE=22500,CODECS="avc1.42e01f,mp4a.40.2"' : '') + `\n/${name}.m3u8?token=${name}\n`;
      } else if (/^\/(high|unknown)(\.m3u8|\d+\.ts)$/.test(url.pathname)) {
        const name = url.pathname.startsWith('/high') ? 'high' : 'unknown';
        if (request.headers['x-video'] !== name) { response.writeHead(403); response.end(); return; }
        type = url.pathname.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl'; data = fs.readFileSync(path.join(temp, url.pathname.slice(1)));
      } else { response.writeHead(404); response.end(); return; }
      const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length }); response.end(request.method === 'HEAD' ? undefined : body);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
    execFileSync('python3', ['install_native_host.py', '--user-data-dir', profile], { cwd: root });
    context = await chromium.launchPersistentContext(profile, { headless: false, viewport: null,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: ['--no-proxy-server', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    context.setDefaultTimeout(25000);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(settings => chrome.storage.local.set({ settings }), { output_dir: output, workers: 1 });
    const state = () => worker.evaluate(async () => (await chrome.storage.session.get('nativeState')).nativeState);
    const source = await context.newPage(); await source.goto(base + '/');
    const panel = await openPanel(context, worker, source);
    await waitFor(async () => (await state())?.analysis?.status === 'done', 'No automatic recovery').catch(async error => { console.error(await state()); console.error(await panel.locator('body').innerText()); throw error; });
    let analysis = (await state()).analysis;
    assert.match(analysis.url, /\/high\/master.m3u8\?token=high$/);
    assert.equal(analysis.result.formats.some(format => format.height === 720), true);
    assert.equal(analysis.result.formats.some(format => format.fps === 22500), false);
    assert.equal((await state()).jobs.length, 0, 'preparing must not download the full video');
    await panel.locator('#analysisResult').waitFor();
    await panel.waitForFunction(() => document.querySelector('#videoThumbnail').src.startsWith('data:image/gif;base64,'));
    assert.equal(await panel.locator('#videoChoice option').count(), 2);
    assert.equal(await panel.locator('#formatDetails').textContent().then(text => text.includes('22500')), false);
    const firstAnalysisId = analysis.id;
    // A second panel shares the completed batch, not another extraction.
    const [secondSource] = await Promise.all([context.waitForEvent('page'), worker.evaluate(url => chrome.windows.create({ url }), base + '/second')]);
    await secondSource.waitForLoadState();
    const second = await openPanel(context, worker, secondSource); await second.locator('#analysisResult').waitFor();
    await source.bringToFront();
    assert.equal((await state()).analysis.id, firstAnalysisId);
    await panel.locator('#downloadFormat').click();
    await waitFor(async () => (await state()).jobs[0]?.status === 'done', 'Recommended video did not download: ' + JSON.stringify(await state()));
    const job = (await state()).jobs[0]; assert.match(job.url, /\/high\/master.m3u8\?token=high$/);
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', job.path], { encoding: 'utf8' })).streams;
    assert.equal(streams.find(stream => stream.codec_type === 'video').height, 720);
    assert.ok(streams.some(stream => stream.codec_type === 'audio'));
    assert.ok(requests.some(request => request.path.startsWith('/high0.ts') && request.headers['x-video'] === 'high'));
    const image = await panel.locator('#videoThumbnail').getAttribute('src');
    fs.writeFileSync(path.join(artifacts, 'preview.gif'), Buffer.from(image.split(',')[1], 'base64'));
    const gif = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', path.join(artifacts, 'preview.gif')], { encoding: 'utf8' })).streams[0];
    assert.ok(gif.width <= 320 && gif.height <= 180 && Number(gif.nb_frames) > 1 && Number(gif.nb_frames) <= 8);
    assert.ok(image.length <= 128 * 1024);
    const storage = await worker.evaluate(async () => JSON.stringify({ ...(await chrome.storage.local.get(null)), ...(await chrome.storage.session.get(null)) }));
    assert.equal(storage.includes('data:image/gif'), false, 'GIF must not enter history or full native state');
    await panel.setViewportSize({ width: 400, height: 900 }); await panel.screenshot({ path: path.join(artifacts, 'recommended-400.png'), fullPage: true });
    // Explicit alternative selects its own format and source without re-analysis.
    const other = analysis.result.videos.find(video => video.id !== analysis.result.source_id);
    await panel.locator('#videoChoice').selectOption(other.id); await panel.locator('#downloadFormat').click();
    await waitFor(async () => (await state()).jobs[1]?.status === 'done', 'Alternative video did not download');
    assert.match((await state()).jobs[1].url, /\/unknown\/master.m3u8/);
    // Click while the unsupported page is still waiting; discover streams afterwards.
    await source.goto(base + '/early');
    await panel.locator('#closeAnalysis').click();
    await panel.waitForFunction(() => document.querySelector('#tabTitle').textContent === 'Выбранная серия' && !document.querySelector('#inspectPage').disabled);
    await panel.locator('#inspectPage').click();
    await source.evaluate(() => window.discover());
    await waitFor(async () => (await state()).jobs.length === 3 && (await state()).jobs[2].status === 'done', 'Pending one-click download failed: ' + JSON.stringify(await state()));
    assert.match((await state()).jobs[2].url, /\/high\/master.m3u8/);
    // Regression: the DOM bridge can fail to answer before native inspection starts.
    // The worker deadline must still release the panel and let the page analysis end.
    await source.goto(base + '/early?stalled-context=1');
    await worker.evaluate(() => {
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      let stalled = false;
      chrome.scripting.executeScript = options => {
        if (!stalled && options.files?.includes('page-preview.js')) { stalled = true; return new Promise(() => {}); }
        return original(options);
      };
    });
    await panel.locator('#closeAnalysis').click();
    const beforeStalled = (await state()).analysis.id;
    await panel.locator('#inspectPage').click();
    await waitFor(async () => { const analysis = (await state()).analysis; return analysis.id !== beforeStalled && analysis.status === 'error'; }, 'DOM bridge left preparation stuck', 10000);
    await panel.waitForFunction(() => !document.querySelector('#inspectLink').disabled);
    const log = await worker.evaluate(async () => (await chrome.storage.session.get('diagnosticLog')).diagnosticLog);
    assert.ok(log.some(row => row.event === 'page_context_unavailable' && row.elapsed_ms >= 2800), 'context timeout must be visible without URLs in diagnostics');
    assert.deepEqual(errors, []);
    console.log('PASS real automatic fallback: two candidates, 720p+sound recommendation, GIF, two panels, exact-source download, alternative choice, early one-click intent, stalled DOM bridge deadline');
    console.log('Artifacts: ' + artifacts);
  } finally {
    await context?.close(); if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
