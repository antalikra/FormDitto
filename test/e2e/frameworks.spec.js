import { test, expect } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant, submits } from './helpers.js';

const reactState = async (page) => JSON.parse(await page.textContent('#state'));
const vueState = async (page) => JSON.parse(await page.textContent('#state'));

test('[T5] React controlled inputs: filled values reach React state; undo resets state', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'react.html');
  await page.fill('#fullName', 'Jake Thompson');
  await page.fill('#remail', 'ivan@example.com');
  await page.selectOption('#plan', 'team');
  await page.fill('#startDate', '2026-12-01');
  await page.check('input[name="tier"][value="priority"]');
  await page.check('#agree');
  await page.fill('#notes', 'Call before delivery');
  const recorded = await reactState(page);
  expect(recorded.plan).toBe('team');

  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, [], { addAll: true, name: 'React', variant: 'Team plan' });
  await page.reload();
  await page.waitForSelector('#state');
  const empty = await reactState(page);

  await fillVariant(panel, 'Team plan');
  await expect(panel.getByTestId('stat-problems')).toHaveText('0');
  expect(await reactState(page)).toEqual(recorded);
  // DOM shows the same values as state (React did not revert them on re-render).
  expect(await page.inputValue('#fullName')).toBe('Jake Thompson');
  expect(await page.isChecked('#agree')).toBe(true);

  await panel.getByTestId('undo').click();
  await expect(panel.getByTestId('undo')).toHaveCount(0);
  // Everything returns to the initial state, except the radio group: nothing was selected before
  // and a radio cannot be unselected (by a person either), so the selection is kept.
  await expect.poll(() => reactState(page)).toEqual({ ...empty, tier: 'priority' });
  expect(await page.isChecked('input[name="tier"][value="priority"]')).toBe(true);
  expect(await submits(page)).toBe(0);
});

test('[T5] Vue v-model (including .lazy, select, radio, checkbox): filled values reach Vue state', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'vue.html');
  await page.fill('#company', 'Stackwell Ltd');
  await page.fill('#vcity', 'Lakeview');
  await page.locator('#vcity').blur();
  await page.selectOption('#size', 'm');
  await page.fill('#visit', '2026-10-30');
  await page.check('input[name="billing"][value="yearly"]');
  await page.check('#newsletter');
  await page.fill('#comment', 'Second floor');
  const recorded = await vueState(page);
  expect(recorded.city).toBe('Lakeview');

  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, [], { addAll: true, name: 'Vue', variant: 'Yearly' });
  await page.reload();
  await page.waitForSelector('#state');

  await fillVariant(panel, 'Yearly');
  await expect(panel.getByTestId('stat-problems')).toHaveText('0');
  await expect.poll(() => vueState(page)).toEqual(recorded);
  expect(await submits(page)).toBe(0);
});
