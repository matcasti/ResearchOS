// Carga perezosa: highlight.js, KaTeX y Google Identity solo se descargan cuando hacen falta.
const { test, expect, openApp, gotoView, seed } = require('../helpers');

const HEAVY = { code: /highlight(\.min)?\.js|highlight\.js\/.*\.css/, math: /katex/i, google: /accounts\.google\.com/ };
const track = page => { const seen = []; page.on('request', r => seen.push(r.url())); return (re) => seen.filter(u => re.test(u)); };

test.describe('Carga perezosa de librerías', () => {
  test('un arranque sin código, fórmulas ni Drive no pide highlight.js, KaTeX ni a Google', async ({ page }) => {
    const seen = track(page);
    await openApp(page);
    await seed(page);
    for (const v of ['dashboard', 'kanban', 'ideas', 'references', 'meetings', 'collaborators', 'settings', 'network', 'report']) await gotoView(page, v);
    expect(seen(HEAVY.code)).toEqual([]);
    expect(seen(HEAVY.math)).toEqual([]);
    expect(seen(HEAVY.google)).toEqual([]);
    expect(await page.evaluate(() => [typeof hljs, typeof renderMathInElement, typeof google])).toEqual(['undefined', 'undefined', 'undefined']);
  });

  test('los snippets descargan highlight.js la primera vez y resaltan el código', async ({ page }) => {
    const seen = track(page);
    await openApp(page);
    await seed(page);
    await gotoView(page, 'snippets');
    await expect(page.locator('.snippet-card code.hljs').first()).toBeVisible();
    expect(seen(/highlight\.min\.js/).length).toBe(1);
    expect(seen(/github-dark-dimmed/).length).toBe(1);
    await gotoView(page, 'dashboard'); await gotoView(page, 'snippets');                       // no se vuelve a pedir
    expect(seen(/highlight\.min\.js/).length).toBe(1);
  });

  test('una nota con fórmulas descarga KaTeX; una sin fórmulas no', async ({ page }) => {
    const seen = track(page);
    await openApp(page);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      await db.ideas.add({ title: 'Sin fórmulas', content: 'solo texto', status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    });
    await gotoView(page, 'ideas');
    expect(seen(HEAVY.math)).toEqual([]);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      await db.ideas.add({ title: 'Con fórmulas', content: 'energía $E = mc^2$ y \\(a^2+b^2=c^2\\)', status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    });
    await gotoView(page, 'dashboard'); await gotoView(page, 'ideas');
    await expect(page.locator('#ideasList .katex').first()).toBeVisible();
    expect(seen(/katex\.min\.js/).length).toBe(1);
    expect(seen(/auto-render/).length).toBe(1);
  });

  test('Google Identity se descarga al pulsar «Conectar» y no antes', async ({ page }) => {
    const seen = track(page);
    await openApp(page);
    await gotoView(page, 'settings');
    expect(seen(HEAVY.google)).toEqual([]);
    await page.evaluate(() => GoogleSync.signIn());                                         // el stub de pruebas devuelve un script vacío
    await expect.poll(() => seen(HEAVY.google).length).toBe(1);
    await expect(page.locator('.toast.error').last()).toContainText('Google Identity Services no disponible');   // sin librería real, avisa en vez de fallar en silencio
  });

  test('si la descarga falla (sin conexión) no rompe la vista y se puede reintentar', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    let block = true;
    await page.route(/highlight\.min\.js/, r => block ? r.abort() : r.fallback());          // solo esa librería «se cae»; la app arranca normal
    await gotoView(page, 'snippets');
    await expect(page.locator('.snippet-card').first()).toBeVisible();                       // el código se ve como texto plano
    await expect.poll(() => page.evaluate(() => Object.keys(_libLoads).length)).toBe(0);      // el fallo no queda memorizado
    expect(await page.evaluate(() => typeof hljs)).toBe('undefined');
    block = false;                                                                           // vuelve la red: al volver a la vista se resalta
    await gotoView(page, 'dashboard'); await gotoView(page, 'snippets');
    await expect(page.locator('.snippet-card code.hljs').first()).toBeVisible();
    expect(errors.filter(e => !/highlight\.min\.js|Failed to load resource|net::ERR/.test(e))).toEqual([]);
  });
});
