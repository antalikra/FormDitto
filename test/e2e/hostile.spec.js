// A page that changes fields while FormDitto works on them.
import { test, expect, ORIGIN_A } from './fixtures.js';
import { openForm, openPanel, seedTemplates, fillVariant, submits } from './helpers.js';

const loc = (sel, index, extra = {}) => ({ sel, path: [], tag: 'input', type: 'text', index, ...extra });

async function seed(sw, fields, values) {
  await seedTemplates(sw, [{ id: 'tpl1', name: 'Portal', origin: ORIGIN_A, fields, variants: [{ id: 'v1', name: 'Emily', values }] }], { waitTimeoutMs: 500 });
}

test('[T4] a field that turns into a password field on focus receives nothing', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  await page.evaluate(() => {
    document.getElementById('requester').addEventListener('focus', (e) => { e.target.type = 'password'; });
  });
  await seed(sw, [
    { id: 'f1', kind: 'text', label: 'Full name', locator: loc('#requester', 0, { id: 'requester', name: 'requester' }) },
    { id: 'f2', kind: 'text', label: 'Model', locator: loc('#model', 7, { id: 'model', name: 'model' }) },
  ], { f1: 'Emily Carter', f2: 'CP-40/160' });
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('template-card').click();
  await fillVariant(panel, 'Emily');
  expect(await page.inputValue('#requester')).toBe('');
  expect(await page.inputValue('#model')).toBe('CP-40/160');
  await expect(panel.getByTestId('stat-problems')).toHaveText('1');
  await expect(panel.getByTestId('result-problem')).toContainText('password');
});

test('[T5] Undo never clicks a checkbox that the page turned into a submit button', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  await page.evaluate(() => { document.getElementById('onsite').checked = false; });
  await seed(sw, [{ id: 'f1', kind: 'checkbox', label: 'Needs on-site visit', locator: { sel: '#onsite', path: [], tag: 'input', type: 'checkbox', index: 15, id: 'onsite', name: 'onsite' } }], { f1: true });
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('template-card').click();
  await fillVariant(panel, 'Emily');
  expect(await page.isChecked('#onsite')).toBe(true);
  await page.evaluate(() => { document.getElementById('onsite').type = 'submit'; });
  await panel.getByTestId('undo').click();
  await expect(panel.getByTestId('done')).toBeVisible();
  expect(await submits(page)).toBe(0);
});

test('a recording stops by itself when the panel that started it goes away', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-save').waitFor();
  await page.click('#requester');
  await expect(panel.getByTestId('rec-field')).toHaveCount(1);
  expect(await page.locator('formditto-overlay').count()).toBe(1);
  await panel.close();
  // The agent asks every two seconds; with nobody answering it removes its marks and handlers.
  await expect(page.locator('formditto-overlay')).toHaveCount(0, { timeout: 6000 });
  await page.click('#email');
  await page.keyboard.type('typed normally');
  await expect(page.locator('#email')).toHaveValue('typed normally');
});
