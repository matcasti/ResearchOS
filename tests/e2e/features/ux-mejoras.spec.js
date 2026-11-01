// Mejoras de uso detectadas al recorrer la app completa: bienvenida que no insiste, Calendario con tareas, Hoy con las tareas primero,
// menú con contadores y perfiles de uso, Ajustes en pestañas y la copia de seguridad a la vista.
const { test, expect, openApp, gotoView, seed } = require('../helpers');

const iso = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); const p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

test.describe('Bienvenida', () => {
  test('elegir un camino la silencia para siempre; quien ya tiene datos no la ve; cerrarla sin elegir la deja para la próxima', async ({ page }) => {
    await openApp(page, { welcomed: false });
    await expect(page.locator('#welcomeStart')).toBeVisible();
    await page.keyboard.press('Escape');                                       // cerrar sin elegir
    await page.reload();
    await expect(page.locator('#welcomeStart')).toBeVisible();                 // sigue sin haber elegido: vuelve a ofrecerse
    await page.locator('#welcomeStart').click();                              // elegir «empezar con mi app vacía»
    await page.reload();
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);    // aunque no haya datos, ya eligió: no insiste
    await page.evaluate(() => localStorage.removeItem('ros-welcomed'));
    await page.reload();
    await expect(page.locator('#welcomeLoadDemo')).toBeVisible();
    await page.locator('#welcomeLoadDemo').click();                           // elegir «datos de ejemplo»
    await expect(page.locator('.toast.success').last()).toContainText('Datos de ejemplo');
    await page.reload();
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);    // ya con datos y con camino elegido: no insiste

    await page.evaluate(() => localStorage.removeItem('ros-welcomed'));         // un navegador con datos pero sin la marca (p. ej. de una versión anterior)
    await page.reload();
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    expect(await page.evaluate(() => localStorage.getItem('ros-welcomed'))).toBe('1');
  });
});

test.describe('Calendario', () => {
  test('muestra las tareas con fecha (abiertas y hechas), respeta el área y abre su proyecto', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      await Tasks.add({ title: 'Redactar métodos', projectId: 1, due: addDaysISO(2), priority: 'Alta' });
      await Tasks.add({ title: 'Pedir permiso', due: addDaysISO(2) });
      await Tasks.add({ title: 'Hoy mensual', due: addDaysISO(0) });
      const id = await Tasks.add({ title: 'Ya enviada', projectId: 1, due: addDaysISO(3) });
      await Tasks.setDone(id, true);
    });
    await gotoView(page, 'weekly');
    await expect(page.locator('.weekly-event', { hasText: '☐ Redactar métodos' })).toBeVisible();
    await expect(page.locator('.weekly-event', { hasText: '☐ Pedir permiso' })).toBeVisible();
    await expect(page.locator('.weekly-event.is-done', { hasText: '☑ Ya enviada' })).toBeVisible();     // lo hecho se ve atenuado
    await page.locator('.weekly-event', { hasText: 'Redactar métodos' }).click();                       // abre su proyecto
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');
    await page.locator('.weekly-event', { hasText: 'Pedir permiso' }).click();                          // una tarea suelta se gestiona en Hoy
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'dashboard');

    await gotoView(page, 'weekly');                                                                     // vista mensual
    await page.locator('#agendaMonthBtn').click();
    await expect(page.locator('.monthly-event-pill', { hasText: '☐ Hoy mensual' }).first()).toBeVisible();

    await page.evaluate(async () => {                                                                   // el área activa filtra las tareas igual que en Hoy
      await _saveAreas([{ id: 1, name: 'Investigación', color: '#3b82f6' }, { id: 2, name: 'Docencia', color: '#10b981' }]);
      await db.projects.where('title').equals('Paper Alfa').modify({ areaId: 1 });
      await setAreaContext(2);
    });
    await gotoView(page, 'weekly');
    await expect(page.locator('.monthly-event-pill', { hasText: 'Hoy mensual' })).toHaveCount(0);
  });
});

test.describe('Hoy', () => {
  test('los avisos van en una sola franja plegable y las tareas quedan arriba; «Sin fecha» y «Más adelante» se pliegan si son muchas', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => loadSampleData({ replace: true }));
    await gotoView(page, 'dashboard');
    const franja = page.locator('#todayNotices');
    await expect(franja).toBeVisible();
    await expect(franja.locator('summary')).toContainText('datos de ejemplo');
    await expect(franja.locator('summary')).toContainText('primeros pasos');
    await expect(page.locator('.sample-banner')).toBeHidden();                       // plegada por defecto: no empuja las tareas hacia abajo
    const alto = await page.evaluate(() => document.querySelector('.today-main > :first-child').getBoundingClientRect().top);
    expect(alto).toBeLessThan(420);
    await franja.locator('summary').click();                                         // se despliega y se recuerda
    await expect(page.locator('.sample-banner')).toBeVisible();
    await page.reload();
    await expect(page.locator('.sample-banner')).toBeVisible();
    await page.locator('#todayNotices > summary').click();
    await expect(page.locator('.sample-banner')).toBeHidden();

    const sinFecha = page.locator('[data-sec="loose"]');                              // con 4 o más, «Sin fecha» empieza plegada y la elección se recuerda
    await expect(sinFecha).toHaveJSProperty('open', false);
    await sinFecha.locator('> summary').click();
    await expect(sinFecha).toHaveJSProperty('open', true);
    await page.reload();
    await expect(page.locator('[data-sec="loose"]')).toHaveJSProperty('open', true);
  });

  test('en móvil, los tipos de captura aparecen al escribir y la columna lateral no corta los títulos', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => Tasks.add({ title: 'Una tarea con un título bastante largo que antes se cortaba con puntos suspensivos', assigneeId: 1, due: addDaysISO(1) }));
    await gotoView(page, 'dashboard');
    const largo = await page.locator('.today-side .tw-text', { hasText: 'Una tarea con un título' }).evaluate(e => ({ clamp: getComputedStyle(e).webkitLineClamp, ws: getComputedStyle(e).whiteSpace }));
    expect(largo).toEqual({ clamp: '2', ws: 'normal' });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.reload();
    await expect(page.locator('.capture-kinds')).toBeHidden();
    await page.locator('#captureInput').focus();
    await expect(page.locator('.capture-kinds')).toBeVisible();
  });
});

test.describe('Menú y perfiles', () => {
  test('el grupo plegado dice cuántos pendientes esconde; «Carpetas del proyecto» ya no es jerga', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'dashboard');
    const personas = page.locator('[data-group="people"] .nav-group-dot');
    await expect(personas).toBeVisible();
    await expect(personas).toHaveText(/^\d+$/);
    expect(+(await personas.innerText())).toBeGreaterThan(0);
    await page.locator('[data-group="more"] .nav-group-toggle').click();
    await expect(page.locator('.nav-item[data-view="filesystem"]')).toContainText('Carpetas del proyecto');
    expect(await page.locator('.nav-item', { hasText: 'FS Bridge' }).count()).toBe(0);
  });

  test('el perfil de uso oculta del menú lo que no usas, sigue accesible desde la paleta y se elige en el primer uso o en Ajustes', async ({ page }) => {
    await openApp(page);
    await page.locator('.fr-profile[data-profile="teaching"]').click();                 // primer uso: Docencia
    await expect(page.locator('.toast.success').last()).toContainText('Menú actualizado');
    await page.locator('[data-group="library"] .nav-group-toggle').click();
    await page.locator('[data-group="more"] .nav-group-toggle').click();
    for (const v of ['references', 'snippets', 'submissions', 'report']) await expect(page.locator(`.nav-item[data-view="${v}"]`)).toBeHidden();
    for (const v of ['starred', 'review', 'archived']) await expect(page.locator(`.nav-item[data-view="${v}"]`)).toBeVisible();

    await page.reload();                                                                // se recuerda
    await expect(page.locator('.nav-item[data-view="references"]')).toBeHidden();
    await page.keyboard.press('Control+k');                                              // …pero la paleta sigue llegando a todo
    await page.fill('#paletteInput', 'referencias');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => App.view)).toBe('references');
    await expect(page.locator('.nav-item[data-view="references"]')).toHaveClass(/active/);   // abierta, no queda invisible
    await expect(page.locator('.nav-item[data-view="references"]')).toBeVisible();

    await gotoView(page, 'settings');                                                    // Ajustes → Preferencias
    await page.locator('[data-settings-tab="prefs"]').click();
    await page.selectOption('#profileSelect', 'all');
    await expect(page.locator('.nav-item[data-view="snippets"]')).toBeAttached();
    expect(await page.locator('.nav-item.profile-hidden').count()).toBe(0);
  });
});

test.describe('Ajustes', () => {
  test('cuatro pestañas con buscador, títulos sin emoji y la pestaña elegida se recuerda', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'settings');
    await expect(page.locator('.settings-tab')).toHaveText([/Datos y copias/, /Sincronización e IA/, /Preferencias/, /Ayuda y avanzado/]);
    await expect(page.locator('.settings-tab.active')).toContainText('Datos y copias');
    await expect(page.locator('#exportJsonBtn')).toBeVisible();
    await expect(page.locator('#syncOn')).toBeHidden();                                  // lo de otra pestaña no estorba
    const titulos = await page.locator('.settings-section:not([hidden]) > .settings-section-title').allInnerTexts();
    expect(titulos.length).toBeGreaterThan(5);
    for (const t of titulos) expect(/^[\p{L}\p{N}]/u.test(t.trim()), t).toBe(true);        // sin emojis delante
    await page.locator('[data-settings-tab="sync"]').click();
    await expect(page.locator('#syncOn')).toBeVisible();
    await expect(page.locator('#assistantOn')).toBeVisible();
    await expect(page.locator('#exportJsonBtn')).toBeHidden();
    await page.reload();
    await gotoView(page, 'settings');
    await expect(page.locator('.settings-tab.active')).toContainText('Sincronización e IA');   // se recuerda

    await page.fill('#settingsSearch', 'cifrada');                                       // el buscador atraviesa las pestañas
    await expect(page.locator('.settings-section:not([hidden]) > .settings-section-title', { hasText: 'Copia cifrada' })).toBeVisible();
    await expect(page.locator('#syncOn')).toBeHidden();
    await page.fill('#settingsSearch', 'google');                                        // y abre lo avanzado si coincide
    await expect(page.locator('#googleSyncSection')).toBeVisible();
    await page.fill('#settingsSearch', '');
    await expect(page.locator('.settings-tab.active')).toContainText('Sincronización e IA');
  });
});

test.describe('Copia de seguridad a la vista', () => {
  test('el menú avisa si no hay copia, la muestra al exportar y lleva a Ajustes; el primer paso cuenta la copia automática', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#backupLine')).toBeHidden();                              // app vacía: no hay nada que proteger todavía
    await seed(page);
    await gotoView(page, 'ideas');
    await expect(page.locator('#backupLine')).toBeVisible();
    await expect(page.locator('#backupLine')).toHaveClass(/is-warn/);
    await expect(page.locator('#backupLine')).toContainText('Sin copia de seguridad');
    await page.evaluate(() => BackupMeta.mark());
    await expect(page.locator('#backupLine')).toContainText('Copia de hoy');
    await expect(page.locator('#backupLine')).not.toHaveClass(/is-warn/);
    await page.evaluate(() => localStorage.setItem('ros-last-export', String(Date.now() - 20 * 86400000)));
    await page.evaluate(() => updateBackupLine());
    await expect(page.locator('#backupLine')).toContainText('hace 20 d');
    await expect(page.locator('#backupLine')).toHaveClass(/is-warn/);
    await page.locator('#backupLine').click();
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'settings');
    await expect(page.locator('.settings-tab.active')).toContainText('Datos y copias');

    await page.evaluate(() => { localStorage.removeItem('ros-last-export'); localStorage.setItem('ros-autobackup', '1'); localStorage.setItem('ros-autobackup-last', String(Date.now())); });
    expect((await page.evaluate(() => _onboardItems())).find(i => i.id === 'backup').done).toBe(true);      // la copia automática también cuenta
  });

  test('las tarjetas del Tablero solo destacan la prioridad cuando no es la normal', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await expect(page.locator('.kanban-card', { hasText: 'Paper Alfa' }).locator('.badge', { hasText: 'Alta' })).toBeVisible();
    await expect(page.locator('.kanban-card', { hasText: 'Grant Gamma' }).locator('.badge', { hasText: 'Baja' })).toBeVisible();
    await expect(page.locator('.kanban-card', { hasText: 'Dataset Beta' }).locator('.badge', { hasText: 'Media' })).toHaveCount(0);   // «Media» es lo normal: no hace falta decirlo
  });
});
