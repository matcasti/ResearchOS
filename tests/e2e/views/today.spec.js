// Vista «Hoy», tareas con fecha, captura rápida, contexto por área, menú agrupado,
// revisión semanal, enlaces [[ ]] y migración de las subtareas antiguas.
// Cada prueba recorre un tema entero sobre una sola carga de la app.
const { test, expect, openApp, gotoView, seed } = require('../helpers');

const iso = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); const p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const addTask = (page, t) => page.evaluate(async t => Tasks.add(t), t);
const taskDue = (page, title) => page.evaluate(t => db.tasks.filter(x => x.title === t).first().then(x => x.due), title);

test.describe('Parser de captura rápida', () => {
  test('tarea con proyecto, fecha relativa y prioridad; fechas; idea o prefijos; @proyecto por prefijo, entre comillas y desconocido', async ({ page }) => {
    await openApp(page);
    // 31-oct-2026 es sábado
    const parse = (raw, projects = [{ id: 1, title: 'Paper Alfa' }, { id: 2, title: 'Grant Gamma' }]) =>
      page.evaluate(([r, p]) => parseCapture(r, p, new Date('2026-10-31T12:00:00')), [raw, projects]);
    expect(await parse('llamar a imprenta mañana @alfa !alta')).toMatchObject({ kind: 'task', title: 'llamar a imprenta', due: '2026-11-01', projectId: 1, priority: 'Alta' });
    const due = async raw => (await parse(raw)).due;
    expect(await due('x pasado mañana')).toBe('2026-11-02');
    expect(await due('x el viernes')).toBe('2026-11-06');
    expect(await due('x sábado')).toBe('2026-11-07');          // hoy es sábado: "sábado" = el próximo
    expect(await due('x en 3 días')).toBe('2026-11-03');
    expect(await due('x en 2 semanas')).toBe('2026-11-14');
    expect(await due('x 5/11')).toBe('2026-11-05');
    expect(await due('x 15/03')).toBe('2027-03-15');            // ya pasó este año → el siguiente
    expect(await due('x 2027-01-20')).toBe('2027-01-20');
    expect(await due('x hoy')).toBe('2026-10-31');
    expect(await parse('leer sobre modelos mixtos')).toMatchObject({ kind: 'idea', title: 'leer sobre modelos mixtos', due: null });
    expect(await parse('t: comprar licencia')).toMatchObject({ kind: 'task', title: 'comprar licencia', explicit: true });
    expect(await parse('p: Nuevo estudio piloto')).toMatchObject({ kind: 'project', title: 'Nuevo estudio piloto' });
    expect(await parse('r: comité de tesis lunes')).toMatchObject({ kind: 'meeting', title: 'comité de tesis', due: '2026-11-02' });
    expect(await parse('i: idea para mañana')).toMatchObject({ kind: 'idea', due: '2026-11-01' });
    expect(await parse('x @gam')).toMatchObject({ projectId: 2 });
    expect(await parse('x @"Paper Alfa"')).toMatchObject({ projectId: 1, title: 'x' });
    const r = await parse('x @nadaquever');
    expect(r.projectId).toBeNull();
    expect(r.kind).toBe('idea');
  });
});

test.describe('Vista Hoy', () => {
  test('con la app vacía invita a capturar; lo escrito sobrevive a un re-render; «c» enfoca la captura; una idea o una tarea suelta; posponer una tarea desde ⋯ y eliminarla con deshacer', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.today-welcome')).toContainText('Empieza escribiendo');

    await page.fill('#captureInput', 'idea a medio escribir @alfa');
    await page.evaluate(() => renderToday());                   // p. ej. un cambio de área o una tarea completada en otra vista
    await expect(page.locator('#captureInput')).toHaveValue('idea a medio escribir @alfa');
    await expect(page.locator('#capturePreview')).toContainText('Idea');
    await page.fill('#captureInput', '');

    await gotoView(page, 'ideas');
    await page.locator('body').press('c');                      // el atajo «c» enfoca la captura desde cualquier vista
    await expect(page.locator('#captureInput')).toBeFocused();

    await page.fill('#captureInput', 'modelo bayesiano jerárquico');                       // texto sin más es una idea; el selector fuerza el tipo
    await page.press('#captureInput', 'Enter');
    await expect(page.locator('.toast.success').last()).toContainText('Idea guardada');
    expect(await page.evaluate(() => db.ideas.where('title').equals('modelo bayesiano jerárquico').count())).toBe(1);
    await page.locator('[data-ckind="task"]').click();
    await page.fill('#captureInput', 'tarea suelta sin proyecto');
    await page.press('#captureInput', 'Enter');
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada');
    expect(await page.evaluate(() => db.tasks.filter(t => t.title === 'tarea suelta sin proyecto').first().then(t => t.projectId))).toBeNull();

    await addTask(page, { title: 'mover esta', due: iso(-1) });                              // posponer desde el menú ⋯ y eliminar con deshacer
    await gotoView(page, 'ideas');
    await gotoView(page, 'dashboard');
    const row = page.locator('.tw-row', { hasText: 'mover esta' });
    await row.hover();
    await row.locator('.tw-more').click();
    await page.locator('.tw-menu-item', { hasText: 'mañana' }).click();
    await expect(page.locator('[data-sec="week"] .tw-row', { hasText: 'mover esta' })).toBeVisible();
    expect(await taskDue(page, 'mover esta')).toBe(iso(1));
    await page.locator('.tw-row', { hasText: 'mover esta' }).hover();
    await page.locator('.tw-row', { hasText: 'mover esta' }).locator('.tw-more').click();
    await page.locator('.tw-menu-item.danger').click();
    await expect(page.locator('.tw-row', { hasText: 'mover esta' })).toHaveCount(0);
    await page.locator('.toast-undo-btn').last().click();
    await expect(page.locator('.tw-row', { hasText: 'mover esta' })).toBeVisible();
  });

  test('con datos: fechas límite y reuniones, un paper en revisión «esperando», el panorama plegado, capturar una tarea y completar con deshacer', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);                     // Paper Alfa vence en 3 d, Dataset Beta venció hace 2 d, reunión hoy
    await gotoView(page, 'dashboard');
    await expect(page.locator('[data-sec="now"] .tw-row[data-kind="deadline"]', { hasText: 'Dataset Beta' })).toContainText('hace 2 d');
    await expect(page.locator('[data-sec="week"] .tw-row[data-kind="deadline"]', { hasText: 'Paper Alfa' })).toBeVisible();
    await expect(page.locator('.tw-row[data-kind="meeting"]', { hasText: 'Reunión de avance' })).toBeVisible();
    await expect(page.locator('.tw-row[data-kind="action"]', { hasText: 'Revisar sección 2' })).toBeVisible();

    await page.evaluate(async () => {                                                        // un paper en revisión se muestra como «esperando», sin alertas, y no cuenta como quieto
      const old = new Date(Date.now() - 100 * 86400000).toISOString();
      await db.projects.where('title').equals('Paper Alfa').modify({ submissionStatus: 'en_revision', updatedAt: old, deadline: null });
      await db.projects.where('title').equals('Dataset Beta').modify({ updatedAt: old, deadline: null });     // este sí está quieto
      await db.projects.where('title').equals('Grant Gamma').modify({ updatedAt: new Date().toISOString() });
    });
    await gotoView(page, 'ideas');
    await gotoView(page, 'dashboard');
    await expect(page.locator('.today-side')).toContainText('Esperando respuesta');
    await expect(page.locator('.today-side')).toContainText('Paper Alfa');
    await expect(page.locator('.alert-panel')).toContainText('1 proyecto sin movimiento');
    await expect(page.locator('.alert-panel')).not.toContainText('Paper Alfa');
    await expect(page.locator('#researchStatus')).toContainText('1 quieto');

    await expect(page.locator('#panoramaBody')).toBeEmpty();                                 // el panorama (métricas) está plegado y se calcula al abrirlo
    await page.locator('#panorama > summary').click();
    await expect(page.locator('#panoramaBody .dash-chart-card').first()).toBeVisible();
    await expect(page.locator('#panoramaBody')).toContainText('Distribución por tipo');
    await expect(page.locator('#panoramaBody')).not.toContainText('Actividad anual');       // el mapa de actividad se eliminó

    await page.fill('#captureInput', 'revisar figuras mañana @alfa !alta');                 // capturar una tarea con proyecto y fecha la deja en «Próximos 7 días»
    await expect(page.locator('#capturePreview')).toContainText('Tarea');
    await expect(page.locator('#capturePreview')).toContainText('Paper Alfa');
    await page.press('#captureInput', 'Enter');
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada');
    await expect(page.locator('[data-sec="week"] .tw-row', { hasText: 'revisar figuras' })).toBeVisible();
    const t = await page.evaluate(() => db.tasks.toArray().then(a => a.find(x => x.title === 'revisar figuras')));
    expect(t).toMatchObject({ due: iso(1), priority: 'Alta', done: false });
    expect(t.projectId).toBeGreaterThan(0);

    await addTask(page, { title: 'atrasada', due: iso(-3) });                               // atrasadas y de hoy primero; completar con deshacer
    await addTask(page, { title: 'para hoy', due: iso(0) });
    await addTask(page, { title: 'sin fecha' });
    await gotoView(page, 'ideas');
    await gotoView(page, 'dashboard');
    const now = page.locator('[data-sec="now"]');
    await expect(now.locator('.tw-row', { hasText: 'atrasada' })).toContainText('hace 3 d');
    await expect(now.locator('.tw-row', { hasText: 'para hoy' })).toContainText('hoy');
    await expect(page.locator('[data-sec="loose"]')).toContainText('sin fecha');
    await expect(page.locator('#todayBadge')).not.toHaveText('0');
    await now.locator('.tw-row', { hasText: 'para hoy' }).locator('.tw-check').click();
    await expect(now.locator('.tw-row', { hasText: 'para hoy' })).toHaveCount(0);
    expect(await page.evaluate(() => db.tasks.filter(x => x.title === 'para hoy').first().then(x => x.done))).toBe(true);
    await page.locator('.toast-undo-btn').last().click();
    await expect(now.locator('.tw-row', { hasText: 'para hoy' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('Tareas con enlace y notas', () => {
  test('un enlace pegado en la captura queda como enlace de la tarea; desde ⋯ se editan notas y enlace; lo peligroso se rechaza', async ({ page }) => {
    await openApp(page);
    const c = await page.evaluate(() => {
      const now = new Date('2026-10-31T12:00:00'), p = raw => parseCapture(raw, [], now, []);
      return { a: p('responder a la editora https://mail.google.com/a/b?x=1 mañana'), b: p('ver (https://example.org/doc).'), c: p('abrir javascript:alert(1) mañana'), d: p('i: leer https://example.org/x') };
    });
    expect(c.a).toMatchObject({ title: 'responder a la editora', link: 'https://mail.google.com/a/b?x=1', due: '2026-11-01', kind: 'task' });
    expect(c.b.link).toBe('https://example.org/doc');                                  // la puntuación pegada al enlace no es parte de él
    expect(c.c.link).toBeNull();                                                       // solo http(s)
    expect(c.d).toMatchObject({ kind: 'idea', link: 'https://example.org/x' });

    await page.fill('#captureInput', 'responder a la editora https://mail.google.com/mail/u/0/#inbox/18c3 mañana');
    await expect(page.locator('#capturePreview')).toContainText('🔗 enlace');
    await page.press('#captureInput', 'Enter');
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada');
    const row = page.locator('.tw-row', { hasText: 'responder a la editora' });
    const link = row.locator('a.tw-link');
    await expect(link).toHaveAttribute('href', 'https://mail.google.com/mail/u/0/#inbox/18c3');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    expect(await page.locator('#todayRoot').evaluate(() => App.view)).toBe('dashboard');            // abrir el enlace no abre nada dentro de la app
    await row.hover(); await row.locator('.tw-more').click();
    await page.locator('.tw-menu-item', { hasText: 'Notas y enlace…' }).click();
    await page.fill('#tdNotes', 'Pide la versión final con las figuras');
    await page.fill('#tdLink', 'ftp://servidor/archivo');
    await page.locator('#tdSave').click();
    await expect(page.locator('.toast.error').last()).toContainText('http');                        // no se acepta otro esquema
    await page.fill('#tdLink', 'https://example.org/carta');
    await page.locator('#tdSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Guardado');
    await expect(page.locator('.tw-row', { hasText: 'responder a la editora' }).locator('.tw-notes')).toHaveAttribute('title', /versión final/);
    await expect(page.locator('.tw-row', { hasText: 'responder a la editora' }).locator('a.tw-link')).toHaveAttribute('href', 'https://example.org/carta');
    expect(await page.evaluate(() => db.tasks.filter(t => t.title === 'responder a la editora').first().then(t => [t.notes, t.link]))).toEqual(['Pide la versión final con las figuras', 'https://example.org/carta']);

    await page.evaluate(() => db.tasks.filter(t => t.title === 'responder a la editora').modify({ link: 'javascript:alert(1)' }));   // un dato que llegó de fuera con un esquema peligroso no se pinta como enlace
    await gotoView(page, 'ideas'); await gotoView(page, 'dashboard');
    await expect(page.locator('.tw-row', { hasText: 'responder a la editora' }).locator('a.tw-link')).toHaveCount(0);
  });
});

test.describe('Contexto por área', () => {
  test('elegir un área filtra Hoy, el Tablero y Proyectos y persiste al recargar; «Sin área»; el formulario de proyecto usa el área activa', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      await _saveAreas([{ id: 1, name: 'Investigación', color: '#3b82f6' }, { id: 2, name: 'Docencia', color: '#10b981' }]);
      await db.projects.where('title').equals('Paper Alfa').modify({ areaId: 1 });
      await db.projects.where('title').equals('Dataset Beta').modify({ areaId: 1 });
      await db.projects.where('title').equals('Grant Gamma').modify({ areaId: 2 });
      const g = await db.projects.where('title').equals('Grant Gamma').first();
      await Tasks.add({ title: 'preparar clase 3', projectId: g.id, due: new Date().toISOString().slice(0, 10) });
      await Tasks.add({ title: 'tarea suelta de gestión', due: null, areaId: 2 });
      await renderContextSwitcher();
    });
    await gotoView(page, 'dashboard');
    await expect(page.locator('#mainContent')).toContainText('preparar clase 3');
    await page.selectOption('#ctxSelect', '2');
    await expect(page.locator('#mainContent')).toContainText('preparar clase 3');
    await expect(page.locator('#mainContent')).toContainText('tarea suelta de gestión');
    await expect(page.locator('#mainContent')).not.toContainText('Dataset Beta');
    await expect(page.locator('.view-subtitle')).toContainText('Docencia');
    await gotoView(page, 'kanban');
    await expect(page.locator('.kanban-card')).toHaveCount(1);
    await expect(page.locator('.kanban-card')).toContainText('Grant Gamma');
    await gotoView(page, 'projects');
    await expect(page.locator('#projectsContainer')).toContainText('Grant Gamma');
    await expect(page.locator('#projectsContainer')).not.toContainText('Paper Alfa');
    await page.reload();
    await expect(page.locator('#ctxSelect')).toHaveValue('2');
    await page.selectOption('#ctxSelect', 'all');
    await gotoView(page, 'kanban');
    await expect(page.locator('.kanban-card')).toHaveCount(3);

    await page.evaluate(() => db.projects.where('title').equals('Grant Gamma').modify({ areaId: null }));      // «Sin área» y el formulario de proyecto usa el área activa
    await page.selectOption('#ctxSelect', 'none');
    await gotoView(page, 'kanban');
    await expect(page.locator('.kanban-card')).toHaveCount(1);
    await page.selectOption('#ctxSelect', '1');
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="blank"]').click();
    await expect(page.locator('#mp-area')).toHaveValue('1');
  });

  test('sin áreas definidas el selector invita a crearlas, y el botón crea las sugeridas', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#ctxCreate')).toBeVisible();
    await page.locator('#ctxCreate').click();
    await page.locator('#seedAreasBtn').click();
    await expect(page.locator('#ctxSelect option')).toHaveCount(6);       // todas + 4 sugeridas + sin área
    await expect(page.locator('#ctxSelect')).toContainText('Docencia');
  });
});

test.describe('Menú lateral y paleta', () => {
  test('menú: 6 destinos a la vista, un punto avisa de contadores pendientes en un grupo cerrado, abrir un grupo se recuerda y navegar a una vista oculta abre su grupo', async ({ page }) => {
    await openApp(page);
    for (const v of ['dashboard', 'kanban', 'ideas', 'weekly', 'network', 'settings'])           // «kanban» = Proyectos (con pestañas)
      await expect(page.locator(`.nav-item[data-view="${v}"]`)).toBeVisible();
    for (const v of ['snippets', 'meetings', 'review', 'report', 'submissions', 'filesystem'])
      await expect(page.locator(`.nav-item[data-view="${v}"]`)).toBeHidden();
    expect(await page.locator('.sidebar .nav-item:visible').count()).toBe(6);
    for (const v of ['timeline', 'nested', 'orphans', 'focus'])                                  // sin entrada propia: pestañas o integrados en Hoy
      await expect(page.locator(`.nav-item[data-view="${v}"]`)).toHaveCount(0);

    await seed(page);
    await gotoView(page, 'dashboard');
    await expect(page.locator('[data-group="people"]')).toHaveClass(/has-alert/);                // acción pendiente de reunión
    await expect(page.locator('[data-group="people"] .nav-group-dot')).toBeVisible();

    await page.locator('[data-group="library"] .nav-group-toggle').click();
    await expect(page.locator('.nav-item[data-view="snippets"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('.nav-item[data-view="snippets"]')).toBeVisible();
    await page.evaluate(() => navigate('review'));
    await expect(page.locator('.nav-item[data-view="review"]')).toBeVisible();
    await expect(page.locator('[data-group="more"] .nav-group-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  test('crear desde la paleta (Ctrl+K): lo escrito se convierte en tarea con proyecto y fecha, y con prefijo solo ofrece ese tipo', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.reload();
    await page.keyboard.press('Control+k');
    await page.fill('#paletteInput', 'enviar carta mañana @beta');
    const item = page.locator('.palette-item', { hasText: 'Crear tarea' });
    await expect(item).toContainText('Dataset Beta');
    await item.click();
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada');
    expect(await taskDue(page, 'enviar carta')).toBe(iso(1));
    await page.keyboard.press('Control+k');
    await page.fill('#paletteInput', 'p: Estudio piloto');
    await expect(page.locator('.palette-item', { hasText: 'Crear proyecto' })).toBeVisible();
    await expect(page.locator('.palette-item', { hasText: 'Crear idea' })).toHaveCount(0);
  });
});

test.describe('Revisión semanal', () => {
  test('recorre pasos, resuelve proyectos quietos y queda registrada en Hoy', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    await page.evaluate(async o => {
      await db.projects.where('title').equals('Dataset Beta').modify({ updatedAt: o });
      await db.projects.where('title').equals('Grant Gamma').modify({ updatedAt: o });
      await Tasks.add({ title: 'tarea vieja', due: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) });
    }, old);
    await gotoView(page, 'review');
    await expect(page.locator('.review-step')).toHaveCount(8);
    await expect(page.locator('.review-step', { hasText: 'Tareas atrasadas' })).toContainText('tarea vieja');
    const idle = page.locator('.review-step', { hasText: 'sin movimiento' });
    await idle.locator('.tw-row', { hasText: 'Dataset Beta' }).locator('[data-rv="keep"]').click();
    await expect(idle.locator('.tw-row', { hasText: 'Dataset Beta' })).toHaveCount(0);
    await idle.locator('.tw-row', { hasText: 'Grant Gamma' }).locator('[data-rv="archive"]').click();
    expect(await page.evaluate(() => db.projects.where('title').equals('Grant Gamma').first().then(p => p.archived))).toBe(true);
    await page.locator('#rvBulk').click();
    await page.locator('.tw-menu-item', { hasText: 'Mañana' }).click();
    await expect(page.locator('.toast.success').last()).toContainText('reprogramada');
    expect(await taskDue(page, 'tarea vieja')).toBe(iso(1));
    await page.locator('#rvDone').click();
    await expect(page.locator('.nav-item[data-view="dashboard"]')).toHaveClass(/active/);
    await expect(page.locator('#todayReview .review-age')).toHaveText('hoy');
  });
});

test.describe('Enlaces [[ ]]', () => {
  test('se convierten en enlaces que abren el elemento (los inexistentes se marcan), autocompletan al escribir «[[» y el proyecto muestra desde dónde está enlazado', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const n = new Date().toISOString();
      await db.ideas.add({ title: 'Nota enlazada', content: 'Ver [[Paper Alfa]], [[snippet ggplot|el gráfico]] y [[Fantasma]]', status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: n, updatedAt: n });
      await _buildSearchIndex();
    });
    await gotoView(page, 'ideas');
    const card = page.locator('.idea-item', { hasText: 'Nota enlazada' });
    await expect(card.locator('a.wikilink')).toHaveCount(2);
    await expect(card.locator('a.wikilink').nth(1)).toHaveText('el gráfico');
    await expect(card.locator('.wikilink-missing')).toHaveText('Fantasma');
    await card.locator('a.wikilink').first().click();
    await expect(page.locator('#inspectorBody .inspector-project-title')).toHaveText('Paper Alfa');   // no abrió la idea contenedora
    await expect(page.locator('#inspectorBody')).toContainText('Mencionado en');                      // el proyecto muestra desde dónde está enlazado
    await expect(page.locator('#inspectorBody')).toContainText('Nota enlazada');

    await page.locator('#ideaContentInput').click();                                                  // al escribir «[[» aparece un autocompletado que inserta el título
    await page.keyboard.type('Relacionado con [[Pap');
    await expect(page.locator('.wl-popup .wl-item', { hasText: 'Paper Alfa' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#ideaContentInput')).toHaveValue('Relacionado con [[Paper Alfa]]');
    await expect(page.locator('.wl-popup')).toHaveCount(0);
  });
});

test.describe('Tareas ligadas a proyectos e ideas', () => {
  test('desde el inspector del proyecto y la idea; borrar la idea o el proyecto las trata bien (con deshacer); un backup antiguo con subtareas embebidas las convierte en tareas', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const gid = await page.evaluate(() => db.projects.where('title').equals('Grant Gamma').first().then(p => p.id));      // añadir una tarea con fecha desde el inspector del proyecto
    await page.evaluate(i => inspectProject(i), gid);
    await page.locator(`#inspectorBody #stInput-${gid}`).fill('enviar informe');
    await page.locator(`#inspectorBody #stDue-${gid}`).fill(iso(2));
    await page.locator(`#inspectorBody #stAddBtn-${gid}`).click();
    await expect(page.locator('.subtask-item', { hasText: 'enviar informe' })).toBeVisible();
    await expect(page.locator('.subtask-item', { hasText: 'enviar informe' }).locator('.subtask-due')).toContainText(/\d/);
    expect(await page.evaluate(() => db.tasks.filter(t => t.title === 'enviar informe').first().then(t => [t.due, t.ideaId]))).toEqual([iso(2), null]);
    await gotoView(page, 'dashboard');
    await expect(page.locator('[data-sec="week"] .tw-row', { hasText: 'enviar informe' })).toContainText('Grant Gamma');

    const ids = await page.evaluate(async () => {                                          // las tareas de una idea llevan su proyecto y se borran con la idea
      const i = await db.ideas.where('title').equals('Idea uno').first();
      await Tasks.add({ title: 'leer paper', ideaId: i.id, projectId: i.projectId });
      return { idea: i.id, project: i.projectId };
    });
    expect(await page.evaluate(() => db.tasks.filter(t => t.title === 'leer paper').first().then(t => t.projectId))).toBe(ids.project);
    await gotoView(page, 'ideas');
    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-delete-btn').click();
    await expect.poll(() => page.evaluate(() => db.tasks.filter(t => t.title === 'leer paper').count())).toBe(0);
    await page.locator('.toast-undo-btn').last().click();
    await expect.poll(() => page.evaluate(() => db.tasks.filter(t => t.title === 'leer paper').count())).toBe(1);

    const r = await page.evaluate(async () => {                                            // al eliminar un proyecto sus tareas pasan a sueltas conservando el área
      const p = await db.projects.where('title').equals('Paper Alfa').first();
      await db.projects.update(p.id, { areaId: 7 });
      await Tasks.add({ title: 'del proyecto', projectId: p.id });
      const undo = await deleteProjectCascade(p.id);
      const t = await db.tasks.filter(t => t.title === 'del proyecto').first();
      const afterDelete = [t.projectId, t.areaId];
      await undo();
      const t2 = await db.tasks.filter(t => t.title === 'del proyecto').first();
      return { afterDelete, restored: t2.projectId === p.id };
    });
    expect(r).toEqual({ afterDelete: [null, 7], restored: true });

    const legacy = { _app: 'ResearchOS', _version: 3, kanbanColumns: [{ id: 1, title: 'A', order: 0, color: '#38bdf8' }],
      projects: [{ id: 5, title: 'Proyecto viejo', columnId: 1, type: 'Paper', priority: 'Media', subtasks: [{ id: 1, text: 'tarea A', done: false }, { id: 2, text: 'tarea B', done: true }] }],
      ideas: [{ id: 9, title: 'Idea vieja', projectId: 5, status: 'unread', subtasks: [{ id: 3, text: 'tarea C', done: false }] }] };
    await page.evaluate(t => importAllData(JSON.stringify(t)), legacy);                    // reemplaza todo: va al final
    const tasks = await page.evaluate(() => db.tasks.toArray());
    expect(tasks.map(t => t.title).sort()).toEqual(['tarea A', 'tarea B', 'tarea C']);
    expect(tasks.find(t => t.title === 'tarea A')).toMatchObject({ projectId: 5, ideaId: null, done: false });
    expect(tasks.find(t => t.title === 'tarea B').done).toBe(true);
    expect(tasks.find(t => t.title === 'tarea C')).toMatchObject({ ideaId: 9, projectId: 5 });
    expect(await page.evaluate(() => db.projects.get(5).then(p => p.subtasks))).toEqual([]);
  });

  test('migración de la base: las subtareas de una BD antigua (v4) pasan a la tabla de tareas', async ({ page }) => {
    // Se crea una BD con el esquema anterior desde una página sin la app (mismo origen) y luego se abre la app.
    await page.goto('/README.md');                                          // una página del mismo origen sin la app
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('ResearchOS_v2', 40);                  // Dexie multiplica la versión por 10
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const t of ['projects', 'ideas', 'snippets', 'snippetCollections', 'resources', 'collaborators', 'kanbanColumns', 'submissions', 'meetings', 'references'])
          db.createObjectStore(t, { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['projects', 'ideas'], 'readwrite');
        tx.objectStore('projects').add({ id: 1, title: 'Proyecto antiguo', columnId: 1, updatedAt: '2026-01-01T00:00:00.000Z',
          subtasks: [{ id: 10, text: 'subtarea uno', done: false }, { id: 11, text: 'subtarea dos', done: true }] });
        tx.objectStore('ideas').add({ id: 1, title: 'Idea antigua', projectId: 1, status: 'unread', subtasks: [{ id: 12, text: 'subtarea idea', done: false }] });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }));
    const { errors } = await openApp(page);
    const tasks = await page.evaluate(() => db.tasks.toArray());
    expect(tasks.map(t => t.title).sort()).toEqual(['subtarea dos', 'subtarea idea', 'subtarea uno']);
    expect(tasks.find(t => t.title === 'subtarea idea')).toMatchObject({ ideaId: 1, projectId: 1 });
    expect(await page.evaluate(() => db.projects.get(1).then(p => p.subtasks))).toEqual([]);
    await expect(page.locator('[data-sec="loose"]')).toContainText('subtarea uno');
    expect(errors).toEqual([]);
  });
});

test.describe('Detalles de las tarjetas y las listas', () => {
  test('la vista previa de proyectos no muestra markdown crudo, los filtros están plegados (y se abren solos si hay alguno), «Curso» existe para docencia y las tarjetas muestran «✓ hechas/total» con aviso de vencidas', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      await db.projects.where('title').equals('Paper Alfa').modify({ description: '## Objetivo General\nEvaluar **cambios** en [[Grant Gamma]] y [web](https://x.org)\n- punto' });
      const p = await db.projects.where('title').equals('Paper Alfa').first();
      await Tasks.add({ title: 'a', projectId: p.id });
      await Tasks.add({ title: 'b', projectId: p.id, due: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10) });
      const t = await db.tasks.filter(x => x.title === 'a').first();
      await Tasks.setDone(t.id, true);
    });
    await gotoView(page, 'projects');
    await expect(page.locator('.project-card-desc').first()).toBeVisible();
    const txt = (await page.locator('.project-card-desc').allInnerTexts()).find(t => t.includes('Objetivo General'));
    expect(txt).toBe('Objetivo General Evaluar cambios en Grant Gamma y web punto');
    await expect(page.locator('#projectsContainer .card', { hasText: 'Paper Alfa' }).locator('.task-pill')).toHaveText('✓ 1/2');
    await expect(page.locator('#filtersFold')).not.toHaveAttribute('open', '');
    await page.locator('#filtersFold > summary').click();
    await page.locator('[data-ftype="Paper"]').click();
    await expect(page.locator('#filtersFold')).toHaveAttribute('open', '');
    await expect(page.locator('#filtersFold > summary')).toContainText('1 activo');

    await gotoView(page, 'kanban');
    const pill = page.locator('.kanban-card', { hasText: 'Paper Alfa' }).locator('.task-pill');
    await expect(pill).toHaveText('✓ 1/2');
    await expect(pill).toHaveClass(/late/);
    await expect(page.locator('.kanban-card', { hasText: 'Grant Gamma' }).locator('.task-pill')).toHaveCount(0);
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="course"]').click();
    await expect(page.locator('#mp-type')).toHaveValue('Curso');
    await expect(page.locator('#mpCFContainer')).toContainText('Código');
  });
});
