// Real extension/isolated worlds, disposable profile, loopback only; no native host.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { extensionPath, openPanel } = require('./extension_browser.cjs');
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';
(async () => {
  const { visibleMedia, selectMedia } = await import('../extension/media-model.mjs');
  const root = path.join(__dirname, 'fixtures/media-identity');
  const servers = [], profile = fs.mkdtempSync(path.join(os.tmpdir(), 'viddow-identity-'));
  let context, cross;
  const handler = (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/') response.end(fs.readFileSync(path.join(root, 'top.html')));
    else if (url.pathname === '/feed') response.end(fs.readFileSync(path.join(root, 'feed.html')));
    else if (url.pathname.endsWith('.m3u8')) { response.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); response.end('#EXTM3U\n#EXT-X-ENDLIST\n'); }
    else if (url.pathname === '/wrapper') response.end(`<iframe style="width:380px;height:220px" src="${cross}/player?${url.searchParams}"></iframe>`);
    else if (url.pathname === '/player') response.end(fs.readFileSync(path.join(root, 'player.html')));
    else if (/^\/episode-[12]\.mp4$/.test(url.pathname)) { response.setHeader('Content-Type', 'video/mp4'); response.end(fs.readFileSync(path.join(root, url.pathname.slice(1)))); }
    else if (url.pathname.endsWith('.svg')) { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="green"/></svg>'); }
    else { response.statusCode = 404; response.end(); }
  };
  try {
    for (let i = 0; i < 2; i++) { const server = http.createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
    const base = `http://127.0.0.1:${servers[0].address().port}`;
    cross = `http://127.0.0.1:${servers[1].address().port}`;
    context = await chromium.launchPersistentContext(profile, { headless: false,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: ['--no-proxy-server', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    context.setDefaultTimeout(15000);
    await context.route(/^https?:/,  route => /^https?:\/\/127\.0\.0\.1:/.test(route.request().url()) ? route.continue() : route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const source = await context.newPage(); await source.goto(base); await source.waitForLoadState('load');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, source.url());
    const collect = () => worker.evaluate(async tabId => {
      const target = { tabId, allFrames: true };
      await chrome.scripting.executeScript({ target, files: ['page-preview.js'] });
      return chrome.scripting.executeScript({ target, func: () => globalThis.__viddowReadPreview() });
    }, tabId);
    await worker.evaluate(() => { chrome.runtime.connectNative = () => { throw new Error('Native disabled in identity fixture'); }; });
    const panel = await openPanel(context, worker, source);
    await panel.evaluate(() => { document.documentElement.style.width = '320px'; document.body.style.width = '320px'; });
    await panel.waitForFunction(() => document.querySelector('#pageFacts').textContent.includes('0:02'));
    let frames = await collect(), candidates = visibleMedia(tabId, frames);
    assert.equal(frames.length, 5, 'top + two wrappers + two cross-origin players');
    assert.equal(candidates.length, 1, 'hidden wrapper excludes backup grandchild');
    assert.equal(candidates[0].duration, 2);
    assert.match(candidates[0].poster, /episode-1.svg$/);
    const player = source.frames().find(frame => frame.url().startsWith(`${cross}/player?player=visible`));
    assert.ok(player);
    await player.evaluate(() => fetch('/capture.m3u8?token=complete').then(response => response.text()));
    const captured = await worker.evaluate(async tabId => (await chrome.storage.session.get(`tab_${tabId}`))[`tab_${tabId}`], tabId);
    const stream = captured.find(item => item.url.includes('/capture.m3u8?token=complete'));
    assert.ok(stream, 'webRequest captured iframe stream with full query');
    assert.equal(stream.frameId, candidates[0].frameId);
    assert.equal(stream.documentId, candidates[0].documentId);
    assert.equal(selectMedia(candidates, stream), null, 'manifest fetch does not prove relation to a video in the same frame');

    await player.waitForFunction(() => document.querySelector('video').readyState >= 2);
    const playbackBefore = await player.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, time: v.currentTime }; });
    await panel.waitForFunction(() => document.querySelector('#pageThumbnail').src.startsWith('data:image/jpeg;base64,'));
    const firstImage = await panel.locator('#pageThumbnail').getAttribute('src');
    assert.equal(await panel.locator('#pageThumbnail').getAttribute('alt'), 'Кадр выбранного видео');
    assert.deepEqual(await player.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, time: v.currentTime }; }), playbackBefore);
    const selected = { key: candidates[0].key };
    await source.locator('#backup').evaluate(node => node.classList.remove('concealed'));
    candidates = visibleMedia(tabId, await collect());
    assert.equal(candidates.length, 2);
    assert.equal(selectMedia(candidates), null, 'two visible frames ambiguous');
    await panel.waitForFunction(() => document.querySelector('#playerChoice').options.length === 3);
    assert.equal(await panel.locator('#pageThumbnail').isHidden(), true);
    assert.equal(await panel.locator('#playerImages button img').count(), 2);
    await panel.locator('#playerChoice').selectOption(selected.key);
    await panel.waitForFunction(() => document.querySelector('#pageFacts').textContent.includes('0:02'));
    assert.equal(selectMedia(candidates, selected).key, selected.key);
    await player.evaluate(() => window.addSecond());
    candidates = visibleMedia(tabId, await collect());
    assert.equal(candidates.length, 3, 'multiple video per document have separate keys');
    assert.equal(selectMedia(candidates, selected).key, selected.key);
    frames = await collect();
    await player.evaluate(() => window.changeEpisode());
    await player.waitForFunction(() => document.querySelector('video').duration === 4);
    const latest = await collect();
    assert.equal(visibleMedia(tabId, frames, latest).some(media => media.key === selected.key), false, 'late episode result rejected');
    candidates = visibleMedia(tabId, latest);
    assert.equal(selectMedia(candidates, selected), null, 'old explicit selection does not switch to backup');
    await panel.waitForFunction(() => document.querySelector('#playerChoice option').textContent.includes('недоступен'));
    assert.equal(await panel.locator('#pageThumbnail').isHidden(), true);
    assert.ok(candidates.some(media => media.duration === 4 && media.poster.endsWith('episode-2.svg')));
    const episode2 = candidates.find(media => media.duration === 4);
    await panel.locator('#playerChoice').selectOption(episode2.key);
    await panel.waitForFunction(image => { const img = document.querySelector('#pageThumbnail'); return !img.hidden && img.src.startsWith('data:image/jpeg;base64,') && img.src !== image; }, firstImage);
    // Same video DOM element, cross-origin media without CORS: no canvas frame.
    await player.evaluate(base => { const v = document.querySelector('video'); v.src = `${base}/episode-1.mp4?cors=denied`; v.load(); }, base);
    await player.waitForFunction(() => document.querySelector('video').readyState >= 2);
    const tainted = visibleMedia(tabId, await collect()).find(media => media.src.includes('cors=denied'));
    await panel.waitForFunction(key => [...document.querySelector('#playerChoice').options].some(option => option.value === key), tainted.key);
    await panel.locator('#playerChoice').selectOption(tainted.key);
    await panel.waitForFunction(() => document.querySelector('#pageThumbnail').getAttribute('alt') === 'Постер выбранного видео');
    assert.match(await panel.locator('#pageThumbnail').getAttribute('src'), /episode-2.svg$/);

    await source.locator('#primary').evaluate(node => node.style.visibility = 'hidden');
    assert.equal(visibleMedia(tabId, await collect()).length, 1, 'ancestor visibility hides both video');
    await source.reload();
    assert.equal(visibleMedia(tabId, latest, await collect()).length, 0, 'late navigation result rejected');
    await source.goto(`${base}/feed`);
    await source.waitForFunction(() => document.querySelectorAll('video').length === 30 && [...document.querySelectorAll('video')].every(video => video.readyState >= 2));
    await panel.waitForFunction(() => document.querySelectorAll('#playerImages button').length === 30);
    const last = await panel.locator('#playerImages button').last().getAttribute('data-key');
    await panel.locator('#playerChoice').selectOption(last);
    await panel.waitForFunction(() => document.querySelector('#pageThumbnail').src.startsWith('data:image/jpeg;base64,') && !document.querySelector('#pageThumbnail').hidden);
    assert.equal(await panel.locator('#playerImages button[aria-pressed="true"]').getAttribute('data-key'), last);
    await panel.waitForFunction(() => { const container = document.querySelector('#playerImages'), bounds = container.getBoundingClientRect(); return [...container.children].filter(button => { const rect = button.getBoundingClientRect(); return rect.top < bounds.bottom && rect.bottom > bounds.top; }).every(button => button.querySelector('img').src.startsWith('data:image/jpeg;base64,')); });
    assert.equal(await source.evaluate(() => [...document.querySelectorAll('video')].every(video => video.paused && video.currentTime === 0)), true);
    const artifacts = process.env.VIDDOW_ARTIFACTS || '/tmp/viddow-media-identity'; fs.mkdirSync(artifacts, { recursive: true });
    for (const [width, theme] of [[320, 'light'], [400, 'dark']]) {
      await panel.evaluate(({ width, theme }) => { document.documentElement.style.width = `${width}px`; document.body.style.width = `${width}px`; document.documentElement.dataset.theme = theme; }, { width, theme });
      assert.equal(await panel.evaluate(() => document.body.scrollWidth <= document.body.clientWidth), true);
      await panel.locator('body').screenshot({ path: path.join(artifacts, `feed-${width}-${theme}.png`) });
    }
    console.log('PASS media identity: thirty-player feed, selected frame, CORS fallback, no play/seek; nesting, hidden ancestors, ambiguity, explicit choice, episode and document freshness');
  } finally {
    await context?.close(); for (const server of servers) await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
