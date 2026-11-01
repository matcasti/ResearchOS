// Pestaña «Red»: grafo de conexiones estilo Obsidian (datos → nodos/aristas, filtros, grafo local, interacción).
const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('../helpers');

// La entrada de la vista anima 200 ms (translateY): las medidas de posición deben esperar a que termine.
const settled = page => page.evaluate(() => Promise.all(document.getElementById('mainContent').getAnimations().map(a => a.finished.catch(() => {}))));
const graph = page => page.evaluate(() => ({
  nodes: window.__graph.nodes.map(n => ({ key: n.key, type: n.type, label: n.label, degree: n.degree, x: n.x, y: n.y })),
  links: window.__graph.links.map(l => ({ a: l.source, b: l.target, kind: l.kind })),
}));
const edge = (g, a, b) => g.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
const keyOf = (g, type, label) => g.nodes.find(n => n.type === type && n.label.startsWith(label))?.key;

test.describe('Pestaña Red', () => {
  test('aparece en el menú y construye nodos y conexiones desde los datos', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await expect(page.locator('#netCanvas')).toBeVisible();
    const g = await graph(page);
    const alfa = keyOf(g, 'project', 'Paper Alfa');
    // proyectos, ideas, snippet, referencia, reunión y persona
    expect(g.nodes.filter(n => n.type === 'project')).toHaveLength(3);
    expect(g.nodes.filter(n => n.type === 'idea')).toHaveLength(2);
    expect(edge(g, alfa, keyOf(g, 'idea', 'Idea uno'))).toBeTruthy();
    expect(edge(g, alfa, keyOf(g, 'snippet', 'Snippet ggplot'))).toBeTruthy();
    expect(edge(g, alfa, keyOf(g, 'meeting', 'Reunión de avance'))).toBeTruthy();
    expect(edge(g, alfa, keyOf(g, 'ref', 'García'))).toBeTruthy();
    // «Dra. Vega» es responsable del proyecto y participante de la reunión
    const vega = keyOf(g, 'collab', 'Dra. Vega');
    expect(edge(g, vega, alfa)).toBeTruthy();
    expect(edge(g, vega, keyOf(g, 'meeting', 'Reunión de avance'))).toBeTruthy();
    // la idea sin proyecto queda suelta
    expect(g.nodes.find(n => n.label === 'Idea dos').degree).toBe(0);
    // posiciones finitas y repartidas (la simulación no colapsa ni explota)
    for (const n of g.nodes) { expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true); expect(Math.abs(n.x)).toBeLessThan(5000); }
    expect(new Set(g.nodes.map(n => `${Math.round(n.x)},${Math.round(n.y)}`)).size).toBe(g.nodes.length);
    expect(errors).toEqual([]);
  });

  test('los filtros por tipo y «solo con conexiones» actualizan el grafo y se recuerdan', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await page.locator('[data-net-type="idea"]').uncheck();
    await expect.poll(async () => (await graph(page)).nodes.filter(n => n.type === 'idea').length).toBe(0);
    await expect(page.locator('#netStats')).toContainText('nodos');
    await page.locator('#netOnlyConnected').check();
    await expect.poll(async () => (await graph(page)).nodes.every(n => n.degree > 0)).toBe(true);
    // el tipo «Tareas» está apagado por defecto y se puede mostrar
    await page.evaluate(() => Tasks.add({ title: 'Escribir métodos', projectId: 1 }));
    await page.locator('[data-net-type="task"]').check();
    await expect.poll(async () => (await graph(page)).nodes.some(n => n.type === 'task' && n.label === 'Escribir métodos')).toBe(true);
    // la preferencia sobrevive a recargar
    await page.reload();
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
    await gotoView(page, 'network');
    await expect(page.locator('[data-net-type="idea"]')).not.toBeChecked();
    await expect(page.locator('#netOnlyConnected')).toBeChecked();
  });

  test('los enlaces [[Título]] de las notas se dibujan como aristas explícitas', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      await db.ideas.where('title').equals('Idea dos').modify({ content: 'Se relaciona con [[Grant Gamma]] y con [[Snippet ggplot]]' });
      await db.projects.where('title').equals('Dataset Beta').modify({ description: 'Insumo de [[Paper Alfa|el paper]]' });
    });
    await gotoView(page, 'network');
    const g = await graph(page);
    expect(edge(g, keyOf(g, 'idea', 'Idea dos'), keyOf(g, 'project', 'Grant Gamma'))?.kind).toBe('link');
    expect(edge(g, keyOf(g, 'idea', 'Idea dos'), keyOf(g, 'snippet', 'Snippet ggplot'))?.kind).toBe('link');
    expect(edge(g, keyOf(g, 'project', 'Dataset Beta'), keyOf(g, 'project', 'Paper Alfa'))?.kind).toBe('link');
    // un enlace a algo que no existe no genera nada
    await page.evaluate(() => db.ideas.where('title').equals('Idea dos').modify({ content: '[[No existe nada así]]' }));
    await gotoView(page, 'dashboard'); await gotoView(page, 'network');
    expect((await graph(page)).nodes.find(n => n.label === 'Idea dos').degree).toBe(0);
  });

  test('la búsqueda resalta coincidencias y Enter centra la primera', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await settled(page);
    await expect.poll(() => page.evaluate(() => window.__graph.settled), { timeout: 15000 }).toBe(true);      // sin nodos en movimiento: el centrado se mide exacto
    await page.fill('#netSearch', 'gamma');
    const gamma = keyOf(await graph(page), 'project', 'Grant Gamma');
    expect(await page.evaluate(() => [...NetView.matchKeys])).toEqual([gamma]);
    await page.press('#netSearch', 'Enter');
    await expect.poll(() => page.evaluate(() => window.__graph.animating)).toBe(false);          // la vista «vuela» hasta el resultado
    const pos = await page.evaluate(() => window.__graph.screenPos(NetView.graph.nodes.find(n => n.label === 'Grant Gamma').key));
    const box = await page.locator('#netCanvas').boundingBox();
    expect(Math.abs(pos.x - (box.x + box.width / 2))).toBeLessThan(3);
    expect(Math.abs(pos.y - (box.y + box.height / 2))).toBeLessThan(3);
    expect(await page.evaluate(() => window.__graph.selected)).toBe(gamma);                      // y queda seleccionado
    await page.press('#netSearch', 'Escape');
    expect(await page.evaluate(() => NetView.matchKeys)).toBeNull();
  });

  test('clic en un nodo abre su inspector; doble clic activa el grafo local y se vuelve atrás', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await settled(page);
    const centre = key => page.evaluate(k => window.__graph.screenPos(k), key);
    const g0 = await graph(page);
    const alfa = keyOf(g0, 'project', 'Paper Alfa');
    // pasar el ratón resalta (hover) y muestra la ficha flotante
    let p = await centre(alfa);
    await page.mouse.move(p.x, p.y);
    await expect(page.locator('#netTip')).toContainText('Paper Alfa');
    expect(await page.evaluate(() => window.__graph.hover)).toBe(alfa);
    // clic → inspector
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');
    // doble clic → grafo local alrededor del nodo
    p = await centre(alfa);
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#netUnfocus')).toBeVisible();
    await expect.poll(async () => (await graph(page)).nodes.length).toBeLessThan(g0.nodes.length);
    const local = await graph(page);
    expect(local.nodes.some(n => n.key === alfa)).toBe(true);
    expect(local.nodes.find(n => n.label === 'Idea dos')).toBeUndefined();         // no conectada
    await expect(page.locator('#netStats')).toContainText('grafo local');
    // la profundidad 1 solo trae vecinos directos
    await page.selectOption('#netDepth', '1');
    await expect(page.locator('#netDepth')).toHaveValue('1');
    await expect.poll(async () => { const d = await graph(page); return d.nodes.every(n => n.key === alfa || edge(d, alfa, n.key)); }).toBe(true);
    await page.click('#netUnfocus');
    await expect.poll(async () => (await graph(page)).nodes.length).toBe(g0.nodes.length);
  });

  test('arrastrar un nodo lo recoloca y arrastrar el fondo mueve la vista; la rueda hace zoom', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await settled(page);
    const box = await page.locator('#netCanvas').boundingBox();
    const v0 = await page.evaluate(() => ({ ...window.__graph.view }));
    // evento de rueda sintético: la emulación de rueda de WebKit headless no siempre llega al lienzo
    await page.evaluate(([x, y]) => document.getElementById('netCanvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: x, clientY: y, bubbles: true, cancelable: true })),
      [box.x + box.width / 2, box.y + box.height / 2]);
    await expect.poll(() => page.evaluate(() => window.__graph.view.k)).toBeGreaterThan(v0.k);
    // fondo (esquina inferior izquierda, lejos de los nodos): pan
    const bg = { x: box.x + 8, y: box.y + box.height - 8 };
    const before = await page.evaluate(() => ({ ...window.__graph.view }));
    await page.mouse.move(bg.x, bg.y); await page.mouse.down(); await page.mouse.move(bg.x + 40, bg.y - 25, { steps: 4 }); await page.mouse.up();
    const after = await page.evaluate(() => ({ ...window.__graph.view }));
    expect(Math.abs(after.x - before.x - 40)).toBeLessThan(1.5); expect(Math.abs(after.y - before.y + 25)).toBeLessThan(1.5);
    // nodo: se arrastra y no abre el inspector
    const g = await graph(page);
    const vega = keyOf(g, 'collab', 'Dra. Vega');
    const p = await page.evaluate(k => window.__graph.screenPos(k), vega);
    const origin = g.nodes.find(n => n.key === vega);
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 60, p.y + 40, { steps: 5 });
    // mientras se arrastra, el nodo sigue al puntero (después las fuerzas lo asientan: no se comprueba la posición final)
    await expect.poll(async () => { const m = (await graph(page)).nodes.find(n => n.key === vega); return Math.hypot(m.x - origin.x, m.y - origin.y); }).toBeGreaterThan(10);
    await page.mouse.up();
    await expect(page.locator('#inspectorBody')).not.toContainText('Vega');
  });

  test('respeta el contexto de área y los archivados', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      await _saveAreas([{ id: 1, name: 'Investigación', color: '#38bdf8' }, { id: 2, name: 'Gestión', color: '#fb923c' }]);
      await db.projects.where('title').equals('Paper Alfa').modify({ areaId: 1 });
      await db.projects.where('title').equals('Dataset Beta').modify({ areaId: 1 });
      await db.projects.where('title').equals('Grant Gamma').modify({ areaId: 2 });
    });
    await gotoView(page, 'network');
    let g = await graph(page);
    expect(g.nodes.filter(n => n.type === 'area').map(n => n.label).sort()).toEqual(['Gestión', 'Investigación']);
    expect(edge(g, keyOf(g, 'project', 'Paper Alfa'), keyOf(g, 'area', 'Investigación'))).toBeTruthy();
    // contexto «Gestión»: solo su proyecto; lo ligado a otros proyectos desaparece
    await page.evaluate(() => setAreaContext(2));
    await gotoView(page, 'network');
    g = await graph(page);
    expect(g.nodes.filter(n => n.type === 'project').map(n => n.label)).toEqual(['Grant Gamma']);
    expect(g.nodes.find(n => n.label === 'Idea uno')).toBeUndefined();
    await page.evaluate(() => setAreaContext('all'));
    // archivado: oculto salvo que se pida
    await page.evaluate(() => db.projects.where('title').equals('Dataset Beta').modify({ archived: true }));
    await gotoView(page, 'dashboard'); await gotoView(page, 'network');
    expect((await graph(page)).nodes.find(n => n.label === 'Dataset Beta')).toBeUndefined();
    await page.locator('#netArchived').check();
    await expect.poll(async () => !!(await graph(page)).nodes.find(n => n.label === 'Dataset Beta')).toBe(true);
  });

  test('sin datos muestra un estado vacío y no falla', async ({ page }) => {
    const { errors } = await openApp(page);
    await gotoView(page, 'network');
    await expect(page.locator('.net-empty')).toContainText('Aún no hay nada que conectar');
    await page.click('#netFit'); await page.click('#netZoomIn'); await page.click('#netZoomOut');
    expect(errors).toEqual([]);
  });

  test('al salir de la vista se detiene la animación y el grafo se mantiene tras sincronizar cambios', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await expect.poll(() => page.evaluate(() => window.__graph.settled), { timeout: 15000 }).toBe(true);
    await gotoView(page, 'dashboard');
    expect(await page.evaluate(() => NetView.destroyed)).toBe(true);
    await gotoView(page, 'network');
    expect(await page.evaluate(() => NetView.destroyed)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('rendimiento: 600 nodos se construyen y se asientan con soltura', async ({ page }) => {
    test.setTimeout(90000);
    await openApp(page);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      const cols = await db.kanbanColumns.orderBy('order').toArray();
      const ps = [];
      for (let i = 0; i < 40; i++) ps.push(await db.projects.add({ title: 'Proyecto ' + i, type: 'Paper', columnId: cols[0].id, status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now }));
      const ideas = [];
      for (let i = 0; i < 560; i++) ideas.push({ title: 'Idea ' + i, content: i % 9 === 0 ? `ver [[Proyecto ${i % 40}]]` : '', status: 'unread', projectId: ps[i % 40], projectIds: [ps[i % 40]], tags: [], subtasks: [], createdAt: now, updatedAt: now });
      await db.ideas.bulkAdd(ideas);
    });
    const t0 = Date.now();
    await gotoView(page, 'network');
    const built = Date.now() - t0;
    expect(built).toBeLessThan(8000);
    const g = await graph(page);
    expect(g.nodes.length).toBeGreaterThanOrEqual(600);
    for (const n of g.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    // un tick de la simulación con 600 nodos debe costar pocos milisegundos
    const ms = await page.evaluate(() => { const s = NetView.sim, t = performance.now(); for (let i = 0; i < 20; i++) s.tick(); return (performance.now() - t) / 20; });
    expect(ms).toBeLessThan(25);
  });
});

test.describe('Pestaña Red — consumo en reposo', () => {
  test('una vez asentado el grafo, el bucle de animación se duerme y los gestos lo despiertan', async ({ page }) => {
    await page.addInitScript(() => { window.__raf = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = f => { window.__raf++; return raf(f); }; });
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await expect.poll(() => page.evaluate(() => window.__graph.settled), { timeout: 15000 }).toBe(true);
    await page.waitForTimeout(400);                                          // último fotograma pendiente
    const a = await page.evaluate(() => window.__raf);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__raf) - a).toBeLessThanOrEqual(1);       // en reposo: ni un fotograma por segundo
    // el zoom y la búsqueda siguen redibujando
    const k0 = await page.evaluate(() => window.__graph.view.k);
    await page.click('#netZoomIn');
    await expect.poll(() => page.evaluate(() => window.__graph.view.k)).toBeGreaterThan(k0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__raf) - a).toBeGreaterThan(0);
    // mover una fuerza recalienta la simulación y vuelve a dormirse
    await page.locator('#netRepel').fill('2');
    await expect.poll(() => page.evaluate(() => window.__graph.settled === false || NetView.raf !== 0), { timeout: 3000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__graph.settled), { timeout: 20000 }).toBe(true);
  });
});

test.describe('Pestaña Red — gestos táctiles', () => {
  test('el pellizco de dos dedos hace zoom y desplaza sin abrir ni mover nodos', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await settled(page);
    await expect.poll(() => page.evaluate(() => window.__graph.settled), { timeout: 15000 }).toBe(true);      // sin simulación en curso: cualquier desplazamiento sería de un arrastre
    const box = await page.locator('#netCanvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const fire = (type, id, x, y) => page.evaluate(([t, i, x, y]) => document.getElementById('netCanvas').dispatchEvent(new PointerEvent(t, { pointerId: i, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: i === 1 })), [type, id, x, y]);
    const before = await page.evaluate(() => ({ ...window.__graph.view }));
    const nodes0 = (await graph(page)).nodes;
    // dos dedos en un espacio vacío (esquina) se separan: zoom ×2
    const ax = box.x + 30, ay = box.y + box.height - 60;
    await fire('pointerdown', 1, ax, ay); await fire('pointerdown', 2, ax + 40, ay);
    await fire('pointermove', 1, ax - 20, ay); await fire('pointermove', 2, ax + 60, ay);               // 40 px → 80 px de separación
    await fire('pointerup', 1, ax - 20, ay); await fire('pointerup', 2, ax + 60, ay);
    const after = await page.evaluate(() => ({ ...window.__graph.view }));
    expect(after.k / before.k).toBeCloseTo(2, 1);
    // ningún nodo se movió ni se abrió el inspector
    const drift = (await graph(page)).nodes.map(n => { const o = nodes0.find(m => m.key === n.key); return Math.hypot(n.x - o.x, n.y - o.y); });
    expect(Math.max(...drift)).toBeLessThan(1);                              // nadie fue arrastrado
    await expect(page.locator('body')).toHaveClass(/inspector-closed/);
    // un dedo sigue arrastrando el fondo después de pellizcar
    const v1 = await page.evaluate(() => ({ ...window.__graph.view }));
    await fire('pointerdown', 3, ax, ay); await fire('pointermove', 3, ax + 25, ay - 10); await fire('pointerup', 3, ax + 25, ay - 10);
    const v2 = await page.evaluate(() => ({ ...window.__graph.view }));
    expect(v2.x - v1.x).toBeCloseTo(25, 0); expect(v2.y - v1.y).toBeCloseTo(-10, 0);
    void cx; void cy;
  });
});


// ── Muchos elementos: etiquetas legibles, selección, búsqueda con lista y teclado ──────────────────────────────────────────────
const bigGraph = (page, ideas = 260) => page.evaluate(async n => {
  const now = new Date().toISOString();
  const cols = await db.kanbanColumns.orderBy('order').toArray();
  const ps = [];
  for (let i = 0; i < 24; i++) ps.push(await db.projects.add({ title: 'Proyecto de investigación número ' + i, type: 'Paper', columnId: cols[0].id, status: 'active', archived: false, starred: false, tags: [], coauthors: [], createdAt: now, updatedAt: now }));
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ title: 'Idea ' + i + ' sobre el gradiente altitudinal de la diversidad', content: '', status: 'unread', projectId: ps[i % 24], projectIds: [ps[i % 24]], tags: [], subtasks: [], createdAt: now, updatedAt: now });
  await db.ideas.bulkAdd(rows);
}, ideas);
const labels = page => page.evaluate(() => window.__graph.labels);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const waitSettled = page => expect.poll(() => page.evaluate(() => window.__graph.settled), { timeout: 20000 }).toBe(true);

test.describe('Pestaña Red — muchos elementos', () => {
  test('las etiquetas no se pisan entre sí ni salen del grafo, aunque haya cientos de nodos', async ({ page }) => {
    await openApp(page);
    await bigGraph(page);
    await gotoView(page, 'network');
    await waitSettled(page);
    const boxes = await labels(page);
    const { w, h } = await page.evaluate(() => ({ w: NetView.w, h: NetView.h }));
    expect(boxes.length).toBeGreaterThan(8);
    expect(boxes.length).toBeLessThan(260);                                              // no se intenta etiquetar todo: no cabría
    for (const b of boxes) { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0); expect(b.x + b.w).toBeLessThanOrEqual(w + 0.5); expect(b.y + b.h).toBeLessThanOrEqual(h + 0.5); }
    const clashes = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i], boxes[j])) clashes.push([boxes[i].key, boxes[j].key]);
    expect(clashes).toEqual([]);
  });

  test('los proyectos más conectados siempre llevan etiqueta (ganan a las ideas cuando falta sitio)', async ({ page }) => {
    await openApp(page);
    await bigGraph(page);
    await gotoView(page, 'network');
    await waitSettled(page);
    const top = await page.evaluate(() => NetView.graph.order.find(n => n.type === 'project').key);
    expect((await labels(page)).map(b => b.key)).toContain(top);
  });

  test('«Más» etiqueta más nodos, «Ninguna» solo lo señalado, y la elección se recuerda', async ({ page }) => {
    await openApp(page);
    await bigGraph(page);
    await gotoView(page, 'network');
    await waitSettled(page);
    const auto = (await labels(page)).length;
    await page.click('[data-net-labels="more"]');
    await expect.poll(async () => (await labels(page)).length).toBeGreaterThan(auto);
    await expect(page.locator('[data-net-labels="more"]')).toHaveAttribute('aria-checked', 'true');
    await page.click('[data-net-labels="none"]');
    await expect.poll(async () => (await labels(page)).length).toBe(0);
    // aun sin etiquetas, el nodo señalado dice cómo se llama
    const key = await page.evaluate(() => NetView.graph.order[0].key);
    const p = await page.evaluate(k => window.__graph.screenPos(k), key);
    await page.mouse.move(p.x, p.y);
    await expect.poll(async () => (await labels(page)).map(b => b.key)).toContain(key);
    // sobrevive a recargar
    await page.reload();
    await expect(page.locator('#mainContent')).not.toContainText('Iniciando ResearchOS');
    await gotoView(page, 'network');
    await expect(page.locator('[data-net-labels="none"]')).toHaveClass(/active/);
  });

  test('un grafo grande se separa solo más que uno pequeño', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    const small = await page.evaluate(() => NetView.sim.spread);
    await page.evaluate(() => db.projects.clear());
    await bigGraph(page);
    await gotoView(page, 'dashboard'); await gotoView(page, 'network');
    const big = await page.evaluate(() => NetView.sim.spread);
    expect(small).toBe(1);
    expect(big).toBeGreaterThan(1.5); expect(big).toBeLessThanOrEqual(2.2);
  });

  test('la búsqueda lista resultados: ↑ ↓ los recorren, Enter va al marcado y lo selecciona, Esc limpia y luego quita la selección', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await settled(page);
    await page.fill('#netSearch', 'idea');
    await expect(page.locator('#netResults .net-res')).toHaveCount(2);
    await expect(page.locator('#netStats')).toContainText('2 coincidencia');
    await page.press('#netSearch', 'ArrowDown');
    await expect(page.locator('#netResults .net-res.active')).toContainText('Idea dos');
    await page.press('#netSearch', 'Enter');
    await expect(page.locator('#netSel')).toBeVisible();
    await expect(page.locator('#netSel')).toContainText('Idea dos');
    expect(await page.evaluate(() => window.__graph.selected)).toBe(keyOf(await graph(page), 'idea', 'Idea dos'));
    await expect.poll(() => page.evaluate(() => window.__graph.animating)).toBe(false);
    await page.press('#netSearch', 'Escape');                                      // primero limpia la búsqueda…
    await expect(page.locator('#netResults')).toBeHidden();
    await expect(page.locator('#netSel')).toBeVisible();
    await page.press('#netSearch', 'Escape');                                      // …y luego la selección
    await expect(page.locator('#netSel')).toBeHidden();
    // una búsqueda sin resultados lo dice
    await page.fill('#netSearch', 'zzzz');
    await expect(page.locator('#netResults')).toContainText('Sin coincidencias');
    // un clic en un resultado también lleva hasta él
    await page.fill('#netSearch', 'gamma');
    await page.click('#netResults .net-res');
    await expect(page.locator('#netSel')).toContainText('Grant Gamma');
  });

  test('un clic selecciona el nodo (ficha con Abrir y Aislar); un clic en el fondo quita la selección', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await settled(page);
    const g0 = await graph(page);
    const alfa = keyOf(g0, 'project', 'Paper Alfa');
    const p = await page.evaluate(k => window.__graph.screenPos(k), alfa);
    await page.mouse.click(p.x, p.y);
    expect(await page.evaluate(() => window.__graph.selected)).toBe(alfa);
    await expect(page.locator('#netSel')).toContainText('Paper Alfa');
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');            // en escritorio sigue abriendo el inspector
    // Aislar = grafo local; la ficha pasa a ofrecer «Ver todo»
    await page.click('#netSelIsolate');
    await expect(page.locator('#netUnfocus')).toBeVisible();
    await expect(page.locator('#netSelIsolate')).toHaveText('Ver todo');
    await page.click('#netSelIsolate');
    await expect(page.locator('#netUnfocus')).toHaveCount(0);
    await expect.poll(async () => (await graph(page)).nodes.length).toBe(g0.nodes.length);
    // fondo: quita la selección
    const box = await page.locator('#netCanvas').boundingBox();
    await page.mouse.click(box.x + 8, box.y + box.height - 8);
    await expect(page.locator('#netSel')).toBeHidden();
    expect(await page.evaluate(() => window.__graph.selected)).toBeNull();
  });

  test('pasar el ratón resume de qué está rodeado el nodo', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await settled(page);
    const alfa = keyOf(await graph(page), 'project', 'Paper Alfa');
    const p = await page.evaluate(k => window.__graph.screenPos(k), alfa);
    await page.mouse.move(p.x, p.y);
    await expect(page.locator('#netTip')).toContainText(/\d+ (idea|snippet|reuni|referencia|persona)/i);
  });

  test('con el grafo enfocado: + y − acercan, las flechas desplazan, 0 lo centra y Esc quita la selección', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await settled(page);
    await page.locator('#netStage').focus();
    const k0 = await page.evaluate(() => window.__graph.view.k);
    await page.keyboard.press('+');
    await expect.poll(() => page.evaluate(() => window.__graph.view.k)).toBeGreaterThan(k0 * 1.2);
    await expect.poll(() => page.evaluate(() => window.__graph.animating)).toBe(false);
    const v = await page.evaluate(() => ({ ...window.__graph.view }));
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => window.__graph.view.x)).toBeCloseTo(v.x + 60, 0);
    await page.keyboard.press('0');
    await expect.poll(() => page.evaluate(() => window.__graph.view.k)).toBeCloseTo(k0, 1);
    await page.evaluate(() => _netSelect(NetView.graph.nodes[0].key));
    await page.locator('#netStage').focus();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__graph.selected)).toBeNull();
  });

  test('ir a un resultado es una animación que termina, se cancela al tocar el grafo y deja el bucle dormido', async ({ page }) => {
    await page.addInitScript(() => { window.__raf = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = f => { window.__raf++; return raf(f); }; });
    await openApp(page);
    await seed(page);
    await gotoView(page, 'network');
    await waitSettled(page);
    await page.fill('#netSearch', 'gamma');
    await page.press('#netSearch', 'Enter');
    expect(await page.evaluate(() => window.__graph.animating)).toBe(true);
    const box = await page.locator('#netCanvas').boundingBox();
    await page.mouse.move(box.x + 8, box.y + box.height - 8); await page.mouse.down();       // tocar el grafo cancela el vuelo
    expect(await page.evaluate(() => window.__graph.animating)).toBe(false);
    await page.mouse.up();
    await page.click('#netFit');
    await expect.poll(() => page.evaluate(() => window.__graph.animating)).toBe(false);
    await page.waitForTimeout(400);
    const a = await page.evaluate(() => window.__raf);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__raf) - a).toBeLessThanOrEqual(1);                 // terminó y se durmió
  });
});

test.describe('Pestaña Red — móvil', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('tocar un nodo lo selecciona sin tapar el grafo con el inspector; la ficha cabe y abre el elemento', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => navigate('network'));
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'network');
    await waitSettled(page);
    const alfa = keyOf(await graph(page), 'project', 'Paper Alfa');
    const p = await page.evaluate(k => window.__graph.screenPos(k), alfa);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('#netSel')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/inspector-closed/);
    const sel = await page.locator('#netSel').boundingBox(), stage = await page.locator('#netStage').boundingBox();
    expect(sel.x).toBeGreaterThanOrEqual(stage.x); expect(sel.x + sel.width).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
    expect(sel.y + sel.height).toBeLessThanOrEqual(stage.y + stage.height + 0.5);
    await page.click('#netSelOpen');
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');
  });

  test('la lista de resultados cabe en el panel y no desborda la pantalla', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => navigate('network'));
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'network');
    await page.fill('#netSearch', 'a');
    await expect(page.locator('#netResults')).toBeVisible();
    const r = await page.locator('#netResults').boundingBox();
    expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.width).toBeLessThanOrEqual(360 + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
