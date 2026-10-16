import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplate, validateExport, parseImport, buildExport, isValidOrigin, LIMITS, EXPORT_FORMAT } from '../../extension/lib/schema.js';

const field = (over = {}) => ({ id: 'f1', kind: 'text', label: 'Model', locator: { sel: '#model', path: [], tag: 'input', type: 'text', name: 'model', index: 0 }, ...over });
const tpl = (over = {}) => ({ id: 't1', name: 'Pumps', origin: 'https://portal.example.com', fields: [field()], variants: [{ id: 'v1', name: 'B', values: { f1: 'CP-40' } }], ...over });
const doc = (templates) => ({ format: EXPORT_FORMAT, version: 1, templates });
const withLocator = (extra) => tpl({ fields: [field({ locator: { ...field().locator, ...extra } })], variants: [] });

test('[T10] a valid template passes and comes back as a clean copy', () => {
  const r = validateTemplate(tpl());
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, tpl());
  assert.notEqual(r.value, tpl());
});

test('[T10] unknown keys, __proto__ and constructor keys are rejected at every level', () => {
  assert.equal(validateTemplate({ ...tpl(), extra: 1 }).ok, false);
  const proto = JSON.parse(JSON.stringify(tpl()).replace('"name":"Pumps"', '"name":"Pumps","__proto__":{"polluted":true}'));
  const r = validateTemplate(proto);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown key "__proto__"/);
  assert.equal({}.polluted, undefined);
  assert.equal(validateTemplate(tpl({ fields: [field({ constructor: 'x' })] })).ok, false);
  assert.equal(validateTemplate(tpl({ variants: [{ id: 'v1', name: 'B', values: { f1: 'x' }, admin: true }] })).ok, false);
  const valuesProto = JSON.parse('{"__proto__": "x"}');
  assert.equal(validateTemplate(tpl({ variants: [{ id: 'v1', name: 'B', values: valuesProto }] })).ok, false);
});

test('[T10] origins must be bare http(s) origins', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'https://portal.example.com/', 'https://portal.example.com/login', 'https://user:pw@portal.example.com', 'data:text/html,x', '', 'https://']) {
    assert.equal(isValidOrigin(bad), false, bad);
    assert.equal(validateTemplate(tpl({ origin: bad })).ok, false, bad);
  }
  for (const good of ['https://portal.example.com', 'http://127.0.0.1:5179', 'https://xn--80ak6aa92e.com']) assert.equal(isValidOrigin(good), true, good);
});

test('[T10] string, array and count limits are enforced', () => {
  assert.equal(validateTemplate(tpl({ name: 'x'.repeat(LIMITS.name + 1) })).ok, false);
  assert.equal(validateTemplate(tpl({ name: '' })).ok, false);
  assert.equal(validateTemplate(withLocator({ sel: 'a'.repeat(LIMITS.selector + 1) })).ok, false);
  assert.equal(validateTemplate(withLocator({ path: Array.from({ length: LIMITS.pathDepth + 1 }, () => ({ t: 'shadow', sel: 'x' })) })).ok, false);
  assert.equal(validateTemplate(withLocator({ path: [{ t: 'script', sel: 'x' }] })).ok, false);
  assert.equal(validateTemplate(tpl({ variants: [{ id: 'v1', name: 'B', values: { f1: 'x'.repeat(LIMITS.value + 1) } }] })).ok, false);
  const many = Array.from({ length: LIMITS.fields + 1 }, (_, i) => field({ id: `f${i}` }));
  assert.equal(validateTemplate(tpl({ fields: many, variants: [] })).ok, false);
  assert.equal(validateTemplate(tpl({ fields: [] })).ok, false);
  assert.equal(validateTemplate(tpl({ id: '../../x' })).ok, false);
  assert.equal(validateTemplate(tpl({ id: 'a'.repeat(41) })).ok, false);
});

test('[T10] values must reference existing fields and match the field kind', () => {
  assert.equal(validateTemplate(tpl({ variants: [{ id: 'v1', name: 'B', values: { nope: 'x' } }] })).ok, false);
  const cb = tpl({ fields: [field({ kind: 'checkbox', locator: { ...field().locator, type: 'checkbox' } })], variants: [{ id: 'v1', name: 'B', values: { f1: 'yes' } }] });
  assert.equal(validateTemplate(cb).ok, false);
  cb.variants[0].values.f1 = true;
  assert.equal(validateTemplate(cb).ok, true);
  assert.equal(validateTemplate(tpl({ variants: [{ id: 'v1', name: 'B', values: { f1: 42 } }] })).ok, false);
  assert.equal(validateTemplate(tpl({ fields: [field(), field()] })).ok, false, 'duplicate field ids');
  assert.equal(validateTemplate(tpl({ variants: [{ id: 'v1', name: 'a', values: {} }, { id: 'v1', name: 'b', values: {} }] })).ok, false, 'duplicate variant ids');
});

test('[T10] kind, tag and input type must agree', () => {
  assert.equal(validateTemplate(tpl({ fields: [field({ kind: 'macro' })] })).ok, false);
  assert.equal(validateTemplate(withLocator({ tag: 'select' })).ok, false);
  assert.equal(validateTemplate(withLocator({ type: 'checkbox' })).ok, false);
  assert.equal(validateTemplate(withLocator({ type: 'submit' })).ok, false);
  assert.equal(validateTemplate(tpl({ fields: [field({ inputType: 'date' })] })).ok, false);
  assert.equal(validateTemplate(tpl({ fields: [field({ options: [{ v: 'a', t: 'A' }] })] })).ok, false, 'options only for select/radio');
});

test('[T4] password, payment-card, one-time-code and hidden field locators are rejected', () => {
  const cases = [
    { type: 'password' }, { type: 'hidden' }, { type: 'file' },
    { autocomplete: 'cc-number' }, { autocomplete: 'section-pay billing cc-csc' }, { autocomplete: 'current-password' }, { autocomplete: 'new-password' }, { autocomplete: 'one-time-code' },
    { name: 'user_password' }, { name: 'pwd' }, { id: 'cvv' }, { name: 'card_number' }, { label: 'Номер карты' }, { label: 'Пароль' }, { placeholder: 'CVC' }, { ariaLabel: 'Security code' }, { name: 'otp' },
  ];
  for (const extra of cases) {
    const r = validateTemplate(withLocator(extra));
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.match(r.error, /password, payment-card and hidden fields are not allowed|does not fit kind/, JSON.stringify(extra));
  }
  for (const extra of [{ name: 'passport_number' }, { label: 'Card holder company' }, { name: 'discount' }]) {
    assert.equal(validateTemplate(withLocator(extra)).ok, true, JSON.stringify(extra));
  }
});

test('[T10] parseImport: size limit before parsing, JSON errors, schema errors', () => {
  const good = JSON.stringify(doc([tpl()]));
  assert.deepEqual(parseImport(good, good.length).ok, true);
  assert.deepEqual(parseImport(good, LIMITS.importBytes + 1), { ok: false, error: 'too-large' });
  assert.deepEqual(parseImport('{', 1), { ok: false, error: 'not-json' });
  assert.equal(parseImport(JSON.stringify({ ...doc([tpl()]), format: 'other' }), 10).error, 'schema');
  assert.equal(parseImport(JSON.stringify({ ...doc([tpl()]), version: 2 }), 10).error, 'schema');
  assert.equal(parseImport(JSON.stringify(doc([])), 10).error, 'schema');
  assert.equal(parseImport(JSON.stringify(doc([tpl(), tpl()])), 10).error, 'schema', 'duplicate ids');
  assert.equal(parseImport('[]', 2).error, 'schema');
  assert.equal(parseImport('null', 4).error, 'schema');
  const tooMany = doc(Array.from({ length: LIMITS.templatesPerImport + 1 }, (_, i) => tpl({ id: `t${i}` })));
  assert.equal(parseImport(JSON.stringify(tooMany), 100).error, 'schema');
});

test('[T10] selectors are kept as inert data (never interpreted at import)', () => {
  const sneaky = withLocator({ sel: 'img[src=x][onerror="alert(1)"]', label: '<script>alert(1)</script>' });
  const r = validateTemplate(sneaky);
  assert.equal(r.ok, true);
  assert.equal(r.value.fields[0].locator.sel, 'img[src=x][onerror="alert(1)"]');
});

test('buildExport produces a document that validates', () => {
  const out = buildExport([tpl()], new Date('2026-10-15T00:00:00Z'));
  assert.equal(out.exportedAt, '2026-10-15T00:00:00.000Z');
  assert.equal(validateExport(JSON.parse(JSON.stringify(out))).ok, true);
});

test('[T10] an optional section heading is kept as a bounded string', () => {
  const r = validateTemplate(tpl({ fields: [field({ section: 'Requester' })] }));
  assert.equal(r.ok, true);
  assert.equal(r.value.fields[0].section, 'Requester');
  assert.equal(validateTemplate(tpl({ fields: [field({ section: 5 })] })).ok, false);
  assert.equal(validateTemplate(tpl({ fields: [field({ section: 'x'.repeat(LIMITS.label + 1) })] })).ok, false);
});
