// Recorre toda la app con el dataset de ejemplo real (sample.js, con fechas relativas a hoy),
// que es el escenario más cercano a un usuario con datos. Cada prueba carga el ejemplo una sola vez y lo recorre entero.
const { test, expect, openApp, gotoView } = require('../helpers');

const VIEWS = [
  'dashboard', 'kanban', 'projects', 'timeline', 'areas', 'nested', 'ideas', 'snippets', 'starred', 'orphans', 'submissions',
  'meetings', 'references', 'collaborators', 'weekly', 'filesystem', 'archived', 'tutorial', 'settings', 'network', 'review', 'report',
];

async function loadDemo(page) {
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

/** Lo que está mal en la vista abierta: texto roto, ids repetidos y botones, campos o imágenes sin nombre (vacío = todo bien). */
const probe = page => page.evaluate(() => {
  const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const tag = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]);
  const named = e => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title || e.textContent || '').trim();
  const labelled = e => e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title || e.closest('label') || (e.id && document.querySelector(`label[for="${e.id}"]`));
  const ids = {}; document.querySelectorAll('[id]').forEach(e => ids[e.id] = (ids[e.id] || 0) + 1);
  // El código de los snippets puede contener legítimamente NULL/NaN/undefined.
  const c = document.getElementById('mainContent').cloneNode(true);
  c.querySelectorAll('pre, code, .snippet-code').forEach(n => n.remove());
  const bad = (c.innerText.match(/.{0,30}(undefined|NaN|\[object |null(?!\w)).{0,30}/s) || [])[0];
  return {
    texto: bad ? [bad] : [],
    ids: Object.entries(ids).filter(([, n]) => n > 1).map(([k]) => k),
    botones: [...document.querySelectorAll('button, a[href]')].filter(vis).filter(e => !named(e)).map(tag),
    campos: [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(vis).filter(e => !labelled(e)).map(tag),
    imágenes: [...document.querySelectorAll('img:not([alt])')].map(tag),
  };
});

test.describe('Dataset de ejemplo', () => {
  test('el botón de bienvenida lo carga completo y cada vista se ve limpia: sin «undefined/NaN», con nombres accesibles y sin errores', async ({ page }) => {
    test.setTimeout(120_000);
    const { errors } = await loadDemo(page);
    const counts = await page.evaluate(async () => Object.fromEntries(await Promise.all(
      ['projects', 'ideas', 'snippets', 'references', 'meetings', 'collaborators', 'kanbanColumns'].map(async t => [t, await db[t].count()]))));
    expect(counts).toEqual({ projects: 14, ideas: 10, snippets: 8, references: 8, meetings: 11, collaborators: 4, kanbanColumns: 6 });

    const problems = [];
    let seen = 0;
    for (const v of VIEWS) {
      await show(page, v);
      await page.waitForTimeout(200);                                          // algunas vistas terminan de pintarse tras la animación
      for (const [k, list] of Object.entries(await probe(page))) if (list.length) problems.push(`${v} ${k}: ${list.slice(0, 4).join(', ')}`);
      if (errors.length > seen) { problems.push(`${v} errores: ${errors.slice(seen).join(' | ')}`); seen = errors.length; }
    }
    expect(problems).toEqual([]);

    // el panel de Hoy cuadra con la base de datos
    await show(page, 'dashboard');
    await expect(page.locator('#ideasBadge')).not.toHaveText('0');
    const pending = await page.evaluate(async () => (await db.meetings.toArray()).reduce((n, m) => n + (m.actionItems || []).filter(a => !a.done).length, 0));
    await expect(page.locator('#meetingsBadge')).toHaveText(String(pending));       // el badge de reuniones cuenta acciones pendientes, no reuniones

    // inspectores de todas las entidades y Project/Collaborator Hub de cada proyecto y persona
    const bad = await page.evaluate(async () => {
      const out = [];
      const sus = t => (t.match(/.{0,30}(undefined|NaN|\[object ).{0,30}/) || [])[0];
      const check = async (label, fn) => {
        try { await fn(); } catch (e) { out.push(`${label}: ${e.message}`); return; }
        const s = sus(inspectorBody.innerText);
        if (s) out.push(`${label}: texto sospechoso -> ${s}`);
      };
      for (const p of await db.projects.toArray())       await check(`project ${p.id} ${p.title}`, () => inspectProject(p.id));
      for (const i of await db.ideas.toArray())          await check(`idea ${i.id}`,       () => inspectIdea(i.id));
      for (const s of await db.snippets.toArray())       await check(`snippet ${s.id}`,    () => inspectSnippet(s));
      for (const m of await db.meetings.toArray())       await check(`meeting ${m.id}`,    () => inspectMeeting(m.id));
      for (const r of await db.references.toArray())     await check(`ref ${r.id}`,        () => inspectReference(r.id));
      for (const c of await db.collaborators.toArray())  await check(`collab ${c.id}`,     () => inspectCollaborator(c.id));
      for (const p of await db.projects.toArray()) {
        try { App.projectHubId = p.id; await renderView('project-hub'); const s = sus(mainContent.innerText); if (s) out.push(`hub ${p.title}: ${s}`); }
        catch (e) { out.push(`hub ${p.title}: ${e.message}`); }
      }
      for (const c of await db.collaborators.toArray()) {
        try { App.collaboratorHubId = c.id; await renderView('collaborator-hub'); }
        catch (e) { out.push(`collab-hub ${c.name}: ${e.message}`); }
      }
      return out;
    });
    expect(bad).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('interacciones sobre el ejemplo: línea de tiempo, agenda, submissions, revisión rápida, presentación y ventanas', async ({ page }) => {
    test.setTimeout(90_000);
    const { errors } = await openApp(page);
    await page.evaluate(() => loadSampleData());

    await gotoView(page, 'timeline');                                         // zoom semana/mes/año y filtros
    const btns = page.locator('#mainContent .tl-btn-group button, #mainContent [data-tl-zoom]');
    const n = await btns.count();
    for (let i = 0; i < n; i++) { await btns.nth(i).click().catch(() => {}); await page.waitForTimeout(120); }
    expect(await page.locator('#mainContent').innerText()).not.toMatch(/undefined|NaN|\[object /);

    await gotoView(page, 'weekly');                                           // agenda: semana ↔ mes y navegar
    for (const id of ['agendaMonthBtn', 'agendaPrev', 'agendaNext', 'agendaToday', 'agendaWeekBtn']) await page.locator('#' + id).click();

    await gotoView(page, 'submissions');                                      // lista y pipeline
    await page.locator('#subViewList').click();
    await expect(page.locator('#subContentArea')).toBeVisible();
    await page.locator('#subViewPipeline').click();
    await expect(page.locator('.sub-pipe-col').first()).toBeVisible();

    await gotoView(page, 'ideas');                                            // revisión rápida (triage) con teclado
    await page.locator('#startTriageBtn').click();
    await expect(page.locator('#mainContent')).toContainText(/Revisión rápida|\d+\s*\/\s*\d+/);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await gotoView(page, 'kanban');                                           // modo presentación (F5) entra y sale con Esc
    await page.keyboard.press('F5');
    await expect(page.locator('body')).toHaveClass(/presentation-mode/);
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/presentation-mode/);

    // las ventanas nombran sus campos…
    const unlabeled = [];
    const modals = [() => showAddProjectModal(), () => showAddReferenceModal(), () => showAddCollaboratorModal(), () => openDayPlanner(), () => openQuickCapture(), () => showManageColumnsModal()];
    for (const open of modals) {
      await page.evaluate(open);
      await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
      unlabeled.push(...await page.evaluate(() => [...document.querySelectorAll('#modalContent input:not([type=hidden]), #modalContent select, #modalContent textarea')]
        .filter(e => e.getBoundingClientRect().width > 0)
        .filter(e => !(e.getAttribute('aria-label') || e.title || e.closest('label') || (e.id && document.querySelector(`label[for="${e.id}"]`)))).map(e => e.id || e.className)));
      await page.evaluate(() => closeModal());
    }
    expect(unlabeled).toEqual([]);

    // …y, en un móvil de 360 px, ventanas, paleta e inspector caben en la pantalla
    await page.setViewportSize({ width: 360, height: 700 });
    const fits = () => page.evaluate(() => [...document.querySelectorAll('#modalOverlay.visible .modal, #paletteOverlay.open .palette, #inspectorPanel')]
      .filter(e => e.getBoundingClientRect().width > 0 && !document.body.classList.contains('inspector-closed') || e.classList.contains('modal') || e.classList.contains('palette'))
      .map(e => { const b = e.getBoundingClientRect(); return b.left >= -1 && b.right <= innerWidth + 1 && e.scrollWidth <= e.clientWidth + 1; }));
    await page.evaluate(() => { db.projects.toCollection().first().then(p => inspectProject(p.id)); });
    await expect(page.locator('#inspectorBody')).not.toBeEmpty();
    expect((await fits()).every(Boolean)).toBe(true);
    await page.evaluate(() => closeInspector());
    for (const open of modals.slice(0, 5)) {
      await page.evaluate(open);
      await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
      expect((await fits()).every(Boolean)).toBe(true);
      await page.evaluate(() => closeModal());
    }
    await page.evaluate(() => openPalette());
    expect((await fits()).every(Boolean)).toBe(true);
    expect(errors).toEqual([]);
  });
});
