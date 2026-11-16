// @ts-check
const path = require('path');

/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: './tests',
  timeout: 180000,
  expect: { timeout: 15000 },
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15000,
    navigationTimeout: 120000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
};

module.exports = config;
