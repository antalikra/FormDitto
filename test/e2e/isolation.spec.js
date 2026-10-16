import { test, expect, ORIGIN_A } from './fixtures.js';
import { openForm, openPanel, recordTemplate, fillVariant, seedTemplates, tabIdOf } from './helpers.js';

const SECRET_TPL = 'Secret Template 7f3a';
const SECRET_VARIANT = 'Secret Variant 91bc';

function portalTemplate() {
  return {
    id: 'iso1',
    name: SECRET_TPL,
    origin: ORIGIN_A,
    fields: [{ id: 'f1', kind: 'text', label: 'Full name', locator: { sel: '#requester', path: [], tag: 'input', type: 'text', id: 'requester', name: 'requester', index: 0 } }],
    variants: [{ id: 'v1', name: SECRET_VARIANT, values: { f1: 'Emily' } }],
  };
}

test('[T8] a web page cannot reach the extension: no runtime API, no web-accessible resources', async ({ context, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const probe = await page.evaluate(async (id) => {
    const out = { runtime: typeof (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage) };
    const load = (url) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve('loaded');
      img.onerror = () => resolve('blocked');
      img.src = url;
    });
    out.icon = await load(`chrome-extension://${id}/icons/icon-16.png`);
    try {
      await fetch(`chrome-extension://${id}/manifest.json`);
      out.fetch = 'loaded';
    } catch {
      out.fetch = 'blocked';
    }
    out.agentGlobal = typeof window.__formditto;
    return out;
  }, extensionId);
  expect(probe).toEqual({ runtime: 'undefined', icon: 'blocked', fetch: 'blocked', agentGlobal: 'undefined' });
});

test('[T8] content scripts cannot read chrome.storage; preview and fill leave no template data in the page', async ({ context, sw, extensionId }) => {
  await seedTemplates(sw, [portalTemplate()]);
  const page = await openForm(context, 'portal.html');
  const tabId = await tabIdOf(sw, page);

  const fromContentScript = await sw.evaluate(async (id) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: async () => {
        try {
          if (!chrome.storage || !chrome.storage.local) return 'no-storage-api';
          const all = await chrome.storage.local.get(null);
          return `read:${Object.keys(all).length}`;
        } catch (e) {
          return `error:${e.message}`;
        }
      },
    });
    return r.result;
  }, tabId);
  expect(fromContentScript).not.toMatch(/^read:/);

  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('template-card').click();
  await fillVariant(panel, SECRET_VARIANT);
  expect(await page.inputValue('#requester')).toBe('Emily');
  // The page DOM (including the overlay host) never contains template or variant names.
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain(SECRET_TPL);
  expect(html).not.toContain(SECRET_VARIANT);
  // The agent is not visible to the page's own JavaScript.
  expect(await page.evaluate(() => typeof window.__formditto)).toBe('undefined');
});

test('[T9] forged recording messages (wrong token, other tab) are ignored by the panel', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  const other = await openForm(context, 'trap.html');
  const panel = await openPanel(context, extensionId, sw, page);
  await panel.getByTestId('new-template').click();
  await expect(panel.getByTestId('rec-save')).toBeVisible();

  const forge = (tabId, token) => sw.evaluate(async ({ id, tok }) => {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      func: (t) => chrome.runtime.sendMessage({ type: 'ff:rec', token: t, event: 'blocked', reason: 'password' }).catch(() => null),
      args: [tok],
    });
  }, { id: tabId, tok: token });

  // From the recorded tab's content-script world, but without the session token.
  await forge(await tabIdOf(sw, page), '0'.repeat(32));
  // From another tab.
  await forge(await tabIdOf(sw, other), '1'.repeat(32));
  await panel.waitForTimeout(400);
  await expect(panel.getByTestId('rec-blocked')).toHaveCount(0);

  // Sanity check: the genuine recorder message (real click on a password field) is accepted.
  await page.evaluate(() => {
    const p = document.createElement('input');
    p.type = 'password';
    p.id = 'pw';
    document.querySelector('form').prepend(p);
  });
  await page.click('#pw');
  await expect(panel.getByTestId('rec-blocked')).toContainText('password');
});

test('[T9] the service worker and panel register no external message listeners', async ({ sw, extensionId, context }) => {
  const sw2 = await sw.evaluate(() => ({
    external: chrome.runtime.onMessageExternal.hasListeners(),
    connectExternal: chrome.runtime.onConnectExternal.hasListeners(),
    message: chrome.runtime.onMessage.hasListeners(),
  }));
  expect(sw2).toEqual({ external: false, connectExternal: false, message: false });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForSelector('body[data-ready="1"]');
  const p = await panel.evaluate(() => ({ external: chrome.runtime.onMessageExternal.hasListeners(), connectExternal: chrome.runtime.onConnectExternal.hasListeners() }));
  expect(p).toEqual({ external: false, connectExternal: false });
});

test('[T8] recording overlay and banner stay out of the page script world and hold no field values', async ({ context, sw, extensionId }) => {
  const page = await openForm(context, 'portal.html');
  await page.fill('#requester', 'Value-Should-Not-Leak');
  const panel = await openPanel(context, extensionId, sw, page);
  await recordTemplate(panel, page, ['#requester'], { name: SECRET_TPL, variant: SECRET_VARIANT });
  const info = await page.evaluate(() => {
    const host = document.querySelector('formditto-overlay');
    return { host: !!host, shadow: host ? host.shadowRoot : 'none', html: document.documentElement.outerHTML.includes('Value-Should-Not-Leak') };
  });
  // Overlay host may still be on screen briefly; its shadow root is closed (null for the page).
  if (info.host) expect(info.shadow).toBeNull();
  expect(info.html).toBe(false);
});
