// Barrido de XSS: un backup JSON ajeno (o el Drive Sync) puede traer HTML hostil en cualquier campo.
// - El test "resto de campos" es una guardia de regresión: lo ya escapado debe seguir escapado.
// - Cada campo se prueba aislado (para localizar el sumidero) y además todos a la vez.
const { test, expect } = require('@playwright/test');
const { openApp, gotoView } = require('./helpers');

const PAYLOAD = `"'><img src=x onerror=window.__xss.push(1)>`;
const isoDate = /^\d{4}-\d{2}-\d{2}/;
const TS_KEYS = new Set(['_description', 'exportedAt', 'createdAt', 'updatedAt', 'enteredAt', 'exitedAt', 'ts']);

/**
 * Envenena campos de texto del dataset de ejemplo e importa el resultado.
 * spec (serializable): { only: [claves] } | { columnTitle: true } | { except: [claves] } (todo salvo esas claves).
 */
async function loadPoisoned(page, spec) {
  await page.evaluate(() => { window.__xss = []; });
  const demo = await page.evaluate(() => JSON.stringify(buildSampleData()));
  const data = await page.evaluate(([txt, spec, payload]) => {
    const TS = ['createdAt', 'updatedAt', 'enteredAt', 'exitedAt', 'ts', 'exportedAt', '_description', 'type', 'priority', 'status', 'submissionStatus'];
    const isColTitle = (path, key) => path.includes('kanbanColumns') && key === 'title';
    const when = (path, key) => {
      if (spec.columnTitle) return isColTitle(path, key);
      if (spec.only)        return spec.only.includes(key) && !isColTitle(path, key);
      return !spec.except.includes(key) && !isColTitle(path, key) && !TS.includes(key);
    };
    const walk = (n, path, key) => {
      if (Array.isArray(n)) return n.map(x => walk(x, path, key));
      if (n && typeof n === 'object') return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v, [...path, key].filter(Boolean), k)]));
      if (typeof n === 'string' && n && when(path, key)) return payload + n;
      return n;
    };
    return JSON.stringify(walk(JSON.parse(txt), [], ''));
  }, [demo, spec, PAYLOAD]);
  await page.evaluate(async d => { await importAllData(d); _applySubStages(await _getSubStages()); }, data);
}

/** Recorre vistas, inspectores, hubs, modales de edición y paleta; devuelve dónde se ejecutó el payload. */
const exercise = page => page.evaluate(async () => {
  const where = [];
  const probe = async (label, fn) => {
    const before = window.__xss.length;
    try { await fn(); } catch (e) { /* un error de render no es una ejecución */ }
    await new Promise(r => setTimeout(r, 12));
    if (window.__xss.length > before) where.push(label);
  };
  // Datos que activan las superficies nuevas: «Mi día», seguimiento de personas y un informe que abarca todo
  await db.tasks.toCollection().modify(t => { if (!t.done) { t.planDate = localDateISO(); t.effort = 30; } else t.doneAt = new Date().toISOString(); });
  await db.collaborators.toCollection().modify(c => { c.followUpDays = 7; c.lastContact = '2020-01-01'; c.email = c.email || 'a@b.cl'; });
  App._report = { key: 'custom', from: '2000-01-01', to: localDateISO() };
  const views = ['dashboard', 'kanban', 'projects', 'timeline', 'areas', 'nested', 'ideas', 'snippets', 'starred', 'review',
                 'orphans', 'submissions', 'meetings', 'references', 'collaborators', 'weekly', 'archived', 'settings', 'network', 'report'];
  for (const v of views) await probe(`vista:${v}`, async () => { navigate(v); await new Promise(r => setTimeout(r, 60)); });
  await probe('hoy:seguimiento+mi-día', async () => { await renderView('dashboard'); await new Promise(r => setTimeout(r, 250)); });
  await probe('modal:planificar-día', async () => { await openDayPlanner(); }); closeModal();
  await probe('modal:captura-rápida', async () => { await openQuickCapture(); document.getElementById('qcInput').value = 'x'; document.getElementById('qcInput').dispatchEvent(new Event('input')); }); closeModal();
  await probe('red:tooltip', async () => {                         // pasa el ratón por cada nodo: la ficha flotante usa su título
    await renderView('network');
    const c = document.getElementById('netCanvas'), r = c.getBoundingClientRect();
    for (const n of window.__graph.nodes) { const p = window.__graph.screenPos(n.key); c.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x, clientY: p.y, bubbles: true })); }
  });
  for (const p of await db.projects.toArray()) {
    await probe('modal:clases', () => showClassGenerator(p.id)); closeModal();
    await probe('modal:evaluación', () => showEvaluationModal(p.id)); closeModal();
    await probe('modal:revisores', () => { showReviewerResponseModal(p.id); const t = document.getElementById('rv-text'); t.value = '1. <img src=x onerror=window.__xss.push(7)>'; t.dispatchEvent(new Event('input')); }); closeModal();
  }
  for (const p of await db.projects.toArray()) {
    await probe('inspector:proyecto', () => inspectProject(p.id));
    await probe('hub:proyecto', async () => { App.projectHubId = p.id; await renderView('project-hub'); });
    await probe('modal:editar-proyecto', () => showEditProjectModal(p)); closeModal();
  }
  for (const i of await db.ideas.toArray()) {
    await probe('inspector:idea', () => inspectIdea(i.id));
    await probe('modal:editar-idea', () => showEditIdeaModal(i)); closeModal();
  }
  for (const s of await db.snippets.toArray()) {
    await probe('inspector:snippet', () => inspectSnippet(s));
    await probe('modal:editar-snippet', () => showEditSnippetModal(s)); closeModal();
  }
  for (const m of await db.meetings.toArray())      await probe('inspector:reunión', () => inspectMeeting(m.id));
  for (const r of await db.references.toArray())    await probe('inspector:referencia', () => inspectReference(r.id));
  for (const c of await db.collaborators.toArray()) {
    await probe('inspector:colaborador', () => inspectCollaborator(c.id));
    await probe('hub:colaborador', async () => { App.collaboratorHubId = c.id; await renderView('collaborator-hub'); });
  }
  await probe('modal:columnas', () => showManageColumnsModal()); closeModal();
  await probe('paleta', async () => { await _buildSearchIndex(); openPalette(); await _searchPalette('img'); closePalette(); });
  // Un <img onerror> dispara de forma asíncrona: espera final y atribuye lo que haya llegado tarde.
  const seen = window.__xss.length;
  await new Promise(r => setTimeout(r, 400));
  if (window.__xss.length > seen) where.push('(disparo tardío)');
  return [...new Set(where)];
});

test.describe('XSS — datos hostiles', () => {
  test('control positivo: el detector sí registra un payload que se inyecta sin sanear', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => { window.__xss = []; });
    await page.evaluate(p => { document.getElementById('mainContent').innerHTML = p; }, PAYLOAD);
    await expect.poll(() => page.evaluate(() => window.__xss.length)).toBeGreaterThan(0);
  });

  test('ningún campo de texto ejecuta JS en vistas, inspectores, hubs, modales ni paleta', async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await loadPoisoned(page, { except: [] });
    expect(await exercise(page)).toEqual([]);
  });

  // Un solo test que recorre campo por campo (reiniciando la BD entre cada uno): si falla, el diff muestra
  // exactamente { campo: [lugares] } sin pagar una carga de página por campo.
  test('cada campo de texto, aislado, está escapado en todos los sumideros', async ({ page }) => {
    test.setTimeout(300_000);
    await openApp(page);
    const fields = ['description', 'content', 'color', 'language', 'doi', 'tags', 'coauthors', 'id', 'deadline',
                    'title', 'name', 'responsible', 'authors', 'journal', 'text', 'participants', 'agreements', 'targetVenue',
                    'notes', 'role', 'affiliation', 'email', 'citeKey', 'decision', 'callId', 'agency', 'targetJournal', 'manuscriptUrl', 'kind'];
    const offenders = {};
    for (const field of fields) {
      await page.evaluate(async () => { for (const t of db.tables) await t.clear(); await seedDefaults(); });
      await loadPoisoned(page, { only: [field] });
      const where = await exercise(page);
      if (where.length) offenders[field] = where;
    }
    expect(offenders).toEqual({});
  });

  test('título de columna Kanban (select del formulario de edición)', async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await loadPoisoned(page, { columnTitle: true });
    expect(await exercise(page)).toEqual([]);
  });
});

test.describe('XSS — markdown', () => {
  test('renderMd descarta <img onerror> con comillas simples o sin comillas', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => { window.__xss = []; });
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      await db.ideas.add({ title: 'a', content: "<img src=x onerror='window.__xss.push(1)'>", status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
      await db.ideas.add({ title: 'b', content: '<img src=x onerror=window.__xss.push(2)>', status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    });
    await gotoView(page, 'ideas');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__xss.length)).toBe(0);
  });

  test('renderMd no deja href="javascript:" en enlaces markdown', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      await db.ideas.add({ title: 'link', content: '[click](javascript:window.__xss.push(3))', status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    });
    await gotoView(page, 'ideas');
    const hrefs = await page.locator('#ideasList a').evaluateAll(as => as.map(a => a.getAttribute('href')));
    expect(hrefs.filter(h => /^\s*javascript:/i.test(h || ''))).toEqual([]);
  });
});

test.describe('Entrada legítima con comillas (misma causa, sin atacante)', () => {

  test('editar un proyecto con una etiqueta que lleva comillas dobles no trunca la etiqueta', async ({ page }) => {
    await openApp(page);
    const id = await page.evaluate(async () => {
      const col = (await db.kanbanColumns.toArray())[0];
      return db.projects.add({ title: 'P', type: 'Proyecto', columnId: col.id, priority: 'Media', status: 'active', archived: false, starred: false,
        tags: ['pantalla 5"', 'otra'], coauthors: ['Juan "Pancho" Pérez'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    await page.evaluate(async i => showEditProjectModal(await db.projects.get(i)), id);
    await page.locator('#epSave').click();
    await expect(page.locator('.toast.success')).toContainText('Proyecto actualizado'); // el guardado ocurrió de verdad
    const saved = await page.evaluate(i => db.projects.get(i).then(p => ({ tags: p.tags, coauthors: p.coauthors })), id);
    expect(saved).toEqual({ tags: ['pantalla 5"', 'otra'], coauthors: ['Juan "Pancho" Pérez'] });
  });
});
