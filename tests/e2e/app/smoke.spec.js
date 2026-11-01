const { test, expect, openApp, gotoView } = require('../helpers');

const VIEWS = [
  'dashboard', 'kanban', 'projects', 'timeline', 'areas', 'nested',
  'ideas', 'snippets', 'starred', 'orphans', 'submissions',
  'meetings', 'references', 'collaborators', 'weekly', 'filesystem',
  'archived', 'tutorial', 'settings',
];

// Una sola carga de la app: arranca y recorre todas las vistas vacías; cada fallo dice en qué vista ocurrió.
test('la app arranca y todas las vistas se pintan sin errores', async ({ page }) => {
  const { errors } = await openApp(page);
  await expect(page).toHaveTitle(/ResearchOS/);
  await expect(page.locator('.nav-item[data-view="dashboard"]')).toHaveClass(/active/);
  expect(errors).toEqual([]);
  const bad = [];
  let seen = 0;
  for (const view of VIEWS) {
    await gotoView(page, view);
    await page.waitForTimeout(80);                                       // un fallo asíncrono del pintado llega unos ms después
    if ((await page.locator('#mainContent').innerHTML()).length < 200) bad.push(`${view}: vacía`);
    if (errors.length > seen) { bad.push(`${view}: ${errors.slice(seen).join(' | ')}`); seen = errors.length; }
  }
  expect(bad).toEqual([]);
});
