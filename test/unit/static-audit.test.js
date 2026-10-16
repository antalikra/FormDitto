// Static audit of everything that ships in extension/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listExtensionFiles, EXT_DIR } from '../../scripts/build.mjs';

const read = (rel) => readFileSync(path.join(EXT_DIR, rel), 'utf8');
const files = listExtensionFiles();
const js = files.filter((f) => f.endsWith('.js'));
const html = files.filter((f) => f.endsWith('.html'));
const css = files.filter((f) => f.endsWith('.css'));

// Comments are stripped so that explanations ("never calls submit()") do not trip the scan.
function code(rel) {
  return read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function scan(patterns, list = js) {
  const hits = [];
  for (const f of list) {
    const src = code(f);
    for (const re of patterns) {
      const m = src.match(re);
      if (m) hits.push(`${f}: ${m[0]}`);
    }
  }
  return hits;
}

test('[T7] no eval, Function constructor, string timers or HTML injection sinks', () => {
  assert.deepEqual(scan([/\beval\s*\(/, /\bnew\s+Function\b/, /(^|[^.\w])Function\s*\(/, /set(Timeout|Interval)\s*\(\s*['"`]/, /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /createContextualFragment/, /DOMParser/, /\.srcdoc\s*=/, /\.setHTML(Unsafe)?\(/]), []);
});

test('[T7] no remote code: no remote script URLs, no dynamic import, no importScripts', () => {
  assert.deepEqual(scan([/\bimport\s*\(/, /importScripts/, /from\s+['"](?!\.{1,2}\/)/]), []);
  for (const f of html) {
    const src = read(f);
    assert.doesNotMatch(src, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f}: inline script`);
    assert.doesNotMatch(src, /<script[^>]*src=["']?(https?:)?\/\//i, `${f}: remote script`);
    assert.doesNotMatch(src, /\son[a-z]+\s*=/i, `${f}: inline event handler`);
    assert.doesNotMatch(src, /\sstyle\s*=/i, `${f}: inline style attribute`);
    assert.doesNotMatch(src, /javascript:/i, `${f}: javascript: URL`);
  }
  for (const f of css) assert.doesNotMatch(read(f), /url\(|@import/i, `${f}: external CSS resource`);
});

test('[T6] no network APIs and no URLs in code except the SVG namespace', () => {
  assert.deepEqual(scan([/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /RTCPeerConnection/, /navigator\.connection/, /chrome\.storage\.sync/, /storage\.sync/, /chrome\.identity/, /chrome\.downloads/]), []);
  const urls = [];
  for (const f of [...js, ...html, ...css]) {
    for (const m of (f.endsWith('.js') ? code(f) : read(f)).matchAll(/https?:\/\/[^\s'"`)]+/g)) urls.push(m[0]);
  }
  assert.deepEqual([...new Set(urls)].filter((u) => u !== 'http://www.w3.org/2000/svg'), []);
});

test('[T5] the page agent never submits forms, presses keys or clicks anything but the checkbox/radio being filled', () => {
  const agent = code('content/agent.js');
  assert.doesNotMatch(agent, /\.submit\s*\(/);
  assert.doesNotMatch(agent, /requestSubmit/);
  assert.doesNotMatch(agent, /KeyboardEvent|['"]key(down|up|press)['"]/);
  assert.doesNotMatch(agent, /\.form\s*\.\s*\w+\s*\(/, 'no calls on element.form');
  const clicks = [...agent.matchAll(/([\w.]+)\.click\(\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(clicks)].sort(), ['e.el', 'r', 'snap.checked', 'snap.el']);
  // Each click is guarded by a checkbox/radio branch.
  assert.match(agent, /if \(f\.kind === 'checkbox'\) \{[\s\S]*?e\.el\.click\(\)/);
  assert.match(agent, /else if \(f\.kind === 'radio'\) \{[\s\S]*?r\.click\(\)/);
  assert.match(agent, /if \(snap\.kind === 'checkbox'\) \{[\s\S]*?snap\.el\.click\(\)/);
  assert.deepEqual(scan([/\.submit\s*\(/, /requestSubmit/]), []);
});

test('[T9] no external messaging surface; the page agent registers no message listeners', () => {
  assert.deepEqual(scan([/onMessageExternal/, /onConnectExternal/, /externally_connectable/, /tabs\.sendMessage/, /runtime\.connect\b/, /postMessage/]), []);
  assert.doesNotMatch(code('content/agent.js'), /onMessage|addEventListener\(\s*['"]message['"]/);
  assert.doesNotMatch(code('background.js'), /onMessage/);
});

test('[T4] sensitive-field patterns are identical in the page agent and the import schema', () => {
  const grab = (src, name) => (src.match(new RegExp(`const ${name} = (/.*/[a-z]*);`)) || [])[1];
  const agent = read('content/agent.js');
  const schema = read('lib/schema.js').replace(/export const/g, 'const');
  for (const name of ['SENSITIVE_AUTOCOMPLETE', 'SENSITIVE_PASSWORD', 'SENSITIVE_PAYMENT']) {
    assert.ok(grab(agent, name), `${name} in agent`);
    assert.equal(grab(agent, name), grab(schema, name), name);
  }
});

test('[T7] the DOM helper refuses HTML sinks and string event handlers', () => {
  const src = read('lib/dom.js');
  assert.match(src, /FORBIDDEN_PROPS = new Set\(\['innerHTML', 'outerHTML', 'srcdoc'\]\)/);
  assert.match(src, /must be a function/);
});

test('extension sources are plain files: no source maps, no bundled node_modules, no control characters', () => {
  assert.equal(files.some((f) => f.includes('node_modules') || f.endsWith('.map')), false);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const text = files.filter((f) => /\.(js|html|css|json)$/.test(f)).map((f) => path.join(EXT_DIR, f));
  for (const dir of ['test/unit', 'test/e2e', 'scripts', 'scripts/lib']) {
    for (const f of readdirSync(path.join(root, dir))) if (/\.m?js$/.test(f)) text.push(path.join(root, dir, f));
  }
  // eslint-disable-next-line no-control-regex
  const bad = text.filter((f) => /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad, []);
});
