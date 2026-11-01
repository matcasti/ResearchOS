// Dependencias externas y arranque en frío.
const { test, expect, openApp, gotoView, openSettingsTab } = require('../helpers');

test.describe('Dependencias externas', () => {
  test('sin Google Identity Services ni Google Fonts la app funciona igual', async ({ page }) => {
    const { errors } = await openApp(page); // en modo cache los hosts de Google se anulan
    await gotoView(page, 'settings');
    await openSettingsTab(page, 'help');
    await page.locator('#settingsAdvanced > summary').click();          // lo avanzado está plegado
    await expect(page.locator('#googleSyncSection')).toBeVisible();
    await expect(page.locator('#saveIndicatorText')).toHaveText('Solo local');
    expect(errors).toEqual([]);
  });

  test('con la CDN inaccesible la app explica el problema en vez de quedarse en "Iniciando…" y db.js falla de forma controlada', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/cdnjs\.cloudflare\.com/, r => r.abort());
    await page.goto('/index.html');
    await expect(page.locator('.boot-error')).toContainText('no pudo iniciar');
    await expect(page.locator('.boot-error')).toContainText('Dexie');
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
    expect(errors.join('\n')).toMatch(/Dexie is not defined/);   // db.js falla, pero la app lo gestiona
  });
});

test.describe('Arranque en frío', () => {
  test('el HTML se abre por file:// (uso sin servidor, como promete el README)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('file://' + require('path').resolve(__dirname, '../../../index.html'));
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS', { timeout: 15000 });
    expect(errors).toEqual([]);
  });

  test('los datos de ejemplo se cargan también por file:// (se generan en el navegador, sin fetch)', async ({ page }) => {
    await page.goto('file://' + require('path').resolve(__dirname, '../../../index.html'));
    await expect(page.locator('#welcomeLoadDemo')).toBeVisible({ timeout: 15000 });
    await page.locator('#welcomeLoadDemo').click();
    await expect(page.locator('.toast.success')).toContainText('Datos de ejemplo cargados', { timeout: 15000 });
    expect(await page.evaluate(() => db.projects.count())).toBe(14);
  });

  test('tiempo hasta primera vista con 500 proyectos < 3 s', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const col = (await db.kanbanColumns.toArray())[0];
      const now = new Date().toISOString();
      await db.projects.bulkAdd(Array.from({ length: 500 }, (_, i) => ({ title: `Proyecto ${i}`, type: 'Paper', columnId: col.id, priority: 'Media',
        status: 'active', archived: false, starred: false, tags: ['t' + (i % 7)], coauthors: [], createdAt: now, updatedAt: now })));
    });
    const t0 = Date.now();
    await gotoView(page, 'kanban');
    await expect(page.locator('.kanban-card').first()).toBeVisible();
    await gotoView(page, 'projects');
    await expect(page.locator('#projectsContainer')).toContainText('Proyecto');
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
