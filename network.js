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

const NetState = (() => {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('ros-net') || '{}'); } catch { return {}; } })();
  return {
    types: { project: true, idea: true, snippet: true, ref: true, meeting: true, collab: true, area: true, task: false, ...(saved.types || {}) },
    onlyConnected: !!saved.onlyConnected, archived: !!saved.archived,
    query: '', focus: null, depth: 2, repel: 1, link: 1,
    save() { try { localStorage.setItem('ros-net', JSON.stringify({ types: this.types, onlyConnected: this.onlyConnected, archived: this.archived })); } catch {} },
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
  }
  tick() {
    const { nodes, pairs } = this, n = nodes.length;
    const a = this.alpha;
    // repulsión con rejilla (solo vecinos cercanos)
    const cell = 220, grid = new Map();
    for (let i = 0; i < n; i++) { const k = `${Math.floor(nodes[i].x / cell)},${Math.floor(nodes[i].y / cell)}`; (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    const q = 2200 * this.repel;
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
      const rest = 64 + (u.r + v.r) * 2.4, f = (d - rest) * k;
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
  graph.top = new Set([...graph.nodes].sort((a, b) => b.degree - a.degree).slice(0, Math.max(8, Math.round(graph.nodes.length * 0.18))).map(n => n.key));   // los más conectados llevan etiqueta

  const filtersOpen = NetState.filtersOpen ?? !matchMedia('(max-width: 600px)').matches;      // en el móvil, plegado: el grafo necesita la pantalla
  mainContent.innerHTML = `
    <div class="net-wrap" id="netWrap">
      <aside class="net-panel" aria-label="Filtros del grafo">
        <div class="net-title">Red de conexiones</div>
        <div class="net-sub" id="netStats"></div>
        <input class="form-input net-search" id="netSearch" type="search" placeholder="Buscar en el grafo…" aria-label="Buscar en el grafo" value="${esc(NetState.query)}">
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
        <div class="net-hint">Rueda: zoom · Arrastrar el fondo: mover · Arrastrar un nodo: recolocarlo · Clic: abrir · Doble clic: grafo local</div>
      </aside>
      <section class="net-stage" id="netStage">
        <canvas id="netCanvas" role="img" aria-label="Grafo de conexiones entre proyectos, ideas, personas y referencias"></canvas>
        <div class="net-tip" id="netTip" hidden></div>
        <div class="net-zoom">
          <button class="btn btn-ghost btn-sm" id="netZoomIn" aria-label="Acercar">＋</button>
          <button class="btn btn-ghost btn-sm" id="netZoomOut" aria-label="Alejar">－</button>
          <button class="btn btn-ghost btn-sm" id="netFit" aria-label="Centrar el grafo">⌖</button>
        </div>
        ${graph.nodes.length ? '' : `<div class="net-empty"><h3>Aún no hay nada que conectar</h3><p>Vincula ideas, reuniones y referencias a proyectos, o escribe <code>[[Título]]</code> en tus notas.</p></div>`}
      </section>
    </div>`;

  Object.assign(NetView, { graph, destroyed: false, hover: null, drag: null, matchKeys: null, tickCost: 0, lastTickAt: 0 });
  NetView.canvas = $('netCanvas'); NetView.ctx = NetView.canvas.getContext('2d');
  NetView.sim = new ForceSim(graph.nodes, graph.links);
  NetView.sim.repel = NetState.repel; NetView.sim.linkStrength = NetState.link;
  const t0 = performance.now();                                                  // pre-calentado: el grafo aparece ya casi ordenado (con tope de tiempo en grafos enormes)
  for (let i = 0; i < 120 && performance.now() - t0 < 600; i++) NetView.sim.tick();
  NetView.sim.alpha = graph.nodes.length > 1500 ? 0.5 : 0.35;
  _netResize(); _netFit(false); _netStats(); _netFocusBox(); _netApplySearch(); _netWire();
  $('netFilters').addEventListener('toggle', e => { NetState.filtersOpen = e.target.open; setTimeout(_netResize, 0); });
  window.__graph = _netDebug();
  NetView.dirty = true; NetView.raf = 0; _netLoop();
}

function _netDebug() {
  return {
    get nodes() { return NetView.graph.nodes; }, get links() { return NetView.graph.links; }, get view() { return NetView.view; },
    get hover() { return NetView.hover?.key || null; }, get focus() { return NetState.focus; }, get settled() { return NetView.sim.settled; },
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
  for (const n of ns) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
  const pad = 60, k = Math.min(1.1, Math.max(0.15, Math.min((NetView.w - pad * 2) / Math.max(1, x1 - x0), (NetView.h - pad * 2) / Math.max(1, y1 - y0))));
  NetView.view = { k, x: NetView.w / 2 - (x0 + x1) / 2 * k, y: NetView.h / 2 - (y0 + y1) / 2 * k };
  _netDirty();
}

function _netStats() {
  const el = $('netStats'); if (!el) return;
  const g = NetView.graph;
  el.textContent = `${g.nodes.length} nodos · ${g.links.length} conexiones${NetState.focus ? ' (grafo local)' : ''}`;
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
  NetView.matchKeys = q ? new Set(NetView.graph.nodes.filter(n => foldText(n.label).includes(q)).map(n => n.key)) : null;
  _netDirty();
}

function _netNodeAt(px, py) {
  const { x, y, k } = NetView.view;
  let best = null, bd = Infinity;
  for (const n of NetView.graph.nodes) {
    const dx = n.x * k + x - px, dy = n.y * k + y - py, d = Math.sqrt(dx * dx + dy * dy), rr = Math.max(n.r * k, 6) + 3;
    if (d <= rr && d < bd) { best = n; bd = d; }
  }
  return best;
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
  const active = hover ? _netNeighbors(hover.key) : null;
  const byKey = new Map(graph.nodes.map(n => [n.key, n]));
  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.k, view.k);

  // aristas
  for (const l of graph.links) {
    const a = byKey.get(l.source), b = byKey.get(l.target);
    const on = active && (active.has(l.source) && active.has(l.target) && (hover.key === l.source || hover.key === l.target));
    const dim = (active && !on) || (matchKeys && !(matchKeys.has(l.source) || matchKeys.has(l.target)));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineWidth = (on ? 1.8 : l.kind === 'link' ? 1.3 : 0.9) / Math.sqrt(view.k);
    ctx.strokeStyle = on ? '#38bdf8' : l.kind === 'link' ? 'rgba(56,189,248,.55)' : 'rgba(148,163,184,.38)';
    if (l.kind === 'link') ctx.setLineDash([4 / view.k, 3 / view.k]); else ctx.setLineDash([]);
    ctx.globalAlpha = dim ? 0.08 : 1; ctx.stroke();
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;

  // nodos
  const labelMin = graph.nodes.length > 80 ? 1.5 : graph.nodes.length > 24 ? 1.6 : 0.9;
  const topSet = graph.top;
  for (const n of graph.nodes) {
    const isHover = hover && n.key === hover.key, isNb = active?.has(n.key), isMatch = matchKeys?.has(n.key);
    const dim = (active && !isNb) || (matchKeys && !isMatch);
    const color = n.color || NET_TYPES[n.type].color;
    ctx.globalAlpha = dim ? 0.15 : 1;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    if (n.type === 'project' && (n.done || n.waiting)) { ctx.lineWidth = 1.6 / view.k; ctx.strokeStyle = n.done ? '#34d399' : '#fbbf24'; ctx.stroke(); }
    if (n.key === NetState.focus || isHover || isMatch) { ctx.lineWidth = 2.2 / view.k; ctx.strokeStyle = textColor; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2.5 / view.k, 0, Math.PI * 2); ctx.stroke(); }
    // etiqueta: al acercar, para los más conectados, vecinos del hover y coincidencias de búsqueda
    if (isHover || isNb || isMatch || n.key === NetState.focus || view.k >= labelMin || ((topSet.has(n.key) || n.type === 'project' || n.type === 'area') && view.k >= 0.5)) {
      ctx.globalAlpha = dim ? 0.2 : (isHover || isMatch ? 1 : 0.85);
      ctx.font = `${(isHover ? 12.5 : 11) / Math.max(view.k, 0.6)}px DM Sans, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.fillStyle = isHover || isMatch ? textColor : muted;
      const text = n.label.length > 34 ? n.label.slice(0, 33) + '…' : n.label, ty = n.y + n.r + 12 / Math.max(view.k, 0.6);
      ctx.lineJoin = 'round'; ctx.lineWidth = 3 / Math.max(view.k, 0.6); ctx.strokeStyle = bgColor; ctx.strokeText(text, n.x, ty);   // halo: legible sobre las aristas
      ctx.fillText(text, n.x, ty);
    }
  }
  ctx.restore(); ctx.globalAlpha = 1;
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
  const active = !sim.settled || !!NetView.drag?.node;
  if (active && now - (NetView.lastTickAt || 0) >= (NetView.tickCost || 0) * 2.5) {
    sim.tick(); NetView.tickCost = performance.now() - now; NetView.lastTickAt = performance.now(); NetView.dirty = true;
  }
  if (NetView.dirty) { NetView.dirty = false; _netDraw(); }
  if (active || NetView.dirty) NetView.raf = requestAnimationFrame(_netLoop);
}

function _netWire() {
  const c = NetView.canvas, stage = $('netStage');
  const pos = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const toWorld = p => ({ x: (p.x - NetView.view.x) / NetView.view.k, y: (p.y - NetView.view.y) / NetView.view.k });
  const zoomAt = (p, f) => {
    const v = NetView.view, k = Math.min(4, Math.max(0.12, v.k * f)), r = k / v.k;
    NetView.view = { k, x: p.x - (p.x - v.x) * r, y: p.y - (p.y - v.y) * r }; _netDirty();
  };

  c.addEventListener('wheel', e => { e.preventDefault(); zoomAt(pos(e), e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  // Gesto de pellizco (dos dedos): zoom y desplazamiento a la vez. `touches` guarda cada dedo apoyado.
  const touches = new Map();
  let pinch = null;
  const mid = () => { const [a, b] = [...touches.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };
  c.addEventListener('pointerdown', e => {
    try { c.setPointerCapture(e.pointerId); } catch {}
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
      if (n) { tip.hidden = false; tip.innerHTML = `<strong>${esc(n.label)}</strong><span>${NET_TYPES[n.type].label.replace(/s$/, '')} · ${n.degree} conexión(es)</span>`; } else tip.hidden = true;
    }
    if (n) { const tip = $('netTip'); tip.style.left = Math.min(p.x + 14, NetView.w - 220) + 'px'; tip.style.top = (p.y + 14) + 'px'; }
  });
  const end = e => {
    touches.delete(e.pointerId);
    if (pinch) { if (touches.size < 2) pinch = null; NetView.drag = null; return; }            // al soltar un dedo del pellizco no se «hace clic»
    const d = NetView.drag; NetView.drag = null;
    if (!d) return;
    if (d.node) { d.node.fx = d.node.fy = null; if (!d.moved) openEntity(d.node.type, d.node.id); }
    c.style.cursor = 'grab';
  };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  c.addEventListener('pointerleave', () => { if (!NetView.drag) { NetView.hover = null; $('netTip').hidden = true; _netDirty(); } });
  c.addEventListener('dblclick', e => {
    const n = _netNodeAt(pos(e).x, pos(e).y);
    if (n && n.type !== 'task') { NetState.focus = NetState.focus === n.key ? null : n.key; renderNetwork(); }
  });
  c.style.cursor = 'grab';

  $('netZoomIn').addEventListener('click', () => zoomAt({ x: NetView.w / 2, y: NetView.h / 2 }, 1.3));
  $('netZoomOut').addEventListener('click', () => zoomAt({ x: NetView.w / 2, y: NetView.h / 2 }, 1 / 1.3));
  $('netFit').addEventListener('click', () => _netFit());

  document.querySelectorAll('[data-net-type]').forEach(cb => cb.addEventListener('change', () => { NetState.types[cb.dataset.netType] = cb.checked; NetState.save(); renderNetwork(); }));
  $('netOnlyConnected').addEventListener('change', e => { NetState.onlyConnected = e.target.checked; NetState.save(); renderNetwork(); });
  $('netArchived').addEventListener('change', e => { NetState.archived = e.target.checked; NetState.save(); renderNetwork(); });
  $('netRepel').addEventListener('input', e => { NetState.repel = +e.target.value; NetView.sim.repel = NetState.repel; _netReheat(0.8); });
  $('netLink').addEventListener('input', e => { NetState.link = +e.target.value; NetView.sim.linkStrength = NetState.link; _netReheat(0.8); });
  $('netSearch').addEventListener('input', e => { NetState.query = e.target.value; _netApplySearch(); });
  $('netSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter' && NetView.matchKeys?.size) {                       // Enter centra el primer resultado
      const n = NetView.graph.nodes.find(n => NetView.matchKeys.has(n.key));
      NetView.view = { ...NetView.view, k: Math.max(NetView.view.k, 1.2), x: NetView.w / 2 - n.x * Math.max(NetView.view.k, 1.2), y: NetView.h / 2 - n.y * Math.max(NetView.view.k, 1.2) }; _netDirty();
    }
    if (e.key === 'Escape') { e.target.value = ''; NetState.query = ''; _netApplySearch(); e.stopPropagation(); }
  });

  const ro = new ResizeObserver(() => { if (NetView.destroyed) return ro.disconnect(); _netResize(); });
  ro.observe(stage);
}

// Al salir de la vista se detiene la simulación (no gasta CPU en segundo plano)
new MutationObserver(() => { if (NetView.canvas && !document.body.contains(NetView.canvas)) { NetView.destroyed = true; cancelAnimationFrame(NetView.raf); NetView.raf = 0; } })
  .observe(mainContent, { childList: true });
