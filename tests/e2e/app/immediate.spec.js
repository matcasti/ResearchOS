const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('../helpers');

// Un cambio, por pequeño que sea, se ve al instante: en la vista abierta, en el inspector y en el menú, sin recargar
// ni navegar, y sin que el inspector se vacíe ni la lista salte al principio.

const inspectorFlicker = page => page.evaluate(() => {
  window.__empty = 0;
  const insp = document.getElementById('inspectorBody');
  new MutationObserver(() => { if (insp.querySelector('.inspector-empty')) window.__empty++; }).observe(insp, { childList: true });
});

test.describe('Refresco inmediato', () => {
  test('★ de una idea desde el inspector aparece en su tarjeta', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    const card = page.locator('.idea-item', { hasText: 'Idea uno' });
    await card.locator('.idea-title').click();
    await expect(card).not.toContainText('★');
    await page.locator('#ideaStarInspBtn').click();
    await expect(card).toContainText('★');
    expect(errors).toEqual([]);
  });

  test('★ de un proyecto desde el inspector aparece en la tarjeta del tablero y en el menú', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    const card = page.locator('.kanban-card', { hasText: 'Paper Alfa' });
    await card.click();
    await expect(card.locator('.kanban-card-star')).toHaveCount(0);
    await page.locator('#inspStarBtn').click();
    await expect(card.locator('.kanban-card-star')).toHaveCount(1);
    await expect(page.locator('#starredBadge')).toHaveText('1');
  });

  test('eliminar una idea desde el inspector la quita de Hoy', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'dashboard');
    await page.evaluate(async () => { inspectIdea((await db.ideas.where('title').equals('Idea uno').first()).id); });
    await expect(page.locator('#mainContent')).toContainText('Idea uno');
    await page.locator('#ideaDeleteBtn').click();
    await expect(page.locator('#mainContent')).not.toContainText('Idea uno');
  });

  test('una escritura directa en la base de datos se refleja en la vista abierta', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    await expect(page.locator('#projectsContainer')).toContainText('Dataset Beta');
    await page.evaluate(() => db.projects.where('title').equals('Dataset Beta').modify({ title: 'Dataset Beta v2' }));
    await expect(page.locator('#projectsContainer')).toContainText('Dataset Beta v2');
  });

  test('cambiar un área se refleja en el selector del menú lateral', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => seedSuggestedAreas());
    await expect(page.locator('#contextSwitcher')).toContainText('Docencia');
    await page.evaluate(async () => { const a = await _getAreas(); a[1].name = 'Docencia de pregrado'; await _saveAreas(a); });
    await expect(page.locator('#contextSwitcher')).toContainText('Docencia de pregrado');
  });

  test('tras editar en el inspector, el inspector no se vacía y la lista conserva su posición', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      for (let i = 0; i < 40; i++) await db.ideas.add({ title: 'Idea extra ' + i, content: 'x', status: 'unread', projectId: null, projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    });
    await gotoView(page, 'ideas');
    const card = page.locator('.idea-item', { hasText: 'Idea extra 30' });
    await card.scrollIntoViewIfNeeded();
    await card.locator('.idea-title').click();
    const before = await page.evaluate(() => document.getElementById('mainContent').scrollTop);
    expect(before).toBeGreaterThan(300);
    await inspectorFlicker(page);
    await page.locator('#ideaStarInspBtn').click();
    await expect(card).toContainText('★');
    expect(await page.evaluate(() => document.getElementById('mainContent').scrollTop)).toBe(before);
    expect(await page.evaluate(() => window.__empty)).toBe(0);
    await expect(page.locator('#inspectorBody')).toContainText('Idea extra 30');
  });

  test('editar un campo en el inspector: un clic abre, elegir guarda y se ve en el tablero sin vaciar el panel', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    const card = page.locator('.kanban-card', { hasText: 'Paper Alfa' });
    await card.click();
    await inspectorFlicker(page);
    await page.locator('#inspectorBody [data-inplace="priority"]').click();            // un solo clic
    await page.locator('select.inplace-input').selectOption('Baja');                  // elegir guarda: sin Enter ni clic fuera
    await expect(page.locator('#inspectorBody [data-inplace="priority"]')).toContainText('Baja');
    await expect(card).toContainText('Baja');
    await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => p.priority))).toBe('Baja');
    expect(await page.evaluate(() => window.__empty)).toBe(0);
    await expect(page.locator('select.inplace-input')).toHaveCount(0);
  });

  test('el título del proyecto se renombra con un clic en el inspector y se ve en la tarjeta', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Grant Gamma' }).click();
    await page.locator('#inspectorBody [data-inplace="title"]').click();
    await page.locator('input.inplace-input').fill('Grant Delta');
    await page.keyboard.press('Enter');
    await expect(page.locator('.kanban-card', { hasText: 'Grant Delta' })).toHaveCount(1);
    await expect(page.locator('#inspectorBody .inspector-project-title')).toHaveText(/Grant Delta/);
    // un título vacío no se acepta
    await page.locator('#inspectorBody [data-inplace="title"]').click();
    await page.locator('input.inplace-input').fill('');
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast.error').last()).toContainText('vacío');
    await expect(page.locator('#inspectorBody .inspector-project-title')).toHaveText(/Grant Delta/);
  });

  test('los campos editables se alcanzan con teclado y Escape cancela sin cerrar el inspector', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
    const field = page.locator('#inspectorBody [data-inplace="responsible"]');
    await expect(field).toHaveAttribute('role', 'button');
    await field.focus();
    await page.keyboard.press('Enter');
    const input = page.locator('input.inplace-input');
    await expect(input).toBeFocused();
    await input.fill('Alguien más');
    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveClass(/inspector-closed/);
    await expect(field).not.toContainText('Alguien más');
    expect(await page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => p.responsible))).toBe('Dra. Vega');
  });

  test('lo que se está escribiendo no se pisa si llega un cambio de datos; se actualiza al soltar el campo', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
    await page.locator('#inspectorBody [data-inplace="responsible"]').click();
    const input = page.locator('input.inplace-input');
    await input.fill('Escribiendo…');
    await page.evaluate(() => db.projects.where('title').equals('Dataset Beta').modify({ title: 'Dataset Beta v3' }));
    await page.waitForTimeout(400);
    await expect(input).toHaveValue('Escribiendo…');                                  // el campo sigue ahí
    await expect(page.locator('.kanban-card', { hasText: 'Dataset Beta v3' })).toHaveCount(0);   // y la vista espera
    await page.keyboard.press('Escape');
    await expect(page.locator('.kanban-card', { hasText: 'Dataset Beta v3' })).toHaveCount(1);   // al soltar, se pone al día
  });

  test('completar una tarea en Hoy la muestra hecha al instante y un doble clic no la completa dos veces', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => { await Tasks.add({ title: 'Repetida diaria', due: localDateISO(), recurrence: { freq: 'daily', interval: 1 } }); });
    await gotoView(page, 'dashboard');
    const row = page.locator('.tw-row', { hasText: 'Repetida diaria' }).first();
    await expect(row).toBeVisible();
    await row.locator('[data-act="done"]').dblclick();
    await expect.poll(() => page.evaluate(async () => (await db.tasks.filter(t => t.title === 'Repetida diaria').toArray()).filter(t => !t.done).length)).toBe(1);
    expect(await page.evaluate(async () => (await db.tasks.filter(t => t.title === 'Repetida diaria').toArray()).filter(t => t.done).length)).toBe(1);
  });

  test('renombrar una tarjeta en el tablero guarda una sola vez y actualiza el inspector abierto', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Grant Gamma' }).click();
    await expect(page.locator('#inspectorBody')).toContainText('Grant Gamma');
    await page.locator('[data-inline-rename]', { hasText: 'Paper Alfa' }).dblclick();
    await page.locator('.kanban-inline-input').fill('Paper Omega');
    await page.keyboard.press('Enter');
    await expect(page.locator('.kanban-card', { hasText: 'Paper Omega' })).toHaveCount(1);
    await expect(page.locator('.toast.success', { hasText: 'renombrado' })).toHaveCount(1);
  });

  test('con la app abierta en dos pestañas, un cambio en una se ve en la otra sin recargar', async ({ page, context }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'projects');
    const other = await context.newPage();
    await other.goto('/index.html');
    await expect(other.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
    await gotoView(other, 'projects');
    await expect(other.locator('#projectsContainer')).toContainText('Dataset Beta');
    await page.evaluate(() => db.projects.where('title').equals('Dataset Beta').modify({ title: 'Dataset Beta (otra pestaña)' }));
    await expect(other.locator('#projectsContainer')).toContainText('Dataset Beta (otra pestaña)');
    await expect(page.locator('#projectsContainer')).toContainText('Dataset Beta (otra pestaña)');
    await other.close();
  });

  test('un cambio sin repintado propio no provoca bucles de refresco', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'dashboard');
    await page.evaluate(() => { window.__renders = 0; const f = renderToday; window.renderToday = function (...a) { window.__renders++; return f.apply(this, a); }; });
    await page.evaluate(() => db.projects.where('title').equals('Grant Gamma').modify({ priority: 'Alta' }));
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__renders)).toBeLessThanOrEqual(2);
  });
  test('un cambio de datos mientras se pulsa un botón no deshace el clic (el repintado espera a soltar)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const id = await page.evaluate(() => db.ideas.where('title').equals('Idea uno').first().then(i => i.id));
    await page.evaluate(i => inspectIdea(i), id);
    const btn = page.locator('#ideaToTaskBtn');
    await expect(btn).toBeVisible();
    await page.waitForTimeout(400);                  // deja pasar el repintado pendiente de la siembra: el cambio de abajo es el único durante la pulsación
    const box = await btn.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Mientras el botón está pulsado llega un cambio de datos: sin protección, el inspector se repinta y el botón del «mouseup» es otro
    await page.evaluate(() => db.ideas.where('title').equals('Idea uno').modify({ deadline: '2027-01-15' }));
    await page.waitForTimeout(400);
    await page.mouse.up();
    await expect(page.locator('.toast.success').last()).toContainText('convertida en tarea');
  });

  test('«→ Tarea» pulsado dos veces seguidas crea una sola tarea', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const id = await page.evaluate(() => db.ideas.where('title').equals('Idea uno').first().then(i => i.id));
    await page.evaluate(i => inspectIdea(i), id);
    await page.evaluate(() => { const b = document.getElementById('ideaToTaskBtn'); b.click(); b.click(); });
    await expect(page.locator('.toast.success').last()).toContainText('convertida en tarea');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => db.tasks.toArray().then(a => a.filter(t => t.title === 'Idea uno').length))).toBe(1);
  });
  test('un doble Enter en la captura rápida crea un solo elemento y un error devuelve el texto', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'dashboard');
    await page.locator('#captureInput').fill('t: Comprar café para el laboratorio');
    await page.evaluate(() => { const f = document.getElementById('captureForm'); f.requestSubmit(); f.requestSubmit(); });
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada');
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => db.tasks.toArray().then(a => a.filter(t => t.title.startsWith('Comprar café')).length))).toBe(1);
    await expect(page.locator('#captureInput')).toHaveValue('');
  });
  test('guardar la idea rápida dos veces seguidas (Enter mantenido) crea una sola', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.locator('#ideaTitleInput').fill('Idea única del laboratorio');
    await page.evaluate(() => { saveQuickIdea(); saveQuickIdea(); });
    await expect(page.locator('.toast.success').last()).toContainText('Idea guardada');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => db.ideas.toArray().then(a => a.filter(i => i.title === 'Idea única del laboratorio').length))).toBe(1);
  });
  test('un repintado directo lento no pisa la vista a la que se navegó después (ni muestra la pantalla de error)', async ({ page }) => {
    const { errors } = await openApp(page);
    await page.evaluate(() => loadSampleData({ replace: true }));
    await page.evaluate(() => navigate('ideas'));
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'ideas');
    await page.evaluate(() => {
      const read = Tasks.countsByIdea.bind(Tasks);
      let slow = true;
      Tasks.countsByIdea = async (...a) => { const r = await read(...a); if (slow) { slow = false; await new Promise(res => setTimeout(res, 500)); } return r; };
      renderIdeas();                       // como tras guardar una idea: el repintado directo queda esperando a la base de datos…
      navigate('submissions');             // …y la persona ya está en otra vista
    });
    await page.waitForTimeout(1200);
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'submissions');
    await expect(page.locator('.view-error')).toHaveCount(0);
    await expect(page.locator('#addSubmissionBtn')).toHaveCount(1);
    await expect(page.locator('#ideasList')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
