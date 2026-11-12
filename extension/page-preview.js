// Runs in Chrome's isolated world, only in the tab requested by the open panel.
// Read local DOM metadata; never fetch manifests or start the native inspector.
(() => {
  function httpUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, document.baseURI);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  function meta(name) {
    return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || '';
  }
  function read() {
    const videos = [...document.querySelectorAll('video')];
    const playing = videos.filter(video => !video.paused && !video.ended && video.getClientRects().length);
    const video = videos.length === 1 ? videos[0] : playing.length === 1 ? playing[0] : null;
    const pageVideo = /^video[.:]/i.test(meta('og:type')) || Boolean(meta('og:video') || meta('og:video:url'));
    const pageDuration = Number(meta('video:duration') || meta('og:video:duration'));
    const duration = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration
      : videos.length <= 1 && pageVideo && Number.isFinite(pageDuration) && pageDuration > 0 ? pageDuration : null;
    const poster = httpUrl(video?.poster || meta('og:image') || meta('twitter:image'));
    return { url: location.href, poster, posterSource: video?.poster ? 'player' : 'page',
      duration, durationSource: video && Number.isFinite(video.duration) && video.duration > 0 ? 'player' : 'page',
      isLive: Boolean(video && video.duration === Infinity), hasPlayer: Boolean(video), hasVideoMetadata: pageVideo };
  }
  if (!globalThis.__viddowPreviewWatch) {
    globalThis.__viddowPreviewWatch = true;
    let timer;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'page_preview_changed' }).catch(() => {});
      }, 150);
    };
    for (const event of ['loadedmetadata', 'durationchange', 'emptied']) document.addEventListener(event, changed, true);
    document.addEventListener('load', event => { if (event.target.tagName === 'IFRAME') changed(); }, true);
    new MutationObserver(records => {
      const mediaNode = node => node.tagName === 'VIDEO' || node.tagName === 'IFRAME' || node.querySelector?.('video, iframe');
      if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(mediaNode))) changed();
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['poster'] });
    if (document.head) new MutationObserver(changed).observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ['content'] });
  }
  return read();
})();
