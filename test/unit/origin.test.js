import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originOf, permissionPattern, compareOrigins, hostOf } from '../../extension/lib/origin.js';

test('[T2] origins include scheme, host and port; non-web pages have none', () => {
  assert.equal(originOf('https://portal.example.com/requests/new?x=1#y'), 'https://portal.example.com');
  assert.equal(originOf('http://127.0.0.1:5179/portal.html'), 'http://127.0.0.1:5179');
  for (const u of ['chrome://extensions', 'file:///C:/x.html', 'about:blank', 'javascript:alert(1)', 'data:text/html,x', 'not a url', undefined]) assert.equal(originOf(u), null, String(u));
  assert.equal(hostOf('https://portal.example.com:8443'), 'portal.example.com:8443');
});

test('[T1] the permission request covers exactly one host', () => {
  assert.equal(permissionPattern('https://portal.example.com:8443'), 'https://portal.example.com/*');
  assert.equal(permissionPattern('http://127.0.0.1:5179'), 'http://127.0.0.1/*');
  assert.equal(permissionPattern('chrome://settings'), null);
});

test('[T2] exact origin match only', () => {
  assert.equal(compareOrigins('https://portal.example.com', 'https://portal.example.com').same, true);
  for (const other of ['https://portal.example.com:8443', 'http://portal.example.com', 'https://portal.example.co', 'https://evil.com', 'https://sub.portal.example.com']) {
    assert.equal(compareOrigins('https://portal.example.com', other).same, false, other);
  }
});

test('[T2] look-alike and downgrade hints', () => {
  assert.equal(compareOrigins('https://portal.example.com', 'https://portal.examp1e.com').lookalike, 'similar');
  assert.equal(compareOrigins('https://portal.example.com', 'https://portal.example.com.evil.io').lookalike, 'similar');
  assert.equal(compareOrigins('https://portal.example.com', 'https://portal-example-login.com').lookalike, 'similar');
  assert.equal(compareOrigins('https://portal.example.com', 'https://xn--prtal-1sa.example.com').lookalike, 'punycode');
  assert.equal(compareOrigins('https://portal.example.com', 'https://news.other.org').lookalike, null);
  assert.equal(compareOrigins('https://portal.example.com', 'http://portal.example.com').downgrade, true);
  assert.equal(compareOrigins('https://portal.example.com', 'https://portal.example.com:444').downgrade, false);
});
