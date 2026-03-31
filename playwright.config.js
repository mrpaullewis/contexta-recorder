import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 60_000,
  retries: 0,
  workers: 1, // extensions need serial execution
  use: {
    headless: false, // extensions don't work headless
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10_000,
  },
  webServer: {
    command: 'node tests/test-server.js',
    port: 3847,
    reuseExistingServer: true,
  },
});
