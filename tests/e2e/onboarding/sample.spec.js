const { test, expect } = require('@playwright/test');
const { openApp, gotoView } = require('../helpers');

// Datos de ejemplo dinámicos: las fechas se calculan desde «hoy» y el ejemplo usa todas las piezas de la app.

const load = page => page.evaluate(() => loadSampleData());

test.describe('Fechas relativas a hoy', () => {
  test('al mover «hoy» 400 días, todas las fechas del ejemplo se mueven exactamente 400 días', async ({ page }) => {
    await openApp(page);
    const res = await page.evaluate(() => {
      const a = buildSampleData(new Date(2031, 2, 12)), b = buildSampleData(new Date(2032, 3, 15));      // 400 días después (2032 es bisiesto)
      const days = (x, y) => Math.round((Date.UTC(...y.split('-').map((v, i) => +v - (i === 1 ? 1 : 0))) - Date.UTC(...x.split('-').map((v, i) => +v - (i === 1 ? 1 : 0)))) / 86400000);
      const bad = [], checked = {};
      const DATE_FIELDS = ['due', 'planDate', 'deadline', 'date', 'lastContact', 'submittedAt', 'deadlineAt', 'decisionDate', 'deadline'];
      for (const [table, rows] of Object.entries(a)) {
        if (!Array.isArray(rows) || table === 'settings') continue;
        rows.forEach((r, i) => {
          for (const f of DATE_FIELDS) if (r[f]) { checked[f] = (checked[f] || 0) + 1; const d = days(r[f], b[table][i][f]); if (d !== 400) bad.push(`${table}[${i}].${f}: ${d}`); }
          for (const f of ['createdAt', 'updatedAt', 'doneAt', 'readAt']) if (r[f]) { const d = Math.round((new Date(b[table][i][f]) - new Date(r[f])) / 86400000); if (Math.abs(d - 400) > 1) bad.push(`${table}[${i}].${f}: ${d}`); }
          for (const it of r.actionItems || []) { const j = r.actionItems.indexOf(it); if (it.due && days(it.due, b[table][i].actionItems[j].due) !== 400) bad.push(`${table}[${i}].actionItems.due`); }
          for (const rd of r.submissionRounds || []) { const j = r.submissionRounds.indexOf(rd); if (days(rd.submittedAt, b[table][i].submissionRounds[j].submittedAt) !== 400) bad.push(`${table}[${i}].round`); }
        });
      }
      return { bad, checked };
    });
    expect(res.bad).toEqual([]);
    for (const f of ['due', 'planDate', 'deadline', 'date', 'lastContact', 'submittedAt', 'deadlineAt']) expect(res.checked[f], f).toBeGreaterThan(0);
  });

  for (const [label, y, m, d] of [['un día cualquiera', 2031, 2, 12], ['bisiesto 29 de febrero', 2028, 1, 29], ['fin de año', 2030, 11, 31]]) {
    test(`en ${label} hay de todo: atrasado, hoy, esta semana y más adelante`, async ({ page }) => {
      await openApp(page);
      const r = await page.evaluate(([y, m, d]) => {
        const base = new Date(y, m, d), s = buildSampleData(base), today = localDateISO(base);
        const plus = n => localDateISO(new Date(y, m, d + n));
        const open = s.tasks.filter(t => !t.done);
        return {
          late: open.filter(t => t.due && t.due < today).length, today: open.filter(t => t.due === today).length,
          week: open.filter(t => t.due > today && t.due <= plus(7)).length, later: open.filter(t => t.due > plus(7)).length, loose: open.filter(t => !t.due).length,
          planned: s.tasks.filter(t => t.planDate === today).length, classToday: s.meetings.filter(x => x.kind === 'class' && x.date === today).length,
          futureMeetings: s.meetings.filter(x => x.date > today).length,
          idleProject: s.projects.some(p => !p.archived && (new Date(base) - new Date(p.updatedAt)) / 86400000 > 40),
          nothingFuturePast: s.projects.filter(p => p.createdAt > new Date(base).toISOString()).length,
        };
      }, [y, m, d]);
      expect(r.late).toBeGreaterThanOrEqual(3);
      expect(r.today).toBeGreaterThanOrEqual(2);
      expect(r.week).toBeGreaterThanOrEqual(5);
      expect(r.later).toBeGreaterThanOrEqual(5);
      expect(r.loose).toBeGreaterThanOrEqual(1);
      expect(r.planned).toBe(3);
      expect(r.classToday).toBe(1);
      expect(r.futureMeetings).toBeGreaterThanOrEqual(3);
      expect(r.idleProject).toBe(true);
      expect(r.nothingFuturePast).toBe(0);
    });
  }

  test('con el reloj en otro año, Hoy muestra lo mismo y no hay fechas del pasado lejano', async ({ page }) => {
    await page.clock.install({ time: new Date('2034-06-14T10:00:00') });
    await openApp(page);
    await load(page);
    await gotoView(page, 'dashboard');
    await expect(page.locator('#todayRoot')).toContainText('Atrasado y para hoy');
    await expect(page.locator('#todayRoot')).toContainText('Terminar los modelos MaxEnt');
    await expect(page.locator('#followUpHost')).toContainText('Sebastián');                  // toca escribirle (cadencia de 14 días)
    const years = await page.evaluate(async () => {
      const tasks = await db.tasks.toArray(), projects = await db.projects.toArray();
      return [...new Set([...tasks.map(t => t.due), ...projects.map(p => p.deadline)].filter(Boolean).map(x => x.slice(0, 4)))];
    });
    expect(years.every(y => +y >= 2034 && +y <= 2035)).toBe(true);
    await expect(page.locator('#mainContent')).not.toContainText('2026');
  });
});

test.describe('Usa todas las piezas de la app', () => {
  test('cada tabla y cada función tiene datos de ejemplo', async ({ page }) => {
    await openApp(page);
    await load(page);
    const r = await page.evaluate(async () => {
      const [projects, ideas, tasks, meetings, refs, snippets, collabs, subs, colls] = await Promise.all(
        ['projects', 'ideas', 'tasks', 'meetings', 'references', 'snippets', 'collaborators', 'submissions', 'snippetCollections'].map(t => db[t].toArray()));
      const areas = await _getAreas(), today = localDateISO();
      return {
        counts: { projects: projects.length, ideas: ideas.length, tasks: tasks.length, meetings: meetings.length, refs: refs.length, snippets: snippets.length, collabs: collabs.length, subs: subs.length, colls: colls.length, areas: areas.length },
        types: [...new Set(projects.map(p => p.type))].sort(),
        hierarchy: projects.some(p => p.parentId), archived: projects.some(p => p.archived), starred: projects.some(p => p.starred),
        projectsInEveryColumn: new Set(projects.filter(p => !p.archived).map(p => p.columnId)).size,
        areasUsed: new Set(projects.map(p => p.areaId).filter(Boolean)).size,
        subStatuses: [...new Set(projects.map(p => p.submissionStatus).filter(Boolean))].sort(),
        rounds: projects.some(p => (p.submissionRounds || []).length), history: projects.some(p => (p._history || []).length), customFields: projects.some(p => Object.keys(p.customFields || {}).length),
        recurring: tasks.some(t => t.recurrence), assigned: tasks.some(t => t.assigneeId && !t.done), effort: tasks.some(t => t.effort), planned: tasks.some(t => t.planDate === today),
        doneTasks: tasks.some(t => t.done), ideaTasks: tasks.some(t => t.ideaId), looseByArea: tasks.some(t => !t.projectId && !t.ideaId && t.areaId), looseNoArea: tasks.some(t => !t.projectId && t.areaId == null),
        priorities: [...new Set(tasks.map(t => t.priority).filter(Boolean))].sort(),
        ideaStatuses: [...new Set(ideas.map(i => i.status))].sort(), ideaOrphan: ideas.some(i => !i.projectId), ideaMulti: ideas.some(i => (i.projectIds || []).length > 1), ideaStar: ideas.some(i => i.starred),
        readStatuses: [...new Set(refs.map(x => x.readStatus).filter(Boolean))].sort(), refOrphan: refs.some(x => !x.projectId), citeKeys: refs.every(x => x.citeKey),
        classes: meetings.filter(m => m.kind === 'class').length, upcoming: meetings.some(m => m.date > today), actionItems: meetings.some(m => (m.actionItems || []).some(a => a.assigneeId && !a.done)),
        snippetLangs: [...new Set(snippets.map(s => s.language))].sort(), snippetNoCollection: snippets.some(s => !s.collectionId), snippetStar: snippets.some(s => s.starred),
        followUps: collabs.filter(c => c.followUpDays).length, followDue: (await followUps()).length,
        wikilinks: [...projects.map(p => p.description), ...ideas.map(i => i.content), ...refs.map(x => x.notes)].join('\n').match(/\[\[[^\]]+\]\]/g)?.length || 0,
        allUids: [projects, ideas, tasks, meetings, refs, snippets, collabs, subs, colls].every(rows => rows.every(x => String(x.uid).startsWith('smp:'))),
      };
    });
    expect(r.counts).toEqual({ projects: 14, ideas: 10, tasks: 41, meetings: 11, refs: 8, snippets: 8, collabs: 4, subs: 3, colls: 3, areas: 4 });
    expect(r.types).toEqual(['Análisis', 'Curso', 'Dataset', 'Grant', 'Paper', 'Presentación', 'Proyecto']);
    expect([r.hierarchy, r.archived, r.starred, r.rounds, r.history, r.customFields]).toEqual([true, true, true, true, true, true]);
    expect(r.projectsInEveryColumn).toBe(6);
    expect(r.areasUsed).toBe(3);
    expect(r.subStatuses).toEqual(['aceptado', 'en_revision', 'preparacion', 'revision_solicitada']);
    expect([r.recurring, r.assigned, r.effort, r.planned, r.doneTasks, r.ideaTasks, r.looseByArea, r.looseNoArea]).toEqual([true, true, true, true, true, true, true, false]);
    expect(r.priorities).toEqual(['Alta', 'Media']);
    expect(r.ideaStatuses).toEqual(['reviewed', 'unread']);
    expect([r.ideaOrphan, r.ideaMulti, r.ideaStar]).toEqual([true, true, true]);
    expect(r.readStatuses).toEqual(['read', 'reading', 'toread']);
    expect([r.refOrphan, r.citeKeys]).toEqual([true, true]);
    expect(r.classes).toBe(5);
    expect([r.upcoming, r.actionItems]).toEqual([true, true]);
    expect(r.snippetLangs).toEqual(['Bash', 'Python', 'R', 'SQL']);
    expect([r.snippetNoCollection, r.snippetStar]).toEqual([true, true]);
    expect(r.followUps).toBe(4);
    expect(r.followDue).toBeGreaterThanOrEqual(2);
    expect(r.wikilinks).toBeGreaterThanOrEqual(10);
    expect(r.allUids).toBe(true);
  });

  test('los enlaces [[Título]] del ejemplo apuntan a algo que existe', async ({ page }) => {
    await openApp(page);
    const broken = await page.evaluate(() => {
      const s = buildSampleData();
      const titles = new Set([...s.projects, ...s.ideas, ...s.snippets, ...s.meetings, ...s.references].map(x => x.title).concat(s.collaborators.map(c => c.name)));
      const texts = [...s.projects.map(p => p.description), ...s.ideas.map(i => i.content), ...s.references.map(r => r.notes)];
      return texts.flatMap(t => [...String(t || '').matchAll(/\[\[([^\]|]+)/g)].map(m => m[1])).filter(l => !titles.has(l));
    });
    expect(broken).toEqual([]);
  });

  test('las pantallas que viven de las fechas muestran contenido: Hoy, Calendario, Línea de tiempo, Informe, Red y Revisión semanal', async ({ page }) => {
    const { errors } = await openApp(page);
    await load(page);
    await gotoView(page, 'dashboard');
    const hoy = page.locator('#todayRoot');
    await expect(hoy).toContainText('Atrasado y para hoy');
    await expect(hoy).toContainText('Esperando a otras personas');
    await expect(hoy).toContainText('Esperando respuesta');
    await expect(hoy).toContainText('Sin próxima acción');
    await expect(hoy).toContainText('Ideas por revisar');
    await expect(page.locator('#followUpHost')).toContainText('Sebastián');
    await expect(hoy.locator('[data-sec="plan"], .plan-section').first()).toBeVisible();
    await gotoView(page, 'weekly');
    await expect(page.locator('#mainContent')).toContainText('Clase 4');                                 // la clase de hoy
    await gotoView(page, 'timeline');
    await expect(page.locator('#mainContent')).not.toContainText('Sin elementos con fecha');
    await gotoView(page, 'report');
    await expect(page.locator('#mainContent')).toContainText('Subir las notas de la Tarea 1');           // hecha hace 2 días
    await gotoView(page, 'review');
    await expect(page.locator('#mainContent')).toContainText('Dataset: Flora Vascular');               // proyecto quieto
    await gotoView(page, 'submissions');
    await expect(page.locator('#mainContent')).toContainText('Diversidad funcional');
    await gotoView(page, 'network');
    await expect(page.locator('#mainContent')).toContainText(/\d+ nodos/);
    expect(errors).toEqual([]);
  });
});

test.describe('Cargar, reiniciar y quitar', () => {
  test('cargarlo dos veces no duplica nada', async ({ page }) => {
    await openApp(page);
    await load(page);
    const a = await page.evaluate(async () => (await Promise.all(['projects', 'tasks', 'ideas', 'meetings'].map(t => db[t].count()))).join(','));
    await load(page);
    expect(await page.evaluate(async () => (await Promise.all(['projects', 'tasks', 'ideas', 'meetings'].map(t => db[t].count()))).join(','))).toBe(a);
  });

  test('quitarlo conserva lo que creó la persona (aunque cuelgue de un proyecto de ejemplo)', async ({ page }) => {
    await openApp(page);
    await load(page);
    const mine = await page.evaluate(async () => {
      const grant = await db.projects.where('title').startsWith('FONDECYT').first();
      const col = (await db.kanbanColumns.toArray())[0];
      const now = new Date().toISOString();
      const pid = await db.projects.add({ title: 'Mi proyecto', type: 'Paper', columnId: col.id, priority: 'Media', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now });
      await Tasks.add({ title: 'Mi tarea en un proyecto de ejemplo', projectId: grant.id, areaId: null });
      await Tasks.add({ title: 'Mi tarea suelta', due: localDateISO() });
      return pid;
    });
    expect(await page.evaluate(() => hasSampleData())).toBe(true);
    await page.evaluate(() => removeSampleData());
    expect(await page.evaluate(() => sampleCount())).toBe(0);
    const left = await page.evaluate(async () => ({
      projects: (await db.projects.toArray()).map(p => p.title), tasks: (await db.tasks.toArray()).map(t => ({ t: t.title, p: t.projectId })),
      areas: (await _getAreas()).length, ideas: await db.ideas.count(), meetings: await db.meetings.count(), cols: await db.kanbanColumns.count() }));
    expect(left.projects).toEqual(['Mi proyecto']);
    expect(left.tasks.map(x => x.t).sort()).toEqual(['Mi tarea en un proyecto de ejemplo', 'Mi tarea suelta']);
    expect(left.tasks.every(x => x.p == null)).toBe(true);                    // la tarea quedó suelta, no huérfana de un proyecto que ya no existe
    expect(left).toMatchObject({ areas: 4, ideas: 0, meetings: 0, cols: 6 });
    expect(mine).toBeTruthy();
  });

  test('reiniciar el ejemplo recalcula las fechas sin duplicar', async ({ page }) => {
    await page.clock.install({ time: new Date('2031-03-12T10:00:00') });
    await openApp(page);
    await load(page);
    const first = await page.evaluate(() => db.tasks.filter(t => t.title === 'Preparar la clase: gradientes ambientales').first().then(t => t.due));
    expect(first).toBe('2031-03-12');
    await page.clock.setSystemTime(new Date('2031-04-02T10:00:00'));
    await page.evaluate(() => loadSampleData({ replace: true }));
    const second = await page.evaluate(() => db.tasks.filter(t => t.title === 'Preparar la clase: gradientes ambientales').first().then(t => t.due));
    expect(second).toBe('2031-04-02');
    expect(await page.evaluate(() => db.projects.count())).toBe(14);
  });

  test('con colaboradores previos, los pasos de reunión siguen apuntando a la persona correcta', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      for (const n of ['Otra Persona A', 'Otra Persona B', 'Otra Persona C']) await db.collaborators.add({ name: n, createdAt: now });
    });
    await load(page);
    const r = await page.evaluate(async () => {
      const m = await db.meetings.where('title').equals('Reunión de avance del grant').first();
      const byId = Object.fromEntries((await db.collaborators.toArray()).map(c => [c.id, c.name]));
      const t = await db.tasks.filter(x => x.title === 'Carta de apoyo del Prof. McKenzie').first();
      return { items: m.actionItems.filter(a => a.assigneeId).map(a => `${a.text} → ${byId[a.assigneeId]}`), task: byId[t.assigneeId] };
    });
    expect(r.items).toEqual(['Terminar el paso 4 del pipeline NDVI → Lic. Andrea Vega', 'Compartir el acceso al herbario CONC → Dr. Pablo Fuentes']);
    expect(r.task).toBe('Prof. James McKenzie');
  });
});

test.describe('Avisos y accesos', () => {
  test('Hoy avisa que son datos de ejemplo y deja quitarlos o reiniciarlos', async ({ page }) => {
    await openApp(page);
    await load(page);
    await gotoView(page, 'dashboard');
    const banner = page.locator('.sample-banner');
    await expect(banner).toContainText('datos de ejemplo');
    await expect(banner.locator('#sbTour, #sbRefresh, #sbRemove')).toHaveCount(3);
    await page.locator('#sbRemove').click();
    await expect(page.locator('#confirmTitle')).toContainText('Quitar');
    await page.locator('#confirmYes').click();
    await expect(page.locator('.sample-banner')).toHaveCount(0);
    expect(await page.evaluate(() => db.projects.count())).toBe(0);
  });

  test('si el ejemplo tiene una semana o más, el aviso lo dice y ofrece actualizar las fechas', async ({ page }) => {
    await openApp(page);
    await load(page);
    await page.evaluate(() => localStorage.setItem('ros-sample-date', localDateISO(new Date(Date.now() - 12 * 86400000))));
    await gotoView(page, 'dashboard');
    await expect(page.locator('.sample-banner.is-stale')).toContainText('hace 12 días');
    await expect(page.locator('#sbRefresh')).toHaveClass(/btn-primary/);
    await page.locator('#sbRefresh').click();
    await page.locator('#confirmYes').click();
    await expect(page.locator('.toast.success').last()).toContainText('fechas vuelven a estar al día');
    await expect(page.locator('.sample-banner.is-stale')).toHaveCount(0);
  });

  test('Ajustes ofrece cargar, reiniciar y quitar; la paleta ofrece cargar y quitar', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'settings');
    await expect(page.locator('#sampleSection')).toBeVisible();
    await expect(page.locator('#setSampleLoad')).toBeVisible();
    await expect(page.locator('#setSampleRemove')).toBeHidden();
    await page.locator('#setSampleLoad').click();
    await expect(page.locator('.toast.success').last()).toContainText('Datos de ejemplo cargados');
    await gotoView(page, 'settings');
    await expect(page.locator('#setSampleLoad')).toBeHidden();
    await expect(page.locator('#setSampleRefresh')).toBeVisible();
    await expect(page.locator('#setSampleRemove')).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.locator('#paletteInput').fill('ejemplo');
    await expect(page.locator('.palette-item-label', { hasText: 'Cargar datos de ejemplo' })).toBeVisible();
    await expect(page.locator('.palette-item-label', { hasText: 'Quitar datos de ejemplo' })).toBeVisible();
  });
});
