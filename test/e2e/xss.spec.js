import { test, expect } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant } from './helpers.js';

const TPL_NAME = '<img src=x onerror="document.title=\'pwned\'">';
const VARIANT_NAME = '<script>document.title="pwned"</script>';

test('[T7] HTML in page labels, option texts, template and variant names is shown as plain text', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'xss.html');
  const panel = await openPanel(context, extensionId, sw, page);
  const dialogs = [];
  panel.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-add-all').click();
  await expect(panel.getByTestId('rec-field')).toHaveCount(2);
  await expect(panel.getByTestId('rec-field').first()).toContainText('<img src=x onerror="document.title=\'pwned\'"> Name');
  await expect(panel.getByTestId('rec-field').nth(1)).toContainText('<svg onload=alert(1)>');
  await panel.getByTestId('tpl-name').fill(TPL_NAME);
  await panel.getByTestId('variant-name').fill(VARIANT_NAME);
  await panel.getByTestId('rec-save').click();
  await expect(panel.getByTestId('tpl-title')).toHaveText(TPL_NAME);
  await expect(panel.locator('[data-testid="variant"]')).toContainText(VARIANT_NAME);

  await page.fill('#x1', '');
  await page.selectOption('#x2', 'b');
  await fillVariant(panel, VARIANT_NAME);
  await expect(panel.getByTestId('stat-filled')).toHaveText('2');
  expect(await page.inputValue('#x1')).toBe('"><script>document.title=\'pwned\'</script>');
  await panel.getByTestId('done').click();
  await panel.getByTestId('back').click();
  await expect(panel.getByTestId('template-card')).toContainText(TPL_NAME);

  // No markup was created from data: no images, scripts or SVG other than the panel's own icons.
  const counts = await panel.evaluate(() => ({
    img: document.querySelectorAll('main img, #site img, #notice img').length,
    script: document.querySelectorAll('main script').length,
    foreignSvg: Array.from(document.querySelectorAll('main svg')).filter((s) => !s.classList.contains('ico')).length,
    title: document.title,
  }));
  expect(counts).toEqual({ img: 0, script: 0, foreignSvg: 0, title: 'FormDitto' });
  expect(await page.title()).toBe('Hostile labels');
  expect(dialogs).toEqual([]);
});
