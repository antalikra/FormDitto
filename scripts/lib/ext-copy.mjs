// Copies extension/ to a scratch folder and adds host_permissions for the given test hosts only.
// Used by the e2e suite and the store-asset scripts, because automation cannot click Chrome's native
// permission prompt. The release zip is always built from the untouched extension/ folder.
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXT_DIR = path.join(ROOT, 'extension');

export function extensionCopyWithHosts(name, hosts) {
  const dst = path.join(ROOT, '.tmp', name);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(EXT_DIR, dst, { recursive: true });
  const file = path.join(dst, 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.host_permissions = hosts;
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  return dst;
}
