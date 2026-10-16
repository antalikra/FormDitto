import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, listExtensionFiles } from '../../scripts/build.mjs';
import { readZip } from '../../scripts/lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

test('[T14] no runtime dependencies; dev dependencies are pinned to exact versions', () => {
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  for (const [name, version] of Object.entries(pkg.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, name);
});

test('[T14] the lockfile matches package.json and resolves only from the npm registry', () => {
  assert.ok(lock.lockfileVersion >= 3);
  for (const [name, version] of Object.entries(pkg.devDependencies)) assert.equal(lock.packages[`node_modules/${name}`].version, version, name);
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key) continue;
    assert.match(entry.resolved || '', /^https:\/\/registry\.npmjs\.org\//, key);
    assert.match(entry.integrity || '', /^sha512-/, key);
  }
});

test('[T14] the store zip contains exactly the extension files with the release manifest, and is reproducible', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'formditto-zip-'));
  try {
    const a = buildZip({ outDir: out });
    const first = readFileSync(a.file);
    const b = buildZip({ outDir: out });
    assert.equal(a.sha256, b.sha256, 'deterministic build');
    const entries = readZip(first);
    assert.deepEqual([...entries.keys()].sort(), listExtensionFiles().sort());
    assert.ok(entries.has('manifest.json'), 'manifest at the zip root');
    const m = JSON.parse(entries.get('manifest.json').toString('utf8'));
    assert.equal(m.host_permissions, undefined);
    for (const name of entries.keys()) assert.doesNotMatch(name, /^(test|node_modules|scripts|store)\/|\.map$|^\./, name);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
