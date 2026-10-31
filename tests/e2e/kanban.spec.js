const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed, reload } = require('./helpers');

async function createProjectViaUI(page, title, { template = 'blank', extra } = {}) {
  await page.locator('#kanbanAddProject').click();
  await page.locator(`.template-card[data-tpl="${template}"]`).click();
  await expect(page.locator('#mp-title')).toBeVisible();
  await page.fill('#mp-title', title);
  if (extra) await extra();
  await page.locator('#mpSave').click();
}

test.describe('Kanban — crear proyectos', () => {
  test('crear proyecto en blanco aparece en la primera columna', async ({ page }) => {
    const { errors } = await openApp(page);
    await gotoView(page, 'kanban');
    await createProjectViaUI(page, 'Mi proyecto E2E');
    await expect(page.locator('.toast.success')).toContainText('Proyecto creado');
    const firstCol = page.locator('.kanban-col').first();
    await expect(firstCol.locator('.kanban-card')).toHaveCount(1);
    await expect(firstCol.locator('.kanban-card-title-text')).toHaveText('Mi proyecto E2E');
    expect(errors).toEqual([]);
  });

  test('título vacío muestra error y no cierra el modal', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    await createProjectViaUI(page, '');
    await expect(page.locator('.toast.error')).toContainText('título es requerido');
    await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
    expect(await page.evaluate(() => db.projects.count())).toBe(0);
  });

  test('botón "+ Añadir tarjeta" de una columna preselecciona esa columna', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    const thirdCol = page.locator('.kanban-col').nth(2);
    const colId = await thirdCol.getAttribute('data-col-id');
    await thirdCol.locator('.kanban-add-btn').click();
    await page.locator('.template-card[data-tpl="blank"]').click();
    await expect(page.locator('#mp-col')).toHaveValue(colId);
  });

  test('plantilla Paper pre-rellena tipo, prioridad y etiquetas', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="paper"]').click();
    await expect(page.locator('#mp-type')).toHaveValue('Paper');
    await expect(page.locator('#mp-priority')).toHaveValue('Alta');
    await expect(page.locator('#mp-tags')).toHaveValue('writing, review');
  });

  test('el proyecto persiste tras recargar (IndexedDB)', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    await createProjectViaUI(page, 'Persistente');
    await expect(page.locator('.kanban-card')).toHaveCount(1);
    await reload(page);
    await gotoView(page, 'kanban');
    await expect(page.locator('.kanban-card-title-text')).toHaveText('Persistente');
  });
});

test.describe('Kanban — interacción', () => {
  // 6 columnas desbordan a 1280px; el drag HTML5 necesita el destino visible.
  test.use({ viewport: { width: 1800, height: 900 } });

  test('arrastrar tarjeta a otra columna actualiza columnId e historial', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    const card = page.locator('.kanban-card', { hasText: 'Paper Alfa' });
    const target = page.locator('.kanban-col').nth(3).locator('.kanban-cards');
    const targetColId = +(await page.locator('.kanban-col').nth(3).getAttribute('data-col-id'));
    await card.dragTo(target);
    await expect(page.locator('.toast.success')).toContainText('Tarjeta movida');
    const p = await page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first());
    expect(p.columnId).toBe(targetColId);
    expect(p.columnHistory?.at(-1)?.colId).toBe(targetColId);
    await expect(page.locator('.kanban-col').nth(3).locator('.kanban-card')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('deshacer el movimiento restaura la columna original', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    const origColId = (await page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first())).columnId;
    await page.locator('.kanban-card', { hasText: 'Paper Alfa' })
      .dragTo(page.locator('.kanban-col').nth(4).locator('.kanban-cards'));
    await page.locator('.toast-undo-btn').click();
    await expect(page.locator('.toast.success').last()).toContainText('Deshecho');
    const p = await page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first());
    expect(p.columnId).toBe(origColId);
  });

  test('doble clic renombra la tarjeta', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('[data-inline-rename]', { hasText: 'Grant Gamma' }).dblclick();
    const input = page.locator('.kanban-inline-input');
    await input.fill('Grant Renombrado');
    await input.press('Enter');
    await expect(page.locator('.kanban-card-title-text', { hasText: 'Grant Renombrado' })).toBeVisible();
  });

  test('clic en tarjeta abre el inspector con sus datos', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
    await expect(page.locator('body')).not.toHaveClass(/inspector-closed/);
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');
    await expect(page.locator('#inspectorBody')).toContainText('Dra. Vega');
  });

  test('filtro por responsable oculta el resto de tarjetas', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('[data-kfilt-resp="Dr. García"]').click();
    await expect(page.locator('.kanban-card')).toHaveCount(1);
    await expect(page.locator('.kanban-card')).toContainText('Dataset Beta');
  });

  test('modo compacto y swimlanes por tipo renderizan', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('[data-density="compact"]').click();
    await expect(page.locator('.kanban-card.compact')).toHaveCount(3);
    await page.locator('[data-swim="type"]').click();
    await expect(page.locator('[data-swim-col]').first()).toBeVisible();
    await page.locator('[data-swim="area"]').click();
    await expect(page.locator('.kanban-view-header')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('inspector: favorito, archivar y restaurar', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
    await page.locator('#inspStarBtn').click();
    await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => p.starred))).toBe(true);
    await page.locator('#inspArchiveBtn').click();
    await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => p.archived))).toBe(true);
    await expect(page.locator('.kanban-card', { hasText: 'Paper Alfa' })).toHaveCount(0);
    await gotoView(page, 'archived');
    await expect(page.locator('#mainContent')).toContainText('Paper Alfa');
  });

  test('inspector: eliminar proyecto lo borra de la BD', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Grant Gamma' }).click();
    await page.locator('#inspDeleteBtn').click();
    await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Grant Gamma').count())).toBe(0);
  });
});

test.describe('Integridad', () => {
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
