// Planificación del día (tiempo estimado, «Mi día», capacidad), informe de avance y recordatorios.
const { test, expect, openApp, gotoView, seed, openSettingsTab } = require('../helpers');

const projects = [{ id: 1, title: 'Paper Alfa' }];
const parse = (page, raw) => page.evaluate(([r, pr]) => parseCapture(r, pr, new Date('2026-10-31T12:00:00'), []), [raw, projects]);   // sábado
const task = (page, t) => page.evaluate(t => db.tasks.filter(x => x.title === t).first(), t);
const addTask = (page, o) => page.evaluate(o => Tasks.add(o), o);

test.describe('Tiempo estimado en la captura', () => {
  test('~2h, ~30m, ~1h30, ~1,5h, ~45min y ~90', async ({ page }) => {
    await openApp(page);
    expect(await parse(page, 'escribir métodos ~2h')).toMatchObject({ kind: 'task', title: 'escribir métodos', effort: 120 });
    expect((await parse(page, 'revisar figuras ~30m')).effort).toBe(30);
    expect((await parse(page, 'leer paper ~1h30 mañana')).effort).toBe(90);
    expect(await parse(page, 'leer paper ~1h30 mañana')).toMatchObject({ title: 'leer paper', due: '2026-11-01' });
    expect((await parse(page, 'reunión de lab ~1,5h')).effort).toBe(90);
    expect((await parse(page, 'correo ~45min')).effort).toBe(45);
    expect((await parse(page, 'ordenar datos ~90')).effort).toBe(90);
    expect((await parse(page, 'sin estimación')).effort).toBeNull();
    // un «~» suelto o con texto no es una estimación
    expect((await parse(page, 'unos ~ cuantos')).effort).toBeNull();
    // convive con proyecto y prioridad; con estimación solo, es tarea
    expect(await parse(page, 'análisis ~3h @alfa !alta')).toMatchObject({ kind: 'task', projectId: 1, priority: 'Alta', effort: 180, title: 'análisis' });
  });

  test('la vista previa muestra el tiempo y la tarea lo guarda; la fila lo enseña', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.fill('#captureInput', 'redactar discusión ~1h30 hoy');
    await expect(page.locator('#capturePreview')).toContainText('⏱ 1 h 30');
    await page.press('#captureInput', 'Enter');
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada');
    expect((await task(page, 'redactar discusión')).effort).toBe(90);
    await expect(page.locator('.tw-row', { hasText: 'redactar discusión' }).locator('.tw-effort')).toHaveText('⏱ 1 h 30');
  });

  test('fmtEffort y el saneamiento de backups descartan valores absurdos', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => ({
      f: [fmtEffort(30), fmtEffort(60), fmtEffort(90), fmtEffort(125), fmtEffort(0), fmtEffort(null)],
      c: [Tasks.cleanEffort(-5), Tasks.cleanEffort('abc'), Tasks.cleanEffort(0.2), Tasks.cleanEffort(45.4), Tasks.cleanEffort(99999)],
      s: sanitizeBackup({ tasks: [{ id: 1, title: 'x', effort: 'mucho', planDate: 'ayer' }, { id: 2, title: 'y', effort: 75, planDate: '2026-11-03' }] }).tasks.map(t => [t.effort, t.planDate]),
    }));
    expect(r.f).toEqual(['30 min', '1 h', '1 h 30', '2 h 5', '', '']);
    expect(r.c).toEqual([null, null, null, 45, 1440]);
    expect(r.s).toEqual([[null, null], [75, '2026-11-03']]);
  });
});

test.describe('Mi día', () => {
  test('desde el menú de la fila: hacer hoy, estimar tiempo y quitar de mi día', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const id = await addTask(page, { title: 'Armar presentación', due: null });
    await gotoView(page, 'dashboard');
    await expect(page.locator('[data-sec="plan"]')).toHaveCount(0);
    const row = () => page.locator('.tw-row', { hasText: 'Armar presentación' });
    await row().hover();
    await row().locator('[data-act="menu"]').click();
    await page.locator('.tw-menu-item', { hasText: 'Hacer hoy' }).click();
    await expect(page.locator('[data-sec="plan"] .tw-row', { hasText: 'Armar presentación' })).toBeVisible();
    expect((await task(page, 'Armar presentación')).planDate).toBe(await page.evaluate(() => localDateISO()));
    // estimar
    await row().locator('[data-act="menu"]').click();
    await page.locator('.tw-menu-item', { hasText: 'Tiempo estimado' }).click();
    await page.locator('.tw-menu-item', { hasText: '2 h' }).click();
    await expect(row().locator('.tw-effort')).toHaveText('⏱ 2 h');
    await expect(page.locator('#planSub')).toContainText('2 h de 6 h');
    // quitar
    await row().locator('[data-act="menu"]').click();
    await page.locator('.tw-menu-item', { hasText: 'Quitar de mi día' }).click();
    await expect(page.locator('[data-sec="plan"]')).toHaveCount(0);
    expect((await task(page, 'Armar presentación')).planDate).toBeNull();
    void id;
  });

  test('el medidor compara con la capacidad y avisa cuando te pasas', async ({ page }) => {
    await openApp(page);
    const today = await page.evaluate(() => localDateISO());
    for (const [t, m] of [['A', 180], ['B', 120], ['C', null]]) await addTask(page, { title: 'Tarea ' + t, effort: m, planDate: today });
    await gotoView(page, 'dashboard');
    await expect(page.locator('#planSub')).toContainText('5 h de 6 h');
    await expect(page.locator('#planSub')).toContainText('1 sin estimar');
    await expect(page.locator('[data-sec="plan"]')).not.toHaveClass(/is-over/);
    await addTask(page, { title: 'Tarea D', effort: 120, planDate: today });
    await gotoView(page, 'dashboard');
    await expect(page.locator('#planSub')).toContainText('te pasas por 1 h');
    await expect(page.locator('[data-sec="plan"]')).toHaveClass(/is-over/);
    // lo planificado no se repite en «Atrasado y para hoy»
    await expect(page.locator('.tw-row', { hasText: 'Tarea A' })).toHaveCount(1);
    // la capacidad se cambia en Ajustes
    await gotoView(page, 'settings');
    await openSettingsTab(page, 'prefs');
    await page.fill('#setCapacity', '8'); await page.press('#setCapacity', 'Tab');
    await gotoView(page, 'dashboard');
    await expect(page.locator('#planSub')).toContainText('7 h de 8 h');
    await expect(page.locator('[data-sec="plan"]')).not.toHaveClass(/is-over/);
  });

  test('lo planificado ayer y sin terminar sigue en mi día, marcado como pendiente de ayer', async ({ page }) => {
    await openApp(page);
    const yesterday = await page.evaluate(() => addDaysISO(-1));
    await addTask(page, { title: 'Quedó de ayer', planDate: yesterday, effort: 60 });
    await gotoView(page, 'dashboard');
    const row = page.locator('[data-sec="plan"] .tw-row', { hasText: 'Quedó de ayer' });
    await expect(row).toBeVisible();
    await expect(row.locator('.tw-carry')).toContainText('pendiente de ayer');
  });

  test('completar una tarea planificada la cuenta como hecha hoy y una recurrente no hereda el plan', async ({ page }) => {
    await openApp(page);
    const today = await page.evaluate(() => localDateISO());
    await addTask(page, { title: 'Corregir pruebas', planDate: today, effort: 45, recurrence: { freq: 'weekly', interval: 1 } });
    await addTask(page, { title: 'Otra', planDate: today, effort: 30 });
    await gotoView(page, 'dashboard');
    await page.locator('[data-sec="plan"] .tw-row', { hasText: 'Corregir pruebas' }).locator('[data-act="done"]').click();
    await expect(page.locator('#planSub')).toContainText('1 hecha hoy');
    const all = await page.evaluate(() => db.tasks.filter(t => t.title === 'Corregir pruebas').toArray());
    expect(all).toHaveLength(2);
    expect(all.find(t => !t.done).planDate).toBeNull();
    expect(all.find(t => !t.done).due).not.toBe(today);
  });
});

test.describe('Planificar mi día', () => {
  test('lista lo urgente, sugiere según la capacidad y guarda plan y estimaciones', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const p = await page.evaluate(() => ({ today: localDateISO(), late: addDaysISO(-2), soon: addDaysISO(2), far: addDaysISO(20) }));
    await addTask(page, { title: 'Atrasada', due: p.late, effort: 240 });
    await addTask(page, { title: 'De hoy', due: p.today, effort: 120 });
    await addTask(page, { title: 'En dos días', due: p.soon, effort: 60 });
    await addTask(page, { title: 'Lejana', due: p.far });
    await addTask(page, { title: 'De otra persona', due: p.today, assigneeId: await page.evaluate(() => db.collaborators.toCollection().first().then(c => c.id)) });
    await gotoView(page, 'dashboard');
    await page.click('#planDayBtn');
    await expect(page.locator('.dp-row').first()).toBeVisible();
    const titles = await page.locator('.dp-title').allTextContents();
    expect(titles.slice(0, 3)).toEqual(['Atrasada', 'De hoy', 'En dos días']);
    expect(titles).not.toContain('Lejana');
    expect(titles).not.toContain('De otra persona');
    // «Sugerir» con 6 h: atrasada (4 h) + de hoy (2 h); la tercera ya no cabe
    await page.click('#dpSuggest');
    await expect(page.locator('.dp-row', { hasText: 'Atrasada' }).locator('.dp-check')).toBeChecked();
    await expect(page.locator('.dp-row', { hasText: 'De hoy' }).locator('.dp-check')).toBeChecked();
    await expect(page.locator('.dp-row', { hasText: 'En dos días' }).locator('.dp-check')).not.toBeChecked();
    await expect(page.locator('#dpSummary')).toContainText('6 h de 6 h');
    // marcar la tercera: aviso de exceso; ajustar su tiempo
    await page.locator('.dp-row', { hasText: 'En dos días' }).locator('.dp-check').check();
    await expect(page.locator('#dpSummary')).toContainText('te pasas por 1 h');
    await page.locator('.dp-row', { hasText: 'En dos días' }).locator('.dp-eff').fill('30');
    await expect(page.locator('#dpSummary')).toContainText('te pasas por 30 min');
    await page.fill('#dpCap', '7');
    await expect(page.locator('#dpSummary')).toContainText('te sobran 30 min');
    await page.click('#dpSave');
    await expect(page.locator('.toast.success').last()).toContainText('Mi día listo: 3 tareas');
    const saved = await page.evaluate(() => db.tasks.toArray());
    const by = t => saved.find(x => x.title === t);
    expect(by('Atrasada').planDate).toBe(p.today); expect(by('De hoy').planDate).toBe(p.today);
    expect(by('En dos días')).toMatchObject({ planDate: p.today, effort: 30 });
    expect(by('Lejana').planDate).toBeNull();
    expect(await page.evaluate(() => Capacity.get())).toBe(420);
    await expect(page.locator('[data-sec="plan"] .tw-row')).toHaveCount(3);
    // volver a abrir: lo planificado aparece marcado; desmarcar y guardar lo quita de mi día
    await page.click('#planDayBtn');
    await expect(page.locator('.dp-check:checked')).toHaveCount(3);
    await page.locator('.dp-row', { hasText: 'De hoy' }).locator('.dp-check').uncheck();
    await page.click('#dpSave');
    expect((await task(page, 'De hoy')).planDate).toBeNull();
    await expect(page.locator('[data-sec="plan"] .tw-row')).toHaveCount(2);
  });

  test('sin tareas muestra un mensaje y no falla', async ({ page }) => {
    const { errors } = await openApp(page);
    await page.click('#planDayBtn');
    await expect(page.locator('.dp-list')).toContainText('No hay tareas pendientes');
    await page.click('#dpSave');
    expect(errors).toEqual([]);
  });
});

test.describe('Informe de avance', () => {
  async function seedActivity(page) {
    await page.evaluate(async () => {
      const iso = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d.toISOString(); };
      const day = n => localDateISO(new Date(iso(n)));
      const now = new Date().toISOString();
      const cols = await db.kanbanColumns.orderBy('order').toArray();
      const base = { status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now };
      const doneCol = cols[cols.length - 1];                       // la última columna cuenta como «terminado»
      const alfa = await db.projects.add({ ...base, title: 'Paper Alfa', type: 'Paper', columnId: cols[0].id });
      const beta = await db.projects.add({ ...base, title: 'Tesis Beta', type: 'Tesis', columnId: doneCol.id, columnHistory: [{ colId: doneCol.id, enteredAt: iso(-2), exitedAt: null }], submittedAt: day(-3), targetVenue: 'Revista X' });
      await db.projects.add({ ...base, title: 'Vieja', type: 'Paper', columnId: doneCol.id, columnHistory: [{ colId: doneCol.id, enteredAt: iso(-400), exitedAt: null }] });
      const mk = async (title, d, projectId, done = true) => { const id = await Tasks.add({ title, projectId }); await db.tasks.update(id, { done, doneAt: done ? iso(d) : null }); };
      await mk('Escribir intro', -1, alfa); await mk('Figuras', -2, alfa); await mk('Reunir datos', -3, beta); await mk('Muy antigua', -200, alfa); await mk('Pendiente', 0, alfa, false);
      await db.meetings.add({ title: 'Comité de tesis', date: day(-4), participants: '', projectId: beta, agreements: '', actionItems: [{ id: 1, text: 'Enviar capítulo 2', done: true, doneAt: iso(-1) }, { id: 2, text: 'Abierta', done: false }], createdAt: now, updatedAt: now });
      await db.meetings.add({ title: 'Futura', date: day(+5), participants: '', projectId: alfa, agreements: '', actionItems: [], createdAt: now, updatedAt: now });
      await db.references.add({ title: 'Un buen artículo', authors: 'Pérez, J.', year: 2020, readStatus: 'read', readAt: iso(-2), createdAt: now, updatedAt: now });
      await db.references.add({ title: 'Leído hace mucho', authors: 'Soto, L.', year: 2010, readStatus: 'read', readAt: iso(-300), createdAt: now, updatedAt: now });
      await db.ideas.add({ title: 'Idea nueva', content: '', status: 'unread', projectId: null, projectIds: [], tags: [], subtasks: [], createdAt: iso(-1), updatedAt: iso(-1) });
    });
  }

  test('buildReport reúne solo lo ocurrido dentro del periodo', async ({ page }) => {
    await openApp(page);
    await seedActivity(page);
    const r = await page.evaluate(() => { return buildReport(addDaysISO(-10), localDateISO()); });
    expect(r.tasks.map(t => t.title).sort()).toEqual(['Escribir intro', 'Figuras', 'Reunir datos']);
    expect(r.actions.map(a => a.title)).toEqual(['Enviar capítulo 2']);
    expect(r.meetings.map(m => m.title)).toEqual(['Comité de tesis']);              // la reunión futura no cuenta
    expect(r.read.map(x => x.title)).toEqual(['Un buen artículo']);
    expect(r.finished.map(p => p.title)).toEqual(['Tesis Beta']);
    expect(r.submitted.map(p => p.title)).toEqual(['Tesis Beta']);
    expect(r.newIdeas).toBe(1);
  });

  test('la vista muestra métricas, cambia de periodo y exporta Markdown', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'los permisos de portapapeles de Playwright solo existen en Chromium');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    await seedActivity(page);
    await gotoView(page, 'report');
    await page.fill('#rpFrom', await page.evaluate(() => addDaysISO(-10)));
    await page.press('#rpFrom', 'Tab');
    await expect(page.locator('.rp-tile').first().locator('.rp-n')).toHaveText('4');          // 3 tareas + 1 acuerdo
    await expect(page.locator('.rp-sec', { hasText: 'Tareas completadas' })).toContainText('Escribir intro');
    await expect(page.locator('.rp-sec', { hasText: 'Tareas completadas' })).not.toContainText('Muy antigua');
    await expect(page.locator('.rp-sec', { hasText: 'Lecturas' })).toContainText('Un buen artículo');
    // Markdown
    await page.click('#rpCopy');
    const md = await page.evaluate(() => navigator.clipboard.readText());
    expect(md).toContain('# Informe de avance —');
    expect(md).toMatch(/\*\*Resumen:\*\* 4 tareas completadas · 1 proyecto terminado · 1 envío · 1 reunión · 1 lectura · 1 idea nueva\./);
    expect(md).toContain('### Paper Alfa');
    expect(md).toContain('- [x] Escribir intro');
    expect(md).toContain('## Envíos');
    expect(md).toContain('Tesis Beta → Revista X');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rpDownload')]);
    expect(dl.suggestedFilename()).toMatch(/^informe-avance-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.md$/);
    // presets
    await page.click('[data-rp="lastMonth"]');
    await expect(page.locator('.read-chip.active')).toHaveText('Mes pasado');
  });

  test('sin actividad lo dice y los títulos con HTML se escapan', async ({ page }) => {
    const { errors } = await openApp(page);
    await gotoView(page, 'report');
    await expect(page.locator('.report-view .empty-state')).toContainText('Sin actividad');
    await page.evaluate(async () => { const id = await Tasks.add({ title: '<img src=x onerror=window.__pwn=1>' }); await Tasks.setDone(id, true); });
    await gotoView(page, 'dashboard'); await gotoView(page, 'report');
    await expect(page.locator('.rp-sec', { hasText: 'Tareas completadas' })).toContainText('<img src=x');
    expect(await page.evaluate(() => window.__pwn)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('presets de fechas: lunes de esta semana, mes anterior y año', async ({ page }) => {
    await openApp(page);
    const p = await page.evaluate(() => reportPresets(new Date('2026-10-31T12:00:00')));        // sábado
    expect(p.week).toMatchObject({ from: '2026-10-26', to: '2026-10-31' });
    expect(p.lastWeek).toMatchObject({ from: '2026-10-19', to: '2026-10-25' });
    expect(p.month).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(p.lastMonth).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(p.year).toMatchObject({ from: '2026-01-01', to: '2026-10-31' });
    expect(p.quarter.from).toBe('2026-08-03');
    expect(p.last30).toMatchObject({ from: '2026-10-02', to: '2026-10-31' });
  });

  test('el informe abre en «Este mes», pero la primera semana del mes en «Últimos 30 días» (el día 1 «este mes» es un solo día)', async ({ page }) => {
    await openApp(page);
    const keys = await page.evaluate(() => ['2026-11-01', '2026-11-07', '2026-11-08', '2026-10-31', '2026-12-15'].map(d => reportDefaultKey(new Date(d + 'T12:00:00'))));
    expect(keys).toEqual(['last30', 'last30', 'month', 'month', 'month']);
    await page.evaluate(() => { App._report = null; });
    await gotoView(page, 'report');
    const key = await page.evaluate(() => App._report.key);
    expect(['month', 'last30']).toContain(key);
    expect(key).toBe(await page.evaluate(() => reportDefaultKey()));
  });
});

test.describe('Recordatorio diario', () => {
  const stub = page => page.addInitScript(() => {
    window.__notes = [];
    window.Notification = class { constructor(t, o) { window.__notes.push({ t, ...o }); } static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } };
  });

  test('avisa una vez al día, a partir de la hora, con lo que toca; no avisa sin tareas ni desactivado', async ({ page }) => {
    await stub(page);
    await openApp(page);
    const at = (h, m) => page.evaluate(([h, m]) => Reminders.check(new Date(new Date().setHours(h, m, 0, 0))), [h, m]);
    await page.evaluate(() => { localStorage.removeItem('ros-remind-last'); Reminders.set({ on: true, time: '08:30' }); });
    expect(await at(9, 0)).toBe(false);                                                       // sin tareas: nada que avisar
    await page.evaluate(() => { localStorage.removeItem('ros-remind-last'); const t = localDateISO(); return Promise.all([Tasks.add({ title: 'Mandar el informe', due: addDaysISO(-1) }), Tasks.add({ title: 'Otra', due: t })]); });
    await page.evaluate(() => localStorage.removeItem('ros-remind-last'));
    expect(await at(8, 0)).toBe(false);                                                       // aún no es la hora
    expect(await at(8, 45)).toBe(true);
    expect(await at(9, 30)).toBe(false);                                                      // ya avisó hoy
    const notes = await page.evaluate(() => window.__notes);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toMatch(/2 por hacer \(1 atrasada\) — empieza por «Mandar el informe»/);
    await page.evaluate(() => { localStorage.removeItem('ros-remind-last'); Reminders.disable(); });
    expect(await at(10, 0)).toBe(false);
  });

  test('los ajustes lo activan pidiendo permiso, y guardan hora y capacidad', async ({ page }) => {
    await stub(page);
    await openApp(page);
    await gotoView(page, 'settings');
    await openSettingsTab(page, 'prefs');
    await page.fill('#setRemindTime', '07:15');
    await page.locator('#setRemindOn').check();
    await expect(page.locator('.toast.success').last()).toContainText('Recordatorio activado');
    expect(await page.evaluate(() => Reminders.get())).toMatchObject({ on: true, time: '07:15' });
    await page.locator('#setRemindOn').uncheck();
    expect(await page.evaluate(() => Reminders.get().on)).toBe(false);
  });
});
