// ============================================================
//  ResearchOS — Planificación del día, informe de avance y recordatorios
//
//  «Mi día»: las tareas que decides hacer hoy, con tiempo estimado frente a tu capacidad.
//  «Informe de avance»: qué lograste en un periodo (para la memoria anual, el informe al decano o tu CV).
//  Recordatorio diario: aviso del navegador con lo que toca hoy (mientras la app esté abierta).
// ============================================================

'use strict';

const Capacity = {
  DEFAULT: 360,                                            // 6 h de trabajo efectivo al día
  get() { try { return Math.max(30, +localStorage.getItem('ros-capacity') || Capacity.DEFAULT); } catch { return Capacity.DEFAULT; } },
  set(min) { try { localStorage.setItem('ros-capacity', String(Math.max(30, Math.min(960, Math.round(min) || Capacity.DEFAULT)))); } catch {} },
};

// ==============================================================
//  1) MI DÍA
// ==============================================================
function planSectionHTML(d) {
  if (!d.plan.length && !d.doneToday) return '';
  const cap = Math.max(30, Capacity.get() - (d.busyToday || 0));                 // las reuniones de hoy con hora y duración ya ocupan parte del día
  const total = d.plan.reduce((s, r) => s + (r.effort || 0), 0);
  const unest = d.plan.filter(r => !r.effort).length;
  const over = total > cap;
  const bits = [`${esc(fmtEffort(total) || '0 min')} de ${esc(fmtEffort(cap))}${d.busyToday ? ` (tras ${esc(fmtEffort(d.busyToday))} de reuniones)` : ''}`];
  if (unest) bits.push(`${unest} sin estimar`);
  if (over) bits.push(`<strong>te pasas por ${esc(fmtEffort(total - cap))}</strong>`);
  if (d.doneToday) bits.push(`✓ ${d.doneToday} hecha${d.doneToday > 1 ? 's' : ''} hoy`);
  return `
    <section class="today-sec plan ${over ? 'is-over' : ''}" data-sec="plan" aria-labelledby="ts-plan">
      <h2 class="today-sec-title" id="ts-plan">Mi día${d.plan.length ? ` <span class="today-count">${d.plan.length}</span>` : ''}</h2>
      <div class="plan-meter" role="meter" aria-label="Tiempo planificado" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${total}"><span style="width:${Math.min(100, Math.round(total / cap * 100))}%"></span></div>
      <div class="plan-sub" id="planSub">${bits.join(' · ')}</div>
      ${d.plan.length ? d.plan.map(r => _todayRowHTML(r, d.todayISO)).join('') : '<div class="today-empty">✓ Terminaste lo que planificaste.</div>'}
    </section>`;
}

/** Candidatas para hoy: lo ya planificado, lo atrasado, lo de hoy y lo próximo (3 días), más lo importante sin fecha. */
async function dayCandidates() {
  const todayISO = localDateISO(), soon = addDaysISO(3);
  const [tasks, projects] = await Promise.all([db.tasks.toArray(), db.projects.toArray()]);
  const proj = Object.fromEntries(projects.map(p => [p.id, p]));
  const rank = t => t.planDate && t.planDate <= todayISO ? 0 : t.due && t.due < todayISO ? 1 : t.due === todayISO ? 2 : t.due && t.due <= soon ? 3 : 4;
  return tasks
    .filter(t => !t.done && !Me.waiting(t.assigneeId) && !(t.projectId && (proj[t.projectId]?.archived || proj[t.projectId]?.paused)) && !Tasks.isBlocked(t, Tasks.index(tasks)) && (!t.projectId || inContext(proj[t.projectId] || {})))
    .filter(t => rank(t) < 4 || t.priority === 'Alta')
    .map(t => ({ ...t, projectTitle: proj[t.projectId]?.title || '', planned: !!(t.planDate && t.planDate <= todayISO), bucket: rank(t) }))
    .sort((a, b) => a.bucket - b.bucket || _byUrgency(a, b))
    .slice(0, 40);
}

/** «Planificar la semana»: propone un día para lo atrasado, lo que vence en dos semanas y lo importante sin fecha (insights.js → Load.planWeek). */
async function openWeekPlanner() {
  const [tasks, projects, meetings] = await Promise.all([db.tasks.toArray(), db.projects.toArray(), db.meetings.toArray()]);
  const cap = Capacity.get();
  const r = Load.planWeek({ tasks, projects, today: localDateISO(), capacity: cap, busy: Load.busyFrom(meetings) });
  if (!r.plan.length) { showToast(r.unplaced.length ? `${r.unplaced.length} tarea(s) pendientes no caben esta semana: revisa tu capacidad o sus plazos` : 'Lo urgente ya tiene día ✓', 'info'); return; }
  const byDay = new Map(r.days.map(d => [d.day, []]));
  for (const p of r.plan) byDay.get(p.day).push(p);
  const dayLabel = iso => new Date(iso + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'short' });
  showModal('📅 Planificar la semana', `
    <div class="modal-body">
      <p class="settings-row-desc">Propongo un día para lo atrasado, lo que vence en dos semanas y lo importante sin fecha, sin pasar de tus ${esc(fmtEffort(cap))} por día laborable. Desmarca lo que no quieras: se guarda como «el día en que lo haré» y aparece en Mi día.</p>
      ${r.days.map(d => `
        <div class="wp-day">
          <div class="today-day">${esc(dayLabel(d.day))} · ${esc(fmtEffort(d.used) || '0 min')} de ${esc(fmtEffort(d.capacity))}${d.capacity < cap ? ' (tras reuniones)' : ''}</div>
          ${byDay.get(d.day).map(p => `
            <label class="dp-row">
              <input type="checkbox" class="wp-check" data-id="${p.task.id}" data-day="${d.day}" checked aria-label="Hacer ${esc(dayLabel(d.day))}: ${esc(p.task.title)}">
              <span class="dp-main"><span class="dp-title">${esc(p.task.title)}</span>
                <span class="dp-meta">${p.project ? esc(p.project.title) + ' · ' : ''}${p.task.due ? esc(dueLabel(p.task.due)) : p.project?.deadline ? 'plazo ' + esc(formatDate(p.project.deadline)) : 'sin fecha'}${p.late ? ' · <span class="dp-over">pasa de su plazo</span>' : ''}${p.estimated ? '' : ' · sin estimar'}</span></span>
              <span class="dp-unit">${esc(fmtEffort(p.minutes))}</span>
            </label>`).join('') || '<div class="today-empty">Nada nuevo este día.</div>'}
        </div>`).join('')}
      ${r.unplaced.length ? `<div class="dp-note">${r.unplaced.length} tarea(s) no caben esta semana: «${esc(r.unplaced[0].t.title)}»${r.unplaced.length > 1 ? ' y otras' : ''}.</div>` : ''}
    </div>
    <div class="modal-footer"><button class="btn btn-ghost" id="wpCancel">Cancelar</button><button class="btn btn-primary" id="wpApply">Aplicar el plan</button></div>`);
  $('wpCancel').addEventListener('click', closeModal);
  $('wpApply').addEventListener('click', async () => {
    const picks = [...modalContent.querySelectorAll('.wp-check:checked')].map(c => ({ id: +c.dataset.id, day: c.dataset.day }));
    closeModal();
    if (!picks.length) return;
    await dbWrite(async () => { for (const p of picks) await Tasks.setPlan(p.id, p.day); });
    UndoStack.push({ label: 'Plan de la semana', undo: async () => { for (const p of picks) await Tasks.setPlan(p.id, null); } });
    showToastWithUndo(`${picks.length} tarea(s) con día asignado ✓`, 'success');
    renderView(App.view);
  });
}

async function openDayPlanner() {
  const todayISO = localDateISO();
  const list = await dayCandidates();
  const DEFAULT_MIN = 30;
  const dayCap = Math.max(30, Capacity.get() - (Load.busyFrom(await db.meetings.toArray(), todayISO).get(todayISO) || 0));
  const rows = list.map(t => `
    <label class="dp-row" data-id="${t.id}">
      <input type="checkbox" class="dp-check" ${t.planned ? 'checked' : ''} aria-label="Hacer hoy: ${esc(t.title)}">
      <span class="dp-main"><span class="dp-title">${esc(t.title)}</span>
        <span class="dp-meta">${t.projectTitle ? esc(t.projectTitle) + ' · ' : ''}${t.due ? esc(dueLabel(t.due)) : 'sin fecha'}${t.priority === 'Alta' ? ' · alta' : ''}</span></span>
      <input class="form-input dp-eff" type="number" min="5" max="1440" step="5" value="${t.effort || ''}" placeholder="${DEFAULT_MIN}" aria-label="Minutos estimados">
      <span class="dp-unit">min</span>
    </label>`).join('');
  showModal('☀ Planificar mi día', `
    <div class="modal-body">
      <div class="dp-top">
        <label class="dp-cap">Tiempo disponible hoy
          <input class="form-input" id="dpCap" type="number" min="0.5" max="16" step="0.5" value="${(dayCap / 60).toFixed(1).replace(/\.0$/, '')}"> h</label>
        <button type="button" class="btn btn-ghost btn-sm" id="dpSuggest" title="Marca lo más urgente hasta llenar tu tiempo">✨ Sugerir</button>
      </div>
      <div class="dp-meter"><span id="dpBar"></span></div>
      <div class="dp-summary" id="dpSummary" aria-live="polite"></div>
      <div class="dp-list">${rows || '<div class="today-empty">No hay tareas pendientes que planificar. Captura algunas desde Hoy.</div>'}</div>
      <div class="dp-note">Lo que no tenga tiempo estimado cuenta como ${DEFAULT_MIN} min. Lo planificado y sin terminar pasa solo al día siguiente. <button type="button" class="today-more" id="dpWeek">Planificar toda la semana →</button></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="dpCancel">Cancelar</button>
      <button class="btn btn-primary" id="dpSave">Guardar mi día</button>
    </div>`);

  const rowsEl = [...document.querySelectorAll('.dp-row')];
  const minutes = row => +row.querySelector('.dp-eff').value || DEFAULT_MIN;
  const capacity = () => Math.round((parseFloat($('dpCap').value) || 6) * 60);
  const recompute = () => {
    const picked = rowsEl.filter(r => r.querySelector('.dp-check').checked);
    const total = picked.reduce((s, r) => s + minutes(r), 0), cap = capacity();
    $('dpSummary').innerHTML = `${picked.length} tarea${picked.length === 1 ? '' : 's'} · <strong>${esc(fmtEffort(total) || '0 min')}</strong> de ${esc(fmtEffort(cap))}` +
      (total > cap ? ` · <span class="dp-over">te pasas por ${esc(fmtEffort(total - cap))}</span>` : total ? ` · te sobran ${esc(fmtEffort(cap - total))}` : '');
    $('dpBar').style.width = Math.min(100, Math.round(total / cap * 100)) + '%';
    $('dpBar').classList.toggle('over', total > cap);
  };
  document.querySelectorAll('.dp-check, .dp-eff, #dpCap').forEach(el => el.addEventListener('input', recompute));
  $('dpSuggest').addEventListener('click', () => {
    let left = capacity();
    rowsEl.forEach(r => { const m = minutes(r); const take = m <= left || left === capacity(); r.querySelector('.dp-check').checked = take; if (take) left -= m; });
    recompute();
  });
  $('dpCancel').addEventListener('click', closeModal);
  $('dpWeek').addEventListener('click', () => { closeModal(); openWeekPlanner(); });
  $('dpSave').addEventListener('click', async () => {
    if (capacity() !== Math.round(parseFloat((dayCap / 60).toFixed(1)) * 60)) Capacity.set(capacity());       // solo si la persona cambió el tiempo: el valor de partida ya descuenta las reuniones de hoy
    let n = 0, total = 0;
    await dbWrite(async () => {
      for (const r of rowsEl) {
        const id = +r.dataset.id, t = list.find(x => x.id === id), on = r.querySelector('.dp-check').checked;
        const typed = +r.querySelector('.dp-eff').value || null;
        if (typed !== (t.effort || null)) await Tasks.setEffort(id, typed);
        if (on) { n++; total += typed || DEFAULT_MIN; if (t.planDate !== todayISO && !t.planned) await Tasks.setPlan(id, todayISO); }
        else if (t.planDate) await Tasks.setPlan(id, null);
      }
    });
    closeModal();
    showToast(n ? `Mi día listo: ${n} tarea${n === 1 ? '' : 's'} · ${fmtEffort(total)}` : 'Día sin tareas planificadas', 'success');
    if (App.view === 'dashboard') renderToday();
    updateBadges();
  });
  recompute();
}

// ==============================================================
//  2) INFORME DE AVANCE
// ==============================================================
const _isoDay = v => v ? localDateISO(new Date(v)) : null;                // instante UTC → día local
const _inRange = (day, from, to) => !!day && day >= from && day <= to;

function reportPresets(now = new Date()) {
  const d0 = new Date(now); d0.setHours(12, 0, 0, 0);
  const iso = d => localDateISO(d);
  const mon = new Date(d0); mon.setDate(d0.getDate() - ((d0.getDay() + 6) % 7));
  const lastMon = new Date(mon); lastMon.setDate(mon.getDate() - 7);
  const lastSun = new Date(mon); lastSun.setDate(mon.getDate() - 1);
  const m0 = new Date(d0.getFullYear(), d0.getMonth(), 1, 12), pm0 = new Date(d0.getFullYear(), d0.getMonth() - 1, 1, 12), pm1 = new Date(d0.getFullYear(), d0.getMonth(), 0, 12);
  const back = new Date(d0); back.setDate(d0.getDate() - 89);
  const back30 = new Date(d0); back30.setDate(d0.getDate() - 29);
  return {
    week:      { label: 'Esta semana',    from: iso(mon),      to: iso(d0) },
    lastWeek:  { label: 'Semana pasada',  from: iso(lastMon),  to: iso(lastSun) },
    month:     { label: 'Este mes',       from: iso(m0),       to: iso(d0) },
    lastMonth: { label: 'Mes pasado',     from: iso(pm0),      to: iso(pm1) },
    last30:    { label: 'Últimos 30 días', from: iso(back30),  to: iso(d0) },
    quarter:   { label: 'Últimos 90 días', from: iso(back),    to: iso(d0) },
    year:      { label: 'Este año',       from: `${d0.getFullYear()}-01-01`, to: iso(d0) },
  };
}

/** Periodo con el que abre el informe: el mes en curso, salvo la primera semana del mes (el día 1 «este mes» es un solo día y el informe saldría vacío). */
const reportDefaultKey = (now = new Date()) => now.getDate() <= 7 ? 'last30' : 'month';

/** Reúne lo logrado entre dos fechas (ambas incluidas). No toca la interfaz. */
async function buildReport(from, to) {
  await refreshColumnFlags();
  const [tasks, projects, meetings, refs, ideas, snippets] = await Promise.all([
    db.tasks.toArray(), db.projects.toArray(), db.meetings.toArray(), db.references.toArray(), db.ideas.toArray(), db.snippets.toArray()]);
  const proj = Object.fromEntries(projects.map(p => [p.id, p]));
  const today = localDateISO();

  const doneTasks = tasks.filter(t => t.done && _inRange(_isoDay(t.doneAt), from, to))
    .map(t => ({ title: t.title, project: proj[t.projectId]?.title || '', day: _isoDay(t.doneAt) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const actions = meetings.flatMap(m => (m.actionItems || []).filter(a => a.done && _inRange(_isoDay(a.doneAt), from, to))
    .map(a => ({ title: a.text, project: proj[m.projectId]?.title || '', meeting: m.title, day: _isoDay(a.doneAt) })));
  const held = meetings.filter(m => _inRange(m.date, from, to < today ? to : today))
    .map(m => ({ title: m.title, project: proj[m.projectId]?.title || '', day: m.date })).sort((a, b) => a.day.localeCompare(b.day));
  const submitted = projects.filter(p => _inRange(p.submittedAt, from, to))
    .map(p => ({ title: p.title, venue: p.targetVenue || '', day: p.submittedAt })).sort((a, b) => a.day.localeCompare(b.day));
  const read = refs.filter(r => r.readStatus === 'read' && _inRange(_isoDay(r.readAt), from, to))
    .map(r => ({ title: r.title, authors: String(r.authors || '').split(/[;,]/)[0].trim(), year: r.year, day: _isoDay(r.readAt) }));
  const finished = projects.filter(p => (p.columnHistory || []).some(h => App._colFlags.doneIds.has(h.colId) && _inRange(_isoDay(h.enteredAt), from, to)))
    .map(p => ({ title: p.title, type: p.type, day: _isoDay((p.columnHistory || []).filter(h => App._colFlags.doneIds.has(h.colId)).map(h => h.enteredAt).sort().pop()) }));
  const newIdeas = ideas.filter(i => _inRange(_isoDay(i.createdAt), from, to)).length;
  const newSnippets = snippets.filter(s => _inRange(_isoDay(s.createdAt), from, to)).length;
  return { from, to, tasks: doneTasks, actions, meetings: held, submitted, read, finished, newIdeas, newSnippets,
           total: doneTasks.length + actions.length };
}

const _dm = iso => new Date(iso + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
const _range = (a, b) => a === b ? new Date(a + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
  : `${new Date(a + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'long' })} al ${new Date(b + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })}`;

function reportMarkdown(r) {
  const out = [`# Informe de avance — ${_range(r.from, r.to)}`, ''];
  const sum = [];
  if (r.tasks.length + r.actions.length) sum.push(`${r.tasks.length + r.actions.length} tarea${r.tasks.length + r.actions.length === 1 ? '' : 's'} completada${r.tasks.length + r.actions.length === 1 ? '' : 's'}`);
  if (r.finished.length) sum.push(`${r.finished.length} proyecto${r.finished.length === 1 ? '' : 's'} terminado${r.finished.length === 1 ? '' : 's'}`);
  if (r.submitted.length) sum.push(`${r.submitted.length} envío${r.submitted.length === 1 ? '' : 's'}`);
  if (r.meetings.length) sum.push(`${r.meetings.length} ${r.meetings.length === 1 ? 'reunión' : 'reuniones'}`);
  if (r.read.length) sum.push(`${r.read.length} lectura${r.read.length === 1 ? '' : 's'}`);
  if (r.newIdeas) sum.push(`${r.newIdeas} idea${r.newIdeas === 1 ? '' : 's'} nueva${r.newIdeas === 1 ? '' : 's'}`);
  out.push(sum.length ? `**Resumen:** ${sum.join(' · ')}.` : '_Sin actividad registrada en este periodo._', '');
  const section = (title, lines) => { if (lines.length) out.push(`## ${title}`, ...lines, ''); };
  section('Proyectos terminados', r.finished.map(p => `- ${p.title}${p.type ? ` (${p.type})` : ''} — ${_dm(p.day)}`));
  section('Envíos', r.submitted.map(p => `- ${p.title}${p.venue ? ` → ${p.venue}` : ''} — ${_dm(p.day)}`));
  const byProject = new Map();
  for (const t of [...r.tasks, ...r.actions]) { const k = t.project || 'Sin proyecto'; (byProject.get(k) || byProject.set(k, []).get(k)).push(t); }
  if (byProject.size) {
    out.push('## Tareas completadas');
    for (const [k, list] of [...byProject].sort((a, b) => b[1].length - a[1].length)) out.push(`### ${k}`, ...list.map(t => `- [x] ${t.title} — ${_dm(t.day)}`), '');
  }
  section('Reuniones', r.meetings.map(m => `- ${m.title}${m.project ? ` (${m.project})` : ''} — ${_dm(m.day)}`));
  section('Lecturas', r.read.map(x => `- ${x.authors ? x.authors + (x.year ? ` (${x.year})` : '') + '. ' : ''}${x.title}`));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function renderReport() {
  const presets = reportPresets();
  const defKey = reportDefaultKey();
  App._report = App._report || { key: defKey, from: presets[defKey].from, to: presets[defKey].to };
  const st = App._report;
  const r = await buildReport(st.from, st.to);
  const tile = (n, label) => `<div class="rp-tile"><div class="rp-n">${n}</div><div class="rp-l">${label}</div></div>`;
  const list = (title, rows, fmt) => rows.length ? `<section class="rp-sec"><h2 class="rp-h">${title} <span class="today-count">${rows.length}</span></h2>${rows.map(fmt).join('')}</section>` : '';
  const row = (text, meta) => `<div class="rp-row"><span>${esc(text)}</span><span class="rp-meta">${esc(meta || '')}</span></div>`;
  const doneAll = [...r.tasks, ...r.actions].sort((a, b) => a.day.localeCompare(b.day));
  mainContent.innerHTML = `
    <div class="view report-view">
      <div class="view-header">
        <div><h1 class="view-title">Informe de avance</h1>
          <div class="view-subtitle">${esc(_range(st.from, st.to))} — lo que lograste, listo para tu informe, tu CV o tu jefe</div></div>
        <div class="view-actions">
          <button class="btn btn-ghost btn-sm" id="rpCopy">Copiar Markdown</button>
          <button class="btn btn-primary btn-sm" id="rpDownload">Descargar .md</button>
        </div>
      </div>
      <div class="rp-controls">
        <div class="rp-chips" role="group" aria-label="Periodo">
          ${Object.entries(presets).map(([k, p]) => `<button class="read-chip ${st.key === k ? 'active' : ''}" data-rp="${k}">${p.label}</button>`).join('')}
        </div>
        <label class="rp-date">Desde <input class="form-input" type="date" id="rpFrom" value="${st.from}"></label>
        <label class="rp-date">hasta <input class="form-input" type="date" id="rpTo" value="${st.to}"></label>
      </div>
      <div class="rp-tiles">
        ${tile(doneAll.length, 'tareas completadas')}${tile(r.finished.length, 'proyectos terminados')}${tile(r.submitted.length, 'envíos')}
        ${tile(r.meetings.length, 'reuniones')}${tile(r.read.length, 'lecturas')}${tile(r.newIdeas, 'ideas nuevas')}
      </div>
      ${!doneAll.length && !r.finished.length && !r.submitted.length && !r.meetings.length && !r.read.length
        ? '<div class="empty-state"><span class="empty-state-icon">∅</span><h3>Sin actividad en este periodo</h3><p>Completa tareas, marca lecturas como leídas o registra reuniones y aparecerán aquí.</p></div>' : ''}
      ${list('Proyectos terminados', r.finished, p => row(p.title, `${p.type || ''} · ${_dm(p.day)}`))}
      ${list('Envíos', r.submitted, p => row(p.title, `${p.venue ? p.venue + ' · ' : ''}${_dm(p.day)}`))}
      ${list('Tareas completadas', doneAll, t => row(t.title, `${t.project ? t.project + ' · ' : ''}${_dm(t.day)}`))}
      ${list('Reuniones', r.meetings, m => row(m.title, `${m.project ? m.project + ' · ' : ''}${_dm(m.day)}`))}
      ${list('Lecturas', r.read, x => row(x.title, `${x.authors}${x.year ? ' ' + x.year : ''}`))}
    </div>`;
  const md = reportMarkdown(r);
  const setRange = (key, from, to) => { App._report = { key, from, to }; renderReport(); };
  mainContent.querySelectorAll('[data-rp]').forEach(b => b.addEventListener('click', () => setRange(b.dataset.rp, presets[b.dataset.rp].from, presets[b.dataset.rp].to)));
  const custom = () => { const a = $('rpFrom').value, b = $('rpTo').value; if (a && b && a <= b) setRange('custom', a, b); };
  $('rpFrom').addEventListener('change', custom); $('rpTo').addEventListener('change', custom);
  $('rpCopy').addEventListener('click', () => copyText(md, 'Informe copiado ✓'));
  $('rpDownload').addEventListener('click', () => { downloadFile(`informe-avance-${st.from}_${st.to}.md`, md, 'text/markdown'); showToast('Informe descargado', 'success'); });
  mainContent.dataset.view = 'report';
}

// ==============================================================
//  3) RECORDATORIO DIARIO (Notification API; la app debe estar abierta)
// ==============================================================
const Reminders = {
  KEY: 'ros-remind',
  get() { try { return { on: false, time: '08:30', ...JSON.parse(localStorage.getItem(Reminders.KEY) || '{}') }; } catch { return { on: false, time: '08:30' }; } },
  set(v) { try { localStorage.setItem(Reminders.KEY, JSON.stringify({ ...Reminders.get(), ...v })); } catch {} },
  supported: () => typeof Notification !== 'undefined',
  async enable(time) {
    if (!Reminders.supported()) return false;
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') return false;
    Reminders.set({ on: true, time: time || Reminders.get().time });
    Reminders.check();
    return true;
  },
  disable() { Reminders.set({ on: false }); },
  /** Texto del aviso de hoy: tareas del día y atrasadas (sin tocar la interfaz). */
  async summary() {
    const todayISO = localDateISO();
    const tasks = (await db.tasks.toArray()).filter(t => !t.done && !Me.waiting(t.assigneeId));
    const planned = tasks.filter(t => t.planDate && t.planDate <= todayISO);
    const due = tasks.filter(t => t.due && t.due <= todayISO && !(t.planDate && t.planDate <= todayISO));
    const late = tasks.filter(t => t.due && t.due < todayISO);
    if (!planned.length && !due.length) return null;
    const first = [...planned, ...due][0].title;
    return { title: 'ResearchOS · hoy', body: `${planned.length + due.length} por hacer${late.length ? ` (${late.length} atrasada${late.length > 1 ? 's' : ''})` : ''} — empieza por «${first}»` };
  },
  async check(now = new Date()) {
    const cfg = Reminders.get();
    if (!cfg.on || !Reminders.supported() || Notification.permission !== 'granted') return false;
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todayISO = localDateISO(now);
    let last = null; try { last = localStorage.getItem('ros-remind-last'); } catch {}
    if (hhmm < cfg.time || last === todayISO) return false;
    const s = await Reminders.summary();
    try { localStorage.setItem('ros-remind-last', todayISO); } catch {}
    if (!s) return false;
    try { new Notification(s.title, { body: s.body, tag: 'ros-daily' }); } catch { return false; }
    return true;
  },
  start() { Reminders.check(); setInterval(() => Reminders.check(), 60000); },
};
window.addEventListener('load', () => setTimeout(() => Reminders.start(), 4000));

/** Sección de ajustes: capacidad diaria y recordatorio. La llama enhanceSettings (integrations.js). */
function plannerSettingsHTML() {
  const cfg = Reminders.get();
  return `
    <div class="settings-section" id="plannerSection">
      <div class="settings-section-title">☀ Planificación y recordatorios</div>
      <div class="settings-body">
        <div class="settings-row">
          <div><div class="settings-row-label">Tiempo disponible por día</div>
            <div class="settings-row-desc">Es el techo de «Mi día»: si planificas más, la app te avisa de cuánto te pasas.</div></div>
          <div class="settings-row-actions"><input class="form-input" type="number" id="setCapacity" min="1" max="16" step="0.5" value="${(Capacity.get() / 60).toFixed(1).replace(/\.0$/, '')}" style="width:80px"> h</div>
        </div>
        <div class="settings-row">
          <div><div class="settings-row-label">Recordatorio diario</div>
            <div class="settings-row-desc">${Reminders.supported() ? 'Un aviso del navegador con lo que toca hoy. Funciona mientras la app esté abierta (también instalada como app).' : 'Tu navegador no admite notificaciones.'}</div></div>
          <div class="settings-row-actions"><label class="net-toggle"><input type="checkbox" id="setRemindOn" ${cfg.on && Reminders.supported() && Notification.permission === 'granted' ? 'checked' : ''} ${Reminders.supported() ? '' : 'disabled'}> activo</label>
            <input class="form-input" type="time" id="setRemindTime" value="${esc(cfg.time)}" style="width:110px"></div>
        </div>
      </div>
    </div>`;
}
function wirePlannerSettings() {
  $('setCapacity')?.addEventListener('change', e => { Capacity.set((parseFloat(e.target.value) || 6) * 60); showToast('Tiempo diario guardado', 'success'); });
  $('setRemindTime')?.addEventListener('change', e => { Reminders.set({ time: e.target.value || '08:30' }); });
  $('setRemindOn')?.addEventListener('change', async e => {
    if (e.target.checked) {
      const ok = await Reminders.enable($('setRemindTime').value);
      if (!ok) { e.target.checked = false; showToast('El navegador no concedió permiso para notificar', 'error'); }
      else showToast('Recordatorio activado', 'success');
    } else { Reminders.disable(); showToast('Recordatorio desactivado', 'info'); }
  });
}
