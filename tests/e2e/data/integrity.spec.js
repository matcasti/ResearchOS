const { test, expect, openApp, gotoView, openSettingsTab } = require('../helpers');

// Integridad de datos con el escenario más completo (el ejemplo): copiar, restaurar y fusionar no pierde ni mezcla nada.

/** Estado «legible» de la base: los ids se sustituyen por nombres, así dos bases con ids distintos se pueden comparar. */
const snapshot = page => page.evaluate(async ({ onlySample }) => {
  const T = n => db[n].toArray();
  const [projects, ideas, tasks, meetings, refs, snippets, collabs, cols, colls, subs] = await Promise.all(
    ['projects', 'ideas', 'tasks', 'meetings', 'references', 'snippets', 'collaborators', 'kanbanColumns', 'snippetCollections', 'submissions'].map(T));
  const areas = await _getAreas();
  const by = (rows, key = 'title') => Object.fromEntries(rows.map(r => [r.id, r[key]]));
  const P = by(projects), I = by(ideas), C = by(collabs, 'name'), K = by(cols), A = by(areas, 'name'), S = by(colls, 'name');
  const keep = r => !onlySample || String(r.uid || '').startsWith('smp:');
  const sorted = rows => rows.sort((a, b) => String(a.uid || a.title).localeCompare(String(b.uid || b.title)));
  const pick = (r, keys) => Object.fromEntries(keys.map(k => [k, r[k] ?? null]));
  return {
    projects: sorted(projects.filter(keep).map(p => ({ ...pick(p, ['uid', 'title', 'type', 'priority', 'deadline', 'starred', 'archived', 'submissionStatus', 'submittedAt', 'targetVenue', 'tags', 'coauthors', 'description', 'responsible']),
      column: K[p.columnId], parent: P[p.parentId] ?? null, area: A[p.areaId] ?? null, responsibleName: C[p.responsibleId] ?? null, coauthorNames: (p.coauthorIds || []).map(i => C[i]),
      customFields: p.customFields || {}, rounds: (p.submissionRounds || []).map(r => ({ ...r })), history: (p.columnHistory || []).map(h => ({ col: K[h.colId], in: h.enteredAt, out: h.exitedAt })), snapshots: (p._history || []).length }))),
    tasks: sorted(tasks.filter(keep).map(t => ({ ...pick(t, ['uid', 'title', 'done', 'doneAt', 'due', 'planDate', 'effort', 'priority', 'recurrence']),
      project: P[t.projectId] ?? null, idea: I[t.ideaId] ?? null, assignee: C[t.assigneeId] ?? null, area: A[t.areaId] ?? null }))),
    ideas: sorted(ideas.filter(keep).map(i => ({ ...pick(i, ['uid', 'title', 'content', 'status', 'starred', 'deadline', 'tags']), project: P[i.projectId] ?? null, projects: (i.projectIds || []).map(x => P[x]).sort() }))),
    meetings: sorted(meetings.filter(keep).map(m => ({ ...pick(m, ['uid', 'title', 'date', 'kind', 'participants', 'agreements']), project: P[m.projectId] ?? null,
      items: (m.actionItems || []).map(a => ({ text: a.text, done: !!a.done, due: a.due, who: C[a.assigneeId] ?? null })) }))),
    refs: sorted(refs.filter(keep).map(r => ({ ...pick(r, ['uid', 'title', 'readStatus', 'readAt', 'citeKey', 'year', 'doi', 'notes']), project: P[r.projectId] ?? null }))),
    snippets: sorted(snippets.filter(keep).map(s => ({ ...pick(s, ['uid', 'title', 'language', 'starred', 'code']), project: P[s.projectId] ?? null, collection: S[s.collectionId] ?? null }))),
    collabs: sorted(collabs.filter(keep).map(c => pick(c, ['uid', 'name', 'role', 'email', 'followUpDays', 'lastContact']))),
    subs: sorted(subs.filter(keep).map(s => ({ ...pick(s, ['uid', 'title', 'status', 'submittedAt', 'deadlineAt']), project: P[s.projectId] ?? null }))),
    areas: areas.map(a => pick(a, ['name', 'color'])).sort((a, b) => a.name.localeCompare(b.name)),
    columns: cols.sort((a, b) => a.order - b.order).map(c => c.title),
  };
}, { onlySample: false });

/** Solo lo que creó el ejemplo, con los vínculos expresados en nombres (para comparar cargas en bases distintas). */
const snapshotOnly = page => page.evaluate(async () => {
  const [projects, tasks, meetings, collabs, cols] = await Promise.all(['projects', 'tasks', 'meetings', 'collaborators', 'kanbanColumns'].map(n => db[n].toArray()));
  const P = Object.fromEntries(projects.map(p => [p.id, p.title])), C = Object.fromEntries(collabs.map(c => [c.id, c.name])), K = Object.fromEntries(cols.map(c => [c.id, c.title]));
  const mine = r => String(r.uid || '').startsWith('smp:');
  return {
    projects: projects.filter(mine).map(p => [p.title, K[p.columnId], P[p.parentId] ?? null, C[p.responsibleId] ?? null, (p.coauthorIds || []).map(i => C[i]).join('|')]).sort(),
    tasks: tasks.filter(mine).map(t => [t.title, P[t.projectId] ?? null, C[t.assigneeId] ?? null, t.due]).sort(),
    meetings: meetings.filter(mine).map(m => [m.title, P[m.projectId] ?? null, (m.actionItems || []).map(a => `${a.text}→${C[a.assigneeId] ?? '-'}`).join(';')]).sort(),
  };
});

test.describe('Copias de seguridad con el escenario completo', () => {
  test('exportar → vaciar → importar (reemplazar) devuelve exactamente lo mismo', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => loadSampleData());
    const before = await snapshot(page);
    expect(before.tasks.length).toBe(41);
    const json = await page.evaluate(() => exportAllData());
    await page.evaluate(() => clearAllData());
    expect(await page.evaluate(() => db.projects.count())).toBe(0);
    await page.evaluate(j => importAllData(j), json);
    const after = await snapshot(page);
    expect(after).toEqual(before);
  });

  test('fusionar el backup en una base vacía reproduce el ejemplo; hacerlo otra vez no cambia nada', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => loadSampleData());
    const before = await snapshot(page);
    const json = await page.evaluate(() => exportAllData());
    await page.evaluate(() => clearAllData());
    await page.evaluate(j => mergeAllData(j), json);
    expect(await snapshot(page)).toEqual(before);
    const again = await page.evaluate(async j => (await mergeAllData(j)).added, json);
    expect(Object.values(again).reduce((a, b) => a + b, 0)).toBe(0);
    expect(await snapshot(page)).toEqual(before);
  });

  test('con datos propios previos, el ejemplo queda igual de bien enlazado (personas, proyectos, padres, ideas)', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => loadSampleData());
    const clean = await snapshotOnly(page);
    await page.evaluate(() => removeSampleData());
    await page.evaluate(async () => {                          // datos propios con ids que chocan con los del ejemplo
      const col = (await db.kanbanColumns.toArray())[2], now = new Date().toISOString();
      for (const n of ['Persona propia 1', 'Persona propia 2', 'Persona propia 3', 'Persona propia 4', 'Persona propia 5']) await db.collaborators.add({ name: n, createdAt: now });
      for (let i = 0; i < 16; i++) await db.projects.add({ title: 'Proyecto propio ' + i, type: 'Paper', columnId: col.id, priority: 'Media', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now });
      for (let i = 0; i < 12; i++) await db.ideas.add({ title: 'Idea propia ' + i, content: '', status: 'unread', projectId: null, projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
      for (let i = 0; i < 45; i++) await Tasks.add({ title: 'Tarea propia ' + i });
    });
    await page.evaluate(() => loadSampleData());
    expect(await snapshotOnly(page)).toEqual(clean);
    // y lo propio sigue intacto
    expect(await page.evaluate(async () => [await db.projects.filter(p => p.title.startsWith('Proyecto propio')).count(), await db.tasks.filter(t => t.title.startsWith('Tarea propia')).count(), await db.collaborators.filter(c => c.name.startsWith('Persona propia')).count()])).toEqual([16, 45, 5]);
  });

  test('un backup exportado no trae credenciales y todas las tareas conservan su uid', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => loadSampleData());
    await page.evaluate(() => db.settings.put({ key: 'google_access_token', value: 'secreto' }));
    const data = JSON.parse(await page.evaluate(() => exportAllData()));
    expect(JSON.stringify(data)).not.toContain('secreto');
    expect(data.tasks.length).toBe(41);
    expect(data.tasks.every(t => String(t.uid).startsWith('smp:'))).toBe(true);
    expect(data.tasks.filter(t => t.recurrence).length).toBe(3);
  });
});

test.describe('Recuperación ante fallos', () => {
  test('si una vista falla al pintarse se muestra una pantalla de recuperación con salida', async ({ page }) => {
    const { errors } = await openApp(page);
    await page.evaluate(() => { window.renderSnippets = async () => { throw new Error('fallo simulado'); }; });
    await gotoView(page, 'snippets').catch(() => {});
    await expect(page.locator('.view-error')).toContainText('No se pudo mostrar esta pantalla');
    await expect(page.locator('.view-error')).toContainText('fallo simulado');
    await page.locator('#viewHome').click();
    await expect(page.locator('#todayRoot')).toBeVisible();
    expect(await page.evaluate(() => ErrorLog.all().some(e => e.kind.includes('snippets') && e.msg.includes('fallo simulado')))).toBe(true);
    expect(errors.filter(e => !/fallo simulado|Error al pintar «snippets»/.test(e))).toEqual([]);        // Firefox imprime el mensaje de la consola sin el texto del error
  });

  test('un error inesperado se registra, avisa una vez y aparece en Ajustes → Diagnóstico', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => { setTimeout(() => { throw new Error('boom asíncrono'); }, 0); Promise.reject(new Error('promesa perdida')); });
    await expect(page.locator('.toast.error', { hasText: 'Algo no salió como esperaba' })).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => ErrorLog.all().map(e => e.msg).sort())).toEqual(['boom asíncrono', 'promesa perdida']);
    await gotoView(page, 'settings');
    await openSettingsTab(page, 'help');
    await expect(page.locator('#diagCount')).toHaveText('(2)');
    await expect(page.locator('#diagList')).toContainText('promesa perdida');
    await page.locator('#diagClear').click();
    await expect(page.locator('#diagCount')).toHaveText('(ninguno)');
  });

  test('importar datos programa la copia automática y la subida a la carpeta (es un cambio local)', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => { window.__sched = 0; SyncState.listeners.push(() => { window.__sched++; }); });
    await page.evaluate(() => loadSampleData());
    expect(await page.evaluate(() => window.__sched)).toBeGreaterThan(0);
    await page.evaluate(() => { window.__sched = 0; });
    await page.evaluate(() => _afterDataReplaced({ local: false }));                       // lo que llega de la carpeta no se vuelve a subir
    expect(await page.evaluate(() => window.__sched)).toBe(0);
  });
});

test.describe('Fechas y horario de verano', () => {
  test.use({ timezoneId: 'America/New_York' });

  test('«en N días» es exacto aunque haya un cambio de hora entre hoy y la fecha límite', async ({ page }) => {
    await page.clock.install({ time: new Date('2031-10-28T10:00:00-04:00') });         // el 2 de noviembre de 2031 se retrasa una hora
    await openApp(page);
    const id = await page.evaluate(async () => {
      const col = (await db.kanbanColumns.toArray())[0], now = new Date().toISOString();
      return db.projects.add({ title: 'Vence tras el cambio de hora', type: 'Paper', columnId: col.id, priority: 'Alta', status: 'active', archived: false, starred: false, tags: [], coauthors: [], deadline: '2031-11-04', createdAt: now, updatedAt: now });
    });
    await page.evaluate(i => { App.projectHubId = i; navigate('project-hub'); }, id);
    await expect(page.locator('.hub-header')).toContainText('en 7d');                   // con Math.ceil salía 8
  });
});

test.describe('Tareas que se repiten', () => {
  test('completar una repetición atrasada varias veces salta a la primera fecha que no ha pasado', async ({ page }) => {
    await page.clock.install({ time: new Date('2031-03-12T10:00:00') });
    await openApp(page);
    const r = await page.evaluate(async () => {
      const mk = (title, due, recurrence) => Tasks.add({ title, due, recurrence });
      const ids = {
        semanal: await mk('semanal', '2031-02-19', { freq: 'weekly', interval: 1 }),            // 21 días de atraso
        diaria: await mk('diaria', '2031-03-02', { freq: 'daily', interval: 1 }),               // 10 días
        mensual: await mk('mensual', '2030-12-15', { freq: 'monthly', interval: 1 }),           // casi 3 meses
        alDia: await mk('al día', '2031-03-12', { freq: 'weekly', interval: 1 }),               // vence hoy
        futura: await mk('futura', '2031-03-15', { freq: 'weekly', interval: 1 }),
        acotada: await mk('acotada', '2031-02-01', { freq: 'weekly', interval: 1, until: '2031-02-20' }),
      };
      const out = {};
      for (const [k, id] of Object.entries(ids)) { const next = await Tasks.setDone(id, true); out[k] = next ? (await db.tasks.get(next)).due : null; }
      return out;
    });
    expect(r).toEqual({ semanal: '2031-03-12', diaria: '2031-03-12', mensual: '2031-03-15', alDia: '2031-03-19', futura: '2031-03-22', acotada: null });
  });
});

test.describe('Lectoras de pantalla', () => {
  test('el contenido no es una región «aria-live» (no se relee en cada repintado); la navegación se anuncia aparte', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#mainContent')).not.toHaveAttribute('aria-live', /.+/);
    await gotoView(page, 'references');
    await expect(page.locator('#srStatus')).toHaveText('Referencias');
    await gotoView(page, 'settings');
    await expect(page.locator('#srStatus')).toHaveText('Ajustes y backup');
    await page.evaluate(() => db.projects.add({ title: 'Cambio de datos', type: 'Paper', columnId: 1, priority: 'Media', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    await page.waitForTimeout(400);
    await expect(page.locator('#srStatus')).toHaveText('Ajustes y backup');                       // un repintado por datos no vuelve a anunciar
  });
});

test.describe('Varias pestañas y almacenamiento', () => {
  test('si otra pestaña sube la versión de la base de datos, esta avisa y ofrece recargar', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => db.on.versionchange.fire({ newVersion: 999 }));
    await expect(page.locator('.reload-bar')).toContainText('se actualizó en otra pestaña');
    await expect(page.locator('#reloadNow')).toBeVisible();
  });

  test('si el navegador se queda sin espacio, el aviso lo dice claramente', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => { try { await dbWrite(async () => { const e = new Error('lleno'); e.name = 'QuotaExceededError'; throw e; }); } catch {} });
    await expect(page.locator('.toast.error', { hasText: 'Se llenó el almacenamiento' })).toBeVisible();
  });
});
