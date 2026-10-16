// Packages extension/ into dist/formditto-<version>.zip for the Chrome Web Store / Edge Add-ons.
// Refuses to build when the manifest breaks the release rules (e.g. leftover test host permissions).
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './lib/zip.mjs';
import { checkManifest } from './lib/manifest-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXT_DIR = path.join(ROOT, 'extension');

export function listExtensionFiles(dir = EXT_DIR) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

export function buildZip({ outDir = path.join(ROOT, 'dist'), extDir = EXT_DIR } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const problems = checkManifest(manifest);
  if (problems.length) throw new Error(`manifest.json is not releasable:\n- ${problems.join('\n- ')}`);
  const files = listExtensionFiles(extDir);
  const zip = createZip(files.map((name) => ({ name, data: readFileSync(path.join(extDir, name)) })));
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `formditto-${manifest.version}.zip`);
  writeFileSync(file, zip);
  return { file, files, bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), version: manifest.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildZip();
  console.log(`${path.relative(ROOT, r.file)}  ${(r.bytes / 1024).toFixed(1)} KB  sha256 ${r.sha256}`);
  for (const f of r.files) console.log(`  ${f}`);
}
