// Calidad transversal con datos reales (dataset de ejemplo): responsividad, accesibilidad básica y consola limpia.
const { test, expect } = require('@playwright/test');
const { openApp } = require('./helpers');

const VIEWS = ['dashboard', 'kanban', 'projects', 'timeline', 'nested', 'ideas', 'snippets', 'starred', 'review', 'report', 'network', 'submissions',
  'meetings', 'references', 'collaborators', 'weekly', 'areas', 'archived', 'settings', 'tutorial', 'filesystem', 'orphans'];

async function loadDemoApp(page) {
  const ctx = await openApp(page, { welcomed: false });
  await page.locator('#welcomeLoadDemo').click();
  await expect(page.locator('.toast.success')).toContainText('Datos de ejemplo', { timeout: 15000 });
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
  return ctx;
}
async function show(page, v) {
  await page.evaluate(v => navigate(v), v);
  await expect(page.locator('#mainContent')).toHaveAttribute('data-view', v);
  await page.evaluate(() => Promise.all(document.getElementById('mainContent').getAnimations().map(a => a.finished.catch(() => {}))));
}

test.describe('Responsivo: ninguna vista desborda horizontalmente', () => {
  for (const width of [360, 768, 1024, 1440]) {
    test(`${width}px`, async ({ page }) => {
      test.setTimeout(120000);
      await page.setViewportSize({ width, height: 800 });
      await loadDemoApp(page);
      const bad = [];
      for (const v of VIEWS) {
        await show(page, v);
        const r = await page.evaluate(() => {
          const vw = innerWidth, main = document.getElementById('mainContent');
          const inScroller = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return true; } return false; };
          const out = [];
          for (const el of main.querySelectorAll('*')) {
            const b = el.getBoundingClientRect();
            if (b.width && b.height && b.right > vw + 1 && !inScroller(el)) out.push(`${el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]}→${Math.round(b.right)}`);
            if (out.length > 3) break;
          }
          return { page: document.documentElement.scrollWidth > vw + 1, main: main.scrollWidth > main.clientWidth + 1, out };
        });
        if (r.page || r.main || r.out.length) bad.push(`${v}: ${r.out.join(', ') || (r.page ? 'página' : 'main')}`);
      }
      expect(bad).toEqual([]);
    });
  }

  test('modales, paleta e inspector caben en un móvil de 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 700 });
    await loadDemoApp(page);
    const fits = () => page.evaluate(() => [...document.querySelectorAll('#modalOverlay.visible .modal, #paletteOverlay.open .palette, #inspectorPanel')]
      .filter(e => e.getBoundingClientRect().width > 0 && !document.body.classList.contains('inspector-closed') || e.classList.contains('modal') || e.classList.contains('palette'))
      .map(e => { const b = e.getBoundingClientRect(); return b.left >= -1 && b.right <= innerWidth + 1 && e.scrollWidth <= e.clientWidth + 1; }));
    await page.evaluate(() => { db.projects.toCollection().first().then(p => inspectProject(p.id)); });
    await expect(page.locator('#inspectorBody')).not.toBeEmpty();
    expect((await fits()).every(Boolean)).toBe(true);
    await page.evaluate(() => closeInspector());
    for (const open of [() => showAddProjectModal(), () => openDayPlanner(), () => openQuickCapture(), () => showAddReferenceModal(), () => showAddCollaboratorModal()]) {
      await page.evaluate(open);
      await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
      expect((await fits()).every(Boolean)).toBe(true);
      await page.evaluate(() => closeModal());
    }
    await page.evaluate(() => openPalette());
    expect((await fits()).every(Boolean)).toBe(true);
  });

  test('en pantallas táctiles los controles que aparecían al pasar el ratón son visibles', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:4173', serviceWorkers: 'block', hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await loadDemoApp(page);
    await show(page, 'snippets');
    const op = await page.locator('.snippet-actions').first().evaluate(e => getComputedStyle(e).opacity);
    expect(op).toBe('1');
    await ctx.close();
  });
});

test.describe('Accesibilidad básica', () => {
  test('sin ids duplicados, con nombre en botones y campos, y sin errores de consola, en todas las vistas', async ({ page }) => {
    test.setTimeout(120000);
    const { errors } = await loadDemoApp(page);
    const problems = [];
    for (const v of VIEWS) {
      await show(page, v);
      const r = await page.evaluate(() => {
        const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        const tag = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]);
        const ids = {}; document.querySelectorAll('[id]').forEach(e => ids[e.id] = (ids[e.id] || 0) + 1);
        const named = e => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title || e.textContent || '').trim();
        const labelled = e => e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title || e.closest('label') || (e.id && document.querySelector(`label[for="${e.id}"]`));
        return {
          dup: Object.entries(ids).filter(([, n]) => n > 1).map(([k]) => k),
          buttons: [...document.querySelectorAll('button, a[href]')].filter(vis).filter(e => !named(e)).map(tag),
          fields: [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(vis).filter(e => !labelled(e)).map(tag),
          imgs: [...document.querySelectorAll('img:not([alt])')].map(tag),
        };
      });
      for (const [k, list] of Object.entries(r)) if (list.length) problems.push(`${v} ${k}: ${list.slice(0, 4).join(', ')}`);
    }
    expect(problems).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('los modales también nombran sus campos', async ({ page }) => {
    await loadDemoApp(page);
    const unlabeled = [];
    for (const open of [() => showAddProjectModal(), () => showAddReferenceModal(), () => showAddCollaboratorModal(), () => openDayPlanner(), () => openQuickCapture(), () => showManageColumnsModal()]) {
      await page.evaluate(open);
      await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
      unlabeled.push(...await page.evaluate(() => [...document.querySelectorAll('#modalContent input:not([type=hidden]), #modalContent select, #modalContent textarea')]
        .filter(e => e.getBoundingClientRect().width > 0)
        .filter(e => !(e.getAttribute('aria-label') || e.title || e.closest('label') || (e.id && document.querySelector(`label[for="${e.id}"]`)))).map(e => e.id || e.className)));
      await page.evaluate(() => closeModal());
    }
    expect(unlabeled).toEqual([]);
  });
});
