// ============================================================
//  ResearchOS — Application Core
//  Architecture: Single-Page, local-first, IndexedDB-backed.
//  No framework. Vanilla JS with event delegation.
// ============================================================

'use strict';

// ── App state ────────────────────────────────────────────────
const App = {
  view:             'dashboard',
  draggedId:        null,
  filterLang:       'all',
  lastDirHandle:    null,
  navHistory:       [],
  navIndex:         -1,
  filters:          { type: 'all', priority: 'all', column: 'all' },
  filterCollection: 'all',
  bulkSelected:     new Set(),   // ← NUEVO: IDs seleccionados en bulk
  bulkMode:         false,       // ← NUEVO: toggle del modo selección
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

// ── INSERTAR: Deadline Reminder Module ───────────────────────
const DeadlineReminder = {
  _interval: null,

  async requestPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const p = await Notification.requestPermission();
    return p === 'granted';
  },

  async checkDeadlines() {
    if (Notification.permission !== 'granted') return;
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const projects = await db.projects.filter(p =>
      !p.archived && !!p.deadline
    ).toArray();

    for (const p of projects) {
      const d = new Date(p.deadline + 'T00:00:00');
      const daysLeft = Math.ceil((d - today) / 86400000);
      // Notificar si vence hoy o mañana (y no se notificó ya hoy)
      const notifKey = `notif_${p.id}_${today.toISOString().split('T')[0]}`;
      if (daysLeft <= 1 && daysLeft >= 0 && !sessionStorage.getItem(notifKey)) {
        const label = daysLeft === 0 ? 'VENCE HOY' : 'vence mañana';
        new Notification(`⏱ ResearchOS — ${label}`, {
          body: `"${p.title}" ${daysLeft === 0 ? 'tiene fecha límite hoy.' : 'tiene deadline mañana.'}`,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="28" font-size="28">⬡</text></svg>',
          tag: notifKey,
        });
        sessionStorage.setItem(notifKey, '1');
      }
      // Alerta de overdue (sólo una vez al día)
      if (daysLeft < 0) {
        const overdueKey = `overdue_${p.id}_${today.toISOString().split('T')[0]}`;
        if (!sessionStorage.getItem(overdueKey)) {
          new Notification(`🔴 ResearchOS — Proyecto vencido`, {
            body: `"${p.title}" venció hace ${Math.abs(daysLeft)} día(s).`,
            tag: overdueKey,
          });
          sessionStorage.setItem(overdueKey, '1');
        }
      }
    }
  },

  start() {
    // Comprobar al iniciar y cada 30 min
    this.checkDeadlines();
    this._interval = setInterval(() => this.checkDeadlines(), 30 * 60 * 1000);
  },

  stop() { clearInterval(this._interval); }
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

// ── Render Markdown seguro ─────────────────────────
function renderMd(text) {
  if (!text || typeof marked === 'undefined') return esc(text || '');
  // Configurar marked para no escapar HTML ya escapado
  marked.setOptions({ breaks: true, gfm: true });
  // Sanitizar: stripped de tags peligrosos
  const raw = marked.parse(text);
  return raw.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
            .replace(/on\w+="[^"]*"/gi, '');
}

// ── Render LaTeX con KaTeX ─────────────────────────
function renderLatex(container) {
  if (typeof renderMathInElement === 'undefined') return;
  renderMathInElement(container, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$',  right: '$',  display: false },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
    ],
    throwOnError: false,
  });
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
    starred:      [{label:'Dashboard', view:'dashboard'}, {label:'Favoritos',   view:'starred'}],
    nested:       [{label:'Dashboard', view:'dashboard'}, {label:'Anidados',    view:'nested'}],
    weekly:       [{label:'Dashboard', view:'dashboard'}, {label:'Agenda',      view:'weekly'}],
    submissions:  [{label:'Dashboard', view:'dashboard'}, {label:'Submissions', view:'submissions'}],
    meetings:     [{label:'Dashboard', view:'dashboard'}, {label:'Reuniones',   view:'meetings'}],
    references:   [{label:'Dashboard', view:'dashboard'}, {label:'Referencias', view:'references'}],
    collaborators:[{label:'Dashboard', view:'dashboard'}, {label:'Colaboradores',view:'collaborators'}],
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
    case 'nested':       await renderNestedProjects();  break;
    case 'weekly':       await renderWeeklyAgenda();    break;
    case 'submissions':  await renderSubmissions();     break;
    case 'meetings':     await renderMeetings();        break;
    case 'references':   await renderReferences();      break;
    case 'collaborators':await renderCollaborators();   break;
    default:             await renderDashboard();
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

      <div class="stats-grid-v2">
        <div class="stat-card-v2">
          <div class="stat-card-v2-bg" style="--sc:var(--accent)"></div>
          <div class="stat-card-v2-icon">◉</div>
          <div class="stat-card-v2-content">
            <div class="stat-card-v2-value">${projects}</div>
            <div class="stat-card-v2-label">Proyectos</div>
          </div>
          <svg class="stat-card-v2-arc" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16" fill="none" stroke="var(--accent)"
                    stroke-width="2" stroke-dasharray="${Math.min(projects*10,100)} 100"
                    stroke-linecap="round" transform="rotate(-90 20 20)" opacity=".35"/>
          </svg>
        </div>
        <div class="stat-card-v2">
          <div class="stat-card-v2-bg" style="--sc:#a78bfa"></div>
          <div class="stat-card-v2-icon" style="color:#a78bfa">◎</div>
          <div class="stat-card-v2-content">
            <div class="stat-card-v2-value" style="color:#a78bfa">${ideas}</div>
            <div class="stat-card-v2-label">Ideas</div>
          </div>
          <svg class="stat-card-v2-arc" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16" fill="none" stroke="#a78bfa"
                    stroke-width="2" stroke-dasharray="${Math.min(ideas*8,100)} 100"
                    stroke-linecap="round" transform="rotate(-90 20 20)" opacity=".35"/>
          </svg>
        </div>
        <div class="stat-card-v2">
          <div class="stat-card-v2-bg" style="--sc:var(--amber)"></div>
          <div class="stat-card-v2-icon" style="color:var(--amber)">⚠</div>
          <div class="stat-card-v2-content">
            <div class="stat-card-v2-value" style="color:var(--amber)">${ideaUnread}</div>
            <div class="stat-card-v2-label">Sin revisar</div>
          </div>
          <svg class="stat-card-v2-arc" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16" fill="none" stroke="var(--amber)"
                    stroke-width="2" stroke-dasharray="${Math.min(ideaUnread*20,100)} 100"
                    stroke-linecap="round" transform="rotate(-90 20 20)" opacity=".35"/>
          </svg>
        </div>
        <div class="stat-card-v2">
          <div class="stat-card-v2-bg" style="--sc:var(--green)"></div>
          <div class="stat-card-v2-icon" style="color:var(--green)">⟨/⟩</div>
          <div class="stat-card-v2-content">
            <div class="stat-card-v2-value" style="color:var(--green)">${snippets}</div>
            <div class="stat-card-v2-label">Snippets</div>
          </div>
          <svg class="stat-card-v2-arc" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16" fill="none" stroke="var(--green)"
                    stroke-width="2" stroke-dasharray="${Math.min(snippets*10,100)} 100"
                    stroke-linecap="round" transform="rotate(-90 20 20)" opacity=".35"/>
          </svg>
        </div>
      </div>

      <!-- Mini chart distribución por tipo y por columna -->
      <div class="dash-charts-row">
        <div class="dash-chart-card">
          <div class="dash-chart-title">Distribución por tipo</div>
          <div class="dash-chart-bars" id="typeDistChart">
            ${(() => {
              const types = {};
              allProjects.forEach(p => { types[p.type] = (types[p.type]||0)+1; });
              const max = Math.max(...Object.values(types), 1);
              return Object.entries(types)
                .sort((a,b) => b[1]-a[1])
                .map(([t, n]) => `
                  <div class="dash-bar-row">
                    <span class="dash-bar-label">${esc(t)}</span>
                    <div class="dash-bar-track">
                      <div class="dash-bar-fill" style="width:${(n/max*100).toFixed(1)}%;
                           background:var(--accent)"></div>
                    </div>
                    <span class="dash-bar-val">${n}</span>
                  </div>`).join('') || '<span style="color:var(--text-3);font-size:.75rem">Sin datos</span>';
            })()}
          </div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">Proyectos por columna</div>
          <div class="dash-chart-bars" id="colDistChart">
            ${(() => {
              const colCount = {};
              allProjects.forEach(p => { colCount[p.columnId] = (colCount[p.columnId]||0)+1; });
              const max = Math.max(...Object.values(colCount), 1);
              return cols
                .filter(c => colCount[c.id])
                .map(c => `
                  <div class="dash-bar-row">
                    <span class="dash-bar-label">${esc(c.title)}</span>
                    <div class="dash-bar-track">
                      <div class="dash-bar-fill" style="width:${((colCount[c.id]||0)/max*100).toFixed(1)}%;
                           background:${c.color}"></div>
                    </div>
                    <span class="dash-bar-val">${colCount[c.id]||0}</span>
                  </div>`).join('') || '<span style="color:var(--text-3);font-size:.75rem">Sin datos</span>';
            })()}
          </div>
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
        <span class="kanban-col-count ${col.wip && col.cards.length > col.wip ? 'kanban-wip-exceeded' : ''}">
          ${col.cards.length}${col.wip ? `<span class="kanban-wip-badge">/${col.wip}</span>` : ''}
        </span>
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
        <button class="btn btn-ghost" id="kanbanManageCols">⚙ Columnas</button>
        <button class="btn btn-primary" id="kanbanAddProject">+ Nuevo Proyecto</button>
      </div>
    </div>
    <div class="kanban-board">${boardHTML}</div>`;

  $('kanbanAddProject').addEventListener('click', showAddProjectModal);
  $('kanbanManageCols')?.addEventListener('click', showManageColumnsModal);

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

// ── Gestionar columnas Kanban ───────────────────────
async function showManageColumnsModal() {
  const cols = await db.kanbanColumns.orderBy('order').toArray();

  const renderRows = () => cols.map((c, i) => `
    <div class="col-manage-row" data-col-id="${c.id}">
      <span class="col-manage-handle" title="Reordenar">⠿</span>
      <input class="form-input col-manage-title"
             value="${esc(c.title)}" data-col-id="${c.id}"
             style="flex:1;padding:5px 8px;font-size:.82rem">
      <input type="color" class="col-manage-color"
             value="${c.color}" data-col-id="${c.id}"
             style="width:32px;height:32px;border:none;background:none;cursor:pointer;border-radius:6px">
      <input type="number" class="form-input col-manage-wip"
             value="${c.wip||''}" placeholder="WIP" data-col-id="${c.id}"
             style="width:64px;padding:5px 8px;font-size:.82rem"
             title="Límite de trabajo en curso (dejar vacío = sin límite)">
      <button class="btn btn-ghost btn-sm col-manage-del" data-col-id="${c.id}"
              style="color:var(--red)" ${cols.length <= 1 ? 'disabled' : ''}>✕</button>
    </div>`).join('');

  showModal('⚙ Gestionar columnas Kanban', `
    <div class="modal-body">
      <div style="font-size:.75rem;color:var(--text-3);margin-bottom:10px">
        Edita títulos, colores y límites WIP. Los cambios se aplican al guardar.
      </div>
      <div id="colManageList">${renderRows()}</div>
      <button class="btn btn-ghost btn-sm" id="colAddNew" style="margin-top:10px;width:100%">
        + Nueva columna
      </button>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="colManageCancel">Cancelar</button>
      <button class="btn btn-primary" id="colManageSave">Guardar cambios</button>
    </div>`);

  $('colManageCancel').addEventListener('click', closeModal);

  $('colAddNew').addEventListener('click', () => {
    cols.push({
      id: null, title: 'Nueva columna',
      order: cols.length, color: '#38bdf8', wip: null
    });
    $('colManageList').innerHTML = renderRows();
    attachColRowHandlers();
  });

  const attachColRowHandlers = () => {
    document.querySelectorAll('.col-manage-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const cid = +btn.dataset.colId;
        if (!cid) { cols.splice(cols.findIndex(c => !c.id), 1); $('colManageList').innerHTML = renderRows(); attachColRowHandlers(); return; }
        const count = await db.projects.where('columnId').equals(cid).count();
        if (count > 0 && !confirm(`Esta columna tiene ${count} proyectos. ¿Eliminarla de todos modos?`)) return;
        cols.splice(cols.findIndex(c => c.id === cid), 1);
        $('colManageList').innerHTML = renderRows();
        attachColRowHandlers();
      });
    });
  };
  attachColRowHandlers();

  $('colManageSave').addEventListener('click', async () => {
    // Leer valores editados
    document.querySelectorAll('.col-manage-title').forEach(inp => {
      const cid = +inp.dataset.colId || null;
      const col = cols.find(c => c.id === (cid || null));
      if (col) col.title = inp.value.trim() || col.title;
    });
    document.querySelectorAll('.col-manage-color').forEach(inp => {
      const cid = +inp.dataset.colId || null;
      const col = cols.find(c => c.id === (cid || null));
      if (col) col.color = inp.value;
    });
    document.querySelectorAll('.col-manage-wip').forEach(inp => {
      const cid = +inp.dataset.colId || null;
      const col = cols.find(c => c.id === (cid || null));
      if (col) col.wip = +inp.value || null;
    });

    await dbWrite(async () => {
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        c.order = i;
        if (c.id) {
          await db.kanbanColumns.update(c.id, { title: c.title, color: c.color, order: c.order, wip: c.wip });
        } else {
          await db.kanbanColumns.add({ title: c.title, color: c.color, order: c.order, wip: c.wip, isDefault: false });
        }
      }
      // Eliminar columnas borradas
      const existingIds = cols.filter(c => c.id).map(c => c.id);
      const allIds = (await db.kanbanColumns.toArray()).map(c => c.id);
      const toDelete = allIds.filter(id => !existingIds.includes(id));
      if (toDelete.length) await db.kanbanColumns.bulkDelete(toDelete);
    });

    closeModal();
    showToast('Columnas actualizadas ✓', 'success');
    renderView('kanban');
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
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="bulkToggleBtn"
            style="color:${App.bulkMode ? 'var(--accent)' : 'var(--text-2)'}">
            ${App.bulkMode ? '✕ Cancelar selección' : '⊞ Seleccionar'}
          </button>
          <button class="btn btn-primary" id="projAddBtn">+ Nuevo Proyecto</button>
        </div>
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
      el.addEventListener('click', (e) => {
        if (App.bulkMode) return; // En modo selección, no abrir inspector
        inspectProject(+el.dataset.inspectProject);
      });
    });

    // ── Bulk Actions Bar (insertar al final de renderProjects) ────
    $('bulkToggleBtn')?.addEventListener('click', () => {
      App.bulkMode = !App.bulkMode;
      App.bulkSelected.clear();
      renderView('projects');
    });

    if (App.bulkMode) {
      const bulkBar = document.createElement('div');
      bulkBar.id = 'bulkBar';
      bulkBar.style.cssText = `
        position:sticky; bottom:16px; left:0; right:0; margin:16px 0 0;
        background:var(--bg-card); border:1px solid var(--accent);
        border-radius:var(--radius-lg); padding:10px 16px;
        display:flex; align-items:center; gap:10px;
        box-shadow:0 4px 24px rgba(0,0,0,.4); z-index:50;
      `;
      bulkBar.innerHTML = `
        <span id="bulkCount" style="font-size:.78rem;color:var(--text-2);
              font-family:var(--font-mono);min-width:80px">
          0 seleccionados
        </span>
        <button class="btn btn-ghost btn-sm" id="bkSelectAll">Selec. todos</button>
        <div style="flex:1"></div>
        <button class="btn btn-ghost btn-sm" id="bkMoveCol">⬡ Mover columna</button>
        <button class="btn btn-ghost btn-sm" id="bkPrio">⚑ Prioridad</button>
        <button class="btn btn-ghost btn-sm" id="bkArchive">⊟ Archivar</button>
        <button class="btn btn-ghost btn-sm" id="bkStar">★ Favorito</button>
        <button class="btn btn-ghost btn-sm" id="bkDelete"
          style="color:var(--red)">✕ Eliminar</button>
      `;
      mainContent.querySelector('.view').appendChild(bulkBar);

      const updateBulkCount = () => {
        const el = $('bulkCount');
        if (el) el.textContent = `${App.bulkSelected.size} seleccionados`;
      };

      // Poner checkboxes en las tarjetas ya renderizadas
      const patchCards = () => {
        mainContent.querySelectorAll('[data-inspect-project]').forEach(card => {
          const pid = +card.dataset.inspectProject;
          if (card.querySelector('.bulk-check')) return;
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'bulk-check';
          cb.checked = App.bulkSelected.has(pid);
          cb.style.cssText = 'position:absolute;top:10px;left:10px;accent-color:var(--accent);width:16px;height:16px;cursor:pointer;z-index:5';
          card.style.position = 'relative';
          card.prepend(cb);
          cb.addEventListener('change', (e) => {
            e.stopPropagation();
            if (cb.checked) App.bulkSelected.add(pid);
            else App.bulkSelected.delete(pid);
            updateBulkCount();
          });
          // En modo bulk, click en la tarjeta = toggle checkbox
          card.addEventListener('click', (e) => {
            if (!e.target.closest('.bulk-check') && App.bulkMode) {
              cb.checked = !cb.checked;
              cb.dispatchEvent(new Event('change'));
            }
          }, { once: false });
        });
      };

      // Observar cuando el grid async se puebla
      const grid = $('projectsGrid');
      if (grid) {
        const mo = new MutationObserver(patchCards);
        mo.observe(grid, { childList: true });
        patchCards();
      }

      $('bkSelectAll')?.addEventListener('click', async () => {
        const all = await db.projects.toArray();
        all.filter(p => !p.archived).forEach(p => App.bulkSelected.add(p.id));
        mainContent.querySelectorAll('.bulk-check').forEach(cb => cb.checked = true);
        updateBulkCount();
      });

      $('bkArchive')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        await dbWrite(() => db.projects.where('id').anyOf([...App.bulkSelected]).modify({ archived: true }));
        showToast(`${App.bulkSelected.size} proyectos archivados`, 'success');
        App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
      });

      $('bkStar')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        await dbWrite(() => db.projects.where('id').anyOf([...App.bulkSelected]).modify({ starred: true }));
        showToast(`${App.bulkSelected.size} marcados como favorito`, 'success');
        App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
      });

      $('bkDelete')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        if (!confirm(`¿Eliminar ${App.bulkSelected.size} proyectos permanentemente?`)) return;
        await dbWrite(() => db.projects.where('id').anyOf([...App.bulkSelected]).delete());
        showToast(`${App.bulkSelected.size} proyectos eliminados`, 'success');
        App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
      });

      $('bkMoveCol')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        const cols = await db.kanbanColumns.orderBy('order').toArray();
        showModal('Mover a columna', `
          <div class="modal-body">
            <select class="form-select" id="bkColSel">
              ${cols.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}
            </select>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="bkColCancel">Cancelar</button>
            <button class="btn btn-primary" id="bkColOk">Mover</button>
          </div>`);
        $('bkColCancel').addEventListener('click', closeModal);
        $('bkColOk').addEventListener('click', async () => {
          const colId = +$('bkColSel').value;
          await dbWrite(() => db.projects.where('id').anyOf([...App.bulkSelected]).modify({ columnId: colId }));
          closeModal();
          showToast(`${App.bulkSelected.size} proyectos movidos`, 'success');
          App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
        });
      });

      $('bkPrio')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        showModal('Cambiar prioridad', `
          <div class="modal-body">
            <select class="form-select" id="bkPrioSel">
              ${['Alta','Media','Baja'].map(p => `<option>${p}</option>`).join('')}
            </select>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="bkPrioCancel">Cancelar</button>
            <button class="btn btn-primary" id="bkPrioOk">Aplicar</button>
          </div>`);
        $('bkPrioCancel').addEventListener('click', closeModal);
        $('bkPrioOk').addEventListener('click', async () => {
          const prio = $('bkPrioSel').value;
          await dbWrite(() => db.projects.where('id').anyOf([...App.bulkSelected]).modify({ priority: prio }));
          closeModal();
          showToast(`Prioridad actualizada en ${App.bulkSelected.size} proyectos`, 'success');
          App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
        });
      });
    }
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
          <select class="inbox-select" id="ideaProjectSelect" multiple
            style="height:auto;min-height:36px;max-height:80px" title="Ctrl+click para múltiples">
            ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
          </select>
          <div style="font-size:.65rem;color:var(--text-3);margin-top:2px">Ctrl+click = múltiples proyectos</div>
          <button class="btn btn-primary" id="saveIdeaBtn">Guardar</button>
        </div>
      </div>

      <!-- Panel de ecuaciones LaTeX -->
      <div class="inbox-capture" id="latexPanel" style="margin-top:0">
        <div class="inbox-capture-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>∑ Ecuaciones LaTeX</span>
          <button class="btn btn-ghost btn-sm" id="latexToggleBtn" style="font-size:.7rem">
            ${App._latexOpen ? '▲ Ocultar' : '▼ Mostrar'}
          </button>
        </div>
        ${App._latexOpen ? `
          <div style="display:flex;gap:8px;margin-bottom:8px">
            <textarea class="inbox-input inbox-textarea" id="latexInput"
              style="font-family:var(--font-mono);font-size:.8rem;min-height:64px"
              placeholder="Escribe LaTeX: \\frac{d}{dx} f(x) o $$E = mc^2$$"></textarea>
          </div>
          <div class="latex-preview" id="latexPreview"
            style="background:var(--bg-elevated);padding:12px;border-radius:var(--radius-md);
                   min-height:48px;font-size:1rem;color:var(--text-1);text-align:center">
            <span style="color:var(--text-3);font-size:.78rem">Vista previa aquí…</span>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\frac{a}{b}">Fracción</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\sum_{i=0}^{n} x_i">Suma</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\int_{a}^{b} f(x)\\,dx">Integral</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\sqrt{x^2 + y^2}">Raíz</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\lim_{x \\to \\infty}">Límite</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}">Matriz</button>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button class="btn btn-primary btn-sm" id="latexSaveBtn">💾 Guardar como idea</button>
            <button class="btn btn-ghost btn-sm" id="latexCopyBtn">📋 Copiar</button>
          </div>
        ` : ''}
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
  // ── Listeners del panel LaTeX ──────────────────────
  if (!App._latexOpen) App._latexOpen = false;

  $('latexToggleBtn')?.addEventListener('click', () => {
    App._latexOpen = !App._latexOpen;
    renderView('ideas');
  });

  const latexInput = $('latexInput');
  const latexPreview = $('latexPreview');

  latexInput?.addEventListener('input', () => {
    const val = latexInput.value.trim();
    latexPreview.innerHTML = val
      ? `\\[${val.replace(/^\$\$?|\$\$?$/g, '')}\\]`
      : '<span style="color:var(--text-3);font-size:.78rem">Vista previa aquí…</span>';
    if (val) renderLatex(latexPreview);
  });

  mainContent.querySelectorAll('[data-latex-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!latexInput) return;
      latexInput.value = btn.dataset.latexPreset;
      latexInput.dispatchEvent(new Event('input'));
    });
  });

  $('latexCopyBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(latexInput?.value || '');
    showToast('LaTeX copiado ✓', 'success');
  });

  $('latexSaveBtn')?.addEventListener('click', async () => {
    const latex = latexInput?.value.trim();
    if (!latex) return showToast('Escribe una ecuación primero', 'error');
    await dbWrite(() => db.ideas.add({
      title:     `Ecuación: ${latex.slice(0,40)}`,
      content:   `$$${latex}$$`,
      status:    'unread', projectId: null,
      tags:      ['latex', 'ecuación'],
      subtasks:  [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    showToast('Ecuación guardada como idea ✓', 'success');
    if (latexInput) latexInput.value = '';
    renderView('ideas');
  });

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

  // ── renderizar LaTeX en ideas del listado ───────────
  setTimeout(() => {
    const list = $('ideasList');
    if (list) renderLatex(list);
  }, 80);
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
          ${(idea.projectIds||[idea.projectId]).filter(Boolean).map(pid => {
            const p = projMap[pid];
            return p ? `<span class="idea-linked" data-inspect-project="${pid}" style="cursor:pointer"
              title="Ver proyecto">⬡ ${esc(p.title)}</span>` : '';
          }).join('')}
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
  const selEl = $('ideaProjectSelect');
  const projectIds = selEl
    ? [...selEl.selectedOptions].map(o => +o.value).filter(Boolean)
    : [];
  const projectId = projectIds[0] || null; // compatibilidad legacy
  await dbWrite(() => db.ideas.add({
    title, content, status: 'unread', projectId, projectIds,
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

// ── Vista Proyectos Anidados ────────────────────────
async function renderNestedProjects() {
  const all  = await db.projects.filter(p => !p.archived).toArray();
  const cols = await db.kanbanColumns.toArray();
  const colMap = Object.fromEntries(cols.map(c => [c.id, c]));

  // Separar raíz (sin parentId) de hijos
  const roots    = all.filter(p => !p.parentId);
  const childMap = {};
  all.filter(p => p.parentId).forEach(p => {
    if (!childMap[p.parentId]) childMap[p.parentId] = [];
    childMap[p.parentId].push(p);
  });

  function nodeHTML(p, depth = 0) {
    const children = childMap[p.id] || [];
    const col = colMap[p.columnId];
    const indent = depth * 20;
    return `
      <div class="nested-node" data-depth="${depth}" style="margin-left:${indent}px">
        <div class="nested-node-row" data-inspect-project="${p.id}">
          <span class="nested-expand ${children.length ? '' : 'no-children'}"
                data-nest-toggle="${p.id}">${children.length ? '▶' : '·'}</span>
          <span class="nested-dot" style="background:${col?.color||'#888'}"></span>
          <span class="nested-title">${esc(p.title)}</span>
          <span class="badge ${typeBadgeClass(p.type)} nested-badge">${esc(p.type)}</span>
          <span class="badge ${prioBadgeClass(p.priority)} nested-badge">${esc(p.priority)}</span>
          ${p.deadline ? `<span class="nested-deadline">⏱ ${formatDate(p.deadline)}</span>` : ''}
          <span class="nested-col">${esc(col?.title||'—')}</span>
          <span class="nested-actions">
            <button class="btn btn-ghost btn-sm" data-nest-add-child="${p.id}" title="Añadir subproyecto">+</button>
          </span>
        </div>
        ${children.length ? `
          <div class="nested-children" id="nestChildren-${p.id}">
            ${children.map(ch => nodeHTML(ch, depth + 1)).join('')}
          </div>` : ''}
      </div>`;
  }

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">⬡ Proyectos Anidados</div>
          <div class="view-subtitle">${roots.length} proyectos raíz · ${all.length} total</div>
        </div>
        <button class="btn btn-primary" id="nestAddRoot">+ Proyecto Raíz</button>
      </div>
      <div class="nested-tree" id="nestedTree">
        ${roots.length
          ? roots.map(r => nodeHTML(r, 0)).join('')
          : `<div class="empty-state">
               <span class="empty-state-icon">⬡</span>
               <h3>Sin proyectos</h3>
               <p>Crea tu primer proyecto raíz</p>
             </div>`}
      </div>
    </div>`;

  // Inspect al hacer click en la fila
  mainContent.querySelectorAll('[data-inspect-project]').forEach(el => {
    el.addEventListener('click', e => {
      if (!e.target.closest('[data-nest-toggle]') && !e.target.closest('[data-nest-add-child]'))
        inspectProject(+el.dataset.inspectProject);
    });
  });

  // Toggle colapsar/expandir hijos
  mainContent.querySelectorAll('[data-nest-toggle]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pid  = +btn.dataset.nestToggle;
      const cont = document.getElementById(`nestChildren-${pid}`);
      if (!cont) return;
      const collapsed = cont.style.display === 'none';
      cont.style.display = collapsed ? '' : 'none';
      btn.textContent = collapsed ? '▶' : '▼';
    });
  });

  // Añadir subproyecto
  mainContent.querySelectorAll('[data-nest-add-child]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const parentId = +btn.dataset.nestAddChild;
      showAddProjectModal(null, parentId); // ver 6.c
    });
  });

  $('nestAddRoot')?.addEventListener('click', () => showAddProjectModal(null, null));
}

// ══════════════════════════════════════════════════════════════
//  VIEW: AGENDA SEMANAL (solo lectura — agrega deadlines,
//        submissions, reuniones y recordatorios de la semana)
// ══════════════════════════════════════════════════════════════
async function renderWeeklyAgenda() {
  const today = new Date(); today.setHours(0,0,0,0);
  const days  = Array.from({length: 7}, (_, i) => {
    const d = new Date(today); d.setDate(today.getDate() + i); return d;
  });
  const isoDay = d => d.toISOString().split('T')[0];

  // Recoger datos
  const [projects, submissions, meetings] = await Promise.all([
    db.projects.filter(p => !p.archived && !!p.deadline).toArray(),
    db.submissions.toArray(),
    db.meetings.toArray(),
  ]);

  // Indexar por día
  const byDay = {};
  days.forEach(d => { byDay[isoDay(d)] = { deadlines:[], submissions:[], meetings:[] }; });

  projects.forEach(p => {
    if (byDay[p.deadline]) byDay[p.deadline].deadlines.push(p);
  });
  submissions.forEach(s => {
    if (s.deadlineAt && byDay[s.deadlineAt]) byDay[s.deadlineAt].submissions.push(s);
    if (s.submittedAt && byDay[s.submittedAt]) byDay[s.submittedAt].submissions.push({...s, _submitted:true});
  });
  meetings.forEach(m => {
    if (byDay[m.date]) byDay[m.date].meetings.push(m);
  });

  const dayLabels = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const monthNames = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

  const dayHTML = (d) => {
    const iso   = isoDay(d);
    const data  = byDay[iso];
    const isToday = iso === isoDay(today);
    const total = data.deadlines.length + data.submissions.length + data.meetings.length;
    return `
      <div class="weekly-day ${isToday ? 'weekly-today' : ''} ${total === 0 ? 'weekly-empty' : ''}">
        <div class="weekly-day-header">
          <span class="weekly-day-name">${dayLabels[d.getDay()]}</span>
          <span class="weekly-day-num ${isToday ? 'weekly-day-num-today' : ''}">
            ${d.getDate()} ${monthNames[d.getMonth()]}
          </span>
        </div>
        <div class="weekly-events">
          ${data.deadlines.map(p => `
            <div class="weekly-event weekly-event-deadline" data-inspect-project="${p.id}">
              <span class="weekly-event-dot" style="background:var(--red)"></span>
              <span class="weekly-event-text">⏱ ${esc(p.title)}</span>
              <span class="badge ${typeBadgeClass(p.type)}" style="font-size:.58rem">${esc(p.type)}</span>
            </div>`).join('')}
          ${data.submissions.map(s => `
            <div class="weekly-event weekly-event-submission" data-inspect-submission="${s.id}">
              <span class="weekly-event-dot" style="background:var(--amber)"></span>
              <span class="weekly-event-text">📤 ${esc(s.title)}</span>
              <span class="weekly-event-badge">${s._submitted ? 'Enviado' : 'Deadline'}</span>
            </div>`).join('')}
          ${data.meetings.map(m => `
            <div class="weekly-event weekly-event-meeting" data-inspect-meeting="${m.id}">
              <span class="weekly-event-dot" style="background:var(--teal)"></span>
              <span class="weekly-event-text">🗓 ${esc(m.title)}</span>
            </div>`).join('')}
          ${total === 0 ? `<div class="weekly-free">—</div>` : ''}
        </div>
      </div>`;
  };

  const weekLabel = `${days[0].getDate()} ${monthNames[days[0].getMonth()]} — ${days[6].getDate()} ${monthNames[days[6].getMonth()]} ${days[6].getFullYear()}`;

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">📅 Agenda Semanal</div>
          <div class="view-subtitle">${weekLabel}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" id="weeklyAddMeeting">+ Reunión</button>
          <button class="btn btn-ghost btn-sm" id="weeklyAddSubmission">+ Submission</button>
        </div>
      </div>
      <div class="weekly-grid">
        ${days.map(dayHTML).join('')}
      </div>
    </div>`;

  // Handlers
  mainContent.querySelectorAll('[data-inspect-project]').forEach(el =>
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject)));
  mainContent.querySelectorAll('[data-inspect-submission]').forEach(el =>
    el.addEventListener('click', () => inspectSubmission(+el.dataset.inspectSubmission)));
  mainContent.querySelectorAll('[data-inspect-meeting]').forEach(el =>
    el.addEventListener('click', () => inspectMeeting(+el.dataset.inspectMeeting)));

  $('weeklyAddMeeting')?.addEventListener('click', showAddMeetingModal);
  $('weeklyAddSubmission')?.addEventListener('click', showAddSubmissionModal);
}

// ══════════════════════════════════════════════════════════════
//  VIEW: SUBMISSION TRACKER
// ══════════════════════════════════════════════════════════════
const SUB_STATUSES = [
  { key: 'preparacion',       label: 'En preparación', color: 'var(--text-3)' },
  { key: 'enviado',           label: 'Enviado',        color: 'var(--accent)' },
  { key: 'en_revision',       label: 'En revisión',    color: 'var(--amber)'  },
  { key: 'revision_solicitada', label: 'Rev. solicitada', color: 'var(--purple)'},
  { key: 'aceptado',          label: 'Aceptado ✓',    color: 'var(--green)'  },
  { key: 'rechazado',         label: 'Rechazado',      color: 'var(--red)'    },
];
const SUB_TYPES = ['Paper','Grant','Ponencia','Capítulo','Reporte','Otro'];

function subStatusBadge(status) {
  const s = SUB_STATUSES.find(s => s.key === status) || SUB_STATUSES[0];
  return `<span class="badge" style="background:color-mix(in srgb,${s.color} 18%,transparent);
          color:${s.color};border:1px solid color-mix(in srgb,${s.color} 35%,transparent)">${s.label}</span>`;
}

async function renderSubmissions() {
  const [subs, projects] = await Promise.all([
    db.submissions.orderBy('createdAt').reverse().toArray(),
    db.projects.toArray()
  ]);
  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));

  // Pipeline counts
  const counts = {};
  SUB_STATUSES.forEach(s => { counts[s.key] = subs.filter(sub => sub.status === s.key).length; });

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">📤 Submission Tracker</div>
          <div class="view-subtitle">${subs.length} envío(s) registrado(s)</div>
        </div>
        <button class="btn btn-primary" id="addSubmissionBtn">+ Nuevo envío</button>
      </div>

      <!-- Pipeline overview -->
      <div class="sub-pipeline">
        ${SUB_STATUSES.map(s => `
          <div class="sub-pipeline-stage">
            <div class="sub-pipeline-count" style="color:${s.color}">${counts[s.key]}</div>
            <div class="sub-pipeline-label">${s.label}</div>
          </div>`).join('')}
      </div>

      <!-- Submissions list -->
      <div class="sub-list">
        ${subs.length ? subs.map(s => {
          const proj = s.projectId ? projMap[s.projectId] : null;
          const today = new Date(); today.setHours(0,0,0,0);
          const daysToDeadline = s.deadlineAt
            ? Math.ceil((new Date(s.deadlineAt + 'T00:00:00') - today) / 86400000) : null;
          return `
            <div class="sub-card" data-inspect-submission="${s.id}">
              <div class="sub-card-top">
                <div class="sub-card-title">${esc(s.title)}</div>
                ${subStatusBadge(s.status)}
              </div>
              <div class="sub-card-meta">
                <span class="badge" style="background:var(--bg-elevated);color:var(--text-2)">
                  ${esc(s.type || 'Paper')}
                </span>
                ${s.targetVenue ? `<span style="color:var(--text-2);font-size:.75rem">→ ${esc(s.targetVenue)}</span>` : ''}
                ${proj ? `<span style="color:var(--accent);font-size:.72rem;cursor:pointer"
                  data-inspect-project="${proj.id}">⬡ ${esc(proj.title)}</span>` : ''}
              </div>
              <div class="sub-card-dates">
                ${s.deadlineAt ? `<span style="font-size:.72rem;font-family:var(--font-mono);
                  color:${daysToDeadline !== null && daysToDeadline <= 7 ? 'var(--red)' : 'var(--text-3)'}">
                  ⏱ Deadline: ${formatDate(s.deadlineAt)}
                  ${daysToDeadline !== null && daysToDeadline >= 0 && daysToDeadline <= 30 ? `(${daysToDeadline}d)` : ''}
                </span>` : ''}
                ${s.submittedAt ? `<span style="font-size:.72rem;font-family:var(--font-mono);color:var(--text-3)">
                  ✓ Enviado: ${formatDate(s.submittedAt)}
                </span>` : ''}
              </div>
            </div>`;
        }).join('')
        : `<div class="empty-state">
             <span class="empty-state-icon">📤</span>
             <h3>Sin envíos registrados</h3>
             <p>Registra papers, grants y ponencias para hacer seguimiento</p>
           </div>`}
      </div>
    </div>`;

  $('addSubmissionBtn').addEventListener('click', showAddSubmissionModal);
  mainContent.querySelectorAll('[data-inspect-submission]').forEach(el =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-inspect-project]')) return;
      inspectSubmission(+el.dataset.inspectSubmission);
    }));
  mainContent.querySelectorAll('[data-inspect-project]').forEach(el =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      inspectProject(+el.dataset.inspectProject);
    }));
}

async function showAddSubmissionModal(prefillDate = null) {
  const projects = await db.projects.toArray();
  showModal('📤 Nuevo Envío', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="asub-title" placeholder="Título del paper, grant o ponencia…">
      </div>
      <div class="form-group">
        <label class="form-label">Tipo</label>
        <select class="form-select" id="asub-type">
          ${SUB_TYPES.map(t => `<option>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Venue / Journal / Fondo objetivo</label>
        <input class="form-input" id="asub-venue" placeholder="Nature, FONDECYT, ISMIR 2025…">
      </div>
      <div class="form-group">
        <label class="form-label">Estado inicial</label>
        <select class="form-select" id="asub-status">
          ${SUB_STATUSES.map(s => `<option value="${s.key}">${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Deadline de envío</label>
        <input class="form-input" type="date" id="asub-deadline" value="${prefillDate || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Fecha de envío efectivo</label>
        <input class="form-input" type="date" id="asub-submitted">
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="asub-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Notas</label>
        <textarea class="form-textarea" id="asub-notes" rows="2" placeholder="Factor de impacto, contexto, ronda…"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="asubCancel">Cancelar</button>
      <button class="btn btn-primary" id="asubSave">Guardar</button>
    </div>`);
  setTimeout(() => $('asub-title')?.focus(), 60);
  $('asubCancel').addEventListener('click', closeModal);
  $('asubSave').addEventListener('click', async () => {
    const title = $('asub-title').value.trim();
    if (!title) { showToast('El título es requerido', 'error'); return; }
    const now = new Date().toISOString();
    await dbWrite(() => db.submissions.add({
      title,
      type:        $('asub-type').value,
      targetVenue: $('asub-venue').value.trim(),
      status:      $('asub-status').value,
      deadlineAt:  $('asub-deadline').value || null,
      submittedAt: $('asub-submitted').value || null,
      projectId:   +$('asub-project').value || null,
      notes:       $('asub-notes').value.trim(),
      rounds:      [],
      createdAt:   now, updatedAt: now
    }));
    closeModal();
    showToast('Envío registrado ✓', 'success');
    if (App.view === 'submissions') renderSubmissions();
    updateBadges();
  });
}

async function inspectSubmission(id) {
  const s = await db.submissions.get(id);
  if (!s) return;
  const proj = s.projectId ? await db.projects.get(s.projectId) : null;

  inspectorBody.innerHTML = `
    <div>
      <div style="margin-bottom:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${subStatusBadge(s.status)}
        <span class="badge" style="background:var(--bg-elevated);color:var(--text-2)">${esc(s.type||'Paper')}</span>
      </div>
      <div class="inspector-project-title">${esc(s.title)}</div>
      <div class="inspector-meta">
        ${s.targetVenue ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Venue</span>
          <span class="inspector-meta-val">${esc(s.targetVenue)}</span>
        </div>` : ''}
        ${proj ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Proyecto</span>
          <span class="inspector-meta-val" style="cursor:pointer;color:var(--accent)"
                id="subNavProj">${esc(proj.title)}</span>
        </div>` : ''}
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Deadline</span>
          <span class="inspector-meta-val">${s.deadlineAt ? formatDate(s.deadlineAt) : '—'}</span>
        </div>
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Enviado</span>
          <span class="inspector-meta-val">${s.submittedAt ? formatDate(s.submittedAt) : '—'}</span>
        </div>
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Creado</span>
          <span class="inspector-meta-val">${relativeDate(s.createdAt)}</span>
        </div>
      </div>
      ${s.notes ? `<div class="inspector-desc">${esc(s.notes)}</div>` : ''}

      <div class="inspector-related-title">Cambiar estado</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">
        ${SUB_STATUSES.map(st => `
          <button class="btn btn-ghost btn-sm sub-status-btn ${s.status === st.key ? 'active' : ''}"
                  data-status="${st.key}"
                  style="${s.status === st.key ? `border-color:${st.color};color:${st.color}` : ''}">
            ${st.label}
          </button>`).join('')}
      </div>

      <!-- Rondas de revisión -->
      <div class="inspector-related-title">
        Rondas de revisión (${(s.rounds||[]).length})
      </div>
      <div class="sub-rounds-list">
        ${(s.rounds||[]).map((r, i) => `
          <div class="sub-round-item">
            <span class="history-ts">${formatDate(r.date)}</span>
            <span class="badge" style="font-size:.65rem">${esc(r.status)}</span>
            <span style="font-size:.75rem;color:var(--text-2)">${esc(r.notes||'')}</span>
          </div>`).join('')}
      </div>
      <div class="subtask-add-row" style="margin-top:6px">
        <input class="subtask-add-input" id="roundNotes" placeholder="Notas de nueva ronda…">
        <select class="form-select" id="roundStatus" style="width:130px;padding:4px 6px;font-size:.75rem">
          ${SUB_STATUSES.map(st => `<option value="${st.key}">${st.label}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-sm" id="addRoundBtn">+</button>
      </div>

      <div class="inspector-actions" style="margin-top:14px">
        <button class="btn btn-ghost btn-sm" id="subEditBtn">✎ Editar</button>
        <button class="btn btn-danger btn-sm" id="subDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();

  $('subNavProj')?.addEventListener('click', () => {
    navigate('projects'); setTimeout(() => inspectProject(proj.id), 120);
  });

  inspectorBody.querySelectorAll('.sub-status-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await dbWrite(() => db.submissions.update(id, {
        status: btn.dataset.status, updatedAt: new Date().toISOString()
      }));
      showToast('Estado actualizado ✓', 'success');
      inspectSubmission(id);
      if (App.view === 'submissions') renderSubmissions();
      updateBadges();
    });
  });

  $('addRoundBtn').addEventListener('click', async () => {
    const notes  = $('roundNotes').value.trim();
    const status = $('roundStatus').value;
    const rounds = [...(s.rounds||[]), {
      date: new Date().toISOString().split('T')[0], status, notes
    }];
    await dbWrite(() => db.submissions.update(id, { rounds, updatedAt: new Date().toISOString() }));
    showToast('Ronda registrada ✓', 'success');
    inspectSubmission(id);
  });

  $('subEditBtn').addEventListener('click', () => showEditSubmissionModal(s));
  $('subDeleteBtn').addEventListener('click', async () => {
    if (!confirm(`¿Eliminar "${s.title}"?`)) return;
    await db.submissions.delete(id);
    closeInspector();
    showToast('Envío eliminado', 'info');
    if (App.view === 'submissions') renderSubmissions();
    updateBadges();
  });
}

async function showEditSubmissionModal(s) {
  const projects = await db.projects.toArray();
  showModal('✎ Editar Envío', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="esub-title" value="${esc(s.title)}">
      </div>
      <div class="form-group">
        <label class="form-label">Tipo</label>
        <select class="form-select" id="esub-type">
          ${SUB_TYPES.map(t => `<option ${t===s.type?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Venue / Journal / Fondo</label>
        <input class="form-input" id="esub-venue" value="${esc(s.targetVenue||'')}">
      </div>
      <div class="form-group">
        <label class="form-label">Estado</label>
        <select class="form-select" id="esub-status">
          ${SUB_STATUSES.map(st => `<option value="${st.key}" ${st.key===s.status?'selected':''}>${st.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Deadline</label>
        <input class="form-input" type="date" id="esub-deadline" value="${s.deadlineAt||''}">
      </div>
      <div class="form-group">
        <label class="form-label">Fecha de envío</label>
        <input class="form-input" type="date" id="esub-submitted" value="${s.submittedAt||''}">
      </div>
      <div class="form-group">
        <label class="form-label">Proyecto</label>
        <select class="form-select" id="esub-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p => `<option value="${p.id}" ${p.id===s.projectId?'selected':''}>${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Notas</label>
        <textarea class="form-textarea" id="esub-notes" rows="2">${esc(s.notes||'')}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="esubCancel">Cancelar</button>
      <button class="btn btn-primary" id="esubSave">Guardar</button>
    </div>`);
  $('esubCancel').addEventListener('click', closeModal);
  $('esubSave').addEventListener('click', async () => {
    const title = $('esub-title').value.trim();
    if (!title) { showToast('Título requerido', 'error'); return; }
    await dbWrite(() => db.submissions.update(s.id, {
      title, type: $('esub-type').value,
      targetVenue: $('esub-venue').value.trim(),
      status:      $('esub-status').value,
      deadlineAt:  $('esub-deadline').value || null,
      submittedAt: $('esub-submitted').value || null,
      projectId:   +$('esub-project').value || null,
      notes:       $('esub-notes').value.trim(),
      updatedAt:   new Date().toISOString()
    }));
    closeModal();
    showToast('Envío actualizado ✓', 'success');
    inspectSubmission(s.id);
    if (App.view === 'submissions') renderSubmissions();
  });
}

// ══════════════════════════════════════════════════════════════
//  VIEW: LOG DE REUNIONES
// ══════════════════════════════════════════════════════════════
async function renderMeetings() {
  const [meetings, projects] = await Promise.all([
    db.meetings.orderBy('date').reverse().toArray(),
    db.projects.toArray()
  ]);
  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">🗓 Log de Reuniones</div>
          <div class="view-subtitle">${meetings.length} reunión(es) registrada(s)</div>
        </div>
        <button class="btn btn-primary" id="addMeetingBtn">+ Reunión</button>
      </div>
      <div class="meetings-list">
        ${meetings.length ? meetings.map(m => {
          const proj = m.projectId ? projMap[m.projectId] : null;
          const ais  = (m.actionItems || []).filter(a => !a.done);
          return `
            <div class="meeting-card" data-inspect-meeting="${m.id}">
              <div class="meeting-card-date">${formatDate(m.date)}</div>
              <div class="meeting-card-title">${esc(m.title)}</div>
              ${m.participants ? `<div class="meeting-card-meta">👤 ${esc(m.participants)}</div>` : ''}
              ${proj ? `<div class="meeting-card-meta" style="color:var(--accent)">⬡ ${esc(proj.title)}</div>` : ''}
              ${ais.length ? `<div class="meeting-card-meta" style="color:var(--amber)">
                ⚑ ${ais.length} acción(es) pendiente(s)
              </div>` : ''}
            </div>`;
        }).join('')
        : `<div class="empty-state">
             <span class="empty-state-icon">🗓</span>
             <h3>Sin reuniones registradas</h3>
             <p>Registra reuniones con colaboradores, comités o directores</p>
           </div>`}
      </div>
    </div>`;

  $('addMeetingBtn').addEventListener('click', showAddMeetingModal);
  mainContent.querySelectorAll('[data-inspect-meeting]').forEach(el =>
    el.addEventListener('click', () => inspectMeeting(+el.dataset.inspectMeeting)));
}

async function showAddMeetingModal(prefillDate = null) {
  const projects = await db.projects.toArray();
  showModal('🗓 Nueva Reunión', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título / Propósito *</label>
        <input class="form-input" id="am-title" placeholder="Reunión de avance, Defensa capítulo 3…">
      </div>
      <div class="form-group">
        <label class="form-label">Fecha *</label>
        <input class="form-input" type="date" id="am-date" value="${prefillDate || new Date().toISOString().split('T')[0]}">
      </div>
      <div class="form-group">
        <label class="form-label">Participantes</label>
        <input class="form-input" id="am-participants" placeholder="Dr. García, Dr. Vega…">
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="am-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Acuerdos / Resumen</label>
        <textarea class="form-textarea" id="am-agreements" rows="3"
          placeholder="Se acordó enviar borrador antes del 15…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Próximos pasos (uno por línea)</label>
        <textarea class="form-textarea" id="am-actions" rows="3"
          placeholder="Revisar sección 2&#10;Enviar datos a Dr. Vega&#10;Preparar slides"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="amCancel">Cancelar</button>
      <button class="btn btn-primary" id="amSave">Guardar</button>
    </div>`);
  setTimeout(() => $('am-title')?.focus(), 60);
  $('amCancel').addEventListener('click', closeModal);
  $('amSave').addEventListener('click', async () => {
    const title = $('am-title').value.trim();
    const date  = $('am-date').value;
    if (!title || !date) { showToast('Título y fecha son requeridos', 'error'); return; }
    const actionItems = $('am-actions').value.split('\n')
      .map(s => s.trim()).filter(Boolean)
      .map(text => ({ id: Date.now() + Math.random(), text, done: false }));
    const now = new Date().toISOString();
    await dbWrite(() => db.meetings.add({
      title, date,
      participants: $('am-participants').value.trim(),
      projectId:    +$('am-project').value || null,
      agreements:   $('am-agreements').value.trim(),
      actionItems,
      createdAt: now, updatedAt: now
    }));
    closeModal();
    showToast('Reunión guardada ✓', 'success');
    if (App.view === 'meetings') renderMeetings();
    if (App.view === 'weekly') renderWeeklyAgenda();
  });
}

async function inspectMeeting(id) {
  const m    = await db.meetings.get(id);
  if (!m) return;
  const proj = m.projectId ? await db.projects.get(m.projectId) : null;
  const ais  = m.actionItems || [];

  inspectorBody.innerHTML = `
    <div>
      <div class="inspector-project-title">${esc(m.title)}</div>
      <div class="inspector-meta">
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Fecha</span>
          <span class="inspector-meta-val">${formatDate(m.date)}</span>
        </div>
        ${m.participants ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Participantes</span>
          <span class="inspector-meta-val">${esc(m.participants)}</span>
        </div>` : ''}
        ${proj ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Proyecto</span>
          <span class="inspector-meta-val" style="cursor:pointer;color:var(--accent)"
                id="meetNavProj">${esc(proj.title)}</span>
        </div>` : ''}
      </div>
      ${m.agreements ? `
        <div class="inspector-related-title">Acuerdos / Resumen</div>
        <div class="inspector-desc">${esc(m.agreements)}</div>` : ''}

      <div class="inspector-related-title">
        Próximos pasos
        ${ais.length ? `<span class="subtask-count-badge">${ais.filter(a=>a.done).length}/${ais.length}</span>` : ''}
      </div>
      <div class="subtask-list">
        ${ais.map(a => `
          <div class="subtask-item">
            <button class="subtask-check ${a.done?'done':''}" data-toggle-ai="${a.id}">${a.done?'✓':''}</button>
            <span class="subtask-text ${a.done?'done':''}">${esc(a.text)}</span>
          </div>`).join('')}
      </div>

      <div class="inspector-actions" style="margin-top:14px">
        <button class="btn btn-ghost btn-sm" id="meetEditBtn">✎ Editar</button>
        <button class="btn btn-danger btn-sm" id="meetDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();

  $('meetNavProj')?.addEventListener('click', () => {
    navigate('projects'); setTimeout(() => inspectProject(proj.id), 120);
  });

  inspectorBody.querySelectorAll('[data-toggle-ai]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const aid = btn.dataset.toggleAi;
      const updated = ais.map(a => a.id == aid ? {...a, done: !a.done} : a);
      await dbWrite(() => db.meetings.update(id, { actionItems: updated, updatedAt: new Date().toISOString() }));
      inspectMeeting(id);
    });
  });

  $('meetEditBtn').addEventListener('click', async () => {
    const projects = await db.projects.toArray();
    showModal('✎ Editar Reunión', `
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Título *</label>
          <input class="form-input" id="em-title" value="${esc(m.title)}">
        </div>
        <div class="form-group">
          <label class="form-label">Fecha *</label>
          <input class="form-input" type="date" id="em-date" value="${m.date}">
        </div>
        <div class="form-group">
          <label class="form-label">Participantes</label>
          <input class="form-input" id="em-participants" value="${esc(m.participants||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Proyecto</label>
          <select class="form-select" id="em-project">
            <option value="">Sin proyecto</option>
            ${projects.map(p => `<option value="${p.id}" ${p.id===m.projectId?'selected':''}>${esc(p.title)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Acuerdos</label>
          <textarea class="form-textarea" id="em-agreements" rows="3">${esc(m.agreements||'')}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="emCancel">Cancelar</button>
        <button class="btn btn-primary" id="emSave">Guardar</button>
      </div>`);
    $('emCancel').addEventListener('click', closeModal);
    $('emSave').addEventListener('click', async () => {
      const title = $('em-title').value.trim();
      if (!title) { showToast('Título requerido', 'error'); return; }
      await dbWrite(() => db.meetings.update(id, {
        title, date: $('em-date').value,
        participants: $('em-participants').value.trim(),
        projectId:    +$('em-project').value || null,
        agreements:   $('em-agreements').value.trim(),
        updatedAt:    new Date().toISOString()
      }));
      closeModal(); showToast('Reunión actualizada ✓', 'success');
      inspectMeeting(id);
      if (App.view === 'meetings') renderMeetings();
    });
  });

  $('meetDeleteBtn').addEventListener('click', async () => {
    if (!confirm(`¿Eliminar esta reunión?`)) return;
    await db.meetings.delete(id);
    closeInspector(); showToast('Reunión eliminada', 'info');
    if (App.view === 'meetings') renderMeetings();
  });
}

// ══════════════════════════════════════════════════════════════
//  VIEW: GESTOR DE REFERENCIAS / BibTeX
// ══════════════════════════════════════════════════════════════
async function renderReferences() {
  const [refs, projects] = await Promise.all([
    db.references.orderBy('year').reverse().toArray(),
    db.projects.toArray()
  ]);
  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));

  // Filter by project if set
  const filterProjId = App._refFilterProject || 'all';
  const visible = filterProjId === 'all' ? refs
    : refs.filter(r => r.projectId === +filterProjId);

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">📚 Referencias</div>
          <div class="view-subtitle">${visible.length} de ${refs.length} referencia(s)</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="exportBibtexBtn">⬇ .bib</button>
          <button class="btn btn-primary" id="addRefBtn">+ Referencia</button>
        </div>
      </div>

      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
        <select class="form-select" id="refProjectFilter" style="max-width:240px;font-size:.8rem">
          <option value="all">Todos los proyectos</option>
          ${projects.map(p => `<option value="${p.id}" ${p.id == filterProjId?'selected':''}>${esc(p.title)}</option>`).join('')}
        </select>
      </div>

      <div class="ref-list">
        ${visible.length ? visible.map(r => {
          const proj = r.projectId ? projMap[r.projectId] : null;
          return `
            <div class="ref-card" data-inspect-ref="${r.id}">
              <div class="ref-card-main">
                <div class="ref-card-title">${esc(r.title)}</div>
                <div class="ref-card-authors">${esc(r.authors||'')}${r.year ? ` (${r.year})` : ''}</div>
                ${r.journal ? `<div class="ref-card-journal">${esc(r.journal)}</div>` : ''}
              </div>
              <div class="ref-card-side">
                ${r.doi ? `<a class="ref-doi-link" href="https://doi.org/${r.doi}" target="_blank"
                  onclick="event.stopPropagation()">DOI ↗</a>` : ''}
                ${proj ? `<span style="font-size:.65rem;color:var(--accent)">⬡ ${esc(proj.title)}</span>` : ''}
              </div>
            </div>`;
        }).join('')
        : `<div class="empty-state">
             <span class="empty-state-icon">📚</span>
             <h3>Sin referencias</h3>
             <p>Agrega papers y fuentes vinculadas a tus proyectos</p>
           </div>`}
      </div>
    </div>`;

  $('addRefBtn').addEventListener('click', showAddReferenceModal);

  $('exportBibtexBtn').addEventListener('click', async () => {
    const pid = filterProjId !== 'all' ? +filterProjId : null;
    const bib = await exportBibtex(pid);
    if (!bib.trim()) { showToast('Sin referencias para exportar', 'error'); return; }
    const blob = new Blob([bib], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url, download: `references-${new Date().toISOString().split('T')[0]}.bib`
    });
    a.click(); URL.revokeObjectURL(url);
    showToast('.bib exportado ✓', 'success');
  });

  $('refProjectFilter').addEventListener('change', (e) => {
    App._refFilterProject = e.target.value;
    renderReferences();
  });

  mainContent.querySelectorAll('[data-inspect-ref]').forEach(el =>
    el.addEventListener('click', () => inspectReference(+el.dataset.inspectRef)));
}

async function showAddReferenceModal() {
  const projects = await db.projects.toArray();
  showModal('📚 Nueva Referencia', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="ar-title" placeholder="A unifying framework for…">
      </div>
      <div class="form-group">
        <label class="form-label">Autores</label>
        <input class="form-input" id="ar-authors" placeholder="García, J., Vega, M.">
      </div>
      <div class="form-group" style="display:flex;gap:10px">
        <div style="flex:1">
          <label class="form-label">Año</label>
          <input class="form-input" type="number" id="ar-year" min="1900" max="2100"
            placeholder="${new Date().getFullYear()}">
        </div>
        <div style="flex:2">
          <label class="form-label">Journal / Conferencia</label>
          <input class="form-input" id="ar-journal" placeholder="Nature, PLOS ONE…">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">DOI</label>
        <input class="form-input" id="ar-doi" placeholder="10.1038/s41586-...">
      </div>
      <div class="form-group">
        <label class="form-label">URL alternativa</label>
        <input class="form-input" id="ar-url" placeholder="https://...">
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="ar-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Notas personales</label>
        <textarea class="form-textarea" id="ar-notes" rows="2"
          placeholder="Metodología relevante, cita clave, crítica…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="ar-tags" placeholder="methods, review, R">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="arCancel">Cancelar</button>
      <button class="btn btn-primary" id="arSave">Guardar</button>
    </div>`);
  setTimeout(() => $('ar-title')?.focus(), 60);
  $('arCancel').addEventListener('click', closeModal);
  $('arSave').addEventListener('click', async () => {
    const title = $('ar-title').value.trim();
    if (!title) { showToast('Título requerido', 'error'); return; }
    const now = new Date().toISOString();
    await dbWrite(() => db.references.add({
      title,
      authors:   $('ar-authors').value.trim(),
      year:      +$('ar-year').value || null,
      journal:   $('ar-journal').value.trim(),
      doi:       $('ar-doi').value.trim(),
      url:       $('ar-url').value.trim(),
      projectId: +$('ar-project').value || null,
      notes:     $('ar-notes').value.trim(),
      tags:      $('ar-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      createdAt: now, updatedAt: now
    }));
    closeModal(); showToast('Referencia guardada ✓', 'success');
    if (App.view === 'references') renderReferences();
  });
}

async function inspectReference(id) {
  const r    = await db.references.get(id);
  if (!r) return;
  const proj = r.projectId ? await db.projects.get(r.projectId) : null;
  const bibtexKey = `${(r.authors||'').split(',')[0].trim().split(' ').pop()}${r.year||'xxxx'}`;
  const bibtexStr = `@article{${bibtexKey},\n  author  = {${r.authors||''}},\n  title   = {${r.title}},\n  journal = {${r.journal||''}},\n  year    = {${r.year||''}},\n  doi     = {${r.doi||''}}\n}`;

  inspectorBody.innerHTML = `
    <div>
      <div class="inspector-project-title">${esc(r.title)}</div>
      <div class="inspector-meta">
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Autores</span>
          <span class="inspector-meta-val">${esc(r.authors||'—')}</span>
        </div>
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Año</span>
          <span class="inspector-meta-val">${r.year || '—'}</span>
        </div>
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Journal</span>
          <span class="inspector-meta-val">${esc(r.journal||'—')}</span>
        </div>
        ${r.doi ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">DOI</span>
          <span class="inspector-meta-val">
            <a href="https://doi.org/${esc(r.doi)}" target="_blank"
               style="color:var(--accent)">${esc(r.doi)} ↗</a>
          </span>
        </div>` : ''}
        ${proj ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Proyecto</span>
          <span class="inspector-meta-val" style="cursor:pointer;color:var(--accent)"
                id="refNavProj">${esc(proj.title)}</span>
        </div>` : ''}
      </div>
      ${r.notes ? `<div class="inspector-related-title">Notas</div>
        <div class="inspector-desc">${esc(r.notes)}</div>` : ''}
      ${(r.tags||[]).length ? `
        <div class="inspector-related-title">Etiquetas</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
          ${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>` : ''}
      <div class="inspector-related-title">BibTeX</div>
      <div class="ref-bibtex-block">
        <pre style="font-size:.7rem;font-family:var(--font-mono);color:var(--text-2);
                    white-space:pre-wrap;margin:0">${esc(bibtexStr)}</pre>
        <button class="btn btn-ghost btn-sm" id="copyBibtexBtn"
                style="margin-top:6px;font-size:.7rem">📋 Copiar BibTeX</button>
      </div>
      <div class="inspector-actions" style="margin-top:14px">
        <button class="btn btn-ghost btn-sm" id="refEditBtn">✎ Editar</button>
        <button class="btn btn-danger btn-sm" id="refDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();
  $('refNavProj')?.addEventListener('click', () => {
    navigate('projects'); setTimeout(() => inspectProject(proj.id), 120);
  });
  $('copyBibtexBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(bibtexStr);
    showToast('BibTeX copiado ✓', 'success');
  });
  $('refEditBtn').addEventListener('click', async () => {
    const projects = await db.projects.toArray();
    showModal('✎ Editar Referencia', `
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Título *</label>
          <input class="form-input" id="er-title" value="${esc(r.title)}"></div>
        <div class="form-group"><label class="form-label">Autores</label>
          <input class="form-input" id="er-authors" value="${esc(r.authors||'')}"></div>
        <div class="form-group" style="display:flex;gap:10px">
          <div style="flex:1"><label class="form-label">Año</label>
            <input class="form-input" type="number" id="er-year" value="${r.year||''}"></div>
          <div style="flex:2"><label class="form-label">Journal</label>
            <input class="form-input" id="er-journal" value="${esc(r.journal||'')}"></div>
        </div>
        <div class="form-group"><label class="form-label">DOI</label>
          <input class="form-input" id="er-doi" value="${esc(r.doi||'')}"></div>
        <div class="form-group"><label class="form-label">Proyecto</label>
          <select class="form-select" id="er-project">
            <option value="">Sin proyecto</option>
            ${projects.map(p => `<option value="${p.id}" ${p.id===r.projectId?'selected':''}>${esc(p.title)}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Notas</label>
          <textarea class="form-textarea" id="er-notes" rows="2">${esc(r.notes||'')}</textarea></div>
        <div class="form-group"><label class="form-label">Etiquetas</label>
          <input class="form-input" id="er-tags" value="${(r.tags||[]).join(', ')}"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="erCancel">Cancelar</button>
        <button class="btn btn-primary" id="erSave">Guardar</button>
      </div>`);
    $('erCancel').addEventListener('click', closeModal);
    $('erSave').addEventListener('click', async () => {
      const title = $('er-title').value.trim();
      if (!title) { showToast('Título requerido', 'error'); return; }
      await dbWrite(() => db.references.update(r.id, {
        title, authors: $('er-authors').value.trim(),
        year: +$('er-year').value || null,
        journal: $('er-journal').value.trim(),
        doi: $('er-doi').value.trim(),
        projectId: +$('er-project').value || null,
        notes: $('er-notes').value.trim(),
        tags: $('er-tags').value.split(',').map(s => s.trim()).filter(Boolean),
        updatedAt: new Date().toISOString()
      }));
      closeModal(); showToast('Referencia actualizada ✓', 'success');
      inspectReference(r.id);
      if (App.view === 'references') renderReferences();
    });
  });
  $('refDeleteBtn').addEventListener('click', async () => {
    if (!confirm(`¿Eliminar "${r.title}"?`)) return;
    await db.references.delete(id);
    closeInspector(); showToast('Referencia eliminada', 'info');
    if (App.view === 'references') renderReferences();
  });
}

// ══════════════════════════════════════════════════════════════
//  VIEW: COLABORADORES
// ══════════════════════════════════════════════════════════════
async function renderCollaborators() {
  const [collabs, projects] = await Promise.all([
    db.collaborators.orderBy('name').toArray(),
    db.projects.toArray()
  ]);

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">👥 Colaboradores</div>
          <div class="view-subtitle">${collabs.length} colaborador(es)</div>
        </div>
        <button class="btn btn-primary" id="addCollabBtn">+ Colaborador</button>
      </div>
      <div class="collabs-grid">
        ${collabs.length ? collabs.map(c => {
          // Proyectos donde aparece como responsable o coautor
          const linked = projects.filter(p =>
            p.responsible === c.name ||
            (p.coauthors||[]).includes(c.name)
          );
          return `
            <div class="collab-card" data-inspect-collab="${c.id}">
              <div class="collab-avatar">${(c.name||'?')[0].toUpperCase()}</div>
              <div class="collab-info">
                <div class="collab-name">${esc(c.name)}</div>
                ${c.role ? `<div class="collab-role">${esc(c.role)}</div>` : ''}
                ${c.affiliation ? `<div class="collab-affil">${esc(c.affiliation)}</div>` : ''}
                ${c.email ? `<a class="collab-email" href="mailto:${esc(c.email)}"
                  onclick="event.stopPropagation()">${esc(c.email)}</a>` : ''}
                ${linked.length ? `<div class="collab-projects">
                  ${linked.slice(0,3).map(p =>
                    `<span class="tag" style="cursor:pointer" data-inspect-project="${p.id}">⬡ ${esc(p.title)}</span>`
                  ).join('')}
                  ${linked.length > 3 ? `<span class="tag">+${linked.length-3}</span>` : ''}
                </div>` : ''}
              </div>
            </div>`;
        }).join('')
        : `<div class="empty-state" style="grid-column:1/-1">
             <span class="empty-state-icon">👥</span>
             <h3>Sin colaboradores</h3>
             <p>Registra coautores, directores y contactos de investigación</p>
           </div>`}
      </div>
    </div>`;

  $('addCollabBtn').addEventListener('click', showAddCollaboratorModal);
  mainContent.querySelectorAll('[data-inspect-collab]').forEach(el =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-inspect-project]')) return;
      inspectCollaborator(+el.dataset.inspectCollab);
    }));
  mainContent.querySelectorAll('[data-inspect-project]').forEach(el =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      inspectProject(+el.dataset.inspectProject);
    }));
}

async function showAddCollaboratorModal() {
  showModal('👥 Nuevo Colaborador', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Nombre completo *</label>
        <input class="form-input" id="ac-name" placeholder="Dr. Juan García">
      </div>
      <div class="form-group">
        <label class="form-label">Rol</label>
        <input class="form-input" id="ac-role"
          placeholder="Co-investigador, Director de tesis, Revisor externo…">
      </div>
      <div class="form-group">
        <label class="form-label">Institución / Afiliación</label>
        <input class="form-input" id="ac-affiliation"
          placeholder="Universidad de Chile, CONICET…">
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" type="email" id="ac-email"
          placeholder="jgarcia@universidad.cl">
      </div>
      <div class="form-group">
        <label class="form-label">Notas de relación</label>
        <textarea class="form-textarea" id="ac-notes" rows="2"
          placeholder="Especialista en modelos GAM. Contactar antes de congresos."></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="acCancel">Cancelar</button>
      <button class="btn btn-primary" id="acSave">Guardar</button>
    </div>`);
  setTimeout(() => $('ac-name')?.focus(), 60);
  $('acCancel').addEventListener('click', closeModal);
  $('acSave').addEventListener('click', async () => {
    const name = $('ac-name').value.trim();
    if (!name) { showToast('Nombre requerido', 'error'); return; }
    await dbWrite(() => db.collaborators.add({
      name,
      role:        $('ac-role').value.trim(),
      affiliation: $('ac-affiliation').value.trim(),
      email:       $('ac-email').value.trim(),
      notes:       $('ac-notes').value.trim(),
      createdAt:   new Date().toISOString()
    }));
    closeModal(); showToast('Colaborador guardado ✓', 'success');
    if (App.view === 'collaborators') renderCollaborators();
  });
}

async function inspectCollaborator(id) {
  const c = await db.collaborators.get(id);
  if (!c) return;
  const projects = await db.projects.toArray();
  const linked = projects.filter(p =>
    p.responsible === c.name || (p.coauthors||[]).includes(c.name)
  );

  inspectorBody.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div class="collab-avatar" style="width:48px;height:48px;font-size:1.4rem">
          ${(c.name||'?')[0].toUpperCase()}
        </div>
        <div>
          <div class="inspector-project-title" style="margin:0">${esc(c.name)}</div>
          ${c.role ? `<div style="font-size:.78rem;color:var(--text-3)">${esc(c.role)}</div>` : ''}
        </div>
      </div>
      <div class="inspector-meta">
        ${c.affiliation ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Institución</span>
          <span class="inspector-meta-val">${esc(c.affiliation)}</span>
        </div>` : ''}
        ${c.email ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Email</span>
          <span class="inspector-meta-val">
            <a href="mailto:${esc(c.email)}" style="color:var(--accent)">${esc(c.email)}</a>
          </span>
        </div>` : ''}
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Registrado</span>
          <span class="inspector-meta-val">${relativeDate(c.createdAt)}</span>
        </div>
      </div>
      ${c.notes ? `<div class="inspector-related-title">Notas</div>
        <div class="inspector-desc">${esc(c.notes)}</div>` : ''}
      ${linked.length ? `
        <div class="inspector-related-title">Proyectos compartidos (${linked.length})</div>
        ${linked.map(p => `
          <div class="inspector-related-item" data-inspect-project="${p.id}" style="cursor:pointer">
            ⬡ ${esc(p.title)}
          </div>`).join('')}` : ''}
      <div class="inspector-actions" style="margin-top:14px">
        <button class="btn btn-ghost btn-sm" id="collabEditBtn">✎ Editar</button>
        <button class="btn btn-danger btn-sm" id="collabDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();
  inspectorBody.querySelectorAll('[data-inspect-project]').forEach(el =>
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject)));

  $('collabEditBtn').addEventListener('click', () => {
    showModal('✎ Editar Colaborador', `
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Nombre *</label>
          <input class="form-input" id="ec-name" value="${esc(c.name)}"></div>
        <div class="form-group"><label class="form-label">Rol</label>
          <input class="form-input" id="ec-role" value="${esc(c.role||'')}"></div>
        <div class="form-group"><label class="form-label">Institución</label>
          <input class="form-input" id="ec-affiliation" value="${esc(c.affiliation||'')}"></div>
        <div class="form-group"><label class="form-label">Email</label>
          <input class="form-input" type="email" id="ec-email" value="${esc(c.email||'')}"></div>
        <div class="form-group"><label class="form-label">Notas</label>
          <textarea class="form-textarea" id="ec-notes" rows="2">${esc(c.notes||'')}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="ecCancel">Cancelar</button>
        <button class="btn btn-primary" id="ecSave">Guardar</button>
      </div>`);
    $('ecCancel').addEventListener('click', closeModal);
    $('ecSave').addEventListener('click', async () => {
      const name = $('ec-name').value.trim();
      if (!name) { showToast('Nombre requerido', 'error'); return; }
      await dbWrite(() => db.collaborators.update(id, {
        name, role: $('ec-role').value.trim(),
        affiliation: $('ec-affiliation').value.trim(),
        email: $('ec-email').value.trim(),
        notes: $('ec-notes').value.trim()
      }));
      closeModal(); showToast('Colaborador actualizado ✓', 'success');
      inspectCollaborator(id);
      if (App.view === 'collaborators') renderCollaborators();
    });
  });
  $('collabDeleteBtn').addEventListener('click', async () => {
    if (!confirm(`¿Eliminar a "${c.name}"?`)) return;
    await db.collaborators.delete(id);
    closeInspector(); showToast('Colaborador eliminado', 'info');
    if (App.view === 'collaborators') renderCollaborators();
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

      <div class="settings-section">
        <div class="settings-section-title">🔔 Notificaciones de Deadline</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-label">Recordatorios del navegador</div>
              <div class="settings-desc">Notificación el día anterior y el día del deadline</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="notifToggle"
                ${localStorage.getItem('ros-notif-enabled') === 'true' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <button class="btn btn-ghost btn-sm" id="testNotifBtn" style="margin-top:8px">
            🧪 Probar notificación
          </button>
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

  // ── Import con opción merge vs. reemplazar ─────────
  $('importJsonInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = ''; // reset para volver a disparar si mismo archivo

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const counts = {
        projects:  (data.projects  || []).length,
        ideas:     (data.ideas     || []).length,
        snippets:  (data.snippets  || []).length,
      };

      showModal('📥 Importar datos', `
        <div class="modal-body">
          <p style="color:var(--text-2);font-size:.85rem;margin-bottom:14px">
            El archivo contiene <strong style="color:var(--text-1)">${counts.projects}</strong> proyectos,
            <strong style="color:var(--text-1)">${counts.ideas}</strong> ideas y
            <strong style="color:var(--text-1)">${counts.snippets}</strong> snippets.
          </p>
          <p style="font-size:.82rem;color:var(--text-2);margin-bottom:16px">¿Cómo deseas importarlos?</p>
          <div style="display:flex;flex-direction:column;gap:10px">
            <label class="import-option-card" id="importOptMerge" style="cursor:pointer">
              <input type="radio" name="importMode" value="merge" checked style="margin-right:8px">
              <div>
                <strong style="color:var(--text-1)">⊕ Merge (recomendado)</strong>
                <p style="font-size:.75rem;color:var(--text-3);margin:2px 0 0">
                  Añade sólo los registros nuevos. No borra ni modifica los datos existentes.
                </p>
              </div>
            </label>
            <label class="import-option-card" id="importOptReplace" style="cursor:pointer">
              <input type="radio" name="importMode" value="replace" style="margin-right:8px">
              <div>
                <strong style="color:var(--red)">⚠ Reemplazar todo</strong>
                <p style="font-size:.75rem;color:var(--text-3);margin:2px 0 0">
                  Borra todos los datos actuales y los sustituye. Esta acción es irreversible.
                </p>
              </div>
            </label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="importModeCancel">Cancelar</button>
          <button class="btn btn-primary" id="importModeOk">Importar</button>
        </div>`);

      $('importModeCancel').addEventListener('click', closeModal);
      $('importModeOk').addEventListener('click', async () => {
        const mode = document.querySelector('input[name="importMode"]:checked')?.value;
        if (mode === 'replace') {
          if (!confirm('⚠ ¿Seguro? Esto eliminará TODOS tus datos actuales.')) return;
          await importAllData(text);
        } else {
          await mergeAllData(text);
        }
        closeModal();
        showToast(`Datos importados en modo "${mode}" ✓`, 'success');
        navigate('dashboard');
      });
    } catch (err) {
      showToast('Error al leer el archivo: ' + err.message, 'error');
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

  // ── Listeners del toggle de notificaciones ─────────
  $('notifToggle')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    localStorage.setItem('ros-notif-enabled', String(enabled));
    if (enabled) {
      const ok = await DeadlineReminder.requestPermission();
      if (ok) { DeadlineReminder.start(); showToast('Notificaciones activadas ✓', 'success'); }
      else { e.target.checked = false; localStorage.setItem('ros-notif-enabled', 'false');
             showToast('Permiso denegado en el navegador', 'error'); }
    } else {
      DeadlineReminder.stop();
      showToast('Notificaciones desactivadas', 'info');
    }
  });

  $('testNotifBtn')?.addEventListener('click', async () => {
    const ok = await DeadlineReminder.requestPermission();
    if (!ok) return showToast('Permiso denegado', 'error');
    new Notification('⬡ ResearchOS — Prueba', {
      body: 'Las notificaciones de deadline funcionan correctamente.',
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  MODALS — Add / Edit
// ══════════════════════════════════════════════════════════════
const PROJECT_TEMPLATES = {
  paper: {
    label: '📄 Paper', type: 'Paper', priority: 'Alta',
    tags: ['writing', 'review'],
    description: 'Objetivo: publicar en revista indexada.\n\n## Estructura\n- Introducción\n- Métodos\n- Resultados\n- Discusión\n- Conclusiones',
  },
  grant: {
    label: '💰 Grant FONDECYT', type: 'Grant', priority: 'Alta',
    tags: ['grant', 'funding', 'deadline-hard'],
    description: 'Postulación a concurso de financiamiento.\n\n## Secciones requeridas\n- Resumen ejecutivo\n- Objetivos\n- Metodología\n- Presupuesto\n- Equipo',
  },
  course: {
    label: '🎓 Curso / Asignatura', type: 'Análisis', priority: 'Media',
    tags: ['docencia', 'curso'],
    description: '## Información del curso\n- Código:\n- Semestre:\n- Créditos:\n\n## Contenidos mínimos',
  },
  talk: {
    label: '🎤 Ponencia / Congreso', type: 'Presentación', priority: 'Media',
    tags: ['congreso', 'slides'],
    description: '## Detalles\n- Evento:\n- Fecha:\n- Duración:\n\n## Estructura de la presentación',
  },
  dataset: {
    label: '🗄 Dataset / Pipeline', type: 'Dataset', priority: 'Media',
    tags: ['data', 'pipeline'],
    description: '## Descripción de datos\n- Fuente:\n- Formato:\n- Período:\n\n## Pipeline de procesamiento',
  },
  blank: { label: '⬡ En blanco', type: 'Paper', priority: 'Media', tags: [], description: '' },
};

async function showAddProjectModal(defaultColId, defaultParentId = null) {
  // ── Paso 0: elegir template ────────────────────────
  if (!App._skipTemplateStep) {
    showModal('Nuevo Proyecto — Plantilla', `
      <div class="modal-body">
        <div style="font-size:.8rem;color:var(--text-2);margin-bottom:14px">
          Elige una plantilla para pre-rellenar el formulario:
        </div>
        <div class="template-grid">
          ${Object.entries(PROJECT_TEMPLATES).map(([k, t]) => `
            <button class="template-card" data-tpl="${k}">
              <div class="template-card-label">${t.label}</div>
            </button>`).join('')}
        </div>
      </div>`);
    modalContent.querySelectorAll('[data-tpl]').forEach(btn => {
      btn.addEventListener('click', () => {
        App._projectTemplate = btn.dataset.tpl;
        App._skipTemplateStep = true;
        closeModal();
        setTimeout(() => showAddProjectModal(defaultColId, defaultParentId), 80);
      });
    });
    return;
  }
  // Limpiar flag
  App._skipTemplateStep = false;
  const tpl = PROJECT_TEMPLATES[App._projectTemplate || 'blank'];
  App._projectTemplate = null;

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
          ${['Grant','Paper','Análisis','Dataset','Presentación'].map(t =>
            `<option ${t === tpl.type ? 'selected' : ''}>${t}</option>`).join('')}
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
          ${['Alta','Media','Baja'].map(pr => `<option ${pr===tpl.priority?'selected':''}>${pr}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <textarea class="form-textarea" id="mp-desc" rows="3" placeholder="Soporta **Markdown**…">${esc(tpl.description)}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="mp-tags" placeholder="R, ecology, time-series"
             value="${tpl.tags.join(', ')}">
      </div>
      <div class="form-group">
        <label class="form-label">Proyecto padre (subproyecto de…)</label>
        <select class="form-select" id="mp-parent">
          <option value="">— Proyecto raíz —</option>
          ${(await db.projects.toArray()).filter(p => !p.parentId)
            .map(p => `<option value="${p.id}" ${p.id === defaultParentId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
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
      projectIds: [...($('ms-project')?.selectedOptions || [])].map(o => +o.value).filter(Boolean),
      projectId:  +($('ms-project')?.selectedOptions[0]?.value) || null,
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

      <div class="inspector-section-label" style="margin-top:12px;display:flex;align-items:center;justify-content:space-between">
        <span>Descripción</span>
        <button class="btn btn-ghost btn-sm" id="mdEditToggle" style="font-size:.7rem">
          ${App._mdEditing ? '👁 Preview' : '✏ Editar'}
        </button>
      </div>
      ${App._mdEditing
        ? `<textarea class="form-input" id="mdDescEditor"
              style="min-height:120px;font-family:var(--font-mono);font-size:.8rem;resize:vertical"
              placeholder="Soporta **Markdown**, - listas, \`código\`, etc."
            >${esc(p.description || '')}</textarea>
           <div style="display:flex;gap:6px;margin-top:6px">
             <button class="btn btn-primary btn-sm" id="mdDescSave">Guardar</button>
             <button class="btn btn-ghost btn-sm" id="mdDescCancel">Cancelar</button>
           </div>`
        : `<div class="inspector-desc md-preview" id="mdDescPreview">
             ${p.description ? renderMd(p.description) : '<span style="color:var(--text-3);font-size:.8rem">Sin descripción — haz clic en ✏ Editar</span>'}
           </div>`
      }

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

      ${await (async () => {
        const subs = await getSubmissions(p.id);
        const refs  = await getReferences(p.id);
        const meets = await getMeetings(p.id);
        let html = '';
        if (subs.length) html += `
          <div class="inspector-related-title">Submissions (${subs.length})</div>
          ${subs.slice(0,3).map(s => `
            <div class="inspector-related-item" data-inspect-submission="${s.id}" style="cursor:pointer">
              📤 ${esc(s.title)} ${subStatusBadge(s.status)}
            </div>`).join('')}`;
        if (refs.length) html += `
          <div class="inspector-related-title">Referencias (${refs.length})</div>
          ${refs.slice(0,3).map(r => `
            <div class="inspector-related-item" data-inspect-ref="${r.id}" style="cursor:pointer">
              📚 ${esc(r.authors?.split(',')[0]||'')} (${r.year||'?'}) — ${esc(r.title.slice(0,40))}
            </div>`).join('')}`;
        if (meets.length) html += `
          <div class="inspector-related-title">Reuniones (${meets.length})</div>
          ${meets.slice(0,3).map(m => `
            <div class="inspector-related-item" data-inspect-meeting="${m.id}" style="cursor:pointer">
              🗓 ${formatDate(m.date)} — ${esc(m.title)}
            </div>`).join('')}`;
        return html;
      })()}

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

  // ── Listeners del editor Markdown ───────────────────
  if (!App._mdEditing) App._mdEditing = false;

  $('mdEditToggle')?.addEventListener('click', () => {
    App._mdEditing = !App._mdEditing;
    // Re-render sólo el inspector (sin cerrar)
    inspectProject(p.id);
  });

  $('mdDescSave')?.addEventListener('click', async () => {
    const val = $('mdDescEditor')?.value ?? '';
    await snapshotProject(p.id);
    await dbWrite(() => db.projects.update(p.id, {
      description: val,
      updatedAt: new Date().toISOString()
    }));
    App._mdEditing = false;
    showToast('Descripción guardada ✓', 'success');
    inspectProject(p.id);
  });

  $('mdDescCancel')?.addEventListener('click', () => {
    App._mdEditing = false;
    inspectProject(p.id);
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

  // Relacionados desde el inspector
  inspectorBody.querySelectorAll('[data-inspect-submission]').forEach(el =>
    el.addEventListener('click', () => inspectSubmission(+el.dataset.inspectSubmission)));
  inspectorBody.querySelectorAll('[data-inspect-ref]').forEach(el =>
    el.addEventListener('click', () => inspectReference(+el.dataset.inspectRef)));
  inspectorBody.querySelectorAll('[data-inspect-meeting]').forEach(el =>
    el.addEventListener('click', () => inspectMeeting(+el.dataset.inspectMeeting)));

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
      ${(idea._history||[]).length ? (() => {
        const hist = [...(idea._history||[])].reverse().slice(0, 5);
        return `
          <div class="inspector-related-title" style="margin-top:12px">
            Historial (últimas ${hist.length} versiones)
          </div>
          <div class="history-list">
            ${hist.map((snap, si) => {
              const prev  = hist[si + 1] || snap;
              const FIELDS = { title:'Título', content:'Contenido', status:'Estado' };
              const diffs = Object.entries(FIELDS)
                .filter(([k]) => snap[k] !== prev[k] && si < hist.length - 1)
                .map(([k, label]) =>
                  `<span class="history-diff">${label}: </span>` +
                  `<span class="history-diff-old">${esc(String(prev[k]||'—').slice(0,60))}</span> → ` +
                  `<span class="history-diff-new">${esc(String(snap[k]||'—').slice(0,60))}</span>`)
                .join('<br>');
              return `
                <div class="history-entry">
                  <span class="history-ts">${relativeDate(snap.ts)}</span>
                  ${diffs || '<span style="color:var(--text-3)">Snapshot inicial</span>'}
                  <button class="btn btn-ghost btn-sm restore-idea-snap"
                    data-idea-id="${idea.id}" data-snap-idx="${si}"
                    style="font-size:.63rem;margin-top:4px;color:var(--accent)">
                    ↩ Restaurar esta versión
                  </button>
                </div>`;
            }).join('')}
          </div>`;
      })() : ''}
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
    await snapshotIdea(id); // ← antes de cualquier db.ideas.update
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
  // ── Listener restaurar snapshot de idea ─────────────
  inspectorBody.querySelectorAll('.restore-idea-snap').forEach(btn => {
    btn.addEventListener('click', async () => {
      const iid    = +btn.dataset.ideaId;
      const snapIdx = +btn.dataset.snapIdx;
      const idea   = await db.ideas.get(iid);
      const hist   = [...(idea._history||[])].reverse();
      const snap   = hist[snapIdx];
      if (!snap) return;
      if (!confirm('¿Restaurar esta versión? El contenido actual se guardará en el historial.')) return;
      await snapshotIdea(iid);
      await dbWrite(() => db.ideas.update(iid, {
        title:   snap.title,
        content: snap.content,
        updatedAt: new Date().toISOString()
      }));
      showToast('Versión restaurada ✓', 'success');
      inspectIdea(iid);
    });
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
  const subActive = await db.submissions.filter(s =>
    ['preparacion','enviado','en_revision','revision_solicitada'].includes(s.status)
  ).count();
  const subBadge = $('submissionsBadge');
  if (subBadge) {
    subBadge.textContent = subActive;
    subBadge.style.display = subActive > 0 ? '' : 'none';
  }
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

  // ── Iniciar deadline reminders ─────────────────────
  const notifEnabled = localStorage.getItem('ros-notif-enabled') === 'true';
  if (notifEnabled) {
    DeadlineReminder.requestPermission().then(ok => {
      if (ok) DeadlineReminder.start();
    });
  }

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
    { icon:'⏱', label:'Timeline',      sub:'Vista', action: () => { closePalette(); navigate('timeline'); } },
    { icon:'📅', label:'Agenda',        sub:'Vista', action: () => { closePalette(); navigate('weekly'); } },
    { icon:'📤', label:'Submissions',   sub:'Vista', action: () => { closePalette(); navigate('submissions'); } },
    { icon:'🗓', label:'Reuniones',     sub:'Vista', action: () => { closePalette(); navigate('meetings'); } },
    { icon:'📚', label:'Referencias',   sub:'Vista', action: () => { closePalette(); navigate('references'); } },
    { icon:'👥', label:'Colaboradores', sub:'Vista', action: () => { closePalette(); navigate('collaborators'); } },
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
