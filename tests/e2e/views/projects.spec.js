const { test, expect, openApp, gotoView, seed } = require('../helpers');

const box = page => page.locator('#projectsContainer');
/** Los filtros están plegados por defecto (menos ruido): ábrelos antes de usarlos. */
const openFilters = async page => { if (!(await page.locator('#filtersFold').evaluate(d => d.open))) await page.locator('#filtersFold > summary').click(); };
const priorityOf = (page, title) => page.evaluate(t => db.projects.where('title').equals(t).first().then(p => p.priority), title);

test.describe('Vista Proyectos', () => {
  test('filtros por tipo, prioridad y responsable, vista guardada y «seleccionar todos» solo de lo visible; lista ordenable cuyo modo persiste', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    await expect(box(page)).toContainText('Paper Alfa');
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
    await page.locator('#clearFiltersBtn').click();

    await page.locator('[data-ftype="Paper"]').click();                                  // vistas guardadas de filtros
    await page.locator('#saveViewBtn').click();
    await page.locator('#confirmInput').fill('Solo papers');
    await page.locator('#confirmYes').click();
    await expect(page.locator('.toast.success').last()).toContainText('Solo papers');
    await page.locator('#bulkToggleBtn').click();                                        // «Seleccionar todos» con un filtro activo: 1 proyecto visible de 3
    await page.locator('#bkSelectAll').click();
    await expect(page.locator('#bulkCount')).toContainText('1 ');
    await page.locator('#clearFiltersBtn').click();

    await page.locator('#viewModeList').click();                                         // lista (tabla) con ordenación ascendente/descendente
    await page.locator('[data-sk="title"]').click();
    const order = async () => (await page.locator('#projectsContainer tbody tr').allInnerTexts()).map(t => t.split('\t')[0].trim());
    await expect.poll(async () => (await order()).slice(0, 3)).toEqual(['Dataset Beta', 'Grant Gamma', 'Paper Alfa']);
    await page.locator('[data-sk="title"]').click();
    await expect.poll(async () => (await order()).slice(0, 3)).toEqual(['Paper Alfa', 'Grant Gamma', 'Dataset Beta']);
    await page.reload();                                                                 // el modo de vista persiste
    expect(await page.evaluate(() => localStorage.getItem('ros-proj-view-mode'))).toBe('list');
    expect(errors).toEqual([]);
  });

  test('acciones masivas: sin selección avisa; favorito y archivar', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    await page.locator('#bulkToggleBtn').click();
    await page.locator('#bkArchive').click();
    await expect(page.locator('.toast.error')).toContainText('Selecciona al menos un proyecto');
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

  test('paginación: 25 por página y «Cargar más»', async ({ page }) => {
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
});

test.describe('Inspector de proyecto', () => {
  test('edición en línea de prioridad y columna, Project Hub con sus entidades vinculadas y subtareas de una idea', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Grant Gamma' }).click();
    await page.locator('[data-inplace="priority"]').click();
    await page.locator('select.inplace-input').selectOption('Alta');                    // elegir guarda: no hace falta Enter
    await expect.poll(() => priorityOf(page, 'Grant Gamma')).toBe('Alta');
    await page.locator('[data-inplace="columnId"]').click();
    const sel = page.locator('select.inplace-input');
    const target = await sel.locator('option').nth(5).getAttribute('value');
    await sel.selectOption(target);
    await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Grant Gamma').first().then(p => p.columnId))).toBe(+target);

    await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
    await page.locator('#inspHubBtn').click();                                          // Project Hub desde el inspector
    for (const t of ['Paper Alfa', 'Idea uno', 'Snippet ggplot', 'Reunión de avance']) await expect(page.locator('#mainContent')).toContainText(t);

    await gotoView(page, 'ideas');                                                       // subtareas de una idea: añadir, completar y borrar
    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-title').click();
    const id = await page.evaluate(() => db.ideas.where('title').equals('Idea uno').first().then(i => i.id));
    await page.fill(`#stInput-${id}`, 'Leer paper');
    await page.locator(`#stAddBtn-${id}`).click();
    await expect(page.locator('.subtask-item', { hasText: 'Leer paper' })).toBeVisible();
    await page.locator('[data-toggle-st]').first().click();
    await expect(page.locator('.subtask-text.done')).toHaveText('Leer paper');
    await page.locator('[data-del-st]').first().click();
    await expect(page.locator('.subtask-item')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('Áreas, anidados y submissions', () => {
  test('crear un área, un proyecto raíz anidado, la submission de un Paper (solo Papers) y ver los huérfanos', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'areas');                                                       // área nueva
    await page.locator('#mainContent button', { hasText: /Nueva área|\+ Área|\+ Nueva/ }).first().click();
    await page.locator('#modalContent input[type="text"], #modalContent input:not([type])').first().fill('Ecología');
    await page.locator('#modalContent .btn-primary').click();
    await expect(page.locator('#mainContent')).toContainText('Ecología');
    const areas = await page.evaluate(async () => JSON.parse((await db.settings.get('ros-areas')).value));
    expect(areas.map(a => a.name)).toContain('Ecología');

    await gotoView(page, 'nested');                                                      // proyecto raíz anidado
    await page.locator('#nestAddRoot').click();
    await page.locator('.template-card[data-tpl="blank"]').click();
    await page.fill('#mp-title', 'Raíz nueva');
    await page.locator('#mpSave').click();
    await expect(page.locator('#mainContent')).toContainText('Raíz nueva');

    const idOf = t => page.evaluate(t => db.projects.where('title').equals(t).first().then(p => p.id), t);
    await page.evaluate(i => showAddSubmissionModal(null, i), await idOf('Grant Gamma'));          // la submission solo aplica a proyectos tipo Paper
    await expect(page.locator('.toast.info')).toContainText('solo a proyectos tipo Paper');
    await page.evaluate(i => showAddSubmissionModal(null, i), await idOf('Paper Alfa'));           // y en un Paper su estado se edita y sale en el pipeline
    await page.selectOption('#asub-status', { index: 1 });
    await page.fill('#asub-venue', 'Nature');
    await page.locator('#asubSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Submission actualizada');
    await gotoView(page, 'submissions');
    await expect(page.locator('#mainContent')).toContainText('Paper Alfa');

    await gotoView(page, 'orphans');                                                     // la idea suelta aparece entre los huérfanos
    await expect(page.locator('#mainContent')).toContainText('Idea dos');
    expect(errors).toEqual([]);
  });
});
