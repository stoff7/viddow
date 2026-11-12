const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../extension/page-preview.js'), 'utf8');

function read(videos = [], metadata = {}) {
  return vm.runInNewContext(source, {
    URL, location: { href: 'https://example.test/watch' },
    document: {
      baseURI: 'https://example.test/watch', documentElement: {}, head: {},
      querySelectorAll: () => videos,
      querySelector: selector => metadata[selector.match(/"([^"]+)"/)[1]] ? { content: metadata[selector.match(/"([^"]+)"/)[1]] } : null,
      addEventListener() {},
    },
    MutationObserver: class { observe() {} },
  });
}
const video = (values = {}) => ({ paused: true, ended: false, duration: NaN, poster: '', getClientRects: () => [{}], ...values });

test('single player supplies its poster and real duration before native analysis', () => {
  const result = read([video({ duration: 125.5, poster: '/cover.jpg' })]);
  assert.equal(result.poster, 'https://example.test/cover.jpg');
  assert.equal(result.duration, 125.5);
  assert.equal(result.durationSource, 'player');
  assert.equal(result.hasPlayer, true);
});
test('page artwork is identified as page data; generic image does not imply video', () => {
  const generic = read([], { 'og:image': '/article.jpg', 'video:duration': '23' });
  assert.equal(generic.posterSource, 'page');
  assert.equal(generic.hasVideoMetadata, false);
  assert.equal(generic.duration, null);
  const declared = read([], { 'og:type': 'video.movie', 'og:image': '/cover.jpg', 'video:duration': '125' });
  assert.equal(declared.duration, 125);
  assert.equal(declared.hasVideoMetadata, true);
});
test('missing/invalid fields do not become a page URL image or zero duration', () => {
  assert.equal(read().poster, '');
  assert.equal(read([video({ duration: 0, poster: 'javascript:alert(1)' })]).poster, '');
  assert.equal(read([video()]).duration, null);
  assert.equal(read([], { 'og:type': 'video.other', 'video:duration': '-2' }).duration, null);
  assert.equal(read([video({ duration: Infinity })]).isLive, true);
});
test('several paused videos stay ambiguous; only a single visible playing video is selected', () => {
  assert.equal(read([video({ duration: 10 }), video({ duration: 20 })]).duration, null);
  const result = read([video({ duration: 10 }), video({ paused: false, duration: 20, poster: '/playing.jpg' })]);
  assert.equal(result.duration, 20);
  assert.equal(result.poster, 'https://example.test/playing.jpg');
});
