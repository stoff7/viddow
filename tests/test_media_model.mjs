import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleMedia, selectMedia, hiddenDocuments } from '../extension/media-model.mjs';
const media = (id = 1, src = 'https://cdn.test/one.m3u8?token=full') => ({ id, generation: 0, src, visible: true, duration: 10 });
const frame = (id, token, videos = [], children = []) => ({ frameId: id, documentId: `doc-${token}`,
  result: { documentToken: token, media: videos, children } });
const edge = (documentToken, visible = true) => ({ documentToken, visible });

test('only reachable visible descendants survive; absent ancestor never implies visibility', () => {
  const frames = [frame(0, 'top', [], [edge('wrapper'), edge('hidden', false)]), frame(1, 'wrapper', [], [edge('player')]),
    frame(2, 'player', [media()]), frame(3, 'hidden', [], [edge('backup')]), frame(4, 'backup', [media()]), frame(5, 'orphan', [media()])];
  assert.deepEqual(visibleMedia(7, frames).map(item => item.frameId), [2]);
  const latest = structuredClone(frames); latest[0].result.children[0].visible = false;
  assert.equal(visibleMedia(7, frames, latest).length, 0);
});
test('two visible players stay ambiguous and explicit choice survives background candidates', () => {
  const frames = [frame(0, 'top', [media(1), media(2)])];
  const candidates = visibleMedia(7, frames);
  assert.equal(selectMedia(candidates), null);
  assert.equal(selectMedia(candidates, { key: candidates[1].key }), candidates[1]);
  assert.equal(selectMedia(candidates.slice(0, 1), { key: candidates[1].key }), null);
});
test('network match requires full URL and document/frame evidence; blob stays unbound', () => {
  const frames = [frame(0, 'top', [media(), media(2, 'blob:https://site.test/id')])];
  const candidates = visibleMedia(7, frames), item = { url: candidates[0].src, frameId: 0, documentId: 'doc-top' };
  assert.equal(selectMedia(candidates, item), candidates[0]);
  for (const patch of [{ documentId: undefined }, { frameId: 1 }, { documentId: 'old' }, { url: 'https://cdn.test/one.m3u8?token=other' }]) {
    assert.equal(selectMedia(candidates, { ...item, ...patch }), null);
  }
});
test('late old series/document/tab cannot fulfill the selected key', () => {
  const frames = [frame(0, 'top', [media()])], old = visibleMedia(7, frames)[0];
  const latest = structuredClone(frames); latest[0].result.media[0].generation++;
  assert.equal(visibleMedia(7, frames, latest).length, 0);
  assert.equal(selectMedia(visibleMedia(7, latest), { key: old.key }), null);
  assert.equal(selectMedia(visibleMedia(8, frames), { key: old.key }), null);
  assert.equal(visibleMedia(7, frames, [frame(0, 'new', [media()])]).length, 0);
});

test('a known hidden iframe excludes all of its descendants without guessing by frame order', () => {
  const frames = [frame(0, 'top', [], [edge('visible'), edge('hidden', false)]),
    frame(1, 'visible', [media()]), frame(2, 'hidden', [], [edge('nested')]), frame(3, 'nested', [media()])];
  assert.deepEqual(hiddenDocuments(frames).map(frame => frame.documentId), ['doc-hidden', 'doc-nested']);
});
