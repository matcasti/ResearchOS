// ============================================================
//  ResearchOS — Vida académica: relación con personas, docencia, manuscritos y migración desde otras herramientas
//
//  · Seguimiento de personas: último contacto, cadencia («cada 2 semanas» con tu tesista) y agenda por correo.
//  · Docencia: generador de clases (días de la semana → reuniones) y evaluaciones con su tarea de corrección.
//  · Manuscritos: respuesta a revisores (una tarea por comentario + plantilla de carta).
//  · Importar tareas desde CSV (Todoist, Notion, Excel).
// ============================================================

'use strict';

// ==============================================================
//  1) SEGUIMIENTO DE PERSONAS
// ==============================================================
const FOLLOW_OPTIONS = [[0, 'Sin seguimiento'], [7, 'Cada semana'], [14, 'Cada 2 semanas'], [30, 'Cada mes'], [90, 'Cada 3 meses'], [180, 'Cada 6 meses']];

/** Último día en que hablaste con la persona: contacto registrado a mano o última reunión (ya ocurrida) donde participó. */
function lastContactOf(c, meetings = [], today = localDateISO()) {
  let best = c.lastContact || null, via = c.lastContact ? 'contacto' : null;
  for (const m of meetings) {
    if (!m.date || m.date > today) continue;
    if (String(m.participants || '').split(/[,;]/).some(n => sameName(n, c.name)) && (!best || m.date > best)) { best = m.date; via = `reunión «${m.title}»`; }
  }
  return best ? { date: best, via } : null;
}

/** Personas a las que toca escribir: con cadencia definida, no pospuestas y con el plazo vencido. */
async function followUps(todayISO = localDateISO()) {
  const [people, meetings] = await Promise.all([db.collaborators.toArray(), db.meetings.toArray()]);
  const out = [];
  for (const c of people) {
    if (!c.followUpDays) continue;
    if (c.followSnoozeUntil && c.followSnoozeUntil > todayISO) continue;
    const last = lastContactOf(c, meetings, todayISO);
    const since = last ? Math.round((new Date(todayISO + 'T12:00:00') - new Date(last.date + 'T12:00:00')) / 86400000)
                       : Math.round((new Date(todayISO + 'T12:00:00') - new Date(String(c.createdAt || todayISO).slice(0, 10) + 'T12:00:00')) / 86400000);
    if (since >= c.followUpDays) out.push({ collab: c, last, since, over: since - c.followUpDays });
  }
  return out.sort((a, b) => b.over - a.over);
}

async function mailtoFor(c) {
  const email = String(c.email || '').trim();
  if (!/^[^\s@<>"?&]+@[^\s@<>"?&]+$/.test(email)) return null;               // sin «?» ni «&»: nadie añade destinatarios u otros campos
  let body = await agendaTextFor(c);
  if (body.length > 1700) body = body.slice(0, 1700) + '…';
  return `mailto:${encodeURIComponent(email).replace('%40', '@')}?subject=${encodeURIComponent('Agenda · ' + c.name.split(' ')[0])}&body=${encodeURIComponent(body)}`;
}

async function registerContact(id, date = localDateISO()) {
  await dbWrite(() => db.collaborators.update(id, { lastContact: date, followSnoozeUntil: null }));
}

async function renderFollowUps(host) {
  if (!host) return;
  const list = await followUps();
  if (!list.length) { host.innerHTML = ''; return; }
  const rows = await Promise.all(list.slice(0, 5).map(async f => ({ ...f, mail: await mailtoFor(f.collab) })));
  host.innerHTML = `
    <section class="today-sec calm followup" data-sec="followup" aria-labelledby="ts-follow">
      <h2 class="today-sec-title" id="ts-follow">Seguimiento de personas <span class="today-count">${list.length}</span></h2>
      <div class="today-wait-note">Hace tiempo que no hablas con ellas. Escribir un correo breve basta para no perder el hilo.</div>
      ${rows.map(f => `
        <div class="fu-row" data-fu="${f.collab.id}">
          <span class="fu-name" data-fu-open>${esc(f.collab.name)}</span>
          <span class="fu-since">${f.last ? `hace ${f.since} d` : 'sin contacto registrado'} · cada ${f.collab.followUpDays} d</span>
          ${f.mail ? `<a class="fu-btn" href="${esc(f.mail)}" data-fu-act="mail" title="Escribir un correo con la agenda">✉ Escribir</a>` : ''}
          <button class="fu-btn" data-fu-act="done" title="Marcar como contactado hoy">✓ Contactado</button>
          <button class="fu-btn" data-fu-act="snooze" title="Recordármelo en una semana">⏸ 1 sem</button>
        </div>`).join('')}
      ${list.length > 5 ? `<div class="today-empty">…y ${list.length - 5} más</div>` : ''}
    </section>`;
  host.querySelectorAll('.fu-row').forEach(row => {
    const id = +row.dataset.fu;
    row.querySelector('[data-fu-open]').addEventListener('click', () => inspectCollaborator(id));
    row.querySelector('[data-fu-act="done"]').addEventListener('click', async () => { await registerContact(id); showToast('Contacto registrado ✓', 'success'); renderFollowUps(host); updateBadges(); });
    row.querySelector('[data-fu-act="snooze"]').addEventListener('click', async () => {
      await dbWrite(() => db.collaborators.update(id, { followSnoozeUntil: addDaysISO(7) })); showToast('Te lo recuerdo en una semana', 'info'); renderFollowUps(host);
    });
    row.querySelector('[data-fu-act="mail"]')?.addEventListener('click', () => { setTimeout(() => registerContact(id).then(() => renderFollowUps(host)), 800); });
  });
}

/** Añade al inspector de una persona: último contacto, cadencia, registrar contacto y correo con la agenda. */
async function enhanceCollaboratorInspector(c) {
  const actions = inspectorBody.querySelector('.inspector-actions');
  if (!actions) return;
  const meetings = await db.meetings.toArray();
  const last = lastContactOf(c, meetings);
  const mail = await mailtoFor(c);
  const box = document.createElement('div');
  box.id = 'collabRelation';
  box.innerHTML = `
    <div class="inspector-related-title">Relación</div>
    <div class="inspector-meta-row"><span class="inspector-meta-key">Último contacto</span>
      <span class="inspector-meta-val" id="collabLast">${last ? `${esc(formatDate(last.date))} · ${esc(relativeDate(last.date + 'T12:00:00'))} <span class="tw-sub">(${esc(last.via)})</span>` : 'sin registro'}</span></div>
    <div class="inspector-meta-row"><span class="inspector-meta-key">Seguimiento</span>
      <span class="inspector-meta-val"><select class="form-input" id="collabFollow" aria-label="Cadencia de seguimiento" style="padding:2px 6px;font-size:.78rem">
        ${FOLLOW_OPTIONS.map(([d, l]) => `<option value="${d}" ${(c.followUpDays || 0) === d ? 'selected' : ''}>${l}</option>`).join('')}</select></span></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
      <button class="btn btn-ghost btn-sm" id="collabContactBtn">✓ Registrar contacto hoy</button>
      ${mail ? `<a class="btn btn-ghost btn-sm" id="collabMailBtn" href="${esc(mail)}">✉ Escribir con la agenda</a>` : ''}
    </div>`;
  actions.parentNode.insertBefore(box, actions);
  $('collabFollow').addEventListener('change', async e => {
    await dbWrite(() => db.collaborators.update(c.id, { followUpDays: +e.target.value || null, followSnoozeUntil: null }));
    showToast(+e.target.value ? 'Seguimiento activado: aparecerá en Hoy cuando toque' : 'Seguimiento desactivado', 'success');
  });
  $('collabContactBtn').addEventListener('click', async () => { await registerContact(c.id); showToast('Contacto registrado ✓', 'success'); inspectCollaborator(c.id); });
}

// ==============================================================
//  2) DOCENCIA: clases y evaluaciones
// ==============================================================
/** Fechas ISO entre `from` y `to` (inclusive) en los días de la semana dados (0=domingo…6=sábado), salvo las de `skip`. */
function generateClassDates({ weekdays, from, to, skip = [] }) {
  const out = [], skipSet = new Set(skip);
  if (!isoDateOrNull(from) || !isoDateOrNull(to) || !weekdays?.length || from > to) return out;
  for (let d = new Date(from + 'T12:00:00'); localDateISO(d) <= to && out.length < 200; d.setDate(d.getDate() + 1)) {
    const iso = localDateISO(d);
    if (weekdays.includes(d.getDay()) && !skipSet.has(iso)) out.push(iso);
  }
  return out;
}
/** «2026-11-02, 16/11, 20-12-2026» → fechas ISO (los «dd/mm» sin año usan `year`). */
function parseSkipDates(text, year = new Date().getFullYear()) {
  return String(text || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean).map(s => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isoDateOrNull(s);
    const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/);
    if (!m) return null;
    const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : year;
    return isoDateOrNull(`${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`);
  }).filter(Boolean);
}

async function showClassGenerator(projectId) {
  const p = await db.projects.get(projectId);
  if (!p) return;
  const start = nextWeekdayISO(1), end = p.deadline && p.deadline > start ? p.deadline : addDaysISO(16 * 7 + 6);
  const DAYS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb']];
  showModal('📅 Generar clases', `
    <div class="modal-body">
      <p class="form-hint" style="margin-bottom:10px">Crea una reunión por cada clase en «${esc(p.title)}»: aparecen en el calendario y en Hoy, y ahí anotas el contenido y los acuerdos.</p>
      <div class="form-group"><label class="form-label">Días de clase</label>
        <div class="gc-days">${DAYS.map(([n, l]) => `<label class="gc-day"><input type="checkbox" value="${n}" ${n === 1 || n === 3 ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
      <div class="form-group" style="display:flex;gap:10px">
        <div style="flex:1"><label class="form-label">Primera clase (desde)</label><input class="form-input" type="date" id="gc-from" value="${start}"></div>
        <div style="flex:1"><label class="form-label">Última clase (hasta)</label><input class="form-input" type="date" id="gc-to" value="${end}"></div>
      </div>
      <div class="form-group"><label class="form-label">Título (usa {n} para el número)</label>
        <input class="form-input" id="gc-title" value="Clase {n} — ${esc(p.title.slice(0, 40))}"></div>
      <div class="form-group"><label class="form-label">Sin clases (feriados, semana de receso)</label>
        <input class="form-input" id="gc-skip" placeholder="2026-11-02, 16/11, 20/12"></div>
      <div class="form-hint" id="gc-count" aria-live="polite"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-ghost" id="gcCancel">Cancelar</button><button class="btn btn-primary" id="gcSave">Crear clases</button></div>`);
  const compute = () => generateClassDates({
    weekdays: [...document.querySelectorAll('.gc-day input:checked')].map(i => +i.value),
    from: $('gc-from').value, to: $('gc-to').value, skip: parseSkipDates($('gc-skip').value, +($('gc-from').value || start).slice(0, 4)) });
  const refresh = () => {
    const dates = compute();
    $('gc-count').textContent = dates.length ? `${dates.length} clase${dates.length === 1 ? '' : 's'}: ${formatDate(dates[0])} → ${formatDate(dates[dates.length - 1])}` : 'Elige al menos un día y un rango válido.';
    $('gcSave').disabled = !dates.length;
  };
  document.querySelectorAll('#modalContent input').forEach(i => i.addEventListener('input', refresh));
  refresh();
  $('gcCancel').addEventListener('click', closeModal);
  $('gcSave').addEventListener('click', async () => {
    const dates = compute();
    const pattern = $('gc-title').value.trim() || 'Clase {n}';
    const have = new Set((await db.meetings.where('projectId').equals(projectId).toArray()).map(m => `${m.date}|${m.kind || ''}`));
    const now = new Date().toISOString();
    const fresh = dates.map((date, i) => ({ title: pattern.replace('{n}', i + 1), date, kind: 'class', participants: '', projectId, agreements: '', actionItems: [], createdAt: now, updatedAt: now }))
      .filter(m => !have.has(`${m.date}|class`));
    await dbWrite(() => db.meetings.bulkAdd(fresh));
    closeModal();
    showToast(fresh.length ? `${fresh.length} clase${fresh.length === 1 ? '' : 's'} creada${fresh.length === 1 ? '' : 's'} ✓` : 'Esas clases ya existían', fresh.length ? 'success' : 'info');
    renderView(App.view); inspectProject(projectId);
  });
}

async function showEvaluationModal(projectId) {
  const p = await db.projects.get(projectId);
  if (!p) return;
  showModal('📝 Nueva evaluación', `
    <div class="modal-body">
      <div class="form-group"><label class="form-label">Evaluación *</label><input class="form-input" id="ev-name" value="Prueba 1" maxlength="80"></div>
      <div class="form-group" style="display:flex;gap:10px">
        <div style="flex:1"><label class="form-label">Fecha de la evaluación *</label><input class="form-input" type="date" id="ev-date" value="${addDaysISO(14)}"></div>
        <div style="flex:1"><label class="form-label">Entregar notas en (días)</label><input class="form-input" type="number" id="ev-days" min="1" max="60" value="7"></div>
        <div style="flex:1"><label class="form-label">Corregir (horas)</label><input class="form-input" type="number" id="ev-hours" min="0.5" max="40" step="0.5" value="3"></div>
      </div>
      <div class="form-hint">Crea dos tareas en «${esc(p.title)}»: la evaluación y su corrección con el tiempo estimado, para que entre en tu día.</div>
    </div>
    <div class="modal-footer"><button class="btn btn-ghost" id="evCancel">Cancelar</button><button class="btn btn-primary" id="evSave">Crear</button></div>`);
  focusField($('ev-name'), { select: true });
  $('evCancel').addEventListener('click', closeModal);
  $('evSave').addEventListener('click', async () => {
    const name = $('ev-name').value.trim(), date = isoDateOrNull($('ev-date').value);
    if (!name || !date) return showToast('Indica el nombre y la fecha', 'error');
    const days = Math.max(1, +$('ev-days').value || 7), hours = Math.max(0.5, +$('ev-hours').value || 3);
    const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + days);
    await dbWrite(async () => {
      await Tasks.add({ title: `Evaluación: ${name}`, due: date, projectId, priority: 'Alta' });
      await Tasks.add({ title: `Corregir ${name} y subir notas`, due: localDateISO(d), projectId, priority: 'Alta', effort: Math.round(hours * 60) });
    });
    closeModal(); showToast('Evaluación y corrección creadas ✓', 'success');
    renderView(App.view); inspectProject(projectId);
  });
}

// ==============================================================
//  3) MANUSCRITOS: respuesta a revisores
// ==============================================================
/** Divide el texto de una revisión en comentarios: por numeración («1.», «R2:», «Comment 3»), viñetas o párrafos. */
function parseReviewerComments(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const startRe = /^\s*(?:(?:comentario|comment|point|punto|observaci[oó]n|major|minor)\s*)?(?:R\d+[.\d]*\s*[.):-]?|\d+[.)]|\(\d+\)|[-•*]|#\d+)\s+/i;
  const hasMarkers = lines.some(l => startRe.test(l));
  const out = [];
  if (hasMarkers) {
    let cur = null;
    for (const l of lines) {
      if (startRe.test(l)) { if (cur) out.push(cur); cur = l.replace(startRe, '').trim(); }
      else if (cur !== null && l.trim()) cur += ' ' + l.trim();
    }
    if (cur) out.push(cur);
  } else {
    for (const para of String(text || '').replace(/\r/g, '').split(/\n\s*\n/)) { const t = para.replace(/\s+/g, ' ').trim(); if (t) out.push(t); }
  }
  return out.map(s => s.trim()).filter(s => s.length > 2);
}
function reviewerResponseMarkdown(comments, title = '') {
  const out = [`# Respuesta a los revisores${title ? ' — ' + title : ''}`, '', 'Agradecemos los comentarios. A continuación respondemos punto por punto (los cambios aparecen resaltados en el manuscrito).', ''];
  comments.forEach((c, i) => out.push(`## Comentario ${i + 1}`, `> ${c}`, '', '**Respuesta:** ', '', '**Cambio en el manuscrito:** ', ''));
  return out.join('\n');
}

function showReviewerResponseModal(projectId) {
  showModal('↩ Responder a revisores', `
    <div class="modal-body">
      <p class="form-hint" style="margin-bottom:8px">Pega los comentarios del editor o los revisores. Se separan por numeración, viñetas o párrafos.</p>
      <textarea class="form-textarea" id="rv-text" rows="9" placeholder="1. The sample size is too small…&#10;2. Please clarify the model selection…"></textarea>
      <div class="form-group" style="display:flex;gap:10px;margin-top:10px;align-items:end">
        <div style="flex:1"><label class="form-label">Fecha de reenvío</label><input class="form-input" type="date" id="rv-due" value="${addDaysISO(21)}"></div>
        <div class="form-hint" id="rv-count" style="flex:1" aria-live="polite">0 comentarios</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="rvCancel">Cancelar</button>
      <button class="btn btn-ghost" id="rvCopy">Copiar plantilla de carta</button>
      <button class="btn btn-primary" id="rvSave" disabled>Crear tareas</button>
    </div>`);
  const comments = () => parseReviewerComments($('rv-text').value);
  $('rv-text').addEventListener('input', () => {
    const n = comments().length;
    $('rv-count').textContent = `${n} comentario${n === 1 ? '' : 's'} detectado${n === 1 ? '' : 's'}`;
    $('rvSave').disabled = !n; $('rvSave').textContent = n ? `Crear ${n} tarea${n === 1 ? '' : 's'}` : 'Crear tareas';
  });
  focusField($('rv-text'));
  $('rvCancel').addEventListener('click', closeModal);
  $('rvCopy').addEventListener('click', async () => {
    const p = await db.projects.get(projectId);
    const cs = comments();
    if (!cs.length) return showToast('Pega primero los comentarios', 'info');
    try { await navigator.clipboard.writeText(reviewerResponseMarkdown(cs, p?.title)); showToast('Plantilla copiada ✓', 'success'); } catch { showToast('No se pudo copiar', 'error'); }
  });
  $('rvSave').addEventListener('click', async () => {
    const cs = comments(), due = isoDateOrNull($('rv-due').value);
    await dbWrite(async () => {
      for (const [i, c] of cs.entries()) await Tasks.add({ title: `Responder R${i + 1}: ${c.length > 90 ? c.slice(0, 89) + '…' : c}`, due, projectId, priority: 'Alta' });
    });
    closeModal(); showToast(`${cs.length} tarea${cs.length === 1 ? '' : 's'} creada${cs.length === 1 ? '' : 's'} ✓`, 'success');
    renderView(App.view); inspectProject(projectId);
  });
}

/** Botones académicos en el inspector de un proyecto (según su tipo). */
function enhanceProjectInspector(p) {
  const actions = inspectorBody.querySelector('.inspector-actions');
  if (!actions || document.getElementById('acadActions')) return;
  const btns = [];
  if (p.type === 'Curso') btns.push(['acadClasses', '📅 Generar clases', () => showClassGenerator(p.id)], ['acadEval', '📝 + Evaluación', () => showEvaluationModal(p.id)]);
  if (p.type === 'Paper') btns.push(['acadReview', '↩ Responder a revisores', () => showReviewerResponseModal(p.id)]);
  if (!btns.length) return;
  const box = document.createElement('div');
  box.id = 'acadActions';
  box.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:10px 0';
  box.innerHTML = btns.map(([id, label]) => `<button class="btn btn-ghost btn-sm" id="${id}">${label}</button>`).join('');
  actions.parentNode.insertBefore(box, actions);
  for (const [id,, fn] of btns) $(id).addEventListener('click', fn);
}

// ==============================================================
//  4) IMPORTAR TAREAS DESDE CSV (Todoist, Notion, Excel…)
// ==============================================================
/** CSV con comillas y delimitador automático (coma, punto y coma o tabulador). Devuelve filas de celdas. */
function parseCSVTable(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); if (row.some(c => c.trim())) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); if (row.some(c => c.trim())) rows.push(row);
  return rows;
}
const _CSV_COLS = {
  title: ['title', 'titulo', 'tarea', 'task', 'content', 'contenido', 'nombre', 'name', 'summary', 'resumen', 'descripcion'],
  due: ['due', 'due date', 'date', 'fecha', 'fecha limite', 'fecha de vencimiento', 'vencimiento', 'deadline', 'fecha de entrega', 'entrega'],
  project: ['project', 'proyecto'],
  priority: ['priority', 'prioridad'],
  done: ['done', 'status', 'estado', 'completed', 'completado', 'hecho', 'checked'],
  type: ['type'],
};
function _taskCsvDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return isoDateOrNull(`${m[1]}-${m[2]}-${m[3]}`);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/); if (m) return isoDateOrNull(`${+m[3] < 100 ? 2000 + +m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  const t = Date.parse(s + (/\d{4}/.test(s) ? '' : ` ${new Date().getFullYear()}`));
  return Number.isNaN(t) ? null : localDateISO(new Date(t));
}
function _csvPriority(v) {
  const s = foldText(v).trim();
  if (!s) return null;
  if (/^(1|p1|alta|high|urgente|urgent)$/.test(s)) return 'Alta';
  if (/^(2|p2|media|medium|normal)$/.test(s)) return 'Media';
  if (/^(3|p3|baja|low)$/.test(s)) return 'Baja';
  return null;
}
/** Convierte el CSV en tareas. `projects` permite enlazar por nombre; lo que no coincide queda como tarea suelta. */
function tasksFromCSV(text, projects = []) {
  const rows = parseCSVTable(text);
  if (rows.length < 2) return { tasks: [], skipped: 0, columns: {} };
  const header = rows[0].map(h => foldText(h).trim());
  const col = {};
  for (const [k, names] of Object.entries(_CSV_COLS)) { const i = header.findIndex(h => names.includes(h)); if (i >= 0) col[k] = i; }
  if (col.title === undefined) col.title = 0;
  const byTitle = new Map(projects.map(p => [foldText(p.title).trim(), p.id]));
  const tasks = []; let skipped = 0;
  for (const r of rows.slice(1)) {
    if (col.type !== undefined && r[col.type] && !/^task$/i.test(r[col.type].trim())) { skipped++; continue; }   // Todoist: secciones, notas
    const title = String(r[col.title] || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!title) { skipped++; continue; }
    const doneRaw = foldText(r[col.done] || '').trim();
    tasks.push({ title, due: _taskCsvDate(r[col.due]), priority: _csvPriority(r[col.priority]),
      projectId: byTitle.get(foldText(r[col.project] || '').trim()) ?? null,
      projectName: String(r[col.project] || '').trim(),
      done: /^(done|hecho|completed|completado|complete|true|1|si|sí|x|yes)$/.test(doneRaw) });
  }
  return { tasks, skipped, columns: col };
}

function academicSettingsHTML() {
  return `
    <div class="settings-section" id="taskImportSection">
      <div class="settings-section-title">📥 Importar tareas desde otra herramienta</div>
      <div class="settings-body">
        <div class="settings-row">
          <div><div class="settings-row-label">Archivo CSV (Todoist, Notion, Excel…)</div>
            <div class="settings-row-desc">Se reconocen las columnas título, fecha, proyecto, prioridad y estado. Verás una vista previa antes de importar; nada se borra.</div></div>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer">Elegir CSV…<input type="file" id="taskCsvInput" accept=".csv,.tsv,text/csv,text/plain" hidden></label>
        </div>
      </div>
    </div>`;
}
function wireAcademicSettings() {
  $('taskCsvInput')?.addEventListener('change', e => { const file = e.target.files[0]; e.target.value = ''; if (file) startTaskCsvImport(file); });
}

/** Lee un CSV de tareas y abre la vista previa de importación. */
async function startTaskCsvImport(file) {
  const projects = await db.projects.toArray();
  const { tasks, skipped } = tasksFromCSV(await file.text(), projects);
  if (!tasks.length) return showToast('No encontré tareas en ese archivo', 'info');
  const open = tasks.filter(t => !t.done).length, linked = tasks.filter(t => t.projectId).length;
  showModal('📥 Importar tareas', `
    <div class="modal-body">
      <p style="font-size:.85rem;color:var(--text-2)"><strong style="color:var(--text-1)">${tasks.length}</strong> tarea(s): ${open} pendientes, ${tasks.length - open} ya hechas · ${linked} enlazadas a un proyecto por nombre${skipped ? ` · ${skipped} fila(s) omitidas` : ''}.</p>
      <label class="net-toggle" style="margin:8px 0"><input type="checkbox" id="tiDone" checked> Importar también las ya completadas</label>
      <div class="import-preview">${tasks.slice(0, 8).map(t => `<div>${t.done ? '✓ ' : ''}${esc(t.title)}${t.due ? ` · ${esc(formatDate(t.due))}` : ''}${t.projectName ? ` · ${esc(t.projectName)}` : ''}</div>`).join('')}${tasks.length > 8 ? `<div>…y ${tasks.length - 8} más</div>` : ''}</div>
    </div>
    <div class="modal-footer"><button class="btn btn-ghost" id="tiCancel">Cancelar</button><button class="btn btn-primary" id="tiOk">Importar</button></div>`);
  $('tiCancel').addEventListener('click', closeModal);
  $('tiOk').addEventListener('click', async () => {
    const withDone = $('tiDone').checked;
    let n = 0;
    await dbWrite(async () => {
      for (const t of tasks.filter(t => withDone || !t.done)) {
        const id = await Tasks.add({ title: t.title, due: t.due, projectId: t.projectId, priority: t.priority });
        if (id && t.done) await Tasks.setDone(id, true);
        if (id) n++;
      }
    });
    closeModal(); showToast(`${n} tarea(s) importada(s) ✓`, 'success'); updateBadges();
    if (App.view === 'dashboard') renderToday();
  });
}
