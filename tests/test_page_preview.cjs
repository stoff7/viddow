const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../extension/page-preview.js'), 'utf8');
function fixture(videos = [], metadata = {}, canvasFactory = () => { throw new Error("unexpected capture"); }) {
  const events = {};
  const context = vm.createContext({ URL, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout,
    location: { href: 'https://example.test/watch' },
    window: { addEventListener() {} }, getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1', ...node.style }),
    chrome: { runtime: { sendMessage: async () => {} } },
    document: { createElement: canvasFactory, baseURI: 'https://example.test/watch', documentElement: {},
      querySelectorAll: selector => selector === 'video' ? videos : [],
      querySelector: selector => ({ content: metadata[selector.match(/"([^"]+)"/)[1]] || '' }),
      addEventListener: (name, callback) => { events[name] = callback; } },
    MutationObserver: class { observe() {} },
  });
  return { read: () => vm.runInContext(source, context), capture: requests => context.__viddowReadPreview(true, requests), events };
}
const video = values => ({ tagName: 'VIDEO', duration: NaN, poster: '', currentSrc: '', getClientRects: () => [{}], ...values });
test('player fields belong to a stable document/media identity, page artwork stays separate', async () => {
  const f = fixture([video({ duration: 125.5, poster: '/cover.jpg', currentSrc: 'https://cdn.test/a?token=1' })], { 'og:image': '/page.jpg' });
  const first = await f.read(), second = await f.read();
  assert.equal(first.documentToken, second.documentToken);
  assert.equal(first.media[0].poster, 'https://example.test/cover.jpg');
  assert.equal(first.media[0].duration, 125.5);
  assert.equal(first.pageImage, 'https://example.test/page.jpg');
  assert.equal(first.media[0].generation, second.media[0].generation);
});
test('hidden ancestor excludes video; several visible video remain independent', async () => {
  const result = await fixture([video({ parentElement: { hidden: true } }), video({ duration: 20 }), video({ duration: 30 })]).read();
  assert.equal(result.media.length, 3);
  assert.equal(result.media[0].visible, false);
  assert.notEqual(result.media[1].id, result.media[2].id);
});
test('src change and emptied advance generation, invalid duration and image stay unknown', async () => {
  const player = video({ poster: 'javascript:alert(1)', duration: Infinity });
  const f = fixture([player]);
  const first = (await f.read()).media[0];
  assert.equal(first.poster, ''); assert.equal(first.duration, null); assert.equal(first.isLive, true);
  player.currentSrc = 'blob:https://example.test/episode-2';
  const next = (await f.read()).media[0];
  assert.equal(next.generation, first.generation + 1);
  f.events.emptied({ type: 'emptied', target: player });
  assert.equal((await f.read()).media[0].generation, next.generation + 1);
  player.src = 'https://example.test/next-episode';
  assert.equal((await f.read()).media[0].generation, next.generation + 2, 'src changes invalidate even while currentSrc still refers to the old resource');
});

test('only requested decoded frames are captured, bounded and released without playback or seeking', async () => {
  const player = video({ readyState: 2, videoWidth: 1920, videoHeight: 1080, play() { throw new Error('play forbidden'); } });
  let draws = 0, canvas;
  Object.defineProperty(player, 'currentTime', { get: () => 15, set() { throw new Error('seek forbidden'); } });
  const f = fixture([player], {}, () => (canvas = { width: 0, height: 0,
    getContext: () => ({ drawImage(video, x, y, width, height) { draws++; assert.equal(width, 320); assert.equal(height, 180); } }),
    toDataURL: type => { assert.equal(type, 'image/jpeg'); return 'data:image/jpeg;base64,YQ=='; },
  }));
  const snapshot = await f.read();
  assert.equal(draws, 0);
  const result = await f.capture({ [snapshot.documentToken]: [snapshot.media[0].id] });
  assert.match(result.media[0].frameImage, /^data:image\/jpeg/);
  assert.equal(draws, 1); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  assert.equal(player.currentTime, 15);
});
test('CORS, oversized images, undecoded and hidden media retain poster without a foreign frame', async () => {
  for (const mode of ['cors', 'large', 'undecoded', 'hidden']) {
    const player = video({ readyState: mode === 'undecoded' ? 1 : 2, videoWidth: 640, videoHeight: 360,
      poster: '/poster.jpg', hidden: mode === 'hidden' });
    const f = fixture([player], {}, () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }),
      toDataURL() { if (mode === 'cors') throw new Error('SecurityError'); return 'data:image/jpeg;base64,' + 'a'.repeat(128 * 1024); } }));
    const snapshot = await f.read();
    const result = await f.capture({ [snapshot.documentToken]: [snapshot.media[0].id] });
    assert.equal(result.media[0].frameImage, '');
    assert.equal(result.media[0].poster, 'https://example.test/poster.jpg');
  }
});
