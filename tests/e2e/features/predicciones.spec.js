// Predicciones locales sin IA (insights.js): la captura aprende de tus tareas parecidas, avisa de duplicados y series,
// y la carga se compara con tu capacidad para señalar plazos que no caben y proponer un plan de la semana.
const { test, expect, openApp, gotoView, seed } = require('../helpers');

// Una semana conocida: lunes 2 de noviembre de 2026 (2-6 laborables, 7-8 fin de semana)
const LUN = '2026-11-02';

test.describe('Captura que aprende (lógica)', () => {
  test('sugiere proyecto, persona y tiempo cuando hay tres o más tareas parecidas y coinciden; no pisa lo escrito', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => {
      const projects = [{ id: 1, title: 'Docencia: Estadística I' }, { id: 2, title: 'Tesis Magíster: Conectividad' }];
      const people = [{ id: 7, name: 'Dra. María Vega' }, { id: 8, name: 'Dr. Pablo Fuentes' }];
      const mk = (id, title, extra) => ({ id, title, done: false, projectId: null, effort: null, assigneeId: null, ...extra });
      const tasks = [
        mk(1, 'Corregir pruebas parciales', { projectId: 1, effort: 90 }), mk(2, 'Corregir pruebas del curso', { projectId: 1, effort: 90 }),
        mk(3, 'Corregir las pruebas', { projectId: 1, effort: 60, done: true }), mk(4, 'Corregir pruebas finales', { projectId: 1, effort: 120 }),
        mk(5, 'Pedir datos al laboratorio', { assigneeId: 7, projectId: 2 }), mk(6, 'Pedir datos crudos', { assigneeId: 7, projectId: 2 }),
        mk(7, 'Pedir datos de campo', { assigneeId: 7, projectId: 2 }), mk(8, 'Revisar figuras', { effort: 15 }), mk(9, 'Revisar figuras del paper', { effort: 240 }),
        mk(10, 'Revisar figuras finales', { effort: 20 }), mk(11, 'Revisar figuras de la tesis', { effort: 300 }),
      ];
      const ix = Learn.index(tasks, projects, people), now = new Date('2026-11-02T12:00:00');
      const cap = raw => Learn.suggest(ix, parseCapture(raw, projects, now, people));
      return {
        pruebas: cap('corregir pruebas'),
        datos: cap('pedir datos'),
        yaTecleado: cap('corregir pruebas @tesis ~10m'),
        inconsistente: cap('revisar figuras'),
        pocas: Learn.suggest(Learn.index(tasks.slice(0, 2), projects, people), parseCapture('corregir pruebas', projects, now, people)),
        nada: cap('algo completamente distinto'),
        explicitaIdea: Learn.suggest(ix, parseCapture('i: corregir pruebas', projects, now, people)),
      };
    });
    expect(r.pruebas).toMatchObject({ projectId: 1, effort: 90, basis: 4 });
    expect(r.pruebas.add).toBe('@docencia ~1h30');                               // una palabra basta cuando identifica sola al proyecto
    expect(r.pruebas.parts).toEqual(['en «Docencia: Estadística I»', '⏱ 1 h 30']);
    expect(r.datos).toMatchObject({ projectId: 2, assigneeId: 7 });
    expect(r.datos.add).toBe('@tesis >maria');
    expect(r.yaTecleado).toBeNull();                                              // ya puso proyecto y tiempo: no hay nada que añadir
    expect(r.inconsistente).toBeNull();                                           // 15 min y 4 h: la mediana no dice nada útil
    expect(r.pocas).toBeNull();                                                   // con menos de 3 parecidas no se aventura
    expect(r.nada).toBeNull();
    expect(r.explicitaIdea).toBeNull();                                           // «i:» es una idea a propósito
  });

  test('avisa de una tarea abierta casi idéntica y continúa series numeradas', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => {
      const tasks = [{ id: 1, title: 'Enviar borrador del capítulo 3', done: false }, { id: 2, title: 'Enviar informe anual', done: true }, { id: 3, title: 'Llamar', done: false }];
      const ix = Learn.index(tasks), now = new Date('2026-11-02T12:00:00');
      const dup = raw => Learn.duplicate(ix, parseCapture(raw, [], now, []))?.title ?? null;
      const titles = ['Clase 3: modelos mixtos', 'Clase 4: GLM', 'Prueba 1', 'Reunión semanal'];
      return { igual: dup('enviar borrador capitulo 3'), cercana: dup('Enviar el borrador del capítulo 3 hoy'), otra: dup('enviar borrador del capítulo 4 de la tesis'),
               hecha: dup('enviar informe anual'), corta: dup('llamar'),
               serie: Learn.next(titles, 'Clase'), serieTilde: Learn.next(titles, 'clase '), yaNumerada: Learn.next(titles, 'Clase 5'), unica: Learn.next(titles, 'Prueba'), corto: Learn.next(titles, 'Cl') };
    });
    expect(r.igual).toBe('Enviar borrador del capítulo 3');
    expect(r.cercana).toBe('Enviar borrador del capítulo 3');
    expect(r.otra).toBeNull();
    expect(r.hecha).toBeNull();                                                   // una hecha no cuenta como duplicado
    expect(r.corta).toBe('Llamar');                                               // idéntica aunque sea de una palabra
    expect(r.serie).toBe('Clase 5');
    expect(r.serieTilde).toBe('Clase 5');
    expect(r.yaNumerada).toBeNull();
    expect(r.unica).toBeNull();                                                   // una sola «Prueba 1» no es una serie
    expect(r.corto).toBeNull();
  });
});

test.describe('Captura que aprende (en pantalla)', () => {
  async function historial(page) {
    await openApp(page);
    await page.evaluate(async () => {
      const col = (await db.kanbanColumns.toArray())[0], now = new Date().toISOString();
      const pid = await db.projects.add({ title: 'Tesis Doctoral', type: 'Paper', columnId: col.id, priority: 'Media', status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now });
      for (const t of ['Revisar capítulo de métodos', 'Revisar capítulo de resultados', 'Revisar capítulo de discusión', 'Revisar capítulo de introducción'])
        await Tasks.add({ title: t, projectId: pid, effort: 120 });
      await Tasks.add({ title: 'Enviar borrador a la comisión', due: addDaysISO(4) });
    });
  }

  test('en Hoy: aparece la sugerencia, Tab la acepta y la tarea se crea con proyecto y tiempo; el duplicado se avisa', async ({ page }) => {
    await historial(page);
    await gotoView(page, 'dashboard');
    await page.fill('#captureInput', 'revisar capitulo de conclusiones');
    const chip = page.locator('#capturePreview .capture-accept');
    await expect(chip).toContainText('Tesis Doctoral');
    await expect(chip).toContainText('2 h');
    await expect(chip).toContainText('4 parecidas');
    await expect(page.locator('#capturePreview')).toContainText('Idea');                 // sin lo aprendido sería solo una idea
    await page.locator('#captureInput').press('Tab');
    await expect(page.locator('#captureInput')).toHaveValue('revisar capitulo de conclusiones @tesis ~2h');
    await expect(page.locator('#capturePreview')).toContainText('Tarea');
    await expect(page.locator('#capturePreview')).toContainText('«Tesis Doctoral»');
    await expect(page.locator('#capturePreview .capture-accept')).toHaveCount(0);        // ya está todo
    await page.press('#captureInput', 'Enter');
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada en «Tesis Doctoral»');
    const t = await page.evaluate(() => db.tasks.filter(x => x.title.startsWith('revisar capitulo de conclusiones')).first());
    expect(t).toMatchObject({ effort: 120 });
    expect(t.projectId).toBeGreaterThan(0);

    await page.fill('#captureInput', 'enviar borrador a la comision');                  // duplicado de una tarea abierta
    await expect(page.locator('#capturePreview .capture-warn')).toContainText('ya existe «Enviar borrador a la comisión»');
    await page.fill('#captureInput', 'cosa sin historial');
    await expect(page.locator('#capturePreview .capture-accept')).toHaveCount(0);
    await page.locator('#captureInput').press('Tab');                                     // sin sugerencia, Tab sigue su camino normal
    await expect(page.locator('#captureInput')).not.toBeFocused();
  });

  test('también en la captura rápida (con clic, para el móvil)', async ({ page }) => {
    await historial(page);
    await page.evaluate(() => openQuickCapture());
    await page.fill('#qcInput', 'revisar capitulo de anexos');
    await page.locator('#qcPreview .capture-accept').click();
    await expect(page.locator('#qcInput')).toHaveValue('revisar capitulo de anexos @tesis ~2h');
    await page.locator('#qcSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada en «Tesis Doctoral»');
  });
});

test.describe('Carga y plazos (lógica)', () => {
  test('compara lo que vence con las horas disponibles, sin contar fines de semana', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(([hoy]) => {
      const tasks = [
        { id: 1, title: 'A', due: '2026-11-03', effort: 300, projectId: 1 }, { id: 2, title: 'B', due: '2026-11-03', effort: 300, projectId: null },
        { id: 3, title: 'C', due: '2026-11-03', effort: 300, projectId: null }, { id: 4, title: 'D', due: '2026-11-06', effort: 120, projectId: 2 },
        { id: 5, title: 'Atrasada', due: '2026-10-30', effort: 60 }, { id: 6, title: 'Sin estimar', due: '2026-11-13' }, { id: 7, title: 'Ajena', due: '2026-11-03', effort: 999, assigneeId: 5 },
        { id: 8, title: 'Hecha', due: '2026-11-03', effort: 999, done: true }, { id: 9, title: 'Sin fecha', effort: 999 },
      ];
      const projects = [{ id: 1, title: 'Grant', deadline: '2026-11-03' }, { id: 2, title: 'Paper', deadline: '2026-11-20' }];
      const a = Load.analyze({ tasks, projects, today: hoy, capacity: 360 });
      const holgado = Load.analyze({ tasks, projects, today: hoy, capacity: 960 });
      return { av: [Load.available('2026-11-02', '2026-11-03', 360), Load.available('2026-11-06', '2026-11-09', 360), Load.available('2026-11-07', '2026-11-08', 360)],
               first: a.violations[0] && { date: a.violations[0].date, demand: a.violations[0].demand, available: a.violations[0].available, over: a.violations[0].over, titles: a.violations[0].items.map(x => x.t.title) },
               fechas: a.violations.map(v => v.date), riesgo: a.atRisk.map(x => x.project.title), adivinadas: a.guessed, holgado: holgado.violations.length };
    }, [LUN]);
    expect(r.av).toEqual([720, 720, 0]);                                           // lun-mar, vie + lun (se salta el fin de semana), sáb-dom
    expect(r.first).toEqual({ date: '2026-11-03', demand: 960, available: 720, over: 240, titles: ['A', 'B', 'C', 'Atrasada'].sort((x, y) => ({ A: 300, B: 300, C: 300, Atrasada: 60 }[y] - { A: 300, B: 300, C: 300, Atrasada: 60 }[x])) });
    expect(r.fechas[0]).toBe('2026-11-03');
    expect(r.riesgo).toEqual(['Grant']);                                           // su plazo es el 3 y no cabe; «Paper» (20 nov) sí cabe
    expect(r.adivinadas).toBe(1);                                                  // «Sin estimar» cuenta con la mediana (30 min)
    expect(r.holgado).toBe(0);                                                     // con 16 h al día todo cabe: no hay alarma
  });

  test('propone un día para cada tarea sin plan, sin pasar de la capacidad ni del plazo cuando cabe', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(([hoy]) => {
      const tasks = [
        { id: 1, title: 'Atrasada grande', due: '2026-10-30', effort: 240 }, { id: 2, title: 'Del grant', due: null, projectId: 1, effort: 240, priority: 'Media' },
        { id: 3, title: 'Alta sin fecha', due: null, effort: 120, priority: 'Alta' }, { id: 4, title: 'Baja sin fecha', due: null, effort: 60, priority: 'Baja' },
        { id: 5, title: 'Ya planificada', planDate: '2026-11-02', effort: 120 }, { id: 6, title: 'Vence el martes', due: '2026-11-03', effort: 180 },
        { id: 7, title: 'Con plazo lejano', due: '2026-12-30', effort: 60 }, { id: 8, title: 'Urgente de mañana', due: '2026-11-03', effort: 30, projectId: 1 },
      ];
      const projects = [{ id: 1, title: 'Grant', deadline: '2026-11-04' }];
      const w = Load.planWeek({ tasks, projects, today: hoy, capacity: 360 });
      return { dias: w.days.map(d => d.day), plan: w.plan.map(p => [p.task.title, p.day, p.late]), usados: w.days.map(d => d.used), sin: w.unplaced.map(x => x.t.title) };
    }, [LUN]);
    expect(r.dias).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);   // los próximos 7 días, sin sábado ni domingo
    const dia = t => r.plan.find(p => p[0] === t)?.[1];
    expect(dia('Atrasada grande')).toBe('2026-11-02');                             // lo atrasado primero
    expect(dia('Del grant')).toBe('2026-11-04');                                   // lunes ya lleno (120 planificada + 240) y martes con 210 (lo que vence ese día): el miércoles, que es justo su plazo
    expect(dia('Alta sin fecha')).toBe('2026-11-03');                              // cabe el martes (210 + 120 = 5 h 30)
    expect(dia('Baja sin fecha')).toBeUndefined();                                 // lo de baja prioridad sin fecha no se planifica solo
    expect(dia('Ya planificada')).toBeUndefined();                                 // ya tiene día
    expect(dia('Vence el martes')).toBeUndefined();                                // ya tiene día (su vencimiento): solo ocupa ese día
    expect(dia('Con plazo lejano')).toBeUndefined();                               // plazo a más de dos semanas
    expect(r.plan.every(p => !p[2])).toBe(true);                                   // todo cabe antes de su plazo
    expect(Math.max(...r.usados)).toBeLessThanOrEqual(360);
  });
});

test.describe('Carga y plazos (en pantalla)', () => {
  test('con poco trabajo no hay alarma; con demasiado aparece «Plazos que no caben» y se puede planificar la semana (con deshacer)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'dashboard');
    await expect(page.locator('[data-sec="risk"]')).toHaveCount(0);                  // nada de ruido si todo cabe

    await page.evaluate(async () => {
      for (let i = 1; i <= 4; i++) await Tasks.add({ title: `Pesada ${i}`, due: addDaysISO(1), effort: 480, projectId: 1 });
      await Tasks.add({ title: 'Atrasada importante', due: addDaysISO(-3), effort: 90 });
      await Tasks.add({ title: 'Alta sin fecha', effort: 60, priority: 'Alta' });
    });
    await gotoView(page, 'ideas');
    await gotoView(page, 'dashboard');
    const panel = page.locator('[data-sec="risk"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Plazos que no caben');
    await expect(panel).toContainText('de trabajo para');
    await expect(panel).toContainText('Lo más pesado: Pesada');
    await expect(panel).toContainText('Planificar la semana');
    await panel.locator('[data-risk-project]').first().click();                      // un proyecto en riesgo abre su ficha
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');

    await panel.locator('#planWeekBtn').click();
    await expect(page.locator('#modalTitle')).toContainText('Planificar la semana');
    await expect(page.locator('#modalContent')).toContainText('Atrasada importante');
    await expect(page.locator('#modalContent')).toContainText('Alta sin fecha');
    const total = await page.locator('.wp-check').count();
    expect(total).toBeGreaterThanOrEqual(2);
    await page.locator('.wp-check', { hasText: '' }).last().uncheck();                // la persona puede quitar lo que no quiere
    await page.locator('#wpApply').click();
    await expect(page.locator('.toast.success').last()).toContainText(`${total - 1} tarea(s) con día asignado`);
    const planificadas = await page.evaluate(() => db.tasks.filter(t => !!t.planDate).toArray().then(a => a.map(t => t.title).sort()));
    expect(planificadas).toHaveLength(total - 1);
    await page.locator('.toast-undo-btn').last().click();                              // deshacer
    await expect.poll(() => page.evaluate(() => db.tasks.filter(t => !!t.planDate).count())).toBe(0);
  });

  test('«Planificar la semana» también está en la paleta y en el planificador del día; si no hay nada pendiente lo dice', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.keyboard.press('Control+k');
    await page.fill('#paletteInput', 'planificar la semana');
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast.info').last()).toContainText('Lo urgente ya tiene día');   // con el ejemplo mínimo no hay nada que repartir

    await page.evaluate(() => Tasks.add({ title: 'Atrasada', due: addDaysISO(-2), effort: 45 }));
    await page.evaluate(() => openDayPlanner());
    await page.locator('#dpWeek').click();
    await expect(page.locator('#modalTitle')).toContainText('Planificar la semana');
    await expect(page.locator('#modalContent')).toContainText('Atrasada');
  });
});
