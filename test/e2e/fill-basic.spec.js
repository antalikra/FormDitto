import { test, expect } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant, submits, storedTemplates } from './helpers.js';

async function fillByHand(page) {
  await page.fill('#requester', 'Emily Carter');
  await page.fill('#email', 'emily.carter@example.com');
  await page.fill('#phone', '+1 555 0100');
  await page.selectOption('#department', 'mnt');
  await page.selectOption('#site', 'p2');
  await page.selectOption('#equipment', 'cpump');
  await page.fill('#model', 'CP-40/160');
  await page.fill('#qty', '2');
  await page.check('input[name="pump_type"][value="B"]');
  await page.check('input[name="priority"][value="high"]');
  await page.fill('#due', '2026-11-20');
  await page.fill('#costcenter', 'CC-4410');
  await page.fill('#address', 'Plant 2, Gate 3\nDock 4');
  await page.check('#onsite');
  await page.uncheck('#notify');
}

async function readPortal(page) {
  return page.evaluate(() => {
    const v = (id) => document.getElementById(id).value;
    const radio = (n) => (document.querySelector(`input[name="${n}"]:checked`) || {}).value || '';
    return {
      requester: v('requester'), email: v('email'), phone: v('phone'), department: v('department'), site: v('site'), equipment: v('equipment'),
      model: v('model'), qty: v('qty'), pump: radio('pump_type'), priority: radio('priority'), due: v('due'), costcenter: v('costcenter'),
      address: v('address'), onsite: document.getElementById('onsite').checked, notify: document.getElementById('notify').checked,
    };
  });
}

test('records a template by clicking fields (labels, kinds and values are captured)', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  await fillByHand(page);
  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, ['#requester', '#department', 'input[name="pump_type"][value="C"]', '#onsite'], { name: 'Clicked', variant: 'Pump B' });
  const [tpl] = await storedTemplates(sw);
  expect(tpl.origin).toBe('http://127.0.0.1:5179');
  expect(tpl.fields.map((f) => [f.label, f.kind])).toEqual([
    ['Full name', 'text'], ['Department', 'select'], ['Pump type', 'radio'], ['Needs on-site visit', 'checkbox'],
  ]);
  const values = tpl.variants[0].values;
  // Recording clicks never change the page: the radio stays "B" although "C" was clicked.
  expect(Object.values(values)).toEqual(['Emily Carter', 'mnt', 'B', true]);
  expect(await page.isChecked('input[name="pump_type"][value="B"]')).toBe(true);
  expect(tpl.fields[2].options.map((o) => o.t)).toEqual(['Type A', 'Type B', 'Type C']);
});

test('[T5] fills a 20-field form from a variant, highlights it, undo restores it; the form is never submitted', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  await fillByHand(page);
  const filled = await readPortal(page);
  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, [], { addAll: true, name: 'Service request', variant: 'Pump type B' });
  const [tpl] = await storedTemplates(sw);
  expect(tpl.fields).toHaveLength(18);

  await page.reload();
  await page.check('input[name="priority"][value="low"]');
  const empty = await readPortal(page);
  expect(empty.requester).toBe('');

  await fillVariant(panel, 'Pump type B');
  // 18 fields: 15 change, "spare parts" is already unchecked, contact and description are empty in the variant.
  await expect(panel.getByTestId('stat-filled')).toHaveText('15');
  expect(await readPortal(page)).toEqual(filled);
  // Highlight overlay is drawn above the page (closed shadow root host element).
  expect(await page.locator('formditto-overlay').count()).toBe(1);

  await panel.getByTestId('undo').click();
  await expect(panel.getByTestId('undo')).toHaveCount(0);
  // Priority goes back to "low". "Pump type" had nothing selected before; a radio group cannot be
  // unselected (by a person either), so it keeps "B".
  expect(await readPortal(page)).toEqual({ ...empty, pump: 'B' });
  expect(await page.locator('formditto-overlay').count()).toBe(0);
  expect(await submits(page)).toBe(0);
});

test('variants: search, duplicate, edit and delete in the side panel', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  await fillByHand(page);
  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, ['#requester', '#model', '#qty'], { name: 'Pumps', variant: 'Pump type B' });
  // A row shows only "Fill"; edit, duplicate and delete are in the opened variant.
  const opened = async (name) => {
    const row = panel.locator(`[data-testid="variant"][data-name="${name}"]`);
    if (!/\bopen\b/.test(await row.getAttribute('class'))) await row.locator('.variant-main').click();
    await expect(row).toHaveClass(/\bopen\b/);
    return row;
  };
  await expect(panel.getByTestId('variant-edit')).toHaveCount(1);

  await (await opened('Pump type B')).getByTestId('variant-duplicate').click();
  const copy = panel.locator('[data-testid="variant"][data-name="Pump type B (copy)"]');
  await expect(copy).toBeVisible();
  await (await opened('Pump type B (copy)')).getByTestId('variant-edit').click();
  await panel.getByTestId('variant-name').fill('Pump type C');
  const inputs = panel.getByTestId('edit-value');
  await inputs.nth(1).fill('CP-65/200');
  await inputs.nth(2).fill('5');
  await panel.getByTestId('edit-save').click();
  await expect(panel.locator('[data-testid="variant"][data-name="Pump type C"]')).toBeVisible();

  // Add two more so the search box appears (shown from 4 variants).
  for (let i = 0; i < 2; i++) await (await opened('Pump type C')).getByTestId('variant-duplicate').click();
  await panel.getByTestId('search-variants').fill('65/200');
  await expect(panel.getByTestId('variant')).toHaveCount(3);
  await panel.getByTestId('search-variants').fill('Pump type B');
  await expect(panel.getByTestId('variant')).toHaveCount(1);
  await panel.getByTestId('search-variants').fill('');

  await (await opened('Pump type B')).getByTestId('variant-delete').click();
  await panel.getByTestId('confirm-delete').click();
  await expect(panel.locator('[data-testid="variant"][data-name="Pump type B"]')).toHaveCount(0);
  const [tpl] = await storedTemplates(sw);
  expect(tpl.variants.map((v) => v.name)).toEqual(['Pump type C', 'Pump type C (copy)', 'Pump type C (copy)']);

  // Fill the edited variant.
  await page.reload();
  await fillVariant(panel, 'Pump type C');
  expect(await page.inputValue('#model')).toBe('CP-65/200');
  expect(await page.inputValue('#qty')).toBe('5');
  expect(await page.inputValue('#requester')).toBe('Emily Carter');
  expect(await submits(page)).toBe(0);
});
