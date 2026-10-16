import { test, expect } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant } from './helpers.js';

const ALLOWED = [/^http:\/\/127\.0\.0\.1:5179\//, /^http:\/\/localhost:5179\//, /^chrome-extension:\/\//, /^blob:chrome-extension:\/\//, /^data:/, /^about:/];

test('[T6] record, fill, undo, export and settings make no request outside the local test pages', async ({ context, sw, extensionId }) => {
  const seen = [];
  context.on('request', (r) => seen.push({ url: r.url(), frame: r.frame ? '' : 'sw' }));
  context.on('serviceworker', (w) => w.on('request', (r) => seen.push({ url: r.url(), frame: 'sw' })));

  const page = await openForm(context, 'portal.html');
  await page.fill('#requester', 'Emily');
  await page.selectOption('#department', 'ops');
  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, [], { addAll: true, name: 'Net', variant: 'One' });
  await page.reload();
  await fillVariant(panel, 'One');
  await panel.getByTestId('undo').click();
  await panel.getByTestId('done').click();
  await panel.getByTestId('back').click();
  const download = panel.waitForEvent('download');
  await panel.getByTestId('export-all').click();
  await download;
  await panel.locator('#settingsBtn').click();
  await expect(panel.getByTestId('wait-seconds')).toBeVisible();

  const offending = seen.filter((r) => !ALLOWED.some((re) => re.test(r.url)));
  expect(offending).toEqual([]);
  // Extension pages only ever load their own packaged files.
  const ext = seen.filter((r) => r.url.startsWith('chrome-extension://')).map((r) => new URL(r.url).host);
  expect(new Set(ext)).toEqual(new Set([extensionId]));
});
