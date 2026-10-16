import { test, expect, ORIGIN_A } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant, submits, storedTemplates, agentCall, tabIdOf, seedTemplates } from './helpers.js';

const EXPECTED_BLOCKS = {
  fullname: null,
  email: null,
  comment: null,
  terms: null, // custom checkbox: native input has opacity 0 over a visible styled box — allowed
  h_token: 'hidden-type',
  addr_display: 'not-rendered',
  addr_visibility: 'invisible',
  addr_opacity: 'transparent',
  addr_tiny: 'too-small',
  addr_offscreen: 'offscreen',
  addr_clipped: 'clipped',
  addr_cliprect: 'clipped',
  addr_aria: 'aria-hidden',
  addr_inert: 'inert',
  addr_details: 'not-rendered',
  addr_scale: 'too-small',
  addr_fixed: 'offscreen',
  addr_faded: 'transparent',
  pass: 'password',
  cardnum: 'payment',
  cvc: 'payment',
  otp: 'otp',
};

test('[T3][T4] every hidden trap field and every password/card/OTP field is classified as blocked', async ({ context, sw }) => {
  const page = await openForm(context, 'trap.html');
  const scan = await agentCall(sw, await tabIdOf(sw, page), 'scan', { origin: ORIGIN_A });
  const got = Object.fromEntries(scan.fields.map((f) => [f.name, f.blocked]));
  expect(got).toEqual(EXPECTED_BLOCKS);
});

test('[T3][T4] "Add all visible fields" records only visible, non-sensitive fields', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'trap.html');
  await page.fill('#fullname', 'Olga');
  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, [], { addAll: true, name: 'Trap', variant: 'One' });
  const [tpl] = await storedTemplates(sw);
  expect(tpl.fields.map((f) => f.locator.name)).toEqual(['fullname', 'email', 'comment', 'terms']);
});

test('[T11][T3][T4] page-made synthetic clicks are ignored; real clicks on hidden or sensitive fields are refused', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'trap.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await expect(panel.getByTestId('rec-save')).toBeVisible();

  // The page tries to make the recorder pick fields (including a hidden one) with synthetic clicks.
  await page.evaluate(() => {
    for (const id of ['addr_opacity', 'addr_display', 'email', 'fullname']) {
      const el = document.getElementById(id);
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    }
  });
  await page.waitForTimeout(300);
  await expect(panel.getByTestId('rec-field')).toHaveCount(0);

  // A real click on a transparent trap field and on the password field: refused with a reason.
  await page.click('#addr_opacity', { force: true });
  await expect(panel.getByTestId('rec-blocked')).toContainText('transparent');
  await page.click('#pass');
  await expect(panel.getByTestId('rec-blocked')).toContainText('password');
  await page.click('#cardnum');
  await expect(panel.getByTestId('rec-blocked')).toContainText('payment card');
  await expect(panel.getByTestId('rec-field')).toHaveCount(0);

  // A real click on a visible field works.
  await page.click('#email');
  await expect(panel.getByTestId('rec-field')).toHaveCount(1);
  // Clicking the submit button while recording does not submit.
  await page.click('button[type="submit"]');
  await expect(panel.getByTestId('rec-blocked')).toContainText('not submitted');
  // The agent's once-a-second refresh (the field count changed) does not wipe the note.
  await page.waitForTimeout(1300);
  await expect(panel.getByTestId('rec-blocked')).toContainText('not submitted');
  expect(await submits(page)).toBe(0);
});

test('[T3][T4] a template that points at trap or sensitive fields (e.g. from an import) never fills them', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'trap.html');
  const loc = (sel, index, extra = {}) => ({ sel, path: [], tag: 'input', type: 'text', index, ...extra });
  const traps = ['addr_display', 'addr_visibility', 'addr_opacity', 'addr_tiny', 'addr_offscreen', 'addr_clipped', 'addr_cliprect', 'addr_aria', 'addr_inert', 'addr_details', 'addr_scale', 'addr_fixed', 'addr_faded'];
  const fields = [{ id: 'f0', kind: 'text', label: 'Full name', locator: loc('#fullname', 0, { id: 'fullname', name: 'fullname' }) }];
  traps.forEach((n, i) => fields.push({ id: `t${i}`, kind: 'text', label: 'Address', locator: loc(`#${n}`, i + 1) }));
  // Innocent-looking locators that resolve to sensitive or hidden inputs on the page.
  fields.push({ id: 's1', kind: 'text', label: 'Field', locator: loc('#pass', 40) });
  fields.push({ id: 's2', kind: 'text', label: 'Field', locator: loc('#cardnum', 41) });
  fields.push({ id: 's3', kind: 'text', label: 'Field', locator: loc('input[name="h_token"]', 42) });
  fields.push({ id: 's4', kind: 'text', label: 'Field', locator: loc('#cvc', 43) });
  const values = Object.fromEntries(fields.map((f) => [f.id, `LEAK-${f.id}`]));
  await seedTemplates(sw, [{ id: 'traptpl', name: 'Imported trap', origin: ORIGIN_A, fields, variants: [{ id: 'v1', name: 'Leaky', values }] }], { waitTimeoutMs: 500 });

  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('template-card').click();
  await fillVariant(panel, 'Leaky');
  await expect(panel.getByTestId('stat-filled')).toHaveText('1');
  await expect(panel.getByTestId('stat-problems')).toHaveText(String(fields.length - 1));

  const leaked = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).filter((el) => el.value.startsWith('LEAK-')).map((el) => el.id || el.name));
  expect(leaked).toEqual(['fullname']);
  expect(await page.inputValue('input[name="h_token"]')).toBe('xyz');
  expect(await submits(page)).toBe(0);
});
