import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoPreparation } from '../extension/preparation.mjs';
const settle = async preparation => { for (let i = 0; i < 100 && preparation.running; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
function fixture() {
  let state = { session: 'session', analysis: { id: 'page', status: 'error', error_code: 'unsupported_source' } };
  let context = { url: 'https://page.test/', documentToken: 'doc', documents: ['visible'] };
  let items = [];
  const calls = [], updates = [];
  const preparation = new VideoPreparation({
    state: async () => structuredClone(state), context: async () => context, streams: async () => items,
    publish: async value => updates.push(structuredClone(value)),
    inspect: async value => { calls.push(['inspect', value]); state.analysis = { id: 'fallback', status: 'running' }; return { analysis_id: 'fallback' }; },
    download: async value => { calls.push(['download', value]); return { ids: [1] }; },
    cancel: async (...args) => calls.push(['cancel', args]), downloaded: async (...args) => calls.push(['downloaded', args]),
  });
  return { preparation, calls, updates, set state(value) { state = value; }, set context(value) { context = value; },
    set items(value) { items = value; }, begin: download => preparation.begin({ session: 'session', tabId: 1,
      page: 'https://page.test/', documentToken: 'doc', analysisId: 'page', download }) };
}
const stream = (url, documentId = 'visible') => ({ url, documentId, frameId: 2, kind: 'HLS', headers: { Cookie: url }, lastSeen: 1 });

test('unsupported page waits for streams and starts one shared bounded batch, keeping contexts separate', async () => {
  const f = fixture(); await f.begin(false); await settle(f.preparation);
  assert.equal(f.preparation.current.phase, 'waiting');
  f.items = [stream('https://cdn.test/a?token=full'), stream('https://cdn.test/hidden', 'hidden'),
    ...Array.from({ length: 10 }, (_, i) => stream(`https://cdn.test/${i}`))];
  f.preparation.observe(); await settle(f.preparation);
  for (let i = 0; i < 3; i++) f.preparation.observe();
  await new Promise(resolve => setTimeout(resolve, 380)); await settle(f.preparation);
  assert.equal(f.calls.filter(([name]) => name === 'inspect').length, 1);
  const request = f.calls[0][1];
  assert.equal(request.fallbacks.length, 6);
  assert.equal(request.fallbacks.some(item => item.urls[0].includes('hidden')), false);
  assert.equal(request.fallbacks[0].headers.Cookie, 'https://cdn.test/a?token=full');
  f.preparation.observe(); await settle(f.preparation);
  assert.equal(f.calls.length, 1);
});
test('only explicit pending intent downloads the recommended source once', async () => {
  const f = fixture();
  f.state = { session: 'session', analysis: { id: 'page', status: 'done', result: { source_id: 'best', recommended_format_ids: ['720'] } } };
  await f.begin(false); await settle(f.preparation); assert.equal(f.calls.length, 0);
  assert.equal(await f.preparation.requestDownload({ session: 'session', tabId: 1, page: 'https://page.test/', documentToken: 'doc' }), true);
  await settle(f.preparation); f.preparation.observe(); await settle(f.preparation);
  assert.deepEqual(f.calls.filter(([name]) => name === 'download'), [['download', {
    session: 'session', analysis_id: 'page', source_id: 'best', format_ids: ['720'] }]]);
});
test('cancel, tab switch, new document and ambiguous audio prevent pending download', async () => {
  for (const action of ['cancel', 'tab', 'document', 'media', 'audio']) {
    const f = fixture(); f.state = { session: 'session', analysis: { id: 'page', status: 'running' } };
    await f.begin(true); await settle(f.preparation);
    if (action === 'cancel') f.preparation.cancel();
    if (action === 'tab') await f.preparation.clearIntent(2);
    if (action === 'media') { f.preparation.current.mediaKeys = ['old-series']; f.context = { url: 'https://page.test/', documentToken: 'doc', documents: ['visible'], mediaKeys: ['new-series'] }; }
    if (action === 'document') f.context = { url: 'https://page.test/', documentToken: 'new', documents: ['visible'] };
    f.state = { session: 'session', analysis: { id: 'page', status: 'done', result: { source_id: 'best', recommended_format_ids: action === 'audio' ? [] : ['720'] } } };
    f.preparation.observe(); await settle(f.preparation);
    assert.equal(f.calls.some(([name]) => name === 'download'), false, action);
  }
});

test('an explicit player excludes other documents and ambiguous blob siblings', async () => {
  for (const ambiguous of [false, true]) {
    const f = fixture();
    f.context = { url: 'https://page.test/', documentToken: 'doc', documents: ['visible', 'other'],
      mediaKeys: ['chosen'], media: [{ key: 'chosen', src: 'blob:https://page.test/media', documentId: 'visible', frameId: 2 },
        ...(ambiguous ? [{ key: 'sibling', src: 'blob:other', documentId: 'visible', frameId: 2 }] : [])] };
    f.items = [stream('https://cdn.test/target'), stream('https://cdn.test/unrelated', 'other')];
    await f.begin(false); await settle(f.preparation);
    f.preparation.current.selectedMediaKey = 'chosen'; f.preparation.current.mediaKeys = ['chosen'];
    await new Promise(resolve => setTimeout(resolve, 380)); await settle(f.preparation);
    const calls = f.calls.filter(([name]) => name === 'inspect');
    assert.equal(calls.length, ambiguous ? 0 : 1);
    if (!ambiguous) assert.deepEqual(calls[0][1].fallbacks.map(item => item.urls[0]), ['https://cdn.test/target']);
    f.preparation.cancel();
  }
});

test('a late rejected fallback cannot mark a newer preparation as failed', async () => {
  const f = fixture(); let reject;
  f.items = [stream('https://cdn.test/target')];
  f.preparation.io.inspect = () => new Promise((_, failure) => { reject = failure; });
  await f.begin(false); await settle(f.preparation);
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(typeof reject, 'function');
  f.state = { session: 'session', analysis: { id: 'new', status: 'running' } };
  await f.preparation.begin({ session: 'session', tabId: 1, page: 'https://page.test/', documentToken: 'doc', analysisId: 'new', download: false });
  reject(new Error('old request failed')); await settle(f.preparation);
  assert.equal(f.preparation.current.analysisId, 'new');
  assert.equal(f.preparation.current.phase, 'page');
  assert.equal(f.preparation.current.error, undefined);
  f.preparation.cancel();
});
