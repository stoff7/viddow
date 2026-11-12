export function streamKey(item) {
  return JSON.stringify([item.tabGeneration ?? null, item.documentId ?? null, item.frameId ?? null, item.url]);
}
// Полные URL сохраняются: query может задавать авторизацию, дорожку или другое видео.
export function rememberStream(items, item, limit = 30) {
  const previous = items.find((entry) => streamKey(entry) === streamKey(item));
  const merged = { ...previous, ...item,
    headers: item.headers ?? previous?.headers,
    firstSeen: previous?.firstSeen ?? item.lastSeen,
    seen: (previous?.seen || 0) + 1 };
  return [...items.filter((entry) => streamKey(entry) !== streamKey(item)), merged].slice(-limit);
}

export function groupStreams(items) {
  const groups = new Map();
  for (const item of [...items].reverse()) {
    let url;
    try { url = new URL(item.url); } catch { continue; }
    const key = `${item.tabGeneration ?? ""}:${item.documentId ?? ""}:${item.frameId ?? ""}:${item.kind}:${url.origin}${url.pathname}`;
    if (!groups.has(key)) groups.set(key, { key, kind: item.kind, host: url.host, path: url.pathname, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}
