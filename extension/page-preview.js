// Isolated world. No fetch, play or seek. Token identity lasts for this document.
(() => {
  if (globalThis.__viddowReadPreview) return globalThis.__viddowReadPreview(false);
  const documentToken = crypto.randomUUID();
  const identities = new WeakMap();
  const childTokens = new WeakMap();
  const frameCache = new WeakMap();
  let stopped = false, timer, observer, headObserver;
  let styleCache = new WeakMap();
  let sequence = 0;
  function visible(node) {
    if (!node.getClientRects().length) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      let style = styleCache.get(parent);
      if (!style) { style = getComputedStyle(parent); styleCache.set(parent, style); }
      if (parent.hidden || style.contentVisibility === 'hidden' || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  function httpUrl(value) {
    if (!value) return '';
    try { const url = new URL(value, document.baseURI); return /^https?:$/.test(url.protocol) ? url.href : ''; }
    catch { return ''; }
  }
  function identity(video) {
    const src = video.currentSrc || video.src || '';
    const signature = JSON.stringify([video.currentSrc || '', video.src || '', video.poster || '', ...[...(video.querySelectorAll?.('source') || [])].map(node => node.src)]);
    let value = identities.get(video);
    if (!value) { value = { id: ++sequence, generation: 0, src, signature }; identities.set(video, value); }
    if (value.signature !== signature) { value.signature = signature; value.generation++; }
    value.src = src;
    return value;
  }
  const meta = name => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || '';
  const pending = new Map();
  function onMessage(event) {
    if (stopped) return;
    const data = event.data;
    if (data?.type === 'viddow_identity_probe' && event.source === window.parent && event.source !== window) {
      event.source.postMessage({ type: 'viddow_identity_reply', nonce: data.nonce, documentToken }, '*');
    } else if (data?.type === 'viddow_identity_announce' && event.source !== window) {
      const child = [...document.querySelectorAll('iframe, frame')].find(node => node.contentWindow === event.source);
      if (child && typeof data.documentToken === 'string') childTokens.set(child, data.documentToken);
    } else if (data?.type === 'viddow_identity_reply') {
      const probe = pending.get(data.nonce);
      if (probe && probe.child === event.source) probe.resolve(data.documentToken);
    }
  }
  window.addEventListener('message', onMessage);
  function frameImage(video) {
    if (!visible(video) || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
    const signature = JSON.stringify([identity(video).generation, video.videoWidth, video.videoHeight]);
    const cached = frameCache.get(video);
    if (cached?.signature === signature) return cached.image;
    const canvas = document.createElement('canvas');
    let image = '';
    try {
      const scale = Math.min(1, 320 / video.videoWidth, 180 / video.videoHeight);
      canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.72);
      image = data.startsWith('data:image/jpeg;base64,') && data.length <= 128 * 1024 ? data : '';
      return image;
    } catch { return ''; } // Tainted canvas / undecoded frame: keep poster, never play or seek.
    finally { canvas.width = 0; canvas.height = 0; frameCache.set(video, { signature, image }); }
  }
  async function read(probeChildren = true, imageRequests = {}) {
    if (stopped) return null;
    styleCache = new WeakMap();
    // A child can identify its container even when that container is hidden and
    // the parent deliberately avoids waiting for its probe. Tokens are checked
    // against scripting results before either visibility or identity is used.
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: 'viddow_identity_announce', documentToken }, '*'); } catch {}
    }
    const childNodes = [...document.querySelectorAll('iframe, frame')];
    const children = probeChildren ? await Promise.all(childNodes.map(async node => {
      if (!visible(node)) return { documentToken: null, visible: false };
      const nonce = crypto.randomUUID(), child = node.contentWindow;
      const token = await new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(nonce); resolve(null); }, 250);
        pending.set(nonce, { child, resolve: token => { clearTimeout(timer); pending.delete(nonce); resolve(token); } });
        try { child?.postMessage({ type: 'viddow_identity_probe', nonce }, '*'); }
        catch { clearTimeout(timer); pending.delete(nonce); resolve(null); }
      });
      if (token) childTokens.set(node, token);
      return { documentToken: token || childTokens.get(node) || null, visible: visible(node) };
    })) : childNodes.map(node => ({ documentToken: childTokens.get(node) || null, visible: visible(node) }));
    const media = [...document.querySelectorAll('video')].map(video => {
      const { id, generation, src } = identity(video);
      return { id, generation, src, visible: visible(video), poster: httpUrl(video.poster), posterSource: 'player',
        frameImage: imageRequests[documentToken]?.includes(id) ? frameImage(video) : '',
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
        durationSource: 'player', isLive: video.duration === Infinity };
    });
    const pageVideo = /^video[.:]/i.test(meta('og:type')) || Boolean(meta('og:video') || meta('og:video:url'));
    const pageDuration = Number(meta('video:duration') || meta('og:video:duration'));
    return { documentToken, pageDuration: pageVideo && Number.isFinite(pageDuration) && pageDuration > 0 ? pageDuration : null, url: location.href, children, media, hasPlayer: media.length > 0,
      hasVideoMetadata: pageVideo, pageImage: httpUrl(meta('og:image') || meta('twitter:image')) };
  }
  globalThis.__viddowReadPreview = read;
  const events = ['loadedmetadata', 'loadeddata', 'durationchange', 'emptied', 'pause', 'seeked'];
  function stop() {
    stopped = true; clearTimeout(timer);
    observer?.disconnect(); headObserver?.disconnect();
    for (const event of events) document.removeEventListener(event, changed, true);
    document.removeEventListener('load', frameLoaded, true);
    window.removeEventListener('message', onMessage);
    for (const probe of pending.values()) probe.resolve(null);
    pending.clear();
  }
  function notify() {
    timer = null;
    if (stopped) return;
    try {
      if (!globalThis.chrome?.runtime?.id || !chrome.runtime.sendMessage) { stop(); return; }
      chrome.runtime.sendMessage({ type: 'page_preview_changed' }).catch(error => {
        if (/context invalidated|receiving end does not exist|extension.*unloaded/i.test(error?.message || '')) stop();
      });
    } catch { stop(); }
  }
  const changed = event => {
    if (stopped) return;
    if (event?.type === 'emptied' && event.target.tagName === 'VIDEO') identity(event.target).generation++;
    // One notification per burst; continuous controls cannot starve delivery.
    if (!timer) timer = setTimeout(notify, 250);
  };
  for (const event of events) document.addEventListener(event, changed, true);
  function frameLoaded(event) { if (event.target.tagName === 'IFRAME') changed(); }
  document.addEventListener('load', frameLoaded, true);
  observer = new MutationObserver(records => {
    const mediaNode = node => ['VIDEO', 'SOURCE', 'IFRAME', 'FRAME'].includes(node.tagName) || node.querySelector?.('video, iframe');
    if (records.some(record => record.type === 'attributes' ? mediaNode(record.target) : [...record.addedNodes, ...record.removedNodes].some(mediaNode))) changed();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['poster', 'src', 'hidden', 'style', 'class'] });
  if (document.head) {
    headObserver = new MutationObserver(records => {
      const metadata = node => node.tagName === 'META' || node.querySelector?.('meta');
      if (records.some(record => record.type === 'attributes' ? metadata(record.target) : [...record.addedNodes, ...record.removedNodes].some(metadata))) changed();
    });
    headObserver.observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ['content'] });
  }
  return read(false);
})();
