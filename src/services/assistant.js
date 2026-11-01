// ============================================================
//  ResearchOS — Asistente de IA (un LLM lee, maneja y actualiza tus pendientes)
//
//  Elegir una carpeta (p. ej. la de Dropbox o una de tu equipo) y la app deja en ella:
//     AGENTS.md / CLAUDE.md  instrucciones para cualquier LLM (qué hay, cómo proponer cambios)
//     estado.json            tus proyectos, tareas, ideas, reuniones y personas, con nombres legibles
//     pendientes.md          lo mismo como agenda en Markdown (atrasado, hoy, próximos días…)
//     cambios/               aquí la IA deja archivos .json con operaciones (añadir, modificar, completar, borrar)
//     resultados/            la app contesta aquí, con el mismo nombre, qué se aplicó y qué falló
//  La app NUNCA ejecuta código de la IA: solo interpreta un conjunto cerrado de operaciones, valida cada campo y,
//  por defecto, te enseña los cambios antes de aplicarlos. Los borrados siempre se revisan.
// ============================================================

'use strict';

const ASST_STATE_FORMAT = 'researchos-state/1';
const ASST_CHANGES_FORMAT = 'researchos-changes/1';
const ASST_MARK = '<!-- researchos-asistente -->';
const ASST_MAX_OPS = 200;

// -- referencias por uid (completo o prefijo de 8+) o por nombre ---------------------------------------------------------------
function _asstFind(rows, ref, labelOf, what) {
  const q = String(ref ?? '').trim();
  if (!q) throw new Error(`falta ${what}`);
  const byUid = rows.filter(r => r.uid === q || (q.length >= 8 && String(r.uid || '').startsWith(q)));
  if (byUid.length === 1) return byUid[0];
  if (byUid.length > 1) throw new Error(`«${q}» es ambiguo (${byUid.length} uid empiezan así)`);
  const f = foldText(q);
  const exact = rows.filter(r => foldText(labelOf(r)) === f);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`hay ${exact.length} ${what} llamados «${q}»: usa su uid`);
  const part = rows.filter(r => foldText(labelOf(r)).includes(f));
  if (part.length === 1) return part[0];
  throw new Error(part.length ? `«${q}» coincide con ${part.length} ${what}: usa su uid o el nombre completo` : `no existe ${what} «${q}»`);
}
const _asstEmpty = v => v === null || v === undefined || v === '';
const _asstDate = v => {
  if (_asstEmpty(v)) return null;
  const d = isoDateOrNull(v);
  if (!d || String(v).length !== 10) throw new Error(`fecha no válida «${v}» (usa AAAA-MM-DD)`);
  return d;
};
const _asstPriority = v => {
  if (_asstEmpty(v)) return null;
  const p = { alta: 'Alta', high: 'Alta', media: 'Media', medium: 'Media', baja: 'Baja', low: 'Baja' }[foldText(String(v))];
  if (!p) throw new Error(`prioridad no válida «${v}» (Alta, Media o Baja)`);
  return p;
};
const _asstText = (v, max, what, { required = false } = {}) => {
  const s = String(v ?? '').trim().slice(0, max);
  if (required && !s) throw new Error(`${what} no puede estar vacío`);
  return s;
};
const _asstTags = v => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map(x => String(x).trim()).filter(Boolean).slice(0, 20);

/** Acceso a las entidades por referencia. Se consulta la BD en cada llamada: un lote puede crear un proyecto y usarlo después. */
const _asstCx = {
  project: async ref => _asstFind(await db.projects.toArray(), ref, p => p.title, 'proyecto'),
  idea:    async ref => _asstFind(await db.ideas.toArray(), ref, i => i.title, 'idea'),
  person:  async ref => _asstFind(await db.collaborators.toArray(), ref, c => c.name, 'persona'),
  column:  async ref => _asstFind(await db.kanbanColumns.toArray(), ref, c => c.title, 'columna'),
  area:    async ref => _asstFind((await _getAreas()).filter(a => a.uid), ref, a => a.name, 'área'),
};
const _asstRef = (key, field, extra = () => ({})) => async v => {
  if (_asstEmpty(v)) return { [field]: null, ...extra(null) };
  const row = await _asstCx[key](v);
  return { [field]: row.id, ...extra(row) };
};

// -- campos admitidos por tipo: cada uno valida y traduce a campos de la base de datos ------------------------------------------
const ASST_FIELDS = {
  task: {
    title:    v => ({ title: _asstText(v, 300, 'title', { required: true }) }),
    done:     v => ({ __done: !!v }),
    due:      v => ({ due: _asstDate(v) }),
    priority: v => ({ priority: _asstPriority(v) }),
    project:  _asstRef('project', 'projectId', () => ({ areaId: null })),
    idea:     _asstRef('idea', 'ideaId', i => ({ __ideaProject: i?.projectId ?? null })),
    assignee: _asstRef('person', 'assigneeId'),
    repeat:   v => {
      if (_asstEmpty(v)) return { recurrence: null };
      const r = Tasks.cleanRecurrence(typeof v === 'string' ? { freq: v, interval: 1 } : v);
      if (!r) throw new Error('repeat no válido: usa {"freq":"daily|weekly|monthly","interval":1,"until":"AAAA-MM-DD"}');
      return { recurrence: r };
    },
    minutes:  v => { if (_asstEmpty(v)) return { effort: null }; const m = Tasks.cleanEffort(v); if (m == null) throw new Error('minutes debe ser un número positivo'); return { effort: m }; },
    planDate: v => ({ planDate: _asstDate(v) }),
    area:     _asstRef('area', 'areaId'),
  },
  idea: {
    title:    v => ({ title: _asstText(v, 300, 'title', { required: true }) }),
    content:  v => ({ content: _asstText(v, 20000, 'content') }),
    status:   v => { if (!['unread', 'reviewed'].includes(v)) throw new Error('status debe ser unread o reviewed'); return { status: v }; },
    tags:     v => ({ tags: _asstTags(v) }),
    project:  _asstRef('project', 'projectId', p => ({ projectIds: p ? [p.id] : [] })),
    deadline: v => ({ deadline: _asstDate(v) }),
    starred:  v => ({ starred: !!v }),
  },
  project: {
    title:       v => ({ title: _asstText(v, 200, 'title', { required: true }) }),
    description: v => ({ description: _asstText(v, 20000, 'description') }),
    type:        v => ({ type: _asstText(v, 40, 'type', { required: true }) }),
    priority:    v => ({ priority: _asstPriority(v) || 'Media' }),
    deadline:    v => ({ deadline: _asstDate(v) }),
    tags:        v => ({ tags: _asstTags(v) }),
    column:      _asstRef('column', 'columnId'),
    responsible: async v => {
      const name = _asstText(v, 120, 'responsible');
      const p = name ? (await db.collaborators.toArray()).find(c => foldText(c.name) === foldText(name)) : null;
      return { responsible: name, responsibleId: p?.id ?? null };
    },
    area:        _asstRef('area', 'areaId'),
    parent:      _asstRef('project', 'parentId'),
    archived:    v => ({ archived: !!v }),
    starred:     v => ({ starred: !!v }),
  },
  meeting: {
    title:        v => ({ title: _asstText(v, 200, 'title', { required: true }) }),
    date:         v => ({ date: _asstDate(v) || localDateISO() }),
    project:      _asstRef('project', 'projectId'),
    participants: v => ({ participants: _asstText(v, 500, 'participants') }),
    agreements:   v => ({ agreements: _asstText(v, 20000, 'agreements') }),
    actionItems:  async v => ({ actionItems: await _asstActionItems(v) }),
    addActionItems: async (v, existing) => ({ actionItems: [...(existing?.actionItems || []), ...await _asstActionItems(v)] }),
  },
  person: {
    name:        v => ({ name: _asstText(v, 120, 'name', { required: true }) }),
    email:       v => ({ email: _asstText(v, 200, 'email') }),
    role:        v => ({ role: _asstText(v, 120, 'role') }),
    affiliation: v => ({ affiliation: _asstText(v, 200, 'affiliation') }),
    notes:       v => ({ notes: _asstText(v, 5000, 'notes') }),
  },
};
async function _asstActionItems(list) {
  if (!Array.isArray(list)) throw new Error('actionItems debe ser una lista de {text, due, assignee, done}');
  const out = [];
  for (const [i, a] of list.entries()) {
    const o = typeof a === 'string' ? { text: a } : a;
    out.push({ id: Date.now() + i, text: _asstText(o?.text, 300, 'text', { required: true }), done: !!o?.done, due: _asstDate(o?.due),
      assigneeId: _asstEmpty(o?.assignee) ? null : (await _asstCx.person(o.assignee)).id, doneAt: o?.done ? new Date().toISOString() : null });
  }
  return out;
}

// Qué operaciones admite cada tipo, su tabla y cómo se nombra
const ASST_TYPES = {
  task:    { table: 'tasks',         noun: 'tarea',    ops: ['add', 'update', 'complete', 'delete'], label: r => r.title },
  idea:    { table: 'ideas',         noun: 'idea',     ops: ['add', 'update', 'delete'],             label: r => r.title },
  project: { table: 'projects',      noun: 'proyecto', ops: ['add', 'update'],                       label: r => r.title },
  meeting: { table: 'meetings',      noun: 'reunión',  ops: ['add', 'update'],                       label: r => r.title },
  person:  { table: 'collaborators', noun: 'persona',  ops: ['add'],                                 label: r => r.name },
};

/** Convierte los campos recibidos en campos de la BD (resolviendo nombres a ids). Lanza un Error legible si algo no vale. */
async function _asstBuild(type, set, existing) {
  const defs = ASST_FIELDS[type], out = {};
  for (const [k, v] of Object.entries(set)) {
    if (!defs[k]) throw new Error(`campo «${k}» no admitido en ${ASST_TYPES[type].noun}. Admitidos: ${Object.keys(defs).join(', ')}`);
    Object.assign(out, await defs[k](v, existing));
  }
  return out;
}

/** Pone en marcha una operación ya validada. Devuelve { uid, undo }. */
async function _asstRun(it) {
  const { type, op } = it, T = ASST_TYPES[type], table = db[T.table], now = new Date().toISOString();
  if (op === 'add') {
    const c = await _asstBuild(type, it.set, null);
    let id;
    if (type === 'task') {
      const { __done, __ideaProject, ...f } = c;
      if (__ideaProject != null && f.projectId === undefined) f.projectId = __ideaProject;
      id = await Tasks.add({ title: f.title, due: f.due, projectId: f.projectId, ideaId: f.ideaId, areaId: f.areaId, priority: f.priority,
        assigneeId: f.assigneeId, recurrence: f.recurrence, effort: f.effort, planDate: f.planDate });
      if (__done) await Tasks.setDone(id, true);
    } else if (type === 'idea') {
      id = await table.add({ title: '', content: '', status: 'unread', projectId: null, projectIds: [], tags: [], subtasks: [], starred: false, deadline: null, createdAt: now, updatedAt: now, ...c });
    } else if (type === 'project') {
      const col = c.columnId ?? (await db.kanbanColumns.orderBy('order').first())?.id ?? null;
      id = await table.add({ status: 'active', archived: false, starred: false, tags: [], coauthors: [], type: 'Proyecto', priority: 'Media', responsible: '', deadline: null, description: '', createdAt: now, updatedAt: now, ...c, columnId: col });
    } else if (type === 'meeting') {
      id = await table.add({ title: '', date: localDateISO(), participants: '', agreements: '', projectId: null, actionItems: [], createdAt: now, updatedAt: now, ...c });
    } else {
      if ((await table.toArray()).some(p => foldText(p.name) === foldText(c.name))) throw new Error(`ya existe la persona «${c.name}»`);
      id = await table.add({ email: '', role: '', affiliation: '', notes: '', createdAt: now, ...c });
    }
    return { uid: (await table.get(id)).uid, undo: () => table.delete(id) };
  }

  const row = await table.get(it.id);
  if (!row) throw new Error(`${T.noun} ya no existe`);
  if (op === 'delete') {
    if (type === 'task') { await Tasks.remove(row.id); return { uid: row.uid, undo: () => table.add(row) }; }
    const undo = await deleteIdeaCascade(row.id);
    return { uid: row.uid, undo };
  }
  // update / complete
  const set = op === 'complete' ? { done: true } : it.set;
  const c = await _asstBuild(type, set, row);
  let spawned = null;
  if (type === 'task') {
    const { __done, __ideaProject } = c;
    delete c.__done; delete c.__ideaProject;
    if (__ideaProject != null && c.projectId === undefined) c.projectId = __ideaProject;
    if (__done !== undefined && __done !== !!row.done) spawned = await Tasks.setDone(row.id, __done);
  }
  const keys = Object.keys(c);
  const before = Object.fromEntries(keys.map(k => [k, row[k]]));
  if (type === 'project' && 'columnId' in c) {
    before.columnHistory = row.columnHistory; before.columnId = row.columnId;
    const { columnId, ...rest } = c;
    await recordColumnChange(row.id, columnId);
    if (Object.keys(rest).length) await table.update(row.id, rest);
  } else if (keys.length) await table.update(row.id, c);
  return {
    uid: row.uid,
    undo: async () => {
      if (spawned) await db.tasks.delete(spawned);
      if (type === 'task' && 'done' in set) await db.tasks.update(row.id, { done: !!row.done, doneAt: row.doneAt ?? null });
      if (Object.keys(before).length) await table.update(row.id, before);
    },
  };
}

const Assistant = {
  KEY: 'assistant-dir-handle',
  paused: false, _busy: false, _dirty: false, _timer: null, _poll: null,
  _queue: [], _handled: new Set(), _hash: '', _md: '',

  supported: () => typeof window.showDirectoryPicker === 'function',
  enabled:   () => localStorage.getItem('ros-assistant') === '1',
  mode:      () => localStorage.getItem('ros-assistant-mode') === 'auto' ? 'auto' : 'review',
  setMode(m) { try { localStorage.setItem('ros-assistant-mode', m === 'auto' ? 'auto' : 'review'); } catch {} },
  lastRun:   () => +localStorage.getItem('ros-assistant-last') || null,
  async handle() { return (await db.settings.get(this.KEY))?.value || null; },
  async permission(h, { ask = false } = {}) {
    const o = { mode: 'readwrite' };
    let p = await h.queryPermission?.(o);
    if (p !== 'granted' && ask) p = await h.requestPermission?.(o);
    return p || 'denied';
  },
  async choose() {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'researchos-assistant' });
    await db.settings.put({ key: this.KEY, value: handle });
    localStorage.setItem('ros-assistant', '1');
    this.paused = false; this._hash = ''; this._md = '';
    return this.syncNow({ ask: true });
  },
  async disable() {
    await db.settings.delete(this.KEY);
    localStorage.removeItem('ros-assistant'); localStorage.removeItem('ros-assistant-last');
    clearInterval(this._poll); clearTimeout(this._timer);
    this._queue = []; this._handled.clear(); this._bar();
    this.paused = false;
  },

  // ---------- lo que la IA lee ----------
  /** Estado para el LLM: nombres en vez de ids, sin campos vacíos. */
  async state() {
    const today = localDateISO(), cut = addDaysISO(-30), recent = new Date(Date.now() - 14 * 86400000).toISOString();
    const [projects, tasks, ideas, meetings, people, columns] = await Promise.all([
      db.projects.toArray(), db.tasks.toArray(), db.ideas.toArray(), db.meetings.toArray(), db.collaborators.toArray(), db.kanbanColumns.orderBy('order').toArray()]);
    const areas = await _getAreas();
    const name = (rows, key) => new Map(rows.map(r => [r.id, r[key]]));
    const P = name(projects, 'title'), I = name(ideas, 'title'), C = name(people, 'name'), K = name(columns, 'title'), A = name(areas, 'name');
    const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => !(v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length))));
    const cut_ = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
    const open = tasks.filter(t => !t.done);
    const state = {
      format: ASST_STATE_FORMAT, today, weekday: new Date(today + 'T12:00:00').toLocaleDateString('es', { weekday: 'long' }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generated: new Date().toISOString(),
      note: 'Fechas AAAA-MM-DD en hora local. Los campos ausentes están vacíos o en falso. Para cambiar algo lee AGENTS.md y deja un archivo en cambios/.',
      summary: { openTasks: open.length, overdueTasks: open.filter(t => t.due && t.due < today).length, dueToday: open.filter(t => t.due === today).length,
        dueNext7Days: open.filter(t => t.due > today && t.due <= addDaysISO(7)).length, waitingOnOthers: open.filter(t => t.assigneeId).length,
        activeProjects: projects.filter(p => !p.archived).length, archivedProjects: projects.filter(p => p.archived).length, unreadIdeas: ideas.filter(i => i.status === 'unread').length },
      columns: columns.map(c => c.title), areas: areas.map(a => ({ uid: a.uid, name: a.name })),
      people: people.map(c => clean({ uid: c.uid, name: c.name, role: c.role, affiliation: c.affiliation, email: c.email, followUpDays: c.followUpDays, lastContact: c.lastContact })),
      projects: projects.filter(p => !p.archived).map(p => clean({ uid: p.uid, title: p.title, type: p.type, column: K.get(p.columnId), priority: p.priority, deadline: p.deadline,
        responsible: p.responsible || C.get(p.responsibleId), area: A.get(p.areaId), parent: P.get(p.parentId), tags: p.tags, starred: p.starred, submissionStatus: p.submissionStatus, description: cut_(p.description, 400) })),
      tasks: tasks.filter(t => !t.done || (t.doneAt || '') > recent).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 600).map(t => clean({
        uid: t.uid, title: t.title, done: t.done, doneAt: t.done ? t.doneAt : null, due: t.due, late: !t.done && t.due && t.due < today, priority: t.priority,
        project: P.get(t.projectId), idea: I.get(t.ideaId), assignee: C.get(t.assigneeId), repeat: t.recurrence, minutes: t.effort, planDate: t.planDate, area: A.get(t.areaId) })),
      ideas: ideas.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 200).map(i => clean({
        uid: i.uid, title: i.title, status: i.status, project: P.get(i.projectId), tags: i.tags, deadline: i.deadline, starred: i.starred, content: cut_(i.content, 500) })),
      meetings: meetings.filter(m => (m.date || '') >= cut).sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(0, 60).map(m => clean({
        uid: m.uid, title: m.title, date: m.date, project: P.get(m.projectId), participants: m.participants, agreements: cut_(m.agreements, 400),
        actionItems: (m.actionItems || []).map(a => clean({ text: a.text, done: a.done, due: a.due, assignee: C.get(a.assigneeId) })) })),
    };
    return state;
  },

  /** La misma información como agenda en Markdown (las referencias a registros usan los 8 primeros caracteres del uid). */
  markdown(s) {
    const short = u => '`' + String(u).slice(0, 8) + '`';
    const line = t => `- [${t.done ? 'x' : ' '}] ${t.title}${t.project ? ` — ${t.project}` : ''}${t.due ? ` · ${t.due}` : ''}${t.priority ? ` · ${t.priority}` : ''}${t.assignee ? ` · esperando a ${t.assignee}` : ''}${t.repeat ? ` · ↻ ${t.repeat.freq}` : ''} ${short(t.uid)}`;
    const open = s.tasks.filter(t => !t.done);
    const sect = (title, list) => list.length ? `\n## ${title} (${list.length})\n\n${list.map(line).join('\n')}\n` : '';
    return `${ASST_MARK}\n# Pendientes — ${s.today} (${s.weekday})\n\n` +
      `> Generado por ResearchOS. **No lo edites**: para cambiar algo deja un archivo en \`cambios/\` (ver AGENTS.md). Los códigos entre acentos graves son el comienzo del uid.\n` +
      `\n**Resumen:** ${s.summary.openTasks} tareas abiertas · ${s.summary.overdueTasks} atrasadas · ${s.summary.dueToday} para hoy · ${s.summary.dueNext7Days} en los próximos 7 días · ${s.summary.waitingOnOthers} esperando a otras personas · ${s.summary.unreadIdeas} ideas sin leer\n` +
      sect('Atrasadas', open.filter(t => t.due && t.due < s.today && !t.assignee)) +
      sect('Hoy', open.filter(t => t.due === s.today && !t.assignee)) +
      sect('Próximos 7 días', open.filter(t => t.due > s.today && t.due <= addDaysISO(7) && !t.assignee)) +
      sect('Más adelante', open.filter(t => t.due > addDaysISO(7) && !t.assignee)) +
      sect('Sin fecha', open.filter(t => !t.due && !t.assignee)) +
      sect('Esperando a otras personas', open.filter(t => t.assignee)) +
      (s.meetings.filter(m => m.date >= s.today).length ? `\n## Reuniones próximas\n\n${s.meetings.filter(m => m.date >= s.today).map(m => `- ${m.date} · ${m.title}${m.project ? ` — ${m.project}` : ''} ${short(m.uid)}`).join('\n')}\n` : '') +
      `\n## Proyectos activos (${s.projects.length})\n\n${s.projects.map(p => `- **${p.title}** · ${p.column || '—'}${p.deadline ? ` · vence ${p.deadline}` : ''}${p.priority ? ` · ${p.priority}` : ''} ${short(p.uid)}`).join('\n') || '_ninguno_'}\n` +
      (s.ideas.filter(i => i.status === 'unread').length ? `\n## Ideas sin leer\n\n${s.ideas.filter(i => i.status === 'unread').map(i => `- ${i.title}${i.project ? ` — ${i.project}` : ''} ${short(i.uid)}`).join('\n')}\n` : '');
  },

  /** Instrucciones para cualquier LLM, generadas desde los mismos campos que valida la app (nunca se desactualizan). */
  instructions() {
    const f = t => Object.keys(ASST_FIELDS[t]).map(k => '`' + k + '`').join(', ');
    return `${ASST_MARK}
# ResearchOS — instrucciones para un asistente de IA

Esta carpeta es la puerta de entrada de un asistente de IA a ResearchOS (una app local de gestión de investigación). Tu trabajo: ayudar a la persona a mantener al día sus pendientes, tareas, ideas, reuniones y proyectos.

## Qué hay aquí

| Archivo | Quién lo escribe | Para qué |
|---|---|---|
| \`estado.json\` | la app (solo lectura para ti) | Todo el estado, con nombres legibles y \`uid\` estables. **Léelo siempre antes de proponer cambios.** |
| \`pendientes.md\` | la app (solo lectura) | La misma agenda en Markdown: atrasado, hoy, próximos días, esperando a otros. |
| \`cambios/\` | **tú** | Aquí dejas los cambios, uno o varios archivos \`.json\`. |
| \`resultados/\` | la app | Con el mismo nombre que tu archivo: qué se aplicó, qué falló y por qué. |

**No edites \`estado.json\` ni \`pendientes.md\`**: se regeneran y tus cambios se perderían. Todo cambio va por \`cambios/\`.

## Cómo proponer cambios

Crea un archivo nuevo en \`cambios/\` (nombre único, p. ej. \`2026-11-01T10-30-claude.json\`; nunca reutilices un nombre) con este formato:

\`\`\`json
{
  "format": "${ASST_CHANGES_FORMAT}",
  "author": "claude-code",
  "note": "Reorganicé las entregas de la semana",
  "ops": [
    { "op": "add", "type": "task", "set": { "title": "Enviar borrador a Vega", "due": "2026-11-06", "project": "Paper Alfa", "priority": "Alta", "assignee": "Dra. Vega" } },
    { "op": "update", "type": "task", "uid": "3f2a9c1e", "set": { "due": "2026-11-10", "priority": "Media" } },
    { "op": "complete", "type": "task", "uid": "a81b77d0" },
    { "op": "add", "type": "idea", "set": { "title": "Probar modelo mixto", "content": "Con lme4", "tags": ["estadística"] } },
    { "op": "delete", "type": "task", "uid": "c0ffee12" }
  ]
}
\`\`\`

- \`op\`: \`add\`, \`update\`, \`complete\` (solo tareas) o \`delete\` (solo tareas e ideas).
- \`type\`: \`task\`, \`idea\`, \`project\`, \`meeting\` o \`person\`. Operaciones por tipo: tarea (add, update, complete, delete) · idea (add, update, delete) · proyecto (add, update) · reunión (add, update) · persona (add).
- Para \`update\`, \`complete\` y \`delete\` indica el registro con \`uid\` (el completo o sus **8 primeros caracteres**, como en \`pendientes.md\`). Si no lo tienes, \`"match": "título exacto"\` también sirve cuando es único.
- \`set\` lleva los campos. Para borrar un valor ponlo en \`null\`.
- Los **nombres** de proyectos, personas, ideas, columnas y áreas sirven como referencia (sin importar mayúsculas ni tildes). Si son ambiguos, usa el \`uid\`.
- Fechas: \`AAAA-MM-DD\`, en la hora local de \`estado.json\` (\`today\`). Prioridades: \`Alta\`, \`Media\`, \`Baja\`.
- Un lote puede crear un proyecto y, después, tareas que lo mencionen por nombre. Máximo ${ASST_MAX_OPS} operaciones por archivo.

### Campos de \`set\` por tipo

- **task**: ${f('task')}. \`repeat\`: \`{"freq":"daily|weekly|monthly","interval":1,"until":"AAAA-MM-DD"}\` (o solo \`"weekly"\`). \`minutes\`: tiempo estimado. \`planDate\`: el día en que la harás. \`assignee\`: persona de la que esperas la tarea.
- **idea**: ${f('idea')}. \`status\`: \`unread\` o \`reviewed\`.
- **project**: ${f('project')}. \`column\`: nombre de la columna del tablero (ver \`columns\`).
- **meeting**: ${f('meeting')}. \`addActionItems\`: lista de \`{"text","due","assignee","done"}\` que se añade a los acuerdos.
- **person**: ${f('person')}.

## Qué pasa después

1. La app (debe estar abierta en el navegador) lee \`cambios/\` cada pocos segundos.
2. Por defecto **la persona revisa y acepta** tus cambios; los borrados **siempre** se revisan. Si activó «aplicar automáticamente», lo que no es un borrado se aplica enseguida y se puede deshacer.
3. La app escribe \`resultados/<mismo nombre>.json\` con \`status\` (\`pending\` mientras espera revisión, luego \`done\`) y, por operación, \`applied\`, \`rejected\` o \`error\` (con el motivo y el \`uid\` creado). **Léelo** y corrige lo que haya fallado en un archivo nuevo.
4. \`estado.json\` se actualiza con lo aplicado.

## Buenas prácticas

- Lee primero \`estado.json\` (o \`pendientes.md\`) y no inventes \`uid\`: cópialos.
- Propón cambios pequeños y explicados en \`note\`; no reorganices todo de golpe.
- Antes de añadir una tarea, comprueba que no existe ya una igual.
- No borres salvo que la persona lo pida. Completar una tarea es \`complete\`, no \`delete\`.

## Herramienta incluida (opcional)

Si hay un archivo \`researchos.js\` en esta carpeta (Node 18+, sin dependencias) hace estos pasos por ti, desde esta misma carpeta:

- \`node researchos.js resumen\` · \`node researchos.js tareas --hasta semana\` · \`node researchos.js buscar "figuras"\`
- \`node researchos.js añadir-tarea "Enviar borrador" --fecha 2026-11-06 --proyecto "Paper Alfa" --prioridad Alta --esperar\`
- \`node researchos.js completar "Enviar borrador"\` · \`node researchos.js modificar <uid> --fecha 2026-11-10\` · \`node researchos.js ayuda\`
- Servidor MCP para Claude Desktop, Cursor, etc.: \`node researchos.js mcp --dir <esta carpeta>\`. Definiciones de funciones para otras APIs: \`node researchos.js schema --formato openai|anthropic\`.
`;
  },

  // ---------- publicar ----------
  async _write(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(text); await w.close();
  },
  async _read(dir, name) { try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; } },
  async _writeIfOurs(dir, name, text) {
    const cur = await this._read(dir, name);
    if (cur === text) return;
    if (cur !== null && !cur.includes(ASST_MARK)) return;                 // un AGENTS.md / CLAUDE.md propio de la persona no se pisa
    await this._write(dir, name, text);
  },
  async publish(dir) {
    await dir.getDirectoryHandle('cambios', { create: true }); await dir.getDirectoryHandle('resultados', { create: true });
    await this._writeIfOurs(dir, 'AGENTS.md', this.instructions());
    await this._writeIfOurs(dir, 'CLAUDE.md', `${ASST_MARK}\n@AGENTS.md\n`);
    try { const r = await fetch('tools/researchos.js', { cache: 'no-cache' }); if (r.ok) await this._writeIfOurs(dir, 'researchos.js', await r.text()); } catch {}   // la herramienta viaja con la carpeta
    const s = await this.state();
    const { generated, ...stable } = s;
    const hash = JSON.stringify(stable);
    if (hash !== this._hash || (await this._read(dir, 'estado.json')) === null) {
      await this._write(dir, 'estado.json', JSON.stringify(s, null, 1));
      this._hash = hash;
    }
    const md = this.markdown(s);
    if (md !== this._md || (await this._read(dir, 'pendientes.md')) === null) { await this._write(dir, 'pendientes.md', md); this._md = md; }
  },

  // ---------- lo que la IA propone ----------
  /** Valida un archivo de cambios y devuelve { author, note, items }: cada item lleva su etiqueta legible, o un error. */
  async plan(change) {
    if (!change || typeof change !== 'object' || !Array.isArray(change.ops)) throw new Error('el archivo debe ser {"format":"' + ASST_CHANGES_FORMAT + '","ops":[…]}');
    if (change.format && change.format !== ASST_CHANGES_FORMAT) throw new Error(`formato «${change.format}» no reconocido (se espera ${ASST_CHANGES_FORMAT})`);
    if (change.ops.length > ASST_MAX_OPS) throw new Error(`demasiadas operaciones (${change.ops.length}; máximo ${ASST_MAX_OPS})`);
    const items = [];
    for (const [i, raw] of change.ops.entries()) {
      const it = { i, op: raw?.op, type: raw?.type, status: 'pending', label: '', set: null, id: null, destructive: false };
      try {
        const T = ASST_TYPES[raw?.type];
        if (!T) throw new Error(`type «${raw?.type}» no existe (${Object.keys(ASST_TYPES).join(', ')})`);
        if (!T.ops.includes(raw.op)) throw new Error(`«${raw.op}» no está permitido para ${T.noun} (admite: ${T.ops.join(', ')})`);
        const reserved = new Set(['op', 'type', 'uid', 'match', 'note']);
        it.set = raw.set && typeof raw.set === 'object' && !Array.isArray(raw.set) ? raw.set
          : Object.fromEntries(Object.entries(raw).filter(([k]) => !reserved.has(k)));
        if (raw.op !== 'complete' && raw.op !== 'delete') {
          const known = ASST_FIELDS[raw.type];
          const bad = Object.keys(it.set).filter(k => !known[k]);
          if (bad.length) throw new Error(`campo «${bad[0]}» no admitido en ${T.noun}. Admitidos: ${Object.keys(known).join(', ')}`);
          if (raw.op === 'add' && !(raw.type === 'person' ? it.set.name : it.set.title)) throw new Error(`falta ${raw.type === 'person' ? 'name' : 'title'} en «set»`);
          if (raw.op === 'update' && !Object.keys(it.set).length) throw new Error('«set» está vacío');
        }
        if (raw.op === 'add') {
          const s = it.set, bits = [s.due && `vence ${s.due}`, (s.project) && `proyecto ${s.project}`, s.assignee && `esperando a ${s.assignee}`, s.date && s.date].filter(Boolean);
          it.label = `Añadir ${T.noun} «${s.title ?? s.name}»${bits.length ? ' · ' + bits.join(' · ') : ''}`;
        } else {
          if (_asstEmpty(raw.uid) && _asstEmpty(raw.match)) throw new Error('falta «uid» (o «match» con el título exacto)');
          const rows = await db[T.table].toArray();
          const row = _asstFind(rows, raw.uid ?? raw.match, T.label, T.noun);
          it.id = row.id; it.uid = row.uid;
          const fmt = v => v === null ? 'vacío' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          it.label = raw.op === 'delete' ? `Eliminar ${T.noun} «${T.label(row)}»`
            : raw.op === 'complete' ? `Completar tarea «${T.label(row)}»`
            : `Modificar ${T.noun} «${T.label(row)}»: ${Object.entries(it.set).map(([k, v]) => `${k} → ${fmt(v)}`).join(', ')}`;
          it.destructive = raw.op === 'delete';
        }
      } catch (e) { it.status = 'error'; it.error = e.message; it.label = it.label || `Operación ${i + 1}`; }
      items.push(it);
    }
    return { author: String(change.author || 'asistente').slice(0, 60), note: String(change.note || '').slice(0, 300), items };
  },

  async _result(batch) {
    const pending = batch.items.some(i => i.status === 'pending');
    const text = JSON.stringify({ format: 'researchos-result/1', file: batch.name, status: pending ? 'pending' : 'done', mode: this.mode(), at: new Date().toISOString(),
      ...(batch.error ? { error: batch.error } : {}),
      ops: batch.items.map(({ i, op, type, status, label, uid, error }) => ({ index: i, op, type, status, label, ...(uid ? { uid } : {}), ...(error ? { error } : {}) })) }, null, 1);
    try { await this._write(await batch.dir.getDirectoryHandle('resultados', { create: true }), batch.name, text); } catch (e) { console.warn('Asistente: no se pudo escribir el resultado', e); }
  },

  /** Ejecuta en orden las operaciones indicadas. Cada una es independiente: si una falla, las demás siguen. */
  async _apply(batch, items) {
    const undos = [];
    for (const it of items) {
      try { const r = await _asstRun(it); it.status = 'applied'; it.uid = r.uid || it.uid; undos.push(r.undo); }
      catch (e) { it.status = 'error'; it.error = e.message; }
    }
    await this._result(batch);
    const done = items.filter(i => i.status === 'applied').length;
    if (done) {
      updateBadges?.();
      UndoStack.push({ label: 'Cambios del asistente', undo: async () => { for (const u of undos.reverse()) { try { await u(); } catch {} } } });
      showToastWithUndo(`🤖 ${batch.author}: ${done} cambio(s) aplicado(s)`, 'success');
    }
    const failed = items.filter(i => i.status === 'error').length;
    if (failed) showToast(`🤖 ${failed} cambio(s) del asistente no se pudieron aplicar (ver resultados/${batch.name})`, 'error');
  },

  async ingest(dir) {
    const cambios = await dir.getDirectoryHandle('cambios', { create: true });
    const resultados = await dir.getDirectoryHandle('resultados', { create: true });
    for await (const [name, entry] of cambios.entries()) {
      if (!/^[\w.-]+\.json$/i.test(name) || entry.kind !== 'file' || this._handled.has(name) || this._queue.some(b => b.name === name)) continue;
      const file = await entry.getFile();
      const prev = await this._read(resultados, name);
      if (prev) {
        let st = null; try { st = JSON.parse(prev).status; } catch {}
        if (st !== 'pending') {
          this._handled.add(name);
          if (Date.now() - file.lastModified > 60 * 86400000) { await cambios.removeEntry(name).catch(() => {}); await resultados.removeEntry(name).catch(() => {}); }   // limpieza de lo viejo
          continue;
        }
      }
      if (Date.now() - file.lastModified < 1500) continue;                    // todavía se está escribiendo: se lee en la siguiente vuelta
      const batch = { name, dir, author: 'asistente', note: '', items: [], error: null };
      let change;
      try { change = JSON.parse(await file.text()); }
      catch (e) {
        if (Date.now() - file.lastModified < 15000) continue;                 // puede estar a medias: se espera un poco antes de darlo por inválido
        batch.error = 'JSON no válido: ' + e.message; await this._result(batch); this._handled.add(name); continue;
      }
      try { Object.assign(batch, await this.plan(change)); }
      catch (e) { batch.error = e.message; await this._result(batch); this._handled.add(name); continue; }
      const todo = batch.items.filter(i => i.status === 'pending');
      if (!todo.length) { await this._result(batch); this._handled.add(name); continue; }
      const auto = this.mode() === 'auto';
      const now = auto ? todo.filter(i => !i.destructive) : [];
      const held = todo.filter(i => !now.includes(i));
      if (held.length) { this._queue.push(batch); await this._result(batch); }
      if (now.length) await this._apply(batch, now);
      if (!held.length) { await this._result(batch); this._handled.add(name); }
    }
    this._bar();
  },

  // ---------- revisión por la persona ----------
  _pendingCount() { return this._queue.reduce((n, b) => n + b.items.filter(i => i.status === 'pending').length, 0); },
  _bar() {
    let bar = document.getElementById('assistantBar');
    const n = this._pendingCount();
    if (!n) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'assistantBar'; bar.className = 'reload-bar'; bar.setAttribute('role', 'alert');
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<span>🤖 Tu asistente propone <strong>${n}</strong> cambio${n === 1 ? '' : 's'}</span>
      <button class="btn btn-primary btn-sm" id="assistantReview">Revisar</button><button class="btn btn-ghost btn-sm" id="assistantDiscardAll">Descartar</button>`;
    bar.querySelector('#assistantReview').onclick = () => this.review();
    bar.querySelector('#assistantDiscardAll').onclick = () => this.decide(false);
  },
  review() {
    const batches = this._queue.filter(b => b.items.some(i => i.status === 'pending'));
    if (!batches.length) return;
    showModal('🤖 Cambios propuestos por tu asistente', `
      ${batches.map((b, bi) => `<div style="margin-bottom:12px">
        <div class="form-label">${esc(b.author)}${b.note ? ` — ${esc(b.note)}` : ''}</div>
        ${b.items.filter(i => i.status === 'pending').map(i => `<label style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;cursor:pointer">
          <input type="checkbox" data-asst="${bi}:${i.i}" checked style="margin-top:3px"><span>${esc(i.label)}${i.destructive ? ' <strong style="color:var(--red)">⚠ borrado</strong>' : ''}</span></label>`).join('')}
        ${b.items.some(i => i.status === 'error') ? `<div class="settings-row-desc">${b.items.filter(i => i.status === 'error').length} operación(es) no válidas: la IA lo verá en resultados/.</div>` : ''}
      </div>`).join('')}
      <div class="modal-footer"><button class="btn btn-ghost" id="asstDiscard">Descartar todo</button><button class="btn btn-primary" id="asstApply">Aplicar lo marcado</button></div>`);
    $('asstApply').onclick = () => { const sel = new Set([...modalContent.querySelectorAll('[data-asst]:checked')].map(c => c.dataset.asst)); closeModal(); this.decide(true, sel, batches); };
    $('asstDiscard').onclick = () => { closeModal(); this.decide(false); };
  },
  /** Aplica (con la selección marcada) o descarta lo que esperaba revisión. */
  async decide(apply, selected = null, batches = this._queue) {
    for (const [bi, b] of batches.entries()) {
      const pending = b.items.filter(i => i.status === 'pending');
      const yes = apply ? pending.filter(i => !selected || selected.has(`${bi}:${i.i}`)) : [];
      pending.filter(i => !yes.includes(i)).forEach(i => { i.status = 'rejected'; });
      if (yes.length) await this._apply(b, yes); else await this._result(b);
    }
    this._queue = this._queue.filter(b => b.items.some(i => i.status === 'pending'));
    for (const b of batches) if (!this._queue.includes(b)) this._handled.add(b.name);
    this._bar();
    this._dirty = true; this.syncNow({ quiet: true }).catch(() => {});
  },

  // ---------- ciclo ----------
  async syncNow({ ask = false } = {}) {
    if (this._busy || !this.enabled()) return null;
    const dir = await this.handle();
    if (!dir) return null;
    if ((await this.permission(dir, { ask })) !== 'granted') { this.paused = true; return null; }
    this._busy = true; this.paused = false;
    try {
      await this.ingest(dir);
      await this.publish(dir);
      localStorage.setItem('ros-assistant-last', String(Date.now()));
      this._dirty = false;
      return true;
    } finally { this._busy = false; }
  },
  /** Cada cambio local reescribe estado.json unos segundos después. */
  schedule() {
    if (!this.enabled()) return;
    this._dirty = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.syncNow().catch(() => {}), 4000);
  },
};
window.Assistant = Assistant;
SyncState.listeners.push(() => Assistant.schedule());

document.addEventListener('visibilitychange', () => {
  if (Assistant.enabled() && !Assistant.paused && document.visibilityState === 'visible') Assistant.syncNow().catch(() => {});
});

/** Al abrir la app: publica el estado y vigila `cambios/` mientras la pestaña esté visible. */
async function initAssistant() {
  if (!Assistant.enabled() || !Assistant.supported()) return;
  try {
    const handle = await Assistant.handle();
    if (!handle) return;
    if ((await Assistant.permission(handle)) !== 'granted') { Assistant.paused = true; return; }
    await Assistant.syncNow();
    clearInterval(Assistant._poll);
    Assistant._poll = setInterval(() => { if (document.visibilityState === 'visible' && !Assistant.paused) Assistant.syncNow().catch(() => {}); }, 15_000);
  } catch (e) { console.warn('Asistente: no disponible', e); }
}

// ==============================================================
//  AJUSTES: sección «Asistente de IA»
// ==============================================================
async function renderAssistantSection() {
  const host = $('assistantSection');
  if (!host) return;
  const handle = Assistant.supported() && Assistant.enabled() ? await Assistant.handle().catch(() => null) : null;
  const perm = handle ? await Assistant.permission(handle).catch(() => 'denied') : null;
  host.innerHTML = `
    <div class="settings-section-title">🤖 Asistente de IA</div>
    <div class="settings-body">
      ${!Assistant.supported() ? `<div class="settings-row-desc">Hace falta un navegador basado en Chromium (Chrome, Edge) para elegir una carpeta.</div>` : `
      <div class="settings-row">
        <div>
          <div class="settings-row-label">${handle ? `Activo → <code>${esc(handle.name || 'carpeta')}</code>` : 'Desactivado'}</div>
          <div class="settings-row-desc" id="assistantDesc">
            ${handle ? (perm === 'granted'
              ? `Última publicación: ${_fmtAgo(Assistant.lastRun())}. Abre un LLM (p. ej. Claude Code) <strong>en esa carpeta</strong>: encontrará <code>AGENTS.md</code>, <code>estado.json</code> y <code>pendientes.md</code>, y te propondrá cambios que verás aquí antes de aplicarlos.`
              : '⚠ En pausa: el navegador necesita que reactives el permiso de la carpeta.')
            : 'Elige una carpeta (mejor una vacía, p. ej. «ResearchOS-IA»). La app dejará en ella tus pendientes en un formato que cualquier IA entiende y leerá los cambios que esta le proponga. Nada sale de tu equipo salvo que esa carpeta se sincronice.'}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${handle ? `${perm !== 'granted' ? `<button class="btn btn-primary btn-sm" id="assistantResume">Reactivar</button>` : ''}
                      <button class="btn btn-ghost btn-sm" id="assistantNow">Actualizar ahora</button>
                      <button class="btn btn-ghost btn-sm" id="assistantOff">Desactivar</button>`
                   : `<button class="btn btn-primary btn-sm" id="assistantOn">Elegir carpeta…</button>`}
        </div>
      </div>
      ${handle ? `<div class="settings-row">
        <div><div class="settings-row-label">Cuando la IA propone cambios</div>
          <div class="settings-row-desc">«Revisar» te enseña la lista y eliges qué aplicar. «Automático» aplica de inmediato lo que no sea un borrado (con «Deshacer»). Los borrados siempre se revisan.</div></div>
        <select class="form-select" id="assistantMode" aria-label="Cuando la IA propone cambios" style="max-width:230px">
          <option value="review"${Assistant.mode() === 'review' ? ' selected' : ''}>Revisar antes de aplicar</option>
          <option value="auto"${Assistant.mode() === 'auto' ? ' selected' : ''}>Aplicar automáticamente</option>
        </select>
      </div>` : ''}`}
    </div>`;
  $('assistantOn')?.addEventListener('click', async () => {
    try { await Assistant.choose(); await initAssistant(); showToast('Asistente activado ✓', 'success'); } catch (e) { if (e?.name !== 'AbortError') showToast('No se pudo activar: ' + e.message, 'error'); }
    renderAssistantSection();
  });
  $('assistantOff')?.addEventListener('click', async () => { await Assistant.disable(); showToast('Asistente desactivado', 'info'); renderAssistantSection(); });
  const run = async ask => { try { const r = await Assistant.syncNow({ ask }); showToast(r ? 'Carpeta del asistente al día ✓' : 'No se pudo actualizar', r ? 'success' : 'error'); } catch (e) { showToast('Error: ' + e.message, 'error'); } renderAssistantSection(); };
  $('assistantNow')?.addEventListener('click', () => run(true));
  $('assistantResume')?.addEventListener('click', async () => { await run(true); await initAssistant(); });
  $('assistantMode')?.addEventListener('change', e => Assistant.setMode(e.target.value));
}
