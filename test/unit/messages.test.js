import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { isFromServiceWorker, isRecordingSender, parseRecPing, isActionClicked, randomToken } from '../../extension/lib/messages.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const SW = `chrome-extension://${ID}/background.js`;
const session = { tabId: 7, origin: 'https://portal.example.com', token: 'f'.repeat(32) };
const cs = (over = {}) => ({ id: ID, tab: { id: 7 }, frameId: 0, origin: 'https://portal.example.com', url: 'https://portal.example.com/x', ...over });

test('[T9] only our own service worker may send ff:action-clicked', () => {
  assert.equal(isFromServiceWorker({ id: ID, url: SW }, ID, SW), true);
  assert.equal(isFromServiceWorker({ id: 'other-extension-id', url: SW }, ID, SW), false);
  assert.equal(isFromServiceWorker({ id: ID, url: SW, tab: { id: 1 } }, ID, SW), false, 'content scripts have a tab');
  assert.equal(isFromServiceWorker({ id: ID, url: `chrome-extension://${ID}/sidepanel.html` }, ID, SW), false);
  assert.equal(isFromServiceWorker(undefined, ID, SW), false);
  assert.equal(isActionClicked({ type: 'ff:action-clicked' }), true);
  assert.equal(isActionClicked('ff:action-clicked'), false);
});

test('[T9] recording pings must come from the recorded tab, top frame, same origin', () => {
  assert.equal(isRecordingSender(cs(), ID, session), true);
  assert.equal(isRecordingSender(cs({ id: 'other' }), ID, session), false);
  assert.equal(isRecordingSender(cs({ tab: { id: 8 } }), ID, session), false);
  assert.equal(isRecordingSender(cs({ tab: undefined }), ID, session), false);
  assert.equal(isRecordingSender(cs({ frameId: 3 }), ID, session), false);
  assert.equal(isRecordingSender(cs({ origin: 'https://evil.example' }), ID, session), false);
  assert.equal(isRecordingSender(cs(), ID, null), false);
});

test('[T9] recording pings need the session token and a known shape', () => {
  const ok = { type: 'ff:rec', token: session.token, event: 'changed' };
  assert.deepEqual(parseRecPing(ok, session), { event: 'changed', reason: undefined });
  assert.deepEqual(parseRecPing({ ...ok, event: 'blocked', reason: 'password' }, session), { event: 'blocked', reason: 'password' });
  assert.deepEqual(parseRecPing({ ...ok, event: 'refresh' }, session), { event: 'refresh', reason: undefined });
  assert.equal(parseRecPing({ ...ok, token: 'e'.repeat(32) }, session), null);
  assert.equal(parseRecPing({ ...ok, token: session.token.slice(1) }, session), null);
  assert.equal(parseRecPing({ ...ok, event: 'fill' }, session), null);
  assert.equal(parseRecPing({ ...ok, reason: '<img>' }, session), null);
  assert.equal(parseRecPing({ ...ok, values: { a: 1 } }, session), null, 'no extra keys (no data in messages)');
  assert.equal(parseRecPing({ ...ok, type: 'ff:fill' }, session), null);
  assert.equal(parseRecPing(ok, null), null);
  assert.equal(parseRecPing([ok], session), null);
});

test('[T9] session tokens are 128-bit random hex', () => {
  const a = randomToken(webcrypto);
  const b = randomToken(webcrypto);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});
