const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed, reload } = require('./helpers');

const openPalette = async page => {
  await page.keyboard.press('Control+k');
  await expect(page.locator('#paletteOverlay')).toHaveClass(/open/);
};

test.describe('Command palette', () => {
  test('Ctrl+K abre y cierra; lista vistas sin escribir', async ({ page }) => {
    await openApp(page);
    await openPalette(page);
    await expect(page.locator('.palette-item', { hasText: 'Proyectos · Tablero' }).first()).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.locator('#paletteOverlay')).not.toHaveClass(/open/);
  });

  test('Esc cierra la paleta', async ({ page }) => {
    await openApp(page);
    await openPalette(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#paletteOverlay')).not.toHaveClass(/open/);
  });

  test('escribir el nombre de una vista y Enter navega a ella', async ({ page }) => {
    await openApp(page);
    await openPalette(page);
    await page.fill('#paletteInput', 'kanban');
    await page.keyboard.press('Enter');                   // el primer resultado ya está activo
    await expect(page.locator('.nav-item[data-view="kanban"]')).toHaveClass(/active/);
  });

  test('busca proyectos, ideas, snippets, referencias y reuniones', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await reload(page); // el índice se construye al iniciar
    await openPalette(page);
    for (const [q, expected] of [['alfa', 'Paper Alfa'], ['uno', 'Idea uno'], ['ggplot', 'Snippet ggplot'],
                                  ['unifying', 'A unifying framework'], ['avance', 'Reunión de avance']]) {
      await page.fill('#paletteInput', q);
      await expect(page.locator('.palette-item', { hasText: expected }).first(), `búsqueda "${q}"`).toBeVisible();
    }
  });

  test('sin coincidencias muestra "Sin resultados"', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await reload(page);
    await openPalette(page);
    await page.fill('#paletteInput', 'zzzzqq');
    await expect(page.locator('.palette-empty')).toContainText('Sin resultados');
  });

  test('flechas + Enter abren el proyecto en el inspector', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await reload(page);
    await openPalette(page);
    await page.fill('#paletteInput', 'alfa');
    await expect(page.locator('.palette-item', { hasText: 'Paper Alfa' }).first()).toBeVisible();
    await page.keyboard.press('Enter');                   // el primer resultado ya está activo
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');
  });
});

test.describe('Búsqueda ampliada', () => {
  const labels = async (page, q) => {
    await page.fill('#paletteInput', q);
    await expect(page.locator('#paletteResults')).toBeVisible();
    await page.waitForTimeout(250);
    return (await page.locator('.palette-item').evaluateAll(els => els.map(e => [e.querySelector('.palette-item-label').textContent, e.querySelector('.palette-item-sub').textContent])))
      .filter(([l]) => !l.startsWith('Crear'));
  };
  async function prepare(page) {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      await db.references.where('title').equals('A unifying framework').modify({ notes: 'metodología bayesiana jerárquica', citeKey: 'garcia2021', keywords: ['occupancy'], tags: [] });
      await db.collaborators.add({ name: 'Dr. Pablo Fuentes', role: 'Director de tesis', affiliation: 'Universidad del Sur', email: 'pfuentes@sur.cl', notes: '', createdAt: new Date().toISOString() });
      await Tasks.add({ title: 'Redactar sección de resultados', projectId: 1, due: addDaysISO(3) });
      await _buildSearchIndex();                             // índice poblado: se prueba la ruta rápida, no el recorrido completo
    });
    await openPalette(page);
  }

  test('varias palabras: todas deben aparecer, en cualquier orden y repartidas entre campos', async ({ page }) => {
    await prepare(page);
    expect((await labels(page, 'paper alfa')).map(r => r[0])).toContain('Paper Alfa');
    expect((await labels(page, 'alfa paper')).map(r => r[0])).toContain('Paper Alfa');
    expect((await labels(page, 'alfa tendencia')).map(r => r[0])).not.toContain('Paper Alfa');       // «tendencia» no está en ese proyecto
    expect((await labels(page, 'garcia nature')).map(r => r[0])).toContain('A unifying framework');  // autor + revista, en campos distintos
  });

  test('el código de los snippets y los identificadores con guion bajo se encuentran', async ({ page }) => {
    await prepare(page);
    expect((await labels(page, 'geom_point')).map(r => r[0])).toContain('Snippet ggplot');
    expect((await labels(page, 'aes x y')).map(r => r[0])).toContain('Snippet ggplot');
  });

  test('notas, claves de cita y palabras clave de las referencias', async ({ page }) => {
    await prepare(page);
    for (const q of ['bayesiana', 'garcia2021', 'occupancy', 'bayesiana jerarquica'])
      expect((await labels(page, q)).map(r => r[0]), q).toContain('A unifying framework');
  });

  test('tareas: se encuentran y al elegirlas abren su proyecto', async ({ page }) => {
    await prepare(page);
    const r = await labels(page, 'resultados');
    expect(r.find(x => x[0] === 'Redactar sección de resultados')?.[1]).toMatch(/^Tarea · /);
    await page.locator('.palette-item', { hasText: 'Redactar sección de resultados' }).click();
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');
  });

  test('personas: por nombre, rol, institución o correo; abren su ficha', async ({ page }) => {
    await prepare(page);
    for (const q of ['fuentes', 'director tesis', 'universidad sur', 'pfuentes'])
      expect((await labels(page, q)).map(r => r[0]), q).toContain('Dr. Pablo Fuentes');
    await page.locator('.palette-item', { hasText: 'Dr. Pablo Fuentes' }).first().click();
    await expect(page.locator('#inspectorBody')).toContainText('Director de tesis');
  });

  test('las tareas hechas puntúan menos que las pendientes y las acciones de reunión se buscan', async ({ page }) => {
    await prepare(page);
    await page.evaluate(async () => { const id = await Tasks.add({ title: 'Revisar sección de discusión' }); await Tasks.setDone(id, true); await Tasks.add({ title: 'Revisar sección de métodos' }); await _buildSearchIndex(); });
    const r = (await labels(page, 'revisar sección')).filter(x => x[1].startsWith('Tarea'));
    expect(r.map(x => x[0])).toEqual(['Revisar sección de métodos', 'Revisar sección de discusión']);
    expect(r[1][1]).toContain('hecha');
    expect((await labels(page, 'capítulo')).length).toBe(0);
    await page.evaluate(async () => { await db.meetings.toCollection().modify({ actionItems: [{ id: 1, text: 'Enviar capítulo dos', done: false }] }); await _buildSearchIndex(); });
    expect((await labels(page, 'capitulo dos')).map(x => x[0])).toContain('Reunión de avance');
  });
});
