// Identity and selection only. No fetching, storage or playback side effects.
export function mediaKey(tabId, frame, media) {
  return JSON.stringify([tabId, frame.result.documentToken, frame.frameId, media.id, media.generation]);
}
export function visibleDocuments(frames, latest = frames) {
  const byToken = new Map(frames.map(frame => [frame.result?.documentToken, frame]));
  const fresh = new Map(latest.map(frame => [frame.result?.documentToken, frame]));
  const top = frames.find(frame => frame.frameId === 0);
  const reachable = new Set();
  function visit(frame) {
    const data = frame?.result, now = fresh.get(data?.documentToken);
    if (!data || !now || now.documentId !== frame.documentId || reachable.has(data.documentToken)) return;
    reachable.add(data.documentToken);
    for (const edge of data.children || []) if (edge.visible && now.result?.children?.some(current => current.visible && current.documentToken === edge.documentToken)) visit(byToken.get(edge.documentToken));
  }
  visit(top);
  return frames.filter(frame => reachable.has(frame.result?.documentToken));
}
export function visibleMedia(tabId, frames, latest = frames) {
  const reachable = new Set(visibleDocuments(frames, latest).map(frame => frame.result.documentToken));
  const fresh = new Map(latest.map(frame => [frame.result?.documentToken, frame]));
  return frames.flatMap(frame => {
    const data = frame.result, now = fresh.get(data?.documentToken)?.result;
    if (!reachable.has(data?.documentToken)) return [];
    return (data.media || []).filter(media => media.visible && now?.media?.some(current =>
      current.id === media.id && current.generation === media.generation && current.visible))
      .map(media => ({ ...now.media.find(current => current.id === media.id), key: mediaKey(tabId, frame, media), tabId,
        frameId: frame.frameId, documentId: frame.documentId, documentToken: data.documentToken }));
  }).sort((left, right) => left.frameId - right.frameId || left.id - right.id);
}
export function selectMedia(candidates, selection = null) {
  if (selection?.key) return candidates.find(media => media.key === selection.key) || null;
  const matches = selection ? candidates.filter(media => media.src === selection.url &&
    selection.documentId && media.documentId === selection.documentId &&
    media.frameId === selection.frameId) : candidates;
  return matches.length === 1 ? matches[0] : null;
}
