import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLabel, mainFormats, choiceProblem, durationLabel } from '../extension/format-model.mjs';

test('quality uses metadata, unknown codecs stay unknown, and sorting does not mutate', () => {
  const formats = [{ id: 'master1080', kind: 'unknown' }, { id: 'low', height: 90, kind: 'video' }, { id: 'high', height: 180, kind: 'combined' }];
  assert.deepEqual(mainFormats(formats).map(f => f.id), ['high', 'low', 'master1080']);
  assert.equal(formats[0].id, 'master1080');
  assert.match(formatLabel(formats[0]), /Разрешение неизвестно.*состав дорожек неизвестен/);
  assert.match(formatLabel(formats[1]), /90p.*без звука/);
  assert.match(formatLabel({ id: 'ru', kind: 'audio', language: 'ru' }), /Звук.*ru/);
});

test('explicit audio choice and ffmpeg are required for merging, silent video is opt-in', () => {
  assert.match(choiceProblem({ kind: 'video' }, [], true), /Выберите/);
  assert.equal(choiceProblem({ kind: 'video' }, [], false, true), '');
  assert.match(choiceProblem({ kind: 'video' }, ['ru'], false), /ffmpeg/);
  assert.equal(choiceProblem({ kind: 'video' }, ['ru', 'en'], true), '');
  assert.match(choiceProblem({ kind: 'combined' }, ['ru'], true), /только/);
  assert.equal(choiceProblem({ kind: 'unknown' }, [], false), '');
});

test('live and missing duration are not shown as zero', () => {
  assert.match(durationLabel({ is_live: true, duration: 5 }), /Прямой эфир/);
  assert.equal(durationLabel({ duration: null }), 'Длительность неизвестна');
  assert.equal(durationLabel({ duration: 61.9 }), '1:01');
  assert.equal(durationLabel({ duration: 0 }), '0:00');
});
