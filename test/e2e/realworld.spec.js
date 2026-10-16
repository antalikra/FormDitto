// Patterns of real sites (test/pages/realworld.html, dynamic.html): masks, re-rendered sections,
// modal dialogs, custom lists over a hidden select, SPA route changes, dependent lists on undo.
import { test, expect } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant, storedTemplates, submits } from './helpers.js';

const fast = { waitTimeoutMs: 1500, language: 'auto', theme: 'auto', recSync: 'both' };

test('[T13] masks and transforms: the page format is what the panel shows, what is saved, and what fills; undo brings back the old value', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'realworld.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await expect(panel.getByTestId('rec-save')).toBeVisible();
  await page.click('#phone');
  await page.click('#plate');
  await page.click('#inn');
  const row = (label) => panel.getByTestId('rec-field').filter({ hasText: label });
  await row('Mobile phone').locator('input').fill('9991234567');
  await row('Vehicle plate').locator('input').fill('a123bc77');
  await row('Tax number').locator('input').fill('77-01 x 234');
  await expect(page.locator('#phone')).toHaveValue('+7 (999) 123-45-67');
  await expect(page.locator('#plate')).toHaveValue('A123BC77');
  await expect(page.locator('#inn')).toHaveValue('7701234');
  // Leaving the panel field shows the page's version there too.
  await panel.locator('h1').click();
  await expect(row('Mobile phone').locator('input')).toHaveValue('+7 (999) 123-45-67');
  await panel.getByTestId('rec-save').click();
  await expect(panel.getByTestId('tpl-title')).toBeVisible();
  const [tpl] = await storedTemplates(sw);
  expect(Object.values(tpl.variants[0].values)).toEqual(['+7 (999) 123-45-67', 'A123BC77', '7701234']);

  // Filling a lower-case plate into the upper-casing field counts as filled (not failed) and can be undone.
  await page.reload();
  await page.fill('#plate', 'OLD1');
  await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const [key, t] = Object.entries(all).find(([k]) => k.startsWith('tpl:'));
    t.variants[0].values.f2 = 'x777xx';
    await chrome.storage.local.set({ [key]: t });
  });
  await fillVariant(panel, 'Variant 1');
  expect(await page.inputValue('#plate')).toBe('X777XX');
  expect(await page.inputValue('#phone')).toBe('+7 (999) 123-45-67');
  await expect(panel.getByTestId('result-problem')).toHaveCount(0);
  await panel.getByTestId('undo').click();
  await expect(panel.getByTestId('undo')).toHaveCount(0);
  await expect(page.locator('#plate')).toHaveValue('OLD1');
  await expect(page.locator('#phone')).toHaveValue('');
  expect(await submits(page)).toBe(0);
});

test('a section the site renders again keeps its recorded fields (same field, new element)', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'realworld.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await expect(panel.getByTestId('rec-save')).toBeVisible();
  await page.click('#first');
  await page.click('#phone');
  await expect(panel.getByTestId('rec-field')).toHaveCount(2);
  // While recording, the first click on a field adds it; the next one acts on the page.
  await page.click('input[value="company"]');
  await expect(panel.getByTestId('rec-field')).toHaveCount(3);
  await page.click('input[value="company"]');
  // Gone from the page: gone from the list (a field that is not there cannot be saved)...
  await expect(panel.getByTestId('rec-field')).toHaveCount(2);
  await page.click('input[value="person"]');
  // ...and back as soon as the same field is rendered again, with its old number.
  await expect(panel.getByTestId('rec-field')).toHaveCount(3);
  await expect(panel.getByTestId('rec-field').filter({ hasText: 'First name' })).toHaveCount(1);
  expect(await page.evaluate(() => window.__renders)).toBe(3);
});

test('a form in a modal dialog: the marks stay above it, fields behind it get none; it records and fills', async ({ context, sw, extensionId }) => {
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), fast);
  const page = await openForm(context, 'realworld.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await expect(panel.getByTestId('rec-save')).toBeVisible();
  await page.click('#openDialog');
  await page.click('#billName');
  await page.keyboard.type('Bill Gates');
  await page.click('#billEmail');
  await expect(panel.getByTestId('rec-field')).toHaveCount(2);
  // The overlay is in the top layer, re-entered after the dialog opened.
  expect(await page.evaluate(() => document.querySelector('formditto-overlay').matches(':popover-open'))).toBe(true);
  await panel.getByTestId('rec-save').click();
  await expect(panel.getByTestId('tpl-title')).toBeVisible();
  await page.reload();
  await page.click('#openDialog');
  await fillVariant(panel, 'Variant 1');
  expect(await page.inputValue('#billName')).toBe('Bill Gates');
  expect(await page.evaluate(() => document.getElementById('billing').open)).toBe(true);
  expect(await submits(page)).toBe(0);
});

test('[T3] a custom list over a hidden select (select2 pattern) is not recorded; contenteditable is not a field', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'realworld.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await expect(panel.getByTestId('rec-save')).toBeVisible();
  await panel.getByTestId('rec-add-all').click();
  await expect(panel.getByTestId('rec-field').first()).toBeVisible();
  const labels = await panel.getByTestId('rec-field').locator('.sk-label').allInnerTexts();
  expect(labels).not.toContain('Manager');
  expect(labels).not.toContain('Notes');
  await page.click('#mgrShown');
  await page.click('#notesRich');
  await expect(panel.getByTestId('rec-field')).toHaveCount(labels.length);
});

test('[T13] an SPA route change after the preview cancels it: nothing is written into the new route', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'realworld.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await page.fill('#ref', 'FRIEND-10');
  await recordTemplate(panel, page, ['#ref'], { name: 'Referral', variant: 'Friend' });
  await page.reload();
  await fillVariant(panel, 'Friend', { expectMismatch: true });
  await page.click('#next');
  await page.click('#prev');
  // The preview was for another address: it is gone, and nothing was filled.
  await expect(panel.getByTestId('preview-table')).toHaveCount(0);
  await expect(panel.getByTestId('tpl-title')).toBeVisible();
  expect(await page.inputValue('#ref')).toBe('');
});

test('[T13] undo puts a dependent list back after its parent: country first, then the city once its options load', async ({ context, sw, extensionId }) => {
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), fast);
  const page = await openForm(context, 'dynamic.html?delay=300');
  const panel = await openPanel(context, extensionId, sw, page);
  await page.selectOption('#region', 'south');
  await expect(page.locator('#city option[value="sunvale"]')).toHaveCount(1);
  await page.selectOption('#city', 'sunvale');
  await recordTemplate(panel, page, ['#region', '#city'], { name: 'Places', variant: 'South' });
  // The person had North / Lakeview before filling.
  await page.reload();
  await page.selectOption('#region', 'north');
  await expect(page.locator('#city option[value="lakeview"]')).toHaveCount(1);
  await page.selectOption('#city', 'lakeview');
  await fillVariant(panel, 'South');
  expect(await page.inputValue('#region')).toBe('south');
  expect(await page.inputValue('#city')).toBe('sunvale');
  await panel.getByTestId('undo').click();
  await expect(panel.locator('#notice')).toContainText('2');
  expect(await page.inputValue('#region')).toBe('north');
  expect(await page.inputValue('#city')).toBe('lakeview');
});
