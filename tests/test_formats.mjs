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
  assert.equal(qualityLabel({ id: 'c', kind: 'combined', height: 720, ext: 'mp4' }), '720p · битрейт не указан · mp4 · со звуком');
  assert.match(audioLabel({ kind: 'audio' }), /Язык не указан/);
  assert.match(audioLabel({ kind: 'audio', language: 'ru' }), /русский/);
});

test('implausible frame rates do not appear in labels or dominate sorting', () => {
  const bad = { id: 'bad', kind: 'combined', height: 720, fps: 22500 };
  assert.equal(formatLabel(bad).includes('22500'), false);
  assert.equal(qualityLabel(bad).includes('22500'), false);
  assert.equal(mainFormats([bad, { ...bad, id: 'good', fps: 30 }])[0].id, 'good');
});


test('bitrate variants use one proven audio group and highest comparable video rate', () => {
  const formats = [{id:'v1',kind:'video',height:720,vcodec:'h264',vbr:1000}, {id:'v2',kind:'video',height:720,vcodec:'h264',vbr:2400},
    {id:'a1',kind:'audio',audio_group:'same',abr:32}, {id:'a2',kind:'audio',audio_group:'same',abr:128}];
  assert.deepEqual(defaultChoice(formats, true), {main:'v2',audio:['a2']});
  assert.match(qualityLabel(formats[1]), /2,4 Мбит/);
  assert.match(audioLabel(formats[3]), /128 кбит/);
  assert.deepEqual(defaultChoice(formats.map(row => ({...row,audio_group:undefined})), true).audio, []);
  assert.match(qualityLabel({kind:'combined', tbr:2500}), /всего/);
  assert.match(qualityLabel({kind:'video', vbr:Infinity, tbr:-1}), /не указан/);
});


test('H.264 and RFC AVC names rank by bitrate in either source order', () => {
  for (const alias of ['h264', 'h.264', 'AVC', 'avc1', 'avc1.640032', 'avc3.640032']) {
    const low = {id:'low', kind:'video', height:1080, fps:30, vcodec:'h.264', vbr:2920};
    const high = {...low, id:'high', vcodec:alias, vbr:5360};
    const audio = {id:'audio',kind:'audio',abr:128};
    for (const rows of [[low, high, audio], [high, low, audio]]) {
      assert.equal(defaultChoice(rows, true).main, 'high');
      assert.equal(mainFormats(rows)[0].id, 'high');
    }
  }
});
