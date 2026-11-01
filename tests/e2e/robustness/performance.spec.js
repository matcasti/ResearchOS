// Humo de rendimiento con un volumen realista de una carrera larga (miles de elementos).
// Los umbrales son holgados: detectan regresiones patológicas, no microoptimizaciones.
const { test, expect } = require('@playwright/test');
const { openApp, gotoView } = require('../helpers');

async function bulkSeed(page) {
  await page.evaluate(async () => {
    const now = new Date().toISOString();
    const cols = await db.kanbanColumns.orderBy('order').toArray();
    const base = { status: 'active', archived: false, starred: false, tags: ['tag'], coauthors: [], createdAt: now, updatedAt: now };
    const pids = [];
    for (let i = 0; i < 300; i++) pids.push(await db.projects.add({ ...base, title: `Proyecto ${i} sobre ecología de ${['bosques', 'humedales', 'pastizales'][i % 3]}`, type: ['Paper', 'Grant', 'Curso', 'Dataset'][i % 4], columnId: cols[i % cols.length].id,
      priority: ['Alta', 'Media', 'Baja'][i % 3], deadline: i % 4 === 0 ? new Date(Date.now() + (i - 150) * 86400000).toISOString().slice(0, 10) : null, description: 'Descripción **larga** '.repeat(20), responsible: 'Dra. Vega' }));
    await db.ideas.bulkAdd(Array.from({ length: 1500 }, (_, i) => ({ title: `Idea ${i}`, content: `contenido de la idea ${i} con [[Proyecto ${i % 300} sobre]] `.repeat(5), status: i % 5 ? 'reviewed' : 'unread', projectId: pids[i % 300], projectIds: [pids[i % 300]], tags: [], subtasks: [], createdAt: now, updatedAt: now })));
    await db.snippets.bulkAdd(Array.from({ length: 800 }, (_, i) => ({ title: `Snippet ${i}`, language: 'R', code: `x${i} <- rnorm(100)\nplot(x${i}, main = "grafico ${i}")\n`.repeat(8), description: '', projectId: pids[i % 300], projectIds: [pids[i % 300]], tags: [], collectionId: null, starred: false, createdAt: now, updatedAt: now })));
    await db.references.bulkAdd(Array.from({ length: 600 }, (_, i) => ({ title: `Artículo ${i}`, authors: `Autor${i}, A.; Otro, B.`, year: 1990 + (i % 35), journal: 'Ecology', doi: `10.1000/${i}`, projectId: pids[i % 300], createdAt: now, updatedAt: now })));
    await db.meetings.bulkAdd(Array.from({ length: 300 }, (_, i) => ({ title: `Reunión ${i}`, date: new Date(Date.now() + (i - 200) * 86400000).toISOString().slice(0, 10), participants: 'Dra. Vega', projectId: pids[i % 300], agreements: '', actionItems: [{ id: 1, text: 'acción', done: i % 2 === 0 }], createdAt: now, updatedAt: now })));
    await db.collaborators.bulkAdd(Array.from({ length: 80 }, (_, i) => ({ name: `Persona ${i} Apellido`, role: 'Colaborador', affiliation: 'UBB', email: '', notes: '', createdAt: now })));
    await db.tasks.bulkAdd(Array.from({ length: 2000 }, (_, i) => ({ title: `Tarea ${i}`, done: i % 3 === 0, doneAt: i % 3 === 0 ? now : null, due: i % 2 ? new Date(Date.now() + (i % 40 - 10) * 86400000).toISOString().slice(0, 10) : null,
      projectId: pids[i % 300], ideaId: null, areaId: null, priority: null, assigneeId: null, recurrence: null, effort: null, planDate: null, createdAt: now, updatedAt: now })));
  });
}

test.describe('Rendimiento con muchos datos', () => {
  test('las vistas principales y la búsqueda responden con ~7 000 elementos', async ({ page }) => {
    test.setTimeout(240000);
    const { errors } = await openApp(page);
    await bulkSeed(page);
    await page.evaluate(() => _buildSearchIndex());
    const times = {};
    for (const [view, max] of [['dashboard', 6000], ['kanban', 8000], ['projects', 8000], ['ideas', 8000], ['references', 8000], ['meetings', 6000], ['weekly', 6000], ['network', 12000], ['report', 6000], ['review', 8000], ['collaborators', 6000]]) {
      const t0 = Date.now();
      await gotoView(page, view);
      times[view] = Date.now() - t0;
      expect(times[view], `${view} tardó ${times[view]} ms`).toBeLessThan(max);
    }
    // índice y búsqueda
    const idx = await page.evaluate(async () => { const t = performance.now(); await _buildSearchIndex(); return performance.now() - t; });
    expect(idx).toBeLessThan(6000);
    await page.keyboard.press('Control+k');
    for (const q of ['humedales', 'plot grafico', 'Autor123']) {
      const t0 = Date.now();
      await page.fill('#paletteInput', q);
      await expect(page.locator('.palette-item').first()).toBeVisible();
      await page.waitForFunction(() => document.querySelectorAll('.palette-item').length > 0);
      expect(Date.now() - t0, `búsqueda «${q}»`).toBeLessThan(3000);
    }
    expect(errors).toEqual([]);
    console.log('PERF', JSON.stringify({ ...times, indexMs: Math.round(idx) }));
  });
});

test.describe('Bandeja de ideas grande', () => {
  test('pinta por tandas, conserva el scroll al pedir más y «seleccionar todo» abarca todas', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      await db.ideas.bulkAdd(Array.from({ length: 400 }, (_, i) => ({ title: `Idea ${String(i).padStart(3, '0')}`, content: '', status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: new Date(Date.now() - i * 1000).toISOString(), updatedAt: now })));
    });
    await gotoView(page, 'ideas');
    await expect(page.locator('#ideasList .idea-item')).toHaveCount(150);
    await expect(page.locator('#ideasMore')).toContainText('Mostrar 150 más · quedan 250');
    await page.locator('#ideasMore').scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => document.getElementById('mainContent').scrollTop);
    expect(y).toBeGreaterThan(300);
    await page.click('#ideasMore');
    await expect(page.locator('#ideasList .idea-item')).toHaveCount(300);
    expect(await page.evaluate(() => document.getElementById('mainContent').scrollTop)).toBeGreaterThan(y - 5);
    await page.click('#ideasMore');
    await expect(page.locator('#ideasList .idea-item')).toHaveCount(400);
    await expect(page.locator('#ideasMore')).toHaveCount(0);
    // al salir y volver, empieza otra vez por las primeras
    await gotoView(page, 'dashboard'); await gotoView(page, 'ideas');
    await expect(page.locator('#ideasList .idea-item')).toHaveCount(150);
    // seleccionar todo: opera sobre los datos, no sobre las tarjetas visibles
    await page.click('#ideaBulkToggle');
    await page.click('#ibSelectAll');
    await expect(page.locator('#ideaBulkCount')).toContainText('400 seleccionadas');
  });
});
