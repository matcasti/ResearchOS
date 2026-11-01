const { test, expect, openApp, seed, reload } = require('../helpers');

const openPalette = async page => {
  await page.keyboard.press('Control+k');
  await expect(page.locator('#paletteOverlay')).toHaveClass(/open/);
};

test.describe('Paleta de comandos', () => {
  test('Ctrl+K abre y cierra y lista las vistas; Esc cierra; escribir una vista y Enter navega a ella', async ({ page }) => {
    await openApp(page);
    await openPalette(page);
    await expect(page.locator('.palette-item', { hasText: 'Proyectos · Tablero' }).first()).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.locator('#paletteOverlay')).not.toHaveClass(/open/);
    await openPalette(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#paletteOverlay')).not.toHaveClass(/open/);
    await openPalette(page);
    await page.fill('#paletteInput', 'kanban');
    await page.keyboard.press('Enter');                   // el primer resultado ya está activo
    await expect(page.locator('.nav-item[data-view="kanban"]')).toHaveClass(/active/);
  });

  test('busca proyectos, ideas, snippets, referencias y reuniones (sin tildes, y lo recién creado al instante); sin coincidencias lo dice; Enter abre el proyecto', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const col = (await db.kanbanColumns.toArray())[0];
      await db.projects.add({ title: 'Análisis de series', type: 'Análisis', columnId: col.id, priority: 'Media', status: 'active',
        archived: false, starred: false, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    await reload(page);                                    // el índice se construye al iniciar y, con datos, desactiva el escaneo completo
    await page.waitForTimeout(300);
    await openPalette(page);
    for (const [q, expected] of [['alfa', 'Paper Alfa'], ['uno', 'Idea uno'], ['ggplot', 'Snippet ggplot'],
                                  ['unifying', 'A unifying framework'], ['avance', 'Reunión de avance'], ['analisis', 'Análisis de series']]) {
      await page.fill('#paletteInput', q);
      await expect(page.locator('.palette-item', { hasText: expected }).first(), `búsqueda "${q}"`).toBeVisible();
    }
    await page.fill('#paletteInput', 'zzzzqq');
    await expect(page.locator('.palette-empty')).toContainText('Sin resultados');
    await page.fill('#paletteInput', 'alfa');
    await expect(page.locator('.palette-item', { hasText: 'Paper Alfa' }).first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');

    // un proyecto recién creado se encuentra de inmediato (el índice no queda obsoleto 1,5 s)
    await page.evaluate(() => navigate('kanban'));
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="blank"]').click();
    await page.fill('#mp-title', 'Quimera Zebra');
    await page.locator('#mpSave').click();
    await expect(page.locator('.toast.success')).toContainText('Proyecto creado');
    await openPalette(page);
    await page.fill('#paletteInput', 'quimera');
    await expect(page.locator('.palette-item', { hasText: 'Quimera Zebra' }).first()).toBeVisible({ timeout: 800 });
  });

  test('búsqueda ampliada: varias palabras, código, notas, claves, tareas, personas y acciones de reunión', async ({ page }) => {
    const labels = async q => {
      await page.fill('#paletteInput', q);
      await expect(page.locator('#paletteResults')).toBeVisible();
      await page.waitForTimeout(250);
      return (await page.locator('.palette-item').evaluateAll(els => els.map(e => [e.querySelector('.palette-item-label').textContent, e.querySelector('.palette-item-sub').textContent])))
        .filter(([l]) => !l.startsWith('Crear'));
    };
    const names = async q => (await labels(q)).map(r => r[0]);
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      await db.references.where('title').equals('A unifying framework').modify({ notes: 'metodología bayesiana jerárquica', citeKey: 'garcia2021', keywords: ['occupancy'], tags: [] });
      await db.collaborators.add({ name: 'Dr. Pablo Fuentes', role: 'Director de tesis', affiliation: 'Universidad del Sur', email: 'pfuentes@sur.cl', notes: '', createdAt: new Date().toISOString() });
      await Tasks.add({ title: 'Redactar sección de resultados', projectId: 1, due: addDaysISO(3) });
      await _buildSearchIndex();                             // índice poblado: se prueba la ruta rápida, no el recorrido completo
    });
    await openPalette(page);

    // varias palabras: todas deben aparecer, en cualquier orden y repartidas entre campos
    expect(await names('paper alfa')).toContain('Paper Alfa');
    expect(await names('alfa paper')).toContain('Paper Alfa');
    expect(await names('alfa tendencia')).not.toContain('Paper Alfa');           // «tendencia» no está en ese proyecto
    expect(await names('garcia nature')).toContain('A unifying framework');       // autor + revista, en campos distintos
    // el código de los snippets y los identificadores con guion bajo
    expect(await names('geom_point')).toContain('Snippet ggplot');
    expect(await names('aes x y')).toContain('Snippet ggplot');
    // notas, claves de cita y palabras clave de las referencias
    for (const q of ['bayesiana', 'garcia2021', 'occupancy', 'bayesiana jerarquica']) expect(await names(q), q).toContain('A unifying framework');

    // tareas: se encuentran y al elegirlas abren su proyecto
    const r = await labels('resultados');
    expect(r.find(x => x[0] === 'Redactar sección de resultados')?.[1]).toMatch(/^Tarea · /);
    await page.locator('.palette-item', { hasText: 'Redactar sección de resultados' }).click();
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');

    // personas: por nombre, rol, institución o correo; abren su ficha
    await openPalette(page);
    for (const q of ['fuentes', 'director tesis', 'universidad sur', 'pfuentes']) expect(await names(q), q).toContain('Dr. Pablo Fuentes');
    await page.locator('.palette-item', { hasText: 'Dr. Pablo Fuentes' }).first().click();
    await expect(page.locator('#inspectorBody')).toContainText('Director de tesis');

    // las tareas hechas puntúan menos que las pendientes y las acciones de reunión se buscan
    await page.evaluate(async () => { const id = await Tasks.add({ title: 'Revisar sección de discusión' }); await Tasks.setDone(id, true); await Tasks.add({ title: 'Revisar sección de métodos' }); await _buildSearchIndex(); });
    await openPalette(page);
    const tareas = (await labels('revisar sección')).filter(x => x[1].startsWith('Tarea'));
    expect(tareas.map(x => x[0])).toEqual(['Revisar sección de métodos', 'Revisar sección de discusión']);
    expect(tareas[1][1]).toContain('hecha');
    expect((await labels('capítulo')).length).toBe(0);
    await page.evaluate(async () => { await db.meetings.toCollection().modify({ actionItems: [{ id: 1, text: 'Enviar capítulo dos', done: false }] }); await _buildSearchIndex(); });
    expect(await names('capitulo dos')).toContain('Reunión de avance');
  });
});
