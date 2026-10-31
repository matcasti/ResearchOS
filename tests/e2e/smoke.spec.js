const { test, expect } = require('@playwright/test');
const { openApp, gotoView } = require('./helpers');

const VIEWS = [
  'dashboard', 'kanban', 'projects', 'timeline', 'areas', 'nested',
  'ideas', 'snippets', 'starred', 'orphans', 'submissions',
  'meetings', 'references', 'collaborators', 'weekly', 'filesystem',
  'archived', 'tutorial', 'settings',
];

test('la app arranca y muestra el dashboard', async ({ page }) => {
  const { errors } = await openApp(page);
  await expect(page).toHaveTitle(/ResearchOS/);
  await expect(page.locator('.nav-item[data-view="dashboard"]')).toHaveClass(/active/);
  expect(errors).toEqual([]);
});

for (const view of VIEWS) {
  test(`vista "${view}" renderiza sin errores`, async ({ page }) => {
    const { errors } = await openApp(page);
    await gotoView(page, view);
    await page.waitForTimeout(400);
    const html = await page.locator('#mainContent').innerHTML();
    expect(html.length).toBeGreaterThan(200);
    expect(errors).toEqual([]);
  });
}
