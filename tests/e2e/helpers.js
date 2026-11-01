// Utilidades compartidas por los tests e2e de ResearchOS.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const base = require('@playwright/test');
const { expect } = base;

// `test` de Playwright con una limpieza automática: al cerrar, Playwright espera a las rutas que sigan en vuelo (p. ej. una tipografía
// pedida justo al terminar la prueba) y eso cuesta ~5 s por prueba. Soltarlas sin esperar es inocuo: la página ya no se usa.
const test = base.test.extend({
  _soltarRutas: [async ({ context }, use) => {
    await use();
    for (const p of context.pages()) await p.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  }, { auto: true }],
});

// Las libs vienen de cdnjs. Para que los tests sean rápidos y deterministas se
// descargan una vez y se sirven desde disco. Google (Fonts, GSI) se anula: no
// aporta nada a los tests y es la principal fuente de ruido de red.
const CDN_CACHE = path.join(__dirname, '.cdn-cache');

async function routeExternal(page, mode) {
  if (mode === 'live') return;
  await page.route(/^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|accounts\.google\.com)\//, async route => {
    const url = route.request().url();
    if (mode === 'blocked') return route.abort();
    if (!url.includes('cdnjs.cloudflare.com')) {
      return route.fulfill({ status: 200, contentType: url.endsWith('.js') || url.includes('/gsi/') ? 'text/javascript' : 'text/css', body: '' });
    }
    // Las tipografías (p. ej. las de KaTeX) no aportan nada a los tests y descargarlas de la red real retrasa el cierre de cada prueba varios segundos.
    if (/\.(woff2?|ttf|otf)(\?|$)/.test(url)) return route.fulfill({ status: 200, contentType: 'font/woff2', body: '' });
    const key = path.join(CDN_CACHE, crypto.createHash('sha1').update(url).digest('hex'));
    if (fs.existsSync(key + '.json')) {
      const meta = JSON.parse(fs.readFileSync(key + '.json', 'utf8'));
      return route.fulfill({ status: 200, contentType: meta.contentType, body: fs.readFileSync(key + '.bin') });
    }
    try {
      const res = await route.fetch();
      const body = await res.body();
      fs.mkdirSync(CDN_CACHE, { recursive: true });
      fs.writeFileSync(key + '.bin', body);
      fs.writeFileSync(key + '.json', JSON.stringify({ url, contentType: res.headers()['content-type'] || 'application/octet-stream' }));
      return route.fulfill({ response: res, body });
    } catch { return route.abort().catch(() => {}); } // la página se cerró a mitad de la descarga
  });
}

/** Abre la app con IndexedDB limpia, sin modal de bienvenida, y registra errores. */
async function openApp(page, { welcomed = true, cdn = 'cache', url = '/index.html' } = {}) {
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.addInitScript(w => {
    // Solo la primera carga: no reinicia el estado en recargas posteriores.
    if (sessionStorage.getItem('__e2e_init')) return;
    sessionStorage.setItem('__e2e_init', '1');
    localStorage.clear();
    if (w) localStorage.setItem('ros-welcomed', '1');
  }, welcomed);

  await routeExternal(page, cdn);
  await page.goto(url);
  await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
  return { errors };
}

async function gotoView(page, view) {
  const item = page.locator(`.nav-item[data-view="${view}"]`);
  const projectTab = ['kanban', 'projects', 'timeline', 'nested'].includes(view);   // el ítem «Proyectos» abre la última pestaña usada
  if (projectTab || await item.count() === 0) {
    // Vistas sin entrada propia en el menú (pestañas de Proyectos, Huérfanos…): se navega como lo haría un enlace interno.
    await page.evaluate(v => navigate(v), view);
  } else {
    // Las vistas secundarias viven en grupos plegables: ábrelos si hace falta.
    if (!(await item.isVisible())) await page.locator(`.nav-group:has(.nav-item[data-view="${view}"]) .nav-group-toggle`).click();
    await item.click();
    await expect(item).toHaveClass(/active/);
  }
  // La vista se pinta de forma asíncrona: espera a que termine antes de interactuar con ella.
  await expect(page.locator('#mainContent')).toHaveAttribute('data-view', view);
  // La entrada de la vista anima 200 ms (translateY): arrastres y clics por coordenadas deben esperar a que termine.
  await page.evaluate(() => Promise.all(document.getElementById('mainContent').getAnimations().map(a => a.finished.catch(() => {}))));
}

module.exports = { openApp, gotoView, test, expect };

/** Inserta un dataset mínimo pero representativo vía Dexie (atajo para tests que no prueban la creación). */
async function seed(page) {
  await page.evaluate(async () => {
    const now = new Date().toISOString();
    const cols = await db.kanbanColumns.orderBy('order').toArray();
    const iso = d => { const x = new Date(); x.setDate(x.getDate() + d); return localDateISO(x); };      // fecha LOCAL: la UTC se adelanta un día de noche
    const base = { status: 'active', archived: false, starred: false, createdAt: now, updatedAt: now, tags: [], coauthors: [] };
    const p1 = await db.projects.add({ ...base, title: 'Paper Alfa', type: 'Paper', columnId: cols[0].id, priority: 'Alta',  responsible: 'Dra. Vega', deadline: iso(3),  description: 'Estudio **alfa**', tags: ['R', 'ecology'] });
    const p2 = await db.projects.add({ ...base, title: 'Dataset Beta', type: 'Dataset', columnId: cols[1].id, priority: 'Media', responsible: 'Dr. García', deadline: iso(-2), description: '' });
    const p3 = await db.projects.add({ ...base, title: 'Grant Gamma', type: 'Grant', columnId: cols[2].id, priority: 'Baja', responsible: '', deadline: null, description: '' });
    await db.ideas.add({ title: 'Idea uno', content: 'contenido **md**', status: 'unread', projectId: p1, projectIds: [p1], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    await db.ideas.add({ title: 'Idea dos', content: '', status: 'reviewed', projectId: null, projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    await db.snippets.add({ title: 'Snippet ggplot', language: 'R', code: 'ggplot(df, aes(x, y)) + geom_point()', description: 'scatter', projectId: p1, projectIds: [p1], tags: ['plot'], collectionId: null, starred: false, createdAt: now, updatedAt: now });
    await db.collaborators.add({ name: 'Dra. Vega', email: 'vega@uni.cl', role: 'Colaboradora', affiliation: 'UBB', createdAt: now });
    await db.meetings.add({ title: 'Reunión de avance', date: iso(0), participants: 'Dra. Vega', projectId: p1, agreements: 'Enviar borrador', actionItems: [{ id: 1, text: 'Revisar sección 2', done: false }], createdAt: now, updatedAt: now });
    await db.references.add({ title: 'A unifying framework', authors: 'García, J., Vega, M.', year: 2021, journal: 'Nature', doi: '10.1038/x', projectId: p1, createdAt: now, updatedAt: now });
    return { p1, p2, p3 };
  });
}

/** Navega y espera a que la vista haya re-renderizado (los renders son async). */
async function reload(page) {
  await page.reload();
  await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
}

module.exports.seed = seed;
module.exports.reload = reload;
module.exports.routeExternal = routeExternal;

/** Ajustes se organiza en pestañas (data = Datos y copias · sync = Sincronización e IA · prefs = Preferencias · help = Ayuda y avanzado). */
async function openSettingsTab(page, key) { await page.locator(`[data-settings-tab="${key}"]`).click(); }
/** Los avisos de Hoy (ejemplo, primeros pasos, alertas, personas) viven en una franja plegable. */
async function openNotices(page) {
  const box = page.locator('#todayNotices');
  await expect(box).toBeVisible();
  if (!(await box.evaluate(e => e.open))) await box.locator('> summary').click();
}
module.exports.openSettingsTab = openSettingsTab;
module.exports.openNotices = openNotices;
