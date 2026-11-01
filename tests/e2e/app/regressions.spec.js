// Regresiones: cada test describe un bug que existió (detectado en la revisión inicial) y que ya está corregido.
// Si alguno vuelve a fallar, el bug ha reaparecido.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('../helpers');

const tables = ['projects', 'ideas', 'snippets', 'references', 'meetings', 'collaborators'];
const counts = page => page.evaluate(async t => Object.fromEntries(await Promise.all(
  t.map(async n => [n, await db[n].count()]))), tables);
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

test.describe('Formularios: el click pasa el MouseEvent como argumento', () => {

  test('"+ Reunión" en la vista Reuniones prellena la fecha de hoy', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'meetings');
    await page.locator('#addMeetingBtn').click();
    await expect(page.locator('#am-date')).toHaveValue(today());
  });

  test('"+ Reunión" en la Agenda prellena la fecha de hoy', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'weekly');
    await page.locator('#weeklyAddMeeting').click();
    await expect(page.locator('#am-date')).toHaveValue(today());
  });

  test('guardar una reunión desde la vista Reuniones solo con título funciona', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'meetings');
    await page.locator('#addMeetingBtn').click();
    await page.fill('#am-title', 'Reunión rápida');
    await page.locator('#amSave').click();
    await expect(page.locator('.meeting-card', { hasText: 'Reunión rápida' })).toBeVisible();
  });
});

test.describe('Badges y listas', () => {

  test('marcar una idea como revisada actualiza el badge del sidebar al instante', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    await expect(page.locator('#ideasBadge')).toHaveText('1');
    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-status-btn').click();
    await expect(page.locator('#ideasBadge')).toBeHidden();
  });
});

test.describe('Favoritos', () => {

  test('el badge de Favoritos cuenta lo mismo que lista la vista (proyectos, ideas y snippets)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      await db.ideas.toCollection().modify({ starred: true });
      await db.snippets.toCollection().modify({ starred: true });
      await updateBadges();
    });
    // 2 ideas + 1 snippet favoritos, ningún proyecto: la vista los lista, el badge los ignora.
    await gotoView(page, 'starred');
    const listed = await page.locator('#mainContent .idea-item, #mainContent .snippet-card').count();
    expect(listed).toBe(3);
    await expect(page.locator('#starredBadge')).toHaveText('3');
  });
});

test.describe('Referencias sin año', () => {

  test('una referencia sin año aparece en la lista de Referencias', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'references');
    await page.locator('#addRefBtn').click();
    await expect(page.locator('#ar-doi-search')).toBeFocused();
    await page.fill('#ar-title', 'Paper sin año');
    await page.locator('#arSave').click();
    await expect(page.locator('.toast.success')).toContainText('Referencia guardada');
    await expect(page.locator('.ref-card', { hasText: 'Paper sin año' })).toBeVisible();
  });

  test('una referencia sin año se incluye en la exportación .bib', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => db.references.add({ title: 'Sin año', authors: 'Diaz, A.', year: null, journal: '', doi: '' }));
    expect(await page.evaluate(() => exportBibtex())).toContain('Sin año');
  });
});

test.describe('BibTeX', () => {

  test('varios autores se separan con " and " (requisito de BibTeX)', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => db.references.add({ title: 'T', authors: 'García, J., Vega, M.', year: 2021, journal: 'J', doi: '' }));
    expect(await page.evaluate(() => exportBibtex())).toMatch(/author\s*=\s*\{García, J\. and Vega, M\.\}/);
  });

  test('claves de cita únicas si hay dos referencias del mismo autor y año', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
      await db.references.add({ title: 'Uno', authors: 'García, J.', year: 2021, journal: 'A', doi: '' });
      await db.references.add({ title: 'Dos', authors: 'García, J.', year: 2021, journal: 'B', doi: '' });
    });
    const keys = [...(await page.evaluate(() => exportBibtex())).matchAll(/@article\{([^,]+),/g)].map(m => m[1]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('las claves de cita son ASCII (sin tildes)', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => db.references.add({ title: 'T', authors: 'Muñoz, A.', year: 2020, journal: 'J', doi: '' }));
    expect(await page.evaluate(() => exportBibtex())).toMatch(/@article\{[A-Za-z0-9_:-]+,/);
  });

  test('los caracteres especiales de LaTeX en el título se escapan', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => db.references.add({ title: 'R&D at 50% growth_rate', authors: 'X, Y.', year: 2020, journal: 'J', doi: '' }));
    const bib = await page.evaluate(() => exportBibtex());
    expect(bib).toContain('R\\&D');
    expect(bib).toContain('50\\%');
  });
});

test.describe('Importar / Borrar datos', () => {

  test('merge no descarta registros nuevos cuando su id coincide con uno local', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const local = await page.evaluate(() => db.projects.orderBy('id').first());
    const remote = { ...local, uid: 'remoto-distinto-0001', title: 'Proyecto remoto con mismo id' };     // mismo id numérico, otra identidad
    const backup = { _version: 3, projects: [remote], ideas: [], snippets: [], resources: [], collaborators: [], kanbanColumns: [], snippetCollections: [], submissions: [], meetings: [], references: [], settings: [] };
    await gotoView(page, 'settings');
    await page.locator('#importJsonInput').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.locator('#importOptMerge').click();
    await page.locator('#importModeOk').click();
    await expect(page.locator('.toast.success').last()).toContainText('1 registro(s) nuevo(s)');
    const titles = await page.evaluate(() => db.projects.toArray().then(a => a.map(p => p.title)));
    expect(titles).toContain('Proyecto remoto con mismo id');
    expect(titles).toHaveLength(4);
  });

  test('reemplazar con un JSON que no es un backup de ResearchOS no borra los datos', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'settings');
    await page.locator('#importJsonInput').setInputFiles({ name: 'package.json', mimeType: 'application/json', buffer: Buffer.from('{"name":"otra-cosa","version":"1.0.0"}') });
    await expect(page.locator('.toast.error')).toContainText('no contiene datos de ResearchOS');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);   // ni siquiera se ofrece importar
    expect((await counts(page)).projects).toBe(3);
  });

  test('"Borrar TODOS los datos" también vacía reuniones y referencias', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'settings');
    await page.locator('#clearAllBtn').click();
    await page.locator('#confirmInput').fill('BORRAR');
    await page.locator('#confirmYes').click();
    await expect.poll(async () => (await counts(page)).projects).toBe(0);
    const c = await counts(page);
    expect(c.meetings).toBe(0);
    expect(c.references).toBe(0);
  });
});

test.describe('CSV', () => {

  test('exportar e importar un proyecto con descripción multilínea no crea filas fantasma', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const col = (await db.kanbanColumns.toArray())[0];
      await db.projects.add({ title: 'Con plantilla', type: 'Paper', columnId: col.id, priority: 'Alta', responsible: '', deadline: null,
        description: 'Objetivo.\n\n## Estructura\n- Introducción\n- Métodos', tags: [], status: 'active', archived: false, starred: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    await gotoView(page, 'settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#exportCsvBtn').click()]);
    const csv = await fs.promises.readFile(await dl.path(), 'utf8');
    await page.evaluate(() => db.projects.clear());
    await page.locator('#importCsvInput').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.locator('#confirmCsvImport').click();
    await expect(page.locator('.toast.success').last()).toContainText('importados');
    const ps = await page.evaluate(() => db.projects.toArray());
    expect(ps.map(p => p.title)).toEqual(['Con plantilla']);
    expect(ps[0].description).toContain('## Estructura');
  });
});

test.describe('Zona horaria (Chile, UTC-3 en octubre)', () => {
  test.use({ timezoneId: 'America/Santiago', locale: 'es-CL' });

  test('a las 23:30 locales, la fecha por defecto de una reunión es la de hoy y no la de mañana', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-31T23:30:00-03:00'));
    await openApp(page);
    await page.evaluate(() => showAddMeetingModal());
    await expect(page.locator('#am-date')).toHaveValue('2026-10-31');
  });
});

test.describe('Kanban', () => {

  test('soltar una tarjeta en su misma columna no añade entradas al historial', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    // Drop sintético: el arrastre real de Playwright sobre la misma columna no siempre dispara 'drop'.
    const len = () => page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => (p.columnHistory || []).length));
    const before = await len();
    await page.evaluate(async () => {
      const p = await db.projects.where('title').equals('Paper Alfa').first();
      App.draggedId = p.id;
      const list = document.querySelector(`.kanban-col[data-col-id="${p.columnId}"] .kanban-cards`);
      await kanbanDrop({ preventDefault() {}, currentTarget: list });
    });
    expect(await len()).toBe(before);
  });
});

test.describe('Búsqueda (paleta de comandos)', () => {

  test('un proyecto recién creado se encuentra de inmediato (el índice no queda obsoleto 1,5 s)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.reload();                       // el índice inicial ya contiene datos → desactiva el escaneo completo
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando');
    await page.waitForTimeout(300);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="blank"]').click();
    await page.fill('#mp-title', 'Quimera Zebra');
    await page.locator('#mpSave').click();
    await expect(page.locator('.toast.success')).toContainText('Proyecto creado');
    await page.keyboard.press('Control+k');
    await page.fill('#paletteInput', 'quimera');
    await expect(page.locator('.palette-item', { hasText: 'Quimera Zebra' }).first()).toBeVisible({ timeout: 800 });
  });

  test('la búsqueda ignora tildes ("analisis" encuentra "Análisis")', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const col = (await db.kanbanColumns.toArray())[0];
      await db.projects.add({ title: 'Análisis de series', type: 'Análisis', columnId: col.id, priority: 'Media', status: 'active',
        archived: false, starred: false, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    await page.reload();
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+k');
    await page.fill('#paletteInput', 'analisis');
    await expect(page.locator('.palette-item', { hasText: 'Análisis de series' }).first()).toBeVisible({ timeout: 1000 });
  });
});

test.describe('Integridad referencial', () => {

  test('al eliminar un proyecto, sus ideas vinculadas aparecen en Huérfanos', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
    await page.locator('#inspDeleteBtn').click();
    await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Paper Alfa').count())).toBe(0);
    await gotoView(page, 'orphans');
    await expect(page.locator('#mainContent')).toContainText('Idea uno');
    await expect(page.locator('#mainContent')).toContainText('Snippet ggplot');
  });

  test('al eliminar una columna con proyectos, éstos siguen visibles en el Kanban', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanManageCols').click();
    const row = page.locator('.col-manage-row').nth(1); // "Limpieza de Datos" contiene Dataset Beta
    await row.locator('.col-manage-del').click();
    await page.locator('#confirmYes').click();
    await page.locator('#colManageSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Columnas actualizadas');
    await expect(page.locator('.kanban-card', { hasText: 'Dataset Beta' })).toBeVisible();
  });

  test('dos columnas nuevas en la misma sesión conservan cada una su nombre', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanManageCols').click();
    await page.locator('#colAddNew').click();
    await page.locator('#colAddNew').click();
    const titles = page.locator('.col-manage-title');
    const n = await titles.count();
    await titles.nth(n - 2).fill('Alfa');
    await titles.nth(n - 1).fill('Beta');
    await page.locator('#colManageSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Columnas actualizadas');
    const names = await page.evaluate(() => db.kanbanColumns.orderBy('order').toArray().then(a => a.map(c => c.title)));
    expect(names.slice(-2)).toEqual(['Alfa', 'Beta']);
  });
});

test.describe('Móvil (≤ 600 px)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('el contenido principal tiene ancho útil (antes medía 0 px)', async ({ page }) => {
    await openApp(page);
    const box = await page.locator('#mainContent').boundingBox();
    expect(box.width).toBeGreaterThan(300);
  });

  test('un botón visible abre el menú, navegar lo cierra y el fondo también', async ({ page }) => {
    await openApp(page);
    await page.locator('#mobileMenuBtn').click();
    await expect(page.locator('body')).toHaveClass(/sidebar-mobile-open/);
    await expect(page.locator('#sidebar')).toBeInViewport();
    await page.locator('.nav-item[data-view="ideas"]').click();
    await expect(page.locator('body')).not.toHaveClass(/sidebar-mobile-open/);
    await expect(page.locator('.nav-item[data-view="ideas"]')).toHaveClass(/active/);
    await page.locator('#mobileMenuBtn').click();
    await page.locator('#sidebarBackdrop').click({ position: { x: 360, y: 400 } });
    await expect(page.locator('body')).not.toHaveClass(/sidebar-mobile-open/);
  });

  test('el estado "colapsado" de escritorio no estropea el drawer móvil', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => localStorage.setItem('ros-sidebar-collapsed', '1'));
    await page.reload();
    await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);
    await page.locator('#mobileMenuBtn').click();
    await expect(page.locator('.nav-item[data-view="kanban"] span').last()).toBeVisible();
  });
});
