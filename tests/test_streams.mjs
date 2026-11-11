import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberStream, groupStreams } from '../extension/stream-model.mjs';

test('full URL is deduplicated with current headers', () => {
  const first = { url: 'https://cdn.example/a/master.m3u8?t=one', kind: 'HLS', headers: { Cookie: 'old' }, lastSeen: 1 };
  let items = rememberStream([], first);
  items = rememberStream(items, { ...first, headers: { Cookie: 'new' }, lastSeen: 2 });
  assert.equal(items.length, 1);
  assert.equal(items[0].headers.Cookie, 'new');
  assert.equal(items[0].firstSeen, 1);
  assert.equal(items[0].seen, 2);
  items = rememberStream(items, { ...first, headers: undefined, lastSeen: 3 });
  assert.equal(items[0].headers.Cookie, 'new');
});

test('query variants group without losing their exact URL and headers', () => {
  const items = ['old', 'new'].map((token, index) => ({ url: `https://cdn.example/a/master.m3u8?token=${token}`,
    kind: 'HLS', headers: { Cookie: token }, lastSeen: index }));
  const groups = groupStreams(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].items[0].url, items[1].url);
  assert.equal(groups[0].items[1].headers.Cookie, 'old');
});

test('identical names in different paths are separate streams', () => {
  const items = ['/video-1/master.m3u8', '/video-2/master.m3u8', '/video-1/index-f1.m3u8'].map(path => ({
    url: `https://cdn.example${path}`, kind: 'HLS' }));
  assert.equal(groupStreams(items).length, 3);
});

test('at capacity fresh URLs replace oldest; refreshed URLs stay recent', () => {
  let items = [];
  for (let i = 0; i < 30; i++) items = rememberStream(items, { url: `https://cdn.example/${i}.m3u8` });
  items = rememberStream(items, { url: 'https://cdn.example/0.m3u8' });
  items = rememberStream(items, { url: 'https://cdn.example/new.m3u8' });
  assert.equal(items.length, 30);
  assert.equal(items.at(-1).url, 'https://cdn.example/new.m3u8');
  assert.equal(items.some(item => item.url === 'https://cdn.example/1.m3u8'), false);
  assert.equal(items.some(item => item.url === 'https://cdn.example/0.m3u8'), true);
});
