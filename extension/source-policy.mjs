const PAGE_ERRORS = new Set(['unsupported_source', 'authentication_required', 'embedded_source_error',
  'access_denied', 'source_unavailable', 'expired_link', 'network', 'network_timeout', 'network_tls',
  'analysis_timeout', 'download_error']);

export function canRecoverPageError(page, analysis) {
  if (analysis?.status !== 'error') return false;
  let host;
  try {
    const url = new URL(page);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    host = url.hostname.toLowerCase();
  } catch { return false; }
  if (analysis.error_code === 'unsupported_source') return true;
  const youtube = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)
    || host.endsWith('.youtube.com') || host.endsWith('.youtube-nocookie.com');
  return !youtube && PAGE_ERRORS.has(analysis.error_code);
}
