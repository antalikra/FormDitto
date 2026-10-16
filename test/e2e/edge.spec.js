// Edge cases: what is never read, and fields that must not swap values.
import { test, expect } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant, storedTemplates, tabIdOf, agentCall, expectCleanText, submits } from './helpers.js';

const fast = { waitTimeoutMs: 500, language: 'auto', theme: 'auto', recSync: 'both' };
const setFast = (sw) => sw.evaluate((s) => chrome.storage.local.set({ settings: s }), fast);

test('[T3][T4] a recorded field that is now hidden or a card field: the preview reads nothing from it', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'edge.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await page.fill('#reference', 'R-1');
  await page.fill('#notes', 'N-1');
  await recordTemplate(panel, page, ['#reference', '#notes'], { name: 'Edge', variant: 'One' });
  // The site hides one field with a private value and turns the other into a card field.
  await page.evaluate(() => {
    const r = document.getElementById('reference');
    r.value = 'HIDDEN-VALUE';
    r.style.display = 'none';
    const n = document.getElementById('notes');
    n.value = 'DO-NOT-READ';
    n.setAttribute('autocomplete', 'cc-number');
  });
  await fillVariant(panel, 'One', { expectMismatch: true });
  await expect(panel.getByTestId('preview-table')).not.toContainText('HIDDEN-VALUE');
  await expect(panel.getByTestId('preview-table')).not.toContainText('DO-NOT-READ');
  // Nor does the agent's answer carry them.
  const [tpl] = await storedTemplates(sw);
  const res = await agentCall(sw, await tabIdOf(sw, page), 'preview', { origin: new URL(page.url()).origin, fields: tpl.fields });
  expect(res.rows.map((r) => r.status)).toEqual(['blocked', 'blocked']);
  expect(JSON.stringify(res)).not.toMatch(/HIDDEN-VALUE|DO-NOT-READ/);
});

test('[T3] a hidden checked radio is never read: not as the recorded value, not as an option', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'edge.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-save').waitFor();
  await page.click('input[value="pickup"]');
  const row = panel.getByTestId('rec-field').filter({ hasText: 'Delivery' });
  await expect(row.locator('.sk-opt')).toHaveText(['Pickup', 'Courier']);
  await expect(row.locator('.sk-opt.on')).toHaveCount(0);
  await panel.getByTestId('rec-save').click();
  await expect(panel.getByTestId('edit-save')).toBeVisible();
  const [tpl] = await storedTemplates(sw);
  expect(tpl.variants[0].values).toEqual({});
  expect(JSON.stringify(tpl)).not.toContain('saved-address-123');
});

test('[T13] fields the site reordered still get their own values (a position never beats a contradicting label)', async ({ context, sw, extensionId }) => {
  await setFast(sw);
  const page = await openForm(context, 'edge.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await page.fill('#wrapA input', 'Emily Carter');
  await page.fill('#wrapB input', 'Acme Ltd');
  await recordTemplate(panel, page, ['#wrapA input', '#wrapB input'], { name: 'People', variant: 'Emily' });
  await page.reload();
  await page.evaluate(() => document.getElementById('contact').prepend(document.getElementById('wrapB')));
  await fillVariant(panel, 'Emily');
  expect(await page.inputValue('#wrapA input')).toBe('Emily Carter');
  expect(await page.inputValue('#wrapB input')).toBe('Acme Ltd');
});

test('[T13] a field missing from the page never takes the element the preview gave to another field', async ({ context, sw, extensionId }) => {
  await setFast(sw);
  const page = await openForm(context, 'edge.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await page.fill('#primary', 'Primary person');
  await page.fill('#secondary', 'Second person');
  await recordTemplate(panel, page, ['#primary', '#secondary'], { name: 'Twins', variant: 'Both' });
  await page.reload();
  await page.evaluate(() => document.getElementById('primary').remove());
  await fillVariant(panel, 'Both');
  expect(await page.inputValue('#secondary')).toBe('Second person');
  await expect(panel.getByTestId('result-problem')).toHaveCount(1);
  await expect(panel.getByTestId('result-problem')).toContainText('Contact name');
});

test('[T13] unavailable list options (disabled, or in a disabled group) are never chosen', async ({ context, sw, extensionId }) => {
  await setFast(sw);
  const page = await openForm(context, 'edge.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await page.selectOption('#plan', 'basic');
  await recordTemplate(panel, page, ['#plan'], { name: 'Plans', variant: 'Premium' });
  // Variants that ask for an option a person could not pick.
  await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const [key, tpl] = Object.entries(all).find(([k]) => k.startsWith('tpl:'));
    tpl.variants[0].values = { f1: 'premium' };
    tpl.variants.push({ id: 'v-old', name: 'Old', updatedAt: Date.now(), values: { f1: 'old' } });
    await chrome.storage.local.set({ [key]: tpl });
  });
  await page.reload();
  // The open template view picks the change up from storage.
  await expect(panel.locator('.variant-name', { hasText: 'Old' })).toBeVisible();
  for (const name of ['Premium', 'Old']) {
    await fillVariant(panel, name);
    expect(await page.inputValue('#plan')).toBe('');
    await expect(panel.getByTestId('result-problem')).toContainText('Plan');
    await panel.getByTestId('done').click();
  }
});

test('[T13] a field the page re-renders while being filled is judged on the live field, and undo counts only real restores', async ({ context, sw, extensionId }) => {
  await setFast(sw);
  const page = await openForm(context, 'edge.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await page.fill('#reference', 'R-42');
  await page.fill('#notes', 'Call first');
  await recordTemplate(panel, page, ['#reference', '#notes'], { name: 'Refs', variant: 'R42' });
  await page.reload();
  // The reference input is replaced by a fresh one (with its own default) as soon as it gets input.
  await page.evaluate(() => {
    const r = document.getElementById('reference');
    r.addEventListener('input', () => {
      const n = r.cloneNode();
      n.value = 'default';
      r.replaceWith(n);
    }, { once: true });
  });
  await fillVariant(panel, 'R42');
  expect(await page.inputValue('#reference')).toBe('default');
  expect(await page.inputValue('#notes')).toBe('Call first');
  await expect(panel.getByTestId('result-problem')).toHaveCount(1);
  await expect(panel.getByTestId('result-problem')).toContainText('Reference');
  await panel.getByTestId('undo').click();
  await expect(panel.locator('#notice')).toContainText('1');
  expect(await page.inputValue('#notes')).toBe('');
  await expectCleanText(panel);
  expect(await submits(page)).toBe(0);
});

test('labels in the previous column of a grid row name their fields (Bootstrap-style forms)', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'edge.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await expect(panel.getByTestId('rec-save')).toBeVisible();
  await page.click('#gridEmail');
  await page.click('#shiftNight');
  await expect(panel.getByTestId('rec-field').locator('.sk-label')).toHaveText(['Work email', 'Shift']);
});
