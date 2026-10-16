import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, DEFAULT_SETTINGS } from '../../extension/lib/store.js';

test('settings: wait time is clamped, language is "auto" or a locale code', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS });
  assert.equal(DEFAULT_SETTINGS.language, 'auto');
  assert.equal(normalizeSettings({ waitTimeoutMs: 100 }).waitTimeoutMs, 500);
  assert.equal(normalizeSettings({ waitTimeoutMs: 99999 }).waitTimeoutMs, 30000);
  for (const ok of ['auto', 'de', 'pt_BR', 'zh_CN']) assert.equal(normalizeSettings({ language: ok }).language, ok);
  for (const bad of ['', 'DE', 'pt-BR', 'en_us', '../x', 5, null]) assert.equal(normalizeSettings({ language: bad }).language, 'auto');
  for (const ok of ['auto', 'light', 'dark']) assert.equal(normalizeSettings({ theme: ok }).theme, ok);
  for (const bad of ['', 'Dark', 'blue', 1]) assert.equal(normalizeSettings({ theme: bad }).theme, 'auto');
  for (const ok of ['both', 'page']) assert.equal(normalizeSettings({ recSync: ok }).recSync, ok);
  for (const bad of ['', 'panel', 'Both', 0, null]) assert.equal(normalizeSettings({ recSync: bad }).recSync, 'both');
});
