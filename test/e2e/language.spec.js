// The panel language and theme can be picked in the panel itself; "auto" follows the browser/system.
import { test, expect } from './fixtures.js';
import { openForm, openPanel } from './helpers.js';

/** Opens one of the panel's own dropdowns and picks a value. */
async function pick(panel, testid, value) {
  await panel.getByTestId(testid).click();
  await panel.locator(`.dd-menu:popover-open .dd-opt[data-value="${value}"]`).click();
  await expect(panel.locator('.dd-menu:popover-open')).toHaveCount(0);
}

test('the language picker switches the panel at once and remembers the choice', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  let panel = await openPanel(context, extensionId, sw, page);
  // The language is a one-time choice: it lives in the settings, not in the top bar.
  await expect(panel.locator('.topbar .dd')).toHaveCount(0);
  await panel.locator('#settingsBtn').click();
  const picker = panel.getByTestId('language');
  await expect(picker).toHaveText('As in browser (English)');
  await picker.click();
  const menu = panel.locator('.dd-menu:popover-open');
  await expect(menu.locator('.dd-opt')).toHaveCount(15);
  await expect(menu.locator('.dd-opt[aria-selected="true"]')).toHaveText('As in browser (English)');
  // Keyboard: arrows move, Escape closes and gives focus back to the button.
  await panel.keyboard.press('ArrowDown');
  await expect(menu.locator('.dd-opt').nth(1)).toBeFocused();
  await panel.keyboard.press('Escape');
  await expect(panel.locator('.dd-menu:popover-open')).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(panel.locator('h1')).toHaveText('Settings');

  await pick(panel, 'language', 'de');
  await expect(panel.locator('h1')).toHaveText('Einstellungen');
  await expect(panel.locator('html')).toHaveAttribute('lang', 'de');
  await expect(panel.locator('#settingsBtn')).toHaveAttribute('title', 'Einstellungen');
  await expect(panel.getByTestId('language')).toHaveText('Deutsch');
  await expect(panel.getByTestId('language')).toHaveAttribute('aria-label', 'Sprache: Deutsch');
  expect((await sw.evaluate(() => chrome.storage.local.get('settings'))).settings.language).toBe('de');

  // A reopened panel starts in the chosen language.
  await panel.close();
  panel = await openPanel(context, extensionId, sw, page);
  await expect(panel.getByTestId('new-template')).toHaveText('Neue Vorlage');
  await panel.locator('#settingsBtn').click();
  await pick(panel, 'language', 'ja');
  await expect(panel.locator('h1')).toHaveText('設定');

  // Keyboard choice: focus comes back to the (re-created) picker.
  await panel.getByTestId('language').focus();
  await panel.keyboard.press('ArrowDown');
  await expect(panel.locator('.dd-menu:popover-open .dd-opt[aria-selected="true"]')).toBeFocused();
  await panel.keyboard.press('Home');
  await panel.keyboard.press('Enter');
  await expect(panel.getByTestId('language')).toBeFocused();
  await expect(panel.locator('h1')).toHaveText('Settings');
  // Resizing the panel closes an open list instead of leaving it detached.
  await panel.getByTestId('language').click();
  await expect(panel.locator('.dd-menu:popover-open')).toHaveCount(1);
  await panel.setViewportSize({ width: 330, height: 700 });
  await expect(panel.locator('.dd-menu:popover-open')).toHaveCount(0);
  await expect(panel.getByTestId('language')).toHaveText('As in browser (English)');
});

test('the theme follows the system until the person picks one, from the top bar or the settings', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  const html = panel.locator('html');
  await panel.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await panel.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-theme', 'light');

  await panel.locator('#themeBtn').click();
  // One switch for the whole panel: no element eases its colours at its own speed.
  const easing = await panel.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(document.getAnimations().filter((x) => x instanceof CSSTransition).length))));
  expect(easing).toBe(0);
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).not.toHaveClass(/theme-switch/);
  expect((await sw.evaluate(() => chrome.storage.local.get('settings'))).settings.theme).toBe('dark');
  // An explicit choice no longer follows the system.
  await panel.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await panel.locator('#settingsBtn').click();
  await panel.getByTestId('theme').locator('[data-value="light"]').click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  // Radio groups: arrow keys move and pick, focus stays on the picked option.
  await panel.getByTestId('theme').locator('[data-value="light"]').focus();
  await panel.keyboard.press('ArrowRight');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(panel.getByTestId('theme').locator('[data-value="dark"]')).toBeFocused();
  await panel.getByTestId('theme').locator('[data-value="auto"]').click();
  await panel.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'dark');
  // Notices are toasts at the bottom: the view does not move when one appears.
  const before = await panel.locator('h1').boundingBox();
  await panel.getByTestId('wait-seconds').locator('[data-value="10"]').click();
  await expect(panel.locator('#notice')).toContainText('Settings saved');
  expect((await panel.locator('h1').boundingBox()).y).toBe(before.y);
  // Segmented controls change in place and their pill slides (as in Convertly) instead of jumping.
  const seg = panel.getByTestId('wait-seconds');
  const pill = seg.locator('.seg-pill');
  const from = await pill.evaluate((p) => p.style.transform);
  await seg.locator('[data-value="20"]').click();
  await expect.poll(() => pill.evaluate((p) => p.style.transform)).not.toBe(from);
  expect(await pill.evaluate((p) => getComputedStyle(p).transitionProperty)).toContain('transform');
  await expect(seg.locator('[data-value="20"]')).toBeFocused();
});

test('the settings open over a recording or an unsaved variant, and "back" returns to it as it was', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-save').waitFor();
  await page.click('#model');
  const model = panel.getByTestId('rec-field').filter({ hasText: 'Model' }).locator('input');
  await model.fill('CP-40');
  await panel.getByTestId('tpl-name').fill('Pumps');
  await panel.locator('#settingsBtn').click();
  await expect(panel.locator('h1')).toHaveText('Settings');
  // The recording goes on meanwhile: a field picked on the page is there on return.
  await page.click('#qty');
  await panel.getByTestId('back').click();
  await expect(panel.getByTestId('rec-field')).toHaveCount(2);
  await expect(model).toHaveValue('CP-40');
  await expect(panel.getByTestId('tpl-name')).toHaveValue('Pumps');
  // The gear button closes the settings too.
  await panel.locator('#settingsBtn').click();
  await panel.locator('#settingsBtn').click();
  await expect(panel.getByTestId('rec-count')).toHaveText('2');

  await panel.getByTestId('rec-save').click();
  await expect(panel.getByTestId('tpl-title')).toHaveText('Pumps');
  await panel.getByTestId('variant-edit').first().click();
  await panel.getByTestId('variant-name').fill('Not saved yet');
  await panel.locator('#settingsBtn').click();
  await panel.getByTestId('back').click();
  await expect(panel.getByTestId('variant-name')).toHaveValue('Not saved yet');
  await panel.getByTestId('edit-save').click();
  await expect(panel.locator('#notice')).toContainText('Not saved yet');
});
