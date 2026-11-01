const { test, expect, openApp } = require('../helpers');

// Nada se sale de su caja: ni con el laboratorio de ejemplo ni con textos larguísimos sin espacios (URLs, DOIs, nombres) en
// móvil y en escritorio. Se mira el scroll horizontal de la página y cualquier elemento que sobrepase el borde de su contenedor.

const VIEWS = ['dashboard', 'kanban', 'projects', 'timeline', 'nested', 'ideas', 'snippets', 'references', 'submissions', 'meetings',
  'collaborators', 'weekly', 'review', 'report', 'areas', 'starred', 'archived', 'orphans', 'network', 'tutorial', 'filesystem', 'settings'];

/** El laboratorio de ejemplo con un tercio de los registros llenos de palabras larguísimas, URLs y DOIs. */
async function loadLongSample(page) {
  await page.evaluate(async () => {
    const data = buildSampleData(new Date());
    const LONG = 'SupercalifragilisticoespialidosoextraordinariamenteLargoSinEspaciosParaProbarOverflowDeTextoEnTodasLasVistas';
    const URL_ = 'https://example.org/a/very/long/path/without/spaces/' + 'segmento-'.repeat(14) + 'final?query=' + 'x'.repeat(60);
    const FIELDS = ['title', 'name', 'authors', 'journal', 'affiliation', 'role', 'email', 'targetVenue', 'participants', 'responsible', 'doi', 'citeKey', 'url', 'link', 'description', 'content', 'agreements', 'notes', 'text'];
    for (const rows of Object.values(data)) {
      if (!Array.isArray(rows)) continue;
      rows.forEach((r, i) => {
        if (!r || typeof r !== 'object' || r.uid === undefined || i % 3 === 2) return;
        const mode = i % 3;
        for (const f of FIELDS) {
          if (typeof r[f] !== 'string' || !r[f]) continue;
          if (f === 'email') r[f] = 'persona.con.un.correo.' + 'muy.largo.'.repeat(8) + '@example.org';
          else if (f === 'url' || f === 'link') r[f] = URL_;
          else if (f === 'doi') r[f] = '10.1234/' + 'x'.repeat(90);
          else if (['description', 'content', 'agreements', 'notes'].includes(f)) r[f] += '\n\n' + (mode === 0 ? URL_ + ' ' + LONG : 'palabra '.repeat(60));
          else r[f] = mode === 0 ? LONG + ' ' + LONG : 'Un título bastante largo con muchas palabras para forzar el salto de línea en cualquier contenedor ' + r[f];
        }
        if (Array.isArray(r.tags)) r.tags = [...r.tags, mode === 0 ? LONG : 'etiqueta-larga-' + 'abc'.repeat(8)];
      });
    }
    await mergeAllData(JSON.stringify(data));
    await _afterDataReplaced();
  });
}

/** Abre una vista por navegación interna (en el móvil el menú lateral está oculto). */
async function gotoView(page, view) {
  await page.evaluate(v => navigate(v), view);
  await expect(page.locator('#mainContent')).toHaveAttribute('data-view', view);
  await page.evaluate(() => Promise.all(document.getElementById('mainContent').getAnimations().map(a => a.finished.catch(() => {}))));
}

/** Lo que se sale de su caja en la vista abierta (vacío = todo bien). */
const spills = page => page.evaluate(() => {
  const out = [];
  const vw = document.documentElement.clientWidth;
  const label = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '');
  if (document.documentElement.scrollWidth > vw + 1) out.push(`la página tiene scroll horizontal (${document.documentElement.scrollWidth} > ${vw})`);
  const main = document.getElementById('mainContent');
  if (main.scrollWidth > main.clientWidth + 1) out.push(`el contenido principal desborda (${main.scrollWidth} > ${main.clientWidth})`);
  // ¿hay entre el elemento y #mainContent una caja que recorte o desplace (carrusel, tabla con scroll)? Esas desbordan a propósito
  const scrolls = el => { for (let p = el.parentElement; p && p !== main; p = p.parentElement) if (/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowX)) return true; return false; };
  for (const el of document.querySelectorAll('#mainContent *')) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (!r.width || cs.visibility === 'hidden' || cs.display === 'none' || cs.display === 'inline' || el.matches('.sr-only, .tw-check, svg, svg *')) continue;
    if (el.closest('details:not([open]) > :not(summary)')) continue;
    if (cs.position !== 'fixed' && !scrolls(el) && (r.right > vw + 1 || r.left < -1)) { out.push(`${label(el)} fuera de la pantalla (${Math.round(r.left)}–${Math.round(r.right)} de ${vw})`); continue; }
    if (cs.overflowX === 'visible' && !scrolls(el) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) out.push(`${label(el)} desborda su caja (${el.scrollWidth} > ${el.clientWidth})`);
  }
  return out.slice(0, 12);
});

// El laboratorio con textos larguísimos incluye (sin tocar) un tercio de los registros del ejemplo: una sola pasada por tamaño basta.
for (const [name, size] of [['móvil 360 px', { width: 360, height: 740 }], ['móvil 320 px', { width: 320, height: 568 }], ['tableta 768 px', { width: 768, height: 1024 }], ['escritorio 1280 px', { width: 1280, height: 800 }]]) {
  test.describe(`Sin desbordes · ${name}`, name === 'móvil 360 px' ? {} : { tag: '@slow' }, () => {
    test.use({ viewport: size });

    test('ninguna vista se sale de su caja, con el ejemplo y con textos larguísimos sin espacios (URLs, DOIs, nombres)', async ({ page }) => {
      test.setTimeout(90_000);
      await openApp(page);
      await loadLongSample(page);
      const bad = {};
      for (const v of VIEWS) { await gotoView(page, v); const s = await spills(page); if (s.length) bad[v] = s; }
      expect(bad).toEqual({});
    });
  });
}

test.describe('Detalles de diseño en pantallas estrechas', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('casilla redonda, referencia con ancho para el texto, Snippets a todo el ancho y nombres largos recortados', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => loadSampleData({ replace: true }));

    await gotoView(page, 'review');                                          // la casilla de una tarea no se estira a óvalo por el tamaño táctil
    const check = await page.locator('.review-step .tw-check').first().boundingBox();
    expect(Math.round(check.width)).toBe(Math.round(check.height));

    await gotoView(page, 'references');                                      // el texto deja de aplastarse a 18 px junto al estado
    const widths = await page.locator('.ref-card').evaluateAll(cards => cards.map(c => Math.round(c.querySelector('.ref-card-main').getBoundingClientRect().width)));
    expect(widths.length).toBeGreaterThan(3);
    expect(Math.min(...widths)).toBeGreaterThan(200);

    await gotoView(page, 'snippets');                                        // las colecciones quedan encima y las tarjetas ocupan todo el ancho útil
    const panel = await page.locator('.snippet-collections-panel').boundingBox();
    const card = await page.locator('.snippet-card').first().boundingBox();
    expect(card.y).toBeGreaterThanOrEqual(panel.y + panel.height - 1);
    expect(card.width).toBeGreaterThan(300);

    await page.evaluate(() => db.projects.toCollection().first().then(p => db.projects.update(p.id, { responsible: 'X'.repeat(120) })));
    await gotoView(page, 'kanban');                                          // un nombre larguísimo se recorta con puntos suspensivos dentro de la píldora
    const chip = page.locator('.kanban-card-person .person-chip', { hasText: 'XXXX' }).first();
    const kcard = await chip.locator('xpath=ancestor::div[contains(@class,"kanban-card")][1]').boundingBox();
    const box = await chip.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(kcard.x + kcard.width);
    expect(await chip.locator('.person-chip-name').evaluate(e => getComputedStyle(e).textOverflow)).toBe('ellipsis');
  });
});

test.describe('Pantallas táctiles', () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });

  test('los controles que aparecían al pasar el ratón son visibles', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => loadSampleData({ replace: true }));
    await gotoView(page, 'snippets');
    expect(await page.locator('.snippet-actions').first().evaluate(e => getComputedStyle(e).opacity)).toBe('1');
  });
});
