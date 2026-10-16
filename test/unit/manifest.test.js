import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXT_DIR } from '../../scripts/build.mjs';
import { checkManifest } from '../../scripts/lib/manifest-rules.mjs';

const manifest = JSON.parse(readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

test('[T1] permissions are exactly activeTab, scripting, storage, sidePanel', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'sidePanel', 'storage']);
});

test('[T1] site access only through optional host permissions; nothing runs on pages by default', () => {
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  for (const k of ['host_permissions', 'content_scripts', 'externally_connectable', 'web_accessible_resources', 'optional_permissions']) {
    assert.equal(k in manifest, false, k);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>|"tabs"|webRequest|history|cookies|clipboard|debugger|nativeMessaging|unlimitedStorage/);
});

test('[T7] strict CSP for extension pages', () => {
  const csp = manifest.content_security_policy.extension_pages;
  for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(d), d);
  assert.doesNotMatch(csp, /unsafe|https?:|\*/);
});

test('[T1][T7] the release rules accept the real manifest and reject a test overlay', () => {
  assert.deepEqual(checkManifest(manifest), []);
  assert.ok(checkManifest({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }).some((p) => p.includes('host_permissions')));
  assert.ok(checkManifest({ ...manifest, permissions: [...manifest.permissions, 'tabs'] }).length > 0);
  assert.ok(checkManifest({ ...manifest, content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } }).length > 0);
  assert.ok(checkManifest({ ...manifest, externally_connectable: { matches: ['https://*/*'] } }).length > 0);
});

test('manifest basics', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  for (const size of ['16', '32', '48', '128']) assert.ok(readFileSync(path.join(EXT_DIR, manifest.icons[size])).length > 0);
});
