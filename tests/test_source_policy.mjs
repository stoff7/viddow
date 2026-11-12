import test from 'node:test';
import assert from 'node:assert/strict';
import { canRecoverPageError } from '../extension/source-policy.mjs';
const error = code => ({ status: 'error', error_code: code });

test('a failed embedded extractor on a third-party page may recover using observed streams', () => {
  for (const code of ['authentication_required', 'embedded_source_error', 'access_denied', 'analysis_timeout', 'network']) {
    assert.equal(canRecoverPageError('https://anime.test/episode', error(code)), true, code);
  }
});
test('direct YouTube login errors, DRM and missing tools do not start source retries', () => {
  for (const url of ['https://www.youtube.com/watch?v=one', 'https://youtu.be/one', 'https://www.youtube-nocookie.com/embed/one']) {
    assert.equal(canRecoverPageError(url, error('authentication_required')), false, url);
  }
  for (const code of ['drm', 'missing_dependency', 'destination_full']) {
    assert.equal(canRecoverPageError('https://anime.test/', error(code)), false, code);
  }
  assert.equal(canRecoverPageError('https://anime.test/', { status: 'cancelled', error_code: 'authentication_required' }), false);
});
test('host parsing uses real URL boundaries rather than a substring in an unrelated URL', () => {
  assert.equal(canRecoverPageError('https://youtube.com.example.test/', error('authentication_required')), true);
  assert.equal(canRecoverPageError('https://anime.test/?next=https://youtube.com/', error('authentication_required')), true);
  assert.equal(canRecoverPageError('https://anime.test@youtube.com/watch?v=one', error('authentication_required')), false);
  assert.equal(canRecoverPageError('javascript:alert(1)', error('unsupported_source')), false);
  assert.equal(canRecoverPageError('bad URL', error('unsupported_source')), false);
});
