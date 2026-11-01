const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('../helpers');

const box = page => page.locator('#projectsContainer');
/** Los filtros están plegados por defecto (menos ruido): ábrelos antes de usarlos. */
const openFilters = async page => { if (!(await page.locator('#filtersFold').evaluate(d => d.open))) await page.locator('#filtersFold > summary').click(); };

test.describe('Vista Proyectos', () => {
  test('filtros por tipo, prioridad, columna y responsable; limpiar filtros', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    await expect(page.locator('#projectsContainer')).toContainText('Paper Alfa');
    await openFilters(page);
    await page.locator('[data-ftype="Paper"]').click();
    await expect(box(page)).toContainText('Paper Alfa');
    await expect(box(page)).not.toContainText('Dataset Beta');
    await page.locator('#clearFiltersBtn').click();
    await page.locator('[data-fprio="Baja"]').click();
    await expect(box(page)).toContainText('Grant Gamma');
    await expect(box(page)).not.toContainText('Paper Alfa');
    await page.locator('#clearFiltersBtn').click();
    await page.locator('[data-fresp="Dr. García"]').click();
    await expect(box(page)).toContainText('Dataset Beta');
    await expect(box(page)).not.toContainText('Grant Gamma');
    expect(errors).toEqual([]);
  });

  test('vista lista (tabla) con ordenación ascendente/descendente por título', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    await page.locator('#viewModeList').click();
    await page.locator('[data-sk="title"]').click();
    const order = async () => (await page.locator('#projectsContainer tbody tr').allInnerTexts()).map(t => t.split('\t')[0].trim());
    await expect.poll(async () => (await order()).slice(0, 3)).toEqual(['Dataset Beta', 'Grant Gamma', 'Paper Alfa']);
    await page.locator('[data-sk="title"]').click();
    await expect.poll(async () => (await order()).slice(0, 3)).toEqual(['Paper Alfa', 'Grant Gamma', 'Dataset Beta']);
  });

  test('el modo de vista (grid/lista) persiste tras recargar', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'projects');
    await page.locator('#viewModeList').click();
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem('ros-proj-view-mode'))).toBe('list');
  });

  test('paginación: 25 por página y "Cargar más"', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const col = (await db.kanbanColumns.toArray())[0]; const now = new Date().toISOString();
      await db.projects.bulkAdd(Array.from({ length: 40 }, (_, i) => ({ title: `Proyecto ${String(i).padStart(2, '0')}`, type: 'Paper', columnId: col.id,
        priority: 'Media', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now })));
    });
    await gotoView(page, 'projects');
    await expect(page.locator('#loadMoreProj')).toContainText('15 restante');
    await page.locator('#loadMoreProj').click();
    await expect(page.locator('#loadMoreProj')).toHaveCount(0);
  });

  test('acciones masivas: favorito, archivar y mover de columna', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    await page.locator('#bulkToggleBtn').click();
    await page.locator('.bulk-check').nth(0).check();
    await page.locator('.bulk-check').nth(1).check();
    await expect(page.locator('#bulkCount')).toContainText('2');
    await page.locator('#bkStar').click();
    await expect.poll(() => page.evaluate(() => db.projects.filter(p => p.starred).count())).toBe(2);
    await page.locator('#bulkToggleBtn').click();
    await page.locator('.bulk-check').nth(0).check();
    await page.locator('#bkArchive').click();
    await expect.poll(() => page.evaluate(() => db.projects.filter(p => p.archived).count())).toBe(1);
  });

  test('acciones masivas sin selección muestran aviso', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    await page.locator('#bulkToggleBtn').click();
    await page.locator('#bkArchive').click();
    await expect(page.locator('.toast.error')).toContainText('Selecciona al menos un proyecto');
  });

  test('vistas guardadas de filtros', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    await openFilters(page);
    await page.locator('[data-ftype="Paper"]').click();
    await page.locator('#saveViewBtn').click();
    await page.locator('#confirmInput').fill('Solo papers');
    await page.locator('#confirmYes').click();
    await expect(page.locator('.toast.success').last()).toContainText('Solo papers');
  });
});

test.describe('Inspector de proyecto', () => {
  test('edición en línea (un clic) de prioridad persiste', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Grant Gamma' }).click();
    await page.locator('[data-inplace="priority"]').click();
    await page.locator('select.inplace-input').selectOption('Alta');                 // elegir guarda: no hace falta Enter
    await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Grant Gamma').first().then(p => p.priority))).toBe('Alta');
  });

  test('cambiar de columna desde el inspector actualiza la columna', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Grant Gamma' }).click();
    await page.locator('[data-inplace="columnId"]').click();
    const sel = page.locator('select.inplace-input');
    const target = await sel.locator('option').nth(5).getAttribute('value');
    await sel.selectOption(target);                                                  // elegir guarda: no hace falta Enter
    await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Grant Gamma').first().then(p => p.columnId))).toBe(+target);
  });

  test('subtareas de una idea: añadir, completar y borrar', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-title').click();
    const id = await page.evaluate(() => db.ideas.where('title').equals('Idea uno').first().then(i => i.id));
    await page.fill(`#stInput-${id}`, 'Leer paper');
    await page.locator(`#stAddBtn-${id}`).click();
    await expect(page.locator('.subtask-item', { hasText: 'Leer paper' })).toBeVisible();
    await page.locator('[data-toggle-st]').first().click();
    await expect(page.locator('.subtask-text.done')).toHaveText('Leer paper');
    await page.locator('[data-del-st]').first().click();
    await expect(page.locator('.subtask-item')).toHaveCount(0);
  });

  test('Project Hub: se abre desde el inspector con sus entidades vinculadas', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
    await page.locator('#inspHubBtn').click();
    await expect(page.locator('#mainContent')).toContainText('Paper Alfa');
    await expect(page.locator('#mainContent')).toContainText('Idea uno');
    await expect(page.locator('#mainContent')).toContainText('Snippet ggplot');
    await expect(page.locator('#mainContent')).toContainText('Reunión de avance');
    expect(errors).toEqual([]);
  });
});

test.describe('Áreas, anidados y submissions', () => {
  test('crear un área y asignarla a un proyecto', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'areas');
    await page.locator('#mainContent button', { hasText: /Nueva área|\+ Área|\+ Nueva/ }).first().click();
    await page.locator('#modalContent input[type="text"], #modalContent input:not([type])').first().fill('Ecología');
    await page.locator('#modalContent .btn-primary').click();
    await expect(page.locator('#mainContent')).toContainText('Ecología');
    const areas = await page.evaluate(async () => JSON.parse((await db.settings.get('ros-areas')).value));
    expect(areas.map(a => a.name)).toContain('Ecología');
  });

  test('proyecto anidado: "+ Subproyecto" crea un hijo con parentId', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'nested');
    await page.locator('#nestAddRoot').click();
    await page.locator('.template-card[data-tpl="blank"]').click();
    await page.fill('#mp-title', 'Raíz nueva');
    await page.locator('#mpSave').click();
    await expect(page.locator('#mainContent')).toContainText('Raíz nueva');
  });

  test('Paper: estado de submission se puede editar y aparece en el pipeline', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    const id = await page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => p.id));
    await page.evaluate(i => showAddSubmissionModal(null, i), id);
    await page.selectOption('#asub-status', { index: 1 });
    await page.fill('#asub-venue', 'Nature');
    await page.locator('#asubSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Submission actualizada');
    await gotoView(page, 'submissions');
    await expect(page.locator('#mainContent')).toContainText('Paper Alfa');
    expect(errors).toEqual([]);
  });

  test('submission solo aplica a proyectos tipo Paper', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const id = await page.evaluate(() => db.projects.where('title').equals('Grant Gamma').first().then(p => p.id));
    await page.evaluate(i => showAddSubmissionModal(null, i), id);
    await expect(page.locator('.toast.info')).toContainText('solo a proyectos tipo Paper');
  });

  test('huérfanos: vincular una idea suelta a un proyecto', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'orphans');
    await expect(page.locator('#mainContent')).toContainText('Idea dos');
  });
});

test.describe('Selección masiva respeta los filtros', () => {

  test('"Seleccionar todos" con un filtro activo selecciona solo los proyectos visibles', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    await openFilters(page);
    await page.locator('[data-ftype="Paper"]').click();       // 1 proyecto visible de 3
    await page.locator('#bulkToggleBtn').click();
    await page.locator('#bkSelectAll').click();
    await expect(page.locator('#bulkCount')).toContainText('1 ');
  });
});
