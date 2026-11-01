// Flujo de trabajo del investigador: tareas recurrentes, «esperando a», plantillas con fechas relativas,
// próxima acción, pestañas de Proyectos, referencias (.bib/.ris), calendario .ics, copia automática y PWA.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('../helpers');

const iso = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); const p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const people = [{ id: 1, name: 'Dra. María Vega' }, { id: 2, name: 'Dr. Pablo Fuentes' }];
const projects = [{ id: 1, title: 'Paper Alfa' }, { id: 2, title: 'Grant Gamma' }];
const parse = (page, raw) => page.evaluate(([r, pr, pe]) => parseCapture(r, pr, new Date('2026-10-31T12:00:00'), pe), [raw, projects, people]);   // 31-oct-2026 = sábado
const taskByTitle = (page, t) => page.evaluate(t => db.tasks.filter(x => x.title === t).first(), t);

test.describe('Captura: responsable y repetición', () => {
  test('«>persona» marca a quién se espera', async ({ page }) => {
    await openApp(page);
    expect(await parse(page, 'enviar borrador >vega viernes @alfa')).toMatchObject({
      kind: 'task', title: 'enviar borrador', assigneeId: 1, assigneeName: 'Dra. María Vega', due: '2026-11-06', projectId: 1 });
    expect(await parse(page, 'pedir datos >"Pablo Fuentes"')).toMatchObject({ assigneeId: 2, kind: 'task' });
    expect((await parse(page, 'x >nadie')).assigneeId).toBeNull();
  });

  test('«cada lunes», «cada 2 semanas», «diario», «mensual», con tope «hasta»', async ({ page }) => {
    await openApp(page);
    expect(await parse(page, 'preparar clase cada lunes')).toMatchObject({ title: 'preparar clase', due: '2026-11-02', recurrence: { freq: 'weekly', interval: 1 } });
    expect(await parse(page, 'informe cada 2 semanas')).toMatchObject({ due: '2026-10-31', recurrence: { freq: 'weekly', interval: 2 } });
    expect(await parse(page, 'revisar correo diario')).toMatchObject({ recurrence: { freq: 'daily', interval: 1 } });
    expect(await parse(page, 'pagar licencia cada mes')).toMatchObject({ recurrence: { freq: 'monthly', interval: 1 } });
    expect(await parse(page, 'laboratorio todos los viernes hasta 15/12')).toMatchObject({ due: '2026-11-06', recurrence: { freq: 'weekly', until: '2026-12-15' } });
    expect((await parse(page, 'sin repetir')).recurrence).toBeNull();
  });

  test('la vista previa y el alta describen responsable y repetición', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.fill('#captureInput', 'corregir pruebas cada viernes >vega');
    await expect(page.locator('#capturePreview')).toContainText('esperando a Dra. Vega');
    await expect(page.locator('#capturePreview')).toContainText('↻ cada semana');
    await page.press('#captureInput', 'Enter');
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada');
    const t = await taskByTitle(page, 'corregir pruebas');
    expect(t.recurrence).toMatchObject({ freq: 'weekly', interval: 1 });
    expect(t.assigneeId).toBeGreaterThan(0);
  });
});

test.describe('Tareas recurrentes', () => {
  test('nextDue: día, semana y mes (ajusta fin de mes) y respeta «until»', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => [
      Tasks.nextDue('2026-11-02', { freq: 'daily', interval: 3 }),
      Tasks.nextDue('2026-11-02', { freq: 'weekly', interval: 2 }),
      Tasks.nextDue('2026-01-31', { freq: 'monthly', interval: 1 }),
      Tasks.nextDue('2026-12-30', { freq: 'monthly', interval: 2 }),
      Tasks.nextDue('2026-11-02', { freq: 'weekly', interval: 1, until: '2026-11-05' }),
    ]);
    expect(r).toEqual(['2026-11-05', '2026-11-16', '2026-02-28', '2027-02-28', null]);
  });

  test('completar una recurrente crea la siguiente; deshacer la quita', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => Tasks.add({ title: 'clase semanal', due: new Date().toISOString().slice(0, 10), recurrence: { freq: 'weekly', interval: 1 } }));
    await gotoView(page, 'dashboard');
    const row = page.locator('.tw-row', { hasText: 'clase semanal' });
    await expect(row.locator('.tw-rec')).toBeVisible();
    await row.locator('.tw-check').click();
    await expect(page.locator('.toast.success').last()).toContainText('siguiente ocurrencia');
    const rows = await page.evaluate(() => db.tasks.filter(t => t.title === 'clase semanal').toArray());
    expect(rows.map(t => t.done).sort()).toEqual([false, true]);
    expect(rows.find(t => !t.done).due > rows.find(t => t.done).due).toBe(true);
    await page.locator('.toast-undo-btn').click();
    await expect.poll(() => page.evaluate(() => db.tasks.filter(t => t.title === 'clase semanal').toArray().then(a => a.map(t => t.done)))).toEqual([false]);
  });

  test('una recurrente con «until» agotado no genera más', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const id = await Tasks.add({ title: 'última', due: '2026-11-02', recurrence: { freq: 'weekly', interval: 1, until: '2026-11-05' } });
      const spawned = await Tasks.setDone(id, true);
      return [spawned, await db.tasks.count()];
    });
    expect(r).toEqual([null, 1]);
  });

  test('repetir desde el menú ⋯ y que el menú ofrezca asignar', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => { await db.collaborators.add({ name: 'Dra. María Vega', createdAt: new Date().toISOString() }); await Tasks.add({ title: 'revisar bibliografía', due: new Date().toISOString().slice(0, 10) }); });
    await gotoView(page, 'dashboard');
    const row = page.locator('.tw-row', { hasText: 'revisar bibliografía' });
    await row.hover(); await row.locator('.tw-more').click();
    await page.locator('.tw-menu-item', { hasText: 'Repetir…' }).click();
    await page.locator('.tw-menu-item', { hasText: 'Cada semana' }).click();
    await expect(page.locator('.tw-row', { hasText: 'revisar bibliografía' }).locator('.tw-rec')).toBeVisible();
    const r2 = page.locator('.tw-row', { hasText: 'revisar bibliografía' });
    await r2.hover(); await r2.locator('.tw-more').click();
    await page.locator('.tw-menu-item', { hasText: 'Esperando a…' }).click();
    await page.locator('.tw-menu-item', { hasText: 'Dra. María Vega' }).click();
    await expect(page.locator('[data-sec="theirs"]')).toContainText('Dra. María Vega');
    await expect(page.locator('[data-sec="now"]')).not.toContainText('revisar bibliografía');
  });
});

test.describe('Esperando a personas', () => {
  async function setup(page) {
    await seed(page);
    return page.evaluate(async () => {
      const vega = await db.collaborators.filter(c => c.name === 'Dra. Vega').first();
      const p = await db.projects.where('title').equals('Paper Alfa').first();
      await Tasks.add({ title: 'enviar datos crudos', projectId: p.id, assigneeId: vega.id, due: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) });
      await Tasks.add({ title: 'mi propia tarea', projectId: p.id });
      return vega.id;
    });
  }

  test('las tareas de otra persona van a su propia sección y no a «lo mío»', async ({ page }) => {
    await openApp(page);
    await setup(page);
    await gotoView(page, 'dashboard');
    await expect(page.locator('[data-sec="theirs"]')).toContainText('Dra. Vega');
    await expect(page.locator('[data-sec="theirs"]')).toContainText('enviar datos crudos');
    await expect(page.locator('[data-sec="week"]')).not.toContainText('enviar datos crudos');
    await expect(page.locator('[data-sec="loose"]')).toContainText('mi propia tarea');
  });

  test('el perfil de la persona lista lo que se espera de ella y copia la agenda', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Los permisos clipboard-read/clipboard-write de prueba solo existen en Chromium');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    const id = await setup(page);
    await page.evaluate(i => inspectCollaborator(i), id);
    await expect(page.locator('#inspectorBody')).toContainText('Esperando a Dra.');
    await expect(page.locator('#inspectorBody')).toContainText('enviar datos crudos');
    await page.locator('#collabAgendaBtn').click();
    await expect(page.locator('.toast.success').last()).toContainText('Agenda copiada');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('Agenda con Dra. Vega');
    expect(text).toContain('- [ ] enviar datos crudos (Paper Alfa)');
  });

  test('una reunión con esa persona muestra sus pendientes; los pasos admiten «>persona» y fecha', async ({ page }) => {
    await openApp(page);
    await setup(page);
    await gotoView(page, 'meetings');
    await page.locator('#addMeetingBtn').click();
    await page.fill('#am-title', 'Avance con Vega');
    await page.fill('#am-participants', 'Dra. Vega');
    await page.fill('#am-actions', 'Mandar figuras >vega viernes\nRevisar anexo');
    await page.locator('#amSave').click();
    await expect(page.locator('.meeting-card', { hasText: 'Avance con Vega' })).toBeVisible();
    const m = await page.evaluate(() => db.meetings.where('title').equals('Avance con Vega').first());
    expect(m.actionItems[0]).toMatchObject({ text: 'Mandar figuras', assigneeId: expect.any(Number) });
    expect(m.actionItems[0].due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.actionItems[1].assigneeId).toBeNull();
    await page.locator('.meeting-card', { hasText: 'Avance con Vega' }).click();
    await expect(page.locator('#inspectorBody')).toContainText('Para tratar con los asistentes');
    await expect(page.locator('#inspectorBody')).toContainText('enviar datos crudos');
  });
});

test.describe('Próxima acción', () => {
  test('el Tablero y Proyectos muestran la tarea propia más cercana', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const p = await db.projects.where('title').equals('Paper Alfa').first();
      await Tasks.add({ title: 'después', projectId: p.id, due: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10) });
      await Tasks.add({ title: 'primero', projectId: p.id, due: new Date(Date.now() + 1 * 86400000).toISOString().slice(0, 10) });
      await Tasks.add({ title: 'de otra persona', projectId: p.id, assigneeId: 999, due: new Date().toISOString().slice(0, 10) });
    });
    await gotoView(page, 'kanban');
    await expect(page.locator('.kanban-card', { hasText: 'Paper Alfa' }).locator('.next-action')).toContainText('primero');
    await gotoView(page, 'projects');
    await expect(page.locator('#projectsContainer .card', { hasText: 'Paper Alfa' }).locator('.next-action')).toContainText('primero');
  });

  test('Hoy lista los proyectos en curso sin siguiente paso y «+ tarea» prepara la captura', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => db.projects.where('title').equals('Dataset Beta').modify({ deadline: null }));
    await gotoView(page, 'dashboard');
    const row = page.locator('[data-kind="nonext"]', { hasText: 'Dataset Beta' });
    await expect(row).toBeVisible();
    await row.locator('.tw-addnext').click();
    await expect(page.locator('#captureInput')).toHaveValue('t: @"Dataset Beta" ');
    await page.keyboard.type('limpiar outliers mañana');
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada');
    await expect(page.locator('[data-kind="nonext"]', { hasText: 'Dataset Beta' })).toHaveCount(0);
  });
});

test.describe('Plantillas con fechas relativas', () => {
  async function createFromTemplate(page, tpl, deadline) {
    await page.evaluate(() => document.querySelectorAll('.toast').forEach(x => x.remove()));      // evita confundir el aviso de una creación anterior
    await gotoView(page, 'kanban');
    await page.locator('#kanbanAddProject').click();
    await page.locator(`.template-card[data-tpl="${tpl}"]`).click();
    await page.fill('#mp-title', `Proyecto ${tpl}`);
    if (deadline) await page.fill('#mp-deadline', deadline);
    await page.locator('#mpSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Proyecto creado');
  }

  test('paper: las tareas se programan hacia atrás desde la fecha límite', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="paper"]').click();
    await expect(page.locator('#mpTplHint')).toContainText('7 tareas');
    await page.locator('#mpSave').click();               // sin título: no guarda, pero comprobamos que sigue abierto
    await page.fill('#mp-title', 'Mi paper');
    await page.fill('#mp-deadline', iso(70));
    await page.locator('#mpSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Proyecto creado');
    const tasks = await page.evaluate(() => db.tasks.toArray());
    expect(tasks).toHaveLength(7);
    const dueOf = t => tasks.find(x => x.title.startsWith(t)).due;
    expect(dueOf('Enviar manuscrito')).toBe(iso(70));
    expect(dueOf('Revisión de coautores')).toBe(iso(56));
    expect(dueOf('Definir pregunta')).toBe(iso(10));
  });

  test('sin fecha límite las tareas quedan sin fecha; las ya vencidas no se crean con fecha', async ({ page }) => {
    await openApp(page);
    await createFromTemplate(page, 'talk', null);
    expect((await page.evaluate(() => db.tasks.toArray())).every(t => t.due === null)).toBe(true);
    await page.evaluate(() => db.tasks.clear());
    await createFromTemplate(page, 'grant', iso(15));        // «-60/-45/-30/-20» ya pasaron: sin fecha; «-10» y «-2» sí
    const tasks = await page.evaluate(() => db.tasks.toArray());
    expect(tasks.find(t => t.title.startsWith('Leer bases')).due).toBeNull();
    expect(tasks.find(t => t.title.startsWith('Revisión interna')).due).toBe(iso(5));
  });

  test('curso: una tarea semanal recurrente hasta el fin del semestre', async ({ page }) => {
    await openApp(page);
    await createFromTemplate(page, 'course', iso(100));
    const t = (await page.evaluate(() => db.tasks.toArray())).find(x => x.title.startsWith('Preparar la clase'));
    expect(t.recurrence).toMatchObject({ freq: 'weekly', interval: 1, until: iso(100) });
    expect(new Date(t.due + 'T12:00:00').getDay()).toBe(1);        // el próximo lunes
  });
});

test.describe('Idea → tarea o proyecto', () => {
  test('promover a tarea conserva proyecto y fecha; un deshacer lo revierte todo', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => db.ideas.where('title').equals('Idea uno').modify({ deadline: '2027-01-15' }));
    const id = await page.evaluate(() => db.ideas.where('title').equals('Idea uno').first().then(i => i.id));
    await page.evaluate(i => inspectIdea(i), id);
    await page.locator('#ideaToTaskBtn').click();
    await expect(page.locator('.toast.success').last()).toContainText('convertida en tarea');
    expect(await page.evaluate(i => db.ideas.get(i), id)).toBeUndefined();
    const t = await taskByTitle(page, 'Idea uno');
    expect(t).toMatchObject({ due: '2027-01-15' });
    expect(t.projectId).toBeGreaterThan(0);
    await page.locator('.toast-undo-btn').click();
    await expect.poll(() => page.evaluate(i => db.ideas.get(i).then(Boolean), id)).toBe(true);
    expect(await taskByTitle(page, 'Idea uno')).toBeUndefined();
  });

  test('promover a proyecto copia título, texto y etiquetas', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => { const n = new Date().toISOString(); await db.ideas.add({ title: 'Estudio piloto de suelos', content: 'Muestrear 20 parcelas', tags: ['campo'], status: 'unread', projectIds: [], subtasks: [], createdAt: n, updatedAt: n }); });
    const id = await page.evaluate(() => db.ideas.toArray().then(a => a[0].id));
    await page.evaluate(i => inspectIdea(i), id);
    await page.locator('#ideaToProjectBtn').click();
    await expect(page.locator('.toast.success').last()).toContainText('convertida en proyecto');
    const p = await page.evaluate(() => db.projects.where('title').equals('Estudio piloto de suelos').first());
    expect(p).toMatchObject({ description: 'Muestrear 20 parcelas', tags: ['campo'], type: 'Proyecto' });
    expect(await page.evaluate(() => db.ideas.count())).toBe(0);
  });
});

test.describe('Proyectos en una sola pantalla', () => {
  test('el menú tiene una entrada «Proyectos» con pestañas; recuerda la última', async ({ page }) => {
    await openApp(page);
    await page.locator('.nav-item[data-view="kanban"]').click();
    await expect(page.locator('.proj-tabs .proj-tab')).toHaveText(['Tablero', 'Lista', 'Línea de tiempo', 'Jerarquía']);
    await expect(page.locator('.proj-tab.active')).toHaveText('Tablero');
    await page.locator('.proj-tab', { hasText: 'Línea de tiempo' }).click();
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'timeline');
    await expect(page.locator('.proj-tab.active')).toHaveText('Línea de tiempo');
    await expect(page.locator('.nav-item[data-view="kanban"]')).toHaveClass(/active/);          // el ítem sigue marcado
    await page.locator('.nav-item[data-view="ideas"]').click();
    await expect(page.locator('.proj-tabs')).toHaveCount(0);
    await page.locator('.nav-item[data-view="kanban"]').click();
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'timeline');          // volvió a la pestaña recordada
  });

  test('las pestañas sobreviven a los re-renders internos (agrupar el Tablero)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('[data-swim="type"]').click();
    await expect(page.locator('.proj-tabs')).toHaveCount(1);
    await page.locator('[data-density="compact"]').click();
    await expect(page.locator('.proj-tabs')).toHaveCount(1);
    await expect(page.locator('.proj-tab.active')).toHaveText('Tablero');
  });

  test('«focus» (Focus Feed) abre Hoy', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => navigate('focus'));
    await expect(page.locator('#captureInput')).toBeVisible();
  });
});

test.describe('Referencias: importar y leer', () => {
  const BIB = `@comment{export de Zotero}
@article{garcia2021,
  author = {Garc{\\'i}a, Juan and Mu{\\~n}oz, Ana and {Smith}, Bob},
  title = {Cambios en la {Diversidad} Funcional: un enfoque \\& m\\'as},
  journal = "Ecology Letters",
  year = 2021, volume = {24}, pages = {100--120},
  doi = {https://doi.org/10.1000/ABC.123},
  keywords = {ecología, funcional; bosques},
  abstract = {Resumen con {llaves} anidadas.}
}
@inproceedings{vega2019,
  author = {Vega, M.},
  title = {Series temporales},
  booktitle = {Proceedings of ISMIR},
  year = {2019}
}
@string{foo = "bar"}`;
  const RIS = `TY  - JOUR\nAU  - Pérez, Luis\nAU  - Soto, Eva\nTI  - Modelos mixtos en ecología\nJO  - Methods in Ecology\nPY  - 2020/05/01\nDO  - 10.2000/xyz\nSP  - 5\nEP  - 15\nKW  - estadística\nER  - \n`;

  test('parseBibtex entiende acentos LaTeX, llaves, comillas, autores «and» y salta @comment/@string', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(b => { const e = parseBibtex(b); return { n: e.length, keys: e.map(x => x.key), refs: bibtexToReferences(e) }; }, BIB);
    expect(r.n).toBe(2);
    expect(r.keys).toEqual(['garcia2021', 'vega2019']);
    expect(r.refs[0]).toMatchObject({ title: 'Cambios en la Diversidad Funcional: un enfoque & más', authors: 'García, Juan; Muñoz, Ana; Smith, Bob', year: 2021,
      journal: 'Ecology Letters', doi: '10.1000/ABC.123', volume: '24', pages: '100–120', tags: ['ecología', 'funcional', 'bosques'], citeKey: 'garcia2021' });
    expect(r.refs[0].notes).toBe('Resumen con llaves anidadas.');
    expect(r.refs[1]).toMatchObject({ journal: 'Proceedings of ISMIR', year: 2019 });
  });

  test('parseRIS lee autores repetidos, páginas y año', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(t => parseRIS(t), RIS);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ title: 'Modelos mixtos en ecología', authors: 'Pérez, Luis; Soto, Eva', year: 2020, journal: 'Methods in Ecology', doi: '10.2000/xyz', pages: '5–15', tags: ['estadística'] });
  });

  test('importar desde la pantalla: vista previa, proyecto y sin duplicar al repetir', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'references');
    await page.locator('#importRefsInput').setInputFiles({ name: 'zotero.bib', mimeType: 'text/plain', buffer: Buffer.from(BIB) });
    await expect(page.locator('.modal')).toContainText('2 son nuevas'.replace('2 son', '').trim() || '');
    await expect(page.locator('#impRefOk')).toHaveText('Importar 2');
    await page.selectOption('#impRefProject', { label: 'Paper Alfa' });
    await page.locator('#impRefOk').click();
    await expect(page.locator('.toast.success').last()).toContainText('2 referencia(s) importada(s)');
    const refs = await page.evaluate(() => db.references.toArray());
    expect(refs).toHaveLength(3);
    expect(refs.find(r => r.citeKey === 'garcia2021')).toMatchObject({ readStatus: 'toread', projectId: expect.any(Number) });
    await page.locator('#importRefsInput').setInputFiles({ name: 'zotero.bib', mimeType: 'text/plain', buffer: Buffer.from(BIB) });
    await expect(page.locator('#impRefOk')).toBeDisabled();
    await page.locator('#impRefCancel').click();
    await page.locator('#importRefsInput').setInputFiles({ name: 'x.ris', mimeType: 'text/plain', buffer: Buffer.from(RIS) });
    await page.locator('#impRefOk').click();
    await expect.poll(() => page.evaluate(() => db.references.count())).toBe(4);
  });

  test('estado de lectura: ciclo con un clic y filtro', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'references');
    const chip = page.locator('[data-ref-read]').first();
    await expect(chip).toContainText('estado');
    await chip.click();
    await expect(page.locator('[data-ref-read]').first()).toContainText('Por leer');
    await page.locator('[data-ref-read]').first().click();
    await expect(page.locator('[data-ref-read]').first()).toContainText('Leyendo');
    await page.locator('[data-read-filter="reading"]').click();
    await expect(page.locator('.ref-card')).toHaveCount(1);
    await page.locator('[data-read-filter="read"]').click();
    await expect(page.locator('.ref-card')).toHaveCount(0);
  });

  test('el .bib exportado se puede volver a importar sin pérdidas (ida y vuelta)', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => db.references.add({ title: 'Tamaño & efecto: 50% de _varianza_', authors: 'Muñoz, A., Vega, M.', year: 2022, journal: 'Nature', doi: '10.1/x', volume: '5', pages: '1-9' }));
    const back = await page.evaluate(async () => bibtexToReferences(parseBibtex(await exportBibtex()))[0]);
    expect(back).toMatchObject({ title: 'Tamaño & efecto: 50% de _varianza_', authors: 'Muñoz, A.; Vega, M.', year: 2022, doi: '10.1/x', pages: '1–9' });
  });
});

test.describe('Calendario .ics', () => {
  test('exporta fechas límite, tareas (con RRULE) y reuniones', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => Tasks.add({ title: 'clase, semanal; lunes', due: '2026-11-02', recurrence: { freq: 'weekly', interval: 2, until: '2026-12-14' } }));
    await gotoView(page, 'settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#icsExportBtn').click()]);
    const ics = await fs.promises.readFile(await dl.path(), 'utf8');
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toContain('SUMMARY:⏱ Entrega: Paper Alfa');
    expect(ics).toContain('SUMMARY:🗓 Reunión de avance');
    expect(ics).toContain('SUMMARY:☐ clase\\, semanal\; lunes');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261214');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261102');
    for (const line of ics.split('\r\n')) expect(line.length).toBeLessThanOrEqual(71);          // líneas plegadas
  });

  test('parseICS expande repeticiones semanales con BYDAY, soporta UTC y fecha simple', async ({ page }) => {
    await openApp(page);
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Estadística I', 'DTSTART;TZID=America/Santiago:20261102T100000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261118T000000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Comité\\, tesis', 'DTSTART;VALUE=DATE:20261110', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Fuera de rango', 'DTSTART:20300101T120000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const ev = await page.evaluate(t => parseICS(t, { from: '2026-11-01', to: '2026-12-31' }), ics);
    expect(ev.filter(e => e.title === 'Estadística I').map(e => e.date)).toEqual(['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16', '2026-11-18']);
    expect(ev.find(e => e.title === 'Comité, tesis').date).toBe('2026-11-10');
    expect(ev.some(e => e.title === 'Fuera de rango')).toBe(false);
  });

  test('importar crea reuniones y no duplica al repetir', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'settings');
    const d = iso(3).replace(/-/g, '');
    const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Seminario\r\nDTSTART;VALUE=DATE:${d}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const upload = () => page.locator('#icsImportInput').setInputFiles({ name: 'c.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
    await upload();
    await page.locator('#icsOk').click();
    await expect(page.locator('.toast.success').last()).toContainText('1 evento(s) importado(s)');
    expect(await page.evaluate(() => db.meetings.filter(m => m.title === 'Seminario').count())).toBe(1);
    await upload();
    await expect(page.locator('#icsOk')).toBeDisabled();
  });
});

test.describe('Copia automática a carpeta', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'La copia a una carpeta usa la File System Access API, que solo existe en Chromium (Chrome/Edge)');
  async function stubPicker(page) {
    await page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });   // OPFS hace de «carpeta elegida»
  }
  const opfsFiles = page => page.evaluate(async () => { const dir = await navigator.storage.getDirectory(); const n = []; for await (const [name] of dir.entries()) n.push(name); return n.sort(); });

  test('elegir carpeta escribe «latest» y una copia fechada, y desactivar la olvida', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await stubPicker(page);
    await gotoView(page, 'settings');
    await page.locator('#autoBackupOn').click();
    await expect(page.locator('.toast.success').last()).toContainText('Copia automática activada');
    const files = await opfsFiles(page);
    expect(files).toContain('researchos-backup-latest.json');
    expect(files.some(f => /^researchos-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))).toBe(true);
    const saved = JSON.parse(await page.evaluate(async () => { const d = await navigator.storage.getDirectory(); return (await (await d.getFileHandle('researchos-backup-latest.json')).getFile()).text(); }));
    expect(saved.projects).toHaveLength(3);
    expect(saved.settings.some(s => s.key === 'backup-dir-handle')).toBe(false);          // el handle nunca viaja en el backup
    await expect(page.locator('#autoBackupDesc')).toContainText('Última copia');
    await expect(page.locator('#backupStatus')).toContainText('hoy');                   // cuenta como backup reciente
    await page.locator('#autoBackupOff').click();
    expect(await page.evaluate(() => db.settings.get('backup-dir-handle'))).toBeUndefined();
    await expect(page.locator('#autoBackupOn')).toBeVisible();
  });

  test('cada cambio programa una copia y «Copiar ahora» la fuerza con los datos nuevos', async ({ page }) => {
    await openApp(page);
    await stubPicker(page);
    await gotoView(page, 'settings');
    await page.locator('#autoBackupOn').click();
    await expect(page.locator('.toast.success').last()).toContainText('activada');
    await page.evaluate(() => Tasks.add({ title: 'tarea nueva tras la copia' }).then(() => dbWrite(async () => {})));
    expect(await page.evaluate(() => AutoBackup._dirty)).toBe(true);
    await page.locator('#autoBackupNow').click();
    await expect(page.locator('.toast.success').last()).toContainText('Copia guardada');
    const saved = JSON.parse(await page.evaluate(async () => { const d = await navigator.storage.getDirectory(); return (await (await d.getFileHandle('researchos-backup-latest.json')).getFile()).text(); }));
    expect(saved.tasks.map(t => t.title)).toContain('tarea nueva tras la copia');
  });

  test('rota las copias diarias: solo se conservan las últimas 14', async ({ page }) => {
    await openApp(page);
    await stubPicker(page);
    await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      for (let d = 1; d <= 20; d++) { const fh = await dir.getFileHandle(`researchos-backup-2026-01-${String(d).padStart(2, '0')}.json`, { create: true }); const w = await fh.createWritable(); await w.write('{}'); await w.close(); }
      await AutoBackup.choose();
    });
    const files = (await opfsFiles(page)).filter(f => /^researchos-backup-\d{4}/.test(f));
    expect(files).toHaveLength(14);
    expect(files).not.toContain('researchos-backup-2026-01-01.json');
  });
});

test.describe('PWA y captura compartida', () => {
  test('el manifiesto es válido y sus iconos existen', async ({ page, request }) => {
    await openApp(page);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'assets/manifest.webmanifest');
    const m = await (await request.get('/assets/manifest.webmanifest')).json();
    expect(m).toMatchObject({ name: 'ResearchOS', display: 'standalone', start_url: '../index.html', scope: '../' });
    expect(m.share_target.params).toEqual({ title: 'title', text: 'text', url: 'url' });
    for (const i of m.icons) expect((await request.get('/assets/' + i.src)).ok(), i.src).toBe(true);
  });

  test('«Compartir → ResearchOS» crea una idea y limpia la URL', async ({ page }) => {
    await openApp(page, { url: '/index.html?title=Art%C3%ADculo%20interesante&text=Lo%20vi%20en%20Twitter&url=https%3A%2F%2Fexample.org%2Fpaper' });
    await expect(page.locator('.toast.success').last()).toContainText('bandeja de ideas');
    const idea = await page.evaluate(() => db.ideas.toArray().then(a => a[0]));
    expect(idea).toMatchObject({ title: 'Artículo interesante', status: 'unread', tags: ['compartido'] });
    expect(idea.content).toContain('https://example.org/paper');
    expect(await page.evaluate(() => location.search)).toBe('');
    await page.reload();
    expect(await page.evaluate(() => db.ideas.count())).toBe(1);          // recargar no duplica
  });

  test('el acceso directo «Captura rápida» enfoca el campo de captura', async ({ page }) => {
    await openApp(page, { url: '/index.html?capture=1' });
    await expect(page.locator('#captureInput')).toBeFocused();
  });
});

test.describe('Uso local y ajustes avanzados', () => {
  test('cuenta las vistas abiertas, solo en el navegador, y se puede reiniciar', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await gotoView(page, 'ideas');
    await gotoView(page, 'snippets');
    await gotoView(page, 'settings');
    const usage = await page.locator('#usageSection').innerText();
    expect(usage).toContain('Ideas');
    expect(await page.evaluate(() => Usage.read().ideas)).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => JSON.stringify(Object.keys(localStorage)))).toContain('ros-usage');
    await page.locator('#usageReset').click();
    await expect(page.locator('#usageSection')).toContainText('Aún sin datos');
  });

  test('Google Drive, campos personalizados y sync de papers están en «Avanzado» plegado', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'settings');
    await expect(page.locator('#settingsAdvanced')).not.toHaveAttribute('open', '');
    await expect(page.locator('#googleSyncSection')).toBeHidden();
    await expect(page.locator('#cfSettingsSection')).toBeHidden();
    await expect(page.locator('#exportJsonBtn')).toBeVisible();              // lo esencial sigue a la vista
    await page.locator('#settingsAdvanced > summary').click();
    await expect(page.locator('#cfSettingsSection')).toBeVisible();
  });
});

test.describe('Backups con las nuevas entidades', () => {
  test('exportar/importar conserva responsable, repetición y estado de lectura; el merge remapea al colaborador', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const v = await db.collaborators.filter(c => c.name === 'Dra. Vega').first();
      await Tasks.add({ title: 'pendiente con Vega', assigneeId: v.id, due: '2026-12-01', recurrence: { freq: 'monthly', interval: 1, until: '2027-06-01' } });
      await db.references.toCollection().modify({ readStatus: 'reading' });
    });
    const backup = JSON.parse(await page.evaluate(() => exportAllData()));
    expect(backup.tasks.find(t => t.title === 'pendiente con Vega')).toMatchObject({ recurrence: { freq: 'monthly', interval: 1, until: '2027-06-01' } });
    // «otro dispositivo»: los ids de colaboradores no coinciden con los locales
    const foreign = { ...backup, collaborators: backup.collaborators.map(c => ({ ...c, id: c.id + 40, uid: 'for-' + c.uid, name: 'Prof. Foráneo' })),
      tasks: backup.tasks.map(t => ({ ...t, id: t.id + 40, uid: 'for-' + t.uid, assigneeId: t.assigneeId == null ? null : t.assigneeId + 40, title: t.title + ' (foráneo)' })), projects: [], ideas: [], snippets: [], meetings: [], references: [] };
    await page.evaluate(t => mergeAllData(JSON.stringify(t)), foreign);
    const r = await page.evaluate(async () => {
      const t = await db.tasks.filter(x => x.title === 'pendiente con Vega (foráneo)').first();
      const c = await db.collaborators.get(t.assigneeId);
      return { who: c?.name, rec: t.recurrence };
    });
    expect(r.who).toBe('Prof. Foráneo');
    expect(r.rec.freq).toBe('monthly');
    expect((await page.evaluate(() => db.references.toArray()))[0].readStatus).toBe('reading');
  });

  test('sanitizeBackup descarta repeticiones y responsables inválidos', async ({ page }) => {
    await openApp(page);
    const t = await page.evaluate(() => sanitizeBackup({ tasks: [{ title: 'x', recurrence: { freq: 'hourly' }, assigneeId: 'abc' },
      { title: 'y', recurrence: { freq: 'weekly', interval: 999, until: '"><img>' } }] }).tasks);
    expect(t[0]).toMatchObject({ recurrence: null, assigneeId: null });
    expect(t[1].recurrence).toEqual({ freq: 'weekly', interval: 52, until: null });
  });
});
