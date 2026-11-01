// Regresiones: cada paso describe un bug que existió (detectado en la revisión inicial) y que ya está corregido.
// Si alguno vuelve a fallar, el bug ha reaparecido. (Los de importación/borrado, CSV, zona horaria y búsqueda viven junto a sus pruebas temáticas.)
const { test, expect, openApp, gotoView, seed } = require('../helpers');

const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

test('«+ Reunión» prellena la fecha de hoy en Reuniones y en la Agenda, y guardar solo con título funciona', async ({ page }) => {
  await openApp(page);                                                          // el click pasaba el MouseEvent como argumento del formulario
  await gotoView(page, 'meetings');
  await page.locator('#addMeetingBtn').click();
  await expect(page.locator('#am-date')).toHaveValue(today());
  await page.fill('#am-title', 'Reunión rápida');
  await page.locator('#amSave').click();
  await expect(page.locator('.meeting-card', { hasText: 'Reunión rápida' })).toBeVisible();
  await gotoView(page, 'weekly');
  await page.locator('#weeklyAddMeeting').click();
  await expect(page.locator('#am-date')).toHaveValue(today());
});

test('los badges del menú cuentan lo mismo que lista la vista (ideas revisadas y favoritos)', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await gotoView(page, 'ideas');
  await expect(page.locator('#ideasBadge')).toHaveText('1');
  await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-status-btn').click();
  await expect(page.locator('#ideasBadge')).toBeHidden();                       // al instante, sin recargar
  await page.evaluate(async () => {
    await db.ideas.toCollection().modify({ starred: true });
    await db.snippets.toCollection().modify({ starred: true });
    await updateBadges();
  });
  await gotoView(page, 'starred');                                              // 2 ideas + 1 snippet favoritos, ningún proyecto
  expect(await page.locator('#mainContent .idea-item, #mainContent .snippet-card').count()).toBe(3);
  await expect(page.locator('#starredBadge')).toHaveText('3');
});

test('referencias y BibTeX: una sin año aparece en la lista y en el .bib; autores con « and », claves únicas y ASCII, y LaTeX escapado', async ({ page }) => {
  await openApp(page);
  await gotoView(page, 'references');
  await page.locator('#addRefBtn').click();
  await expect(page.locator('#ar-doi-search')).toBeFocused();
  await page.fill('#ar-title', 'Paper sin año');
  await page.locator('#arSave').click();
  await expect(page.locator('.toast.success')).toContainText('Referencia guardada');
  await expect(page.locator('.ref-card', { hasText: 'Paper sin año' })).toBeVisible();
  await page.evaluate(() => db.references.bulkAdd([
    { title: 'T', authors: 'García, J., Vega, M.', year: 2021, journal: 'J', doi: '' },
    { title: 'Uno', authors: 'García, J.', year: 2021, journal: 'A', doi: '' },      // mismo autor y año que la anterior
    { title: 'Dos', authors: 'García, J.', year: 2021, journal: 'B', doi: '' },
    { title: 'Con tilde', authors: 'Muñoz, A.', year: 2020, journal: 'J', doi: '' },
    { title: 'R&D at 50% growth_rate', authors: 'X, Y.', year: 2020, journal: 'J', doi: '' },
  ]));
  const bib = await page.evaluate(() => exportBibtex());
  expect(bib).toContain('Paper sin año');
  expect(bib).toMatch(/author\s*=\s*\{García, J\. and Vega, M\.\}/);
  const keys = [...bib.matchAll(/@article\{([^,]+),/g)].map(m => m[1]);
  expect(keys.length).toBe(6);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.every(k => /^[A-Za-z0-9_:-]+$/.test(k))).toBe(true);
  expect(bib).toContain('R\\&D');
  expect(bib).toContain('50\\%');
});

test('integridad: soltar en la misma columna no ensucia el historial; al borrar un proyecto sus ideas van a Huérfanos; borrar una columna no esconde proyectos; dos columnas nuevas conservan su nombre', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await gotoView(page, 'kanban');
  const len = () => page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => (p.columnHistory || []).length));
  const before = await len();
  await page.evaluate(async () => {                                              // drop sintético: el arrastre real sobre la misma columna no siempre dispara 'drop'
    const p = await db.projects.where('title').equals('Paper Alfa').first();
    App.draggedId = p.id;
    await kanbanDrop({ preventDefault() {}, currentTarget: document.querySelector(`.kanban-col[data-col-id="${p.columnId}"] .kanban-cards`) });
  });
  expect(await len()).toBe(before);

  await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
  await page.locator('#inspDeleteBtn').click();
  await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Paper Alfa').count())).toBe(0);
  await gotoView(page, 'orphans');
  await expect(page.locator('#mainContent')).toContainText('Idea uno');
  await expect(page.locator('#mainContent')).toContainText('Snippet ggplot');

  await gotoView(page, 'kanban');
  await page.locator('#kanbanManageCols').click();
  await page.locator('.col-manage-row').nth(1).locator('.col-manage-del').click();    // "Limpieza de Datos" contiene Dataset Beta
  await page.locator('#confirmYes').click();
  await page.locator('#colManageSave').click();
  await expect(page.locator('.toast.success').last()).toContainText('Columnas actualizadas');
  await expect(page.locator('.kanban-card', { hasText: 'Dataset Beta' })).toBeVisible();

  await page.locator('#kanbanManageCols').click();
  await page.locator('#colAddNew').click();
  await page.locator('#colAddNew').click();
  const titles = page.locator('.col-manage-title');
  const n = await titles.count();
  await titles.nth(n - 2).fill('Alfa');
  await titles.nth(n - 1).fill('Beta');
  await page.locator('#colManageSave').click();
  await expect.poll(() => page.evaluate(() => db.kanbanColumns.orderBy('order').toArray().then(a => a.map(c => c.title).slice(-2)))).toEqual(['Alfa', 'Beta']);
});

test.describe('Móvil (≤ 600 px)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('el contenido tiene ancho útil; un botón abre el menú, navegar y el fondo lo cierran; el estado «colapsado» de escritorio no lo estropea', async ({ page }) => {
    await openApp(page);
    expect((await page.locator('#mainContent').boundingBox()).width).toBeGreaterThan(300);      // antes medía 0 px
    await page.locator('#mobileMenuBtn').click();
    await expect(page.locator('body')).toHaveClass(/sidebar-mobile-open/);
    await expect(page.locator('#sidebar')).toBeInViewport();
    await page.locator('.nav-item[data-view="ideas"]').click();
    await expect(page.locator('body')).not.toHaveClass(/sidebar-mobile-open/);
    await expect(page.locator('.nav-item[data-view="ideas"]')).toHaveClass(/active/);
    await page.locator('#mobileMenuBtn').click();
    await page.locator('#sidebarBackdrop').click({ position: { x: 360, y: 400 } });
    await expect(page.locator('body')).not.toHaveClass(/sidebar-mobile-open/);
    await page.evaluate(() => localStorage.setItem('ros-sidebar-collapsed', '1'));
    await page.reload();
    await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);
    await page.locator('#mobileMenuBtn').click();
    await expect(page.locator('.nav-item[data-view="kanban"] span').last()).toBeVisible();
  });
});
