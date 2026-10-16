// Shared steps for the e2e suite.
import { expect, ORIGIN_A } from './fixtures.js';

export async function openForm(context, file, origin = ORIGIN_A) {
  const page = await context.newPage();
  await page.goto(`${origin}/${file}`);
  await page.waitForLoadState('load');
  return page;
}

export async function tabIdOf(sw, page) {
  const url = page.url();
  const id = await sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === u);
    return tab ? tab.id : null;
  }, url);
  if (id === null) throw new Error(`tab not found for ${url}`);
  return id;
}

/** Opens sidepanel.html in a normal tab, pointed at the tab that shows `page`. */
export async function openPanel(context, extensionId, sw, page) {
  const tabId = await tabIdOf(sw, page);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
  await panel.waitForSelector('body[data-ready="1"]');
  return panel;
}

/** Calls the page agent directly (from the service worker), as the panel does. */
export async function agentCall(sw, tabId, method, args = {}) {
  return sw.evaluate(async ({ tabId: id, method: m, args: a }) => {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/agent.js'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: (mm, aa) => globalThis.__formditto.call(mm, aa), args: [m, a] });
    return r.result;
  }, { tabId, method, args });
}

export async function storedTemplates(sw) {
  return sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).filter(([k]) => k.startsWith('tpl:')).map(([, v]) => v);
  });
}

export async function seedTemplates(sw, templates, settings) {
  await sw.evaluate(async ({ list, s }) => {
    const items = {};
    for (const t of list) items[`tpl:${t.id}`] = t;
    if (s) items.settings = s;
    await chrome.storage.local.set(items);
  }, { list: templates, s: settings || null });
}

/** Records a template through the UI by clicking the given selectors on the page. */
export async function recordTemplate(panel, page, selectors, { name = 'Service request', variant = 'Pump type B', addAll = false } = {}) {
  await panel.getByTestId('new-template').click();
  await expect(panel.getByTestId('rec-save')).toBeVisible();
  if (addAll) await panel.getByTestId('rec-add-all').click();
  for (const sel of selectors) await page.click(sel);
  const expected = addAll ? undefined : selectors.length;
  if (expected !== undefined) await expect(panel.getByTestId('rec-field')).toHaveCount(expected);
  await panel.getByTestId('tpl-name').fill(name);
  await panel.getByTestId('variant-name').fill(variant);
  await panel.getByTestId('rec-save').click();
  // A recording from an empty form opens the editor of the first variant; saving it unchanged
  // keeps the recorded values.
  const editSave = panel.getByTestId('edit-save');
  await expect(panel.getByTestId('tpl-title').or(editSave)).toBeVisible();
  if (await editSave.isVisible()) await editSave.click();
  await expect(panel.getByTestId('tpl-title')).toHaveText(name);
  await expectCleanText(panel);
}

/**
 * Opens sidepanel.html in its own popup window, following the active tab of `windowId` the way
 * the real side panel follows its browser window.
 */
export async function openFollowingPanel(context, extensionId, sw, windowId) {
  const opened = context.waitForEvent('page');
  await sw.evaluate(({ url }) => chrome.windows.create({ url, type: 'popup', width: 420, height: 900, focused: false }), { url: `chrome-extension://${extensionId}/sidepanel.html?window=${windowId}` });
  const panel = await opened;
  await panel.waitForSelector('body[data-ready="1"]');
  return panel;
}

export async function fillVariant(panel, variantName, { expectMismatch = false } = {}) {
  const row = panel.getByTestId('variant').filter({ has: panel.locator('.variant-name').getByText(variantName, { exact: true }) });
  await row.getByTestId('variant-fill').click();
  await expect(panel.getByTestId('preview-table')).toBeVisible();
  await expectCleanText(panel);
  if (expectMismatch) return;
  await panel.getByTestId('fill-confirm').click();
  await expect(panel.getByTestId('result-stats')).toBeVisible({ timeout: 30_000 });
  await expectCleanText(panel);
}

/** Guards against values leaking into the UI as the words "null" or "undefined". */
export async function expectCleanText(panel) {
  await expect(panel.locator('body')).not.toContainText(/\b(null|undefined|NaN)\b/);
}

export const submits = (page) => page.evaluate(() => window.__submits);
