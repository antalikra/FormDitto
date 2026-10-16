import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  reporter: [['list']],
  webServer: {
    command: 'node test/server.mjs',
    url: 'http://127.0.0.1:5179/health',
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
