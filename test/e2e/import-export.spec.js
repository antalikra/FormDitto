import { test, expect, ORIGIN_A } from './fixtures.js';
import { readFileSync } from 'node:fs';
import { openForm, openPanel, seedTemplates, storedTemplates, fillVariant } from './helpers.js';

function template(id = 'exp1', name = 'Pumps') {
  return {
    id,
    name,
    origin: ORIGIN_A,
    createdAt: 1767225600000,
    updatedAt: 1767225600000,
    fields: [
      { id: 'f1', kind: 'text', label: 'Model', locator: { sel: '#model', path: [], tag: 'input', type: 'text', id: 'model', name: 'model', label: 'Model', index: 6 } },
      { id: 'f2', kind: 'select', label: 'Equipment type', options: [{ v: 'cpump', t: 'Centrifugal pump' }], locator: { sel: '#equipment', path: [], tag: 'select', id: 'equipment', name: 'equipment', index: 5 } },
    ],
    variants: [
      { id: 'v1', name: 'Pump type B', values: { f1: 'CP-40', f2: 'cpump' } },
      { id: 'v2', name: 'Pump type C', values: { f1: 'CP-65' } },
    ],
  };
}

const file = (name, text) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });

test('[T10] export then import: identical data, existing ids are imported as copies, imported template fills', async ({ context, sw, extensionId }) => {
  await seedTemplates(sw, [template()]);
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);

  const dl = panel.waitForEvent('download');
  await panel.getByTestId('export-all').click();
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/^formditto-templates-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(exported.format).toBe('formditto-templates');
  expect(exported.version).toBe(1);
  expect(exported.templates).toEqual([template()]);

  await panel.locator('#importFile').setInputFiles(file('in.json', JSON.stringify(exported)));
  await expect(panel.getByTestId('import-item')).toHaveCount(1);
  await expect(panel.getByTestId('import-item')).toContainText(ORIGIN_A);
  await panel.getByTestId('import-confirm').click();
  await expect(panel.getByTestId('template-card')).toHaveCount(2);
  const names = (await storedTemplates(sw)).map((t) => t.name).sort();
  expect(names).toEqual(['Pumps', 'Pumps (imported)']);

  await panel.getByTestId('template-card').filter({ hasText: 'Pumps (imported)' }).click();
  await fillVariant(panel, 'Pump type B');
  expect(await page.inputValue('#model')).toBe('CP-40');
  expect(await page.inputValue('#equipment')).toBe('cpump');
});

test('[T10] oversized, non-JSON and schema-violating files are rejected and nothing is saved', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  const input = panel.locator('#importFile');
  const notice = panel.locator('#notice .notice.error');
  const good = { format: 'formditto-templates', version: 1, templates: [template()] };

  const cases = [
    [file('big.json', ' '.repeat(2 * 1024 * 1024 + 1)), 'larger than 2 MB'],
    [file('bad.json', '{"format": "formditto-templates", '), 'not a JSON file'],
    [file('extra.json', JSON.stringify({ ...good, evil: true })), 'unknown key "evil"'],
    [file('proto.json', JSON.stringify(good).replace('"name":"Pumps"', '"name":"Pumps","__proto__":{"admin":true}')), 'unknown key "__proto__"'],
    [file('origin.json', JSON.stringify({ ...good, templates: [{ ...template(), origin: 'javascript:alert(1)' }] })), 'origin'],
    [file('path.json', JSON.stringify({ ...good, templates: [{ ...template(), origin: 'https://portal.example.com/login' }] })), 'origin'],
    [file('pass.json', JSON.stringify({ ...good, templates: [{ ...template(), fields: [{ ...template().fields[0], locator: { ...template().fields[0].locator, type: 'password' } }], variants: [] }] })), 'password'],
    [file('card.json', JSON.stringify({ ...good, templates: [{ ...template(), fields: [{ ...template().fields[0], locator: { ...template().fields[0].locator, autocomplete: 'cc-number' } }], variants: [] }] })), 'payment'],
    [file('long.json', JSON.stringify({ ...good, templates: [{ ...template(), name: 'x'.repeat(121) }] })), 'longer than 120'],
    [file('selector.json', JSON.stringify({ ...good, templates: [{ ...template(), fields: [{ ...template().fields[0], locator: { ...template().fields[0].locator, sel: 'a'.repeat(501) } }], variants: [] }] })), 'longer than 500'],
    [file('value.json', JSON.stringify({ ...good, templates: [{ ...template(), variants: [{ id: 'v1', name: 'x', values: { nope: 'y' } }] }] })), 'unknown field'],
  ];
  for (const [f, message] of cases) {
    await input.setInputFiles(f);
    await expect(notice).toContainText(message);
    await expect(panel.getByTestId('import-item')).toHaveCount(0);
  }
  expect(await storedTemplates(sw)).toEqual([]);
});
