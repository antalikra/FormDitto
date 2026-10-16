// The panel follows the active tab of its window and says plainly when it has no access to it.
import { test, expect, ORIGIN_A, ORIGIN_B } from './fixtures.js';
import { openForm, tabIdOf, seedTemplates, openFollowingPanel } from './helpers.js';

test('the panel switches to the tab the person activates', async ({ context, sw, extensionId }) => {
  const a = await openForm(context, 'portal.html', ORIGIN_A);
  const b = await openForm(context, 'portal.html', ORIGIN_B);
  const [idA, idB] = [await tabIdOf(sw, a), await tabIdOf(sw, b)];
  const windowId = await sw.evaluate(async ([x, y]) => {
    const tab = await chrome.tabs.get(x);
    await chrome.tabs.move(y, { windowId: tab.windowId, index: -1 });
    await chrome.tabs.update(x, { active: true });
    return tab.windowId;
  }, [idA, idB]);
  const panel = await openFollowingPanel(context, extensionId, sw, windowId);
  await expect(panel.locator('.site-host')).toHaveText('127.0.0.1:5179');

  await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), idB);
  await expect(panel.locator('.site-host')).toHaveText('localhost:5179');
  await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), idA);
  await expect(panel.locator('.site-host')).toHaveText('127.0.0.1:5179');
});

test.describe('with the real manifest (no site access granted)', () => {
  test.use({ production: true });

  test('[T1] a tab without access explains the toolbar click; Fill says the same instead of "open the page"', async ({ context, sw, extensionId }) => {
    await openForm(context, 'portal.html');
    const fields = [{ id: 'f1', kind: 'text', label: 'Full name', locator: { sel: '#requester', path: [], tag: 'input', type: 'text', index: 0, id: 'requester' } }];
    await seedTemplates(sw, [{ id: 'tpl1', name: 'Portal', origin: ORIGIN_A, fields, variants: [{ id: 'v1', name: 'Emily', values: { f1: 'Emily' } }] }]);
    const windowId = await sw.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id);
    const panel = await openFollowingPanel(context, extensionId, sw, windowId);

    await expect(panel.locator('#site')).toContainText('No access to this tab yet');
    await expect(panel.locator('#site')).toContainText('Click the FormDitto icon in the browser toolbar');
    await panel.getByTestId('template-card').click();
    await panel.getByTestId('variant-fill').click();
    await expect(panel.locator('#notice')).toContainText('FormDitto has no access to this tab yet. Click the FormDitto icon in the browser toolbar.');
    await expect(panel.getByTestId('preview-table')).toHaveCount(0);
  });
});
