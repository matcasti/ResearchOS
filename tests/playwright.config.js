// @ts-check
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

// Esta configuración vive en tests/: las rutas se resuelven desde aquí y el servidor sirve la raíz del repositorio.
const ROOT = path.resolve(__dirname, '..');

module.exports = defineConfig({
  testDir: './e2e',
  outputDir: path.join(ROOT, 'test-results'),
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 2,   // cada worker es un Chromium: más de 2 satura la RAM de portátiles de 8 GB
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(ROOT, 'playwright-report') }]],
  use: {
    baseURL: 'http://localhost:4173',
    serviceWorkers: 'block',   // el SW de la app interferiría con el mock de la CDN; tiene su propio test
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Compatibilidad (opcional): CROSS_BROWSER=1 npm run test:e2e:compat  — Firefox y Safari (WebKit) con un subconjunto de pruebas
    ...(process.env.CROSS_BROWSER ? [
      { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
      { name: 'webkit',  use: { ...devices['Desktop Safari'] } },
    ] : []),
  ],
  webServer: {
    command: 'python3 -m http.server 4173',
    cwd: ROOT,
    url: 'http://localhost:4173/index.html',
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
