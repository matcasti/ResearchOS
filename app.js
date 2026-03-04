// ============================================================
//  ResearchOS — Application Core
//  Architecture: Single-Page, local-first, IndexedDB-backed.
//  No framework. Vanilla JS with event delegation.
// ============================================================

'use strict';

// ── App state ────────────────────────────────────────────────
const App = {
  view:          'dashboard',
  draggedId:     null,
  filterLang:    'all',
  lastDirHandle: null,
  // Navigation history
  navHistory:    [],
  navIndex:      -1,
  // Cross-filters for Projects
  filters:       { type: 'all', priority: 'all', column: 'all' },
  filterCollection:  'all',   // Feature 8
};

// ── DOM refs ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const mainContent    = $('mainContent');
const inspectorPanel = $('inspectorPanel');
const inspectorBody  = $('inspectorBody');
const modalOverlay   = $('modalOverlay');
const modalTitle     = $('modalTitle');
const modalContent   = $('modalContent');

// ── Auto-save Indicator ──────────────────────────────────────
const SaveIndicator = {
  _timer: null,
  show() {
    const el = $('saveIndicator'); const tx = $('saveIndicatorText');
    if (!el) return;
    el.className = 'save-indicator saving';
    if (tx) tx.textContent = 'Guardando…';
  },
  done() {
    const el = $('saveIndicator'); const tx = $('saveIndicatorText');
    if (!el) return;
    el.className = 'save-indicator saved';
    if (tx) tx.textContent = '✓ Guardado';
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      el.className = 'save-indicator';
      if (tx) tx.textContent = 'Local Only';
    }, 2200);
  },
  error() {
    const el = $('saveIndicator'); const tx = $('saveIndicatorText');
    if (!el) return;
    el.className = 'save-indicator';
    if (tx) tx.textContent = '⚠ Error';
  }
};

/** Wraps any IndexedDB write: shows saving → saved indicator. */
async function dbWrite(fn) {
  SaveIndicator.show();
  try { const r = await fn(); SaveIndicator.done(); return r; }
  catch(e) { SaveIndicator.error(); throw e; }
}

// ── Breadcrumbs ──────────────────────────────────────────────
const VIEW_LABELS = {
  dashboard: 'Dashboard', kanban: 'Kanban', projects: 'Proyectos',
  ideas: 'Ideas Inbox', snippets: 'Snippets',
  filesystem: 'FS Bridge', settings: 'Settings', timeline: 'Timeline'
};

function breadcrumbHTML(items) {
  if (!items || !items.length) return '';
  return `<div class="breadcrumb-bar" id="bcBar">
    ${items.map((it, i) => {
      const last = i === items.length - 1;
      const sep  = i > 0 ? '<span class="bc-sep">›</span>' : '';
      return last
        ? `${sep}<span class="bc-item current">${esc(it.label)}</span>`
        : `${sep}<span class="bc-item link" data-bc-nav="${it.view}">${esc(it.label)}</span>`;
    }).join('')}
  </div>`;
}

function attachBreadcrumbHandlers() {
  mainContent.querySelectorAll('[data-bc-nav]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.bcNav));
  });
}

// ══════════════════════════════════════════════════════════════
//  ROUTER
// ══════════════════════════════════════════════════════════════
function navigate(view, addToHistory = true) {
  App.view = view;
  if (addToHistory) {
    // Truncate forward stack when branching
    App.navHistory = App.navHistory.slice(0, App.navIndex + 1);
    App.navHistory.push(view);
    App.navIndex = App.navHistory.length - 1;
  }
  _updateNavHistoryBtns();
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  renderView(view);
}

function navBack() {
  if (App.navIndex > 0) {
    App.navIndex--;
    navigate(App.navHistory[App.navIndex], false);
  }
}

function navForward() {
  if (App.navIndex < App.navHistory.length - 1) {
    App.navIndex++;
    navigate(App.navHistory[App.navIndex], false);
  }
}

function _updateNavHistoryBtns() {
  const b = $('navBack');    if (b) b.disabled = App.navIndex <= 0;
  const f = $('navForward'); if (f) f.disabled = App.navIndex >= App.navHistory.length - 1;
}

async function renderView(view) {
  closeInspector();
  mainContent.innerHTML = '';

  const bcMap = {
    dashboard:  [{label:'Dashboard', view:'dashboard'}],
    kanban:     [{label:'Dashboard', view:'dashboard'}, {label:'Kanban', view:'kanban'}],
    projects:   [{label:'Dashboard', view:'dashboard'}, {label:'Proyectos', view:'projects'}],
    ideas:      [{label:'Dashboard', view:'dashboard'}, {label:'Ideas Inbox', view:'ideas'}],
    snippets:   [{label:'Dashboard', view:'dashboard'}, {label:'Snippets', view:'snippets'}],
    filesystem: [{label:'Dashboard', view:'dashboard'}, {label:'FS Bridge', view:'filesystem'}],
    settings:   [{label:'Dashboard', view:'dashboard'}, {label:'Settings', view:'settings'}],
    timeline:   [{label:'Dashboard', view:'dashboard'}, {label:'Timeline', view:'timeline'}],
    archived:   [{label:'Dashboard', view:'dashboard'}, {label:'Archivados', view:'archived'}],
    starred:    [{label:'Dashboard', view:'dashboard'}, {label:'Favoritos',  view:'starred'}],
  };

  // Render first, then inject BC at top so innerHTML overwrites don't destroy it
  switch (view) {
    case 'dashboard':  await renderDashboard();  break;
    case 'kanban':     await renderKanban();     break;
    case 'projects':   await renderProjects();   break;
    case 'ideas':      await renderIdeas();      break;
    case 'snippets':   await renderSnippets();   break;
    case 'filesystem': await renderFilesystem(); break;
    case 'settings':   await renderSettings();   break;
    case 'archived':   await renderArchived();   break;
    case 'starred':    await renderStarred();    break;
    case 'timeline':   await renderTimeline();   break;
    default:           await renderDashboard();
  }

  const bcHTML = breadcrumbHTML(bcMap[view] || []);
  if (bcHTML) {
    const wrap = document.createElement('div');
    wrap.innerHTML = bcHTML;
    const bcEl = wrap.firstElementChild;
    if (bcEl && mainContent.firstChild) {
      mainContent.insertBefore(bcEl, mainContent.firstChild);
    }
  }

  attachBreadcrumbHandlers();
  await updateBadges();
}

// ══════════════════════════════════════════════════════════════
//  VIEW: DASHBOARD
// ══════════════════════════════════════════════════════════════
async function renderDashboard() {
  const { projects, ideas, snippets, ideaUnread, recentProjects } =
    await getDashboardStats();
  const cols        = await db.kanbanColumns.orderBy('order').toArray();
  const colMap      = Object.fromEntries(cols.map(c => [c.id, c]));
  const allProjects = await db.projects.toArray();
  const today       = new Date(); today.setHours(0,0,0,0);

  // Compute deadline urgency
  const withDeadlines = allProjects
    .filter(p => p.deadline)
    .map(p => {
      const d = new Date(p.deadline + 'T00:00:00');
      const daysLeft = Math.ceil((d - today) / 86400000);
      return { ...p, daysLeft };
    })
    .filter(p => p.daysLeft <= 30)
    .sort((a,b) => a.daysLeft - b.daysLeft);

  const overdue  = withDeadlines.filter(p => p.daysLeft < 0);
  const dueSoon  = withDeadlines.filter(p => p.daysLeft >= 0 && p.daysLeft <= 7);
  const upcoming = withDeadlines.filter(p => p.daysLeft > 7 && p.daysLeft <= 30);
  const allAlert = [...withDeadlines].slice(0, 7);

  const urgencyBadge = (p) => {
    if (p.daysLeft < 0)  return `<span class="deadline-urgency urgency-overdue">Vencido</span>`;
    if (p.daysLeft === 0) return `<span class="deadline-urgency urgency-soon">Hoy</span>`;
    if (p.daysLeft <= 7) return `<span class="deadline-urgency urgency-soon">${p.daysLeft}d</span>`;
    return `<span class="deadline-urgency urgency-ok">${p.daysLeft}d</span>`;
  };

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Dashboard</div>
          <div class="view-subtitle">${new Date().toLocaleDateString('es-CL', {weekday:'long', year:'numeric', month:'long', day:'numeric'})}</div>
        </div>
        <button class="btn btn-primary" id="dashAddProject">+ Nuevo Proyecto</button>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Proyectos</div>
          <div class="stat-value stat-accent">${projects}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Ideas</div>
          <div class="stat-value stat-purple">${ideas}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Sin Revisar</div>
          <div class="stat-value stat-amber">${ideaUnread}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Snippets</div>
          <div class="stat-value stat-green">${snippets}</div>
        </div>
      </div>

      <div class="section-title">Proyectos Recientes</div>
      <div class="recent-list">
        ${recentProjects.length ? recentProjects.map(p => `
          <div class="recent-item" data-inspect-project="${p.id}">
            <span class="recent-dot" style="background:${colMap[p.columnId]?.color ?? '#888'}"></span>
            <span class="recent-title">${esc(p.title)}</span>
            <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
            <span class="recent-meta">${esc(colMap[p.columnId]?.title ?? '—')}</span>
          </div>
        `).join('') : `<div class="empty-state"><span class="empty-state-icon">◉</span>
          <h3>Sin proyectos aún</h3><p>Crea tu primer proyecto para comenzar</p></div>`}
      </div>

      ${overdue.length ? `
      <div class="workload-alert">
        ⚠ <strong>${overdue.length} proyecto(s) vencido(s)</strong>
        — requieren atención inmediata.
      </div>` : ''}

      ${allAlert.length ? `
      <div class="section-title mt-16">Carga de Trabajo — Próximos 30 días</div>
      <div class="deadline-list" id="deadlineList">
        ${allAlert.map(p => `
          <div class="deadline-item" data-inspect-project="${p.id}">
            ${urgencyBadge(p)}
            <span class="deadline-title">${esc(p.title)}</span>
            <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
            <span class="deadline-date">${formatDate(p.deadline)}</span>
          </div>`).join('')}
      </div>` : ''}

      <div class="section-title mt-16">Acciones Rápidas</div>
      <div class="quick-actions">
        <button class="btn btn-ghost" id="qAddIdea">+ Idea</button>
        <button class="btn btn-ghost" id="qAddSnippet">+ Snippet</button>
        <button class="btn btn-ghost" id="qGoKanban">Ver Kanban →</button>
        <button class="btn btn-ghost" id="qGoFS">FS Bridge →</button>
        <button class="btn btn-ghost" id="qGoTimeline">Timeline →</button>
      </div>
    </div>`;

  $('dashAddProject').addEventListener('click', showAddProjectModal);
  $('qAddIdea').addEventListener('click', showAddIdeaModal);
  $('qAddSnippet').addEventListener('click', () => { navigate('snippets'); });
  $('qGoKanban').addEventListener('click', () => navigate('kanban'));
  $('qGoTimeline')?.addEventListener('click', () => navigate('timeline'));
  $('qGoFS').addEventListener('click', () => navigate('filesystem'));
  mainContent.querySelectorAll('[data-inspect-project]').forEach(el => {
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject));
  });

  // Render heatmap
  await renderActivityHeatmap();
}

async function renderActivityHeatmap() {
  const activityMap = await getActivityHeatmap();
  const today       = new Date();
  today.setHours(12, 0, 0, 0);

  // Build 53-week grid starting from (today - 364 days), aligned to Sunday
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364);
  // Rewind to nearest Sunday
  startDate.setDate(startDate.getDate() - startDate.getDay());

  const weeks = [];
  let cur = new Date(startDate);
  while (cur <= today) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const iso  = cur.toISOString().split('T')[0];
      const cnt  = activityMap[iso] || 0;
      const lvl  = cnt === 0 ? 0 : cnt <= 2 ? 1 : cnt <= 4 ? 2 : cnt <= 7 ? 3 : 4;
      const future = cur > today;
      week.push({ iso, cnt, lvl, future, dow: cur.getDay() });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  // Month labels (one per ~4 weeks)
  const months = [];
  weeks.forEach((week, wi) => {
    const firstDay = new Date(week[0].iso + 'T12:00:00');
    if (firstDay.getDate() <= 7 || wi === 0) {
      months.push({ label: firstDay.toLocaleDateString('es-CL', { month: 'short' }), weekIdx: wi });
    }
  });

  const totalActs = Object.values(activityMap).reduce((s, v) => s + v, 0);
  const activeDays = Object.keys(activityMap).length;

  const container = mainContent.querySelector('.view');
  if (!container) return;

  container.insertAdjacentHTML('beforeend', `
    <div class="heatmap-section">
      <div class="section-title">
        Actividad anual
        <span style="font-family:var(--font-mono);font-size:.7rem;color:var(--text-3);font-weight:400;margin-left:8px">
          ${totalActs} ediciones · ${activeDays} días activos
        </span>
      </div>
      <div class="heatmap-scroll">
        <div class="heatmap-month-labels">
          ${months.map(m => `<span class="heatmap-month-label" style="margin-left:${m.weekIdx > 0 ? 0 : 0}px">${m.label}</span>`).join('')}
        </div>
        <div class="heatmap-grid" id="heatmapGrid">
          ${weeks.map(week => `
            <div class="heatmap-week">
              ${week.map(cell => cell.future
                ? `<div class="heatmap-cell" style="visibility:hidden"></div>`
                : `<div class="heatmap-cell" data-level="${cell.lvl}"
                        title="${cell.iso}: ${cell.cnt} actividad(es)"></div>`
              ).join('')}
            </div>`).join('')}
        </div>
        <div class="heatmap-legend">
          <span>Menos</span>
          ${[0,1,2,3,4].map(l => `<div class="heatmap-legend-cell heatmap-cell" data-level="${l}"></div>`).join('')}
          <span>Más</span>
        </div>
      </div>
    </div>`);
}

// ══════════════════════════════════════════════════════════════
//  VIEW: KANBAN
// ══════════════════════════════════════════════════════════════
async function renderKanban() {
  const kanbanData = await getKanbanData();

  const boardHTML = kanbanData.map(col => `
    <div class="kanban-col" data-col-id="${col.id}" id="col-${col.id}">
      <div class="kanban-col-header">
        <span class="kanban-col-dot" style="background:${col.color}"></span>
        <span class="kanban-col-title">${esc(col.title)}</span>
        <span class="kanban-col-count">${col.cards.length}</span>
      </div>
      <div class="kanban-cards" id="cards-${col.id}"
           data-col="${col.id}"
           ondragover="kanbanDragOver(event)"
           ondragleave="kanbanDragLeave(event)"
           ondrop="kanbanDrop(event)">
        ${col.cards.map(p => kanbanCardHTML(p)).join('')}
      </div>
      <button class="kanban-add-btn" data-add-col="${col.id}">+ Add card</button>
    </div>
  `).join('');

  mainContent.innerHTML = `
    <div class="kanban-view-header">
      <div>
        <div class="view-title">Kanban Board</div>
        <div class="view-subtitle">${kanbanData.reduce((s,c) => s + c.cards.length, 0)} proyectos activos</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" id="kanbanPresBtn" title="Modo presentación (F5)">⛶ Presentación</button>
        <button class="btn btn-primary" id="kanbanAddProject">+ Nuevo Proyecto</button>
      </div>
    </div>
    <div class="kanban-board">${boardHTML}</div>`;

  $('kanbanAddProject').addEventListener('click', showAddProjectModal);

  $('kanbanPresBtn').addEventListener('click', () => {
    document.body.classList.add('presentation-mode');
    document.body.classList.add('inspector-closed');
  });
  mainContent.querySelectorAll('.kanban-add-btn').forEach(btn => {
    btn.addEventListener('click', () => showAddProjectModal(+btn.dataset.addCol));
  });
  mainContent.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (!e.target.closest('.kanban-card-footer')) {
        inspectProject(+card.dataset.projectId);
      }
    });
    card.addEventListener('dragstart', kanbanDragStart);
    card.addEventListener('dragend', kanbanDragEnd);
  });
}

function kanbanCardHTML(p) {
  const deadline = p.deadline
    ? `<span class="kanban-card-date">⏱ ${formatDate(p.deadline)}</span>` : '';
  const tags = (p.tags || []).slice(0,3).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  return `
    <div class="kanban-card" draggable="true" data-project-id="${p.id}">
      <div class="kanban-card-title">${esc(p.title)}</div>
      <div class="kanban-card-meta">
        <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
        <span class="badge ${prioBadgeClass(p.priority)}">${esc(p.priority)}</span>
      </div>
      ${tags ? `<div class="project-card-tags" style="margin-bottom:6px">${tags}</div>` : ''}
      <div class="kanban-card-footer">
        <span class="kanban-card-person">👤 ${esc(p.responsible || '—')}</span>
        ${deadline}
      </div>
    </div>`;
}

// Drag & Drop
function kanbanDragStart(e) {
  App.draggedId = +e.currentTarget.dataset.projectId;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function kanbanDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
}
function kanbanDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.closest('.kanban-col')?.classList.add('drag-over');
}
function kanbanDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.closest('.kanban-col')?.classList.remove('drag-over');
  }
}
async function kanbanDrop(e) {
  e.preventDefault();
  const col       = e.currentTarget.closest('.kanban-col');
  col?.classList.remove('drag-over');
  const newColId  = +col?.dataset.colId;
  const draggedId = App.draggedId;
  App.draggedId   = null;
  if (!draggedId || !newColId) return;
  try {
    await recordColumnChange(draggedId, newColId);
    await renderKanban();
    showToast('Tarjeta movida', 'success');
  } catch (err) {
    showToast('Error al mover tarjeta', 'error');
    console.error(err);
  }
}
// Expose drag handlers globally for inline ondragover/ondrop
window.kanbanDragOver  = kanbanDragOver;
window.kanbanDragLeave = kanbanDragLeave;
window.kanbanDrop      = kanbanDrop;

// ══════════════════════════════════════════════════════════════
//  VIEW: PROJECTS
// ══════════════════════════════════════════════════════════════
async function renderProjects() {
  let allProjects = await db.projects.toArray();
  const cols      = await db.kanbanColumns.toArray();
  const colMap    = Object.fromEntries(cols.map(c => [c.id, c]));
  const f         = App.filters;

  // Apply compound filters
  let projects = allProjects.filter(p =>
    (f.type     === 'all' || p.type     === f.type) &&
    (f.priority === 'all' || p.priority === f.priority) &&
    (f.column   === 'all' || p.columnId === +f.column)
  );

  const types    = ['all','Grant','Paper','Análisis','Dataset','Presentación'];
  const prios    = ['all','Alta','Media','Baja'];
  const hasActiveFilters = f.type !== 'all' || f.priority !== 'all' || f.column !== 'all';

  const activePills = [];
  if (f.type     !== 'all') activePills.push({ key:'type',     label:`Tipo: ${f.type}` });
  if (f.priority !== 'all') activePills.push({ key:'priority', label:`Prioridad: ${f.priority}` });
  if (f.column   !== 'all') activePills.push({ key:'column',   label:`Columna: ${colMap[+f.column]?.title || f.column}` });

  mainContent.insertAdjacentHTML('beforeend', `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Proyectos</div>
          <div class="view-subtitle">${projects.length} de ${allProjects.length} proyecto(s)</div>
        </div>
        <button class="btn btn-primary" id="projAddBtn">+ Nuevo Proyecto</button>
      </div>

      <div class="cross-filter-bar">
        <div class="cross-filter-group">
          <div class="cross-filter-label">Tipo</div>
          <div class="cross-filter-chips">
            ${types.map(t => `<button class="filter-chip ${f.type===t?'active':''}" data-ftype="${t}">${t==='all'?'Todos':t}</button>`).join('')}
          </div>
        </div>
        <div class="cross-filter-group">
          <div class="cross-filter-label">Prioridad</div>
          <div class="cross-filter-chips">
            ${prios.map(pr => `<button class="filter-chip ${f.priority===pr?'active':''}${pr!=='all'?' prio-'+pr.toLowerCase():''}" data-fprio="${pr}">${pr==='all'?'Todas':pr}</button>`).join('')}
          </div>
        </div>
        <div class="cross-filter-group">
          <div class="cross-filter-label">Columna Kanban</div>
          <div class="cross-filter-chips">
            <button class="filter-chip ${f.column==='all'?'active':''}" data-fcol="all">Todas</button>
            ${cols.map(c => `<button class="filter-chip ${f.column==c.id?'active':''}" data-fcol="${c.id}">${esc(c.title)}</button>`).join('')}
          </div>
        </div>
        ${hasActiveFilters ? `<button class="btn btn-ghost btn-sm" id="clearFiltersBtn" style="align-self:flex-end">✕ Limpiar filtros</button>` : ''}
      </div>

      ${activePills.length ? `<div class="active-filters-row">
        ${activePills.map(p => `<span class="active-filter-pill" data-clear-filter="${p.key}">${esc(p.label)} ✕</span>`).join('')}
      </div>` : ''}

      <div class="projects-grid" id="projectsGrid">
        <div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-3);font-size:.8rem">
          Calculando métricas…
        </div>
      </div>
    </div>`);

  $('projAddBtn').addEventListener('click', showAddProjectModal);
  $('clearFiltersBtn')?.addEventListener('click', () => {
    App.filters = { type:'all', priority:'all', column:'all' };
    renderView('projects');
  });
  mainContent.querySelectorAll('[data-ftype]').forEach(btn => {
    btn.addEventListener('click', () => { App.filters.type = btn.dataset.ftype; renderView('projects'); });
  });
  mainContent.querySelectorAll('[data-fprio]').forEach(btn => {
    btn.addEventListener('click', () => { App.filters.priority = btn.dataset.fprio; renderView('projects'); });
  });
  mainContent.querySelectorAll('[data-fcol]').forEach(btn => {
    btn.addEventListener('click', () => { App.filters.column = btn.dataset.fcol; renderView('projects'); });
  });
  mainContent.querySelectorAll('[data-clear-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
      App.filters[pill.dataset.clearFilter] = 'all';
      renderView('projects');
    });
  });

  // Async: compute completeness for each card then render
  (async () => {
    const grid = $('projectsGrid');
    if (!grid) return;
    if (!projects.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <span class="empty-state-icon">◉</span>
        <h3>Sin proyectos</h3><p>Crea tu primer proyecto</p></div>`;
      return;
    }
    const cards = await Promise.all(
      projects.map(async p => {
        const pct = await projectCompleteness(p);
        return projectCardHTML(p, colMap[p.columnId], pct);
      })
    );
    grid.innerHTML = cards.join('');
    grid.querySelectorAll('[data-inspect-project]').forEach(el => {
      el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject));
    });
  })();
}

function projectCardHTML(p, col, completeness = null) {
  const tags   = (p.tags || []).slice(0,4).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const starEl = p.starred
    ? `<span title="Favorito" style="color:var(--amber);margin-right:4px">★</span>` : '';
  const archEl = p.archived
    ? `<span class="badge" style="background:rgba(120,120,120,.15);color:var(--text-3)">Archivado</span>` : '';
  return `
    <div class="card clickable" data-inspect-project="${p.id}">
      ${p.parentId ? `<div class="project-card-parent-label">↳ subproyecto</div>` : ''}
      <div class="project-card-header">
        <div class="project-card-title">${starEl}${esc(p.title)}</div>
        <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
          ${archEl}
          <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
        </div>
      </div>
      <div class="project-card-desc">${esc(p.description || 'Sin descripción.')}</div>
      ${tags ? `<div class="project-card-tags">${tags}</div>` : ''}
      ${completeness !== null ? completenessBarHTML(completeness) : ''}
      <div class="project-card-footer">
        <div>
          <div class="project-card-meta">👤 ${esc(p.responsible || '—')}</div>
          ${p.deadline ? `<div class="project-card-meta">⏱ ${formatDate(p.deadline)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <span class="badge ${prioBadgeClass(p.priority)}">${esc(p.priority)}</span>
          ${col ? `<span style="font-size:.65rem;color:var(--text-3);font-family:var(--font-mono)">⬡ ${esc(col.title)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
//  VIEW: IDEAS INBOX
// ══════════════════════════════════════════════════════════════
async function renderIdeas() {
  const ideas    = await db.ideas.orderBy('createdAt').reverse().toArray();
  const projects = await db.projects.toArray();
  const projMap  = Object.fromEntries(projects.map(p => [p.id, p]));

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Ideas Inbox</div>
          <div class="view-subtitle">${ideas.filter(i=>i.status==='unread').length} sin revisar</div>
        </div>
      </div>

      <!-- Quick capture -->
      <div class="inbox-capture">
        <div class="inbox-capture-title">⚡ Captura rápida</div>
        <input class="inbox-input" id="ideaTitleInput" placeholder="Título de la idea…" maxlength="200">
        <textarea class="inbox-input inbox-textarea" id="ideaContentInput" placeholder="Contenido, URL, nota… (opcional)"></textarea>
        <div class="inbox-row">
          <select class="inbox-select" id="ideaProjectSelect">
            <option value="">Sin proyecto</option>
            ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
          </select>
          <button class="btn btn-primary" id="saveIdeaBtn">Guardar</button>
        </div>
      </div>

      <!-- Ideas list -->
      <div class="ideas-list" id="ideasList">
        ${ideas.length ? ideas.map(i => ideaItemHTML(i, projMap)).join('')
          : `<div class="empty-state"><span class="empty-state-icon">◎</span>
              <h3>Inbox vacío</h3><p>Captura tu primera idea arriba</p></div>`}
      </div>
    </div>`;

  $('saveIdeaBtn').addEventListener('click', saveQuickIdea);
  $('ideaTitleInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveQuickIdea(); });

  mainContent.querySelectorAll('.idea-status-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = +btn.dataset.ideaId;
      const idea = await db.ideas.get(id);
      await db.ideas.update(id, { status: idea.status === 'reviewed' ? 'unread' : 'reviewed' });
      renderIdeas();
    });
  });

  mainContent.querySelectorAll('.idea-item').forEach(el => {
    el.addEventListener('click', () => inspectIdea(+el.dataset.ideaId));
  });

  mainContent.querySelectorAll('.idea-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('¿Eliminar esta idea?')) {
        await db.ideas.delete(+btn.dataset.ideaId);
        renderIdeas();
        showToast('Idea eliminada', 'info');
      }
    });
  });

  mainContent.querySelectorAll('.idea-star-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idea = await db.ideas.get(+btn.dataset.ideaId);
      await db.ideas.update(+btn.dataset.ideaId, { starred: !idea.starred });
      renderIdeas();
      updateBadges();
    });
  });
}

function ideaItemHTML(idea, projMap) {
  const proj = idea.projectId ? projMap[idea.projectId] : null;
  const stCount  = (idea.subtasks || []).length;
  const stDone   = (idea.subtasks || []).filter(t => t.done).length;
  return `
    <div class="idea-item ${idea.status === 'unread' ? 'idea-unread' : ''}" data-idea-id="${idea.id}">
      <button class="idea-status-btn ${idea.status === 'reviewed' ? 'reviewed' : ''}"
              data-idea-id="${idea.id}" title="Marcar como revisada"></button>
      <div class="idea-body">
        <div class="idea-title">${esc(idea.title)}</div>
        ${idea.content ? `<div class="idea-content">${esc(idea.content)}</div>` : ''}
        <div class="idea-footer">
          ${(idea.tags||[]).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
          ${proj ? `<span class="idea-linked">⬡ ${esc(proj.title)}</span>` : ''}
          ${stCount ? `<span class="subtask-count-badge">${stDone}/${stCount} ✓</span>` : ''}
          <span style="font-size:.65rem;color:var(--text-3);font-family:var(--font-mono);margin-left:auto">${relativeDate(idea.createdAt)}</span>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm idea-star-btn" data-idea-id="${idea.id}"
              title="${idea.starred ? 'Quitar favorito' : 'Marcar favorito'}"
              style="color:${idea.starred ? 'var(--amber)' : 'var(--text-3)'}">${idea.starred ? '★' : '☆'}</button>
      <button class="btn btn-ghost btn-sm idea-delete-btn" data-idea-id="${idea.id}" title="Eliminar">✕</button>
    </div>`;
}

async function saveQuickIdea() {
  const title   = $('ideaTitleInput').value.trim();
  if (!title) { showToast('Escribe un título', 'error'); return; }
  const content   = $('ideaContentInput').value.trim();
  const projectId = +$('ideaProjectSelect').value || null;
  await dbWrite(() => db.ideas.add({
    title, content, status: 'unread', projectId,
    tags: [], subtasks: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }));
  showToast('Idea guardada ✓', 'success');
  renderIdeas();
}

// ══════════════════════════════════════════════════════════════
//  VIEW: SNIPPETS
// ══════════════════════════════════════════════════════════════
const LANGS = ['all','R','Python','Bash','SQL','Other'];

async function renderSnippets() {
  const [allSnippets, projects, collections] = await Promise.all([
    db.snippets.orderBy('createdAt').reverse().toArray(),
    db.projects.toArray(),
    getCollections(),
  ]);
  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));
  const colMap  = Object.fromEntries(collections.map(c => [c.id, c]));

  // Active collection filter
  const activeColId = App.filterCollection ?? 'all';
  let snippets = allSnippets;
  if (App.filterLang !== 'all') snippets = snippets.filter(s => s.language === App.filterLang);
  if (activeColId !== 'all')    snippets = snippets.filter(s => s.collectionId === +activeColId);
  if (activeColId === 'none')   snippets = allSnippets.filter(s => !s.collectionId &&
                                  (App.filterLang === 'all' || s.language === App.filterLang));

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Snippets</div>
          <div class="view-subtitle">${snippets.length} de ${allSnippets.length} snippet(s)</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="addCollectionBtn">+ Colección</button>
          <button class="btn btn-primary" id="addSnippetBtn">+ Snippet</button>
        </div>
      </div>

      <div style="display:flex;gap:16px">
        <!-- Collections sidebar -->
        <div class="snippet-collections-panel">
          <div class="snip-col-panel-title">Colecciones</div>
          <button class="snip-col-item ${activeColId==='all'?'active':''}" data-col-filter="all">
            ◈ Todos <span style="margin-left:auto">${allSnippets.length}</span>
          </button>
          <button class="snip-col-item ${activeColId==='none'?'active':''}" data-col-filter="none">
            ⊡ Sin colección <span style="margin-left:auto">${allSnippets.filter(s=>!s.collectionId).length}</span>
          </button>
          ${collections.map(c => `
            <button class="snip-col-item ${activeColId==c.id?'active':''}" data-col-filter="${c.id}">
              <span style="width:8px;height:8px;border-radius:50%;background:${c.color};flex-shrink:0;display:inline-block"></span>
              ${esc(c.name)}
              <span style="margin-left:auto">${allSnippets.filter(s=>s.collectionId===c.id).length}</span>
            </button>`).join('')}
        </div>

        <!-- Snippet main area -->
        <div style="flex:1;min-width:0">
          <div class="lang-tabs">
            ${LANGS.map(l => `
              <button class="lang-tab ${App.filterLang===l?'active':''}"
                      data-lang="${l}">${l === 'all' ? 'Todos' : l}</button>`).join('')}
          </div>
          <div class="snippets-list">
            ${snippets.length ? snippets.map(s => snippetCardHTML(s, projMap, colMap)).join('')
              : `<div class="empty-state"><span class="empty-state-icon">⟨/⟩</span>
                  <h3>Sin snippets</h3><p>Guarda tu primer fragmento de código</p></div>`}
          </div>
        </div>
      </div>
    </div>`;

  mainContent.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  $('addSnippetBtn').addEventListener('click', showAddSnippetModal);
  $('addCollectionBtn').addEventListener('click', showAddCollectionModal);

  mainContent.querySelectorAll('[data-col-filter]').forEach(btn => {
    btn.addEventListener('click', () => { App.filterCollection = btn.dataset.colFilter; renderSnippets(); });
  });
  mainContent.querySelectorAll('.lang-tab').forEach(tab => {
    tab.addEventListener('click', () => { App.filterLang = tab.dataset.lang; renderSnippets(); });
  });
  mainContent.querySelectorAll('.copy-btn-float').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(decodeURIComponent(btn.dataset.code));
      btn.textContent = '✓ Copiado'; setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  });
  mainContent.querySelectorAll('.snippet-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('¿Eliminar este snippet?')) {
        await db.snippets.delete(+btn.dataset.id);
        renderSnippets();
        showToast('Snippet eliminado', 'info');
      }
    });
  });
  mainContent.querySelectorAll('.snippet-star-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = await db.snippets.get(+btn.dataset.id);
      await db.snippets.update(+btn.dataset.id, { starred: !s.starred });
      renderSnippets();
    });
  });

  mainContent.querySelectorAll('.snippet-edit-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = await db.snippets.get(+btn.dataset.id);
      if (s) showEditSnippetModal(s);
    });
  });

  mainContent.querySelectorAll('.snippet-card').forEach(card => {
    card.addEventListener('click', async (e) => {
      if (e.target.closest('button') || e.target.closest('.copy-btn-float')) return;
      const s = await db.snippets.get(+card.dataset.snippetId);
      if (s) inspectSnippet(s);
    });
  });
}

function snippetCardHTML(s, projMap, colMap = {}) {
  const proj     = s.projectId    ? projMap[s.projectId]    : null;
  const snipCol  = s.collectionId ? colMap[s.collectionId]  : null;
  const langCls  = `lang-${s.language || 'Other'}`;
  const encoded  = encodeURIComponent(s.code || '');
  const hlLang   = s.language === 'R' ? 'r'
                 : s.language === 'Python' ? 'python'
                 : s.language === 'Bash'   ? 'bash'
                 : s.language === 'SQL'    ? 'sql'
                 : 'plaintext';
  return `
    <div class="snippet-card" data-snippet-id="${s.id}" style="cursor:pointer">
      <div class="snippet-header">
        <span class="snippet-lang-badge ${langCls}">${esc(s.language || 'Other')}</span>
        <span class="snippet-title">${esc(s.title)}</span>
        <div class="snippet-actions">
          <button class="btn btn-ghost btn-sm snippet-star-btn" data-id="${s.id}"
                  title="${s.starred ? 'Quitar favorito' : 'Marcar favorito'}">${s.starred ? '★' : '☆'}</button>
          <button class="btn btn-ghost btn-sm snippet-edit-btn" data-id="${s.id}" title="Editar">✎</button>
          <button class="btn btn-ghost btn-sm snippet-delete-btn" data-id="${s.id}">✕</button>
        </div>
      </div>
      ${s.description ? `<div class="snippet-desc">${esc(s.description)}</div>` : ''}
      <div class="snippet-code">
        <button class="copy-btn-float" data-code="${encoded}">Copy</button>
        <pre><code class="language-${hlLang}">${esc(s.code || '')}</code></pre>
      </div>
      <div class="snippet-footer">
        ${(s.tags||[]).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        ${snipCol ? `<span style="display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono);font-size:.65rem;color:var(--text-2)"><span style="width:7px;height:7px;border-radius:50%;background:${snipCol.color}"></span>${esc(snipCol.name)}</span>` : ''}
        ${proj ? `<span class="idea-linked" style="margin-left:auto">⬡ ${esc(proj.title)}</span>` : ''}
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
//  VIEW: FILE SYSTEM BRIDGE
// ══════════════════════════════════════════════════════════════

// ── FS Templates ─────────────────────────────────────────────
const FS_TEMPLATES = {
  rstudio: {
    name: 'RStudio Project',
    desc: 'Estructura clásica R con data-raw, scripts, plots y manuscript.',
    dirs:  ['data-raw', 'data-processed', 'scripts', 'plots', 'manuscript'],
    files: [
      { name: '{safe}.Rproj',
        content: () => 'Version: 1.0\n\nRestoreWorkspace: Default\nSaveWorkspace: Default\nAlwaysSaveHistory: Default\n\nEnableCodeIndexing: Yes\nUseSpacesForTab: Yes\nNumSpacesForTab: 2\nEncoding: UTF-8\n' },
      { name: 'README.md',
        content: ({name,desc,author,date}) =>
          `# ${name}\n\n${desc||'Proyecto de investigación.'}\n\n**Autor:** ${author}  \n**Fecha:** ${date}\n` },
      { name: 'scripts/00_setup.R',
        content: ({name,author}) =>
          `# Project: ${name}\n# Author:  ${author}\n\nlibrary(tidyverse)\nlibrary(here)\n\nPATH_RAW  <- here("data-raw")\nPATH_DATA <- here("data-processed")\nPATH_FIGS <- here("plots")\n` },
    ]
  },
  python_ds: {
    name: 'Python Data Science',
    desc: 'Notebooks, src, data y reports para proyectos Python.',
    dirs:  ['data/raw', 'data/processed', 'notebooks', 'src', 'reports', 'tests'],
    files: [
      { name: 'README.md',
        content: ({name,desc,author,date}) =>
          `# ${name}\n\n${desc||'Data science project.'}\n\n**Author:** ${author}  \n**Date:** ${date}\n` },
      { name: 'requirements.txt',
        content: () => 'pandas\nnumpy\nmatplotlib\nseaborn\nscipy\nsklearn\njupyter\n' },
      { name: 'src/__init__.py', content: () => '# Source package\n' },
    ]
  },
  minimal: {
    name: 'Minimal',
    desc: 'Estructura mínima: data, scripts, output y README.',
    dirs:  ['data', 'scripts', 'output'],
    files: [
      { name: 'README.md',
        content: ({name,desc,author,date}) =>
          `# ${name}\n\n${desc||'Research project.'}\n\n**Author:** ${author}  \n**Date:** ${date}\n` },
    ]
  },
  custom: {
    name: 'Personalizado',
    desc: 'Define tus propias carpetas y archivos iniciales.',
    dirs:  [],
    files: []
  }
};

async function renderFilesystem() {
  const fsSupported = 'showDirectoryPicker' in window;
  const projects = await db.projects.toArray();
  {
    const tplKeys = Object.keys(FS_TEMPLATES);
    const tplTabsHTML = tplKeys.map(k => `
      <button class="lang-tab ${k === 'rstudio' ? 'active' : ''}" data-tpl="${k}">
        ${FS_TEMPLATES[k].name}
      </button>`).join('');

    mainContent.innerHTML = `
      <div class="view">
        <div class="view-header">
          <div>
            <div class="view-title">FS Bridge</div>
            <div class="view-subtitle">Genera estructura de proyecto en tu sistema de archivos local</div>
          </div>
        </div>

        ${!fsSupported ? `
          <div class="fs-unsupported">
            ⚠ La File System Access API no está disponible en este navegador.<br>
            Usa <strong>Chrome 86+</strong> o <strong>Edge 86+</strong> para esta funcionalidad.<br>
            <small style="opacity:.7">Firefox y Safari no soportan showDirectoryPicker() aún.</small>
          </div>` : ''}

        <div class="section-title">Template de carpetas</div>
        <div class="lang-tabs" id="tplTabs" style="margin-bottom:12px">${tplTabsHTML}</div>
        <p id="tplDescText" style="font-size:.8rem;color:var(--text-2);margin:0 0 16px">
          ${esc(FS_TEMPLATES.rstudio.desc)}
        </p>

        <div class="fs-layout">
          <div class="fs-form-section">
            <div class="form-group">
              <label class="form-label">Proyecto vinculado (opcional)</label>
              <select class="form-select" id="fsProjectSelect">
                <option value="">— Nuevo proyecto —</option>
                ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Nombre del directorio</label>
              <input class="form-input" id="fsDirName" placeholder="mi_proyecto_2025"
                     ${!fsSupported ? 'disabled' : ''}>
              <span class="form-hint">Se usará como nombre de carpeta en tu sistema</span>
            </div>
            <div class="form-group">
              <label class="form-label">Descripción del proyecto</label>
              <textarea class="form-textarea" id="fsDescription"
                        placeholder="Escribe una descripción breve del proyecto…"
                        ${!fsSupported ? 'disabled' : ''}></textarea>
            </div>
            <div class="form-group">
              <label class="form-label">Autor / Responsable</label>
              <input class="form-input" id="fsAuthor" placeholder="Dr. García"
                     ${!fsSupported ? 'disabled' : ''}>
            </div>

            <div id="customTplEditor" style="display:none">
              <div class="form-group">
                <label class="form-label">Carpetas a crear (una por línea)</label>
                <textarea class="form-textarea" id="fsCustomDirs" rows="4"
                          style="font-family:var(--font-mono);font-size:.78rem"
                          placeholder="data-raw&#10;scripts&#10;output"></textarea>
              </div>
              <div class="form-group">
                <label class="form-label">Archivos a crear (ruta:contenido, uno por línea)</label>
                <textarea class="form-textarea" id="fsCustomFiles" rows="4"
                          style="font-family:var(--font-mono);font-size:.78rem"
                          placeholder="README.md:# Mi Proyecto&#10;scripts/main.R:# Script principal"></textarea>
              </div>
            </div>

            <button class="dir-picker-btn ${!fsSupported ? 'disabled' : ''}"
                    id="pickDirBtn" ${!fsSupported ? 'disabled' : ''}>
              <span class="dir-picker-icon">📁</span>
              Seleccionar carpeta raíz y generar estructura
            </button>
          </div>

          <div class="fs-preview">
            <div class="section-title">Vista previa de estructura</div>
            <div class="fs-tree" id="fsTree">
              <span style="color:var(--text-3)">Elige un template y escribe el nombre del directorio.</span>
            </div>
          </div>
        </div>
      </div>`;

    let currentTpl = 'rstudio';
    const updateTplPreview = () => {
      const tpl  = FS_TEMPLATES[currentTpl];
      const tree = $('fsTree');
      if (!tree) return;
      if (currentTpl === 'custom') {
        tree.innerHTML = '<span style="color:var(--text-3)">Define tus carpetas y archivos arriba.</span>';
        return;
      }
      const name = ($('fsDirName')?.value.trim() || 'mi_proyecto').replace(/[^a-zA-Z0-9_\-]/g, '_');
      tree.innerHTML = [
        `<div class="success"><span class="dir">📁 ${name}/</span></div>`,
        ...tpl.dirs.map(d  => `<div class="success">  <span class="dir">📁 ${d}/</span></div>`),
        ...tpl.files.map(f => `<div class="success">  📄 ${f.name.replace('{safe}', name)}</div>`),
      ].join('');
    };
    updateTplPreview();

    mainContent.querySelectorAll('[data-tpl]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentTpl = btn.dataset.tpl;
        mainContent.querySelectorAll('[data-tpl]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('tplDescText').textContent = FS_TEMPLATES[currentTpl].desc;
        $('customTplEditor').style.display = currentTpl === 'custom' ? 'block' : 'none';
        updateTplPreview();
      });
    });

    $('fsDirName')?.addEventListener('input', updateTplPreview);

    if (fsSupported) {
      $('pickDirBtn').addEventListener('click', () => runFSBridge(currentTpl));
      $('fsProjectSelect').addEventListener('change', async () => {
        const id = +$('fsProjectSelect').value;
        if (!id) return;
        const p = await db.projects.get(id);
        if (p) {
          $('fsDirName').value     = p.title.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
          $('fsDescription').value = p.description || '';
          $('fsAuthor').value      = p.responsible || '';
          updateTplPreview();
        }
      });
    }
  }
}

async function runFSBridge(templateKey = 'rstudio') {
  const name = $('fsDirName').value.trim() || 'research_project';
  const desc = $('fsDescription').value.trim();
  const auth = $('fsAuthor').value.trim() || 'Unknown';

  try {
    showToast('Selecciona la carpeta raíz…', 'info');
    const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    App.lastDirHandle = rootHandle;
    await createProjectStructure(rootHandle, { name, desc, author: auth }, templateKey);
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('Error: ' + err.message, 'error');
      console.error(err);
    }
  }
}

// File System Access API helpers
async function createDir(parentHandle, name) {
  return parentHandle.getDirectoryHandle(name, { create: true });
}

async function writeFile(parentHandle, name, content) {
  const fh       = await parentHandle.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(content);
  await writable.close();
}

async function createProjectStructure(rootHandle, { name, desc, author }, templateKey = 'rstudio') {
  const tree  = $('fsTree');
  const safe  = name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const date  = new Date().toISOString().split('T')[0];
  const ctx   = { name: safe, desc, author, date };
  const steps = [];

  const log = (msg, cls = '') => {
    steps.push(`<div class="${cls}">${msg}</div>`);
    tree.innerHTML = steps.join('');
  };

  let tpl;
  if (templateKey === 'custom') {
    const rawDirs  = ($('fsCustomDirs')?.value  || '').split('\n').map(s => s.trim()).filter(Boolean);
    const rawFiles = ($('fsCustomFiles')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    tpl = {
      dirs:  rawDirs,
      files: rawFiles.map(line => {
        const sep = line.indexOf(':');
        return sep > 0
          ? { name: line.slice(0, sep).trim(), content: () => line.slice(sep + 1).trim() }
          : { name: line.trim(), content: () => '' };
      })
    };
  } else {
    tpl = FS_TEMPLATES[templateKey] || FS_TEMPLATES.rstudio;
  }

  try {
    for (const dir of tpl.dirs) {
      const parts = dir.split('/').filter(Boolean);
      let handle  = rootHandle;
      for (const part of parts) handle = await handle.getDirectoryHandle(part, { create: true });
      log(`<span class="dir">📁 ${dir}/</span>`, 'success');
    }

    for (const file of tpl.files) {
      const fname   = file.name.replace('{safe}', safe);
      const content = typeof file.content === 'function' ? file.content(ctx) : (file.content || '');
      const parts   = fname.split('/').filter(Boolean);
      let handle    = rootHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        handle = await handle.getDirectoryHandle(parts[i], { create: true });
      }
      await writeFile(handle, parts[parts.length - 1], content);
      log(`📄 ${fname}`, 'success');
    }

    log(`<br><strong style="color:var(--green)">✓ Estructura "${safe}" generada correctamente</strong>`);
    showToast(`Estructura "${safe}" creada ✓`, 'success');
  } catch (err) {
    log(`<span style="color:var(--red)">⚠ Error: ${esc(err.message)}</span>`);
    showToast('Error al crear estructura: ' + err.message, 'error');
    console.error(err);
  }
}

// ══════════════════════════════════════════════════════════════
//  VIEW: TIMELINE / GANTT
// ══════════════════════════════════════════════════════════════
async function renderTimeline() {
  const projects = await db.projects.toArray();
  const withDL   = projects.filter(p => p.deadline).sort((a,b) => new Date(a.deadline) - new Date(b.deadline));

  const PRIO_COLORS = { Alta: 'var(--red)', Media: 'var(--amber)', Baja: 'var(--green)' };
  const TYPE_COLORS = { Grant: 'var(--amber)', Paper: 'var(--accent)', 'Análisis': 'var(--purple)', Dataset: 'var(--teal)' };

  mainContent.insertAdjacentHTML('beforeend', `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Timeline</div>
          <div class="view-subtitle">${withDL.length} proyectos con deadline</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" id="tlColorByPrio">Color: Prioridad</button>
          <button class="btn btn-ghost btn-sm" id="tlColorByType">Color: Tipo</button>
        </div>
      </div>
    </div>`);

  const viewEl = mainContent.querySelector('.view');

  if (!withDL.length) {
    viewEl.insertAdjacentHTML('beforeend', `<div class="timeline-empty">⏱ Ningún proyecto tiene deadline. Edita proyectos para añadir fechas límite.</div>`);
    return;
  }

  // Date range: from 30d before first deadline to 30d after last
  const today    = new Date(); today.setHours(12,0,0,0);
  const allDates = withDL.map(p => new Date(p.deadline + 'T12:00:00'));
  const minDate  = new Date(Math.min(...allDates, today.getTime() - 15 * 86400000));
  const maxDate  = new Date(Math.max(...allDates, today.getTime() + 60 * 86400000));
  const totalMs  = maxDate - minDate;
  const toX      = d => ((new Date(d + 'T12:00:00') - minDate) / totalMs * 100).toFixed(2) + '%';
  const todayX   = ((today - minDate) / totalMs * 100).toFixed(2) + '%';

  // Month labels
  const months = [];
  const cur = new Date(minDate); cur.setDate(1);
  while (cur <= maxDate) {
    months.push({ label: cur.toLocaleDateString('es-CL', { month:'short', year:'2-digit' }), x: ((cur - minDate) / totalMs * 100).toFixed(2) + '%' });
    cur.setMonth(cur.getMonth() + 1);
  }

  let colorMode = 'priority';
  const getColor = (p) => colorMode === 'priority'
    ? (PRIO_COLORS[p.priority] || 'var(--text-2)')
    : (TYPE_COLORS[p.type]     || 'var(--text-2)');

  const buildTimeline = () => `
    <div class="timeline-legend">
      ${colorMode === 'priority'
        ? Object.entries(PRIO_COLORS).map(([k,v]) => `<span class="timeline-legend-item"><span class="tl-dot" style="background:${v}"></span>${k}</span>`).join('')
        : Object.entries(TYPE_COLORS).map(([k,v]) => `<span class="timeline-legend-item"><span class="tl-dot" style="background:${v}"></span>${k}</span>`).join('')
      }
      <span class="timeline-legend-item"><span style="display:inline-block;width:10px;height:2px;background:var(--accent);border-radius:1px"></span>Hoy</span>
    </div>
    <div class="timeline-wrapper">
      <div class="timeline-grid">
        <div class="timeline-header-row">
          <div style="font-family:var(--font-mono);font-size:.68rem;color:var(--text-3);padding-bottom:8px">Proyecto</div>
          <div style="position:relative;height:24px;">
            ${months.map(m => `<span class="timeline-month-label" style="left:${m.x}">${m.label}</span>`).join('')}
          </div>
        </div>
        ${withDL.map(p => `
          <div class="timeline-row">
            <div class="timeline-row-label" data-inspect-project="${p.id}" title="${esc(p.title)}">
              ${esc(p.title)}
            </div>
            <div class="timeline-track">
              <div class="timeline-today-line" style="left:${todayX}">
                <span class="timeline-today-label">hoy</span>
              </div>
              <div class="timeline-deadline-dot"
                   style="left:${toX(p.deadline)};background:${getColor(p)}"
                   data-inspect-project="${p.id}"
                   title="${esc(p.title)} — ${formatDate(p.deadline)}">
              </div>
              <span class="timeline-deadline-label" style="left:${toX(p.deadline)}">
                ${formatDate(p.deadline)}
              </span>
            </div>
          </div>`).join('')}
      </div>
    </div>`;

  const tlContainer = document.createElement('div');
  tlContainer.id = 'tlContainer';
  tlContainer.innerHTML = buildTimeline();
  viewEl.appendChild(tlContainer);

  const rebind = () => {
    mainContent.querySelectorAll('[data-inspect-project]').forEach(el => {
      el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject));
    });
  };
  rebind();

  $('tlColorByPrio')?.addEventListener('click', () => {
    colorMode = 'priority';
    tlContainer.innerHTML = buildTimeline();
    rebind();
  });
  $('tlColorByType')?.addEventListener('click', () => {
    colorMode = 'type';
    tlContainer.innerHTML = buildTimeline();
    rebind();
  });
}

// ══════════════════════════════════════════════════════════════
//  VIEW: ARCHIVADOS & FAVORITOS
// ══════════════════════════════════════════════════════════════
async function renderArchived() {
  const projects = (await db.projects.toArray()).filter(p => p.archived);
  const cols     = await db.kanbanColumns.toArray();
  const colMap   = Object.fromEntries(cols.map(c => [c.id, c]));

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Proyectos Archivados</div>
          <div class="view-subtitle">${projects.length} proyecto(s) archivado(s)</div>
        </div>
      </div>
      <div class="projects-grid" id="archivedGrid">
        ${projects.length
          ? projects.map(p => projectCardHTML(p, colMap[p.columnId])).join('')
          : `<div class="empty-state" style="grid-column:1/-1">
               <span class="empty-state-icon">⊟</span>
               <h3>Sin archivados</h3>
               <p>Los proyectos archivados aparecerán aquí</p>
             </div>`}
      </div>
    </div>`;

  mainContent.querySelectorAll('[data-inspect-project]').forEach(el => {
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject));
  });
}

async function renderStarred() {
  const projects = (await db.projects.toArray()).filter(p => p.starred && !p.archived);
  const cols     = await db.kanbanColumns.toArray();
  const colMap   = Object.fromEntries(cols.map(c => [c.id, c]));
  const ideas    = (await db.ideas.toArray()).filter(i => i.starred);
  const snippets = (await db.snippets.toArray()).filter(s => s.starred);

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">★ Favoritos</div>
          <div class="view-subtitle">${projects.length + ideas.length + snippets.length} elementos marcados</div>
        </div>
      </div>
      ${projects.length ? `
        <div class="section-title">Proyectos</div>
        <div class="projects-grid" id="starredProjGrid">
          ${projects.map(p => projectCardHTML(p, colMap[p.columnId])).join('')}
        </div>` : ''}
      ${ideas.length ? `
        <div class="section-title mt-16">Ideas</div>
        <div class="ideas-list">
          ${ideas.map(i => ideaItemHTML(i, {})).join('')}
        </div>` : ''}
      ${snippets.length ? `
        <div class="section-title mt-16">Snippets</div>
        <div class="snippets-list">
          ${snippets.map(s => snippetCardHTML(s, {})).join('')}
        </div>` : ''}
      ${!projects.length && !ideas.length && !snippets.length ? `
        <div class="empty-state">
          <span class="empty-state-icon">★</span>
          <h3>Sin favoritos</h3>
          <p>Marca proyectos, ideas o snippets con ★ para verlos aquí</p>
        </div>` : ''}
    </div>`;

  mainContent.querySelectorAll('[data-inspect-project]').forEach(el => {
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject));
  });
  mainContent.querySelectorAll('.idea-item').forEach(el => {
    el.addEventListener('click', () => inspectIdea(+el.dataset.ideaId));
  });
  mainContent.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  mainContent.querySelectorAll('.copy-btn-float').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(decodeURIComponent(btn.dataset.code));
      btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  VIEW: SETTINGS & EXPORT
// ══════════════════════════════════════════════════════════════
async function renderSettings() {
  const counts = {
    p: await db.projects.count(),
    i: await db.ideas.count(),
    s: await db.snippets.count()
  };

  mainContent.innerHTML = `
    <div class="view" style="max-width:640px">
      <div class="view-header">
        <div>
          <div class="view-title">Settings &amp; Export</div>
          <div class="view-subtitle">Gestión de datos y configuración</div>
        </div>
      </div>

      <!-- Data summary -->
      <div class="settings-section">
        <div class="settings-section-title">📊 Estado de la base de datos</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Proyectos</div>
              <div class="settings-row-desc">Stored in IndexedDB</div>
            </div>
            <span style="font-family:var(--font-mono);font-size:.9rem;color:var(--accent)">${counts.p}</span>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Ideas</div>
            </div>
            <span style="font-family:var(--font-mono);font-size:.9rem;color:var(--purple)">${counts.i}</span>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Snippets</div>
            </div>
            <span style="font-family:var(--font-mono);font-size:.9rem;color:var(--green)">${counts.s}</span>
          </div>
        </div>
      </div>

      <!-- Export -->
      <div class="settings-section">
        <div class="settings-section-title">💾 Exportar backup</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Exportar a JSON</div>
              <div class="settings-row-desc">Descarga un backup completo de todos tus datos</div>
            </div>
            <button class="btn btn-primary btn-sm" id="exportJsonBtn">Exportar</button>
          </div>
        </div>
      </div>

      <!-- Import -->
      <div class="settings-section">
        <div class="settings-section-title">📂 Importar backup</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Importar desde JSON</div>
              <div class="settings-row-desc">⚠ Reemplaza TODOS los datos actuales</div>
            </div>
            <label class="btn btn-ghost btn-sm" style="cursor:pointer">
              Importar
              <input type="file" accept=".json" id="importJsonInput" style="display:none">
            </label>
          </div>
        </div>
      </div>

      <!-- CSV -->
      <div class="settings-section">
        <div class="settings-section-title">📋 CSV — Importar / Exportar proyectos</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Exportar proyectos a CSV</div>
              <div class="settings-row-desc">Columnas: title, type, responsible, priority, deadline, description, tags, status</div>
            </div>
            <button class="btn btn-ghost btn-sm" id="exportCsvBtn">CSV ↓</button>
          </div>
          <div class="settings-row" style="margin-top:8px">
            <div>
              <div class="settings-row-label">Importar proyectos desde CSV</div>
              <div class="settings-row-desc">Las columnas title y type son obligatorias. Los proyectos existentes no se modifican.</div>
            </div>
            <label class="btn btn-ghost btn-sm" style="cursor:pointer">
              CSV ↑
              <input type="file" accept=".csv,text/csv" id="importCsvInput" style="display:none">
            </label>
          </div>
          <div id="csvPreviewArea"></div>
        </div>
      </div>

      <!-- Danger zone -->
      <div class="settings-section settings-danger-zone">
        <div class="settings-section-title">⚠ Zona de peligro</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Borrar todos los datos</div>
              <div class="settings-row-desc">Elimina permanentemente proyectos, ideas y snippets</div>
            </div>
            <button class="btn btn-danger btn-sm" id="clearAllBtn">Borrar todo</button>
          </div>
        </div>
      </div>

      <!-- About -->
      <div class="settings-section">
        <div class="settings-section-title">ℹ Acerca de ResearchOS</div>
        <div class="settings-body">
          <div style="font-size:.8rem;color:var(--text-2);line-height:1.6">
            <strong style="color:var(--text-1)">ResearchOS v1.0</strong><br>
            Herramienta de productividad científica, <em>local-first</em>.<br>
            Sin backend. Sin telemetría. Tus datos nunca salen de tu navegador.<br><br>
            <strong style="color:var(--text-1)">Stack técnico:</strong>
            HTML5 · CSS Grid · Vanilla JS ES2022 · Dexie.js 3 (IndexedDB) · File System Access API · highlight.js
          </div>
        </div>
      </div>
    </div>`;

  $('exportJsonBtn').addEventListener('click', async () => {
    const json = await exportAllData();
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url,
      download: `researchos-backup-${new Date().toISOString().split('T')[0]}.json`
    });
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup exportado ✓', 'success');
  });

  $('importJsonInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('⚠ Esto reemplazará TODOS tus datos actuales. ¿Continuar?')) return;
    try {
      const text = await file.text();
      await importAllData(text);
      showToast('Datos importados ✓', 'success');
      navigate('dashboard');
    } catch (err) {
      showToast('Error al importar: ' + err.message, 'error');
    }
  });

  $('exportCsvBtn').addEventListener('click', exportProjectsCSV);
  $('importCsvInput').addEventListener('change', e => previewImportCSV(e.target.files[0]));
  $('clearAllBtn').addEventListener('click', async () => {
    if (!confirm('⚠ ¿Borrar TODOS los datos permanentemente?')) return;
    if (!confirm('Esta acción no se puede deshacer. ¿Confirmas?')) return;
    await db.transaction('rw', [db.projects, db.ideas, db.snippets, db.resources, db.collaborators], async () => {
      await Promise.all([
        db.projects.clear(), db.ideas.clear(), db.snippets.clear(),
        db.resources.clear(), db.collaborators.clear()
      ]);
    });
    showToast('Datos eliminados', 'info');
    navigate('dashboard');
  });
}

// ══════════════════════════════════════════════════════════════
//  MODALS — Add / Edit
// ══════════════════════════════════════════════════════════════
async function showAddProjectModal(defaultColId) {
  const cols = await db.kanbanColumns.orderBy('order').toArray();
  const body = `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="mp-title" placeholder="Título del proyecto">
      </div>
      <div class="form-group">
        <label class="form-label">Tipo</label>
        <select class="form-select" id="mp-type">
          ${['Grant','Paper','Análisis','Dataset','Presentación'].map(t => `<option>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Columna Kanban</label>
        <select class="form-select" id="mp-col">
          ${cols.map(c => `<option value="${c.id}" ${c.id === defaultColId ? 'selected':''}>${c.title}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Responsable</label>
        <input class="form-input" id="mp-responsible" placeholder="Dr. García">
      </div>
      <div class="form-group">
        <label class="form-label">Coautores (separados por coma)</label>
        <input class="form-input" id="mp-coauthors" placeholder="Dr. Martínez, Lic. López">
      </div>
      <div class="form-group">
        <label class="form-label">Fecha límite</label>
        <input class="form-input" type="date" id="mp-deadline">
      </div>
      <div class="form-group">
        <label class="form-label">Prioridad</label>
        <select class="form-select" id="mp-priority">
          <option>Alta</option><option selected>Media</option><option>Baja</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <textarea class="form-textarea" id="mp-desc" rows="3" placeholder="Descripción breve del proyecto…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="mp-tags" placeholder="R, ecology, time-series">
      </div>
      <div class="form-group">
        <label class="form-label">Proyecto padre (subproyecto de…)</label>
        <select class="form-select" id="mp-parent">
          <option value="">— Proyecto raíz —</option>
          ${(await db.projects.toArray()).filter(p => !p.parentId)
            .map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="mpCancel">Cancelar</button>
      <button class="btn btn-primary" id="mpSave">Guardar Proyecto</button>
    </div>`;

  showModal('Nuevo Proyecto', body);
  setTimeout(() => $('mp-title')?.focus(), 60);
  $('mpCancel').addEventListener('click', closeModal);
  $('mpSave').addEventListener('click', async () => {
    const title = $('mp-title').value.trim();
    if (!title) { showToast('El título es requerido', 'error'); return; }
    await dbWrite(() => db.projects.add({
      title,
      type:        $('mp-type').value,
      columnId:    +$('mp-col').value,
      responsible: $('mp-responsible').value.trim(),
      coauthors:   $('mp-coauthors').value.split(',').map(s => s.trim()).filter(Boolean),
      deadline:    $('mp-deadline').value || null,
      priority:    $('mp-priority').value,
      description: $('mp-desc').value.trim(),
      tags:        $('mp-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      parentId:    +$('mp-parent').value || null,
      status:      'active',
      archived:    false,
      starred:     false,
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString()
    }));
    closeModal();
    showToast('Proyecto creado ✓', 'success');
    renderView(App.view);
  });
}

async function showAddCollectionModal() {
  const COLORS = ['#38bdf8','#34d399','#a78bfa','#fbbf24','#f87171','#fb923c','#2dd4bf'];
  showModal('Nueva Colección', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Nombre *</label>
        <input class="form-input" id="nc-name" placeholder="Visualización ggplot2…">
      </div>
      <div class="form-group">
        <label class="form-label">Color</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${COLORS.map((c,i) => `
            <label style="cursor:pointer">
              <input type="radio" name="nc-color" value="${c}" ${i===0?'checked':''} style="display:none">
              <span style="display:block;width:24px;height:24px;border-radius:50%;background:${c};
                           border:2px solid transparent;transition:border 140ms"
                    onclick="this.style.borderColor='#fff'"></span>
            </label>`).join('')}
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="ncCancel">Cancelar</button>
      <button class="btn btn-primary" id="ncSave">Crear</button>
    </div>`);
  setTimeout(() => $('nc-name')?.focus(), 60);
  $('ncCancel').addEventListener('click', closeModal);
  $('ncSave').addEventListener('click', async () => {
    const name  = $('nc-name').value.trim();
    if (!name) { showToast('Nombre requerido', 'error'); return; }
    const color = document.querySelector('input[name="nc-color"]:checked')?.value || '#38bdf8';
    await createCollection(name, color);
    closeModal(); showToast('Colección creada ✓', 'success'); renderSnippets();
  });
}

async function showAddIdeaModal() {
  const projects = await db.projects.toArray();
  const body = `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="mi-title" placeholder="Idea o recurso…">
      </div>
      <div class="form-group">
        <label class="form-label">Contenido / URL / Nota</label>
        <textarea class="form-textarea" id="mi-content" placeholder="Detalles, link, ruta de archivo…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="mi-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="miCancel">Cancelar</button>
      <button class="btn btn-primary" id="miSave">Guardar</button>
    </div>`;

  showModal('Nueva Idea', body);
  setTimeout(() => $('mi-title')?.focus(), 60);
  $('miCancel').addEventListener('click', closeModal);
  $('miSave').addEventListener('click', async () => {
    const title = $('mi-title').value.trim();
    if (!title) { showToast('El título es requerido', 'error'); return; }
    await dbWrite(() => db.ideas.add({
      title, content: $('mi-content').value.trim(),
      status: 'unread',
      projectId: +$('mi-project').value || null,
      tags: [], subtasks: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
    closeModal();
    showToast('Idea guardada ✓', 'success');
    if (App.view === 'ideas') renderIdeas();
    updateBadges();
  });
}

async function showEditIdeaModal(idea) {
  const projects = await db.projects.toArray();
  showModal('Editar Idea', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="ei-title" value="${esc(idea.title)}">
      </div>
      <div class="form-group">
        <label class="form-label">Contenido / URL / Nota</label>
        <textarea class="form-textarea" id="ei-content" rows="4">${esc(idea.content || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="ei-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p =>
            `<option value="${p.id}" ${p.id === idea.projectId ? 'selected' : ''}>${esc(p.title)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="ei-tags" value="${(idea.tags || []).join(', ')}">
      </div>
      <div class="form-group">
        <label class="form-label">Estado</label>
        <select class="form-select" id="ei-status">
          <option value="unread"   ${idea.status === 'unread'   ? 'selected' : ''}>Sin revisar</option>
          <option value="reviewed" ${idea.status === 'reviewed' ? 'selected' : ''}>Revisada</option>
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost"   id="eiCancel">Cancelar</button>
      <button class="btn btn-primary" id="eiSave">Guardar Cambios</button>
    </div>`);
  setTimeout(() => $('ei-title')?.focus(), 60);
  $('eiCancel').addEventListener('click', closeModal);
  $('eiSave').addEventListener('click', async () => {
    const title = $('ei-title').value.trim();
    if (!title) { showToast('El título es requerido', 'error'); return; }
    await dbWrite(() => db.ideas.update(idea.id, {
      title,
      content:   $('ei-content').value.trim(),
      projectId: +$('ei-project').value || null,
      tags:      $('ei-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      status:    $('ei-status').value,
      updatedAt: new Date().toISOString()
    }));
    closeModal();
    showToast('Idea actualizada ✓', 'success');
    await inspectIdea(idea.id);
    if (App.view === 'ideas') renderIdeas();
    updateBadges();
  });
}

async function showAddSnippetModal() {
  const projects = await db.projects.toArray();
  const body = `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="ms-title" placeholder="Nombre del snippet…">
      </div>
      <div class="form-group">
        <label class="form-label">Lenguaje</label>
        <select class="form-select" id="ms-lang">
          ${['R','Python','Bash','SQL','Other'].map(l => `<option>${l}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Código *</label>
        <textarea class="form-textarea" id="ms-code" rows="7"
                  style="font-family:var(--font-mono);font-size:.8rem"
                  placeholder="# Pega tu código aquí…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <input class="form-input" id="ms-desc" placeholder="Qué hace este snippet…">
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="ms-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="ms-tags" placeholder="R, ggplot, cleaning">
      </div>
      <div class="form-group">
        <label class="form-label">Colección</label>
        <select class="form-select" id="ms-collection">
          <option value="">Sin colección</option>
          ${(await getCollections()).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="msCancel">Cancelar</button>
      <button class="btn btn-primary" id="msSave">Guardar Snippet</button>
    </div>`;

  showModal('Nuevo Snippet', body);
  setTimeout(() => $('ms-title')?.focus(), 60);
  $('msCancel').addEventListener('click', closeModal);
  $('msSave').addEventListener('click', async () => {
    const title = $('ms-title').value.trim();
    const code  = $('ms-code').value;
    if (!title || !code) { showToast('Título y código son requeridos', 'error'); return; }
    await dbWrite(() => db.snippets.add({
      title, language: $('ms-lang').value, code,
      description: $('ms-desc').value.trim(),
      projectId:   +$('ms-project').value || null,
      tags:         $('ms-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      collectionId: +$('ms-collection').value || null,
      starred:      false,
      createdAt:    new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
    closeModal();
    showToast('Snippet guardado ✓', 'success');
    if (App.view === 'snippets') renderSnippets();
  });
}

// ══════════════════════════════════════════════════════════════
//  INSPECTOR PANEL
// ══════════════════════════════════════════════════════════════
function openInspector() {
  document.body.classList.remove('inspector-closed');
}
function closeInspector() {
  document.body.classList.add('inspector-closed');
  inspectorBody.innerHTML = `
    <div class="inspector-empty">
      <span class="empty-icon">◈</span>
      <p>Selecciona un elemento para inspeccionar</p>
    </div>`;
}

async function inspectProject(id) {
  const p         = await db.projects.get(id);
  if (!p) return;
  const cols      = await db.kanbanColumns.toArray();
  const colMap    = Object.fromEntries(cols.map(c => [c.id, c]));
  const relIdeas  = await getRelatedIdeas(id);
  const relSnips  = await getRelatedSnippets(id);
  const col       = colMap[p.columnId];

  inspectorBody.innerHTML = `
    <div>
      <div style="margin-bottom:10px">
        <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
        <span class="badge ${prioBadgeClass(p.priority)}" style="margin-left:4px">${esc(p.priority)}</span>
      </div>
      <div class="inspector-project-title">${esc(p.title)}</div>

      <div class="inspector-meta">
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Estado</span>
          <span class="inspector-meta-val" style="color:var(--text-1)">${esc(col?.title ?? '—')}</span>
        </div>
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Responsable</span>
          <span class="inspector-meta-val">${esc(p.responsible || '—')}</span>
        </div>
        ${p.coauthors?.length ? `
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Coautores</span>
          <span class="inspector-meta-val">${p.coauthors.map(esc).join(', ')}</span>
        </div>` : ''}
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Deadline</span>
          <span class="inspector-meta-val">${p.deadline ? formatDate(p.deadline) : '—'}</span>
        </div>
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Creado</span>
          <span class="inspector-meta-val">${relativeDate(p.createdAt)}</span>
        </div>
      </div>
      <div id="completenessInspector"></div>

      ${p.description ? `<div class="inspector-desc">${esc(p.description)}</div>` : ''}

      ${(p.tags||[]).length ? `
        <div class="inspector-related-title">Etiquetas</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>` : ''}

      ${(p._history||[]).length ? (() => {
        const hist = [...(p._history||[])].reverse().slice(0, 5);
        const FIELDS = { title:'Título', type:'Tipo', responsible:'Responsable',
                         priority:'Prioridad', deadline:'Deadline', description:'Descripción' };
        return `
          <div class="inspector-related-title">Historial (últimas ${hist.length} ediciones)</div>
          <div class="history-list">
            ${hist.map((snap, si) => {
              // Diff against next-older snapshot or current state
              const prev   = hist[si + 1] || snap;
              const diffs  = Object.entries(FIELDS)
                .filter(([k]) => snap[k] !== prev[k] && si < hist.length - 1)
                .map(([k, label]) =>
                  `<span class="history-diff">${label}: </span>` +
                  `<span class="history-diff-old">${esc(String(prev[k] || '—'))}</span> → ` +
                  `<span class="history-diff-new">${esc(String(snap[k] || '—'))}</span>`)
                .join('<br>');
              return `
                <div class="history-entry">
                  <span class="history-ts">${relativeDate(snap.ts)}</span>
                  ${diffs || '<span style="color:var(--text-3)">Snapshot inicial</span>'}
                </div>`;
            }).join('')}
          </div>`;
      })() : ''}

      ${relIdeas.length ? `
        <div class="inspector-related-title">Ideas vinculadas (${relIdeas.length})</div>
        ${relIdeas.slice(0,4).map(i => `<div class="inspector-related-item">◎ ${esc(i.title)}</div>`).join('')}` : ''}

      ${relSnips.length ? `
        <div class="inspector-related-title">Snippets vinculados (${relSnips.length})</div>
        ${relSnips.slice(0,4).map(s => `<div class="inspector-related-item">⟨/⟩ ${esc(s.title)}</div>`).join('')}` : ''}

      ${(() => {
        const durations = computeColumnDurations(p, colMap);
        if (!durations.length) return '';
        const maxD = Math.max(...durations.map(d => d.days), 1);
        return `
          <div class="inspector-related-title">Tiempo por columna</div>
          <div class="col-duration-list">
            ${durations.map(d => `
              <div class="col-duration-item">
                <span class="col-duration-name">${esc(d.colTitle)}</span>
                <div class="col-duration-bar-wrap">
                  <div class="col-duration-bar"
                       style="width:${(d.days/maxD*100).toFixed(1)}%;background:${d.colColor}"></div>
                </div>
                <span class="col-duration-label">${d.days}d</span>
              </div>`).join('')}
          </div>`;
      })()}

      <div class="inspector-actions">
        <button class="btn btn-ghost btn-sm" id="inspEditBtn">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" id="inspFSBtn" title="Crear estructura FS">📁 FS</button>
        <button class="btn btn-ghost btn-sm" id="inspStarBtn">${p.starred ? '★ Quitar fav.' : '☆ Favorito'}</button>
        <button class="btn btn-ghost btn-sm" id="inspArchiveBtn">${p.archived ? '↩ Restaurar' : '⊟ Archivar'}</button>
        <button class="btn btn-danger btn-sm" id="inspDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  // Breadcrumb contextual en inspector
  const bcInspector = inspectorBody.querySelector('.insp-bc');
  if (!bcInspector) {
    const bcEl = document.createElement('div');
    bcEl.className = 'insp-bc';
    bcEl.style.cssText = 'font-size:.65rem;font-family:var(--font-mono);color:var(--text-3);margin-bottom:10px;cursor:pointer;';
    bcEl.textContent = `${VIEW_LABELS[App.view] || 'Vista'} › ${p.type}`;
    bcEl.addEventListener('click', () => navigate(App.view));
    inspectorBody.querySelector('div')?.prepend(bcEl);
  }

  openInspector();

  $('inspDeleteBtn').addEventListener('click', async () => {
    if (confirm(`¿Eliminar "${p.title}"?`)) {
      await db.projects.delete(id);
      closeInspector();
      showToast('Proyecto eliminado', 'info');
      renderView(App.view);
    }
  });

  $('inspFSBtn').addEventListener('click', () => {
    navigate('filesystem');
    setTimeout(() => {
      const sel = $('fsProjectSelect');
      if (sel) sel.value = id;
      sel?.dispatchEvent(new Event('change'));
    }, 300);
  });

  // Async completeness in inspector
  projectCompleteness(p).then(pct => {
    const el = $('completenessInspector');
    if (el) el.innerHTML = `
      <div class="inspector-related-title">Completitud del proyecto</div>
      ${completenessBarHTML(pct)}
      <div style="font-size:.7rem;color:var(--text-3);margin-top:4px;font-family:var(--font-mono)">
        ${pct < 100 ? 'Faltan: ' + [
          !p.description?.trim() && 'descripción',
          !p.deadline            && 'deadline',
          !p.responsible?.trim() && 'responsable',
          !(p.tags||[]).length   && 'etiquetas',
        ].filter(Boolean).join(', ') : '✓ Proyecto completo'}
      </div>`;
  });

  $('inspEditBtn').addEventListener('click', () => showEditProjectModal(p));

  $('inspStarBtn').addEventListener('click', async () => {
    await db.projects.update(id, { starred: !p.starred, updatedAt: new Date().toISOString() });
    showToast(p.starred ? 'Quitado de favoritos' : '★ Añadido a favoritos', 'success');
    inspectProject(id);
    if (App.view === 'projects' || App.view === 'starred') renderView(App.view);
  });

  $('inspArchiveBtn').addEventListener('click', async () => {
    await db.projects.update(id, { archived: !p.archived, updatedAt: new Date().toISOString() });
    showToast(p.archived ? 'Proyecto restaurado' : 'Proyecto archivado', 'info');
    closeInspector();
    renderView(App.view);
  });

  // Async: show subprojects
  db.projects.where('parentId').equals(id).toArray().then(children => {
    if (!children.length) return;
    const actionsEl = inspectorBody.querySelector('.inspector-actions');
    if (!actionsEl) return;
    const subEl = document.createElement('div');
    subEl.innerHTML = `
      <div class="inspector-related-title">Subproyectos (${children.length})</div>
      <div class="subproject-list">
        ${children.map(c => `
          <div class="subproject-item" data-inspect-project="${c.id}">
            <span class="badge ${typeBadgeClass(c.type)}" style="flex-shrink:0">${esc(c.type)}</span>
            ${esc(c.title)}
          </div>`).join('')}
      </div>`;
    actionsEl.parentNode.insertBefore(subEl, actionsEl);
    subEl.querySelectorAll('[data-inspect-project]').forEach(el => {
      el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject));
    });
  });
}

async function inspectSnippet(s) {
  const proj    = s.projectId ? await db.projects.get(s.projectId) : null;
  const colls   = await getCollections();
  const collMap = Object.fromEntries(colls.map(c => [c.id, c]));
  const snipCol = s.collectionId ? collMap[s.collectionId] : null;
  const encoded = encodeURIComponent(s.code || '');
  const hlLang  = { R:'r', Python:'python', Bash:'bash', SQL:'sql' }[s.language] || 'plaintext';

  inspectorBody.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span class="snippet-lang-badge lang-${s.language || 'Other'}">${esc(s.language || 'Other')}</span>
        ${s.starred ? '<span style="color:var(--amber)">★</span>' : ''}
      </div>
      <div class="inspector-project-title">${esc(s.title)}</div>
      <div class="inspector-meta">
        ${proj ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Proyecto</span>
          <span class="inspector-meta-val" style="cursor:pointer;color:var(--accent)"
                id="snipNavProj">${esc(proj.title)}</span>
        </div>` : ''}
        ${snipCol ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Colección</span>
          <span class="inspector-meta-val" style="display:flex;align-items:center;gap:5px">
            <span style="width:8px;height:8px;border-radius:50%;background:${snipCol.color}"></span>
            ${esc(snipCol.name)}
          </span>
        </div>` : ''}
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Editado</span>
          <span class="inspector-meta-val">${relativeDate(s.updatedAt)}</span>
        </div>
      </div>
      ${s.description ? `<div class="inspector-desc">${esc(s.description)}</div>` : ''}
      ${(s.tags||[]).length ? `
        <div class="inspector-related-title">Etiquetas</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
          ${s.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>` : ''}
      <div class="inspector-related-title">Código</div>
      <div class="snippet-code" style="max-height:300px;overflow-y:auto;border-radius:var(--radius-md);margin-bottom:10px">
        <button class="copy-btn-float" data-code="${encoded}">Copy</button>
        <pre><code class="language-${hlLang}">${esc(s.code || '')}</code></pre>
      </div>
      <div class="inspector-actions">
        <button class="btn btn-ghost btn-sm" id="snipEditBtn">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" id="snipStarBtn"
                style="color:${s.starred ? 'var(--amber)' : 'inherit'}">
          ${s.starred ? '★ Quitar fav.' : '☆ Favorito'}
        </button>
        <button class="btn btn-danger btn-sm" id="snipDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();
  inspectorBody.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  inspectorBody.querySelectorAll('.copy-btn-float').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(decodeURIComponent(btn.dataset.code));
      btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  });
  $('snipNavProj')?.addEventListener('click', () => {
    navigate('projects'); setTimeout(() => inspectProject(proj.id), 120);
  });
  $('snipEditBtn').addEventListener('click', () => showEditSnippetModal(s));
  $('snipStarBtn').addEventListener('click', async () => {
    await db.snippets.update(s.id, { starred: !s.starred });
    showToast(s.starred ? 'Quitado de favoritos' : '★ Favorito', 'success');
    inspectSnippet(await db.snippets.get(s.id));
    if (App.view === 'snippets') renderSnippets();
  });
  $('snipDeleteBtn').addEventListener('click', async () => {
    if (confirm(`¿Eliminar "${s.title}"?`)) {
      await db.snippets.delete(s.id);
      closeInspector();
      showToast('Snippet eliminado', 'info');
      if (App.view === 'snippets') renderSnippets();
    }
  });
}

async function showEditSnippetModal(s) {
  const [projects, collections] = await Promise.all([
    db.projects.toArray(), getCollections()
  ]);
  showModal('Editar Snippet', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="es-title" value="${esc(s.title)}">
      </div>
      <div class="form-group">
        <label class="form-label">Lenguaje</label>
        <select class="form-select" id="es-lang">
          ${['R','Python','Bash','SQL','Other'].map(l =>
            `<option ${l === s.language ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Código *</label>
        <textarea class="form-textarea" id="es-code" rows="8"
                  style="font-family:var(--font-mono);font-size:.8rem">${esc(s.code || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <input class="form-input" id="es-desc" value="${esc(s.description || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="es-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p =>
            `<option value="${p.id}" ${p.id === s.projectId ? 'selected' : ''}>${esc(p.title)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="es-tags" value="${(s.tags||[]).join(', ')}">
      </div>
      <div class="form-group">
        <label class="form-label">Colección</label>
        <select class="form-select" id="es-collection">
          <option value="">Sin colección</option>
          ${collections.map(c =>
            `<option value="${c.id}" ${c.id === s.collectionId ? 'selected' : ''}>${esc(c.name)}</option>`
          ).join('')}
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost"   id="esCancel">Cancelar</button>
      <button class="btn btn-primary" id="esSave">Guardar Cambios</button>
    </div>`);
  setTimeout(() => $('es-title')?.focus(), 60);
  $('esCancel').addEventListener('click', closeModal);
  $('esSave').addEventListener('click', async () => {
    const title = $('es-title').value.trim();
    const code  = $('es-code').value;
    if (!title || !code) { showToast('Título y código son requeridos', 'error'); return; }
    await dbWrite(() => db.snippets.update(s.id, {
      title,
      language:     $('es-lang').value,
      code,
      description:  $('es-desc').value.trim(),
      projectId:    +$('es-project').value    || null,
      tags:         $('es-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      collectionId: +$('es-collection').value || null,
      updatedAt:    new Date().toISOString()
    }));
    closeModal();
    showToast('Snippet actualizado ✓', 'success');
    inspectSnippet(await db.snippets.get(s.id));
    if (App.view === 'snippets') renderSnippets();
  });
}

async function showEditProjectModal(p) {
  const cols = await db.kanbanColumns.orderBy('order').toArray();
  const body = `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título</label>
        <input class="form-input" id="ep-title" value="${esc(p.title)}">
      </div>
      <div class="form-group">
        <label class="form-label">Tipo</label>
        <select class="form-select" id="ep-type">
          ${['Grant','Paper','Análisis','Dataset','Presentación'].map(t => `<option ${t===p.type?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Columna Kanban</label>
        <select class="form-select" id="ep-col">
          ${cols.map(c => `<option value="${c.id}" ${c.id===p.columnId?'selected':''}>${c.title}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Responsable</label>
        <input class="form-input" id="ep-responsible" value="${esc(p.responsible || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Coautores (separados por coma)</label>
        <input class="form-input" id="ep-coauthors" value="${(p.coauthors||[]).join(', ')}">
      </div>
      <div class="form-group">
        <label class="form-label">Fecha límite</label>
        <input class="form-input" type="date" id="ep-deadline" value="${p.deadline || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Prioridad</label>
        <select class="form-select" id="ep-priority">
          ${['Alta','Media','Baja'].map(pr => `<option ${pr===p.priority?'selected':''}>${pr}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <textarea class="form-textarea" id="ep-desc">${esc(p.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas</label>
        <input class="form-input" id="ep-tags" value="${(p.tags||[]).join(', ')}">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="epCancel">Cancelar</button>
      <button class="btn btn-primary" id="epSave">Guardar Cambios</button>
    </div>`;

  showModal('Editar Proyecto', body);
  $('epCancel').addEventListener('click', closeModal);
  $('epSave').addEventListener('click', async () => {
    await snapshotProject(p.id);          // Save snapshot before overwriting
    await db.projects.update(p.id, {
      title:       $('ep-title').value.trim(),
      type:        $('ep-type').value,
      columnId:    +$('ep-col').value,
      responsible: $('ep-responsible').value.trim(),
      coauthors:   $('ep-coauthors').value.split(',').map(s => s.trim()).filter(Boolean),
      deadline:    $('ep-deadline').value || null,
      priority:    $('ep-priority').value,
      description: $('ep-desc').value.trim(),
      tags:        $('ep-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      updatedAt:   new Date().toISOString()
    });
    closeModal();
    showToast('Proyecto actualizado ✓', 'success');
    await inspectProject(p.id);
    renderView(App.view);
  });
}

async function inspectIdea(id) {
  const idea = await db.ideas.get(id);
  if (!idea) return;
  const proj = idea.projectId ? await db.projects.get(idea.projectId) : null;

  inspectorBody.innerHTML = `
    <div>
      <div class="badge ${idea.status === 'reviewed' ? 'badge-paper' : 'badge-prio-alta'}"
           style="margin-bottom:12px">
        ${idea.status === 'reviewed' ? '✓ Revisada' : '● Sin revisar'}
      </div>
      <div class="inspector-project-title">${esc(idea.title)}</div>
      ${idea.content ? `<div class="inspector-desc">${esc(idea.content)}</div>` : ''}
      <div class="inspector-meta">
        ${proj ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Proyecto</span>
          <span class="inspector-meta-val"
                style="cursor:pointer;color:var(--accent)"
                id="inspIdeaNavProj">${esc(proj.title)}</span>
        </div>` : ''}
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Creada</span>
          <span class="inspector-meta-val">${relativeDate(idea.createdAt)}</span>
        </div>
      </div>
      ${subtaskListHTML(idea)}
      <div class="inspector-actions" style="margin-top:14px">
        <button class="btn btn-ghost btn-sm" id="ideaEditBtn">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" id="ideaToggleReviewBtn">
          ${idea.status === 'reviewed' ? '○ Sin revisar' : '✓ Revisada'}
        </button>
        <button class="btn btn-ghost btn-sm" id="ideaStarInspBtn"
                style="color:${idea.starred ? 'var(--amber)' : 'var(--text-3)'}">
          ${idea.starred ? '★' : '☆'}
        </button>
        <button class="btn btn-danger btn-sm" id="ideaDeleteBtn">✕ Eliminar</button>
      </div>`;

  openInspector();

  // Navigate to linked project
  $('inspIdeaNavProj')?.addEventListener('click', () => {
    navigate('projects'); setTimeout(() => inspectProject(proj.id), 120);
  });

  // Toggle review status
  $('ideaToggleReviewBtn').addEventListener('click', async () => {
    await dbWrite(() => db.ideas.update(id, {
      status: idea.status === 'reviewed' ? 'unread' : 'reviewed',
      updatedAt: new Date().toISOString()
    }));
    inspectIdea(id);
    if (App.view === 'ideas') renderIdeas();
  });

  // Subtask handlers
  inspectorBody.querySelectorAll('[data-toggle-st]').forEach(btn => {
    btn.addEventListener('click', () => toggleSubtask(id, +btn.dataset.toggleSt));
  });
  inspectorBody.querySelectorAll('[data-del-st]').forEach(btn => {
    btn.addEventListener('click', () => deleteSubtask(id, +btn.dataset.delSt));
  });
  const stInput  = $(`stInput-${id}`);
  const stAddBtn = $(`stAddBtn-${id}`);
  stAddBtn?.addEventListener('click', () => { addSubtask(id, stInput.value); stInput.value = ''; });
  stInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { addSubtask(id, stInput.value); stInput.value = ''; }
  });

  $('ideaEditBtn').addEventListener('click', () => showEditIdeaModal(idea));

  $('ideaStarInspBtn').addEventListener('click', async () => {
    await db.ideas.update(id, { starred: !idea.starred });
    showToast(idea.starred ? 'Quitado de favoritos' : '★ Favorito', 'success');
    inspectIdea(id);
    updateBadges();
  });

  $('ideaDeleteBtn').addEventListener('click', async () => {
    if (confirm('¿Eliminar esta idea?')) {
      await db.ideas.delete(id);
      closeInspector();
      showToast('Idea eliminada', 'info');
      if (App.view === 'ideas') renderIdeas();
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  MODAL SYSTEM
// ══════════════════════════════════════════════════════════════
function showModal(title, bodyHTML) {
  modalTitle.textContent = title;
  modalContent.innerHTML = bodyHTML;
  modalOverlay.classList.add('visible');
}
function closeModal() {
  modalOverlay.classList.remove('visible');
  modalContent.innerHTML = '';
}

// ══════════════════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ══════════════════════════════════════════════════════════════
function showToast(message, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || '•'}</span> ${esc(message)}`;
  $('toastContainer').appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ══════════════════════════════════════════════════════════════
//  BADGES & COUNTERS
// ══════════════════════════════════════════════════════════════
async function updateBadges() {
  const [unread, archived, starred] = await Promise.all([
    db.ideas.where('status').equals('unread').count(),
    db.projects.filter(p => !!p.archived).count(),
    db.projects.filter(p => !!p.starred && !p.archived).count(),
  ]);
  const badge = $('ideasBadge');
  if (badge) { badge.textContent = unread; badge.classList.toggle('visible', unread > 0); }
  const abadge = $('archivedBadge');
  if (abadge) { abadge.textContent = archived; abadge.classList.toggle('visible', archived > 0); }
  const sbadge = $('starredBadge');
  if (sbadge) { sbadge.textContent = starred; sbadge.classList.toggle('visible', starred > 0); }
}

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function typeBadgeClass(type) {
  const map = { Grant:'badge-grant', Paper:'badge-paper', Análisis:'badge-analisis', Dataset:'badge-dataset' };
  return map[type] || 'badge-type';
}

function prioBadgeClass(prio) {
  const map = { Alta:'badge-prio-alta', Media:'badge-prio-media', Baja:'badge-prio-baja' };
  return map[prio] || 'badge-type';
}

/**
 * Computes a 0–100 completeness score for a project.
 * Criteria: title(20) + description(15) + deadline(15) + responsible(10)
 *           + tags(10) + ideas(15) + snippets(15)
 */
async function projectCompleteness(p) {
  let score = 0;
  if (p.title?.trim())       score += 20;
  if (p.description?.trim()) score += 15;
  if (p.deadline)            score += 15;
  if (p.responsible?.trim()) score += 10;
  if ((p.tags||[]).length)   score += 10;
  const ideas    = await db.ideas.where('projectId').equals(p.id).count();
  const snippets = await db.snippets.where('projectId').equals(p.id).count();
  if (ideas    > 0)          score += 15;
  if (snippets > 0)          score += 15;
  return Math.min(score, 100);
}

function completenessBarHTML(pct) {
  const color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)';
  return `
    <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
      <div style="flex:1;height:4px;background:var(--bg-elevated);border-radius:99px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:99px;transition:width 400ms var(--ease)"></div>
      </div>
      <span style="font-family:var(--font-mono);font-size:.65rem;color:${color}">${pct}%</span>
    </div>`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('es-CL', { day:'2-digit', month:'short', year:'numeric' });
}

function relativeDate(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Ahora';
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d}d`;
  return formatDate(iso.split('T')[0]);
}

// ══════════════════════════════════════════════════════════════
//  CSV IMPORT / EXPORT
// ══════════════════════════════════════════════════════════════
const CSV_COLS = ['title','type','responsible','priority','deadline','description','tags','status','parentId'];

function toCSVRow(vals) {
  return vals.map(v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

async function exportProjectsCSV() {
  const projects = await db.projects.toArray();
  const header   = toCSVRow(CSV_COLS);
  const rows     = projects.map(p =>
    toCSVRow(CSV_COLS.map(k => k === 'tags' ? (p.tags || []).join('|') : p[k]))
  );
  const csv  = [header, ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), {
    href: url,
    download: `researchos-projects-${new Date().toISOString().split('T')[0]}.csv`
  }).click();
  URL.revokeObjectURL(url);
  showToast(`${projects.length} proyectos exportados ✓`, 'success');
}

function parseCSV(text) {
  const lines  = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return { headers: [], rows: [] };

  const parseRow = (line) => {
    const vals = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i+1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim());
    return vals;
  };

  const headers = parseRow(lines[0]).map(h => h.toLowerCase().trim());
  const rows    = lines.slice(1).map(l => {
    const vals = parseRow(l);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
  return { headers, rows };
}

async function previewImportCSV(file) {
  if (!file) return;
  const text    = await file.text();
  const { headers, rows } = parseCSV(text);
  const preview = $('csvPreviewArea');
  if (!preview) return;

  if (!headers.includes('title')) {
    preview.innerHTML = `<div class="fs-unsupported" style="margin-top:10px">⚠ El CSV no tiene columna "title". Verifica el formato.</div>`;
    return;
  }

  const VALID_TYPES    = ['Grant','Paper','Análisis','Dataset','Presentación'];
  const VALID_PRIORITY = ['Alta','Media','Baja'];

  const toImport = rows.filter(r => r.title?.trim()).map(r => ({
    title:       r.title.trim(),
    type:        VALID_TYPES.includes(r.type) ? r.type : 'Paper',
    responsible: r.responsible?.trim() || '',
    priority:    VALID_PRIORITY.includes(r.priority) ? r.priority : 'Media',
    deadline:    r.deadline?.trim() || null,
    description: r.description?.trim() || '',
    tags:        r.tags ? r.tags.split('|').map(t => t.trim()).filter(Boolean) : [],
    status:      r.status?.trim() || 'active',
    archived:    false, starred: false, coauthors: [],
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  }));

  if (!toImport.length) {
    preview.innerHTML = `<div class="fs-unsupported" style="margin-top:10px">⚠ No se encontraron filas válidas.</div>`;
    return;
  }

  preview.innerHTML = `
    <div style="margin-top:12px;background:var(--bg-elevated);border:1px solid var(--border);
                border-radius:var(--radius-md);overflow:hidden">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;
                  align-items:center;justify-content:space-between">
        <span style="font-size:.82rem;color:var(--text-1)">
          Vista previa: <strong>${toImport.length}</strong> proyectos a importar
        </span>
        <button class="btn btn-primary btn-sm" id="confirmCsvImport">Importar ${toImport.length} proyectos</button>
      </div>
      <div style="max-height:200px;overflow-y:auto">
        <table style="width:100%;border-collapse:collapse;font-size:.75rem">
          <thead>
            <tr style="background:var(--bg-card)">
              ${['Título','Tipo','Prioridad','Deadline','Responsable'].map(h =>
                `<th style="padding:6px 12px;text-align:left;color:var(--text-2);
                            font-family:var(--font-mono);font-size:.65rem;
                            border-bottom:1px solid var(--border)">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${toImport.slice(0, 20).map((r, i) => `
              <tr style="${i % 2 === 0 ? '' : 'background:var(--bg-surface)'}">
                <td style="padding:5px 12px;color:var(--text-1);max-width:180px;
                           overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.title)}</td>
                <td style="padding:5px 12px"><span class="badge ${typeBadgeClass(r.type)}">${esc(r.type)}</span></td>
                <td style="padding:5px 12px"><span class="badge ${prioBadgeClass(r.priority)}">${esc(r.priority)}</span></td>
                <td style="padding:5px 12px;color:var(--text-2);font-family:var(--font-mono);font-size:.67rem">${r.deadline || '—'}</td>
                <td style="padding:5px 12px;color:var(--text-2)">${esc(r.responsible || '—')}</td>
              </tr>`).join('')}
            ${toImport.length > 20 ? `
              <tr><td colspan="5" style="padding:6px 12px;color:var(--text-3);font-size:.72rem">
                … y ${toImport.length - 20} más
              </td></tr>` : ''}
          </tbody>
        </table>
      </div>
    </div>`;

  $('confirmCsvImport').addEventListener('click', async () => {
    // Columna por defecto: primera columna Kanban
    const cols = await db.kanbanColumns.orderBy('order').toArray();
    const defaultColId = cols[0]?.id ?? 1;
    const withCol = toImport.map(p => ({ ...p, columnId: defaultColId }));
    await db.projects.bulkAdd(withCol);
    preview.innerHTML = '';
    showToast(`${withCol.length} proyectos importados ✓`, 'success');
    await updateBadges();
  });
}

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════
async function init() {
  // Seed database defaults
  await seedDefaults();

  // Theme persistence
  const savedTheme = localStorage.getItem('ros-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  $('themeToggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next    = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ros-theme', next);
  });

  // Navigation history buttons
  $('navBack')?.addEventListener('click', navBack);
  $('navForward')?.addEventListener('click', navForward);

  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-view]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.dataset.view);
    });
  });

  // Presentation mode exit
  $('presExitBtn')?.addEventListener('click', () => {
    document.body.classList.remove('presentation-mode');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' && App.view === 'kanban') {
      e.preventDefault();
      document.body.classList.toggle('presentation-mode');
    }
    if (e.key === 'Escape') {
      document.body.classList.remove('presentation-mode');
    }
  });

  // Inspector close
  $('closeInspector').addEventListener('click', closeInspector);

  // Modal close
  $('modalClose').addEventListener('click', closeModal);
  $('modalOverlay').addEventListener('click', (e) => {
    if (e.target === $('modalOverlay')) closeModal();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePalette(); closeModal(); closeInspector(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      $('paletteOverlay').classList.contains('open') ? closePalette() : openPalette();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'K') {
      e.preventDefault(); navigate('kanban');   // ⌘⇧K → Kanban
    }
    if (e.altKey && e.key === 'ArrowLeft')  navBack();
    if (e.altKey && e.key === 'ArrowRight') navForward();
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault();
      $('pomodoroWidget').classList.toggle('visible');
      $('pomFAB').classList.toggle('active', $('pomodoroWidget').classList.contains('visible'));
      Pomodoro.render();
    }
  });

  _initPalette();
  _initPomodoro();

  // Initial view
  navigate('dashboard');
}

// ══════════════════════════════════════════════════════════════
//  COMMAND PALETTE
// ══════════════════════════════════════════════════════════════
let _paletteActiveIdx = -1;
let _paletteResults   = [];

function openPalette() {
  $('paletteOverlay').classList.add('open');
  const input = $('paletteInput');
  input.value = '';
  input.focus();
  _searchPalette('');
}

function closePalette() {
  $('paletteOverlay').classList.remove('open');
  _paletteActiveIdx = -1;
}

function _paletteSetActive(idx) {
  _paletteActiveIdx = idx;
  $('paletteResults').querySelectorAll('.palette-item').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    if (i === idx) el.scrollIntoView({ block: 'nearest' });
  });
}

async function _searchPalette(q) {
  const lq = q.toLowerCase();
  const [projects, ideas, snippets] = await Promise.all([
    db.projects.toArray(), db.ideas.toArray(), db.snippets.toArray()
  ]);

  const groups = [];

  // Navigation shortcuts (always shown when query is short)
  const navItems = [
    { icon:'◈', label:'Dashboard',   sub:'Vista',    action: () => { closePalette(); navigate('dashboard'); } },
    { icon:'⊞', label:'Kanban',      sub:'Vista',    action: () => { closePalette(); navigate('kanban'); } },
    { icon:'◉', label:'Proyectos',   sub:'Vista',    action: () => { closePalette(); navigate('projects'); } },
    { icon:'◎', label:'Ideas Inbox', sub:'Vista',    action: () => { closePalette(); navigate('ideas'); } },
    { icon:'⟨/⟩',label:'Snippets',  sub:'Vista',    action: () => { closePalette(); navigate('snippets'); } },
    { icon:'⊟', label:'FS Bridge',   sub:'Vista',    action: () => { closePalette(); navigate('filesystem'); } },
    { icon:'⏱', label:'Timeline',    sub:'Vista',    action: () => { closePalette(); navigate('timeline'); } },
  ].filter(n => !lq || n.label.toLowerCase().includes(lq));
  if (navItems.length) groups.push({ label: 'Vistas', items: navItems });

  // Projects
  const pItems = projects
    .filter(p => !lq || p.title.toLowerCase().includes(lq) || (p.description||'').toLowerCase().includes(lq))
    .slice(0, 5)
    .map(p => ({
      icon: '◉', label: p.title, sub: p.type,
      action: () => { closePalette(); navigate('projects'); setTimeout(() => inspectProject(p.id), 120); }
    }));
  if (pItems.length) groups.push({ label: 'Proyectos', items: pItems });

  // Ideas
  const iItems = ideas
    .filter(i => !lq || i.title.toLowerCase().includes(lq) || (i.content||'').toLowerCase().includes(lq))
    .slice(0, 4)
    .map(i => ({
      icon: '◎', label: i.title, sub: 'Idea',
      action: () => { closePalette(); navigate('ideas'); setTimeout(() => inspectIdea(i.id), 120); }
    }));
  if (iItems.length) groups.push({ label: 'Ideas', items: iItems });

  // Snippets
  const sItems = snippets
    .filter(s => !lq || s.title.toLowerCase().includes(lq) || (s.code||'').toLowerCase().includes(lq))
    .slice(0, 4)
    .map(s => ({
      icon: '⟨/⟩', label: s.title, sub: s.language,
      action: () => { closePalette(); navigate('snippets'); }
    }));
  if (sItems.length) groups.push({ label: 'Snippets', items: sItems });

  // Flatten for keyboard navigation
  _paletteResults = groups.flatMap(g => g.items);
  _paletteActiveIdx = _paletteResults.length > 0 ? 0 : -1;

  const container = $('paletteResults');
  if (!_paletteResults.length) {
    container.innerHTML = `<div class="palette-empty">Sin resultados para "${esc(q)}"</div>`;
    return;
  }

  let html = ''; let globalIdx = 0;
  for (const group of groups) {
    html += `<div class="palette-group-label">${esc(group.label)}</div>`;
    for (const item of group.items) {
      html += `<div class="palette-item ${globalIdx === 0 ? 'active' : ''}" data-pidx="${globalIdx}">
        <span class="palette-item-icon">${item.icon}</span>
        <span class="palette-item-label">${esc(item.label)}</span>
        <span class="palette-item-sub">${esc(item.sub)}</span>
      </div>`;
      globalIdx++;
    }
  }
  container.innerHTML = html;

  container.querySelectorAll('.palette-item').forEach(el => {
    const idx = +el.dataset.pidx;
    el.addEventListener('click', () => _paletteResults[idx]?.action());
    el.addEventListener('mouseenter', () => _paletteSetActive(idx));
  });
}

function _initPalette() {
  const input   = $('paletteInput');
  const overlay = $('paletteOverlay');

  input.addEventListener('input',   e => _searchPalette(e.target.value));
  input.addEventListener('keydown', e => {
    const len = _paletteResults.length;
    if (!len) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _paletteSetActive(Math.min(_paletteActiveIdx + 1, len - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _paletteSetActive(Math.max(_paletteActiveIdx - 1, 0));
    } else if (e.key === 'Enter') {
      if (_paletteActiveIdx >= 0) _paletteResults[_paletteActiveIdx]?.action();
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) closePalette(); });
}

// ══════════════════════════════════════════════════════════════
//  SUBTASKS (Ideas)
// ══════════════════════════════════════════════════════════════
async function toggleSubtask(ideaId, taskId) {
  const idea = await db.ideas.get(ideaId);
  const subtasks = (idea.subtasks || []).map(t =>
    t.id === taskId ? { ...t, done: !t.done } : t
  );
  await dbWrite(() => db.ideas.update(ideaId, { subtasks, updatedAt: new Date().toISOString() }));
  inspectIdea(ideaId);
}

async function deleteSubtask(ideaId, taskId) {
  const idea = await db.ideas.get(ideaId);
  const subtasks = (idea.subtasks || []).filter(t => t.id !== taskId);
  await dbWrite(() => db.ideas.update(ideaId, { subtasks, updatedAt: new Date().toISOString() }));
  inspectIdea(ideaId);
}

async function addSubtask(ideaId, text) {
  if (!text.trim()) return;
  const idea = await db.ideas.get(ideaId);
  const subtasks = [...(idea.subtasks || []), { id: Date.now(), text: text.trim(), done: false }];
  await dbWrite(() => db.ideas.update(ideaId, { subtasks, updatedAt: new Date().toISOString() }));
  inspectIdea(ideaId);
}

function subtaskListHTML(idea) {
  const tasks = idea.subtasks || [];
  if (!tasks.length && !true) return '';   // always show section
  const done  = tasks.filter(t => t.done).length;
  return `
    <div class="inspector-related-title">
      Subtareas
      ${tasks.length ? `<span class="subtask-count-badge">${done}/${tasks.length}</span>` : ''}
    </div>
    <div class="subtask-list" id="stList-${idea.id}">
      ${tasks.map(t => `
        <div class="subtask-item">
          <button class="subtask-check ${t.done?'done':''}" data-toggle-st="${t.id}">
            ${t.done ? '✓' : ''}
          </button>
          <span class="subtask-text ${t.done?'done':''}">${esc(t.text)}</span>
          <button class="subtask-del" data-del-st="${t.id}">✕</button>
        </div>`).join('')}
    </div>
    <div class="subtask-add-row">
      <input class="subtask-add-input" id="stInput-${idea.id}" placeholder="Nueva subtarea…" maxlength="200">
      <button class="btn btn-ghost btn-sm" id="stAddBtn-${idea.id}">+</button>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
//  POMODORO / FOCUS MODE
// ══════════════════════════════════════════════════════════════
const Pomodoro = {
  FOCUS_SECS : 25 * 60,
  BREAK_SECS : 5  * 60,
  remaining  : 25 * 60,
  isRunning  : false,
  isFocus    : true,
  sessions   : 0,
  _interval  : null,

  get totalSecs() { return this.isFocus ? this.FOCUS_SECS : this.BREAK_SECS; },

  formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2,'0');
    const sc = (s % 60).toString().padStart(2,'0');
    return `${m}:${sc}`;
  },

  render() {
    const disp  = $('pomDisplay');
    const bar   = $('pomProgressBar');
    const btn   = $('pomStartStop');
    const lbl   = $('pomModeLabel');
    const sess  = $('pomSessions');
    if (!disp) return;

    disp.textContent = this.formatTime(this.remaining);
    disp.className   = 'pom-display' + (this.isRunning ? (this.isFocus ? ' focus-running' : ' break-running') : '');

    const pct = ((this.totalSecs - this.remaining) / this.totalSecs * 100).toFixed(1) + '%';
    bar.style.width = pct;
    bar.className   = 'pom-progress-bar' + (this.isFocus ? '' : ' break');

    btn.textContent = this.isRunning ? '⏸ Pausar' : '▶ Iniciar';
    btn.className   = 'pom-btn' + (this.isRunning ? ' running' : '');

    lbl.textContent = this.isFocus ? 'Enfoque 🔴' : 'Descanso 🟢';

    const dots = Array.from({length:4},(_,i) => i < this.sessions % 4 ? '●' : '○').join(' ');
    sess.textContent = dots;
  },

  startStop() {
    if (this.isRunning) {
      clearInterval(this._interval);
      this.isRunning = false;
      document.body.classList.remove('focus-mode');
    } else {
      this.isRunning = true;
      if (this.isFocus) document.body.classList.add('focus-mode');
      this._interval = setInterval(() => {
        this.remaining--;
        if (this.remaining <= 0) {
          clearInterval(this._interval);
          this.isRunning = false;
          if (this.isFocus) {
            this.sessions++;
            this.isFocus = false;
            this.remaining = this.BREAK_SECS;
            document.body.classList.remove('focus-mode');
            showToast('¡Bloque de enfoque completado! Descansa 5 min 🟢', 'success');
          } else {
            this.isFocus = true;
            this.remaining = this.FOCUS_SECS;
            showToast('Descanso terminado. ¡A trabajar! 🔴', 'info');
          }
          this.render();
          return;
        }
        this.render();
      }, 1000);
    }
    document.body.classList.toggle('focus-mode', this.isRunning && this.isFocus);
    this.render();
  },

  reset() {
    clearInterval(this._interval);
    this.isRunning = false;
    this.remaining = this.isFocus ? this.FOCUS_SECS : this.BREAK_SECS;
    document.body.classList.remove('focus-mode');
    this.render();
  }
};

function _initPomodoro() {
  const widget = $('pomodoroWidget');
  const fab    = $('pomFAB');

  fab.addEventListener('click', () => {
    widget.classList.toggle('visible');
    fab.classList.toggle('active', widget.classList.contains('visible'));
    if (widget.classList.contains('visible')) Pomodoro.render();
  });

  $('pomClose').addEventListener('click', () => {
    widget.classList.remove('visible');
    fab.classList.remove('active');
  });

  $('pomStartStop').addEventListener('click', () => Pomodoro.startStop());
  $('pomReset').addEventListener('click', () => Pomodoro.reset());

  Pomodoro.render();
}

window.addEventListener('DOMContentLoaded', init);
