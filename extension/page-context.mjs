import { visibleDocuments, visibleMedia } from './media-model.mjs';

export async function pageContext(tabId) {
  try {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['page-preview.js'] });
    const frames = await chrome.scripting.executeScript({ target, func: () => globalThis.__viddowReadPreview?.() });
    const latest = await chrome.scripting.executeScript({ target, func: () => globalThis.__viddowReadPreview?.() });
    const top = visibleDocuments(frames, latest).find(frame => frame.frameId === 0);
    if (!top) return null;
    const media = visibleMedia(tabId, frames, latest);
    return { media: media.map(({ key, src, documentId, frameId }) => ({ key, src, documentId, frameId })), mediaKeys: media.filter(media => media.src).map(media => media.key), url: top.result.url, documentToken: top.result.documentToken,
      documents: visibleDocuments(frames, latest).map(frame => frame.documentId) };
  } catch { return null; }
}
