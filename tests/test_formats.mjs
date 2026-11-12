import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLabel, mainFormats, choiceProblem, durationLabel, defaultChoice, qualityLabel, audioLabel } from '../extension/format-model.mjs';

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

test('defaults keep sound and never silently select one of several audio tracks', () => {
  const video = { id: 'v', height: 1080, kind: 'video' };
  const combined = { id: 'c', height: 720, kind: 'combined' };
  const ru = { id: 'ru', kind: 'audio', language: 'ru' };
  const en = { id: 'en', kind: 'audio', language: 'en' };
  assert.deepEqual(defaultChoice([video, combined, ru, en], true), { main: 'c', audio: [] });
  assert.deepEqual(defaultChoice([video, ru], true), { main: 'v', audio: ['ru'] });
  assert.deepEqual(defaultChoice([video, combined, ru], false), { main: 'c', audio: [] });
  assert.deepEqual(defaultChoice([video, ru, en], true), { main: 'v', audio: [] });
  assert.match(choiceProblem(video, defaultChoice([video, ru], false).audio, false), /Выберите/);
  assert.deepEqual(defaultChoice([], true), { main: '', audio: [] });
});

test('short labels keep unknown sound explicit and technical IDs in details', () => {
  assert.match(qualityLabel({ id: 'master1080', kind: 'unknown' }), /Качество неизвестно.*звук неизвестен/);
  assert.equal(qualityLabel({ id: 'c', kind: 'combined', height: 720, ext: 'mp4' }), '720p · mp4 · со звуком');
  assert.match(audioLabel({ kind: 'audio' }), /Язык не указан/);
  assert.match(audioLabel({ kind: 'audio', language: 'ru' }), /русский/);
});

test('implausible frame rates do not appear in labels or dominate sorting', () => {
  const bad = { id: 'bad', kind: 'combined', height: 720, fps: 22500 };
  assert.equal(formatLabel(bad).includes('22500'), false);
  assert.equal(qualityLabel(bad).includes('22500'), false);
  assert.equal(mainFormats([bad, { ...bad, id: 'good', fps: 30 }])[0].id, 'good');
});
