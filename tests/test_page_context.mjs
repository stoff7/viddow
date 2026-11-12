import test from 'node:test';
import assert from 'node:assert/strict';
import { pageContext } from '../extension/page-context.mjs';

const frame = (frameId, token, children = []) => ({ frameId, documentId: token,
  result: { documentToken: token, url: 'https://page.test/', children, media: [] } });

test('an executeScript that never answers cannot hold preparation forever', async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = { scripting: { executeScript: () => new Promise(() => {}) } };
  try {
    const started = performance.now();
    assert.equal(await pageContext(1, { timeoutMs: 25 }), null);
    assert.ok(performance.now() - started < 500);
  } finally { globalThis.chrome = previous; }
});

test('unresponsive iframe probes do not block snapshots; unproved edges stay excluded', async () => {
  const previous = globalThis.chrome, reader = globalThis.__viddowReadPreview;
  let calls = 0, probes = 0;
  const snapshots = [frame(0, 'top', [{ documentToken: 'visible', visible: true }, { documentToken: null, visible: true }]),
    frame(2, 'visible'), frame(3, 'unproved')];
  globalThis.__viddowReadPreview = () => { probes++; return new Promise(() => {}); };
  globalThis.chrome = { scripting: { executeScript: async script => {
    calls++;
    if (calls === 2) return [{ result: script.func() }];
    return snapshots;
  } } };
  try {
    const result = await pageContext(1, { timeoutMs: 1000 });
    assert.equal(probes, 1);
    assert.deepEqual(result.documents, ['top', 'visible']);
    assert.equal(calls, 4);
  } finally { globalThis.chrome = previous; globalThis.__viddowReadPreview = reader; }
});

test('network ownership survives unavailable DOM and subsequent DOM recovery within one browser navigation epoch', async () => {
  const { networkPageContext } = await import('../extension/page-context.mjs');
  const tab = { id: 7, url: 'https://anime.test/episode' };
  const unavailable = networkPageContext(tab, 'generation', null, ['hidden-doc']);
  const recovered = networkPageContext(tab, 'generation', { url: tab.url, documentToken: 'dom-token', documents: ['visible'], media: [], mediaKeys: [], hiddenDocuments: [] });
  assert.equal(unavailable.domAvailable, false);
  assert.deepEqual(unavailable.media, []);
  assert.deepEqual(unavailable.hiddenDocuments, ['hidden-doc']);
  assert.equal(recovered.domAvailable, true);
  assert.equal(recovered.domDocumentToken, 'dom-token');
  assert.equal(unavailable.documentToken, recovered.documentToken);
  assert.notEqual(networkPageContext(tab, 'new-navigation').documentToken, unavailable.documentToken);
  assert.equal(networkPageContext({ id: 7, url: 'chrome://settings/' }, 'generation'), null);
});
