// X uses separate blob URLs per player. Its own poster and CDN manifests share
// a stable media ID; a document/frame alone cannot distinguish feed videos.
export function xMediaIdentity(value, poster = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== (poster ? 'pbs.twimg.com' : 'video.twimg.com')) return null;
    const match = url.pathname.match(poster
      ? /^\/(amplify_video|ext_tw_video)_thumb\/(\d+)\//
      : /^\/(amplify_video|ext_tw_video)\/(\d+)\//);
    return match ? `${match[1]}:${match[2]}` : null;
  } catch { return null; }
}
export function isXPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname);
  } catch { return false; }
}
export function playerStreamMatch(selected, item, media, page) {
  if (!selected || item.documentId !== selected.documentId || item.frameId !== selected.frameId) return null;
  if (/^https?:/.test(selected.src)) return item.url === selected.src ? 'exact_media_url' : null;
  if (isXPage(page)) {
    const identity = xMediaIdentity(selected.poster, true);
    return identity && identity === xMediaIdentity(item.url) ? 'player_media_id' : null;
  }
  return media.filter(value => value.documentId === selected.documentId).length === 1 ? 'single_player' : null;
}
