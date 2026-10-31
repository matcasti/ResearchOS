// Sincronización entre dispositivos: identidad (uid), «gana el más reciente», lápidas de borrado,
// referencias entre registros y transporte por carpeta compartida. Cada «dispositivo» es un contexto de navegador aparte.
const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('./helpers');

const BASE = 'http://localhost:4173';
async function device(browser) {
  const ctx = await browser.newContext({ baseURL: BASE, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await openApp(page);
  return { ctx, page };
}
const snap = page => page.evaluate(async () => JSON.stringify(await Sync.snapshot()));
const apply = (page, s) => page.evaluate(t => Sync.apply(JSON.parse(t)), s);
const titles = (page, table, field = 'title') => page.evaluate(([t, f]) => db[t].toArray().then(a => a.map(r => r[f]).sort()), [table, field]);

/** Un proyecto con idea, tareas (una asignada a una persona) y reunión, todo enlazado. */
async function populate(page) {
  await page.evaluate(async () => {
    const cols = await db.kanbanColumns.orderBy('order').toArray();
    const now = new Date().toISOString();
    const pid = await db.projects.add({ title: 'Proyecto A', type: 'Paper', columnId: cols[3].id, priority: 'Alta', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now });
    const hijo = await db.projects.add({ title: 'Hijo de A', type: 'Dataset', columnId: cols[1].id, parentId: pid, priority: 'Media', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now });
    const iid = await db.ideas.add({ title: 'Idea de A', content: '', status: 'unread', projectId: pid, projectIds: [pid], tags: [], createdAt: now, updatedAt: now });
    const cid = await db.collaborators.add({ name: 'Dra. Vega', createdAt: now });
    await Tasks.add({ title: 'Tarea del proyecto', projectId: pid, due: '2027-01-10' });
    await Tasks.add({ title: 'Tarea de la idea', ideaId: iid, projectId: pid });
    await Tasks.add({ title: 'Esperando a Vega', projectId: pid, assigneeId: cid, recurrence: { freq: 'weekly', interval: 1 } });
    await db.meetings.add({ title: 'Reunión A', date: '2027-02-01', projectId: pid, participants: 'Dra. Vega', actionItems: [{ id: 1, text: 'paso', done: false, assigneeId: cid }], createdAt: now, updatedAt: now });
    return hijo;
  });
}

test.describe('Identidad y ganchos', () => {
  test('todo registro nuevo recibe uid y updatedAt; editar actualiza updatedAt', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const id = await Tasks.add({ title: 'x' });
      const a = await db.tasks.get(id);
      await new Promise(r => setTimeout(r, 15));
      await db.tasks.update(id, { title: 'y' });
      const b = await db.tasks.get(id);
      const c = await db.collaborators.add({ name: 'N', createdAt: new Date().toISOString() });
      return { uid: a.uid, a: a.updatedAt, b: b.updatedAt, collab: (await db.collaborators.get(c)).uid };
    });
    expect(r.uid).toMatch(/[0-9a-f-]{16,}/);
    expect(r.b > r.a).toBe(true);
    expect(r.collab).toBeTruthy();
  });

  test('un updatedAt explícito se respeta (backups, migraciones y la propia sincronización)', async ({ page }) => {
    await openApp(page);
    const v = await page.evaluate(async () => {
      const id = await Tasks.add({ title: 'x' });
      await db.tasks.update(id, { title: 'y', updatedAt: '2020-01-01T00:00:00.000Z' });
      return (await db.tasks.get(id)).updatedAt;
    });
    expect(v).toBe('2020-01-01T00:00:00.000Z');
  });

  test('borrar deja una lápida; «Deshacer» la retira y el registro vuelve más reciente', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const r = await page.evaluate(async () => {
      const p = await db.projects.where('title').equals('Grant Gamma').first();
      const undo = await deleteProjectCascade(p.id);
      await new Promise(r => setTimeout(r, 100));
      const tombs = (await db.tombstones.toArray()).filter(t => t.uid === p.uid);
      await undo();
      await new Promise(r => setTimeout(r, 100));
      const back = await db.projects.where('uid').equals(p.uid).first();
      return { tombs: tombs.length, after: (await db.tombstones.toArray()).filter(t => t.uid === p.uid).length, newer: back.updatedAt > p.updatedAt };
    });
    expect(r).toEqual({ tombs: 1, after: 0, newer: true });
  });

  test('datos anteriores o backups sin uid reciben un uid determinista (el mismo en cualquier dispositivo)', async ({ page }) => {
    await openApp(page);
    const backup = { projects: [{ id: 1, title: 'Proyecto viejo', createdAt: '2026-01-01T10:00:00.000Z', columnId: 1 }], kanbanColumns: [{ id: 1, title: 'Ideación', order: 0 }] };
    await page.evaluate(b => importAllData(JSON.stringify(b)), backup);
    const a = await page.evaluate(() => db.projects.toArray().then(r => r[0].uid));
    await page.evaluate(b => importAllData(JSON.stringify(b)), backup);
    const b2 = await page.evaluate(() => db.projects.toArray().then(r => r[0].uid));
    expect(a).toBe(b2);
    expect(a).toBe(await page.evaluate(() => legacyUid('projects', { title: 'Proyecto viejo', createdAt: '2026-01-01T10:00:00.000Z' })));
  });

  test('el merge de backups reconoce lo ya existente por uid, no por título', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const backup = JSON.parse(await page.evaluate(() => exportAllData()));
    backup.projects[0].title = 'Título cambiado en el backup';          // misma identidad, otro título: no debe duplicarse
    const sum = await page.evaluate(b => mergeAllData(JSON.stringify(b)), backup);
    expect(sum.added.projects || 0).toBe(0);
    expect(await page.evaluate(() => db.projects.count())).toBe(3);
  });
});

test.describe('Fusión entre dos dispositivos', () => {
  test('lo creado en A llega a B con todas sus relaciones intactas', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    await populate(A.page);
    const r = await apply(B.page, await snap(A.page));
    expect(r.added).toBe(8);                                                    // 2 proyectos, 1 idea, 1 persona, 3 tareas, 1 reunión
    expect(await titles(B.page, 'projects')).toEqual(['Hijo de A', 'Proyecto A']);
    const rel = await B.page.evaluate(async () => {
      const p = await db.projects.where('title').equals('Proyecto A').first();
      const h = await db.projects.where('title').equals('Hijo de A').first();
      const i = await db.ideas.where('title').equals('Idea de A').first();
      const v = await db.collaborators.where('name').equals('Dra. Vega').first();
      const col = await db.kanbanColumns.get(p.columnId);
      const ts = await db.tasks.toArray();
      const m = await db.meetings.toArray();
      return { parentOk: h.parentId === p.id, ideaOk: i.projectId === p.id && i.projectIds[0] === p.id, colOk: col.title === 'Escritura',
        taskIdea: ts.find(t => t.title === 'Tarea de la idea').ideaId === i.id,
        taskAssignee: ts.find(t => t.title === 'Esperando a Vega').assigneeId === v.id,
        rec: ts.find(t => t.title === 'Esperando a Vega').recurrence.freq, actionAssignee: m[0].actionItems[0].assigneeId === v.id };
    });
    expect(rel).toEqual({ parentOk: true, ideaOk: true, colOk: true, taskIdea: true, taskAssignee: true, rec: 'weekly', actionAssignee: true });
    expect(await B.page.evaluate(() => db.kanbanColumns.count())).toBe(6);                // columnas por defecto: mismas en ambos, sin duplicar
    await A.ctx.close(); await B.ctx.close();
  });

  test('es idempotente: aplicar dos veces lo mismo no cambia nada', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    await populate(A.page);
    const s = await snap(A.page);
    await apply(B.page, s);
    const before = await B.page.evaluate(() => Promise.all(['projects', 'ideas', 'tasks', 'meetings', 'collaborators'].map(t => db[t].count())));
    expect(await apply(B.page, s)).toEqual({ added: 0, updated: 0, deleted: 0 });
    expect(await B.page.evaluate(() => Promise.all(['projects', 'ideas', 'tasks', 'meetings', 'collaborators'].map(t => db[t].count())))).toEqual(before);
    await A.ctx.close(); await B.ctx.close();
  });

  test('gana el cambio más reciente, en ambas direcciones, y los cambios en registros distintos se suman', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    await populate(A.page);
    await apply(B.page, await snap(A.page));
    // A edita el proyecto; B (después) edita el mismo proyecto y además la idea
    await A.page.evaluate(() => db.projects.where('title').equals('Proyecto A').first().then(p => db.projects.update(p.id, { title: 'Proyecto A (editado en A)' })));
    await B.page.waitForTimeout(30);
    await B.page.evaluate(async () => {
      const p = await db.projects.where('title').equals('Proyecto A').first();
      await db.projects.update(p.id, { title: 'Proyecto A (editado en B, más reciente)' });
      const i = await db.ideas.where('title').equals('Idea de A').first();
      await db.ideas.update(i.id, { title: 'Idea editada en B' });
    });
    await apply(A.page, await snap(B.page));
    await apply(B.page, await snap(A.page));
    for (const d of [A, B]) {
      expect(await titles(d.page, 'projects')).toEqual(['Hijo de A', 'Proyecto A (editado en B, más reciente)']);
      expect(await titles(d.page, 'ideas')).toEqual(['Idea editada en B']);
    }
    await A.ctx.close(); await B.ctx.close();
  });

  test('un borrado se propaga (con sus tareas), no deja referencias colgantes y no resucita', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    await populate(A.page);
    await apply(B.page, await snap(A.page));
    await A.page.evaluate(async () => { const i = await db.ideas.where('title').equals('Idea de A').first(); const undo = await deleteIdeaCascade(i.id); window.__noUndo = undo; });
    await A.page.waitForTimeout(100);
    const r = await apply(B.page, await snap(A.page));
    expect(r.deleted).toBeGreaterThanOrEqual(2);                            // la idea y la tarea de la idea
    expect(await titles(B.page, 'ideas')).toEqual([]);
    expect((await titles(B.page, 'tasks')).includes('Tarea de la idea')).toBe(false);
    await apply(A.page, await snap(B.page));                                  // B no la devuelve
    expect(await titles(A.page, 'ideas')).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  test('si se edita DESPUÉS del borrado, la edición gana y el registro vuelve', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    await populate(A.page);
    await apply(B.page, await snap(A.page));
    await A.page.evaluate(async () => { const i = await db.ideas.where('title').equals('Idea de A').first(); await db.ideas.delete(i.id); });
    await B.page.waitForTimeout(60);
    await B.page.evaluate(async () => { const i = await db.ideas.where('title').equals('Idea de A').first(); await db.ideas.update(i.id, { content: 'edición posterior al borrado' }); });
    await apply(B.page, await snap(A.page));                                  // la lápida de A es más antigua que la edición de B
    expect(await titles(B.page, 'ideas')).toEqual(['Idea de A']);
    await apply(A.page, await snap(B.page));
    expect(await titles(A.page, 'ideas')).toEqual(['Idea de A']);
    await A.ctx.close(); await B.ctx.close();
  });

  test('un hijo que llega antes que su padre se enlaza igualmente', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    await populate(A.page);
    const s = JSON.parse(await snap(A.page));
    s.tables.projects.reverse();                                              // hijo primero
    await apply(B.page, JSON.stringify(s));
    expect(await B.page.evaluate(async () => { const h = await db.projects.where('title').equals('Hijo de A').first(); return (await db.projects.get(h.parentId))?.title; })).toBe('Proyecto A');
    await A.ctx.close(); await B.ctx.close();
  });

  test('las áreas se unifican por nombre, y su borrado se propaga', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    for (const d of [A, B]) await d.page.evaluate(() => seedSuggestedAreas());          // ambas crean «Investigación», «Docencia»… con uids distintos
    await A.page.evaluate(async () => _saveAreas([...(await _getAreas()), { id: 99, name: 'Extensión', color: '#ec4899' }]));
    await apply(B.page, await snap(A.page));
    const names = await B.page.evaluate(() => _getAreas().then(a => a.map(x => x.name).sort()));
    expect(names).toEqual(['Docencia', 'Extensión', 'Gestión', 'Investigación', 'Personal']);        // sin duplicados
    await A.page.waitForTimeout(40);
    await A.page.evaluate(async () => _saveAreas((await _getAreas()).filter(a => a.name !== 'Personal')));
    await apply(B.page, await snap(A.page));
    expect(await B.page.evaluate(() => _getAreas().then(a => a.map(x => x.name).includes('Personal')))).toBe(false);
    await A.ctx.close(); await B.ctx.close();
  });

  test('dos dispositivos que ya compartían datos por backup no los duplican al sincronizar', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    const legacy = { kanbanColumns: [{ id: 1, title: 'Ideación', order: 0, color: '#3b82f6' }],
      projects: [{ id: 1, title: 'P1', columnId: 1, createdAt: '2026-03-01T08:00:00.000Z', type: 'Paper', priority: 'Media' }],
      ideas: [{ id: 1, title: 'I1', projectId: 1, status: 'unread', createdAt: '2026-03-02T08:00:00.000Z' }] };
    for (const d of [A, B]) await d.page.evaluate(t => importAllData(JSON.stringify(t)), legacy);
    await apply(B.page, await snap(A.page));
    expect(await B.page.evaluate(() => Promise.all([db.projects.count(), db.ideas.count(), db.kanbanColumns.count()]))).toEqual([1, 1, 1]);
    await A.ctx.close(); await B.ctx.close();
  });

  test('«Reemplazar todo» en un dispositivo borra lo anterior también en el otro', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    await populate(A.page);
    await apply(B.page, await snap(A.page));
    await A.page.waitForTimeout(40);
    await A.page.evaluate(() => importAllData(JSON.stringify({ projects: [{ id: 1, title: 'Solo este', columnId: 1, type: 'Paper', priority: 'Media', createdAt: '2027-01-01T00:00:00.000Z' }], kanbanColumns: [{ id: 1, title: 'Ideación', order: 0 }] })));
    await apply(B.page, await snap(A.page));
    expect(await titles(B.page, 'projects')).toEqual(['Solo este']);
    expect(await titles(B.page, 'ideas')).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });
});

test.describe('Carpeta compartida', () => {
  const peerFile = (page, name, text) => page.evaluate(async ([n, t]) => {
    const dir = await navigator.storage.getDirectory();
    const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(t); await w.close();
  }, [name, text]);
  const opfs = page => page.evaluate(async () => { const d = await navigator.storage.getDirectory(); const n = []; for await (const [k] of d.entries()) n.push(k); return n.sort(); });

  test('elegir carpeta escribe el archivo propio y trae los cambios de otro dispositivo', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    await populate(A.page);
    const fromA = await snap(A.page);
    await B.page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
    await gotoView(B.page, 'settings');
    await peerFile(B.page, 'researchos-sync-dZZZZ.json', fromA);                // «Dropbox» ya trae el archivo del otro dispositivo
    await B.page.locator('#syncOn').click();
    await expect(B.page.locator('.toast', { hasText: 'Sincronizado con' })).toBeVisible();
    await expect.poll(() => titles(B.page, 'projects')).toEqual(['Hijo de A', 'Proyecto A']);
    const files = await opfs(B.page);
    expect(files).toContain(`researchos-sync-${await B.page.evaluate(() => Sync.deviceId())}.json`);
    await expect(B.page.locator('#syncDesc')).toContainText('Última sincronización');
    const again = await B.page.evaluate(() => SyncFolder.syncNow({ quiet: true }));
    expect(again).toMatchObject({ added: 0, updated: 0, deleted: 0 });          // el archivo del par no cambió: no se relee
    await A.ctx.close(); await B.ctx.close();
  });

  test('el archivo propio refleja los cambios locales y los otros dispositivos pueden leerlo', async ({ browser }) => {
    const A = await device(browser), B = await device(browser);
    await A.page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
    await gotoView(A.page, 'settings');
    await A.page.locator('#syncOn').click();
    await expect(A.page.locator('.toast.success').last()).toContainText('activada');
    await populate(A.page);
    await A.page.evaluate(() => SyncFolder.syncNow({ quiet: true }));
    const text = await A.page.evaluate(async () => { const d = await navigator.storage.getDirectory(); return (await (await d.getFileHandle(SyncFolder.fileName())).getFile()).text(); });
    const r = await apply(B.page, text);
    expect(r.added).toBe(8);
    expect(await titles(B.page, 'projects')).toContain('Proyecto A');
    await A.ctx.close(); await B.ctx.close();
  });

  test('desactivar olvida la carpeta y el nombre del dispositivo se guarda', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
    await gotoView(page, 'settings');
    await page.locator('#syncOn').click();
    await expect(page.locator('#syncOff')).toBeVisible();
    await page.fill('#syncDeviceName', 'Portátil de la oficina');
    await page.locator('#syncDeviceName').blur();
    expect(await page.evaluate(() => Sync.deviceName())).toBe('Portátil de la oficina');
    await page.locator('#syncOff').click();
    expect(await page.evaluate(() => db.settings.get('sync-dir-handle'))).toBeUndefined();
    await expect(page.locator('#syncOn')).toBeVisible();
  });

  test('los handles de carpeta nunca viajan en un backup', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
    await gotoView(page, 'settings');
    await page.locator('#syncOn').click();
    await expect(page.locator('#syncOff')).toBeVisible();
    const keys = await page.evaluate(async () => JSON.parse(await exportAllData()).settings.map(s => s.key));
    expect(keys).not.toContain('sync-dir-handle');
  });
});
