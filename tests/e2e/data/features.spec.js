// Mejoras añadidas tras la revisión inicial: importación robusta, CSV, borrado en cascada, sanitizador,
// accesibilidad, avisos de backup y modo sin conexión.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('../helpers');

const DAY = 86400000;
const emptyBackup = extra => ({ _app: 'ResearchOS', _version: 3, projects: [], ideas: [], snippets: [], resources: [], collaborators: [],
  kanbanColumns: [], snippetCollections: [], submissions: [], meetings: [], references: [], settings: [], ...extra });

async function importText(page, backup, mode = 'merge') {
  await gotoView(page, 'settings');
  await page.locator('#importJsonInput').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.locator(mode === 'replace' ? '#importOptReplace' : '#importOptMerge').click();
  await page.locator('#importModeOk').click();
  if (mode === 'replace') await page.locator('#confirmYes').click();
}

test.describe('Importación: merge sin pérdidas', () => {
  test('reimportar el mismo backup no duplica nada', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const backup = JSON.parse(await page.evaluate(() => exportAllData()));
    await importText(page, backup, 'merge');
    await expect(page.locator('.toast.success').last()).toContainText('0 registro(s) nuevo(s)');
    await expect(page.locator('.toast.success').last()).toContainText('ya existía');
    expect(await page.evaluate(async () => [await db.projects.count(), await db.ideas.count(), await db.meetings.count()])).toEqual([3, 2, 1]);
  });

  test('registros de otro dispositivo con ids que chocan reciben id nuevo y conservan sus relaciones', async ({ page }) => {
    await openApp(page);
    await seed(page);                                    // local: proyecto id 1 "Paper Alfa", etc.
    const now = '2026-01-01T00:00:00.000Z';
    const backup = emptyBackup({
      kanbanColumns: [{ id: 1, title: 'Ideación', order: 0, color: '#3b82f6' }, { id: 2, title: 'Revisión externa', order: 1, color: '#f59e0b' }],
      projects: [
        { id: 1, title: 'Foráneo padre', type: 'Paper', columnId: 2, priority: 'Alta', createdAt: now, updatedAt: now },
        { id: 2, title: 'Foráneo hijo', type: 'Dataset', columnId: 1, parentId: 1, priority: 'Baja', createdAt: now, updatedAt: now },
      ],
      ideas: [{ id: 1, title: 'Idea foránea', content: '', status: 'unread', projectId: 1, projectIds: [1], createdAt: now, updatedAt: now }],
      meetings: [{ id: 1, title: 'Reunión foránea', date: '2026-02-02', projectId: 2, actionItems: [], createdAt: now, updatedAt: now }],
    });
    await importText(page, backup, 'merge');
    await expect(page.locator('.toast.success').last()).toContainText('Importado (merge)');
    const r = await page.evaluate(async () => {
      const cols = await db.kanbanColumns.toArray();
      const padre = await db.projects.where('title').equals('Foráneo padre').first();
      const hijo  = await db.projects.where('title').equals('Foráneo hijo').first();
      const idea  = await db.ideas.where('title').equals('Idea foránea').first();
      const meet  = await db.meetings.where('title').equals('Reunión foránea').first();
      const local = await db.projects.where('title').equals('Paper Alfa').first();
      return { colTitles: cols.map(c => c.title), padreCol: cols.find(c => c.id === padre.columnId)?.title, hijoCol: cols.find(c => c.id === hijo.columnId)?.title,
               hijoParentOk: hijo.parentId === padre.id, padreIdChanged: padre.id !== 1, ideaOk: idea.projectId === padre.id && idea.projectIds[0] === padre.id,
               meetOk: meet.projectId === hijo.id, localIntact: local.id === 1 && local.title === 'Paper Alfa' };
    });
    expect(r.padreCol).toBe('Revisión externa');
    expect(r.hijoCol).toBe('Ideación');                      // "Ideación" ya existía: se reutiliza, no se duplica
    expect(r.colTitles.filter(t => t === 'Ideación')).toHaveLength(1);
    expect(r).toMatchObject({ hijoParentOk: true, padreIdChanged: true, ideaOk: true, meetOk: true, localIntact: true });
  });

  test('"Reemplazar" descarga antes una copia de los datos actuales', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const backup = emptyBackup({ projects: [{ id: 1, title: 'Solo este', columnId: 1, type: 'Paper', priority: 'Media' }] });
    await gotoView(page, 'settings');
    await page.locator('#importJsonInput').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.locator('#importOptReplace').click();
    await page.locator('#importModeOk').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#confirmYes').click()]);
    expect(dl.suggestedFilename()).toMatch(/^researchos-antes-de-reemplazar-\d{4}-\d{2}-\d{2}\.json$/);
    const saved = JSON.parse(await fs.promises.readFile(await dl.path(), 'utf8'));
    expect(saved.projects.map(p => p.title).sort()).toEqual(['Dataset Beta', 'Grant Gamma', 'Paper Alfa']);
    await expect(page.locator('.toast.success').last()).toContainText('Datos reemplazados');
  });

  test('un backup sin columnas no deja el Kanban inutilizable', async ({ page }) => {
    await openApp(page);
    await importText(page, emptyBackup({ ideas: [{ id: 1, title: 'x', status: 'unread' }] }), 'replace');
    await expect(page.locator('.toast.success').last()).toContainText('Datos reemplazados');
    expect(await page.evaluate(() => db.kanbanColumns.count())).toBe(6);
  });

  test('"Borrar todos los datos" descarga copia, vacía todo y restaura las columnas por defecto', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'settings');
    await page.locator('#clearAllBtn').click();
    await page.locator('#confirmInput').fill('BORRAR');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#confirmYes').click()]);
    expect(dl.suggestedFilename()).toContain('antes-de-borrar');
    await expect.poll(() => page.evaluate(() => db.projects.count())).toBe(0);
    expect(await page.evaluate(() => db.kanbanColumns.count())).toBe(6);
  });

  test('sanitizeBackup rechaza basura y normaliza tipos peligrosos', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => {
      const fails = [null, [], 'x', 42, {}, { foo: 1 }].map(v => { try { sanitizeBackup(v); return false; } catch { return true; } });
      const ok = sanitizeBackup({ projects: [{ id: '7', title: 5, deadline: '"><x>', tags: 'no-array', archived: 1 }],
        snippets: [{ language: 'R"><b>' }], kanbanColumns: [{ color: 'red;background:url(x)' }] });
      return { fails, p: ok.projects[0], lang: ok.snippets[0].language, color: ok.kanbanColumns[0].color };
    });
    expect(r.fails).toEqual([true, true, true, true, true, true]);
    expect(r.p).toMatchObject({ id: 7, title: '5', deadline: null, tags: [], archived: true });
    expect(r.lang).toBe('Rb');
    expect(r.color).toBe('#38bdf8');
  });
});

test.describe('CSV', () => {
  test('acepta ";" (Excel es-CL), fechas dd/mm/aaaa y rechaza duplicados al reimportar', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'settings');
    const csv = '﻿title;type;priority;deadline;tags\nTesis cap. 3;Paper;alta;15/03/2027;a|b\nOtro;Dataset;baja;no-es-fecha;\n';
    const set = () => page.locator('#importCsvInput').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await set();
    await page.locator('#confirmCsvImport').click();
    await expect(page.locator('.toast.success').last()).toContainText('2 proyectos importados');
    const ps = await page.evaluate(() => db.projects.toArray());
    expect(ps.find(p => p.title === 'Tesis cap. 3')).toMatchObject({ deadline: '2027-03-15', priority: 'Alta', type: 'Paper', tags: ['a', 'b'] });
    expect(ps.find(p => p.title === 'Otro').deadline).toBeNull();
    await gotoView(page, 'settings');
    await set();
    await expect(page.locator('#csvPreviewArea')).toContainText('ya existen');
  });

  test('exportar e importar conserva columna y proyecto padre', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const p = await db.projects.where('title').equals('Paper Alfa').first();
      await db.projects.where('title').equals('Dataset Beta').modify({ parentId: p.id });
    });
    await gotoView(page, 'settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#exportCsvBtn').click()]);
    const csv = await fs.promises.readFile(await dl.path(), 'utf8');
    expect(csv).toContain('Limpieza de Datos');           // columna
    await page.evaluate(() => db.projects.clear());
    await page.locator('#importCsvInput').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.locator('#confirmCsvImport').click();
    await expect(page.locator('.toast.success').last()).toContainText('3 proyectos importados');
    const r = await page.evaluate(async () => {
      const cols = Object.fromEntries((await db.kanbanColumns.toArray()).map(c => [c.id, c.title]));
      const a = await db.projects.where('title').equals('Paper Alfa').first();
      const b = await db.projects.where('title').equals('Dataset Beta').first();
      return { colB: cols[b.columnId], parentOk: b.parentId === a.id, hist: b.columnHistory?.length };
    });
    expect(r).toEqual({ colB: 'Limpieza de Datos', parentOk: true, hist: 1 });
  });
});

test.describe('Borrado en cascada y deshacer', () => {
  test('eliminar un proyecto desvincula sus ideas/snippets y sube de nivel a los hijos; deshacer restaura todo', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const ids = await page.evaluate(async () => {
      const a = await db.projects.where('title').equals('Paper Alfa').first();
      const b = await db.projects.where('title').equals('Dataset Beta').first();
      await db.projects.update(b.id, { parentId: a.id });
      return { a: a.id, b: b.id };
    });
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
    await page.locator('#inspDeleteBtn').click();
    await expect.poll(() => page.evaluate(i => db.projects.get(i), ids.a)).toBeUndefined();
    const after = await page.evaluate(async b => ({
      hijo: (await db.projects.get(b)).parentId,
      idea: (await db.ideas.where('title').equals('Idea uno').first()).projectId,
      snip: (await db.snippets.toArray())[0].projectId,
      meet: (await db.meetings.toArray())[0].projectId,
      ref:  (await db.references.toArray())[0].projectId }), ids.b);
    expect(after).toEqual({ hijo: null, idea: null, snip: null, meet: null, ref: null });
    await page.locator('.toast-undo-btn').click();
    await expect.poll(() => page.evaluate(i => db.projects.get(i).then(Boolean), ids.a)).toBe(true);
    const restored = await page.evaluate(async ([a, b]) => ({
      hijo: (await db.projects.get(b)).parentId === a,
      idea: (await db.ideas.where('title').equals('Idea uno').first()).projectId === a,
      meet: (await db.meetings.toArray())[0].projectId === a }), [ids.a, ids.b]);
    expect(restored).toEqual({ hijo: true, idea: true, meet: true });
  });

  test('eliminar una idea ofrece deshacer', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    await page.locator('.idea-item', { hasText: 'Idea dos' }).locator('.idea-delete-btn').click();
    await expect(page.locator('.idea-item', { hasText: 'Idea dos' })).toHaveCount(0);
    await page.locator('.toast-undo-btn').click();
    await expect(page.locator('.idea-item', { hasText: 'Idea dos' })).toBeVisible();
  });
});

test.describe('Columnas Kanban', () => {
  test('eliminar una columna mueve sus proyectos a la anterior y registra el historial', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanManageCols').click();
    await page.locator('.col-manage-row').nth(1).locator('.col-manage-del').click();
    await expect(page.locator('#confirmMsg')).toContainText('Se moverán a «Ideación»');
    await page.locator('#confirmYes').click();
    await page.locator('#colManageSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Columnas actualizadas');
    const r = await page.evaluate(async () => {
      const p = await db.projects.where('title').equals('Dataset Beta').first();
      const col = await db.kanbanColumns.get(p.columnId);
      return { col: col.title, hist: p.columnHistory.at(-1).colId === p.columnId };
    });
    expect(r).toEqual({ col: 'Ideación', hist: true });
  });

  test('los cambios de nombre no se pierden al añadir o quitar filas', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanManageCols').click();
    await page.locator('.col-manage-title').first().fill('Ideas sueltas');
    await page.locator('#colAddNew').click();
    await expect(page.locator('.col-manage-title').first()).toHaveValue('Ideas sueltas');
  });
});

test.describe('Markdown seguro', () => {
  test('conserva el formato legítimo y elimina lo peligroso', async ({ page }) => {
    await openApp(page);
    const html = await page.evaluate(() => renderMd([
      '**negrita** y `código`', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '- [x] hecho', '',
      '[sitio](https://example.org) [mal](javascript:alert(1)) [mal2](java\tscript:alert(2))', '',
      '<script>alert(3)</script><iframe src="x"></iframe><img src=x onerror=alert(4)><a href="#" onclick="alert(5)" style="x">y</a>',
      '<svg onload=alert(6)></svg><img src="data:text/html;base64,AAAA">',
    ].join('\n')));
    expect(html).toContain('<strong>negrita</strong>');
    expect(html).toContain('<code>código</code>');
    expect(html).toContain('<table>');
    expect(html).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*disabled)[^>]*>/);
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('rel="noopener noreferrer"');
    for (const bad of [/<script/i, /<iframe/i, /<svg/i, /onerror/i, /onclick/i, /style=/i, /javascript:/i, /data:text/i]) expect(html).not.toMatch(bad);
  });

  test('LaTeX sigue renderizando dentro de ideas', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => { const n = new Date().toISOString(); await db.ideas.add({ title: 'tex', content: 'Sea $x^2 + y^2$', status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: n, updatedAt: n }); });
    await gotoView(page, 'ideas');
    await expect(page.locator('#ideasList .katex').first()).toBeVisible();
  });

  test('cssColor solo deja pasar colores inocuos', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => ['#38bdf8', '#fff', 'rgb(1, 2, 3)', 'var(--accent)', 'tomato', 'red;background:url(x)', '"><img>', 'url(javascript:1)', 5, null].map(c => cssColor(c, 'FALLBACK')));
    expect(r).toEqual(['#38bdf8', '#fff', 'rgb(1, 2, 3)', 'var(--accent)', 'tomato', 'FALLBACK', 'FALLBACK', 'FALLBACK', 'FALLBACK', 'FALLBACK']);
  });
});

test.describe('Accesibilidad y teclado', () => {
  test('Esc cierra una sola capa: primero el modal, luego el inspector', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Paper Alfa' }).click();
    await expect(page.locator('body')).not.toHaveClass(/inspector-closed/);
    await page.locator('#inspEditBtn').click();
    await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    await expect(page.locator('body')).not.toHaveClass(/inspector-closed/);
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).toHaveClass(/inspector-closed/);
  });

  test('el modal atrapa Tab y devuelve el foco al cerrar', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanAddProject').focus();
    await page.locator('#kanbanAddProject').click();
    await expect(page.locator('.template-card').first()).toBeVisible();
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.getElementById('modal').contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#kanbanAddProject')).toBeFocused();
  });

  test('el diálogo y las regiones tienen roles ARIA', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#modal')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#toastContainer')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#closeInspector')).toHaveAttribute('aria-label', /Cerrar/);
  });
});

test.describe('Recordatorio de backup', () => {
  test('Settings indica que aún no hay backup y pasa a "hoy" tras exportar', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'settings');
    await expect(page.locator('#backupStatus')).toContainText('Aún no has exportado');
    await page.locator('#exportJsonBtn').click();
    await expect(page.locator('#backupStatus')).toContainText('Último backup: hoy');
  });

  test('alerta cuando hay datos, pasaron 3+ días y nunca se exportó', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(d => localStorage.setItem('ros-first-seen', String(Date.now() - 5 * d)), DAY);
    await gotoView(page, 'dashboard');
    await expect(page.locator('.alert-panel')).toContainText('nunca has exportado un backup');
  });

  test('alerta cuando el último backup tiene más de 14 días', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(d => localStorage.setItem('ros-last-export', String(Date.now() - 20 * d)), DAY);
    await gotoView(page, 'dashboard');
    await expect(page.locator('.alert-panel')).toContainText('último backup fue hace 20 días');
  });
});

test.describe('Fechas locales', () => {
  test.use({ timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  test('en UTC+9 a las 08:00 locales (aún "ayer" en UTC) las fechas por defecto son las locales', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-01T08:00:00+09:00'));
    await openApp(page);
    expect(await page.evaluate(() => localDateISO())).toBe('2026-11-01');
    await page.evaluate(() => showAddMeetingModal());
    await expect(page.locator('#am-date')).toHaveValue('2026-11-01');
  });
});

test.describe('Funciona sin conexión (service worker)', () => {
  test.use({ serviceWorkers: 'allow' });

  test('tras la primera visita, la app arranca y funciona sin red', async ({ page, context }) => {
    test.slow();
    const reachable = await fetch('https://cdnjs.cloudflare.com/ajax/libs/dexie/3.2.4/dexie.min.js', { method: 'HEAD' }).then(r => r.ok).catch(() => false);
    test.skip(!reachable, 'necesita acceso real a cdnjs para la primera visita');
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/index.html');
    await page.evaluate(() => localStorage.setItem('ros-welcomed', '1'));
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    // el SW guarda las librerías a partir del mensaje de la página: espera a que estén en caché
    await expect.poll(() => page.evaluate(async () => {
      const names = await caches.keys();
      let n = 0; for (const k of names) n += (await (await caches.open(k)).keys()).length;
      return n;
    }), { timeout: 20000 }).toBeGreaterThan(10);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS', { timeout: 15000 });
    await expect(page.locator('.boot-error')).toHaveCount(0);
    await page.locator('.nav-item[data-view="ideas"]').click();
    await page.fill('#ideaTitleInput', 'Idea sin conexión');
    await page.locator('#saveIdeaBtn').click();
    await expect(page.locator('.idea-item', { hasText: 'Idea sin conexión' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
