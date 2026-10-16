// Recording UX: values are typed during recording, an empty recording goes to the variant editor.
import { test, expect } from './fixtures.js';
import { openForm, openPanel, storedTemplates, expectCleanText, submits, tabIdOf, agentCall } from './helpers.js';

test('a selected field can be typed into while recording; the value shows up live and becomes the first variant', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-add-all').click();
  await expect(panel.getByTestId('rec-field')).toHaveCount(18);

  // A click on a field that is already in the template focuses it instead of removing it.
  await page.click('#requester');
  await page.keyboard.type('Emily Carter');
  await expect(page.locator('#requester')).toHaveValue('Emily Carter');
  const nameRow = panel.getByTestId('rec-field').filter({ hasText: 'Full name' });
  await expect(nameRow.locator('input')).toHaveValue('Emily Carter');
  // Checkboxes toggle normally once they are in the template.
  await page.click('#onsite');
  await expect(page.locator('#onsite')).toBeChecked();
  const onsiteBox = panel.getByTestId('rec-field').filter({ hasText: 'Needs on-site visit' }).locator('[role="checkbox"]');
  await expect(onsiteBox).toHaveAttribute('aria-checked', 'true');
  // The box shows its state; no "Checked" words next to it.
  await expect(onsiteBox.locator('.sk-value')).toHaveText('');
  await expect(panel.getByTestId('rec-field')).toHaveCount(18);

  // Removing is done in the panel.
  await nameRow.getByTestId('rec-remove').click();
  await expect(panel.getByTestId('rec-field')).toHaveCount(17);
  await page.click('#requester');
  await expect(panel.getByTestId('rec-field')).toHaveCount(18);

  await panel.getByTestId('rec-save').click();
  await expect(panel.getByTestId('tpl-title')).toBeVisible();
  const [tpl] = await storedTemplates(sw);
  const byLabel = Object.fromEntries(tpl.fields.map((f) => [f.label, tpl.variants[0].values[f.id]]));
  expect(byLabel['Full name']).toBe('Emily Carter');
  expect(byLabel['Needs on-site visit']).toBe(true);
  // Each field remembers the part of the form it belongs to (the fieldset legends of the portal).
  expect([...new Set(tpl.fields.map((f) => f.section))]).toEqual(['Requester', 'Equipment', 'Delivery']);
  expect(await submits(page)).toBe(0);

  // The saved variant is drawn as the form, grouped by those sections.
  const sketch = panel.getByTestId('variant').locator('.sketch');
  await expect(sketch.locator('.sk-title')).toHaveText(['Requester', 'Equipment', 'Delivery']);
  await expect(sketch.locator('.k-text').first().locator('.sk-value')).toHaveText('Emily Carter');
  await expect(sketch.locator('.k-checkbox .sk-check.on')).toHaveCount(2);
});

test('saving a recording of an empty form opens the first variant for editing; a stale "select a field" error clears', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-save').click();
  await expect(panel.locator('#notice')).toContainText('Select at least one field');

  await page.click('#requester');
  await page.click('#model');
  await expect(panel.getByTestId('rec-field')).toHaveCount(2);
  await expect(panel.locator('#notice')).toBeEmpty();

  await panel.getByTestId('rec-save').click();
  await expect(panel.getByTestId('edit-save')).toBeVisible();
  await expect(panel.locator('#notice')).toContainText('Now enter the values for the first variant');
  await panel.locator('[data-field="f1"]').fill('Emily Carter');
  await panel.locator('[data-field="f2"]').fill('CP-40/160');
  await panel.getByTestId('edit-save').click();
  await expect(panel.getByTestId('tpl-title')).toBeVisible();
  await expectCleanText(panel);
  const [tpl] = await storedTemplates(sw);
  expect(tpl.variants).toHaveLength(1);
  expect(tpl.variants[0].values).toEqual({ f1: 'Emily Carter', f2: 'CP-40/160' });
});

test('page and panel stay in sync while recording: each side shows the other, the last edit wins', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-add-all').click();
  await expect(panel.getByTestId('rec-field')).toHaveCount(18);
  const row = (label) => panel.getByTestId('rec-field').filter({ hasText: label });

  // Panel → page, for every kind of control.
  await row('Model').locator('input').fill('CP-40/160');
  await expect(page.locator('#model')).toHaveValue('CP-40/160');
  await row('Department').getByTestId('edit-value').click();
  await panel.locator('.dd-menu:popover-open .dd-opt', { hasText: 'Maintenance' }).click();
  await expect(page.locator('#department')).toHaveValue('mnt');
  await row('Pump type').locator('.sk-opt', { hasText: 'Type C' }).click();
  await expect(page.locator('input[name="pump_type"][value="C"]')).toBeChecked();
  await row('Include spare parts kit').locator('.sk-check').click();
  await expect(page.locator('#spares')).toBeChecked();

  // Page → panel, also after the panel edited that field: the later edit wins. The panel field that
  // has focus is not overwritten while the person types elsewhere.
  await row('Problem description').locator('textarea').click();
  await page.click('#model', { clickCount: 3 });
  await page.keyboard.type('CP-50');
  await expect(row('Model').locator('input')).toHaveValue('CP-50');
  await page.click('#requester');
  await page.keyboard.type('Emily');
  await expect(row('Full name').locator('input')).toHaveValue('Emily');
  await expect(row('Problem description').locator('textarea')).toBeFocused();

  // And the panel again, saved straight away (the pending write is flushed first).
  await row('Model').locator('input').fill('CP-60');
  await panel.getByTestId('rec-save').click();
  await expect(panel.getByTestId('tpl-title')).toBeVisible();
  expect(await page.inputValue('#model')).toBe('CP-60');
  const [tpl] = await storedTemplates(sw);
  const byLabel = Object.fromEntries(tpl.fields.map((f) => [f.label, tpl.variants[0].values[f.id]]));
  expect(byLabel).toMatchObject({ 'Full name': 'Emily', Model: 'CP-60', Department: 'mnt', 'Pump type': 'C', 'Include spare parts kit': true });
  expect(await submits(page)).toBe(0);
});

test('[T11] a value the page refuses stays in the panel with a note, until the page field is edited again', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-save').waitFor();
  await page.click('#spares');
  await page.click('#onsite');
  await page.click('#model');
  const row = (label) => panel.getByTestId('rec-field').filter({ hasText: label });
  await expect(panel.getByTestId('rec-field')).toHaveCount(3);
  // The page cancels programmatic clicks on the boxes (a person's clicks still work).
  await page.evaluate(() => { for (const id of ['spares', 'onsite']) document.getElementById(id).addEventListener('click', (e) => { if (!e.isTrusted) e.preventDefault(); }); });
  await row('Needs on-site visit').locator('.sk-check').click();
  await row('Include spare parts kit').locator('.sk-check').click();
  // One note per refused field.
  await expect(panel.getByTestId('rec-set-failed')).toHaveCount(2);
  await expect(panel.getByTestId('rec-set-failed').filter({ hasText: 'Include spare parts kit' })).toHaveCount(1);
  await expect(page.locator('#spares')).not.toBeChecked();
  await expect(row('Include spare parts kit').locator('.sk-check')).toHaveAttribute('aria-checked', 'true');

  // Ticking it on the page is the newer edit: the note goes away and both sides agree.
  await page.click('#spares');
  await expect(page.locator('#spares')).toBeChecked();
  await expect(panel.getByTestId('rec-set-failed')).toHaveCount(1);
  await expect(panel.getByTestId('rec-set-failed')).toContainText('Needs on-site visit');
  await page.click('#spares');
  await expect(row('Include spare parts kit').locator('.sk-check')).toHaveAttribute('aria-checked', 'false');
});

test('panel edits stay with their field when the page adds fields or replaces list options', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-save').waitFor();
  await page.click('#model');
  await page.click('#qty');
  await page.click('#department');
  const row = (label) => panel.getByTestId('rec-field').filter({ hasText: label });
  await row('Quantity').locator('input').fill('7');
  // The page inserts a field above the recorded ones and swaps the department options (same count).
  await page.evaluate(() => {
    const extra = document.createElement('input');
    extra.id = 'extra';
    extra.setAttribute('aria-label', 'Extra');
    document.querySelector('fieldset').prepend(extra);
    const sel = document.getElementById('department');
    [...sel.options].forEach((o, i) => { if (i) { o.value = `new${i}`; o.textContent = `New ${i}`; } });
  });
  await page.click('#costcenter'); // any selection makes the panel refresh
  await expect(panel.getByTestId('rec-field')).toHaveCount(4);
  await row('Department').getByTestId('edit-value').click();
  await expect(panel.locator('.dd-menu:popover-open .dd-opt').nth(1)).toHaveText('New 1');
  await panel.keyboard.press('Escape');
  await panel.getByTestId('rec-save').click();
  await panel.getByTestId('edit-save').or(panel.getByTestId('tpl-title')).first().waitFor();
  const [tpl] = await storedTemplates(sw);
  const byLabel = Object.fromEntries(tpl.fields.map((f) => [f.label, tpl.variants[0].values[f.id]]));
  expect(byLabel.Quantity).toBe('7');
  expect(byLabel.Model).toBeUndefined();
});

test("[T11] panel writes are bound to their recording, lose to a later page edit and never count as the person's edit", async ({ context, sw }) => {
  const page = await openForm(context, 'portal.html');
  const tabId = await tabIdOf(sw, page);
  // Stands in for the panel: answers the agent's heartbeat, so the recording keeps going.
  await sw.evaluate(() => chrome.runtime.onMessage.addListener((m, _s, reply) => { if (m && m.type === 'ff:rec' && m.event === 'ping') reply(true); }));
  const origin = new URL(page.url()).origin;
  const token = 'a'.repeat(32);
  const other = 'b'.repeat(32);
  expect((await agentCall(sw, tabId, 'recordStart', { origin, token })).ok).toBe(true);
  await page.click('#model');
  await page.click('#spares');
  const get = async () => (await agentCall(sw, tabId, 'recordGet', { origin, token })).fields;
  const [model, spares] = await get();
  expect([model.label, spares.label]).toEqual(['Model', 'Include spare parts kit']);

  // Calls naming another recording (a late call from an earlier one, another panel) change nothing.
  expect(await agentCall(sw, tabId, 'recordSet', { origin, token: other, sid: model.sid, value: 'X', at: Date.now() })).toMatchObject({ ok: false, error: 'other-recording' });
  expect(await agentCall(sw, tabId, 'recordGet', { origin, token: other })).toMatchObject({ ok: false, error: 'other-recording' });
  expect(await agentCall(sw, tabId, 'recordStop', { token: other })).toMatchObject({ stopped: false });
  expect(await page.inputValue('#model')).toBe('');

  // A panel edit older than the person's last edit on the page does not overwrite it.
  const before = Date.now();
  await page.click('#model');
  await page.keyboard.type('Typed on page');
  expect(await agentCall(sw, tabId, 'recordSet', { origin, token, sid: model.sid, value: 'Older panel value', at: before - 1 })).toMatchObject({ ok: false, error: 'superseded' });
  expect(await page.inputValue('#model')).toBe('Typed on page');
  expect(await agentCall(sw, tabId, 'recordSet', { origin, token, sid: model.sid, value: 'Newer panel value', at: Date.now() })).toMatchObject({ ok: true, value: 'Newer panel value' });

  // Ticking the box from the panel makes the browser fire trusted change events: still not the person's edit.
  expect(await agentCall(sw, tabId, 'recordSet', { origin, token, sid: spares.sid, value: true, at: Date.now() })).toMatchObject({ ok: true, value: true });
  expect((await get()).find((f) => f.sid === spares.sid).edited).toBe(0);

  // A field the page swaps for a same-looking new element (a re-rendered component) stays in the
  // recording; the replacement lost the value, so the write counts as refused.
  await page.evaluate(() => document.getElementById('model').addEventListener('input', (e) => { if (e.isTrusted) return; const n = e.target.cloneNode(); n.value = ''; e.target.replaceWith(n); }, { once: true }));
  expect(await agentCall(sw, tabId, 'recordSet', { origin, token, sid: model.sid, value: 'Z', at: Date.now() })).toMatchObject({ ok: false, error: 'failed' });
  expect((await get()).map((f) => f.sid)).toEqual([model.sid, spares.sid]);
  expect(await agentCall(sw, tabId, 'recordSet', { origin, token, sid: model.sid, value: 'Z2', at: Date.now() })).toMatchObject({ ok: true, value: 'Z2' });
  // One with another identity is not taken over.
  await page.evaluate(() => document.getElementById('model').addEventListener('input', (e) => { if (e.isTrusted) return; const n = e.target.cloneNode(); n.id = 'model2'; n.name = 'model2'; e.target.replaceWith(n); }, { once: true }));
  expect(await agentCall(sw, tabId, 'recordSet', { origin, token, sid: model.sid, value: 'Z3', at: Date.now() })).toMatchObject({ ok: false, error: 'replaced' });
  expect((await get()).map((f) => f.sid)).toEqual([spares.sid]);
  expect(await agentCall(sw, tabId, 'recordStop', { token })).toMatchObject({ ok: true });
  expect(await submits(page)).toBe(0);
});

test('typing on in the panel while an earlier write is still on its way keeps the field in sync', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-save').waitFor();
  await page.click('#model');
  const input = panel.getByTestId('rec-field').filter({ hasText: 'Model' }).locator('input');
  // The page takes 100 ms over the first value written from the panel.
  await page.evaluate(() => {
    let slow = true;
    document.getElementById('model').addEventListener('input', (e) => {
      if (e.isTrusted || !slow) return;
      slow = false;
      const end = performance.now() + 100;
      while (performance.now() < end);
    });
  });
  await input.pressSequentially('AB', { delay: 250 });
  await expect(page.locator('#model')).toHaveValue('AB');
  await panel.waitForTimeout(300);
  await input.press('End');
  await input.pressSequentially('C');
  await expect(page.locator('#model')).toHaveValue('ABC');
  // The page still reaches the panel once the panel field is left.
  await input.blur();
  await page.click('#model');
  await page.keyboard.press('End');
  await page.keyboard.type('D');
  await expect(input).toHaveValue('ABCD');
});

test('a time field stays a time field in the panel when the page changes its type', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-save').waitFor();
  await page.click('#due');
  const due = panel.getByTestId('rec-field').filter({ hasText: 'Required by' }).locator('input');
  await expect(due).toHaveAttribute('type', 'date');
  await page.evaluate(() => { document.getElementById('due').type = 'time'; });
  await page.click('#qty'); // any selection makes the panel refresh
  await expect(due).toHaveAttribute('type', 'time');
  await due.fill('14:30');
  await expect(page.locator('#due')).toHaveValue('14:30');
});

test('"Page → panel" setting: the panel follows the page, panel edits stay in the template only', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.locator('#settingsBtn').click();
  await panel.getByTestId('rec-sync').locator('[data-value="page"]').click();
  await expect(panel.locator('#notice')).toContainText('Settings saved');
  expect((await sw.evaluate(() => chrome.storage.local.get('settings'))).settings.recSync).toBe('page');
  await panel.getByTestId('back').click();
  await panel.getByTestId('new-template').click();
  await expect(panel.locator('.hint').first()).toContainText('edits in the panel stay in the template only');
  await page.click('#model');
  await page.click('#department');
  const row = (label) => panel.getByTestId('rec-field').filter({ hasText: label });

  // Page → panel.
  await page.click('#model');
  await page.keyboard.type('CP-40');
  await expect(row('Model').locator('input')).toHaveValue('CP-40');
  // A panel edit does not touch the page...
  await row('Model').locator('input').fill('CP-99');
  await row('Department').getByTestId('edit-value').click();
  await panel.locator('.dd-menu:popover-open .dd-opt', { hasText: 'Maintenance' }).click();
  await panel.waitForTimeout(400);
  expect(await page.inputValue('#model')).toBe('CP-40');
  expect(await page.inputValue('#department')).toBe('');
  // ...until the field is edited on the page again: then the page wins.
  await page.click('#model');
  await page.keyboard.press('End');
  await page.keyboard.type('/1');
  await expect(row('Model').locator('input')).toHaveValue('CP-40/1');

  await panel.getByTestId('rec-save').click();
  await expect(panel.getByTestId('tpl-title')).toBeVisible();
  const [tpl] = await storedTemplates(sw);
  const byLabel = Object.fromEntries(tpl.fields.map((f) => [f.label, tpl.variants[0].values[f.id]]));
  expect(byLabel).toEqual({ Model: 'CP-40/1', Department: 'mnt' });
  expect(await page.inputValue('#department')).toBe('');
});
