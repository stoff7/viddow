import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHistory, historyFromJobs, offlineJobs, pageReference } from '../extension/history-model.mjs';

const job = { id: 7, name: 'Lesson', status: 'done', path: '/tmp/Saved/lesson.mp4', created_at: 123,
  url: 'https://cdn.example/master.m3u8?signature=cdn-secret',
  page: 'https://site.example/watch/7', format_ids: ['stale-format'], format_label: '90p · ru' };

test('persistent projection excludes media URLs, request context, analysis, raw errors and progress', () => {
  const history = historyFromJobs([{ ...job, headers: { Cookie: 'cookie-secret', Authorization: 'Bearer bearer-secret' },
    referer: 'https://ref.example/?secret=referer-secret', page: 'https://user:password-secret@site.example/watch/7?token=page-secret#fragment-secret',
    name: 'Lesson https://site.example/?token=title-secret', error: 'HTTP Error 403: https://cdn.example/?token=error-secret',
    fraction: .5, label: 'private-progress', analysis: { thumbnail: 'https://cdn.example/?token=cover-secret' } }]);
  const json = JSON.stringify(history);
  for (const value of ['cdn-secret', 'cookie-secret', 'bearer-secret', 'referer-secret', 'password-secret', 'page-secret',
    'fragment-secret', 'title-secret', 'error-secret', 'cover-secret', 'private-progress', 'stale-format']) assert.equal(json.includes(value), false, value);
  assert.equal(history.jobs[0].page, 'https://site.example/watch/7');
  assert.equal(history.jobs[0].page_retry, false);
  assert.equal(history.jobs[0].http_status, 403);
  assert.equal(history.jobs[0].path, job.path);
  assert.equal(history.jobs[0].source_origin, 'https://cdn.example');
});

test('safe source identity survives, altered query and SPA references cannot restart silently', () => {
  assert.deepEqual(pageReference('https://site.example/watch/7'), { page: 'https://site.example/watch/7', retry: true });
  assert.deepEqual(pageReference('https://www.youtube.com/watch?v=public_ID'), { page: 'https://www.youtube.com/watch?v=public_ID', retry: true });
  assert.equal(pageReference('https://www.youtube.com/watch?v=public_ID&token=secret').retry, false);
  assert.equal(pageReference('https://site.example/#/video/7').retry, false);
  assert.deepEqual(pageReference('https://cdn.example/master.m3u8?token=secret'), { page: null, retry: false });
  assert.deepEqual(pageReference('javascript:alert(1)'), { page: null, retry: false });
});

test('version 0 migration preserves safe records and strips unrecognized legacy fields', () => {
  const decoded = decodeHistory([{ id: 3, title: 'Old lesson', source_page: 'https://site.example/watch/3', status: 'error',
    created_at: 10, url: 'https://cdn.example/?token=secret', headers: { Cookie: 'secret' } }]);
  assert.equal(decoded.writable, true); assert.equal(decoded.history.version, 1);
  assert.equal(decoded.history.jobs[0].name, 'Old lesson'); assert.equal(decoded.history.jobs[0].page_retry, true);
  assert.equal(JSON.stringify(decoded.history).includes('secret'), false);
  assert.deepEqual(decodeHistory(decoded.history).history, decoded.history);
});

test('corruption and duplicate IDs skip bad entries; future version stays untouched', () => {
  const good = historyFromJobs([job]).jobs[0];
  const decoded = decodeHistory({ version: 1, jobs: [null, { id: '7', status: 'done' }, good, good] });
  assert.equal(decoded.history.jobs.length, 1); assert.match(decoded.warning, /3/);
  assert.equal(decodeHistory('broken JSON').history.jobs.length, 0);
  assert.match(decodeHistory('broken JSON').warning, /повреждена/);
  const future = { version: 42, jobs: [good], extra: 'keep' }, before = JSON.stringify(future);
  assert.equal(decodeHistory(future).writable, false);
  assert.equal(JSON.stringify(future), before);
});

test('offline restoration marks active jobs interrupted, preserves results and never holds retry context', () => {
  const history = historyFromJobs([{ ...job, status: 'running' }, { ...job, id: 8, status: 'error', error: 'HTTP 404 private URL' }, { ...job, id: 9 }]);
  const restored = offlineJobs(history);
  assert.deepEqual(restored.map(row => row.status), ['interrupted', 'error', 'done']);
  assert.deepEqual(restored.map(row => row.format_ids), [[], [], []]);
  assert.equal(restored[2].path, job.path); assert.equal(restored[2].restored, true);
  assert.match(restored[1].error, /404/);
});

test('progress does not change persistent JSON and header-like metadata cannot expose credentials', () => {
  assert.deepEqual(historyFromJobs([{ ...job, fraction: .1, label: '10%' }]), historyFromJobs([{ ...job, fraction: .9, label: '90%' }]));
  for (const name of ['Authorization: Bearer secret-value', 'Cookie: sid=secret-value', 'token=secret-value', 'Bearer secret-value']) {
    assert.equal(JSON.stringify(historyFromJobs([{ ...job, name, format_label: name }])).includes('secret-value'), false);
  }
});
