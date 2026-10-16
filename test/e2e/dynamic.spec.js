import { test, expect } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant, submits, storedTemplates } from './helpers.js';

test('waits for lists that load later, dependent lists, late fields and fields revealed by earlier answers', async ({ context, sw, extensionId }) => {
  // Record on a fully loaded page.
  const page = await openForm(context, 'dynamic.html?delay=300');
  await page.selectOption('#region', 'south');
  await expect(page.locator('#city option')).toHaveCount(4);
  await page.selectOption('#city', 'riverbend');
  await expect(page.locator('#product option')).toHaveCount(4);
  await page.selectOption('#product', 'p-200');
  await page.check('#express');
  await page.fill('#courier', 'FastLane');
  await page.locator('#batch').waitFor();
  await page.fill('#batch', 'B-2026-17');

  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, ['#region', '#city', '#product', '#express', '#courier', '#batch'], { name: 'Dynamic', variant: 'South' });

  // Fill on a fresh, slow page: product list and batch field are not there yet, the city list
  // loads 1.2 s after the region changes, and "Courier" only appears after "Express" is checked.
  await page.goto(`${page.url().split('?')[0]}?delay=1200`);
  await fillVariant(panel, 'South');
  await expect(panel.getByTestId('stat-filled')).toHaveText('6');
  await expect(panel.getByTestId('stat-problems')).toHaveText('0');
  expect(await page.inputValue('#region')).toBe('south');
  expect(await page.inputValue('#city')).toBe('riverbend');
  expect(await page.inputValue('#product')).toBe('p-200');
  expect(await page.isChecked('#express')).toBe(true);
  expect(await page.inputValue('#courier')).toBe('FastLane');
  expect(await page.inputValue('#batch')).toBe('B-2026-17');
  expect(await submits(page)).toBe(0);
});

test('reports fields that never appear after the timeout instead of hanging', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'dynamic.html?delay=200');
  await page.locator('#batch').waitFor();
  await page.fill('#batch', 'B-1');
  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, ['#batch'], { name: 'Late', variant: 'One' });
  const [tpl] = await storedTemplates(sw);
  // Shorten the wait to 1 s and fill on a page where the batch field appears only after 20 s.
  await sw.evaluate(() => chrome.storage.local.set({ settings: { waitTimeoutMs: 1000 } }));
  await panel.reload();
  await panel.waitForSelector('body[data-ready="1"]');
  await panel.getByTestId('template-card').filter({ hasText: tpl.name }).click();
  await page.goto(`${page.url().split('?')[0]}?delay=20000`);
  const started = Date.now();
  await fillVariant(panel, 'One');
  expect(Date.now() - started).toBeLessThan(12000);
  await expect(panel.getByTestId('stat-problems')).toHaveText('1');
  await expect(panel.getByTestId('result-problem')).toContainText('Batch number');
});
