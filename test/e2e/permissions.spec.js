// Runs against the real, unmodified manifest (no test host permissions).
import { test, expect } from './fixtures.js';
import { openForm } from './helpers.js';

test.use({ production: true });

test('[T1] after install the extension has its four API permissions and no access to any site', async ({ sw }) => {
  const perms = await sw.evaluate(() => chrome.permissions.getAll());
  expect(perms.origins).toEqual([]);
  expect([...perms.permissions].sort()).toEqual(['activeTab', 'scripting', 'sidePanel', 'storage']);
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
});

test('[T1] without a grant the panel cannot read or touch the page', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  // Without host access the extension cannot even see the tab URL, let alone inject the agent.
  const tabs = await sw.evaluate(() => chrome.tabs.query({}));
  expect(tabs.every((t) => t.url === undefined)).toBe(true);
  const tabId = Math.max(...tabs.map((t) => t.id)); // the portal tab is the newest one
  const inject = await sw.evaluate(async (id) => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/agent.js'] });
      return 'injected';
    } catch (e) {
      return 'refused';
    }
  }, tabId);
  expect(inject).toBe('refused');

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
  await panel.waitForSelector('body[data-ready="1"]');
  await expect(panel.locator('#site')).toContainText('Click the FormDitto icon in the browser toolbar');
  await expect(panel.getByTestId('new-template')).toBeDisabled();
  expect(await page.locator('formditto-overlay').count()).toBe(0);
});

test('[T1] "Always allow on this site" requests exactly one origin pattern for the current site', async ({ context, extensionId }) => {
  const panel = await context.newPage();
  // Simulate the state right after a toolbar click (activeTab): the URL is known, no permanent grant.
  await panel.addInitScript(() => {
    window.__requests = [];
    chrome.tabs.get = async (id) => ({ id, url: 'https://portal.example.com:8443/requests/new?x=1' });
    chrome.permissions.contains = async () => false;
    chrome.permissions.request = async (p) => { window.__requests.push(p); return false; };
  });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=1`);
  await panel.waitForSelector('body[data-ready="1"]');
  await expect(panel.locator('#site')).toContainText('portal.example.com:8443');
  await panel.getByTestId('allow-site').click();
  await expect.poll(() => panel.evaluate(() => window.__requests)).toEqual([{ origins: ['https://portal.example.com/*'] }]);
});
