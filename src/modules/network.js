// ============================================================
//  ResearchOS — Red: grafo de conexiones entre todo lo que guardas (estilo Obsidian)
//
//  Nodos: proyectos, ideas, snippets, referencias, reuniones, personas, áreas (y tareas, opcional).
//  Aristas: pertenencia a proyecto, subproyectos, responsable/coautores, participantes, tareas asignadas
//           y los enlaces explícitos [[Título]] que escribes en tus notas.
//  Sin dependencias: simulación de fuerzas + render en <canvas>.
// ============================================================

'use strict';

const NET_TYPES = {
  project: { label: 'Proyectos',   color: '#38bdf8', r: 7 },
  idea:    { label: 'Ideas',       color: '#a78bfa', r: 5 },
  snippet: { label: 'Snippets',    color: '#34d399', r: 4.5 },
  ref:     { label: 'Referencias', color: '#fbbf24', r: 4.5 },
  meeting: { label: 'Reuniones',   color: '#fb923c', r: 5 },
  collab:  { label: 'Personas',    color: '#f472b6', r: 6 },
  area:    { label: 'Áreas',       color: '#94a3b8', r: 9 },
  task:    { label: 'Tareas',      color: '#64748b', r: 3.5 },
};

// Cuando no caben todas las etiquetas, ganan las de los tipos y nodos más importantes (más conectados)
const NET_PRIO = { area: 40, project: 30, collab: 22, meeting: 10, idea: 10, ref: 8, snippet: 8, task: 4 };

const NetState = (() => {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('ros-net') || '{}'); } catch { return {}; } })();
  return {
    types: { project: true, idea: true, snippet: true, ref: true, meeting: true, collab: true, area: true, task: false, ...(saved.types || {}) },
    onlyConnected: !!saved.onlyConnected, archived: !!saved.archived,
    labels: ['auto', 'more', 'none'].includes(saved.labels) ? saved.labels : 'auto',       // cuántas etiquetas dibujar: Auto (las que caben), Más, Ninguna
    query: '', focus: null, selected: null, depth: 2, repel: 1, link: 1,
    save() { try { localStorage.setItem('ros-net', JSON.stringify({ types: this.types, onlyConnected: this.onlyConnected, archived: this.archived, labels: this.labels })); } catch {} },
  };
})();

// ==============================================================
//  1) DATOS: de la base al grafo (función pura respecto a la interfaz → testeable)
// ==============================================================
async function buildGraph(opts = NetState) {
  const [projects, ideas, snippets, refs, meetings, collabs, tasks, areas] = await Promise.all([
    db.projects.toArray(), db.ideas.toArray(), db.snippets.toArray(), db.references.toArray(),
    db.meetings.toArray(), db.collaborators.toArray(), db.tasks.toArray(), _getAreas()]);

  const titleIdx = makeTitleIndex({ projects, ideas, snippets, refs, meets: meetings, collabs });   // índice propio: nunca está desfasado
  const nodes = new Map(), links = new Map();
  const node = (type, id, label, extra = {}) => {
    const key = `${type}:${id}`;
    if (!nodes.has(key)) nodes.set(key, { key, type, id, label: String(label || '—').slice(0, 60), degree: 0, ...extra });
    return nodes.get(key);
  };
  const link = (a, b, kind = 'rel') => {
    if (!a || !b || a === b) return;
    const k = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
    if (!links.has(k)) links.set(k, { source: a.key, target: b.key, kind });
    else if (kind === 'link') links.get(k).kind = 'link';          // un enlace explícito [[ ]] prevalece sobre uno estructural
  };

  const visibleProject = p => (opts.archived || !p.archived) && inContext(p);
  const pNode = Object.create(null);
  for (const p of projects.filter(visibleProject)) pNode[p.id] = node('project', p.id, p.title, { done: isFinished(p), waiting: isWaiting(p), idle: isIdle(p) });

  const areaNode = {};
  for (const a of areas) areaNode[a.id] = node('area', a.id, a.name, { color: cssColor(a.color, NET_TYPES.area.color) });
  for (const p of projects) if (pNode[p.id] && p.areaId && areaNode[p.areaId]) link(pNode[p.id], areaNode[p.areaId], 'area');
  for (const p of projects) if (pNode[p.id] && p.parentId && pNode[p.parentId]) link(pNode[p.id], pNode[p.parentId], 'parent');

  // elementos que cuelgan de proyectos; si TODOS sus proyectos quedan fuera (archivados / otra área) se omiten
  const attach = (type, rec, label, projectIds) => {
    const ids = projectIds.filter(Boolean);
    const vis = ids.filter(id => pNode[id]);
    if (ids.length && !vis.length) return null;                    // sus proyectos no se muestran
    if (!ids.length && App.areaContext !== 'all') return null;     // sin proyecto: solo en la vista de todas las áreas
    const n = node(type, rec.id, label);
    for (const id of vis) link(n, pNode[id], 'rel');
    return n;
  };
  const nodeOf = {};                                               // «tipo:id» → nodo, para resolver enlaces [[ ]]
  const reg = n => { if (n) nodeOf[n.key] = n; return n; };

  for (const i of ideas)    reg(attach('idea', i, i.title, [i.projectId, ...(i.projectIds || [])]));
  for (const s of snippets) reg(attach('snippet', s, s.title, [s.projectId, ...(s.projectIds || [])]));
  for (const r of refs)     reg(attach('ref', r, `${String(r.authors || '').split(/[;,]/)[0].trim() || r.title}${r.year ? ' ' + r.year : ''}`, [r.projectId]));
  for (const m of meetings) reg(attach('meeting', m, m.title, [m.projectId]));

  // personas: responsable, coautores y participantes de reuniones
  const findCollab = name => (nameKey(name) ? collabs.find(c => nameKey(c.name) === nameKey(name)) || collabs.find(c => sameName(c.name, name)) : null);
  {
    const cNode = c => reg(node('collab', c.id, c.name));
    for (const p of projects) {
      if (!pNode[p.id]) continue;
      const people = new Set();
      if (p.responsibleId) people.add(p.responsibleId); else { const c = findCollab(p.responsible); if (c) people.add(c.id); }
      for (const [i, name] of (p.coauthors || []).entries()) { const id = p.coauthorIds?.[i]; if (id) people.add(id); else { const c = findCollab(name); if (c) people.add(c.id); } }
      for (const id of people) { const c = collabs.find(c => c.id === id); if (c) link(cNode(c), pNode[p.id], 'person'); }
    }
    for (const m of meetings) {
      const mn = nodeOf[`meeting:${m.id}`];
      if (!mn) continue;
      for (const name of String(m.participants || '').split(',')) { const c = findCollab(name.trim()); if (c) link(cNode(c), mn, 'person'); }
    }
    // personas sin ningún vínculo: solo cuando se ve todo
    if (App.areaContext === 'all') for (const c of collabs) cNode(c);
  }

  if (opts.types.task) {
    for (const t of tasks.filter(t => !t.done)) {
      const pid = t.projectId;
      if (pid && !pNode[pid]) continue;
      if (!pid && !t.ideaId && App.areaContext !== 'all') continue;
      const tn = reg(node('task', t.id, t.title));
      if (pid) link(tn, pNode[pid], 'rel');
      if (t.ideaId && nodeOf[`idea:${t.ideaId}`]) link(tn, nodeOf[`idea:${t.ideaId}`], 'rel');
      if (t.assigneeId && opts.types.collab) { const c = collabs.find(c => c.id === t.assigneeId); if (c) link(tn, node('collab', c.id, c.name), 'person'); }
    }
  }

  // enlaces explícitos [[Título]] (en notas, descripciones y acuerdos)
  const re = /\[\[([^\[\]\n|]{1,120})(?:\|[^\]]*)?\]\]/g;
  const wiki = (source, text) => {
    if (!source || !text) return;
    for (const m of String(text).matchAll(re)) {
      const t = resolveTitle(m[1], titleIdx);
      if (!t) continue;
      const target = nodes.get(`${t.type}:${t.id}`) || (t.type === 'project' ? pNode[t.id] : null);
      if (target && target !== source) link(source, target, 'link');
    }
  };
  for (const p of projects) wiki(pNode[p.id], p.description);
  for (const i of ideas) wiki(nodeOf[`idea:${i.id}`], i.content);
  for (const s of snippets) wiki(nodeOf[`snippet:${s.id}`], s.description);
  for (const m of meetings) wiki(nodeOf[`meeting:${m.id}`], `${m.agreements || ''} ${m.title || ''}`);

  // -- filtros --
  const counts = {};
  for (const n of nodes.values()) counts[n.type] = (counts[n.type] || 0) + 1;
  if (!opts.types.task) counts.task = tasks.filter(t => !t.done && (!t.projectId || pNode[t.projectId])).length;
  let list = [...nodes.values()].filter(n => opts.types[n.type]);
  const keep = new Set(list.map(n => n.key));
  let edges = [...links.values()].filter(l => keep.has(l.source) && keep.has(l.target));
  const byKey = new Map(list.map(n => [n.key, n]));
  const deg = () => { for (const n of list) n.degree = 0; for (const l of edges) { byKey.get(l.source).degree++; byKey.get(l.target).degree++; } };
  deg();
  if (opts.onlyConnected) { list = list.filter(n => n.degree > 0); const k2 = new Set(list.map(n => n.key)); edges = edges.filter(l => k2.has(l.source) && k2.has(l.target)); deg(); }

  // grafo local: vecindad de `focus` hasta `depth` saltos
  if (opts.focus && byKey.has(opts.focus)) {
    const adj = new Map(list.map(n => [n.key, []]));
    for (const l of edges) { adj.get(l.source).push(l.target); adj.get(l.target).push(l.source); }
    const dist = new Map([[opts.focus, 0]]); const q = [opts.focus];
    while (q.length) { const u = q.shift(); if (dist.get(u) >= opts.depth) continue; for (const v of adj.get(u)) if (!dist.has(v)) { dist.set(v, dist.get(u) + 1); q.push(v); } }
    list = list.filter(n => dist.has(n.key));
    edges = edges.filter(l => dist.has(l.source) && dist.has(l.target));
    for (const n of list) n.hop = dist.get(n.key);
    deg();
  }
  return { nodes: list, links: edges, counts };
}

// ==============================================================
//  2) SIMULACIÓN DE FUERZAS
// ==============================================================
class ForceSim {
  constructor(nodes, links) {
    this.nodes = nodes; this.links = links; this.alpha = 1;
    const idx = new Map(nodes.map((n, i) => [n.key, i]));
    this.pairs = links.map(l => [idx.get(l.source), idx.get(l.target)]);
    nodes.forEach((n, i) => {                                       // posiciones iniciales deterministas (estable entre recargas y en pruebas)
      const h = _fnv(n.key), a = parseInt(h.slice(0, 4), 16) / 65535 * Math.PI * 2, rr = 30 + parseInt(h.slice(4, 8), 16) / 65535 * 160;
      n.x = n.x ?? Math.cos(a) * rr; n.y = n.y ?? Math.sin(a) * rr; n.vx = 0; n.vy = 0;
      n.r = (NET_TYPES[n.type]?.r || 5) + 1.6 * Math.sqrt(n.degree);
    });
    this.repel = 1; this.linkStrength = 1;
    this.spread = Math.min(2.2, Math.max(1, Math.sqrt(nodes.length / 70)));      // los grafos grandes se separan más solos: las etiquetas necesitan sitio
  }
  tick() {
    const { nodes, pairs } = this, n = nodes.length;
    const a = this.alpha;
    // repulsión con rejilla (solo vecinos cercanos)
    const cell = 220, grid = new Map();
    for (let i = 0; i < n; i++) { const k = `${Math.floor(nodes[i].x / cell)},${Math.floor(nodes[i].y / cell)}`; (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    const q = 2200 * this.repel * this.spread;
    for (let i = 0; i < n; i++) {
      const u = nodes[i], cx = Math.floor(u.x / cell), cy = Math.floor(u.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(`${gx},${gy}`); if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const v = nodes[j]; let dx = v.x - u.x, dy = v.y - u.y, d2 = dx * dx + dy * dy;
          if (d2 > cell * cell * 2.2) continue;
          if (d2 < 1) { dx = (i % 7) - 3 || 1; dy = (j % 5) - 2 || 1; d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2), f = q * a / d2, fx = dx / d * f, fy = dy / d * f;
          u.vx -= fx; u.vy -= fy; v.vx += fx; v.vy += fy;
          const min = u.r + v.r + 3;                                // colisión blanda
          if (d < min) { const push = (min - d) * 0.05; u.vx -= dx / d * push; u.vy -= dy / d * push; v.vx += dx / d * push; v.vy += dy / d * push; }
        }
      }
    }
    // muelles
    const k = 0.06 * this.linkStrength * a;
    for (const [i, j] of pairs) {
      const u = nodes[i], v = nodes[j]; let dx = v.x - u.x, dy = v.y - u.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = (64 + (u.r + v.r) * 2.4) * (1 + (this.spread - 1) * 0.6), f = (d - rest) * k;
      dx /= d; dy /= d;
      u.vx += dx * f; u.vy += dy * f; v.vx -= dx * f; v.vy -= dy * f;
    }
    // gravedad suave hacia el centro (mantiene juntos los componentes sueltos)
    for (const u of nodes) { u.vx -= u.x * 0.007 * a; u.vy -= u.y * 0.007 * a; }
    for (const u of nodes) {
      if (u.fx != null) { u.x = u.fx; u.y = u.fy; u.vx = u.vy = 0; continue; }
      u.vx *= 0.58; u.vy *= 0.58; u.x += u.vx; u.y += u.vy;
    }
    this.alpha *= nodes.length > 1500 ? 0.96 : 0.985;
  }
  reheat(a = 0.7) { this.alpha = Math.max(this.alpha, a); }
  get settled() { return this.alpha < 0.012; }
}

// ==============================================================
//  3) VISTA (canvas + panel de filtros)
// ==============================================================
const NetView = { sim: null, raf: 0, view: { x: 0, y: 0, k: 1 }, hover: null, drag: null, canvas: null, ctx: null, w: 0, h: 0, graph: null, matchKeys: null, destroyed: false, dirty: true };

async function renderNetwork() {
  NetView.destroyed = true; cancelAnimationFrame(NetView.raf); NetView.raf = 0;   // detiene una instancia anterior
  const graph = await buildGraph(NetState);
  const counts = graph.counts;
  graph.order = [...graph.nodes].sort((a, b) => ((NET_PRIO[b.type] || 5) + 3 * b.degree) - ((NET_PRIO[a.type] || 5) + 3 * a.degree));   // a quién se le da etiqueta primero
  if (NetState.selected && !graph.nodes.some(n => n.key === NetState.selected)) NetState.selected = null;

  const filtersOpen = NetState.filtersOpen ?? !matchMedia('(max-width: 600px)').matches;      // en el móvil, plegado: el grafo necesita la pantalla
  mainContent.innerHTML = `
    <div class="net-wrap" id="netWrap">
      <aside class="net-panel" aria-label="Filtros del grafo">
        <div class="net-title">Red de conexiones</div>
        <div class="net-sub" id="netStats"></div>
        <input class="form-input net-search" id="netSearch" type="search" placeholder="Buscar en el grafo…" aria-label="Buscar en el grafo" value="${esc(NetState.query)}"
               role="combobox" aria-expanded="false" aria-controls="netResults" aria-autocomplete="list" autocomplete="off">
        <div class="net-results" id="netResults" role="listbox" aria-label="Resultados de la búsqueda" hidden></div>
        <div class="net-seg" role="radiogroup" aria-label="Etiquetas del grafo">
          <span class="net-seg-label">Etiquetas</span>
          ${[['auto', 'Auto', 'Las que caben sin pisarse'], ['more', 'Más', 'Más etiquetas (alguna puede tapar un punto)'], ['none', 'Ninguna', 'Solo la del nodo señalado']].map(([v, l, t]) =>
            `<button type="button" role="radio" class="net-seg-btn ${NetState.labels === v ? 'active' : ''}" aria-checked="${NetState.labels === v}" data-net-labels="${v}" title="${t}">${l}</button>`).join('')}
        </div>
        <div class="net-group" id="netFocusBox"></div>
        <details class="net-filters" id="netFilters" ${filtersOpen ? 'open' : ''}>
          <summary>Filtros y fuerzas</summary>
        <div class="net-group">
          ${Object.entries(NET_TYPES).map(([t, m]) => `
            <label class="net-type"><input type="checkbox" data-net-type="${t}" ${NetState.types[t] ? 'checked' : ''}>
              <span class="net-dot" style="background:${m.color}"></span><span class="net-type-name">${m.label}</span><span class="net-count">${counts[t] || 0}</span></label>`).join('')}
        </div>
        <div class="net-group">
          <label class="net-toggle"><input type="checkbox" id="netOnlyConnected" ${NetState.onlyConnected ? 'checked' : ''}> Solo con conexiones</label>
          <label class="net-toggle"><input type="checkbox" id="netArchived" ${NetState.archived ? 'checked' : ''}> Incluir archivados</label>
        </div>
        <div class="net-group net-forces">
          <label>Repulsión <input type="range" id="netRepel" min="0.3" max="2.5" step="0.1" value="${NetState.repel}"></label>
          <label>Enlaces <input type="range" id="netLink" min="0.3" max="2.5" step="0.1" value="${NetState.link}"></label>
        </div>
        </details>
        <div class="net-hint">Rueda: zoom · Arrastrar el fondo: mover · Arrastrar un nodo: recolocarlo · Clic: seleccionar y abrir · Doble clic o «Aislar»: solo su vecindad · Esc: quitar la selección · Con el grafo enfocado: <kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd> y flechas</div>
      </aside>
      <section class="net-stage" id="netStage" tabindex="0" aria-label="Grafo: con el foco, + y − acercan, 0 lo centra y las flechas lo desplazan">
        <canvas id="netCanvas" role="img" aria-label="Grafo de conexiones entre proyectos, ideas, personas y referencias"></canvas>
        <div class="net-tip" id="netTip" hidden></div>
        <div class="net-sel" id="netSel" hidden></div>
        <div class="net-zoom">
          <button class="btn btn-ghost btn-sm" id="netZoomIn" aria-label="Acercar">＋</button>
          <button class="btn btn-ghost btn-sm" id="netZoomOut" aria-label="Alejar">－</button>
          <button class="btn btn-ghost btn-sm" id="netFit" aria-label="Centrar el grafo">⌖</button>
        </div>
        ${graph.nodes.length ? '' : `<div class="net-empty"><h3>Aún no hay nada que conectar</h3><p>Vincula ideas, reuniones y referencias a proyectos, o escribe <code>[[Título]]</code> en tus notas.</p></div>`}
      </section>
    </div>`;

  Object.assign(NetView, { graph, destroyed: false, hover: null, drag: null, matchKeys: null, tickCost: 0, lastTickAt: 0, anim: null, results: [], resIdx: 0, labelBoxes: [] });
  NetView.canvas = $('netCanvas'); NetView.ctx = NetView.canvas.getContext('2d');
  NetView.sim = new ForceSim(graph.nodes, graph.links);
  NetView.sim.repel = NetState.repel; NetView.sim.linkStrength = NetState.link;
  const t0 = performance.now();                                                  // pre-calentado: el grafo aparece ya casi ordenado (con tope de tiempo en grafos enormes)
  for (let i = 0; i < 120 && performance.now() - t0 < 600; i++) NetView.sim.tick();
  NetView.sim.alpha = graph.nodes.length > 1500 ? 0.5 : 0.35;
  _netResize(); _netFit(false); _netStats(); _netFocusBox(); _netApplySearch(); _netSelUI(); _netWire();
  $('netFilters').addEventListener('toggle', e => { NetState.filtersOpen = e.target.open; setTimeout(_netResize, 0); });
  window.__graph = _netDebug();
  NetView.dirty = true; NetView.raf = 0; _netLoop();
}

function _netDebug() {
  return {
    get nodes() { return NetView.graph.nodes; }, get links() { return NetView.graph.links; }, get view() { return NetView.view; },
    get hover() { return NetView.hover?.key || null; }, get focus() { return NetState.focus; }, get settled() { return NetView.sim.settled; },
    get selected() { return NetState.selected; }, get labels() { return NetView.labelBoxes || []; }, get animating() { return !!NetView.anim; },
    screenPos(key) { const n = NetView.graph.nodes.find(n => n.key === key); const r = NetView.canvas.getBoundingClientRect(); return n ? { x: r.left + n.x * NetView.view.k + NetView.view.x, y: r.top + n.y * NetView.view.k + NetView.view.y } : null; },
  };
}

function _netResize() {
  const stage = $('netStage'), c = NetView.canvas;
  if (!stage || !c) return;
  const dpr = window.devicePixelRatio || 1, w = stage.clientWidth, h = stage.clientHeight;
  NetView.w = w; NetView.h = h;
  c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr));
  c.style.width = w + 'px'; c.style.height = h + 'px';
  NetView.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  _netDirty();
}

function _netFit(animate = true) {
  const ns = NetView.graph.nodes;
  if (!ns.length) { NetView.view = { x: NetView.w / 2, y: NetView.h / 2, k: 1 }; return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  // Con muchos nodos, un par de sueltos muy lejos (sin conexiones) encogerían todo el grafo: se encuadra el 96 % central y los sueltos quedan al borde
  let pool = ns;
  if (ns.length > 120) {
    const lo = a => a[Math.floor(a.length * 0.02)], hi = a => a[Math.ceil(a.length * 0.98) - 1];
    const xs = ns.map(n => n.x).sort((a, b) => a - b), ys = ns.map(n => n.y).sort((a, b) => a - b);
    const bx0 = lo(xs), bx1 = hi(xs), by0 = lo(ys), by1 = hi(ys);
    pool = ns.filter(n => n.x >= bx0 && n.x <= bx1 && n.y >= by0 && n.y <= by1);
  }
  for (const n of pool) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
  const pad = 60, k = Math.min(1.1, Math.max(0.15, Math.min((NetView.w - pad * 2) / Math.max(1, x1 - x0), (NetView.h - pad * 2) / Math.max(1, y1 - y0))));
  _netMoveTo({ k, x: NetView.w / 2 - (x0 + x1) / 2 * k, y: NetView.h / 2 - (y0 + y1) / 2 * k }, { animate });
}

/**
 * Lleva la vista a `target` ({k, x, y}). Con animación el movimiento «vuela»: el punto central se desplaza y el zoom cambia de forma
 * proporcional, así no se pierde de vista dónde se está. `track` (un nodo) corrige el destino cada fotograma si el nodo aún se mueve.
 */
function _netMoveTo(target, { animate = true, track = null, ms = 420 } = {}) {
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { NetView.anim = null; NetView.view = target; _netDirty(); return; }
  NetView.anim = { from: { ...NetView.view }, to: target, track, ms, t0: performance.now() };
  _netWake();
}
function _netStepAnim(now) {
  const a = NetView.anim; if (!a) return;
  const t = Math.min(1, (now - a.t0) / a.ms), e = 1 - Math.pow(1 - t, 3);
  const to = a.track ? { k: a.to.k, x: NetView.w / 2 - a.track.x * a.to.k, y: NetView.h / 2 - a.track.y * a.to.k } : a.to;
  const c0 = { x: (NetView.w / 2 - a.from.x) / a.from.k, y: (NetView.h / 2 - a.from.y) / a.from.k }, c1 = { x: (NetView.w / 2 - to.x) / to.k, y: (NetView.h / 2 - to.y) / to.k };
  const k = a.from.k * Math.pow(to.k / a.from.k, e), cx = c0.x + (c1.x - c0.x) * e, cy = c0.y + (c1.y - c0.y) * e;
  NetView.view = t >= 1 ? { ...to } : { k, x: NetView.w / 2 - cx * k, y: NetView.h / 2 - cy * k };
  NetView.dirty = true;
  if (t >= 1) NetView.anim = null;
}

function _netStats() {
  const el = $('netStats'); if (!el) return;
  const g = NetView.graph;
  el.textContent = `${g.nodes.length} nodos · ${g.links.length} conexiones${NetState.focus ? ' (grafo local)' : ''}${NetView.matchKeys ? ` · ${NetView.matchKeys.size} coincidencia(s)` : ''}`;
}

function _netFocusBox() {
  const box = $('netFocusBox'); if (!box) return;
  const n = NetState.focus && NetView.graph.nodes.find(n => n.key === NetState.focus);
  box.innerHTML = n ? `
    <div class="net-focus"><span class="net-dot" style="background:${n.color || NET_TYPES[n.type].color}"></span><strong>${esc(n.label)}</strong></div>
    <label class="net-depth">Profundidad
      <select id="netDepth">${[1, 2, 3, 4].map(d => `<option value="${d}" ${NetState.depth === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
    <button class="btn btn-ghost btn-sm" id="netUnfocus">← Ver todo el grafo</button>` : '';
  $('netDepth')?.addEventListener('change', e => { NetState.depth = +e.target.value; renderNetwork(); });
  $('netUnfocus')?.addEventListener('click', () => { NetState.focus = null; renderNetwork(); });
}

function _netApplySearch() {
  const q = foldText(NetState.query).trim();
  const hits = q ? NetView.graph.nodes.filter(n => foldText(n.label).includes(q)) : [];
  NetView.matchKeys = q ? new Set(hits.map(n => n.key)) : null;
  // primero los que empiezan por lo escrito y, entre iguales, los más conectados
  NetView.results = hits.sort((a, b) => (foldText(b.label).startsWith(q) - foldText(a.label).startsWith(q)) || b.degree - a.degree);
  NetView.resIdx = 0;
  _netResultsUI(); _netStats(); _netDirty();
}

const _NET_SINGULAR = t => NET_TYPES[t].label.replace(/s$/, '');
function _netResultsUI() {
  const box = $('netResults'), input = $('netSearch'); if (!box) return;
  const res = NetView.results || [];
  const open = !!NetState.query.trim();
  box.hidden = !open; input?.setAttribute('aria-expanded', String(open));
  if (!open) { box.innerHTML = ''; input?.removeAttribute('aria-activedescendant'); return; }
  if (!res.length) { box.innerHTML = '<div class="net-res-empty">Sin coincidencias en el grafo</div>'; input?.removeAttribute('aria-activedescendant'); return; }
  box.innerHTML = res.slice(0, 8).map((n, i) => `
    <button type="button" role="option" id="netRes${i}" class="net-res${i === NetView.resIdx ? ' active' : ''}" aria-selected="${i === NetView.resIdx}" data-net-res="${esc(n.key)}">
      <span class="net-dot" style="background:${n.color || NET_TYPES[n.type].color}"></span><span class="net-res-name">${esc(n.label)}</span><span class="net-res-type">${_NET_SINGULAR(n.type)}</span>
    </button>`).join('') + (res.length > 8 ? `<div class="net-res-more">+${res.length - 8} más: afina la búsqueda o usa ↑ ↓</div>` : '');
  input?.setAttribute('aria-activedescendant', `netRes${NetView.resIdx}`);
}

/** Selecciona un nodo (resalta su vecindad de forma persistente y muestra su ficha) sin abrir nada. */
function _netSelect(key) {
  NetState.selected = key || null;
  _netSelUI(); _netDirty();
}
/** Selecciona un nodo y lleva la vista hasta él. */
function _netGoTo(n) {
  _netSelect(n.key);
  const k = Math.max(NetView.view.k, 1.2);
  _netMoveTo({ k, x: NetView.w / 2 - n.x * k, y: NetView.h / 2 - n.y * k }, { track: n });
}

function _netSelUI() {
  const el = $('netSel'); if (!el) return;
  const n = NetState.selected && NetView.graph.nodes.find(n => n.key === NetState.selected);
  if (!n) { el.hidden = true; el.innerHTML = ''; return; }
  const isolated = NetState.focus === n.key;
  el.hidden = false;
  el.innerHTML = `
    <span class="net-dot" style="background:${n.color || NET_TYPES[n.type].color}"></span>
    <div class="net-sel-text"><strong>${esc(n.label)}</strong><span>${_NET_SINGULAR(n.type)} · ${n.degree} conexión(es)</span></div>
    <div class="net-sel-actions">
      <button type="button" class="btn btn-ghost btn-sm" id="netSelOpen">Abrir</button>
      ${n.type !== 'task' ? `<button type="button" class="btn btn-ghost btn-sm" id="netSelIsolate" title="${isolated ? 'Volver a mostrar todo el grafo' : 'Mostrar solo este nodo y lo que lo rodea'}">${isolated ? 'Ver todo' : 'Aislar'}</button>` : ''}
      <button type="button" class="btn btn-ghost btn-sm" id="netSelClear" aria-label="Quitar la selección">✕</button>
    </div>`;
  $('netSelOpen').addEventListener('click', () => openEntity(n.type, n.id));
  $('netSelIsolate')?.addEventListener('click', () => { NetState.focus = isolated ? null : n.key; renderNetwork(); });
  $('netSelClear').addEventListener('click', () => _netSelect(null));
}

function _netNodeAt(px, py) {
  const { x, y, k } = NetView.view;
  const coarse = matchMedia('(pointer: coarse)').matches;              // con el dedo la zona que responde es mayor
  let best = null, bd = Infinity;
  for (const n of NetView.graph.nodes) {
    const dx = n.x * k + x - px, dy = n.y * k + y - py, d = Math.sqrt(dx * dx + dy * dy), rr = Math.max(n.r * k, coarse ? 11 : 6) + (coarse ? 8 : 3);
    if (d <= rr && d < bd) { best = n; bd = d; }
  }
  return best;
}

/** «3 ideas · 2 reuniones»: de qué está rodeado un nodo, para decidir antes de abrirlo. */
function _netNeighborSummary(n) {
  const byKey = new Map(NetView.graph.nodes.map(m => [m.key, m])), count = {};
  for (const key of _netNeighbors(n.key)) { if (key === n.key) continue; const m = byKey.get(key); if (m) count[m.type] = (count[m.type] || 0) + 1; }
  const parts = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, c]) => `${c} ${(c === 1 ? _NET_SINGULAR(t) : NET_TYPES[t].label).toLowerCase()}`);
  return parts.length ? `<span>${esc(parts.join(' · '))}</span>` : '';
}

function _netNeighbors(key) {
  const s = new Set([key]);
  for (const l of NetView.graph.links) { if (l.source === key) s.add(l.target); else if (l.target === key) s.add(l.source); }
  return s;
}

function _netDraw() {
  const { ctx, w, h, view, graph, hover, matchKeys } = NetView;
  ctx.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.body), textColor = cs.getPropertyValue('--text-1').trim() || '#dde8f6', muted = cs.getPropertyValue('--text-2').trim() || '#9db4d0', bgColor = cs.getPropertyValue('--bg-base').trim() || '#06090f';
  const sel = NetState.selected;
  const lit = hover?.key || sel;                                    // lo resaltado: el nodo bajo el ratón o, si no hay, el seleccionado
  const active = lit ? _netNeighbors(lit) : null;
  const byKey = new Map(graph.nodes.map(n => [n.key, n]));
  const sparse = graph.links.length > 260 ? Math.max(0.3, 260 / graph.links.length) : 1;     // con muchas aristas, más tenues: el fondo no tapa lo importante
  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.k, view.k);

  // aristas
  for (const l of graph.links) {
    const a = byKey.get(l.source), b = byKey.get(l.target);
    const on = active && (lit === l.source || lit === l.target);
    const dim = (active && !on) || (matchKeys && !(matchKeys.has(l.source) || matchKeys.has(l.target)));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineWidth = (on ? 1.8 : l.kind === 'link' ? 1.3 : 0.9) / Math.sqrt(view.k);
    ctx.strokeStyle = on ? '#38bdf8' : l.kind === 'link' ? 'rgba(56,189,248,.55)' : 'rgba(148,163,184,.38)';
    if (l.kind === 'link') ctx.setLineDash([4 / view.k, 3 / view.k]); else ctx.setLineDash([]);
    ctx.globalAlpha = dim ? 0.06 : on ? 1 : sparse; ctx.stroke();
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;

  // nodos
  for (const n of graph.nodes) {
    const isHover = hover && n.key === hover.key, isNb = active?.has(n.key), isMatch = matchKeys?.has(n.key);
    const dim = (active && !isNb) || (matchKeys && !isMatch);
    const color = n.color || NET_TYPES[n.type].color;
    ctx.globalAlpha = dim ? 0.15 : 1;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    if (n.type === 'project' && (n.done || n.waiting)) { ctx.lineWidth = 1.6 / view.k; ctx.strokeStyle = n.done ? '#34d399' : '#fbbf24'; ctx.stroke(); }
    if (n.key === sel) { ctx.lineWidth = 2.6 / view.k; ctx.strokeStyle = '#38bdf8'; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3.5 / view.k, 0, Math.PI * 2); ctx.stroke(); }
    else if (n.key === NetState.focus || isHover || isMatch) { ctx.lineWidth = 2.2 / view.k; ctx.strokeStyle = textColor; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2.5 / view.k, 0, Math.PI * 2); ctx.stroke(); }
  }
  ctx.restore(); ctx.globalAlpha = 1;
  _netPaintLabels({ textColor, muted, bgColor, active, byKey });
}

/**
 * Etiquetas. Se colocan en pantalla (tamaño constante, sin importar el zoom) por orden de importancia y solo si no pisan a otra ya puesta:
 * primero el nodo señalado, el seleccionado y las coincidencias de la búsqueda; luego su vecindad; y, si no hay nada resaltado, el resto
 * según prioridad (áreas y proyectos, los más conectados) hasta un tope que depende del tamaño de la pantalla. Cada etiqueta prueba
 * cuatro posiciones (abajo, arriba, derecha, izquierda). Al acercar entra más sitio y aparecen más etiquetas, solas.
 */
const _netTextW = new Map();
function _netPaintLabels({ textColor, muted, bgColor, active, byKey }) {
  const { ctx, w, h, view, graph, hover, matchKeys } = NetView;
  const mode = NetState.labels, sel = NetState.selected;
  const forced = [], rest = [], seen = new Set();
  const add = (n, list, pill) => { if (n && !seen.has(n.key)) { seen.add(n.key); list.push([n, pill]); } };
  add(hover, forced, true); add(byKey.get(sel), forced, true); add(byKey.get(NetState.focus), forced, true);
  if (matchKeys) { for (const n of graph.order) if (matchKeys.has(n.key)) add(n, forced, true); }
  else if (active) { for (const n of graph.order) if (active.has(n.key)) add(n, forced, false); }
  else if (mode !== 'none') { for (const n of graph.order) add(n, rest, false); }

  const cap = Math.max(mode === 'more' ? 14 : 10, (w * h) / (mode === 'more' ? 4200 : 9500));
  const boxes = [], grid = new Map(), CELL = 96, gk = (gx, gy) => (gx + 64) * 1024 + (gy + 64);
  const cells = b => { const out = []; for (let gx = Math.floor(b.x / CELL); gx <= Math.floor((b.x + b.w) / CELL); gx++) for (let gy = Math.floor(b.y / CELL); gy <= Math.floor((b.y + b.h) / CELL); gy++) out.push(gk(gx, gy)); return out; };
  const free = b => { for (const c of cells(b)) { const arr = grid.get(c); if (arr) for (const o of arr) if (b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h) return false; } return true; };
  const put = b => { boxes.push(b); for (const c of cells(b)) (grid.get(c) || grid.set(c, []).get(c)).push(b); };
  // Lo que flota sobre el grafo (botones de zoom, ficha del nodo seleccionado) cuenta como ocupado: ninguna etiqueta queda debajo
  const cr = NetView.canvas.getBoundingClientRect();
  for (const el of [$('netSel'), document.querySelector('.net-zoom')]) {
    if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect(), b = { x: r.left - cr.left - 4, y: r.top - cr.top - 4, w: r.width + 8, h: r.height + 8 };
    for (const c of cells(b)) (grid.get(c) || grid.set(c, []).get(c)).push(b);
  }
  // Puntos de los nodos en pantalla: una etiqueta corriente no puede tapar el nodo de otro (las resaltadas sí: son lo que se busca)
  const dots = new Map();
  if (rest.length) for (const n of graph.nodes) {
    const sx = n.x * view.k + view.x, sy = n.y * view.k + view.y;
    if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;
    const c = gk(Math.floor(sx / CELL), Math.floor(sy / CELL));
    (dots.get(c) || dots.set(c, []).get(c)).push({ key: n.key, x: sx, y: sy, r: Math.max(n.r * view.k, 3) });
  }
  const coversDot = (b, own) => {
    for (let gx = Math.floor(b.x / CELL); gx <= Math.floor((b.x + b.w) / CELL); gx++) for (let gy = Math.floor(b.y / CELL); gy <= Math.floor((b.y + b.h) / CELL); gy++) {
      const arr = dots.get(gk(gx, gy)); if (!arr) continue;
      for (const d of arr) {
        if (d.key === own) continue;
        const cx = Math.min(Math.max(d.x, b.x), b.x + b.w), cy = Math.min(Math.max(d.y, b.y), b.y + b.h);
        if ((cx - d.x) ** 2 + (cy - d.y) ** 2 < d.r * d.r) return true;
      }
    }
    return false;
  };
  const place = ([n, pill], strict = false) => {
    const sx = n.x * view.k + view.x, sy = n.y * view.k + view.y;
    if (sx < -30 || sx > w + 30 || sy < -20 || sy > h + 20) return false;
    const rs = Math.max(n.r * view.k, 3), maxLen = pill ? 56 : 30;
    const text = n.label.length > maxLen ? n.label.slice(0, maxLen - 1) + '…' : n.label;
    const anchor = n.type === 'project' || n.type === 'area';          // los proyectos y las áreas son los puntos de referencia: etiqueta más marcada
    const font = `${pill ? '600 12.5px' : anchor ? '600 11.5px' : '11px'} DM Sans, system-ui, sans-serif`;
    const id = font + '|' + text;
    let tw = _netTextW.get(id);
    if (tw == null) { ctx.font = font; tw = ctx.measureText(text).width; if (_netTextW.size > 4000) _netTextW.clear(); _netTextW.set(id, tw); }
    const bw = tw + 8, bh = 16;
    for (const [bx, by] of [[sx - bw / 2, sy + rs + 2], [sx - bw / 2, sy - rs - 2 - bh], [sx + rs + 3, sy - bh / 2], [sx - rs - 3 - bw, sy - bh / 2]]) {
      const b = { x: Math.min(Math.max(bx, 2), Math.max(2, w - bw - 2)), y: Math.min(Math.max(by, 2), Math.max(2, h - bh - 2)), w: bw, h: bh, key: n.key, text, font, pill, anchor, color: n.color || NET_TYPES[n.type].color };
      if (free(b) && !(strict && !anchor && coversDot(b, n.key))) { put(b); return true; }
    }
    return false;
  };
  for (const item of forced) place(item);                           // lo resaltado no cuenta para el tope
  let shown = 0;
  for (const item of rest) { if (shown >= cap) break; if (place(item, mode !== 'more')) shown++; }      // «Más» también tapa algún punto con tal de etiquetar más

  ctx.textAlign = 'left'; ctx.lineJoin = 'round';
  for (let i = boxes.length - 1; i >= 0; i--) {                     // las «píldoras» (lo resaltado) se pintan encima de las demás
    const b = boxes[i];
    ctx.font = b.font;
    if (b.pill) {
      ctx.globalAlpha = 0.94; ctx.fillStyle = bgColor; ctx.strokeStyle = b.color; ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, 6); else ctx.rect(b.x, b.y, b.w, b.h);
      ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = textColor; ctx.fillText(b.text, b.x + 4, b.y + 12);
    } else {
      ctx.globalAlpha = 0.9; ctx.lineWidth = 3; ctx.strokeStyle = bgColor; ctx.strokeText(b.text, b.x + 4, b.y + 12);   // halo: legible sobre las aristas
      ctx.fillStyle = active || b.anchor ? textColor : muted; ctx.fillText(b.text, b.x + 4, b.y + 12);
    }
  }
  ctx.globalAlpha = 1;
  NetView.labelBoxes = boxes.map(b => ({ key: b.key, x: b.x, y: b.y, w: b.w, h: b.h }));
}

/**
 * Bucle de animación. Solo corre mientras hace falta: la simulación se frena según lo que cuesta cada paso (grafos enormes: nunca
 * ocupa más de ~30 % del hilo principal) y, una vez asentada y dibujada, el bucle se duerme —sin consumir CPU ni batería—
 * hasta que algo lo despierta (ratón, zoom, filtros, fuerzas, tamaño de la ventana).
 */
function _netWake() { if (!NetView.destroyed && !NetView.raf) NetView.raf = requestAnimationFrame(_netLoop); }
function _netDirty() { NetView.dirty = true; _netWake(); }
function _netReheat(a) { NetView.sim.reheat(a); _netWake(); }

function _netLoop() {
  NetView.raf = 0;
  if (NetView.destroyed) return;
  const sim = NetView.sim, now = performance.now();
  const simActive = !sim.settled || !!NetView.drag?.node, active = simActive || !!NetView.anim;
  if (NetView.anim) _netStepAnim(now);
  if (simActive && now - (NetView.lastTickAt || 0) >= (NetView.tickCost || 0) * 2.5) {
    sim.tick(); NetView.tickCost = performance.now() - now; NetView.lastTickAt = performance.now(); NetView.dirty = true;
  }
  if (NetView.dirty) { NetView.dirty = false; _netDraw(); }
  if (active || NetView.dirty) NetView.raf = requestAnimationFrame(_netLoop);
}

function _netWire() {
  const c = NetView.canvas, stage = $('netStage');
  const pos = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const toWorld = p => ({ x: (p.x - NetView.view.x) / NetView.view.k, y: (p.y - NetView.view.y) / NetView.view.k });
  const zoomAt = (p, f, animate = false) => {
    const v = NetView.view, k = Math.min(4, Math.max(0.12, v.k * f)), r = k / v.k;
    _netMoveTo({ k, x: p.x - (p.x - v.x) * r, y: p.y - (p.y - v.y) * r }, { animate, ms: 240 });
  };

  c.addEventListener('wheel', e => { e.preventDefault(); NetView.anim = null; zoomAt(pos(e), e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  // Gesto de pellizco (dos dedos): zoom y desplazamiento a la vez. `touches` guarda cada dedo apoyado.
  const touches = new Map();
  let pinch = null;
  const mid = () => { const [a, b] = [...touches.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };
  c.addEventListener('pointerdown', e => {
    try { c.setPointerCapture(e.pointerId); } catch {}
    NetView.anim = null;                                                        // tocar el grafo cancela cualquier desplazamiento automático
    const p = pos(e);
    touches.set(e.pointerId, p);
    if (touches.size === 2) {                                                   // el segundo dedo cancela el arrastre en curso y empieza el pellizco
      if (NetView.drag?.node) { NetView.drag.node.fx = NetView.drag.node.fy = null; }
      NetView.drag = null; pinch = mid(); return;
    }
    if (touches.size > 2) return;
    const n = _netNodeAt(p.x, p.y);
    NetView.drag = n ? { node: n, moved: false, start: p } : { pan: true, moved: false, last: p, start: p };
    if (n) { n.fx = n.x; n.fy = n.y; _netReheat(0.3); }
  });
  c.addEventListener('pointermove', e => {
    const p = pos(e), d = NetView.drag;
    if (touches.has(e.pointerId)) touches.set(e.pointerId, p);
    if (pinch && touches.size === 2) {
      const m = mid();
      zoomAt({ x: m.x, y: m.y }, m.d / pinch.d);
      NetView.view = { ...NetView.view, x: NetView.view.x + m.x - pinch.x, y: NetView.view.y + m.y - pinch.y };
      pinch = m; _netDirty(); return;
    }
    if (d) {
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 3) d.moved = true;
      if (d.node) { const w = toWorld(p); d.node.fx = w.x; d.node.fy = w.y; _netReheat(0.3); }
      else { NetView.view = { ...NetView.view, x: NetView.view.x + p.x - d.last.x, y: NetView.view.y + p.y - d.last.y }; d.last = p; }
      _netDirty(); return;
    }
    const n = _netNodeAt(p.x, p.y);
    if (n !== NetView.hover) {
      NetView.hover = n; _netDirty(); c.style.cursor = n ? 'pointer' : 'grab';
      const tip = $('netTip');
      if (n) { tip.hidden = false; tip.innerHTML = `<strong>${esc(n.label)}</strong><span>${_NET_SINGULAR(n.type)} · ${n.degree} conexión(es)</span>${_netNeighborSummary(n)}`; } else tip.hidden = true;
    }
    if (n) { const tip = $('netTip'); tip.style.left = Math.min(p.x + 14, NetView.w - 220) + 'px'; tip.style.top = (p.y + 14) + 'px'; }
  });
  const end = e => {
    touches.delete(e.pointerId);
    if (pinch) { if (touches.size < 2) pinch = null; NetView.drag = null; return; }            // al soltar un dedo del pellizco no se «hace clic»
    const d = NetView.drag; NetView.drag = null;
    if (!d) return;
    if (d.node) {
      d.node.fx = d.node.fy = null;
      if (!d.moved) {
        _netSelect(d.node.key);                                                  // queda resaltada su vecindad y con la ficha para abrirla o aislarla
        if (!matchMedia('(max-width: 600px)').matches) openEntity(d.node.type, d.node.id);   // en el móvil el inspector tapa el grafo: ahí se abre desde la ficha
      }
    } else if (d.pan && !d.moved && NetState.selected) _netSelect(null);
    c.style.cursor = 'grab';
  };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  c.addEventListener('pointerleave', () => { if (!NetView.drag) { NetView.hover = null; $('netTip').hidden = true; _netDirty(); } });
  c.addEventListener('dblclick', e => {
    const n = _netNodeAt(pos(e).x, pos(e).y);
    if (n && n.type !== 'task') { NetState.focus = NetState.focus === n.key ? null : n.key; renderNetwork(); }
  });
  c.style.cursor = 'grab';

  $('netZoomIn').addEventListener('click', () => zoomAt({ x: NetView.w / 2, y: NetView.h / 2 }, 1.3, true));
  $('netZoomOut').addEventListener('click', () => zoomAt({ x: NetView.w / 2, y: NetView.h / 2 }, 1 / 1.3, true));
  $('netFit').addEventListener('click', () => _netFit());

  // Teclado con el grafo enfocado: + − acercan y alejan, 0 centra todo, flechas desplazan, Esc quita la selección, Enter abre lo seleccionado
  stage.addEventListener('keydown', e => {
    if (e.target !== stage || e.ctrlKey || e.metaKey || e.altKey) return;
    const mid = { x: NetView.w / 2, y: NetView.h / 2 }, pan = (dx, dy) => _netMoveTo({ ...NetView.view, x: NetView.view.x + dx, y: NetView.view.y + dy }, { animate: false });
    const sel = NetState.selected && NetView.graph.nodes.find(n => n.key === NetState.selected);
    let used = true;
    if (e.key === '+' || e.key === '=') zoomAt(mid, 1.3, true);
    else if (e.key === '-' || e.key === '_') zoomAt(mid, 1 / 1.3, true);
    else if (e.key === '0') _netFit();
    else if (e.key === 'ArrowLeft') pan(60, 0); else if (e.key === 'ArrowRight') pan(-60, 0);
    else if (e.key === 'ArrowUp') pan(0, 60); else if (e.key === 'ArrowDown') pan(0, -60);
    else if (e.key === 'Escape' && sel) _netSelect(null);
    else if (e.key === 'Enter' && sel) openEntity(sel.type, sel.id);
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); NetView.drag = null; }
  });

  document.querySelectorAll('[data-net-labels]').forEach(b => b.addEventListener('click', () => {
    NetState.labels = b.dataset.netLabels; NetState.save();
    document.querySelectorAll('[data-net-labels]').forEach(x => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-checked', String(on)); });
    _netDirty();
  }));
  $('netResults').addEventListener('click', e => {
    const b = e.target.closest('[data-net-res]'); if (!b) return;
    const n = NetView.graph.nodes.find(n => n.key === b.dataset.netRes);
    if (n) _netGoTo(n);
  });

  document.querySelectorAll('[data-net-type]').forEach(cb => cb.addEventListener('change', () => { NetState.types[cb.dataset.netType] = cb.checked; NetState.save(); renderNetwork(); }));
  $('netOnlyConnected').addEventListener('change', e => { NetState.onlyConnected = e.target.checked; NetState.save(); renderNetwork(); });
  $('netArchived').addEventListener('change', e => { NetState.archived = e.target.checked; NetState.save(); renderNetwork(); });
  $('netRepel').addEventListener('input', e => { NetState.repel = +e.target.value; NetView.sim.repel = NetState.repel; _netReheat(0.8); });
  $('netLink').addEventListener('input', e => { NetState.link = +e.target.value; NetView.sim.linkStrength = NetState.link; _netReheat(0.8); });
  $('netSearch').addEventListener('input', e => { NetState.query = e.target.value; _netApplySearch(); });
  $('netSearch').addEventListener('keydown', e => {
    const shown = Math.min(8, NetView.results.length);
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown) {              // ↑ ↓ recorren los resultados
      e.preventDefault();
      NetView.resIdx = (NetView.resIdx + (e.key === 'ArrowDown' ? 1 : shown - 1)) % shown;
      _netResultsUI(); $(`netRes${NetView.resIdx}`)?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && NetView.results.length) { e.preventDefault(); _netGoTo(NetView.results[NetView.resIdx] || NetView.results[0]); }     // Enter va al resultado marcado (el primero por defecto)
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (NetState.query) { e.target.value = ''; NetState.query = ''; _netApplySearch(); }
      else if (NetState.selected) _netSelect(null);
    }
  });

  const ro = new ResizeObserver(() => { if (NetView.destroyed) return ro.disconnect(); _netResize(); });
  ro.observe(stage);
}

// Al salir de la vista se detiene la simulación (no gasta CPU en segundo plano)
new MutationObserver(() => { if (NetView.canvas && !document.body.contains(NetView.canvas)) { NetView.destroyed = true; cancelAnimationFrame(NetView.raf); NetView.raf = 0; } })
  .observe(mainContent, { childList: true });
