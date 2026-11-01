// Recorre toda la app con el dataset de ejemplo real (sample.js, con fechas relativas a hoy),
// que es el escenario más cercano a un usuario con datos.
const { test, expect } = require('@playwright/test');
const { openApp, gotoView } = require('./helpers');

const VIEWS = [
  'dashboard', 'kanban', 'projects', 'timeline', 'areas', 'nested',
  'ideas', 'snippets', 'starred', 'orphans', 'submissions',
  'meetings', 'references', 'collaborators', 'weekly', 'filesystem',
  'archived', 'tutorial', 'settings', 'network', 'review',
];
const BAD_TEXT = /undefined|NaN|\[object |null(?!\w)/;

async function loadDemo(page) {
  const ctx = await openApp(page, { welcomed: false });
  await page.locator('#welcomeLoadDemo').click();
  await expect(page.locator('.toast.success')).toContainText('Datos de ejemplo', { timeout: 15000 });
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
  return ctx;
}

test.describe('Dataset de ejemplo', () => {
  test('el botón del modal de bienvenida carga todo el dataset', async ({ page }) => {
    const { errors } = await loadDemo(page);
    const counts = await page.evaluate(async () => Object.fromEntries(await Promise.all(
      ['projects', 'ideas', 'snippets', 'references', 'meetings', 'collaborators', 'kanbanColumns']
        .map(async t => [t, await db[t].count()]))));
    expect(counts).toEqual({ projects: 14, ideas: 10, snippets: 8, references: 8, meetings: 11, collaborators: 4, kanbanColumns: 6 });
    expect(errors).toEqual([]);
  });

  for (const view of VIEWS) {
    test(`vista "${view}" con datos reales: sin errores ni "undefined/NaN"`, async ({ page }) => {
      const { errors } = await loadDemo(page);
      await gotoView(page, view);
      await page.waitForTimeout(500);
      // El código de los snippets puede contener legítimamente NULL/NaN/undefined.
      const text = await page.locator('#mainContent').evaluate(el => {
        const c = el.cloneNode(true);
        c.querySelectorAll('pre, code, .snippet-code').forEach(n => n.remove());
        return c.innerText;
      });
      expect(text, `texto de la vista ${view}`).not.toMatch(BAD_TEXT);
      expect(errors).toEqual([]);
    });
  }

  test('inspectores de todas las entidades abren sin errores', async ({ page }) => {
    const { errors } = await loadDemo(page);
    const bad = await page.evaluate(async () => {
      const out = [];
      const check = async (label, fn) => {
        try { await fn(); } catch (e) { out.push(`${label}: ${e.message}`); return; }
        const t = inspectorBody.innerText;
        if (/undefined|NaN|\[object /.test(t)) out.push(`${label}: texto sospechoso -> ${(t.match(/.{0,30}(undefined|NaN|\[object ).{0,30}/) || [])[0]}`);
      };
      for (const p of await db.projects.toArray())       await check(`project ${p.id} ${p.title}`, () => inspectProject(p.id));
      for (const i of await db.ideas.toArray())          await check(`idea ${i.id}`,       () => inspectIdea(i.id));
      for (const s of await db.snippets.toArray())       await check(`snippet ${s.id}`,    () => inspectSnippet(s));
      for (const m of await db.meetings.toArray())       await check(`meeting ${m.id}`,    () => inspectMeeting(m.id));
      for (const r of await db.references.toArray())     await check(`ref ${r.id}`,        () => inspectReference(r.id));
      for (const c of await db.collaborators.toArray())  await check(`collab ${c.id}`,     () => inspectCollaborator(c.id));
      return out;
    });
    expect(bad).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Project Hub de cada proyecto renderiza', async ({ page }) => {
    const { errors } = await loadDemo(page);
    const bad = await page.evaluate(async () => {
      const out = [];
      for (const p of await db.projects.toArray()) {
        try {
          App.projectHubId = p.id;
          await renderView('project-hub');
          const t = mainContent.innerText;
          if (/undefined|NaN|\[object /.test(t)) out.push(`hub ${p.title}: ${(t.match(/.{0,30}(undefined|NaN|\[object ).{0,30}/) || [])[0]}`);
        } catch (e) { out.push(`hub ${p.title}: ${e.message}`); }
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

  test('dashboard muestra estadísticas coherentes con la BD', async ({ page }) => {
    await loadDemo(page);
    await gotoView(page, 'dashboard');
    const txt = await page.locator('#mainContent').innerText();
    expect(txt).toMatch(/8/);           // proyectos
    await expect(page.locator('#ideasBadge')).not.toHaveText('0');
    // El badge de reuniones cuenta action items pendientes, no reuniones.
    const pending = await page.evaluate(async () => (await db.meetings.toArray())
      .reduce((n, m) => n + (m.actionItems || []).filter(a => !a.done).length, 0));
    await expect(page.locator('#meetingsBadge')).toHaveText(String(pending));
  });

  test('timeline: zoom semana/mes/año y filtros sin errores', async ({ page }) => {
    const { errors } = await loadDemo(page);
    await gotoView(page, 'timeline');
    const btns = page.locator('#mainContent .tl-btn-group button, #mainContent [data-tl-zoom]');
    const n = await btns.count();
    for (let i = 0; i < n; i++) { await btns.nth(i).click().catch(() => {}); await page.waitForTimeout(120); }
    expect(await page.locator('#mainContent').innerText()).not.toMatch(BAD_TEXT);
    expect(errors).toEqual([]);
  });

  test('agenda: alternar semana/mes y navegar meses', async ({ page }) => {
    const { errors } = await loadDemo(page);
    await gotoView(page, 'weekly');
    await page.locator('#agendaMonthBtn').click();
    await page.locator('#agendaPrev').click();
    await page.locator('#agendaNext').click();
    await page.locator('#agendaToday').click();
    await page.locator('#agendaWeekBtn').click();
    expect(errors).toEqual([]);
  });

  test('submissions: vista lista y pipeline', async ({ page }) => {
    const { errors } = await loadDemo(page);
    await gotoView(page, 'submissions');
    await page.locator('#subViewList').click();
    await expect(page.locator('#subContentArea')).toBeVisible();
    await page.locator('#subViewPipeline').click();
    await expect(page.locator('.sub-pipe-col').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('revisión rápida de ideas (triage) avanza con teclado', async ({ page }) => {
    const { errors } = await loadDemo(page);
    await gotoView(page, 'ideas');
    await page.locator('#startTriageBtn').click();
    await expect(page.locator('#mainContent')).toContainText(/Revisión rápida|\d+\s*\/\s*\d+/);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(errors).toEqual([]);
  });

  test('modo presentación del Kanban (F5) entra y sale con Esc', async ({ page }) => {
    await loadDemo(page);
    await gotoView(page, 'kanban');
    await page.keyboard.press('F5');
    await expect(page.locator('body')).toHaveClass(/presentation-mode/);
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/presentation-mode/);
  });
});
