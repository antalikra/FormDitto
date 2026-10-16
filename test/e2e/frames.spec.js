import { test, expect, ORIGIN_A } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant, submits, storedTemplates, agentCall, tabIdOf } from './helpers.js';

test('[T12] same-origin iframe fields are recorded and filled; the other-origin iframe is never touched', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'iframe.html');
  const inner = page.frameLocator('#inner');
  const foreignFrame = () => page.frames().find((f) => f.url().includes('frame-foreign.html'));
  await expect.poll(() => !!foreignFrame()).toBe(true);
  await foreignFrame().waitForSelector('#inner_name');

  await page.fill('#title', 'Spare parts order');
  await inner.locator('#inner_name').fill('Dock 4 team');
  await inner.locator('#inner_qty').fill('3');
  await inner.locator('#inner_kind').selectOption('crate');

  // The agent sees the top document and the same-origin frame only.
  const tabId = await tabIdOf(sw, page);
  const scan = await agentCall(sw, tabId, 'scan', { origin: ORIGIN_A });
  expect(scan.fields.map((f) => f.name).sort()).toEqual(['inner_kind', 'inner_name', 'inner_qty', 'title']);

  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, [], { addAll: true, name: 'Frames', variant: 'Crates' });
  const [tpl] = await storedTemplates(sw);
  expect(tpl.fields.map((f) => f.locator.path.map((p) => p.t).join('/'))).toEqual(['', 'frame', 'frame', 'frame']);

  // Clicking into the other-origin frame during recording does nothing.
  await page.reload();
  await expect.poll(() => !!foreignFrame()).toBe(true);
  await foreignFrame().waitForSelector('#inner_name');
  await fillVariant(panel, 'Crates');
  await expect(panel.getByTestId('stat-filled')).toHaveText('4');
  expect(await page.inputValue('#title')).toBe('Spare parts order');
  expect(await inner.locator('#inner_name').inputValue()).toBe('Dock 4 team');
  expect(await inner.locator('#inner_kind').inputValue()).toBe('crate');
  expect(await foreignFrame().inputValue('#inner_name')).toBe('');
  expect(await foreignFrame().inputValue('#title')).toBe('');
  expect(await submits(page)).toBe(0);
});

test('open shadow DOM (including nested) is supported; closed shadow roots are not entered', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'shadow.html');
  await page.fill('#customer', 'Stackwell Ltd');
  await page.fill('#addr >> #street', '12 Harbour Road');
  await page.fill('#addr >> #city', 'Southport');
  await page.fill('#addr >> #zip', '90210');

  const tabId = await tabIdOf(sw, page);
  const scan = await agentCall(sw, tabId, 'scan', { origin: ORIGIN_A });
  const names = scan.fields.map((f) => f.name);
  expect(names).toEqual(expect.arrayContaining(['customer', 'street', 'city', 'zip']));
  expect(names).not.toContain('closed_note');

  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, ['#customer', '#addr >> #street', '#addr >> #city', '#addr >> #zip'], { name: 'Shadow', variant: 'Harbour' });
  const [tpl] = await storedTemplates(sw);
  expect(tpl.fields.map((f) => f.locator.path.length)).toEqual([0, 1, 1, 2]);

  await page.reload();
  await fillVariant(panel, 'Harbour');
  await expect(panel.getByTestId('stat-filled')).toHaveText('4');
  expect(await page.inputValue('#addr >> #street')).toBe('12 Harbour Road');
  expect(await page.inputValue('#addr >> #zip')).toBe('90210');
  expect(await submits(page)).toBe(0);
});
