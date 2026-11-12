import test from 'node:test';
import assert from 'node:assert/strict';
import { xMediaIdentity, playerStreamMatch } from '../extension/player-source.mjs';

test('X poster IDs match master, video and audio of exactly that media namespace', () => {
  for (const type of ['amplify_video', 'ext_tw_video']) {
    const selected = { src: 'blob:https://x.com/opaque', poster: `https://pbs.twimg.com/${type}_thumb/2119187441865109504/img/cover.jpg`, documentId: 'doc', frameId: 0 };
    for (const path of ['master', 'avc1/1280x720/video', 'mp4a/128000/audio']) {
      const item = { url: `https://video.twimg.com/${type}/2119187441865109504/pl/${path}.m3u8?tag=secret`, documentId: 'doc', frameId: 0 };
      assert.equal(playerStreamMatch(selected, item, [selected, { documentId: 'doc' }], 'https://x.com/'), 'player_media_id');
      assert.equal(playerStreamMatch(selected, { ...item, url: item.url.replace('2119187441865109504', '21191874418651095040') }, [selected], 'https://x.com/'), null);
      assert.equal(playerStreamMatch(selected, { ...item, documentId: 'other' }, [selected], 'https://x.com/'), null);
      assert.equal(playerStreamMatch(selected, item, [selected, { documentId: 'doc' }], 'https://example.com/'), null);
    }
  }
});
test('no substring, protocol, namespace or thumbnail-host impersonation', () => {
  for (const url of ['https://video.twimg.com.evil/amplify_video/123/pl/a.m3u8', 'http://video.twimg.com/amplify_video/123/pl/a.m3u8',
    'https://evil/video.twimg.com/amplify_video/123/pl/a.m3u8', 'blob:https://video.twimg.com/amplify_video/123/', 'invalid']) assert.equal(xMediaIdentity(url), null);
  assert.notEqual(xMediaIdentity('https://video.twimg.com/amplify_video/123/pl/a.m3u8'), xMediaIdentity('https://pbs.twimg.com/ext_tw_video_thumb/123/img/a.jpg', true));
  assert.equal(xMediaIdentity('https://pbs.twimg.com/amplify_video_thumb/123/img/a.jpg', true), 'amplify_video:123');
});
test('unknown blob siblings stay ambiguous; direct media keeps exact matching', () => {
  const selected = { src: 'blob:https://x.com/a', poster: '', documentId: 'doc', frameId: 0 };
  const item = { url: 'https://video.twimg.com/amplify_video/123/pl/a.m3u8', documentId: 'doc', frameId: 0 };
  assert.equal(playerStreamMatch(selected, item, [selected, { documentId: 'doc' }], 'https://x.com/'), null);
  assert.equal(playerStreamMatch({ ...selected, src: item.url }, item, [selected], 'https://x.com/'), 'exact_media_url');
});
