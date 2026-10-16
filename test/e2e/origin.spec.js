import { test, expect, ORIGIN_A, ORIGIN_B } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant, submits, agentCall, tabIdOf, storedTemplates } from './helpers.js';

test('[T2] a copy of the portal on another origin gets a blocking warning; filling needs explicit consent', async ({ context, sw, extensionId }) => {
  const real = await openForm(context, 'portal.html', ORIGIN_A);
  await real.fill('#requester', 'Emily Carter');
  await real.fill('#costcenter', 'CC-4410');
  const realPanel = await openPanel(context, extensionId, sw, real);
  await recordTemplate(realPanel, real, ['#requester', '#costcenter'], { name: 'Portal', variant: 'Emily' });

  const copy = await openForm(context, 'portal.html', ORIGIN_B);
  const panel = await openPanel(context, extensionId, sw, copy);
  // The template is not offered as "for this site".
  await expect(panel.locator('details.others summary')).toContainText('Other sites (1)');
  await panel.locator('details.others summary').click();
  await panel.getByTestId('template-card').click();
  await panel.locator('[data-testid="variant"][data-name="Emily"]').getByTestId('variant-fill').click();

  const warning = panel.getByTestId('origin-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(ORIGIN_A);
  await expect(panel.getByTestId('mismatch-page-origin')).toHaveText(ORIGIN_B);
  const fill = panel.getByTestId('fill-confirm');
  await expect(fill).toBeDisabled();
  // Preview alone never writes anything into the foreign page.
  expect(await copy.inputValue('#requester')).toBe('');

  await panel.getByTestId('mismatch-ack').check();
  await expect(fill).toBeEnabled();
  await panel.getByTestId('mismatch-ack').uncheck();
  await expect(fill).toBeDisabled();
  await panel.getByTestId('mismatch-ack').check();
  await fill.click();
  await expect(panel.getByTestId('stat-filled')).toHaveText('2');
  expect(await copy.inputValue('#requester')).toBe('Emily Carter');
  expect(await submits(copy)).toBe(0);
});

test('[T2] same origin: no warning and the fill button is enabled right away', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  await page.fill('#requester', 'Emily');
  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, ['#requester'], { name: 'Portal', variant: 'Emily' });
  await page.reload();
  await panel.locator('[data-testid="variant"][data-name="Emily"]').getByTestId('variant-fill').click();
  await expect(panel.getByTestId('origin-warning')).toHaveCount(0);
  await expect(panel.getByTestId('fill-confirm')).toBeEnabled();
});

test('[T13] after the tab navigates to another origin, the preview is closed and the agent refuses to fill', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html', ORIGIN_A);
  await page.fill('#requester', 'Emily');
  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, ['#requester'], { name: 'Portal', variant: 'Emily' });
  await page.reload();
  await panel.locator('[data-testid="variant"][data-name="Emily"]').getByTestId('variant-fill').click();
  await expect(panel.getByTestId('fill-confirm')).toBeEnabled();

  // Same tab goes to a look-alike copy on another origin.
  const tabId = await tabIdOf(sw, page);
  await page.goto(`${ORIGIN_B}/portal.html`);
  await expect(panel.getByTestId('preview-table')).toHaveCount(0);
  await expect(panel.getByTestId('tpl-title')).toBeVisible();

  // Even a direct call with the old origin is refused by the agent itself.
  const [tpl] = await storedTemplates(sw);
  const res = await agentCall(sw, tabId, 'fill', { origin: ORIGIN_A, fields: tpl.fields, values: tpl.variants[0].values, timeoutMs: 0 });
  expect(res).toEqual({ ok: false, error: 'origin-mismatch' });
  expect(await page.inputValue('#requester')).toBe('');
});
