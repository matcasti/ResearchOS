const { test, expect, openApp, gotoView, seed, reload } = require('../helpers');

const colOf = (page, title) => page.evaluate(t => db.projects.where('title').equals(t).first().then(p => p.columnId), title);
const flag = (page, title, key) => page.evaluate(([t, k]) => db.projects.where('title').equals(t).first().then(p => !!p[k]), [title, key]);

test.describe('Kanban', () => {
  test('crear proyectos: el título es obligatorio, el nuevo va a la primera columna y persiste; la plantilla prerrellena y el «+» de una columna la preselecciona', async ({ page }) => {
    const { errors } = await openApp(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="blank"]').click();
    await page.locator('#mpSave').click();                                              // sin título: avisa y no cierra
    await expect(page.locator('.toast.error')).toContainText('título es requerido');
    await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
    expect(await page.evaluate(() => db.projects.count())).toBe(0);
    await page.fill('#mp-title', 'Mi proyecto E2E');
    await page.locator('#mpSave').click();
    await expect(page.locator('.toast.success')).toContainText('Proyecto creado');
    const firstCol = page.locator('.kanban-col').first();
    await expect(firstCol.locator('.kanban-card')).toHaveCount(1);
    await expect(firstCol.locator('.kanban-card-title-text')).toHaveText('Mi proyecto E2E');
    await reload(page);                                                                  // IndexedDB
    await gotoView(page, 'kanban');
    await expect(page.locator('.kanban-card-title-text')).toHaveText('Mi proyecto E2E');

    const thirdCol = page.locator('.kanban-col').nth(2);
    const colId = await thirdCol.getAttribute('data-col-id');
    await thirdCol.locator('.kanban-add-btn').click();
    await page.locator('.template-card[data-tpl="paper"]').click();
    await expect(page.locator('#mp-col')).toHaveValue(colId);
    await expect(page.locator('#mp-type')).toHaveValue('Paper');
    await expect(page.locator('#mp-priority')).toHaveValue('Alta');
    await expect(page.locator('#mp-tags')).toHaveValue('writing, review');
    expect(errors).toEqual([]);
  });

  // 6 columnas desbordan a 1280px; el drag HTML5 necesita el destino visible.
  test.describe('con tarjetas', () => {
    test.use({ viewport: { width: 1800, height: 900 } });

    test('arrastrar (con deshacer), renombrar, filtrar, densidad y swimlanes, y el inspector: favorito, archivar y eliminar', async ({ page }) => {
      const { errors } = await openApp(page);
      await seed(page);
      await gotoView(page, 'kanban');
      const card = name => page.locator('.kanban-card', { hasText: name });

      const target = page.locator('.kanban-col').nth(3);                                  // arrastrar a otra columna: columnId e historial
      const targetColId = +(await target.getAttribute('data-col-id'));
      await card('Paper Alfa').dragTo(target.locator('.kanban-cards'));
      await expect(page.locator('.toast.success')).toContainText('Tarjeta movida');
      const moved = await page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first());
      expect(moved.columnId).toBe(targetColId);
      expect(moved.columnHistory?.at(-1)?.colId).toBe(targetColId);
      await expect(target.locator('.kanban-card')).toHaveCount(1);

      await card('Paper Alfa').dragTo(page.locator('.kanban-col').nth(4).locator('.kanban-cards'));      // y deshacer lo devuelve a donde estaba
      expect(await colOf(page, 'Paper Alfa')).not.toBe(targetColId);
      await page.locator('.toast-undo-btn').last().click();
      await expect(page.locator('.toast.success').last()).toContainText('Deshecho');
      expect(await colOf(page, 'Paper Alfa')).toBe(targetColId);

      await page.locator('[data-inline-rename]', { hasText: 'Grant Gamma' }).dblclick();     // doble clic renombra
      await page.locator('.kanban-inline-input').fill('Grant Renombrado');
      await page.locator('.kanban-inline-input').press('Enter');
      await expect(page.locator('.kanban-card-title-text', { hasText: 'Grant Renombrado' })).toBeVisible();

      await page.locator('[data-kfilt-resp="Dr. García"]').click();                          // el filtro por responsable oculta el resto
      await expect(page.locator('.kanban-card')).toHaveCount(1);
      await expect(page.locator('.kanban-card')).toContainText('Dataset Beta');
      await page.locator('[data-kfilt-resp="all"]').click();
      await expect(page.locator('.kanban-card')).toHaveCount(3);

      await page.locator('[data-density="compact"]').click();                                // modo compacto y swimlanes
      await expect(page.locator('.kanban-card.compact')).toHaveCount(3);
      await page.locator('[data-swim="type"]').click();
      await expect(page.locator('[data-swim-col]').first()).toBeVisible();
      await page.locator('[data-swim="area"]').click();
      await expect(page.locator('.kanban-view-header')).toBeVisible();
      await page.locator('[data-swim="none"]').click();
      await page.locator('[data-density="detailed"]').click();

      await card('Paper Alfa').click();                                                      // el inspector abre con sus datos
      await expect(page.locator('body')).not.toHaveClass(/inspector-closed/);
      await expect(page.locator('#inspectorBody')).toContainText('Dra. Vega');
      await page.locator('#inspStarBtn').click();
      await expect.poll(() => flag(page, 'Paper Alfa', 'starred')).toBe(true);
      await page.locator('#inspArchiveBtn').click();
      await expect.poll(() => flag(page, 'Paper Alfa', 'archived')).toBe(true);
      await expect(card('Paper Alfa')).toHaveCount(0);
      await gotoView(page, 'archived');
      await expect(page.locator('#mainContent')).toContainText('Paper Alfa');

      await gotoView(page, 'kanban');
      await card('Grant Renombrado').click();
      await page.locator('#inspDeleteBtn').click();
      await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Grant Renombrado').count())).toBe(0);
      expect(errors).toEqual([]);
    });
  });

  test('eliminar un proyecto padre no esconde a sus subproyectos', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const parent = await page.evaluate(async () => {
      const p = await db.projects.where('title').equals('Paper Alfa').first();
      const c = await db.projects.where('title').equals('Dataset Beta').first();
      await db.projects.update(c.id, { parentId: p.id });
      return p.id;
    });
    await page.evaluate(i => db.projects.delete(i), parent);
    await gotoView(page, 'projects');
    await expect(page.locator('#projectsContainer')).toContainText('Dataset Beta');
  });
});
