const { test, expect, openApp, gotoView, seed, settled, openSettingsTab, openNotices } = require('../helpers');

// Recorrido guiado interactivo y lista de primeros pasos.

const title = page => page.locator('#tourTitle');
const goTo = async (page, id) => {
  await page.evaluate(async id => { if (!Tour.active) await Tour.start({ restart: true }); await Tour.show(Tour.steps.findIndex(s => s.id === id)); }, id);
  await expect(page.locator('.tour-card')).not.toHaveClass(/is-loading/);
};
const inside = (inner, outer) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test.describe('Cómo se llega al recorrido', () => {
  test('la bienvenida ofrece tres caminos y «Recorrido guiado» lo inicia; también desde el Tutorial, la paleta, Hoy vacío y Ajustes', async ({ page }) => {
    await openApp(page, { welcomed: false });
    await expect(page.locator('#welcomeTour')).toBeVisible();
    await expect(page.locator('#welcomeLoadDemo')).toBeVisible();
    await expect(page.locator('#welcomeStart')).toBeVisible();
    await page.locator('#welcomeTour').click();
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    await expect(page.locator('#tourLayer')).toBeVisible();
    await expect(title(page)).toHaveText('Bienvenido/a a ResearchOS');
    await expect(page.locator('.tour-count')).toHaveText('Paso 1 de 16');
    await page.evaluate(() => Tour.end(false));

    await gotoView(page, 'tutorial');
    await page.locator('#tourStartBtn').click();
    await expect(page.locator('#tourLayer')).toBeVisible();
    await page.evaluate(() => Tour.end(false));
    await expect(page.locator('#tourLayer')).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await page.locator('#paletteInput').fill('recorrido');
    await page.keyboard.press('Enter');
    await expect(page.locator('#tourLayer')).toBeVisible();
    await page.evaluate(() => Tour.end(false));
    await gotoView(page, 'dashboard');
    await page.locator('#frTour').click();
    await expect(page.locator('#tourLayer')).toBeVisible();
    await page.evaluate(() => Tour.end(false));
    await gotoView(page, 'settings');
    await openSettingsTab(page, 'help');
    await page.locator('#setTourBtn').click();
    await expect(page.locator('#tourLayer')).toBeVisible();
  });
});

test.describe('Cómo funciona', () => {
  test('con la app vacía: «Empezar vacía» no carga nada, los pasos que necesitan datos se saltan, «Saltar este paso» no obliga y elegir el ejemplo lo carga', async ({ page }) => {
    const { errors } = await openApp(page);
    await page.evaluate(() => Tour.start({ restart: true }));
    await expect(page.locator('.tour-choices .btn')).toHaveCount(2);
    await expect(page.locator('[data-tour="next"]')).toBeHidden();
    await page.locator('.tour-choices .btn-ghost').click();                              // «Empezar vacía»
    await expect(title(page)).toHaveText('Hoy: tu punto de partida');
    expect(await page.evaluate(() => db.projects.count())).toBe(0);

    await goTo(page, 'hoy');                                                              // sin tareas ni proyectos, los pasos que los necesitan se saltan
    expect(await page.evaluate(() => !Tour.steps.find(s => s.id === 'completar').needs())).toBe(true);
    await goTo(page, 'tablero');
    expect(await page.evaluate(() => [!Tour.steps.find(s => s.id === 'abrir').needs(), !Tour.steps.find(s => s.id === 'ficha').needs()])).toEqual([true, true]);
    await page.evaluate(() => Tour.next());                                               // y al avanzar de verdad no se detiene en ellos
    await expect(title(page)).toHaveText('Varias formas de ver tus proyectos', { timeout: 8000 });

    await goTo(page, 'captura');                                                          // «Saltar este paso» no obliga a hacerlo
    await page.locator('[data-tour="next"]').click();
    await expect(title(page)).not.toHaveText('Captura sin pensar dónde va');
    expect(await page.evaluate(() => db.tasks.count())).toBe(0);

    await page.evaluate(() => { Tour.end(false); return Tour.start({ restart: true }); });   // elegir el ejemplo carga los datos y sigue
    await page.locator('.tour-choices .btn-primary').click();
    await expect(title(page)).toHaveText('Hoy: tu punto de partida');
    expect(await page.evaluate(() => hasSampleData())).toBe(true);
    await expect(page.locator('#todayRoot')).toContainText('Atrasado y para hoy');
    expect(errors).toEqual([]);
  });

  test('con datos: el foco rodea el elemento y lo de fuera queda bloqueado, los atajos no abren nada tapado, «Tu turno» se detecta y Esc pausa y se retoma', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => Tour.start({ restart: true }));                             // con datos propios no ofrece cargar ejemplo ni toca nada
    await expect(page.locator('.tour-choices')).toBeHidden();
    await expect(page.locator('.tour-body')).toContainText('datos reales');
    expect(await page.evaluate(() => hasSampleData())).toBe(false);

    for (const [id, selector] of [['captura', '#captureForm'], ['plan', '#todayRoot .today-actions'], ['pestanas', '.proj-tabs']]) {   // el foco rodea el elemento real y el cartel no lo tapa
      await goTo(page, id);
      await expect(page.locator('.tour-ring')).toBeVisible();
      await expect.poll(async () => inside(await page.locator(selector).boundingBox(), await page.locator('.tour-ring').boundingBox())).toBe(true);
      const card = await page.locator('.tour-card').boundingBox(), target = await page.locator(selector).boundingBox();
      if (target.height < 600 && target.width < 900) expect(overlaps(card, target), id).toBe(false);
    }

    await goTo(page, 'captura');                                                          // lo de fuera del foco queda bloqueado, lo de dentro responde
    const before = await page.evaluate(() => App.view);
    await page.mouse.click(30, 300);                                                      // sobre el menú lateral, atenuado
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => App.view)).toBe(before);
    await page.locator('#captureInput').click();
    await expect(page.locator('#captureInput')).toBeFocused();

    await expect(page.locator('.tour-task')).toContainText('Tu turno');                   // «Tu turno»: crear una tarea en la captura avanza solo
    await expect(page.locator('[data-tour="next"]')).toHaveText('Saltar este paso →');
    await page.locator('[data-task-fill]').click();
    await expect(page.locator('#captureInput')).toHaveValue('revisar el manuscrito mañana !alta');
    await page.locator('#captureInput').press('Enter');
    await expect(page.locator('.tour-task.is-done')).toContainText('¡Muy bien!');
    await expect(title(page)).toHaveText(/Completa tareas|Planifica el día/, { timeout: 5000 });
    expect(await page.evaluate(() => db.tasks.filter(t => t.title.startsWith('revisar el manuscrito')).count())).toBe(1);

    await goTo(page, 'hoy');                                                              // los atajos no abren nada tapado por la capa
    await page.locator('.tour-body').click();
    for (const k of ['n', '?', 'Control+k', 'Control+z']) await page.keyboard.press(k);
    await page.waitForTimeout(250);
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    await expect(page.locator('#paletteOverlay')).not.toHaveClass(/open/);

    await page.evaluate(() => Tasks.add({ title: 'Para completar', due: localDateISO() }));
    await goTo(page, 'completar');                                                        // «Tu turno»: completar una tarea, abrir un proyecto, abrir la paleta
    await page.locator('#todayRoot .tw-row', { hasText: 'Para completar' }).locator('.tw-check').click();
    await expect(page.locator('.tour-task.is-done')).toBeVisible();
    await goTo(page, 'abrir');
    await page.locator('.kanban-card').first().click();
    await expect(page.locator('.tour-task.is-done')).toBeVisible();
    await expect(title(page)).toHaveText('La ficha del proyecto', { timeout: 5000 });
    await expect(page.locator('#inspectorPanel')).toBeVisible();
    await goTo(page, 'buscar');
    await page.keyboard.press('Control+k');                                               // Ctrl+K solo funciona en el paso del buscador
    await expect(page.locator('.tour-task.is-done')).toBeVisible();
    await expect.poll(async () => inside(await page.locator('#paletteInput').boundingBox(), await page.locator('.tour-ring').boundingBox())).toBe(true);
    await page.keyboard.press('Escape');                                                  // Esc cierra la paleta, no el recorrido
    await expect(page.locator('#paletteOverlay')).not.toHaveClass(/open/);
    await expect(page.locator('#tourLayer')).toBeVisible();

    await page.evaluate(() => { Tour.end(false); return Tour.start({ restart: true }); });   // flechas navegan, Esc pausa y el recorrido se retoma donde quedó
    await page.locator('#tourTitle').click();
    await page.keyboard.press('ArrowRight');
    await expect(title(page)).toHaveText('Hoy: tu punto de partida');
    await page.keyboard.press('ArrowRight');
    await expect(title(page)).toHaveText('Captura sin pensar dónde va');
    await page.locator('.tour-body').click();                                             // el foco sale del campo de captura: las flechas vuelven a navegar
    await page.keyboard.press('ArrowLeft');
    await expect(title(page)).toHaveText('Hoy: tu punto de partida');
    await page.keyboard.press('Escape');
    await expect(page.locator('#tourLayer')).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: 'Recorrido en pausa' }).last()).toBeVisible();
    expect(await page.evaluate(() => Tour.state().step)).toBe(1);
    await gotoView(page, 'tutorial');
    await expect(page.locator('#tourStartBtn')).toHaveText('Retomar el recorrido');
    await page.locator('#tourStartBtn').click();
    await expect(title(page)).toHaveText('Hoy: tu punto de partida');
  });

  test('con el ejemplo cargado recorre los 16 pasos con «Siguiente» sin errores ni textos rotos; el último deja quitarlo y termina', { tag: '@slow' }, async ({ page }) => {
    test.setTimeout(120_000);
    const { errors } = await openApp(page);
    await page.evaluate(() => loadSampleData());
    await page.evaluate(() => Tour.start({ restart: true }));
    for (let n = 0; n < 16; n++) {
      await expect(page.locator('.tour-card')).not.toHaveClass(/is-loading/);
      expect(await page.locator('.tour-card').innerText()).not.toMatch(/undefined|NaN|\[object/);
      if (await page.evaluate(() => Tour.i === Tour.steps.length - 1)) break;
      await page.evaluate(() => Tour.next());
      await page.waitForFunction(() => Tour.active && !Tour.card.classList.contains('is-loading'));
    }
    expect(await page.evaluate(() => Tour.i)).toBe(15);
    await expect(page.locator('.tour-choices .btn')).toHaveCount(2);
    await page.locator('.tour-choices .btn-primary').click();                             // «Quitar el ejemplo» y terminar
    await expect(page.locator('#tourLayer')).toHaveCount(0);
    expect(await page.evaluate(() => hasSampleData())).toBe(false);
    expect(await page.evaluate(() => Tour.state().done)).toBe(true);
    await expect(page.locator('.toast', { hasText: 'Recorrido completado' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('Móvil', () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });

  test('el cartel se ancla arriba o abajo sin tapar el elemento y cabe en la pantalla; el paso de áreas se salta', async ({ page }) => {
    await openApp(page);
    await seed(page);
    for (const [id, selector] of [['captura', '#captureForm'], ['menu', '#mobileBar'], ['plan', '#todayRoot .today-actions']]) {
      await goTo(page, id);
      await expect(page.locator('.tour-ring')).toBeVisible();
      // el cartel termina de colocarse tras la animación: se mide cuando ya no se mueve
      await expect.poll(async () => {
        const card = await page.locator('.tour-card').boundingBox(), target = await page.locator(selector).boundingBox();
        return card.x >= 0 && card.x + card.width <= 390 && card.y >= 0 && card.y + card.height <= 800 && !overlaps(card, target);
      }, { message: id }).toBe(true);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => Tour.steps.find(s => s.id === 'areas').skipIf())).toBe(true);
  });
});

test.describe('Primeros pasos en Hoy', () => {
  test('se marcan solos según lo que haces y se pueden ocultar', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#todayRoot .first-run')).toBeVisible();                   // con la app vacía manda el panel de bienvenida
    await expect(page.locator('.onboard')).toHaveCount(0);
    await page.evaluate(async () => { const col = (await db.kanbanColumns.toArray())[0], now = new Date().toISOString();
      await db.projects.add({ title: 'Mi primer proyecto', type: 'Paper', columnId: col.id, priority: 'Media', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now }); });
    await expect(page.locator('.onboard')).toContainText('Primeros pasos');
    await expect(page.locator('.onb-count')).toHaveText('1/7');
    await openNotices(page);
    await page.locator('[data-ob="areas"]').click();
    await expect(page.locator('.onb-item.done')).toHaveCount(2);
    await page.evaluate(() => Tasks.add({ title: 'Mi primera tarea', due: localDateISO() }));
    await expect(page.locator('.onb-item.done')).toHaveCount(3);
    await page.keyboard.press('Control+k');                                              // abrir el buscador también cuenta
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => Onboard.get().search)).toBe(true);
    await gotoView(page, 'dashboard');
    await expect(page.locator('.onb-count')).toHaveText('4/7');
    await expect(page.locator('.onb-bar')).toHaveAttribute('aria-valuenow', '4');
    await page.locator('#obHide').click();
    await expect(page.locator('.onboard')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
    await expect(page.locator('.onboard')).toHaveCount(0);                              // la elección se recuerda
    await gotoView(page, 'settings');
    await openSettingsTab(page, 'help');
    await page.locator('#setOnbShow').click();
    await gotoView(page, 'dashboard');
    await expect(page.locator('.onboard')).toBeVisible();
  });

  test('con el ejemplo cargado la lista empieza plegada y se despliega recordando la elección; mover un proyecto de columna cuenta y lo de ejemplo no', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => loadSampleData());
    await gotoView(page, 'dashboard');
    await expect(page.locator('.onboard')).toHaveClass(/is-collapsed/);
    await expect(page.locator('#obList')).toBeHidden();
    await expect(page.locator('#obTour')).toHaveCount(0);                                // el recorrido ya está en el aviso del ejemplo
    await expect(page.locator('.onb-count')).toHaveText('1/7');                          // solo las áreas (vienen con el ejemplo); lo demás es de ejemplo
    await openNotices(page);
    await page.locator('#obToggle').click();
    await expect(page.locator('#obList')).toBeVisible();
    await expect(page.locator('#obToggle')).toHaveAttribute('aria-expanded', 'true');
    await gotoView(page, 'ideas');
    await gotoView(page, 'dashboard');
    await expect(page.locator('#obList')).toBeVisible();
    await page.evaluate(async () => { const p = await db.projects.toCollection().first(); const cols = await db.kanbanColumns.toArray(); await recordColumnChange(p.id, cols.find(c => c.id !== p.columnId).id); });
    await gotoView(page, 'ideas');
    await gotoView(page, 'dashboard');
    await expect(page.locator('.onb-count')).toHaveText('2/7');
  });

  test('quien ya tiene mucho material no ve la guía', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const col = (await db.kanbanColumns.toArray())[0], now = new Date().toISOString();
      await db.projects.bulkAdd(Array.from({ length: 70 }, (_, i) => ({ title: 'P' + i, type: 'Paper', columnId: col.id, priority: 'Media', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now })));
    });
    await gotoView(page, 'dashboard');
    await expect(page.locator('.onboard')).toHaveCount(0);
  });

  test('completar todo se celebra una sola vez', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');                                                        // fuera de Hoy: así no se «gasta» la felicitación mientras se prepara el escenario
    await page.evaluate(async () => {
      await seedSuggestedAreas();
      const col = (await db.kanbanColumns.toArray())[0], now = new Date().toISOString();
      const pid = await db.projects.add({ title: 'Mío', type: 'Paper', columnId: col.id, priority: 'Media', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now });
      await db.ideas.add({ title: 'Mi idea', content: '', status: 'unread', projectId: null, projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
      await Tasks.add({ title: 'Mi tarea', projectId: pid });
      Onboard.set({ moved: true, search: true }); BackupMeta.mark();
    });
    await settled(page);                                                                  // el repintado automático de esas escrituras no debe coincidir con el de Hoy
    await gotoView(page, 'dashboard');
    await expect(page.locator('.onboard')).toContainText('Ya conoces lo esencial');
    await gotoView(page, 'ideas');
    await gotoView(page, 'dashboard');
    await expect(page.locator('.onboard')).toHaveCount(0);
  });
});
