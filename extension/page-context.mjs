import { visibleDocuments, visibleMedia } from './media-model.mjs';

async function collectContext(tabId) {
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ['page-preview.js'] });
  // Start probes without awaiting per-frame promises. Hidden documents can throttle
  // their timers indefinitely; the worker owns the discovery window and deadline.
  await chrome.scripting.executeScript({ target, func: () => {
    globalThis.__viddowReadPreview?.().catch(() => {});
    return true;
  } });
  await new Promise(resolve => setTimeout(resolve, 150));
  const frames = await chrome.scripting.executeScript({ target, func: () => globalThis.__viddowReadPreview?.(false) });
  const latest = await chrome.scripting.executeScript({ target, func: () => globalThis.__viddowReadPreview?.(false) });
  const documents = visibleDocuments(frames, latest);
  const top = documents.find(frame => frame.frameId === 0);
  if (!top) return null;
  const media = visibleMedia(tabId, frames, latest);
  return { media: media.map(({ key, src, documentId, frameId }) => ({ key, src, documentId, frameId })),
    mediaKeys: media.filter(media => media.src).map(media => media.key), url: top.result.url,
    documentToken: top.result.documentToken, documents: documents.map(frame => frame.documentId) };
}

export async function pageContext(tabId, { timeoutMs = 3000 } = {}) {
  let timer;
  try {
    return await Promise.race([collectContext(tabId), new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
