const { test, expect } = require('@playwright/test');
const { openApp, seed } = require('../helpers');

// En América, entre las 21:00 y las 24:00 la fecha UTC ya es la de mañana. Todo lo que dice «hoy» debe usar la fecha local.
test.use({ timezoneId: 'America/Santiago' });

test.describe('De noche, la fecha es la local', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2031-03-12T23:40:00-03:00') });          // 02:40 UTC del día 13
  });

  test('«hoy» es el 12 aunque en UTC ya sea 13', async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => [localDateISO(), new Date().toISOString().slice(0, 10)])).toEqual(['2031-03-12', '2031-03-13']);
  });

  test('marcar un paper como «enviado» guarda la fecha local', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const id = await page.evaluate(async () => { const p = await db.projects.where('title').equals('Paper Alfa').first(); await _updatePipelineStage(p.id, 'enviado'); return p.id; });
    expect(await page.evaluate(i => db.projects.get(i).then(p => p.submittedAt), id)).toBe('2031-03-12');
  });

  test('los días desde que registraste a alguien se cuentan con fechas locales', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => db.collaborators.add({ name: 'Olga Vieja', followUpDays: 30, createdAt: new Date(Date.now() - 50 * 86400000).toISOString() }));
    expect(await page.evaluate(() => followUps().then(l => l.map(x => x.since)))).toEqual([50]);
  });

  test('el ejemplo se calcula con el día local: lo de hoy vence hoy', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => loadSampleData());
    expect(await page.evaluate(() => db.tasks.filter(t => t.title === 'Preparar la clase: gradientes ambientales').first().then(t => t.due))).toBe('2031-03-12');
    expect(await page.evaluate(() => db.meetings.filter(m => m.kind === 'class' && m.date === '2031-03-12').count())).toBe(1);
  });
});
