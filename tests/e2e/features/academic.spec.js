// Vida académica: seguimiento de personas, clases y evaluaciones, respuesta a revisores, plantilla de grant e importación CSV.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, expect, openApp, gotoView, seed } = require('../helpers');

const mkCollab = (page, o) => page.evaluate(o => db.collaborators.add({ name: 'Ana', role: '', affiliation: '', email: '', notes: '', createdAt: new Date().toISOString(), ...o }), o);
const tmpFile = (name, content) => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ros-')), name); fs.writeFileSync(p, content); return p; };

test.describe('Nombres de personas', () => {
  test('sameName casa «vega», «Dra. Vega» y «María Vega», pero no apellidos distintos', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => [
      sameName('Dra. Vega', 'María Vega'), sameName('vega', 'Dra. María Vega'), sameName('María Vega', 'Maria  Vega'),
      sameName('Pablo Fuentes', 'María Vega'), sameName('Juan García', 'Juan Pérez'), sameName('', 'Vega'), sameName('al', 'Alberto López')]);
    expect(r).toEqual([true, true, true, false, false, false, false]);
  });
});

test.describe('Seguimiento de personas', () => {
  test('lastContactOf toma lo más reciente entre el contacto registrado y las reuniones ya ocurridas', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => {
      const c = { name: 'María Vega', lastContact: '2026-09-01' };
      const meetings = [{ title: 'Avance', date: '2026-10-05', participants: 'Dra. Vega, Pablo' }, { title: 'Futura', date: '2026-12-01', participants: 'María Vega' }, { title: 'Otra', date: '2026-10-20', participants: 'Pablo Fuentes' }];
      return [lastContactOf(c, meetings, '2026-10-31'), lastContactOf({ name: 'Nadie' }, meetings, '2026-10-31'), lastContactOf({ name: 'María Vega', lastContact: '2026-10-25' }, meetings, '2026-10-31')];
    });
    expect(r[0]).toMatchObject({ date: '2026-10-05', via: expect.stringContaining('Avance') });
    expect(r[1]).toBeNull();
    expect(r[2]).toMatchObject({ date: '2026-10-25', via: 'contacto' });
  });

  test('aparece en Hoy cuando toca, se puede registrar contacto o posponer, y desaparece', async ({ page }) => {
    await openApp(page);
    const old = await page.evaluate(() => addDaysISO(-20));
    const id = await mkCollab(page, { name: 'Tesista Luna', email: 'luna@uni.cl', followUpDays: 14, lastContact: old });
    await mkCollab(page, { name: 'Reciente', followUpDays: 14, lastContact: await page.evaluate(() => addDaysISO(-3)) });
    await mkCollab(page, { name: 'Sin cadencia', lastContact: old });
    await gotoView(page, 'dashboard');
    const sec = page.locator('[data-sec="followup"]');
    await expect(sec).toBeVisible();
    await expect(sec.locator('.fu-row')).toHaveCount(1);
    await expect(sec.locator('.fu-row')).toContainText('Tesista Luna');
    await expect(sec.locator('.fu-since')).toContainText('hace 20 d · cada 14 d');
    // correo con asunto y agenda
    const href = await sec.locator('[data-fu-act="mail"]').getAttribute('href');
    expect(href).toMatch(/^mailto:luna@uni\.cl\?subject=Agenda%20%C2%B7%20Tesista&body=/);
    expect(decodeURIComponent(href)).toContain('Agenda con Tesista Luna');
    // posponer una semana
    await sec.locator('[data-fu-act="snooze"]').click();
    await expect(page.locator('[data-sec="followup"]')).toHaveCount(0);
    expect((await page.evaluate(i => db.collaborators.get(i), id)).followSnoozeUntil).toBe(await page.evaluate(() => addDaysISO(7)));
    // vencida la pospuesta vuelve; «Contactado» registra hoy y la quita
    await page.evaluate(i => db.collaborators.update(i, { followSnoozeUntil: addDaysISO(-1) }), id);
    await gotoView(page, 'dashboard');
    await page.locator('[data-sec="followup"] [data-fu-act="done"]').click();
    await expect(page.locator('[data-sec="followup"]')).toHaveCount(0);
    const c = await page.evaluate(i => db.collaborators.get(i), id);
    expect(c.lastContact).toBe(await page.evaluate(() => localDateISO()));
    expect(c.followSnoozeUntil).toBeNull();
  });

  test('una reunión reciente con la persona cuenta como contacto; nunca contactada se mide desde que la registraste', async ({ page }) => {
    await openApp(page);
    await mkCollab(page, { name: 'María Vega', followUpDays: 14, createdAt: new Date(Date.now() - 40 * 86400000).toISOString() });
    await mkCollab(page, { name: 'Pedro Nuevo', followUpDays: 14, createdAt: new Date(Date.now() - 2 * 86400000).toISOString() });
    await mkCollab(page, { name: 'Olga Vieja', followUpDays: 30, createdAt: new Date(Date.now() - 50 * 86400000).toISOString() });
    await page.evaluate(() => db.meetings.add({ title: 'Reunión de avance', date: addDaysISO(-2), participants: 'Dra. Vega', projectId: null, agreements: '', actionItems: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    const f = await page.evaluate(() => followUps().then(l => l.map(x => [x.collab.name, x.last?.date ?? null, x.since])));
    expect(f.map(x => x[0])).toEqual(['Olga Vieja']);
    expect(f[0][1]).toBeNull();
    expect(f[0][2]).toBeGreaterThanOrEqual(50);
  });

  test('el inspector permite fijar la cadencia y registrar contacto; el correo se omite si el email es sospechoso', async ({ page }) => {
    await openApp(page);
    const id = await mkCollab(page, { name: 'Dr. Paz', email: 'paz@uni.cl' });
    const evil = await mkCollab(page, { name: 'Mala', email: 'a@b.cl?cc=otro@x.com&bcc=z@y.com' });
    await gotoView(page, 'collaborators');
    await page.evaluate(i => inspectCollaborator(i), id);
    await expect(page.locator('#collabLast')).toContainText('sin registro');
    await page.selectOption('#collabFollow', '30');
    await expect(page.locator('.toast.success').last()).toContainText('Seguimiento activado');
    expect((await page.evaluate(i => db.collaborators.get(i), id)).followUpDays).toBe(30);
    await page.click('#collabContactBtn');
    await expect(page.locator('#collabLast')).toContainText('contacto');
    await expect(page.locator('#collabMailBtn')).toHaveAttribute('href', /^mailto:paz@uni\.cl\?subject=/);
    await page.evaluate(i => inspectCollaborator(i), evil);
    await expect(page.locator('#collabFollow')).toBeVisible();
    await expect(page.locator('#collabMailBtn')).toHaveCount(0);
  });

  test('el backup conserva y sanea la cadencia', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => sanitizeBackup({ collaborators: [{ id: 1, name: 'A', followUpDays: 14, lastContact: '2026-10-01' }, { id: 2, name: 'B', followUpDays: 999, lastContact: 'ayer', followSnoozeUntil: '<x>' }] }).collaborators.map(c => [c.followUpDays, c.lastContact, c.followSnoozeUntil ?? null]));
    expect(r).toEqual([[14, '2026-10-01', null], [null, null, null]]);
  });
});

test.describe('Docencia', () => {
  test('generateClassDates y parseSkipDates', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => ({
      lw: generateClassDates({ weekdays: [1, 3], from: '2026-11-02', to: '2026-11-18' }),
      skip: generateClassDates({ weekdays: [1, 3], from: '2026-11-02', to: '2026-11-18', skip: ['2026-11-04', '2026-11-16'] }),
      none: [generateClassDates({ weekdays: [], from: '2026-11-02', to: '2026-11-18' }), generateClassDates({ weekdays: [1], from: '2026-11-18', to: '2026-11-02' }), generateClassDates({ weekdays: [1], from: 'x', to: '2026-11-02' })],
      cap: generateClassDates({ weekdays: [0, 1, 2, 3, 4, 5, 6], from: '2026-01-01', to: '2030-01-01' }).length,
      parse: parseSkipDates('2026-11-02, 16/11, 20-12-2026; 31/02, nada', 2026),
    }));
    expect(r.lw).toEqual(['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16', '2026-11-18']);
    expect(r.skip).toEqual(['2026-11-02', '2026-11-09', '2026-11-11', '2026-11-18']);
    expect(r.none).toEqual([[], [], []]);
    expect(r.cap).toBe(200);
    expect(r.parse).toEqual(['2026-11-02', '2026-11-16', '2026-12-20']);
  });

  test('curso: generar clases crea reuniones en el calendario, sin duplicar al repetir', async ({ page }) => {
    await openApp(page);
    const cols = await page.evaluate(() => db.kanbanColumns.orderBy('order').toArray());
    const id = await page.evaluate(c => db.projects.add({ title: 'Ecología I', type: 'Curso', columnId: c, status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), cols[0].id);
    await gotoView(page, 'projects');
    await page.evaluate(i => inspectProject(i), id);
    await expect(page.locator('#acadClasses')).toBeVisible();
    await expect(page.locator('#acadReview')).toHaveCount(0);
    await page.click('#acadClasses');
    await page.fill('#gc-from', '2026-11-02'); await page.fill('#gc-to', '2026-11-18');
    await page.fill('#gc-skip', '16/11');
    await expect(page.locator('#gc-count')).toContainText('5 clases');
    await page.locator('.gc-day input[value="3"]').uncheck();
    await expect(page.locator('#gc-count')).toContainText('2 clases');
    await page.locator('.gc-day input[value="3"]').check();
    await page.fill('#gc-title', 'Sesión {n}');
    await page.click('#gcSave');
    await expect(page.locator('.toast.success').last()).toContainText('5 clases creadas');
    const ms = await page.evaluate(i => db.meetings.where('projectId').equals(i).sortBy('date'), id);
    expect(ms.map(m => [m.date, m.title, m.kind])).toEqual([
      ['2026-11-02', 'Sesión 1', 'class'], ['2026-11-04', 'Sesión 2', 'class'], ['2026-11-09', 'Sesión 3', 'class'], ['2026-11-11', 'Sesión 4', 'class'], ['2026-11-18', 'Sesión 5', 'class']]);
    // repetir con las mismas fechas no duplica
    await page.click('#acadClasses');
    await page.fill('#gc-from', '2026-11-02'); await page.fill('#gc-to', '2026-11-18'); await page.fill('#gc-skip', '16/11');
    await page.click('#gcSave');
    await expect(page.locator('.toast').last()).toContainText('ya existían');
    expect(await page.evaluate(i => db.meetings.where('projectId').equals(i).count(), id)).toBe(5);
  });

  test('curso: «+ Evaluación» crea la evaluación y su corrección con tiempo estimado', async ({ page }) => {
    await openApp(page);
    const cols = await page.evaluate(() => db.kanbanColumns.orderBy('order').toArray());
    const id = await page.evaluate(c => db.projects.add({ title: 'Ecología I', type: 'Curso', columnId: c, status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), cols[0].id);
    await gotoView(page, 'projects');
    await page.evaluate(i => inspectProject(i), id);
    await page.click('#acadEval');
    await page.fill('#ev-name', 'Certamen 1'); await page.fill('#ev-date', '2026-12-01'); await page.fill('#ev-days', '10'); await page.fill('#ev-hours', '4.5');
    await page.click('#evSave');
    await expect(page.locator('.toast.success').last()).toContainText('Evaluación y corrección creadas');
    const ts = await page.evaluate(() => db.tasks.toArray());
    expect(ts.find(t => t.title === 'Evaluación: Certamen 1')).toMatchObject({ due: '2026-12-01', projectId: id, priority: 'Alta' });
    expect(ts.find(t => t.title === 'Corregir Certamen 1 y subir notas')).toMatchObject({ due: '2026-12-11', effort: 270, projectId: id });
  });
});

test.describe('Respuesta a revisores', () => {
  test('parseReviewerComments: numeración, viñetas, párrafos y líneas continuadas', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => ({
      num: parseReviewerComments('Reviewer 1\n1. The sample size is small.\n   Please justify it.\n2) Clarify the model.\n\n3. Typos.'),
      rn: parseReviewerComments('R1: Falta el análisis de poder.\nR2: Revisar las figuras.'),
      bullets: parseReviewerComments('- Primer punto\n- Segundo punto'),
      paras: parseReviewerComments('Primer comentario largo\ncontinúa aquí.\n\nSegundo comentario.'),
      empty: parseReviewerComments('  \n \n'),
      md: reviewerResponseMarkdown(['A', 'Bb'], 'Mi paper'),
    }));
    expect(r.num).toEqual(['The sample size is small. Please justify it.', 'Clarify the model.', 'Typos.']);
    expect(r.rn).toEqual(['Falta el análisis de poder.', 'Revisar las figuras.']);
    expect(r.bullets).toEqual(['Primer punto', 'Segundo punto']);
    expect(r.paras).toEqual(['Primer comentario largo continúa aquí.', 'Segundo comentario.']);
    expect(r.empty).toEqual([]);
    expect(r.md).toContain('# Respuesta a los revisores — Mi paper');
    expect(r.md).toContain('## Comentario 2\n> Bb');
  });

  test('un paper permite pegar la revisión y crear una tarea por comentario', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'los permisos de portapapeles de Playwright solo existen en Chromium');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    await seed(page);
    const id = await page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => p.id));
    await gotoView(page, 'projects');
    await page.evaluate(i => inspectProject(i), id);
    await page.click('#acadReview');
    await expect(page.locator('#rvSave')).toBeDisabled();
    await page.fill('#rv-text', '1. Aumentar la muestra.\n2. Explicar la selección del modelo.\n3. Corregir la figura 2.');
    await expect(page.locator('#rv-count')).toContainText('3 comentarios');
    await expect(page.locator('#rvSave')).toHaveText('Crear 3 tareas');
    await page.click('#rvCopy');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('## Comentario 3\n> Corregir la figura 2.');
    await page.fill('#rv-due', '2026-12-15');
    await page.click('#rvSave');
    await expect(page.locator('.toast.success').last()).toContainText('3 tareas creadas');
    const ts = (await page.evaluate(() => db.tasks.toArray())).filter(t => t.title.startsWith('Responder R'));
    expect(ts.map(t => t.title)).toEqual(['Responder R1: Aumentar la muestra.', 'Responder R2: Explicar la selección del modelo.', 'Responder R3: Corregir la figura 2.']);
    expect(ts.every(t => t.due === '2026-12-15' && t.projectId === id && t.priority === 'Alta')).toBe(true);
  });
});

test.describe('Plantilla «Ejecución de grant»', () => {
  test('crea tareas recurrentes (mensual, trimestral, semestral) hasta el término del proyecto', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="grantExec"]').click();
    await expect(page.locator('#mpTplHint')).toContainText('4 tareas');
    await page.fill('#mp-title', 'FONDECYT 1230456');
    const end = await page.evaluate(() => addDaysISO(900));
    await page.fill('#mp-deadline', end);
    await page.locator('#mpSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Proyecto creado');
    const ts = await page.evaluate(() => db.tasks.toArray());
    const by = t => ts.find(x => x.title.startsWith(t));
    expect(by('Revisar la ejecución')).toMatchObject({ recurrence: { freq: 'monthly', interval: 1, until: end }, effort: 45 });
    expect(by('Rendición de gastos').recurrence).toMatchObject({ freq: 'monthly', interval: 3 });
    expect(by('Informe de avance').recurrence).toMatchObject({ freq: 'monthly', interval: 6 });
    expect(by('Informe final')).toMatchObject({ due: end, recurrence: null, effort: 300 });
    expect(by('Informe de avance').due).toBe(await page.evaluate(() => addDaysISO(150)));
  });
});

test.describe('Importar tareas desde CSV', () => {
  test('parseCSVTable: comillas, saltos de línea, delimitadores y BOM', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => ({
      a: parseCSVTable('﻿title,due\n"Hola, mundo","dijo ""x"""\n"línea\ndoble",2026-01-01\n'),
      b: parseCSVTable('Tarea;Fecha\r\nUno;31/10/2026\r\nDos;'),
      c: parseCSVTable('a\tb\n1\t2'),
      d: parseCSVTable(''),
    }));
    expect(r.a).toEqual([['title', 'due'], ['Hola, mundo', 'dijo "x"'], ['línea\ndoble', '2026-01-01']]);
    expect(r.b).toEqual([['Tarea', 'Fecha'], ['Uno', '31/10/2026'], ['Dos', '']]);
    expect(r.c).toEqual([['a', 'b'], ['1', '2']]);
    expect(r.d).toEqual([]);
  });

  test('tasksFromCSV entiende Todoist, Notion y Excel en español', async ({ page }) => {
    await openApp(page);
    const projects = [{ id: 7, title: 'Paper Alfa' }];
    const r = await page.evaluate(p => ({
      todoist: tasksFromCSV('TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,DATE,RESPONSIBLE\nsection,Mi sección,,4,1,,\ntask,Enviar borrador,,1,1,2026-11-05,\ntask,Leer paper,,3,1,"Nov 10 2026",\nnote,Una nota,,,,,\n', p),
      notion: tasksFromCSV('Name,Status,Due,Project\nRevisar figuras,Done,"October 31, 2026",Paper Alfa\nEscribir métodos,Not started,,Otro', p),
      excel: tasksFromCSV('Tarea;Fecha límite;Prioridad;Proyecto;Estado\nCorregir pruebas;15/11/2026;Alta;;\nLlamar a Ana;;baja;paper alfa;hecho\n;;;;\n', p),
      few: tasksFromCSV('solo encabezado', p),
    }), projects);
    expect(r.todoist.tasks.map(t => [t.title, t.due, t.priority])).toEqual([['Enviar borrador', '2026-11-05', 'Alta'], ['Leer paper', '2026-11-10', 'Baja']]);
    expect(r.todoist.skipped).toBe(2);
    expect(r.notion.tasks).toMatchObject([{ title: 'Revisar figuras', done: true, due: '2026-10-31', projectId: 7 }, { title: 'Escribir métodos', done: false, due: null, projectId: null, projectName: 'Otro' }]);
    expect(r.excel.tasks).toMatchObject([{ title: 'Corregir pruebas', due: '2026-11-15', priority: 'Alta' }, { title: 'Llamar a Ana', priority: 'Baja', done: true, projectId: 7 }]);
    expect(r.excel.skipped).toBe(0);                     // las filas totalmente vacías ni se cuentan
    expect(r.few.tasks).toEqual([]);
  });

  test('Ajustes: vista previa y alta de tareas (con completadas opcionales); los títulos con HTML se escapan', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'settings');
    const file = tmpFile('tareas.csv', 'Tarea,Fecha,Proyecto,Estado\nRedactar resumen,2026-12-01,Paper Alfa,\nYa lista,,,hecho\n"<img src=x onerror=window.__pwn=1>",,,\n');
    await page.setInputFiles('#taskCsvInput', file);
    await expect(page.locator('#modalContent')).toContainText('3 tarea(s): 2 pendientes, 1 ya hechas · 1 enlazadas');
    await expect(page.locator('.import-preview')).toContainText('<img src=x');
    expect(await page.evaluate(() => window.__pwn)).toBeUndefined();
    await page.locator('#tiDone').uncheck();
    await page.click('#tiOk');
    await expect(page.locator('.toast.success').last()).toContainText('2 tarea(s) importada(s)');
    const ts = await page.evaluate(() => db.tasks.toArray());
    expect(ts.find(t => t.title === 'Redactar resumen')).toMatchObject({ due: '2026-12-01', done: false });
    expect(ts.find(t => t.projectId && t.title === 'Redactar resumen').projectId).toBeGreaterThan(0);
    expect(ts.find(t => t.title === 'Ya lista')).toBeUndefined();
    // segunda importación con completadas
    await page.setInputFiles('#taskCsvInput', tmpFile('t2.csv', 'Tarea,Estado\nYa lista,hecho\n'));
    await page.click('#tiOk');
    await expect(page.locator('.toast.success').last()).toContainText('1 tarea(s) importada(s)');
    expect((await page.evaluate(() => db.tasks.filter(t => t.title === 'Ya lista').first())).done).toBe(true);
    // archivo sin tareas
    await page.setInputFiles('#taskCsvInput', tmpFile('vacio.csv', 'a,b\n'));
    await expect(page.locator('.toast').last()).toContainText('No encontré tareas');
    expect(errors).toEqual([]);
  });
});
