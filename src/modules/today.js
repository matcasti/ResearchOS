// ============================================================
//  ResearchOS — Hoy, tareas, captura rápida, contexto por área,
//  revisión semanal y enlaces [[ ]] entre elementos.
//  Se carga después de app.js y usa sus globales (db, App, esc, navigate…).
// ============================================================

'use strict';

// -- Fechas --------------------------------------------------
function addDaysISO(n, from = new Date()) {
  const d = new Date(from); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n);
  return localDateISO(d);
}
/** Próxima ocurrencia (futura) de un día de la semana; weekday: 0=domingo … 6=sábado. */
function nextWeekdayISO(weekday, from = new Date()) {
  const d = new Date(from); d.setHours(12, 0, 0, 0);
  let diff = (weekday - d.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  d.setDate(d.getDate() + diff);
  return localDateISO(d);
}
const _daysBetween = (aISO, bISO) =>
  Math.round((new Date(bISO + 'T00:00:00') - new Date(aISO + 'T00:00:00')) / 86400000);

// ==============================================================
//  CONTEXTO POR ÁREA  ("¿en qué frente estoy trabajando?")
// ==============================================================
function _readAreaContext() {
  try {
    const v = localStorage.getItem('ros-context-area');
    if (v === 'none') return 'none';
    return v && +v ? +v : 'all';
  } catch { return 'all'; }
}
App.areaContext = _readAreaContext();

/** ¿El proyecto pertenece al contexto de área activo? */
function inContext(p) {
  const c = App.areaContext;
  if (c === 'all') return true;
  return c === 'none' ? !p.areaId : p.areaId === c;
}

async function setAreaContext(value) {
  App.areaContext = value === 'all' || value === 'none' ? value : (+value || 'all');
  try { localStorage.setItem('ros-context-area', String(App.areaContext)); } catch {}
  await renderContextSwitcher();
  await _renderResearchStatus();
  renderView(App.view);
}

async function renderContextSwitcher() {
  const el = $('contextSwitcher');
  if (!el) return;
  const areas = await _getAreas();
  if (typeof App.areaContext === 'number' && !areas.some(a => a.id === App.areaContext)) {
    App.areaContext = 'all';
    try { localStorage.setItem('ros-context-area', 'all'); } catch {}
  }
  if (!areas.length) {
    el.innerHTML = `<button class="context-hint" id="ctxCreate" title="Las áreas te dejan ver solo un frente a la vez">
      ＋ Define tus áreas (Investigación, Docencia…)</button>`;
    $('ctxCreate').addEventListener('click', () => navigate('areas'));
    return;
  }
  const cur = areas.find(a => a.id === App.areaContext);
  el.innerHTML = `
    <label class="context-label" for="ctxSelect">Área</label>
    <select id="ctxSelect" class="context-select" aria-label="Ver solo un área"
            style="border-left:3px solid ${cur ? cssColor(cur.color) : 'transparent'}">
      <option value="all">Todas las áreas</option>
      ${areas.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}
      <option value="none">Sin área</option>
    </select>`;
  $('ctxSelect').value = String(App.areaContext);
  $('ctxSelect').addEventListener('change', e => setAreaContext(e.target.value));
}

/** Crea un conjunto de áreas de partida (se puede editar después). */
async function seedSuggestedAreas() {
  const existing = await _getAreas();
  const wanted = [['Investigación', '#3b82f6'], ['Docencia', '#10b981'], ['Gestión', '#f59e0b'], ['Personal', '#a78bfa']];
  let next = Math.max(0, ...existing.map(a => +a.id || 0)) + 1;
  for (const [name, color] of wanted)
    if (!existing.some(a => foldText(a.name) === foldText(name))) existing.push({ id: next++, name, color, description: '' });
  await _saveAreas(existing);
  await renderContextSwitcher();
}

// ==============================================================
//  PROYECTOS "EN ESPERA" Y "QUIETOS"
//  Un paper en revisión o un proyecto terminado no está abandonado: no debe generar alertas.
// ==============================================================
const WAIT_SUB = ['enviado', 'en_revision', 'revision_solicitada'];
App._colFlags = { doneIds: new Set(), waitIds: new Set() };

async function refreshColumnFlags() {
  const cols = await db.kanbanColumns.orderBy('order').toArray();
  const last = cols[cols.length - 1];
  const done = /complet|terminad|finaliz|publicad|cerrad/i, wait = /review|revisi[oó]n|esperand|enviad/i;
  App._colFlags = {
    doneIds: new Set(cols.filter(c => c.id === last?.id || done.test(c.title)).map(c => c.id)),
    waitIds: new Set(cols.filter(c => wait.test(c.title) && c.id !== last?.id && !done.test(c.title)).map(c => c.id)),
  };
}
const isWaiting  = p => WAIT_SUB.includes(p.submissionStatus) || App._colFlags.waitIds.has(p.columnId);
const isFinished = p => App._colFlags.doneIds.has(p.columnId);
/** Sin movimiento hace `days` días y que no esté esperando respuesta ni terminado. */
const isIdle = (p, days = 30) =>
  !p.archived && !isWaiting(p) && !isFinished(p) && !!p.updatedAt && (Date.now() - new Date(p.updatedAt)) > days * 86400000;

// ==============================================================
//  CAPTURA RÁPIDA
//  "llamar a imprenta mañana @alfa !alta"  →  tarea en «Paper Alfa», vence mañana, prioridad alta
// ==============================================================
const _WD = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const _NUM_WORDS = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };

/**
 * Interpreta una línea de captura. No toca la BD.
 * Devuelve { kind, title, due, projectId, projectTitle, priority, assigneeId, assigneeName, recurrence, effort (min), explicit }.
 * Símbolos: @proyecto · >persona (esperando a) · !alta/!media/!baja · ~2h (tiempo estimado) · fechas en español · «cada lunes», «cada 2 semanas»…
 */
function parseCapture(raw, projects = [], now = new Date(), people = []) {
  let text = String(raw ?? '').trim();
  let kind = null, explicit = false;

  const pre = text.match(/^(t|tarea|todo|i|idea|p|proyecto|r|reuni[oó]n)\s*:\s*/i);
  if (pre) {
    const k = foldText(pre[1]);
    kind = k === 't' || k === 'tarea' || k === 'todo' ? 'task' : k === 'i' || k === 'idea' ? 'idea' : k === 'p' || k === 'proyecto' ? 'project' : 'meeting';
    explicit = true;
    text = text.slice(pre[0].length);
  }

  // un enlace pegado (p. ej. el de un correo) no es parte del título ni de las fechas: se guarda aparte
  let link = null;
  const um0 = text.match(/https?:\/\/[^\s<>"']+/i);
  if (um0) { link = Tasks.cleanLink(um0[0].replace(/[).,;:]+$/, '')); if (link) text = text.replace(um0[0], ' '); }

  // @proyecto  o  @"nombre con espacios"
  let projectId = null, projectTitle = null;
  const at = text.match(/@"([^"]+)"|@([\p{L}\p{N}_-]+)/u);
  if (at) {
    const token = foldText(at[1] ?? at[2]);
    const live = projects.filter(p => !p.archived);
    const hit = live.find(p => foldText(p.title).split(/[\s:—–-]+/).some(w => w.startsWith(token)))
             || live.find(p => foldText(p.title).includes(token));
    if (hit) { projectId = hit.id; projectTitle = hit.title; text = text.replace(at[0], ' '); }
  }

  // >persona  o  >"nombre con espacios"  (la tarea queda «esperando a» esa persona)
  let assigneeId = null, assigneeName = null;
  const to = text.match(/>"([^"]+)"|>([\p{L}\p{N}_-]+)/u);
  if (to) {
    const token = foldText(to[1] ?? to[2]);
    const hit = people.find(c => foldText(c.name).split(/[\s.,]+/).some(w => w && w.startsWith(token)))
             || people.find(c => foldText(c.name).includes(token));
    if (hit) { assigneeId = hit.id; assigneeName = hit.name; text = text.replace(to[0], ' '); }
  }

  // !alta / !media / !baja
  let priority = null;
  const pr = text.match(/(?:^|\s)!(alta|media|baja)\b/i);
  if (pr) { priority = { alta: 'Alta', media: 'Media', baja: 'Baja' }[pr[1].toLowerCase()]; text = text.replace(pr[0], ' '); }

  // tiempo estimado: ~2h · ~30m · ~1h30 · ~1,5h · ~45min
  let effort = null;
  const em = text.match(/(?:^|\s)~\s*(\d+)(?:[.,](\d+))?\s*(h|hr|hrs|horas?|m|min|mins|minutos?)?(?:\s*(\d{1,2})\s*(?:m|min|mins)?)?(?=\s|$)/i);
  if (em) {
    const n = parseFloat(`${em[1]}.${em[2] || 0}`);
    effort = Tasks.cleanEffort(/^h/i.test(em[3] || '') ? Math.round(n * 60) + (+em[4] || 0) : n);
    if (effort) text = text.replace(em[0], ' ');
  }

  // repetición: «cada lunes», «todos los viernes», «cada 2 semanas», «diario», «mensual»…
  let recurrence = null, recDue = null;
  const rm = text.match(/\b(?:cada|todos\s+los|todas\s+las)\s+(?:(\d+)\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|semanas?|d[ií]as?|mes(?:es)?)\b|\b(diari[oa]|semanal(?:mente)?|mensual(?:mente)?)\b/i);
  if (rm) {
    const unit = foldText(rm[2] || rm[3]);
    const interval = +rm[1] || 1;
    const wd = _WD[unit] ?? _WD[unit.replace(/s$/, '')];          // lunes…domingo (y «sábados», «domingos»)
    if (wd !== undefined)                    { recurrence = { freq: 'weekly', interval: 1 }; recDue = nextWeekdayISO(wd, now); }
    else if (/^semana/.test(unit))           recurrence = { freq: 'weekly', interval };
    else if (/^dia|^diari/.test(unit))       recurrence = { freq: 'daily', interval };
    else if (/^mes|^mensual/.test(unit))     recurrence = { freq: 'monthly', interval };
    if (recurrence) {
      text = text.replace(rm[0], ' ');
      const um = text.match(/\bhasta\s+(?:el\s+)?(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)/i);
      if (um) {
        const d = um[1].includes('-') && um[1].length === 10 && /^\d{4}/.test(um[1]) ? um[1] : (() => {
          const [dd, mm, yy] = um[1].split(/[\/.-]/); const y = yy ? (+yy < 100 ? 2000 + +yy : +yy) : now.getFullYear();
          return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; })();
        recurrence.until = isoDateOrNull(d);
        text = text.replace(um[0], ' ');
      }
    }
  }

  // fecha
  let due = null;
  const take = (re, fn) => {
    if (due) return;
    const m = text.match(re);
    if (!m) return;
    const v = fn(m);
    if (v) { due = v; text = text.replace(m[0], ' '); }
  };
  const lead = '(?:\\b(?:para|hasta|antes\\s+del?|vence|el|este|esta|pr[oó]ximo)\\s+)?';
  take(/\b(\d{4}-\d{2}-\d{2})\b/, m => isoDateOrNull(m[1]));
  take(new RegExp(lead + '\\bpasado\\s+ma[nñ]ana\\b', 'i'), () => addDaysISO(2, now));
  take(new RegExp(lead + '\\bma[nñ]ana\\b', 'i'), () => addDaysISO(1, now));
  take(new RegExp(lead + '\\bhoy\\b', 'i'), () => addDaysISO(0, now));
  take(/\ben\s+(\d+|un|una|dos|tres|cuatro|cinco)\s+(d[ií]as?|semanas?|mes(?:es)?)\b/i, m => {
    const n = _NUM_WORDS[foldText(m[1])] ?? +m[1];
    const unit = foldText(m[2]);
    return addDaysISO(unit.startsWith('d') ? n : unit.startsWith('s') ? n * 7 : n * 30, now);
  });
  take(new RegExp(lead + '\\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\\b', 'i'),
       m => nextWeekdayISO(_WD[foldText(m[1])], now));
  take(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/, m => {
    const day = +m[1], mon = +m[2];
    if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
    let year = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : now.getFullYear();
    let iso = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!m[3] && _daysBetween(localDateISO(now), iso) < -1) iso = `${year + 1}-${iso.slice(5)}`;   // "15/03" ya pasado → el año próximo
    return isoDateOrNull(iso);
  });
  if (!due && recDue) due = recDue;
  if (!due && recurrence) due = localDateISO(now);

  const title = text.replace(/\s+/g, ' ').replace(/\s+(para|hasta|el|de|del|a)$/i, '').replace(/^[\s,;:.-]+|[\s,;:]+$/g, '');
  if (!kind) kind = (projectId || due || assigneeId || recurrence || effort) ? 'task' : 'idea';
  return { kind, title, due, projectId, projectTitle, priority, assigneeId, assigneeName, recurrence, effort, link, explicit };
}

/** 90 → «1 h 30», 45 → «45 min», 120 → «2 h». */
function fmtEffort(min) {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h} h ${m}` : `${h} h`) : `${m} min`;
}
const _KIND_LABEL = { task: 'Tarea', idea: 'Idea', project: 'Proyecto', meeting: 'Reunión' };
const _REC_LABEL = { daily: 'día', weekly: 'semana', monthly: 'mes' };
const recurrenceLabel = r => !r ? '' : `cada ${r.interval > 1 ? r.interval + ' ' : ''}${r.freq === 'daily' ? (r.interval > 1 ? 'días' : 'día') : r.freq === 'weekly' ? (r.interval > 1 ? 'semanas' : 'semana') : (r.interval > 1 ? 'meses' : 'mes')}${r.until ? ` hasta ${formatDate(r.until)}` : ''}`;
function describeCapture(c) {
  if (!c.title) return '';
  const bits = [`<strong>${_KIND_LABEL[c.kind]}</strong>`];
  if (c.projectTitle) bits.push(`en «${esc(c.projectTitle)}»`);
  if (c.assigneeName) bits.push(`esperando a ${esc(c.assigneeName)}`);
  if (c.due) bits.push(c.kind === 'project' ? `vence ${esc(dueLabel(c.due))}` : `${c.kind === 'meeting' ? 'el' : 'para'} ${esc(dueLabel(c.due))} (${esc(formatDate(c.due))})`);
  if (c.recurrence) bits.push(`↻ ${esc(recurrenceLabel(c.recurrence))}`);
  if (c.priority) bits.push(`prioridad ${esc(c.priority.toLowerCase())}`);
  if (c.effort && c.kind === 'task') bits.push(`⏱ ${esc(fmtEffort(c.effort))}`);
  if (c.link) bits.push('🔗 enlace');
  if (c.kind !== 'project' && !c.projectTitle && typeof App.areaContext === 'number') bits.push('en el área activa');
  return bits.join(' · ');
}

/**
 * Ayudas bajo la captura, aprendidas de tu historial (insights.js): lo que suele faltar (Tab lo añade), aviso de duplicado y continuación de series.
 * `ctx` = { ix, titles } (se calcula una vez por captura). Devuelve { html, apply } (apply(input) escribe la sugerencia, o null si no hay).
 */
function captureAssist(c, ctx, typed) {
  if (!ctx?.ix || !c?.title) return { html: '', apply: null };
  const dup = Learn.duplicate(ctx.ix, c);
  const sug = Learn.suggest(ctx.ix, c);
  const seq = !sug && c.kind !== 'project' ? Learn.next(ctx.titles, typed.trim()) : null;
  let html = dup ? ` <span class="capture-warn" title="Ya tienes una tarea abierta casi igual">⚠ ya existe «${esc(dup.title)}»</span>` : '', apply = null;
  if (sug) {
    html += ` <button type="button" class="capture-accept" data-accept title="Se deduce de tus tareas parecidas"><kbd>Tab</kbd> añadir ${sug.parts.map(esc).join(' · ')} <span class="capture-why">(${sug.basis} parecidas)</span></button>`;
    apply = input => { input.value = `${input.value.trim()} ${sug.add}`; };
  } else if (seq) {
    html += ` <button type="button" class="capture-accept" data-accept title="Continúa la serie"><kbd>Tab</kbd> ${esc(seq)}</button>`;
    apply = input => { input.value = seq + ' '; };
  }
  return { html, apply };
}
async function captureContext() {
  const [tasks, meetings, projects, people] = await Promise.all([db.tasks.toArray(), db.meetings.toArray(), db.projects.toArray(), db.collaborators.toArray()]);
  return { projects, people, ix: Learn.index(tasks, projects, people), titles: [...tasks.map(t => t.title), ...meetings.map(m => m.title)] };
}

/** Crea el elemento descrito por `c`. Devuelve un mensaje para el aviso. */
async function runCapture(c) {
  const now = new Date().toISOString();
  const area = typeof App.areaContext === 'number' ? App.areaContext : null;
  if (!c.title) throw new Error('Escribe algo para capturar');
  switch (c.kind) {
    case 'task':
      await dbWrite(() => Tasks.add({ title: c.title, due: c.due, projectId: c.projectId, areaId: area, priority: c.priority,
                                      assigneeId: c.assigneeId, recurrence: c.recurrence, effort: c.effort, link: c.link }));
      return `Tarea creada${c.projectTitle ? ` en «${c.projectTitle}»` : ''}${c.assigneeName ? ` · esperando a ${c.assigneeName}` : ''}${c.due ? ` · ${dueLabel(c.due)}` : ''}${c.recurrence ? ' · ↻' : ''}`;
    case 'project': {
      const cols = await db.kanbanColumns.orderBy('order').toArray();
      const colId = cols[0]?.id;
      await dbWrite(() => db.projects.add({
        title: c.title, type: 'Proyecto', columnId: colId, priority: c.priority || 'Media', responsible: '', coauthors: [],
        deadline: c.due, description: '', tags: [], areaId: area, status: 'active', archived: false, starred: false,
        createdAt: now, updatedAt: now, customFields: {}, columnHistory: [{ colId, enteredAt: now, exitedAt: null }] }));
      return 'Proyecto creado';
    }
    case 'meeting':
      await dbWrite(() => db.meetings.add({ title: c.title, date: c.due || localDateISO(), participants: c.assigneeName || '', projectId: c.projectId,
        agreements: '', actionItems: [], createdAt: now, updatedAt: now }));
      return 'Reunión creada';
    default:
      await dbWrite(() => db.ideas.add({ title: c.title, content: c.link || '', status: 'unread', projectId: c.projectId,
        projectIds: c.projectId ? [c.projectId] : [], deadline: c.due, tags: [], subtasks: [], createdAt: now, updatedAt: now }));
      return 'Idea guardada en la bandeja';
  }
}

/** Salta a Hoy y enfoca el campo de captura (atajo «c»). Reintenta hasta que la vista termine de pintarse. */
function focusCapture() {
  const go = (tries = 0) => {
    const el = $('captureInput');
    if (el) { el.focus(); el.select?.(); }
    else if (tries < 40) setTimeout(() => go(tries + 1), 100);
  };
  if (App.view !== 'dashboard') navigate('dashboard');
  go();
}

// ==============================================================
//  MENÚ FLOTANTE (posponer, etc.)
// ==============================================================
function openFloatingMenu(anchor, items) {
  document.querySelectorAll('.tw-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'tw-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) => `<button role="menuitem" class="tw-menu-item ${it.danger ? 'danger' : ''}" data-mi="${i}">${esc(it.label)}</button>`).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top  = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey, true); };
  const outside = e => { if (!menu.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', onKey, true); }, 0);
  menu.addEventListener('click', e => {
    const b = e.target.closest('[data-mi]'); if (!b) return;
    const it = items[+b.dataset.mi]; close(); it.action();
  });
  menu.querySelector('.tw-menu-item')?.focus();
}

const _snoozeOptions = (onPick) => [
  { label: 'Hoy',            action: () => onPick(addDaysISO(0)) },
  { label: 'Mañana',         action: () => onPick(addDaysISO(1)) },
  { label: 'Próximo lunes',  action: () => onPick(nextWeekdayISO(1)) },
  { label: 'En una semana',  action: () => onPick(addDaysISO(7)) },
  { label: 'Sin fecha',      action: () => onPick(null) },
];

// ==============================================================
//  VISTA «HOY»
// ==============================================================
const _prioRank = { Alta: 0, Media: 1, Baja: 2 };
const _byUrgency = (a, b) => (a.due || '9').localeCompare(b.due || '9') || (a.time && b.time ? a.time.localeCompare(b.time) : 0) || (_prioRank[a.priority] ?? 3) - (_prioRank[b.priority] ?? 3);

async function collectToday() {
  await refreshColumnFlags();
  const todayISO = localDateISO();
  const weekEnd  = addDaysISO(7);
  const [allProjects, allTasks, allIdeas, allMeetings, areas, people] = await Promise.all([
    db.projects.toArray(), db.tasks.toArray(), db.ideas.toArray(), db.meetings.toArray(), _getAreas(), db.collaborators.toArray()]);
  const projMap = Object.fromEntries(allProjects.map(p => [p.id, p]));
  const areaMap = Object.fromEntries(areas.map(a => [a.id, a]));
  const who     = Object.fromEntries(people.map(c => [c.id, c.name]));
  const ctxLive = allProjects.filter(p => !p.archived && inContext(p));
  const ctxIds  = new Set(ctxLive.map(p => p.id));
  const c = App.areaContext;

  const taskArea = t => (t.projectId ? projMap[t.projectId]?.areaId : t.areaId) ?? null;
  const taskVisible = t => {
    if (t.projectId && projMap[t.projectId]?.archived) return false;
    return c === 'all' || (c === 'none' ? !taskArea(t) : taskArea(t) === c);
  };
  const chipFor = pid => pid && projMap[pid] ? { projectId: pid, projectTitle: projMap[pid].title,
    color: cssColor(areaMap[projMap[pid].areaId]?.color, 'var(--accent)') } : {};

  const mine = [], theirs = [];                       // lo mío / lo que espero de otras personas
  const push = r => (r.assigneeId ? theirs : mine).push(r);
  for (const t of allTasks.filter(t => !t.done && taskVisible(t)))
    push({ kind: 'task', id: t.id, title: t.title, due: t.due, priority: t.priority, ideaId: t.ideaId, rec: !!t.recurrence,
           assigneeId: t.assigneeId, assignee: who[t.assigneeId], effort: t.effort || null, planDate: t.planDate || null, notes: t.notes || '', link: t.link || null, ...chipFor(t.projectId) });
  for (const p of ctxLive.filter(p => p.deadline && !isFinished(p)))
    mine.push({ kind: 'deadline', id: p.id, title: p.title, due: p.deadline, type: p.type, priority: p.priority, projectId: p.id,
                projectTitle: null, color: cssColor(areaMap[p.areaId]?.color, 'var(--accent)') });
  for (const m of allMeetings) {
    const inScope = c === 'all' || (m.projectId && ctxIds.has(m.projectId));
    if (!inScope) continue;
    if (m.date >= todayISO && m.date <= weekEnd)
      mine.push({ kind: 'meeting', id: m.id, title: m.title, due: m.date, time: m.time || null, duration: m.duration || null, ...chipFor(m.projectId) });
    for (const a of (m.actionItems || []).filter(a => !a.done))
      push({ kind: 'action', id: a.id, sub: m.id, title: a.text, due: a.due || null, meetingTitle: m.title,
             assigneeId: a.assigneeId, assignee: who[a.assigneeId], ...chipFor(m.projectId) });
  }

  // «Mi día»: lo que decidí hacer hoy (o ayer y quedó pendiente). Sale de las demás listas para no repetirse.
  const plan = mine.filter(r => r.kind === 'task' && r.planDate && r.planDate <= todayISO).map(r => ({ ...r, carried: r.planDate < todayISO })).sort(_byUrgency);
  const planned = new Set(plan.map(r => r.id));
  const rest = mine.filter(r => !(r.kind === 'task' && planned.has(r.id)));
  const doneToday = allTasks.filter(t => t.done && t.doneAt && localDateISO(new Date(t.doneAt)) === todayISO && taskVisible(t)).length;

  const now   = rest.filter(r => r.due && r.due <= todayISO).sort(_byUrgency);
  const week  = rest.filter(r => r.due && r.due > todayISO && r.due <= weekEnd).sort(_byUrgency);
  const loose = rest.filter(r => !r.due && (r.kind === 'task' || r.kind === 'action'));
  const later = rest.filter(r => r.due && r.due > weekEnd && r.kind === 'task').sort(_byUrgency);
  theirs.sort(_byUrgency);
  const waiting = ctxLive.filter(isWaiting).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  const ideasUnread = allIdeas.filter(i => i.status === 'unread' && (c === 'all' || !i.projectId || ctxIds.has(i.projectId)));

  // Proyectos en curso sin ninguna acción propia pendiente → candidatos a «¿cuál es el siguiente paso?»
  const withNext = new Set(allTasks.filter(t => !t.done && !t.assigneeId && t.projectId).map(t => t.projectId));
  for (const m of allMeetings) if ((m.actionItems || []).some(a => !a.done && !a.assigneeId) && m.projectId) withNext.add(m.projectId);
  const noNext = ctxLive.filter(p => !withNext.has(p.id) && !isWaiting(p) && !isFinished(p)).sort((a, b) => String(a.title).localeCompare(String(b.title)));

  const lastReview = +localStorage.getItem('ros-last-review') || null;
  const load = Load.analyze({ tasks: allTasks, projects: allProjects, today: todayISO, capacity: Capacity.get() });      // insights.js: ¿cabe lo que viene?
  return { todayISO, plan, doneToday, now, week, loose, later, theirs, waiting, noNext, ideasUnread, areas, areaMap, people, ctxLive, lastReview, load,
           empty: !allProjects.length && !allTasks.length && !allIdeas.length };
}

function _greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
}

function _todayRowHTML(r, todayISO) {
  const overdue = r.due && r.due < todayISO;
  const doable = r.kind === 'task' || r.kind === 'action';
  const check = doable
    ? `<button class="tw-check" data-act="done" aria-label="Marcar como hecha"></button>`
    : r.kind === 'meeting' ? `<span class="tw-icon" aria-hidden="true">🗓</span>`
    : `<span class="tw-icon tw-deadline" aria-hidden="true" title="Fecha límite del proyecto">⏱</span>`;
  const chip = r.projectTitle
    ? `<button class="tw-proj" data-act="project" style="--pc:${r.color || 'var(--accent)'}" title="Abrir proyecto">${esc(r.projectTitle)}</button>` : '';
  const sub  = r.assignee ? `<span class="tw-sub">→ ${esc(r.assignee)}</span>`
             : r.kind === 'action' ? `<span class="tw-sub">${esc(r.meetingTitle)}</span>`
             : r.kind === 'meeting' && r.time ? `<span class="tw-sub tw-when">${esc(meetingWhen(r))}</span>`
             : r.kind === 'deadline' ? `<span class="tw-sub">${esc(r.type)}${r.priority === 'Alta' ? ' · alta' : ''}</span>` : '';
  const rec  = r.rec ? `<span class="tw-rec" title="Tarea recurrente" aria-label="Se repite">↻</span>` : '';
  const eff  = r.effort ? `<span class="tw-effort" title="Tiempo estimado">⏱ ${esc(fmtEffort(r.effort))}</span>` : '';
  const carry = r.carried ? `<span class="tw-carry" title="Planificada para un día anterior y sigue pendiente">↪ pendiente de ayer</span>` : '';
  const due  = r.due ? `<span class="tw-due ${overdue ? 'overdue' : r.due === todayISO ? 'today' : ''}">${esc(dueLabel(r.due))}</span>` : '';
  const href = r.kind === 'task' ? Tasks.cleanLink(r.link) : null;           // se vuelve a validar al pintar: el dato pudo venir de fuera
  const ext = (href ? `<a class="tw-link" data-act="link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="Abrir el enlace (${esc(new URL(href).host)})" aria-label="Abrir enlace">🔗</a>` : '')
            + (r.kind === 'task' && r.notes ? `<span class="tw-notes" title="${esc(r.notes.slice(0, 400))}" role="img" aria-label="Tiene notas">📝</span>` : '');
  const more = doable ? `<button class="tw-more" data-act="menu" aria-label="Más acciones: posponer, asignar, repetir" title="Más acciones…">⋯</button>` : '';
  return `<div class="tw-row" data-kind="${r.kind}" data-id="${esc(r.id)}" ${r.sub != null ? `data-sub="${esc(r.sub)}"` : ''}
               data-project="${esc(r.projectId ?? '')}" ${r.ideaId ? `data-idea="${esc(r.ideaId)}"` : ''}>
    ${check}<span class="tw-text">${esc(r.title)}</span>${ext}${rec}${carry}${sub}${chip}${eff}${due}${more}</div>`;
}

function _foldOpen(id, n) {                       // «Sin fecha» y «Más adelante»: abiertas si son pocas; si no, la persona decide y se recuerda
  try { const v = localStorage.getItem('ros-today-fold-' + id); if (v !== null) return v === '1'; } catch {}
  return n <= 3;
}
function _todaySection(id, title, rows, todayISO, { limit = 6, empty = '', tone = '', byDay = false, fold = false } = {}) {
  if (!rows.length && !empty) return '';
  const open = !!App._todayExpanded?.[id];
  const shown = open ? rows : rows.slice(0, limit);
  let lastDay = null;
  const body = shown.map(r => {
    let head = '';
    if (byDay && r.due !== lastDay) {
      lastDay = r.due;
      head = `<div class="today-day">${esc(new Date(r.due + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'short' }))}</div>`;
    }
    return head + _todayRowHTML(r, todayISO);
  }).join('');
  const more = rows.length > limit ? `<button class="today-more" data-expand="${id}">${open ? 'Ver menos' : `Ver ${rows.length - limit} más`}</button>` : '';
  if (fold && rows.length)
    return `
    <details class="today-sec today-fold ${tone}" data-sec="${id}" data-fold="${id}" ${_foldOpen(id, rows.length) ? 'open' : ''}>
      <summary class="today-sec-title" id="ts-${id}">${title} <span class="today-count">${rows.length}</span></summary>
      ${body}${more}
    </details>`;
  return `
    <section class="today-sec ${tone}" data-sec="${id}" aria-labelledby="ts-${id}">
      <h2 class="today-sec-title" id="ts-${id}">${title}${rows.length ? ` <span class="today-count">${rows.length}</span>` : ''}</h2>
      ${rows.length ? body : `<div class="today-empty">${empty}</div>`}
      ${more}
    </section>`;
}

async function renderToday() {
  const prevScroll = mainContent.scrollTop;
  const token = App._todayToken = (App._todayToken || 0) + 1;     // si hay dos renders solapados, solo vale el último
  const d = await collectToday();
  if (token !== App._todayToken) return;
  // Lo que el usuario esté escribiendo en la captura sobrevive a un re-render (p. ej. al cambiar de área)
  const prevInput = $('captureInput');
  const prevCapture = prevInput ? { value: prevInput.value, focused: document.activeElement === prevInput } : null;
  App._todayExpanded = App._todayExpanded || {};
  const ctxArea = typeof App.areaContext === 'number' ? d.areas.find(a => a.id === App.areaContext) : null;
  const ctxLabel = App.areaContext === 'all' ? '' : App.areaContext === 'none' ? ' · sin área' : ctxArea ? ` · ${ctxArea.name}` : '';
  const reviewDays = d.lastReview ? Math.floor((Date.now() - d.lastReview) / 86400000) : null;
  const reviewDue = reviewDays === null || reviewDays >= 7;
  const overdueTasks = d.now.filter(r => r.kind === 'task' && r.due < d.todayISO);

  const sections = [
    planSectionHTML(d),
    _todaySection('now', 'Atrasado y para hoy', d.now, d.todayISO, {
      tone: d.now.some(r => r.due < d.todayISO) ? 'is-late' : '',
      empty: d.week.length || d.loose.length ? 'Nada vence hoy. Buen momento para avanzar lo de esta semana.' : '✓ Todo al día.' }),
    _todaySection('week', 'Próximos 7 días', d.week, d.todayISO, { limit: 6, byDay: true }),
    _todaySection('loose', 'Pendientes sin fecha', d.loose, d.todayISO, { limit: 4, fold: true }),
    _todaySection('later', 'Más adelante', d.later, d.todayISO, { limit: 3, fold: true }),
  ].join('');

  // «Esperando a personas», agrupado por persona
  const theirsHTML = d.theirs.length ? (() => {
    const groups = new Map();
    for (const r of d.theirs) { const k = r.assignee || 'Alguien'; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
    return `<section class="today-sec calm" data-sec="theirs" aria-labelledby="ts-theirs">
      <h2 class="today-sec-title" id="ts-theirs">Esperando a otras personas <span class="today-count">${d.theirs.length}</span></h2>
      ${[...groups].map(([name, rows]) => `<div class="today-day">${esc(name)}</div>${rows.slice(0, 4).map(r => _todayRowHTML(r, d.todayISO)).join('')}${rows.length > 4 ? `<div class="today-empty">…y ${rows.length - 4} más</div>` : ''}`).join('')}
    </section>`;
  })() : '';

  const riskHTML = d.load.violations.length ? `
    <section class="today-sec calm risk" data-sec="risk" aria-labelledby="ts-risk">
      <h2 class="today-sec-title" id="ts-risk">Plazos que no caben <span class="today-count">${d.load.violations.length}</span></h2>
      <div class="today-wait-note">Comparo lo que vence con tus horas disponibles (${esc(fmtEffort(Capacity.get()))} por día laborable).</div>
      ${d.load.violations.map(v => `
        <div class="risk-row">
          <div><strong>Hasta ${esc(formatDate(v.date))}</strong>: ${esc(fmtEffort(v.demand))} de trabajo para ${esc(fmtEffort(v.available) || '0 min')} <span class="risk-over">(+${esc(fmtEffort(v.over))})</span></div>
          <div class="risk-top">Lo más pesado: ${v.items.slice(0, 2).map(x => `${esc(x.t.title)} (${esc(fmtEffort(x.minutes))})`).join(' · ')}</div>
        </div>`).join('')}
      ${d.load.atRisk.length ? `<div class="risk-top">Proyectos en riesgo: ${d.load.atRisk.slice(0, 3).map(r => `<a href="#" class="risk-proj" data-risk-project="${r.project.id}">${esc(r.project.title)}</a>`).join(', ')}</div>` : ''}
      <button class="today-more" id="planWeekBtn">Planificar la semana →</button>
      ${d.load.guessed ? `<div class="today-wait-note">Incluye ${d.load.guessed} tarea(s) sin estimar (cuentan ${esc(fmtEffort(d.load.typical))} cada una).</div>` : ''}
    </section>` : '';

  const waitingHTML = d.waiting.length ? `
    <section class="today-sec calm" aria-labelledby="ts-wait">
      <h2 class="today-sec-title" id="ts-wait">Esperando respuesta <span class="today-count">${d.waiting.length}</span></h2>
      <div class="today-wait-note">No requieren acción tuya: se muestran para que no se pierdan de vista.</div>
      ${d.waiting.slice(0, 5).map(p => `
        <div class="tw-row" data-kind="waiting" data-id="${p.id}" data-project="${p.id}">
          <span class="tw-icon" aria-hidden="true">⏳</span><span class="tw-text">${esc(p.title)}</span>
          <span class="tw-sub">${esc((SUB_STATUSES.find(s => s.key === p.submissionStatus)?.label) || 'en revisión')}${p.targetVenue ? ' · ' + esc(p.targetVenue) : ''}</span>
          <span class="tw-due">desde hace ${Math.max(0, Math.floor((Date.now() - new Date(p.updatedAt || Date.now())) / 86400000))} d</span>
        </div>`).join('')}
    </section>` : '';

  const noNextHTML = d.noNext.length ? `
    <section class="today-sec calm" aria-labelledby="ts-nonext">
      <h2 class="today-sec-title" id="ts-nonext">Sin próxima acción <span class="today-count">${d.noNext.length}</span></h2>
      <div class="today-wait-note">Proyectos en curso sin ninguna tarea pendiente: ¿cuál es el siguiente paso?</div>
      ${d.noNext.slice(0, 5).map(p => `
        <div class="tw-row" data-kind="nonext" data-id="${p.id}" data-project="${p.id}">
          <span class="tw-icon" aria-hidden="true">◌</span><span class="tw-text">${esc(p.title)}</span>
          <button class="tw-addnext" data-act="addnext" title="Añadir una tarea a este proyecto">+ tarea</button>
        </div>`).join('')}
      ${d.noNext.length > 5 ? `<div class="today-empty">…y ${d.noNext.length - 5} más</div>` : ''}
    </section>` : '';

  const ideasHTML = d.ideasUnread.length ? `
    <section class="today-sec calm" aria-labelledby="ts-ideas">
      <h2 class="today-sec-title" id="ts-ideas">Ideas por revisar <span class="today-count">${d.ideasUnread.length}</span></h2>
      ${d.ideasUnread.slice(0, 3).map(i => `
        <div class="tw-row" data-kind="idea" data-id="${i.id}"><span class="tw-icon" aria-hidden="true">◎</span>
          <span class="tw-text">${esc(i.title)}</span><span class="tw-due">${esc(relativeDate(i.createdAt))}</span></div>`).join('')}
      ${d.ideasUnread.length > 1 ? `<button class="today-more" data-act-triage>Revisar las ${d.ideasUnread.length} en modo rápido →</button>` : ''}
    </section>` : '';

  mainContent.innerHTML = `
    <div class="view today-view" id="todayRoot">
      <div class="today-head">
        <div>
          <h1 class="view-title">${esc(_greeting())}</h1>
          <div class="view-subtitle">${esc(new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}${esc(ctxLabel)}</div>
        </div>
        <div class="today-actions">
          <button class="btn btn-ghost btn-sm" id="planDayBtn" title="Elige qué harás hoy según tu tiempo disponible">☀ Planificar mi día</button>
          <button class="btn btn-ghost btn-sm ${reviewDue ? 'attention' : ''}" id="todayReview" title="Repasa ideas, pendientes y proyectos quietos">
            🗓 Revisión semanal<span class="review-age">${reviewDays === null ? 'nunca' : reviewDays === 0 ? 'hoy' : `hace ${reviewDays} d`}</span></button>
          <button class="btn btn-primary btn-sm" id="dashAddProject">+ Proyecto</button>
        </div>
      </div>

      <form class="capture-bar" id="captureForm" autocomplete="off">
        <input class="capture-input" id="captureInput" maxlength="300" aria-label="Captura rápida"
               placeholder="${window.matchMedia?.('(max-width: 600px)').matches ? 'Capturar tarea, idea o reunión…' : 'Capturar: «enviar borrador >vega viernes @alfa» · «idea: …» · «clase cada lunes» · Enter (atajo: c)'}">
        <div class="capture-kinds" role="group" aria-label="Tipo de elemento">
          ${[['auto', 'Auto'], ['task', 'Tarea'], ['idea', 'Idea'], ['project', 'Proyecto'], ['meeting', 'Reunión']]
            .map(([k, l]) => `<button type="button" class="capture-kind ${k === 'auto' ? 'active' : ''}" data-ckind="${k}">${l}</button>`).join('')}
        </div>
      </form>
      <div class="capture-preview" id="capturePreview" aria-live="polite">
        <span class="capture-hint">Tip: <code>@proyecto</code> asigna · <code>&gt;persona</code> «esperando a» · <code>mañana</code>, <code>viernes</code>, <code>en 3 días</code>, <code>15/03</code> fijan fecha · <code>cada lunes</code> repite · <code>!alta</code> prioridad · <code>[[Título]]</code> enlaza</span>
      </div>

      <details class="today-notices" id="todayNotices" hidden>
        <summary id="todayNoticesSummary"></summary>
        <div class="today-notices-body">
          <div id="onboardHost"></div>
          <div id="todayAlerts"></div>
          <div id="followUpHost"></div>
        </div>
      </details>

      ${d.empty ? firstRunHTML() : `
      <div class="today-grid">
        <div class="today-main">${sections}</div>
        <aside class="today-side">${riskHTML}${theirsHTML}${noNextHTML}${ideasHTML}${waitingHTML}</aside>
      </div>`}

      <details class="panorama" id="panorama" ${localStorage.getItem('ros-panorama-open') === '1' ? 'open' : ''}>
        <summary>Panorama · distribución de proyectos</summary>
        <div id="panoramaBody"></div>
      </details>
    </div>`;

  mainContent.scrollTop = prevScroll;
  _wireToday(d, overdueTasks);
  if (d.empty) wireFirstRun();                                // shell.js
  if (prevCapture?.value) {
    const input = $('captureInput');
    input.value = prevCapture.value;
    input.dispatchEvent(new Event('input'));          // actualiza la vista previa
    if (prevCapture.focused) input.focus();
  }
  Promise.allSettled([
    _renderAlertPanel($('todayAlerts')),
    renderFollowUps($('followUpHost')),                      // academic.js
    renderOnboarding($('onboardHost')),                      // tour.js: datos de ejemplo y primeros pasos
  ]).then(() => _summarizeNotices(token));
  const pano = $('panorama');
  const loadPano = () => { if (pano.open && !pano.dataset.loaded) { pano.dataset.loaded = '1'; renderPanorama($('panoramaBody')); } };
  pano.addEventListener('toggle', () => { try { localStorage.setItem('ros-panorama-open', pano.open ? '1' : '0'); } catch {} loadPano(); });
  loadPano();
  mainContent.dataset.view = 'dashboard';
}

/** Los avisos de Hoy (datos de ejemplo, primeros pasos, alertas, personas por contactar) viven en una sola franja plegable:
    así lo primero que se ve son las tareas. La franja resume qué hay dentro y solo se ve si hay algo. */
function _summarizeNotices(token) {
  const box = $('todayNotices');
  if (!box || token !== App._todayToken) return;
  const q = sel => box.querySelector(sel);
  const alerts = q('.alert-panel .alert-item') ? box.querySelectorAll('.alert-panel .alert-item').length : 0;
  const people = box.querySelectorAll('[data-sec="followup"] .fu-row').length;
  const bits = [
    q('.sample-banner') && 'datos de ejemplo',
    q('.onboard') && `primeros pasos ${q('.onb-count')?.textContent || ''}`.trim(),
    alerts && `<strong>${alerts} alerta${alerts > 1 ? 's' : ''}</strong>`,
    people && `${people} persona${people > 1 ? 's' : ''} por contactar`,
  ].filter(Boolean);
  box.hidden = !bits.length;
  box.classList.toggle('has-alert', alerts > 0);
  $('todayNoticesSummary').innerHTML = `<span class="tn-label">Avisos</span> <span class="tn-bits">${bits.join(' · ')}</span>`;
  let open = false; try { open = localStorage.getItem('ros-today-notices') === '1'; } catch {}
  box.open = open;
  if (!box.dataset.wired) {
    box.dataset.wired = '1';
    box.addEventListener('toggle', () => { try { localStorage.setItem('ros-today-notices', box.open ? '1' : '0'); } catch {} });
  }
}

// -- operaciones sobre «tareas» (tabla tasks) y «acciones de reunión» (dentro de la reunión) con la misma interfaz --
const TaskOps = {
  async complete(kind, id, sub) {
    if (kind === 'task') { const spawned = await Tasks.setDone(id, true); return { undo: async () => { await Tasks.setDone(id, false); if (spawned) await Tasks.remove(spawned); } }; }
    await TaskOps._action(sub, id, { done: true });
    return { undo: () => TaskOps._action(sub, id, { done: false }) };
  },
  async setDue(kind, id, sub, due) { return kind === 'task' ? Tasks.setDue(id, due) : TaskOps._action(sub, id, { due }); },
  async setAssignee(kind, id, sub, who) { return kind === 'task' ? Tasks.setAssignee(id, who) : TaskOps._action(sub, id, { assigneeId: who }); },
  async _action(mid, aid, patch) {
    const m = await db.meetings.get(+mid);
    const items = (m.actionItems || []).map(a => String(a.id) === String(aid) ? { ...a, ...patch, ...('done' in patch ? { doneAt: patch.done ? new Date().toISOString() : null } : {}) } : a);
    await db.meetings.update(+mid, { actionItems: items, updatedAt: new Date().toISOString() });
  },
};

/** Notas y enlace de una tarea (p. ej. el correo del que salió). */
async function editTaskDetails(id, reload) {
  const t = await db.tasks.get(id);
  if (!t) return;
  showModal('📝 Notas y enlace', `
    <div class="modal-body">
      <div class="form-group"><label class="form-label">${esc(t.title)}</label>
        <textarea class="form-textarea" id="tdNotes" rows="4" maxlength="5000" placeholder="Contexto, qué falta, a quién preguntar…">${esc(t.notes || '')}</textarea></div>
      <div class="form-group"><label class="form-label">Enlace <span class="form-hint">(correo, documento, página…)</span></label>
        <input class="form-input" id="tdLink" type="url" placeholder="https://…" value="${esc(t.link || '')}"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-ghost" id="tdCancel">Cancelar</button><button class="btn btn-primary" id="tdSave">Guardar</button></div>`);
  focusField($('tdNotes'));
  $('tdCancel').addEventListener('click', closeModal);
  $('tdSave').addEventListener('click', async () => {
    const raw = $('tdLink').value.trim(), link = Tasks.cleanLink(raw);
    if (raw && !link) { showToast('El enlace debe empezar por http:// o https://', 'error'); return; }
    await dbWrite(() => db.tasks.update(id, { notes: Tasks.cleanNotes($('tdNotes').value), link }));
    closeModal(); showToast('Guardado ✓', 'success'); reload?.();
  });
}

function _taskMenu(anchor, row, reload) {
  const kind = row.dataset.kind, id = row.dataset.id, sub = row.dataset.sub;
  const numId = kind === 'task' ? +id : id;
  const snooze = _snoozeOptions(async due => { await dbWrite(() => TaskOps.setDue(kind, numId, sub, due)); reload(); })
    .map(o => ({ ...o, label: o.label === 'Sin fecha' ? 'Sin fecha' : `Posponer: ${o.label.toLowerCase()}` }));
  const items = [...snooze,
    { label: 'Esperando a…', action: async () => {
        const people = await db.collaborators.orderBy('name').toArray();
        openFloatingMenu(anchor, [{ label: 'Yo (quitar responsable)', action: async () => { await dbWrite(() => TaskOps.setAssignee(kind, numId, sub, null)); reload(); } },
          ...people.slice(0, 12).map(c => ({ label: c.name, action: async () => { await dbWrite(() => TaskOps.setAssignee(kind, numId, sub, c.id)); reload(); } }))]);
      } }];
  if (kind === 'task') {
    const planned = row.closest('[data-sec="plan"]');
    items.push({ label: planned ? 'Quitar de mi día' : 'Hacer hoy (añadir a mi día)', action: async () => { await dbWrite(() => Tasks.setPlan(numId, planned ? null : localDateISO())); reload(); } });
    items.push({ label: 'Tiempo estimado…', action: () => openFloatingMenu(anchor, [15, 30, 60, 120, 240].map(m => ({ label: fmtEffort(m), action: async () => { await dbWrite(() => Tasks.setEffort(numId, m)); reload(); } }))
      .concat([{ label: 'Sin estimar', action: async () => { await dbWrite(() => Tasks.setEffort(numId, null)); reload(); } }])) });
    items.push({ label: 'Repetir…', action: () => openFloatingMenu(anchor, [
      { label: 'No repetir', action: async () => { await dbWrite(() => Tasks.setRecurrence(numId, null)); reload(); } },
      { label: 'Cada día',   action: async () => { await dbWrite(() => Tasks.setRecurrence(numId, { freq: 'daily', interval: 1 })); reload(); } },
      { label: 'Cada semana', action: async () => { await dbWrite(() => Tasks.setRecurrence(numId, { freq: 'weekly', interval: 1 })); reload(); } },
      { label: 'Cada 2 semanas', action: async () => { await dbWrite(() => Tasks.setRecurrence(numId, { freq: 'weekly', interval: 2 })); reload(); } },
      { label: 'Cada mes',   action: async () => { await dbWrite(() => Tasks.setRecurrence(numId, { freq: 'monthly', interval: 1 })); reload(); } }]) });
    items.push({ label: 'Notas y enlace…', action: () => editTaskDetails(numId, reload) });
    items.push({ label: 'Eliminar tarea', danger: true, action: async () => {
      const t = await db.tasks.get(numId);
      await dbWrite(() => Tasks.remove(numId));
      UndoStack.push({ label: 'Eliminar tarea', undo: async () => { await dbWrite(() => db.tasks.put(t)); } });
      showToastWithUndo('Tarea eliminada', 'info'); reload(); } });
  }
  openFloatingMenu(anchor, items);
}

function _wireToday(d, overdueTasks) {
  const root = $('todayRoot');
  $('dashAddProject').addEventListener('click', () => showAddProjectModal());
  $('todayReview').addEventListener('click', () => navigate('review'));
  $('planDayBtn').addEventListener('click', () => openDayPlanner());
  $('planWeekBtn')?.addEventListener('click', () => openWeekPlanner());
  root.querySelector('[data-act-triage]')?.addEventListener('click', () => { App.triageIdx = 0; navigate('triage'); });

  // --- captura ---
  let kindOverride = 'auto';
  const input = $('captureInput'), preview = $('capturePreview');
  const hintHTML = preview.innerHTML;
  let cache = null;
  let assist = { apply: null }, refreshSeq = 0;
  const parsed = async () => {
    cache = cache || await captureContext();
    const c = parseCapture(input.value, cache.projects, new Date(), cache.people);
    if (kindOverride !== 'auto') c.kind = kindOverride;
    return c;
  };
  const refresh = async () => {
    const mine = ++refreshSeq;
    if (!input.value.trim()) { preview.innerHTML = hintHTML; assist = { apply: null }; return; }
    const c = await parsed();
    if (mine !== refreshSeq) return;                                       // llegó tarde: ya se escribió otra cosa
    assist = captureAssist(c, cache, input.value);
    preview.innerHTML = c.title ? `<span class="capture-arrow">→</span> ${describeCapture(c)}${assist.html}` : '';
  };
  input.addEventListener('input', refresh);
  const accept = () => { if (!assist.apply) return false; assist.apply(input); input.dispatchEvent(new Event('input')); input.focus(); return true; };
  preview.addEventListener('click', e => { if (e.target.closest('[data-accept]')) accept(); });
  input.addEventListener('keydown', e => { if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && assist.apply) { e.preventDefault(); accept(); } });
  root.querySelectorAll('[data-ckind]').forEach(b => b.addEventListener('click', () => {
    kindOverride = b.dataset.ckind;
    root.querySelectorAll('[data-ckind]').forEach(x => x.classList.toggle('active', x === b));
    input.focus(); refresh();
  }));
  let capturing = false;                          // un segundo Enter (o un clic) mientras se guarda no debe crear el elemento dos veces
  $('captureForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (capturing) return;
    capturing = true;
    const typed = input.value;
    try {
      const c = await parsed();
      if (c.title) { input.value = ''; refresh(); }               // ya capturado: otro Enter mientras la lista se repinta no lo repite
      const msg = await runCapture(c);
      showToast(msg + ' ✓', 'success');
      cache = null;
      renderToday().then(() => $('captureInput')?.focus());
      updateBadges();
    } catch (err) { input.value = typed; refresh(); showToast(err.message, 'error'); }
    finally { capturing = false; }
  });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { input.value = ''; input.blur(); refresh(); e.stopPropagation(); } });

  // --- filas ---
  const reload = () => { renderToday(); updateBadges(); };
  root.addEventListener('click', async e => {
    const expand = e.target.closest('[data-expand]');
    if (expand) { App._todayExpanded[expand.dataset.expand] = !App._todayExpanded[expand.dataset.expand]; return renderToday(); }
    const fold = e.target.closest('details.today-fold > summary')?.parentElement;           // se recuerda si la persona abre o cierra «Sin fecha» / «Más adelante»
    if (fold) { try { localStorage.setItem('ros-today-fold-' + fold.dataset.fold, fold.open ? '0' : '1'); } catch {} return; }
    const rp = e.target.closest('[data-risk-project]');
    if (rp) { e.preventDefault(); return inspectProject(+rp.dataset.riskProject); }
    const row = e.target.closest('.tw-row');
    if (!row) return;
    const kind = row.dataset.kind, id = +row.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;

    if (act === 'link') return;                                          // un enlace se abre solo: no hay que tratar el clic como un clic en la fila
    if (act === 'done') {
      if (row.classList.contains('tw-done-now')) return;              // un segundo clic no debe completarla dos veces (¡ni crear dos repeticiones!)
      row.classList.add('tw-done-now');                               // se ve hecha al instante; la lista se actualiza justo después
      const { undo } = await dbWrite(() => TaskOps.complete(kind, kind === 'task' ? id : row.dataset.id, row.dataset.sub));
      UndoStack.push({ label: 'Completar', undo: async () => { await dbWrite(() => undo()); } });
      showToastWithUndo(kind === 'task' && row.querySelector('.tw-rec') ? 'Hecho ✓ — creada la siguiente ocurrencia' : 'Hecho ✓', 'success');
      return reload();
    }
    if (act === 'menu') return _taskMenu(e.target.closest('[data-act]'), row, reload);
    if (act === 'addnext') {
      const p = await db.projects.get(+row.dataset.project);
      const input2 = $('captureInput');
      input2.value = `t: @"${p.title.replace(/"/g, '')}" `;
      input2.dispatchEvent(new Event('input'));
      input2.focus(); input2.setSelectionRange(input2.value.length, input2.value.length);
      input2.scrollIntoView({ block: 'center' });
      return;
    }
    if (act === 'project' || kind === 'deadline' || kind === 'waiting' || kind === 'nonext') return inspectProject(+row.dataset.project);
    if (kind === 'meeting') return inspectMeeting(id);
    if (kind === 'action') return inspectMeeting(+row.dataset.sub);
    if (kind === 'idea') return inspectIdea(id);
    if (kind === 'task') {
      if (row.dataset.idea) return inspectIdea(+row.dataset.idea);
      if (row.dataset.project) return inspectProject(+row.dataset.project);
    }
  });
}

// ==============================================================
//  PANORAMA (métricas) — solo se calcula si el usuario lo abre
// ==============================================================
// renderPanorama(host) vive en app.js (antes era todo el dashboard)

/** Cuenta elementos sin proyecto (o con un proyecto que ya no existe). */
async function countOrphans() {
  const [projects, ideas, snippets, refs, meets] = await Promise.all([
    db.projects.toArray(), db.ideas.toArray(), db.snippets.toArray(), db.references.toArray(), db.meetings.toArray()]);
  const live = new Set(projects.map(p => p.id));
  const linked = (...ids) => ids.flat().filter(Boolean).some(id => live.has(id));
  return ideas.filter(i => !linked(i.projectId, i.projectIds || [])).length
       + snippets.filter(x => !linked(x.projectId, x.projectIds || [])).length
       + refs.filter(r => !linked(r.projectId)).length
       + meets.filter(m => !linked(m.projectId)).length;
}

/** Pendientes que dependen de una persona: tareas asignadas a ella + pasos de reunión con su nombre. */
async function pendingWith(collabId) {
  const [tasks, meetings, projects] = await Promise.all([db.tasks.toArray(), db.meetings.toArray(), db.projects.toArray()]);
  const projTitle = Object.fromEntries(projects.map(p => [p.id, p.title]));
  const out = tasks.filter(t => !t.done && t.assigneeId === collabId)
    .map(t => ({ title: t.title, due: t.due, projectTitle: projTitle[t.projectId] || '', src: 'task' }));
  for (const m of meetings)
    for (const a of (m.actionItems || []).filter(a => !a.done && a.assigneeId === collabId))
      out.push({ title: a.text, due: a.due || null, projectTitle: projTitle[m.projectId] || '', src: 'action' });
  return out.sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
}

/** Texto de agenda para pegar en un correo o en las notas de una reunión. */
async function agendaTextFor(collab) {
  const items = await pendingWith(collab.id);
  const lines = [`Agenda con ${collab.name} — ${formatDate(localDateISO())}`, ''];
  lines.push(items.length ? `Pendientes (esperando a ${collab.name.split(' ')[0]}):` : 'Sin pendientes registrados.');
  for (const it of items) lines.push(`- [ ] ${it.title}${it.projectTitle ? ` (${it.projectTitle})` : ''}${it.due ? ` · ${dueLabel(it.due)}` : ''}`);
  return lines.join('\n');
}

/**
 * Convierte una idea de la bandeja en una tarea o en un proyecto y la saca de la bandeja.
 * Un solo «Deshacer» devuelve la idea y elimina lo creado.
 */
const _promoting = new Set();
async function promoteIdea(id, kind) {
  if (_promoting.has(id)) return;            // un doble clic no debe crear dos tareas ni dos proyectos
  _promoting.add(id);
  try { await _promoteIdea(id, kind); } finally { _promoting.delete(id); }
}
async function _promoteIdea(id, kind) {
  const idea = await db.ideas.get(id);
  if (!idea) return;
  const now = new Date().toISOString();
  const area = typeof App.areaContext === 'number' ? App.areaContext : null;
  let createdUndo;
  if (kind === 'task') {
    const taskId = await dbWrite(() => Tasks.add({ title: idea.title, due: idea.deadline, projectId: idea.projectId ?? null, areaId: area }));
    createdUndo = () => Tasks.remove(taskId);
  } else {
    const cols = await db.kanbanColumns.orderBy('order').toArray();
    const colId = cols[0]?.id;
    const pid = await dbWrite(() => db.projects.add({ title: idea.title, type: 'Proyecto', columnId: colId, priority: 'Media', responsible: '', coauthors: [],
      deadline: idea.deadline || null, description: idea.content || '', tags: idea.tags || [], areaId: area, status: 'active', archived: false, starred: false,
      createdAt: now, updatedAt: now, customFields: {}, columnHistory: [{ colId, enteredAt: now, exitedAt: null }] }));
    createdUndo = () => deleteProjectCascade(pid).then(() => {});
  }
  const restoreIdea = await dbWrite(() => deleteIdeaCascade(id));
  UndoStack.push({ label: kind === 'task' ? 'Idea → tarea' : 'Idea → proyecto', undo: async () => { await dbWrite(async () => { await restoreIdea(); await createdUndo(); }); } });
  closeInspector();
  showToastWithUndo(kind === 'task' ? 'Idea convertida en tarea ✓' : 'Idea convertida en proyecto ✓', 'success');
  if (App.view === 'ideas') renderIdeas();
  else renderView(App.view);
  updateBadges();
}

// ==============================================================
//  REVISIÓN SEMANAL
// ==============================================================
async function renderWeeklyReview() {
  const d = await collectToday();
  const todayISO = d.todayISO;
  const in14 = addDaysISO(14);
  const overdueTasks = d.now.filter(r => r.kind === 'task' && r.due < todayISO);
  const idle = d.ctxLive.filter(p => isIdle(p, 14)).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  const upcoming = [...d.week, ...d.later].filter(r => r.due <= in14 && r.kind !== 'task').concat(
                   [...d.week, ...d.later].filter(r => r.due <= in14 && r.kind === 'task'));
  const bk = BackupMeta.daysSince();
  const orphanCount = await countOrphans();

  const step = (n, title, body, count) => `
    <section class="review-step">
      <h2><span class="review-n">${n}</span> ${title}${count != null ? ` <span class="today-count">${count}</span>` : ''}</h2>
      ${body}
    </section>`;

  mainContent.innerHTML = `
    <div class="view" id="reviewRoot">
      <div class="view-header"><div>
        <h1 class="view-title">Revisión semanal</h1>
        <div class="view-subtitle">Diez minutos para dejar tu cabeza libre: cada paso es opcional.${App.areaContext !== 'all' ? ' Solo el área activa.' : ''}</div>
      </div></div>

      ${step(1, 'Bandeja de ideas', d.ideasUnread.length
        ? `<p>Tienes ${d.ideasUnread.length} idea(s) sin revisar.</p><button class="btn btn-primary btn-sm" id="rvTriage">Revisarlas en modo rápido →</button>`
        : `<p class="ok">✓ Bandeja vacía.</p>`, null)}

      ${step(2, 'Tareas atrasadas', overdueTasks.length
        ? `<div class="review-bulk">Reprogramar todas: <button class="btn btn-ghost btn-sm" id="rvBulk">elegir fecha…</button></div>
           ${overdueTasks.slice(0, 12).map(r => _todayRowHTML(r, todayISO)).join('')}
           ${overdueTasks.length > 12 ? `<div class="today-empty">…y ${overdueTasks.length - 12} más</div>` : ''}`
        : `<p class="ok">✓ Sin tareas atrasadas.</p>`, overdueTasks.length || null)}

      ${step(3, 'Proyectos sin movimiento (14+ días)', idle.length
        ? idle.slice(0, 10).map(p => `
          <div class="tw-row" data-id="${p.id}" data-kind="idle">
            <span class="tw-icon" aria-hidden="true">⊘</span>
            <span class="tw-text">${esc(p.title)}</span>
            <span class="tw-due">hace ${Math.floor((Date.now() - new Date(p.updatedAt)) / 86400000)} d</span>
            <span class="review-actions">
              <button class="btn btn-ghost btn-sm" data-rv="keep">Sigue activo</button>
              <button class="btn btn-ghost btn-sm" data-rv="archive">Archivar</button>
              <button class="btn btn-ghost btn-sm" data-rv="open">Abrir</button>
            </span>
          </div>`).join('')
        : `<p class="ok">✓ Todo tiene movimiento reciente (los proyectos en revisión o terminados no cuentan).</p>`, idle.length || null)}

      ${step(4, 'Proyectos sin próxima acción', d.noNext.length
        ? `<p>Están en curso pero no tienen ninguna tarea pendiente. Define el siguiente paso o archívalos.</p>` + d.noNext.slice(0, 8).map(p => `
          <div class="tw-row" data-kind="nonext" data-id="${p.id}" data-project="${p.id}">
            <span class="tw-icon" aria-hidden="true">◌</span><span class="tw-text">${esc(p.title)}</span>
            <span class="review-actions"><button class="btn btn-ghost btn-sm" data-rv="addtask">+ Añadir tarea</button><button class="btn btn-ghost btn-sm" data-rv="open">Abrir</button></span>
          </div>`).join('')
        : `<p class="ok">✓ Todos los proyectos en curso tienen un siguiente paso.</p>`, d.noNext.length || null)}

      ${step(5, 'Próximos 14 días', upcoming.length
        ? upcoming.slice(0, 12).map(r => _todayRowHTML(r, todayISO)).join('')
        : `<p>Nada con fecha en las próximas dos semanas.</p>`, upcoming.length || null)}

      ${step(6, 'Esperando a otras personas y respuestas', (d.theirs.length || d.waiting.length)
        ? d.theirs.slice(0, 8).map(r => _todayRowHTML(r, todayISO)).join('') + d.waiting.map(p => `<div class="tw-row" data-kind="waiting" data-id="${p.id}" data-project="${p.id}"><span class="tw-icon">⏳</span><span class="tw-text">${esc(p.title)}</span>
            <span class="tw-sub">${esc(SUB_STATUSES.find(s => s.key === p.submissionStatus)?.label || 'en revisión')}</span></div>`).join('')
        : `<p>Nada pendiente de terceros.</p>`, (d.theirs.length + d.waiting.length) || null)}

      ${step(7, 'Elementos sin proyecto', orphanCount
        ? `<p>${orphanCount} idea(s), snippet(s), referencia(s) o reunión(es) no están ligados a ningún proyecto.</p><button class="btn btn-ghost btn-sm" id="rvOrphans">Asignarlos →</button>`
        : `<p class="ok">✓ Todo está conectado a un proyecto.</p>`, orphanCount || null)}

      ${step(8, 'Copia de seguridad', `<p class="${bk === null || bk >= BackupMeta.BACKUP_DAYS ? 'warn' : 'ok'}">${
          bk === null ? '⚠ Nunca has exportado un backup.' : bk === 0 ? '✓ Exportado hoy.' : `Último backup: hace ${bk} día(s).`}</p>
        <button class="btn btn-ghost btn-sm" id="rvBackup">Exportar ahora</button>`, null)}

      <div class="review-finish">
        <button class="btn btn-primary" id="rvDone">✓ Terminar revisión</button>
      </div>
    </div>`;

  const root = $('reviewRoot');
  $('rvTriage')?.addEventListener('click', () => { App.triageIdx = 0; navigate('triage'); });
  $('rvOrphans')?.addEventListener('click', () => navigate('orphans'));
  $('rvBackup')?.addEventListener('click', async () => { await downloadBackup(); showToast('Backup exportado ✓', 'success'); renderWeeklyReview(); });
  $('rvDone').addEventListener('click', () => {
    try { localStorage.setItem('ros-last-review', String(Date.now())); } catch {}
    showToast('Revisión terminada ✓ — buen trabajo', 'success');
    navigate('dashboard');
  });
  $('rvBulk')?.addEventListener('click', e => openFloatingMenu(e.target, _snoozeOptions(async due => {
    await dbWrite(async () => { for (const r of overdueTasks) await Tasks.setDue(r.id, due); });
    showToast(`${overdueTasks.length} tarea(s) reprogramada(s) ✓`, 'success'); renderWeeklyReview();
  })));
  root.addEventListener('click', async e => {
    const row = e.target.closest('.tw-row');
    if (!row) return;
    const id = +row.dataset.id, kind = row.dataset.kind;
    const rv = e.target.closest('[data-rv]')?.dataset.rv;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (rv === 'keep')    { await dbWrite(() => db.projects.update(id, { updatedAt: new Date().toISOString() })); return renderWeeklyReview(); }
    if (rv === 'archive') {
      await dbWrite(() => db.projects.update(id, { archived: true, updatedAt: new Date().toISOString() }));
      UndoStack.push({ label: 'Archivar', undo: async () => { await dbWrite(() => db.projects.update(id, { archived: false })); } });
      showToastWithUndo('Proyecto archivado', 'info');
      return renderWeeklyReview();
    }
    if (rv === 'addtask') {
      const p = await db.projects.get(id);
      const title = await askText(`Primera tarea de «${p.title}»`, { placeholder: 'p. ej. Redactar la introducción', message: 'Cuál es el siguiente paso concreto.' });
      if (title?.trim()) { await dbWrite(() => Tasks.add({ title, projectId: id })); showToast('Tarea añadida ✓', 'success'); }
      return renderWeeklyReview();
    }
    if (rv === 'open' || kind === 'idle' || kind === 'waiting' || kind === 'deadline' || kind === 'nonext') return inspectProject(+(row.dataset.project || id));
    if (act === 'done' && (kind === 'task' || kind === 'action')) {
      if (row.classList.contains('tw-done-now')) return;
      row.classList.add('tw-done-now');
      await dbWrite(() => TaskOps.complete(kind, kind === 'task' ? id : row.dataset.id, row.dataset.sub));
      return renderWeeklyReview();
    }
    if (act === 'menu') return _taskMenu(e.target.closest('[data-act]'), row, () => renderWeeklyReview());
  });
}

// ==============================================================
//  ENLACES [[Título]] ENTRE ELEMENTOS
// ==============================================================
/** Reemplaza [[Título]] / [[Título|texto]] por enlaces dentro de un árbol DOM ya saneado. */
function _linkifyWikilinks(root) {
  const idx = App._titleIndex;
  if (!idx || !root) return;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.nodeValue.includes('[[') && !n.parentElement.closest('a, code, pre')) nodes.push(n);
  const re = /\[\[([^\[\]\n|]{1,120})(?:\|([^\[\]\n]{1,120}))?\]\]/g;
  for (const node of nodes) {
    const text = node.nodeValue;
    const frag = doc.createDocumentFragment();
    let last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const target = resolveTitle(m[1]);
      const label = (m[2] || m[1]).trim();
      const el = doc.createElement(target ? 'a' : 'span');
      el.className = target ? 'wikilink' : 'wikilink wikilink-missing';
      el.textContent = label;
      if (target) { el.setAttribute('href', '#'); el.dataset.wlType = target.type; el.dataset.wlId = String(target.id); el.title = `Abrir: ${target.title}`; }
      else el.title = `No existe «${m[1].trim()}»`;
      frag.append(el);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** Busca un elemento por título: exacto, luego por prefijo único, luego por contenido único. */
const _titleCache = new WeakMap();             // índice → { all: [[título, elemento]…], memo: Map } (se descarta solo cuando el índice se reconstruye)
function resolveTitle(raw, idx = App._titleIndex) {
  if (!idx) return null;
  const q = foldText(raw).trim();
  if (!q) return null;
  if (idx.has(q)) return idx.get(q);
  let c = _titleCache.get(idx);
  if (!c) _titleCache.set(idx, c = { all: [...idx.entries()], memo: new Map() });
  if (c.memo.has(q)) return c.memo.get(q);
  const starts = c.all.filter(([k]) => k.startsWith(q));
  let res = null;
  if (starts.length === 1) res = starts[0][1];
  else {
    const incl = c.all.filter(([k]) => k.includes(q));
    res = incl.length === 1 ? incl[0][1] : null;
  }
  c.memo.set(q, res);
  return res;
}

async function openEntity(type, id) {
  if (type === 'project') return inspectProject(id);
  if (type === 'idea') return inspectIdea(id);
  if (type === 'snippet') { const s = await db.snippets.get(id); return s && inspectSnippet(s); }
  if (type === 'ref') return inspectReference(id);
  if (type === 'meeting') return inspectMeeting(id);
  if (type === 'collab') return inspectCollaborator(id);
}

// clic en un enlace [[ ]] (en fase de captura: gana a los clics de la tarjeta que lo contiene)
document.addEventListener('click', e => {
  const a = e.target.closest?.('a.wikilink');
  if (a) { e.preventDefault(); e.stopPropagation(); openEntity(a.dataset.wlType, +a.dataset.wlId); return; }
  const miss = e.target.closest?.('.wikilink-missing');
  if (miss) { e.stopPropagation(); showToast(`«${miss.textContent}» no existe aún. Créalo desde Ctrl+K.`, 'info'); }
}, true);

/** Elementos cuyo texto enlaza explícitamente a `title` mediante [[…]]. */
async function findMentions(title, self = {}) {
  const q = foldText(title).trim();
  if (!q) return { projects: [], ideas: [], snippets: [], meetings: [] };
  const esc_ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[\\[\\s*${esc_}\\s*(\\||\\]\\])`);
  const has = t => re.test(foldText(t || ''));
  const [projects, ideas, snippets, meetings] = await Promise.all([
    db.projects.filter(p => !(self.type === 'project' && self.id === p.id) && has(p.description)).toArray(),
    db.ideas.filter(i => !(self.type === 'idea' && self.id === i.id) && has(i.content)).toArray(),
    db.snippets.filter(s => !(self.type === 'snippet' && self.id === s.id) && has(s.description)).toArray(),
    db.meetings.filter(m => !(self.type === 'meeting' && self.id === m.id) && (has(m.agreements) || has(m.title))).toArray(),
  ]);
  return { projects, ideas, snippets, meetings };
}

/** Bloque «Mencionado en» (enlaces explícitos) al final de un inspector. */
async function _appendBacklinks(selfType, selfId, title) {
  const m = await findMentions(title, { type: selfType, id: selfId });
  const items = [
    ...m.projects.map(x => ({ type: 'project', id: x.id, icon: '◉', title: x.title })),
    ...m.ideas.map(x => ({ type: 'idea', id: x.id, icon: '◎', title: x.title })),
    ...m.snippets.map(x => ({ type: 'snippet', id: x.id, icon: '⟨/⟩', title: x.title })),
    ...m.meetings.map(x => ({ type: 'meeting', id: x.id, icon: '🗓', title: x.title })),
  ];
  if (!items.length || App.inspectedId !== selfId) return;
  const el = document.createElement('div');
  el.className = 'backlinks';
  el.innerHTML = `<div class="inspector-related-title" style="margin-top:12px">🔗 Enlazado desde</div>` +
    items.map(it => `<div class="inspector-related-item" data-bl="${it.type}:${it.id}" style="cursor:pointer;display:flex;gap:6px">
      <span style="flex-shrink:0">${it.icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.title)}</span></div>`).join('');
  const actions = inspectorBody.querySelector('.inspector-actions');
  actions ? actions.parentNode.insertBefore(el, actions) : inspectorBody.firstElementChild?.appendChild(el);
  el.querySelectorAll('[data-bl]').forEach(b => b.addEventListener('click', () => {
    const [t, i] = b.dataset.bl.split(':'); openEntity(t, +i);
  }));
}

// -- Autocompletado al escribir [[ ---------------------------
(function setupWikilinkAutocomplete() {
  let popup = null, field = null, matches = [], active = 0, start = 0;
  const close = () => { popup?.remove(); popup = null; field = null; matches = []; };
  const insert = m => {
    const v = field.value, caret = field.selectionStart;
    field.value = v.slice(0, start) + m.title + ']]' + v.slice(caret);
    const pos = start + m.title.length + 2;
    field.setSelectionRange(pos, pos);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const f = field; close(); f.focus();
  };
  const draw = () => {
    if (!popup) { popup = document.createElement('div'); popup.className = 'wl-popup'; popup.setAttribute('role', 'listbox'); document.body.appendChild(popup); }
    popup.innerHTML = matches.map((m, i) => `<div class="wl-item ${i === active ? 'active' : ''}" role="option" data-i="${i}">
      <span class="wl-type">${{ project: '◉', idea: '◎', snippet: '⟨/⟩', ref: '📚', meeting: '🗓', collab: '👤' }[m.type] || '•'}</span>${esc(m.title)}</div>`).join('');
    const r = field.getBoundingClientRect();
    popup.style.left = `${Math.max(8, r.left)}px`;
    popup.style.top  = `${Math.min(r.bottom + 4, window.innerHeight - 220)}px`;
    popup.style.minWidth = `${Math.min(r.width, 360)}px`;
  };
  document.addEventListener('input', e => {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement && el.type === 'text')) return;
    const upto = el.value.slice(0, el.selectionStart);
    const m = upto.match(/\[\[([^\[\]\n]*)$/);
    if (!m || !App._titleIndex) { close(); return; }
    const q = foldText(m[1]).trim();
    const list = [...App._titleIndex.entries()].filter(([k]) => !q || k.includes(q))
      .sort((a, b) => (a[0].startsWith(q) ? 0 : 1) - (b[0].startsWith(q) ? 0 : 1)).slice(0, 7).map(([, v]) => v);
    if (!list.length) { close(); return; }
    field = el; matches = list; active = 0; start = el.selectionStart - m[1].length;
    draw();
  });
  document.addEventListener('keydown', e => {
    if (!popup) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); active = (active + 1) % matches.length; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); active = (active - 1 + matches.length) % matches.length; draw(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); insert(matches[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }, true);
  document.addEventListener('mousedown', e => {
    const it = e.target.closest?.('.wl-item');
    if (it && popup) { e.preventDefault(); insert(matches[+it.dataset.i]); }
    else if (popup && !popup.contains(e.target)) close();
  }, true);
})();

// ==============================================================
//  NAVEGACIÓN: grupos plegables del menú lateral
// ==============================================================
function _navGroupState() {
  try { return JSON.parse(localStorage.getItem('ros-nav-open') || '{}'); } catch { return {}; }
}
function initNavGroups() {
  const state = _navGroupState();
  document.querySelectorAll('.nav-group').forEach(g => {
    const name = g.dataset.group;
    const open = !!state[name];
    g.classList.toggle('open', open);
    g.querySelector('.nav-group-toggle').setAttribute('aria-expanded', String(open));
    g.querySelector('.nav-group-toggle').addEventListener('click', () => {
      const now = !g.classList.contains('open');
      g.classList.toggle('open', now);
      g.querySelector('.nav-group-toggle').setAttribute('aria-expanded', String(now));
      const s = _navGroupState(); s[name] = now;
      try { localStorage.setItem('ros-nav-open', JSON.stringify(s)); } catch {}
    });
  });
}
// -- Perfil de uso: el menú muestra lo que la persona suele usar; lo demás sigue en la paleta (Ctrl+K) y aparece al abrirlo --
const NAV_PROFILES = [
  { key: 'all',        label: 'Todo',          desc: 'todas las vistas',                                         hide: [] },
  { key: 'research',   label: 'Investigación', desc: 'papers, referencias, submissions e informes',              hide: ['filesystem'] },
  { key: 'teaching',   label: 'Docencia',      desc: 'clases, evaluaciones, estudiantes y reuniones',            hide: ['references', 'snippets', 'submissions', 'report', 'filesystem'] },
  { key: 'management', label: 'Gestión',       desc: 'proyectos, reuniones, personas y seguimiento',             hide: ['references', 'snippets', 'submissions', 'filesystem'] },
];
const NavProfile = {
  get() { try { const k = localStorage.getItem('ros-profile'); return NAV_PROFILES.some(p => p.key === k) ? k : 'all'; } catch { return 'all'; } },
  set(key) { try { localStorage.setItem('ros-profile', key); } catch {} document.querySelectorAll('.nav-item.profile-peek').forEach(a => a.classList.remove('profile-peek')); this.apply(); },
  apply() {
    const hide = new Set(NAV_PROFILES.find(p => p.key === this.get()).hide);
    document.querySelectorAll('.sidebar .nav-item[data-view]').forEach(a => a.classList.toggle('profile-hidden', hide.has(a.dataset.view) && !a.classList.contains('profile-peek')));
    document.querySelectorAll('.nav-group').forEach(g => g.classList.toggle('profile-hidden', ![...g.querySelectorAll('.nav-item')].some(a => !a.classList.contains('profile-hidden'))));
    if (typeof updateNavGroupDots === 'function') updateNavGroupDots();
  },
};
function renderProfileSection() {
  const host = $('profileSection');
  if (!host) return;
  const cur = NavProfile.get();
  host.innerHTML = `
    <div class="settings-section-title">🧭 Perfil de uso</div>
    <div class="settings-body"><div class="settings-row">
      <div><div class="settings-row-label">¿Qué haces más?</div>
        <div class="settings-row-desc">El menú lateral muestra solo lo que ese perfil suele usar. Lo demás sigue disponible en la paleta (${MOD_KEY} K) y aparece en el menú cuando lo abres.</div></div>
      <select class="form-select" id="profileSelect" aria-label="Perfil de uso" style="max-width:300px">
        ${NAV_PROFILES.map(p => `<option value="${p.key}"${p.key === cur ? ' selected' : ''}>${p.label} — ${p.desc}</option>`).join('')}</select>
    </div></div>`;
  $('profileSelect').addEventListener('change', e => { NavProfile.set(e.target.value); showToast('Menú actualizado ✓', 'success'); });
}

/** Abre el grupo que contiene la vista activa (para que nunca quede escondida). */
function revealNavItem(view) {
  const item = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (item?.classList.contains('profile-hidden')) { item.classList.add('profile-peek'); NavProfile.apply(); }     // una vista que el perfil oculta, pero se abrió: no puede quedar invisible
  const g = item?.closest('.nav-group');
  if (g && !g.classList.contains('open')) {
    g.classList.add('open');
    g.querySelector('.nav-group-toggle').setAttribute('aria-expanded', 'true');
  }
}
/** Punto de aviso en un grupo cerrado cuando algún elemento interno tiene contador. */
function updateNavGroupDots() {
  document.querySelectorAll('.nav-group').forEach(g => {
    const n = [...g.querySelectorAll('.nav-badge')].filter(b => b.classList.contains('visible') && !b.closest('.profile-hidden')).reduce((a, b) => a + (parseInt(b.textContent, 10) || 0), 0);
    g.classList.toggle('has-alert', n > 0);
    const dot = g.querySelector('.nav-group-dot');
    if (dot) { dot.textContent = n > 99 ? '99+' : n ? String(n) : ''; dot.title = n ? `${n} pendiente${n > 1 ? 's' : ''} en este grupo` : ''; }   // el grupo plegado dice cuántos pendientes esconde
  });
}
