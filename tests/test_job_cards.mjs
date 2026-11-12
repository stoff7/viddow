import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadCards } from '../extension/job-cards.mjs';
const attempt = 'a'.repeat(32);
const job = (id, status = 'error', fields = {}) => ({ id, status, attempt_id: attempt, error: `Failure ${id}`, ...fields });

test('repeated errors of an attempt produce one card with all error details, without mutating jobs', () => {
  const jobs = [job(1), job(2), job(3)], before = structuredClone(jobs);
  const cards = downloadCards(jobs);
  assert.equal(cards.length, 1); assert.equal(cards[0].id, 3);
  assert.deepEqual(cards[0].attempt_errors.map(row => row.error), ['Failure 1', 'Failure 2', 'Failure 3']);
  assert.deepEqual(jobs, before);
});
test('a running or completed retry contains previous failures in its card', () => {
  for (const status of ['queued', 'running', 'done']) {
    const cards = downloadCards([job(1), job(2), job(3, status, { path: '/tmp/saved.mp4' })]);
    assert.equal(cards.length, 1); assert.equal(cards[0].status, status);
    assert.equal(cards[0].path, '/tmp/saved.mp4');
    assert.deepEqual(cards[0].attempt_errors.map(row => row.id), [1, 2]);
  }
});
test('successful files and concurrent operations never disappear', () => {
  const cards = downloadCards([job(1), job(2, 'done'), job(3, 'done'), job(4, 'running'), job(5, 'running')]);
  assert.deepEqual(cards.map(row => row.id), [2, 3, 4, 5]);
  assert.deepEqual(cards[3].attempt_errors.map(row => row.id), [1]);
});
test('other attempts and legacy rows never group by title, CDN origin or page', () => {
  const jobs = [job(1), job(2, 'error', { attempt_id: 'b'.repeat(32) }),
    job(3, 'error', { attempt_id: undefined }), job(4, 'error', { attempt_id: undefined })];
  assert.equal(downloadCards(jobs).length, 4);
});
