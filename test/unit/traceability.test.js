// Every threat in SECURITY.md must be covered by at least one test whose title carries its id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const security = readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
const threats = [...security.matchAll(/^### (T\d+)\./gm)].map((m) => m[1]);

function testTitles() {
  const out = [];
  for (const dir of ['test/unit', 'test/e2e']) {
    for (const f of readdirSync(path.join(ROOT, dir))) {
      if (!/\.(test|spec)\.js$/.test(f)) continue;
      const src = readFileSync(path.join(ROOT, dir, f), 'utf8');
      for (const m of src.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) out.push({ file: `${dir}/${f}`, title: m[2] });
    }
  }
  return out;
}

test('SECURITY.md lists threats T1…T14', () => {
  assert.deepEqual(threats, Array.from({ length: 14 }, (_, i) => `T${i + 1}`));
});

test('every threat has at least one test, and tests only reference known threats', () => {
  const titles = testTitles();
  const covered = new Map(threats.map((t) => [t, []]));
  for (const { file, title } of titles) {
    for (const m of title.matchAll(/\[(T\d+)\]/g)) {
      assert.ok(covered.has(m[1]), `${file}: unknown threat ${m[1]}`);
      covered.get(m[1]).push(file);
    }
  }
  const uncovered = [...covered].filter(([, files]) => files.length === 0).map(([t]) => t);
  assert.deepEqual(uncovered, []);
});

test('every test file named in SECURITY.md exists and carries the ids it is listed for', () => {
  const titles = testTitles();
  for (const block of security.split(/^### /m).slice(1)) {
    const id = block.match(/^(T\d+)\./)[1];
    for (const m of block.matchAll(/`(test\/(?:unit|e2e)\/[\w.-]+\.js)`/g)) {
      const inFile = titles.filter((t) => t.file === m[1]);
      assert.ok(inFile.length, `${m[1]} (listed for ${id}) has no tests`);
      assert.ok(inFile.some((t) => t.title.includes(`[${id}]`)), `${m[1]} has no test tagged [${id}]`);
    }
  }
});
