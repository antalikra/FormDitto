import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EXT_DIR } from '../../scripts/build.mjs';
import { BLOCK_REASONS } from '../../extension/lib/messages.js';
import { LOCALES } from '../../scripts/i18n-src.mjs';
import { KINDS } from '../../extension/lib/schema.js';
import { MESSAGES, LANGUAGES } from '../../extension/lib/locales.js';

const LOCALES_DIR = path.join(EXT_DIR, '_locales');
const read = (lang) => JSON.parse(readFileSync(path.join(LOCALES_DIR, lang, 'messages.json'), 'utf8'));
const langs = readdirSync(LOCALES_DIR).sort();
const en = read('en');
const panel = readFileSync(path.join(EXT_DIR, 'sidepanel.js'), 'utf8');
const html = readFileSync(path.join(EXT_DIR, 'sidepanel.html'), 'utf8');
const manifest = readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8');

test('the packaged locales are exactly the generated ones (en, ru and 12 more)', () => {
  assert.deepEqual(langs, Object.keys(LOCALES).sort());
  assert.ok(langs.length >= 14);
  assert.equal(JSON.parse(manifest).default_locale, 'en');
});

test('every locale has the same keys and placeholders as en, and no empty message', () => {
  for (const lang of langs) {
    const loc = read(lang);
    assert.deepEqual(Object.keys(loc).sort(), Object.keys(en).sort(), lang);
    for (const k of Object.keys(en)) {
      assert.ok(loc[k].message.trim(), `${lang}.${k} is empty`);
      assert.deepEqual(Object.keys(loc[k].placeholders || {}), Object.keys(en[k].placeholders || {}), `${lang}.${k} placeholders`);
      for (const p of Object.keys(en[k].placeholders || {})) assert.ok(loc[k].message.includes(`$${p.toUpperCase()}$`), `${lang}.${k} uses $${p}`);
    }
    assert.ok(loc.recBanner.message.includes('{n}'), `${lang}.recBanner keeps {n}`);
  }
});

test('translations are real: most strings differ from English', () => {
  for (const lang of langs.filter((l) => l !== 'en')) {
    const loc = read(lang);
    const same = Object.keys(en).filter((k) => loc[k].message === en[k].message);
    assert.ok(same.length / Object.keys(en).length < 0.1, `${lang}: ${same.length} strings equal to English (${same.join(', ')})`);
  }
});

test('hints quote the exact button labels they refer to', () => {
  for (const lang of langs) {
    const loc = read(lang);
    const m = (k) => loc[k].message;
    assert.ok(m('noTemplatesHere').includes(m('newTemplate')), `${lang}: noTemplatesHere → newTemplate`);
    assert.ok(m('noVariants').includes(m('newVariantFromPage')), `${lang}: noVariants → newVariantFromPage`);
    assert.ok(m('siteUnknownBody').includes(m('alwaysAllow')), `${lang}: siteUnknownBody → alwaysAllow`);
  }
});

test('every key used by the panel, the HTML and the manifest exists', () => {
  const used = new Set();
  for (const m of panel.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);
  for (const m of panel.matchAll(/\bt\([^()]*?\? '([A-Za-z0-9_]+)' : '([A-Za-z0-9_]+)'/g)) { used.add(m[1]); used.add(m[2]); }
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
  for (const m of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
  for (const r of BLOCK_REASONS) used.add(`reason_${r.replace(/-/g, '_')}`);
  for (const k of KINDS) used.add(`kind_${k}`);
  for (const s of ['ready', 'unchanged', 'skipped', 'waiting', 'option-wait', 'blocked', 'ambiguous', 'filled', 'not-found', 'no-option', 'failed', 'invalid']) used.add(`st_${s.replace(/-/g, '_')}`);
  used.delete('tab');
  const missing = [...used].filter((k) => !en[k]);
  assert.deepEqual(missing, []);
});

test('store limits in every locale: name ≤ 75 and description ≤ 132 characters', () => {
  for (const lang of langs) {
    const loc = read(lang);
    assert.ok([...loc.extName.message].length <= 75, `${lang}.extName`);
    assert.ok([...loc.extDescription.message].length <= 132, `${lang}.extDescription: ${[...loc.extDescription.message].length}`);
    assert.ok(loc.extName.message.startsWith('FormDitto'), `${lang}.extName keeps the brand`);
  }
});

test('the runtime bundle (lib/locales.js) matches _locales exactly, with a native name per language', () => {
  assert.deepEqual(Object.keys(MESSAGES).sort(), langs);
  assert.deepEqual(LANGUAGES.map(([code]) => code).sort(), langs);
  for (const lang of langs) {
    const loc = read(lang);
    for (const k of Object.keys(en)) assert.equal(MESSAGES[lang][k].replace(/\$([1-9])/g, '$P$1$'), loc[k].message, `${lang}.${k}`);
  }
});
