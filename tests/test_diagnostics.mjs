import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticEntry, diagnosticCode, recordDiagnostic, readDiagnostics, clearDiagnostics, DIAGNOSTIC_LIMIT } from '../extension/diagnostics.mjs';

test('diagnostics only retain approved event codes and numeric/source fields', () => {
  const entry = diagnosticEntry('panel_error', { name: 'TypeError', file: 'popup.js', line: 42,
    message: 'Cookie: private-cookie', stack: 'https://private.test/?token=secret',
    url: 'https://private.test', path: '/Users/private', headers: { Authorization: 'Bearer secret' }, title: 'Private title' }, 123);
  assert.deepEqual(entry, { time: 123, event: 'panel_error', name: 'TypeError', file: 'popup.js', line: 42 });
  assert.equal(diagnosticEntry('https://private.test/?token=secret'), null);
  assert.deepEqual(diagnosticEntry('command_error', { command: 'private-command', code: 'Cookie: secret', elapsed_ms: -1 }, 123), { time: 123, event: 'command_error' });
  assert.doesNotThrow(() => diagnosticEntry('panel_error', null));
  assert.equal(diagnosticCode('Native host not found'), 'host_not_found');
  assert.equal(diagnosticCode('Помощник не ответил'), 'timeout');
});

test('concurrent journal writes are bounded, exported rows are sanitized, and clear follows pending writes', async t => {
  t.mock.method(console, 'info', () => {});
  const previous = globalThis.chrome;
  let storage = { diagnosticLog: [{ time: 1, event: 'panel_error', message: 'Cookie: old-secret' }] };
  globalThis.chrome = { storage: { session: {
    get: async () => structuredClone(storage),
    set: async value => { storage = { ...storage, ...structuredClone(value) }; },
    remove: async key => { delete storage[key]; },
  } } };
  try {
    await Promise.all(Array.from({ length: DIAGNOSTIC_LIMIT + 5 }, (_, index) => recordDiagnostic('command_ok', { command: 'inspect', elapsed_ms: index, url: 'https://private.test/?token=secret' })));
    const rows = await readDiagnostics();
    assert.equal(rows.length, DIAGNOSTIC_LIMIT);
    assert.equal(rows.at(-1).elapsed_ms, DIAGNOSTIC_LIMIT + 4);
    assert.equal(JSON.stringify(storage).includes('secret'), false);
    storage.diagnosticLog.push({ time: 2, event: 'panel_error', name: 'https://private.test', message: 'Cookie: old-secret' });
    assert.equal(JSON.stringify(await readDiagnostics()).includes('secret'), false);
    assert.equal(JSON.stringify(await readDiagnostics()).includes('private.test'), false);
    const pending = recordDiagnostic('panel_start');
    await clearDiagnostics();
    await pending;
    assert.deepEqual(await readDiagnostics(), []);
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
