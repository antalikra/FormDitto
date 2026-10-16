// Playwright fixtures: Chromium with the unpacked extension loaded.
//
// Playwright cannot click Chrome's native permission dialog or the toolbar icon, so by default the
// suite loads a copy of extension/ whose manifest additionally has host_permissions for the two test
// hosts only (127.0.0.1 and localhost). The code is identical. Tests that need the real, unmodified
// manifest use `test.use({ production: true })`.
import { test as base, expect, chromium } from '@playwright/test';
import { EXT_DIR, extensionCopyWithHosts } from '../../scripts/lib/ext-copy.mjs';

export const PORT = 5179;
export const ORIGIN_A = `http://127.0.0.1:${PORT}`;
export const ORIGIN_B = `http://localhost:${PORT}`;
export const TEST_HOST_PERMISSIONS = ['http://127.0.0.1/*', 'http://localhost/*'];

function prepareExtension(production, workerIndex) {
  return production ? EXT_DIR : extensionCopyWithHosts(`ext-e2e-${workerIndex}`, TEST_HOST_PERMISSIONS);
}

export const test = base.extend({
  production: [false, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  context: async ({ production }, use, testInfo) => {
    const extPath = prepareExtension(production, `${testInfo.workerIndex}-${production ? 'p' : 't'}`);
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
    });
    await use(context);
    await context.close();
  },

  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});

export { expect };
