
// ============================================================
//  ResearchOS — Database Layer  (Dexie.js 3.x)
//  Local-first, IndexedDB-backed, zero-backend.
// ============================================================

const db = new Dexie('ResearchOS_v2');   // ← nombre nuevo = BD limpia para todos

// Schema consolidado
db.version(1).stores({
  projects:           '++id, title, type, status, columnId, responsible, deadline, priority, createdAt, updatedAt, archived, starred, parentId',
  ideas:              '++id, title, content, status, projectId, starred, createdAt, updatedAt',
  snippets:           '++id, title, language, code, description, projectId, collectionId, starred, createdAt, updatedAt',
  snippetCollections: '++id, name, color, createdAt',
  resources:          '++id, title, url, filePath, type, projectId, ideaId, createdAt',
  collaborators:      '++id, name, email, role, affiliation, createdAt',
  kanbanColumns:      '++id, title, order, color, isDefault, wip',
  settings:           'key, value',
  submissions:        '++id, title, type, status, projectId, targetVenue, deadlineAt, submittedAt, createdAt, updatedAt',
  meetings:           '++id, title, date, projectId, createdAt, updatedAt',
  references:         '++id, title, authors, year, journal, doi, projectId, createdAt, updatedAt'
});

// Version 2: agrega índice deadline a ideas
db.version(2).stores({
  ideas:              '++id, title, content, status, projectId, starred, createdAt, updatedAt, deadline'
});

// Version 3: índice responsibleId para búsqueda por colaborador canónico
db.version(3).stores({
  projects:           '++id, title, type, status, columnId, responsible, responsibleId, deadline, priority, createdAt, updatedAt, archived, starred, parentId'
});

// Version 4: los campos de submission se integran en proyectos tipo Paper.
// La tabla submissions se mantiene por retrocompatibilidad pero deja de escribirse.
db.version(4).upgrade(async tx => {
  const subs = await tx.table('submissions').toArray();
  for (const sub of subs) {
    if (!sub.projectId) continue;
    const proj = await tx.table('projects').get(sub.projectId);
    if (!proj) continue;
    const upd = {};
    if (!proj.submissionStatus)
      upd.submissionStatus  = sub.status      || 'preparacion';
    if (!proj.targetVenue    && sub.targetVenue)
      upd.targetVenue       = sub.targetVenue;
    if (!proj.submittedAt    && sub.submittedAt)
      upd.submittedAt       = sub.submittedAt;
    if (!proj.submissionNotes && sub.notes)
      upd.submissionNotes   = sub.notes;
    if (!(proj.submissionRounds || []).length && (sub.rounds || []).length)
      upd.submissionRounds  = sub.rounds;
    if (Object.keys(upd).length)
      await tx.table('projects').update(sub.projectId, upd);
  }
});

// -- Utilidades compartidas -----------------------------------
// Viven aquí (db.js se carga antes que app.js) porque también las usa la validación de backups.

/** Fecha local YYYY-MM-DD. `toISOString()` devuelve la fecha UTC: de noche en América desplaza el día. */
function localDateISO(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `YYYY-MM-DD` válido o null. Evita que un valor arbitrario llegue a atributos HTML. */
function isoDateOrNull(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, day] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day ? v : null;      // rechaza «2026-02-31»
}

const _CSS_COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\(\s*[\d.\s,%\/-]+\)|var\(--[\w-]+\)|[a-z]{3,20})$/i;
/** Devuelve `c` solo si es un color CSS inocuo (hex, rgb/hsl, var(--x) o palabra clave); si no, `fallback`. */
function cssColor(c, fallback = '#64748b') {
  return typeof c === 'string' && _CSS_COLOR_RE.test(c.trim()) ? c.trim() : fallback;
}

/** Minúsculas sin diacríticos: "Análisis" → "analisis". Para búsqueda y comparación. */
function foldText(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Normaliza un nombre de persona para comparar «Dra. Vega», «vega» y «María Vega» (sin títulos ni tildes). */
function nameKey(s) {
  return foldText(s).replace(/\b(dr|dra|prof|profa|lic|mg|msc|phd|sr|sra)\b\.?/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
/** ¿Se refieren `a` y `b` a la misma persona? Exacto, o un nombre contenido en el otro («vega» ⊆ «maria vega»). */
function sameName(a, b) {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tx = x.split(' '), ty = y.split(' ');
  const [small, big] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  return small.every(w => big.includes(w)) && small.join('').length > 2;
}

// Version 5: tareas como entidad propia (con fecha, ligadas opcionalmente a un proyecto o a una idea).
// Reemplaza a las "subtareas" embebidas en proyectos e ideas, que no podían tener fecha ni verse en conjunto.
// `done` no se indexa (los booleanos no son claves válidas en IndexedDB).
db.version(5).stores({
  tasks: '++id, projectId, ideaId, due, createdAt, updatedAt'
}).upgrade(async tx => {
  const now = new Date().toISOString();
  const tasks = tx.table('tasks');
  for (const p of await tx.table('projects').toArray()) {
    if (!Array.isArray(p.subtasks) || !p.subtasks.length) continue;
    for (const t of p.subtasks)
      await tasks.add({ title: String(t.text ?? ''), done: !!t.done, doneAt: t.done ? now : null, due: null,
                        projectId: p.id, ideaId: null, createdAt: p.updatedAt || now, updatedAt: now });
    await tx.table('projects').update(p.id, { subtasks: [] });
  }
  for (const i of await tx.table('ideas').toArray()) {
    if (!Array.isArray(i.subtasks) || !i.subtasks.length) continue;
    for (const t of i.subtasks)
      await tasks.add({ title: String(t.text ?? ''), done: !!t.done, doneAt: t.done ? now : null, due: null,
                        projectId: i.projectId ?? null, ideaId: i.id, createdAt: i.updatedAt || now, updatedAt: now });
    await tx.table('ideas').update(i.id, { subtasks: [] });
  }
});

// Version 6: identidad global (`uid`) y lápidas de borrado, para sincronizar entre dispositivos.
// Los ids numéricos son locales de cada navegador; el `uid` identifica al mismo registro en todos.
const SYNC_TABLES = ['projects', 'ideas', 'snippets', 'snippetCollections', 'resources', 'collaborators',
                     'kanbanColumns', 'submissions', 'meetings', 'references', 'tasks'];

/** «HH:MM» válido (00:00–23:59) o null. */
function timeOrNull(v) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null; }
/** Minutos enteros de 5 a 1440, o null (duración de una reunión). */
function durationOrNull(v) { const n = Math.round(+v); return Number.isFinite(n) && n >= 5 ? Math.min(1440, n) : null; }
/** «10:00» + 90 → «11:30» (se queda en el mismo día). */
function addMinutesToTime(t, min) { const [h, m] = t.split(':').map(Number), x = Math.min(23 * 60 + 59, h * 60 + m + min); return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; }
/** «10:00–11:30» (o «10:00» sin duración), o '' si la reunión no tiene hora. */
function meetingWhen(m) { return m?.time ? (m.duration ? `${m.time}–${addMinutesToTime(m.time, m.duration)}` : m.time) : ''; }

/** Hash FNV-1a de 32 bits (hex). Sirve para identidades deterministas, no criptográficas. */
function _fnv(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
/**
 * UID determinista para registros que no lo traen (datos anteriores a la v6 o backups antiguos):
 * dos dispositivos que ya compartían los mismos datos por exportación obtienen el MISMO uid y no se duplican al sincronizar.
 */
function legacyUid(table, r) {
  const label = String(r.title ?? r.name ?? r.text ?? '').toLowerCase().trim();
  const key = `${table}|${r.createdAt || ''}|${label}`;
  return `l-${table.slice(0, 3)}-${_fnv(key)}${_fnv(key, 0x9747b28c)}`;
}
function newUid() {
  return (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`);
}

const SyncState = {
  applying: 0, legacy: 0, deleted: new Map(),         // flags de contexto + borrados de esta sesión (para deshacer)
  listeners: [],                                      // se avisa de cualquier cambio local (sincronización, copia automática…)
  touch() { for (const fn of this.listeners) { try { fn(); } catch {} } },
};

db.version(6).stores({
  projects:           '++id, title, type, status, columnId, responsible, responsibleId, deadline, priority, createdAt, updatedAt, archived, starred, parentId, uid',
  ideas:              '++id, title, content, status, projectId, starred, createdAt, updatedAt, deadline, uid',
  snippets:           '++id, title, language, code, description, projectId, collectionId, starred, createdAt, updatedAt, uid',
  snippetCollections: '++id, name, color, createdAt, uid',
  resources:          '++id, title, url, filePath, type, projectId, ideaId, createdAt, uid',
  collaborators:      '++id, name, email, role, affiliation, createdAt, uid',
  kanbanColumns:      '++id, title, order, color, isDefault, wip, uid',
  submissions:        '++id, title, type, status, projectId, targetVenue, deadlineAt, submittedAt, createdAt, updatedAt, uid',
  meetings:           '++id, title, date, projectId, createdAt, updatedAt, uid',
  references:         '++id, title, authors, year, journal, doi, projectId, createdAt, updatedAt, uid',
  tasks:              '++id, projectId, ideaId, due, createdAt, updatedAt, uid',
  tombstones:         '++id, uid, table',
}).upgrade(async tx => {
  const now = new Date().toISOString();
  for (const t of SYNC_TABLES)
    await tx.table(t).toCollection().modify(r => {
      if (!r.uid) r.uid = legacyUid(t, r);
      if (!r.updatedAt) r.updatedAt = r.createdAt || now;
    });
});

// Ganchos: todo registro nuevo recibe uid; toda modificación actualiza `updatedAt` (base de «gana el cambio más reciente»);
// todo borrado deja una lápida para que los demás dispositivos también lo borren.
for (const t of SYNC_TABLES) {
  db[t].hook('creating', (primKey, obj) => {
    if (!obj.uid) obj.uid = SyncState.legacy ? legacyUid(t, obj) : newUid();
    if (!obj.updatedAt) obj.updatedAt = obj.createdAt || new Date().toISOString();
    if (!SyncState.applying) SyncState.touch();
    if (SyncState.deleted.has(obj.uid) && !SyncState.applying) {           // «Deshacer» de un borrado: el registro vuelve y debe ganar a su lápida
      obj.updatedAt = new Date().toISOString();
      SyncState.deleted.delete(obj.uid);
      const uid = obj.uid;
      setTimeout(() => db.tombstones.where('uid').equals(uid).delete().catch(() => {}), 0);   // fuera de la transacción en curso
    }
  });
  db[t].hook('updating', mods => {
    if (SyncState.applying) return undefined;
    SyncState.touch();
    if ('updatedAt' in mods) return undefined;
    return { updatedAt: new Date().toISOString() };
  });
  db[t].hook('deleting', function (primKey, obj) {
    if (SyncState.applying || !obj?.uid) return;
    this.onsuccess = () => {
      const deletedAt = new Date().toISOString();
      SyncState.deleted.set(obj.uid, deletedAt);
      SyncState.touch();
      setTimeout(() => db.tombstones.add({ uid: obj.uid, table: t, deletedAt }).catch(() => {}), 0);   // fuera de la transacción en curso
    };
  });
}

// -- Seed defaults on first run -------------------------------
async function seedDefaults() {
  const colCount = await db.kanbanColumns.count();
  if (colCount === 0) {
    SyncState.legacy++;                   // las columnas por defecto tienen el mismo uid en todos los dispositivos
    try { await db.kanbanColumns.bulkAdd([
      { title: 'Ideación',          order: 0, color: '#3b82f6', isDefault: true },
      { title: 'Limpieza de Datos', order: 1, color: '#f59e0b', isDefault: true },
      { title: 'Análisis',          order: 2, color: '#8b5cf6', isDefault: true },
      { title: 'Escritura',         order: 3, color: '#10b981', isDefault: true },
      { title: 'Peer Review',       order: 4, color: '#f97316', isDefault: true },
      { title: 'Completado',        order: 5, color: '#14b8a6', isDefault: true },
    ]); } finally { SyncState.legacy--; }
  }
}

// -- Tareas ----------------------------------------------------
// { id, title, done, doneAt, due:'YYYY-MM-DD'|null, projectId|null, ideaId|null, areaId|null (solo sueltas), priority, effort (minutos)|null,
//   planDate:'YYYY-MM-DD'|null (día en que la haré), createdAt, updatedAt }
/** «Yo»: la persona de la agenda que eres tú en este equipo. Lo que otras personas te asignan a ti no es «esperar a nadie». */
const Me = {
  id() { try { return +localStorage.getItem('ros-me') || null; } catch { return null; } },
  set(id) { try { id ? localStorage.setItem('ros-me', String(id)) : localStorage.removeItem('ros-me'); } catch {} },
  /** ¿Estoy esperando a otra persona? (asignar la tarea a «yo» no cuenta). */
  waiting(assigneeId) { return !!assigneeId && assigneeId !== Me.id(); },
};

const Tasks = {
  /** Valida una regla de repetición: { freq: 'daily'|'weekly'|'monthly', interval >= 1, until: 'YYYY-MM-DD'|null } o null. */
  cleanRecurrence(r) {
    if (!r || !['daily', 'weekly', 'monthly'].includes(r.freq)) return null;
    const interval = Math.max(1, Math.min(52, Math.round(+r.interval) || 1));
    return { freq: r.freq, interval, until: isoDateOrNull(r.until) };
  },
  /** Siguiente fecha de una tarea recurrente a partir de `due` (o de hoy), o null si ya pasó `until`. */
  nextDue(due, rec) {
    const base = new Date((due || localDateISO()) + 'T12:00:00');
    if (rec.freq === 'daily') base.setDate(base.getDate() + rec.interval);
    else if (rec.freq === 'weekly') base.setDate(base.getDate() + 7 * rec.interval);
    else {                                                   // mensual: conserva el día, ajustando a fin de mes (31 → 28/30)
      const day = base.getDate();
      base.setDate(1); base.setMonth(base.getMonth() + rec.interval);
      base.setDate(Math.min(day, new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()));
    }
    const next = localDateISO(base);
    return rec.until && next > rec.until ? null : next;
  },
  /** Minutos enteros entre 1 y 1440 (24 h), o null. */
  cleanEffort(m) { const n = Math.round(+m); return Number.isFinite(n) && n >= 1 ? Math.min(1440, n) : null; },
  /** Texto de notas (hasta 5 000 caracteres) o ''. */
  cleanNotes(v) { return String(v ?? '').trim().slice(0, 5000); },
  /** Solo enlaces http(s) válidos (nunca javascript:, data:…), o null. */
  cleanLink(v) { const s = String(v ?? '').trim(); try { const u = new URL(s); return /^https?:$/.test(u.protocol) && s.length <= 2000 ? u.href : null; } catch { return null; } },
  /** Identificador del origen de un dato traído de fuera («gmail:18c3…», «gcal:abc»): sirve para no duplicarlo si se vuelve a proponer. */
  cleanSource(v) { return String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 200); },
  /** Lista de ids de tareas de las que depende (sin repetir ni a sí misma). */
  cleanAfter(v, self = null) { return [...new Set((Array.isArray(v) ? v : []).map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== self))].slice(0, 20); },
  /** Posición manual (número finito; menor = antes) o null. */
  cleanRank(v) { return v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : Math.round(+v * 1000) / 1000; },
  /** Minutos realmente dedicados (1–14 400) o null. */
  cleanSpent(m) { const n = Math.round(+m); return Number.isFinite(n) && n >= 1 ? Math.min(14400, n) : null; },
  async add({ title, due = null, projectId = null, ideaId = null, areaId = null, priority = null, assigneeId = null, recurrence = null, effort = null, planDate = null, notes = '', link = null, source = '',
              ownerId = null, afterIds = [], rank = null, spent = null, event = '', private: priv = false }) {
    const text = String(title ?? '').trim();
    if (!text) return null;
    const now = new Date().toISOString();
    const rec = Tasks.cleanRecurrence(recurrence);
    return db.tasks.add({ title: text, done: false, doneAt: null, due: isoDateOrNull(due) || (rec ? localDateISO() : null),
      projectId: projectId ?? null, ideaId: ideaId ?? null, areaId: projectId ? null : (areaId ?? null),
      priority: priority || null, assigneeId: assigneeId ?? null, recurrence: rec, effort: Tasks.cleanEffort(effort), planDate: isoDateOrNull(planDate),
      notes: Tasks.cleanNotes(notes), link: Tasks.cleanLink(link), source: Tasks.cleanSource(source),
      ownerId: ownerId ?? null, afterIds: Tasks.cleanAfter(afterIds), rank: Tasks.cleanRank(rank), spent: Tasks.cleanSpent(spent), event: Tasks.cleanSource(event), private: !!priv,
      createdAt: now, updatedAt: now });
  },
  /**
   * Marca como hecha (o reabre). Si la tarea es recurrente, al completarla nace la siguiente ocurrencia.
   * Devuelve el id de la ocurrencia creada (para poder deshacer) o null.
   */
  async setDone(id, done) {
    const now = new Date().toISOString();
    const t = await db.tasks.get(id);
    if (!t) return null;
    await db.tasks.update(id, { done: !!done, doneAt: done ? now : null, updatedAt: now });
    if (done && !t.done && t.recurrence) {
      let next = Tasks.nextDue(t.due, t.recurrence);
      // Una repetición atrasada varias veces no deja una cola de fechas pasadas por completar una a una:
      // se descartan las que ya pasaron y la siguiente es la primera que no ha vencido (conserva el día de la semana / del mes).
      const today = localDateISO();
      for (let n = 0; next && next < today && n < 2000; n++) next = Tasks.nextDue(next, t.recurrence);
      if (next) { const { id: _drop, ...rest } = t; return db.tasks.add({ ...rest, done: false, doneAt: null, due: next, planDate: null, spent: null, afterIds: [], createdAt: now, updatedAt: now }); }
    }
    return null;
  },
  async setAssignee(id, assigneeId) { await db.tasks.update(id, { assigneeId: assigneeId ?? null, updatedAt: new Date().toISOString() }); },
  async setRecurrence(id, rec) {
    const t = await db.tasks.get(id);
    const clean = Tasks.cleanRecurrence(rec);
    await db.tasks.update(id, { recurrence: clean, due: t.due || (clean ? localDateISO() : null), updatedAt: new Date().toISOString() });
  },
  async setDue(id, due)   { await db.tasks.update(id, { due: isoDateOrNull(due), updatedAt: new Date().toISOString() }); },
  async setEffort(id, minutes) { await db.tasks.update(id, { effort: Tasks.cleanEffort(minutes), updatedAt: new Date().toISOString() }); await EventLinks.fromTask(await db.tasks.get(id)); },
  async setPlan(id, date) { await db.tasks.update(id, { planDate: isoDateOrNull(date), updatedAt: new Date().toISOString() }); await EventLinks.fromTask(await db.tasks.get(id)); },
  async remove(id)        {
    const t = await db.tasks.get(id); await db.tasks.delete(id); if (t?.source) window.Assistant?.rememberSource(t.source);
    for (const o of await db.tasks.filter(x => (x.afterIds || []).includes(id)).toArray()) await db.tasks.update(o.id, { afterIds: o.afterIds.filter(x => x !== id) });      // nada queda esperando a una tarea que ya no existe
  },
  async setSpent(id, minutes) { await db.tasks.update(id, { spent: Tasks.cleanSpent(minutes), updatedAt: new Date().toISOString() }); },
  /** ¿Sigue bloqueada? Una tarea con «después de» queda oculta mientras alguna de esas tareas esté abierta. */
  isBlocked(t, byId) { return !t.done && (t.afterIds || []).some(i => byId.get(i) && !byId.get(i).done); },
  /** Mapa id → tarea, para isBlocked. */
  index(tasks) { return new Map(tasks.map(t => [t.id, t])); },
  /** Cuánto se desvían tus estimaciones: mediana de (real ÷ estimado) en tareas hechas con ambos datos; null si hay menos de 3. */
  accuracy(tasks) {
    const r = tasks.filter(t => t.done && t.effort && t.spent).map(t => t.spent / t.effort).sort((a, b) => a - b);
    return r.length >= 3 ? { ratio: Math.round(r[Math.floor((r.length - 1) / 2)] * 100) / 100, n: r.length } : null;
  },   // lo borrado a mano no se vuelve a proponer
  /** Tareas de un proyecto (type='project') o de una idea (type='idea'), en orden de creación. */
  async forEntity(type, id) {
    const col = type === 'project' ? 'projectId' : 'ideaId';
    const rows = await db.tasks.where(col).equals(id).toArray();
    // las tareas de una idea llevan también su projectId: en el proyecto solo se listan las propias
    return (type === 'project' ? rows.filter(t => !t.ideaId) : rows).sort((a, b) => a.id - b.id);
  },
  /** Mapa projectId → {total, done, late} (late = vencidas sin completar). Para las insignias de las tarjetas. */
  async statsByProject() {
    const today = localDateISO(), map = {}, all = await db.tasks.toArray(), byId = Tasks.index(all), me = Me.id();
    for (const t of all.filter(t => t.projectId != null && !t.ideaId)) {
      const c = map[t.projectId] || (map[t.projectId] = { total: 0, done: 0, late: 0, next: null, blocked: 0 });
      c.total++; if (t.done) c.done++; else if (t.due && t.due < today) c.late++;
      // «Próxima acción»: la tarea abierta propia que toca primero (su posición manual, luego la fecha más cercana; las sin fecha, después). Las bloqueadas esperan.
      if (!t.done && (!t.assigneeId || t.assigneeId === me)) {
        if (Tasks.isBlocked(t, byId)) { c.blocked++; continue; }
        const key = x => [x.rank ?? 1e9, x.due || '9999', x.id];
        const better = !c.next || (() => { const a = key(t), b = key(c.next); return a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2]; })() < 0;
        if (better) c.next = { id: t.id, title: t.title, due: t.due || null, rank: t.rank ?? null };
      }
    }
    return map;
  },
  /** Mapa ideaId → {total, done} para los contadores de la lista de ideas. */
  async countsByIdea() {
    const map = {};
    for (const t of await db.tasks.filter(t => t.ideaId != null).toArray()) {
      const c = map[t.ideaId] || (map[t.ideaId] = { total: 0, done: 0 });
      c.total++; if (t.done) c.done++;
    }
    return map;
  },
};

/**
 * Tareas ligadas a un bloque del calendario (la tarea guarda en `event` el `source` de la reunión). Los cambios se siguen en los dos sentidos:
 * el día de la reunión es el día en que haré la tarea (`planDate`) y su duración, el tiempo estimado (`effort`).
 * Cada función solo escribe si algo cambió, así que nunca se encadenan.
 */
const EventLinks = {
  async fromMeeting(m) {
    if (!m?.source) return 0;
    let n = 0;
    for (const t of await db.tasks.filter(t => !t.done && t.event === m.source).toArray()) {
      const patch = {};
      if (m.date && t.planDate !== m.date) patch.planDate = m.date;
      if (m.duration && t.effort !== m.duration) patch.effort = m.duration;
      if (Object.keys(patch).length) { await db.tasks.update(t.id, patch); n++; }
    }
    return n;
  },
  async fromTask(t) {
    if (!t?.event) return 0;
    let n = 0;
    for (const m of await db.meetings.filter(m => m.source === t.event).toArray()) {
      const patch = {};
      if (t.planDate && m.date !== t.planDate) patch.date = t.planDate;
      if (t.effort && m.time && m.duration !== t.effort) patch.duration = t.effort;           // solo las reuniones con hora tienen duración
      if (Object.keys(patch).length) { await db.meetings.update(m.id, patch); n++; }
    }
    return n;
  },
};

/**
 * Reuniones que se repiten. La «madre» guarda la regla (`recurrence`); las ocurrencias son reuniones normales con `seriesId` = uid de la madre,
 * creadas con un uid derivado de la fecha para que dos dispositivos no las dupliquen al sincronizar. Cada ocurrencia tiene sus propios acuerdos.
 */
const Meetings = {
  HORIZON_DAYS: 120, MAX_PER_RUN: 80,
  _fields: m => ({ title: m.title, time: m.time ?? null, duration: m.duration ?? null, participants: m.participants || '', projectId: m.projectId ?? null }),
  /** Crea las ocurrencias que faltan hasta el horizonte y pone al día las futuras que nadie ha tocado. Sin regla, quita las futuras intactas. */
  async expandSeries(masterId) {
    const m = await db.meetings.get(masterId);
    if (!m?.uid) return 0;
    const today = localDateISO(), mine = await db.meetings.filter(x => x.seriesId === m.uid).toArray();
    const untouched = x => x.date > today && !x.agreements && !(x.actionItems || []).length;
    const rec = Tasks.cleanRecurrence(m.recurrence);
    if (!rec) { for (const x of mine.filter(untouched)) await db.meetings.delete(x.id); return 0; }
    const limit = addDaysISO(Meetings.HORIZON_DAYS), have = new Map(mine.map(x => [x.date, x]));
    let n = 0, d = m.date;
    for (let i = 0; i < 400 && n < Meetings.MAX_PER_RUN; i++) {
      d = Tasks.nextDue(d, rec);
      if (!d || d > limit) break;
      const cur = have.get(d), now = new Date().toISOString();
      if (!cur) { await db.meetings.add({ ...Meetings._fields(m), date: d, agreements: '', actionItems: [], seriesId: m.uid, uid: `${m.uid}:${d}`, createdAt: now, updatedAt: now }); n++; }
      else if (untouched(cur)) {
        const f = Meetings._fields(m);
        if (Object.keys(f).some(k => (cur[k] ?? null) !== (f[k] ?? null))) await db.meetings.update(cur.id, f);
      }
    }
    return n;
  },
  async expandAll() {
    let n = 0;
    for (const m of await db.meetings.filter(m => m.recurrence && !m.seriesId).toArray()) n += await Meetings.expandSeries(m.id);
    return n;
  },
};

/** La columna de partida de un proyecto de este tipo: la primera pensada para él; si no hay, la primera de uso general. */
function columnForType(cols, type) {
  const own = c => (c.types || []).includes(type), general = c => !(c.types || []).length;
  return (cols.find(own) || cols.find(general) || cols[0])?.id ?? null;
}

// -- Query helpers --------------------------------------------

async function getKanbanData() {
  const [cols, projects] = await Promise.all([
    db.kanbanColumns.orderBy('order').toArray(),
    db.projects.filter(p => !p.archived).toArray()
  ]);
  const byRank = (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9);               // la posición manual manda; sin ella, el orden de siempre (sort estable)
  return cols.map(col => ({
    ...col,
    cards: projects.filter(p => p.columnId === col.id).sort(byRank)
  }));
}

async function getRelatedIdeas(projectId) {
  const all = await db.ideas.where('projectId').equals(projectId).toArray();
  const allIds = new Set(all.map(i => i.id));
  const multi = await db.ideas.filter(i =>
    !allIds.has(i.id) &&
    Array.isArray(i.projectIds) && i.projectIds.includes(projectId)
  ).toArray();
  return [...all, ...multi];
}

async function getRelatedSnippets(projectId) {
  const all = await db.snippets.where('projectId').equals(projectId).toArray();
  const allIds = new Set(all.map(s => s.id));
  const multi = await db.snippets.filter(s =>
    !allIds.has(s.id) &&
    Array.isArray(s.projectIds) && s.projectIds.includes(projectId)
  ).toArray();
  return [...all, ...multi];
}

/**
 * Records that a project moved to a new column.
 * Stores a `columnHistory` array: [{ colId, enteredAt, exitedAt? }]
 */
async function recordColumnChange(projectId, newColId) {
  const p = await db.projects.get(projectId);
  if (!p || p.columnId === newColId) return;           // soltar en la misma columna no es un movimiento
  const now     = new Date().toISOString();
  const history = Array.isArray(p.columnHistory) ? [...p.columnHistory] : [];

  // Proyecto sin historial: reconstruye la estancia en la columna de origen desde su creación.
  if (!history.length && p.columnId) history.push({ colId: p.columnId, enteredAt: p.createdAt || now, exitedAt: null });

  // Close previous entry
  if (history.length > 0 && !history[history.length - 1].exitedAt) {
    history[history.length - 1].exitedAt = now;
  }
  // Open new entry
  history.push({ colId: newColId, enteredAt: now, exitedAt: null });

  await db.projects.update(projectId, {
    columnId:      newColId,
    columnHistory: history,
    updatedAt:     now
  });
  if (typeof Onboard !== 'undefined') Onboard.mark('moved');       // tour.js: «mueve un proyecto» de los primeros pasos
}

/** Returns array of { colTitle, colColor, daysSpent } sorted by enteredAt */
function computeColumnDurations(project, colMap) {
  const history = project.columnHistory || [];
  const now     = new Date();
  return history.map(entry => {
    const entered  = new Date(entry.enteredAt);
    const exited   = entry.exitedAt ? new Date(entry.exitedAt) : now;
    const days     = Math.max(0, Math.round((exited - entered) / 86400000));
    const col      = colMap[entry.colId];
    return { colId: entry.colId, colTitle: col?.title || '?', colColor: col?.color || '#888', days };
  });
}

/**
 * Saves a snapshot of the project fields before modifying.
 * Keeps up to MAX_HISTORY entries (FIFO).
 */
const MAX_HISTORY = 10;
async function snapshotProject(projectId) {
  const p = await db.projects.get(projectId);
  if (!p) return;
  const snapshot = {
    ts:          new Date().toISOString(),
    title:       p.title,
    type:        p.type,
    columnId:    p.columnId,
    responsible: p.responsible,
    priority:    p.priority,
    deadline:    p.deadline,
    description: p.description,
    tags:        p.tags,
  };
  const history = Array.isArray(p._history) ? [...p._history] : [];
  history.push(snapshot);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  await db.projects.update(projectId, { _history: history });
}

// -- snapshotIdea ------------------------------------
async function snapshotIdea(ideaId) {
  const idea = await db.ideas.get(ideaId);
  if (!idea) return;
  const snapshot = {
    ts:        new Date().toISOString(),
    title:     idea.title,
    content:   idea.content,
    status:    idea.status,
    projectId: idea.projectId,
    tags:      idea.tags,
  };
  const history = Array.isArray(idea._history) ? [...idea._history] : [];
  history.push(snapshot);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  await db.ideas.update(ideaId, { _history: history });
}

async function getDashboardStats() {
  const [projects, ideas, snippets, ideaUnread] = await Promise.all([
    db.projects.count(),
    db.ideas.count(),
    db.snippets.count(),
    db.ideas.where('status').equals('unread').count()
  ]);
  const recentProjects = await db.projects.orderBy('updatedAt').reverse().limit(4).toArray();
  return { projects, ideas, snippets, ideaUnread, recentProjects };
}

// -- Full export / import -------------------------------------

const BACKUP_TABLES = ['projects', 'ideas', 'snippets', 'resources', 'collaborators',
                       'kanbanColumns', 'snippetCollections', 'submissions', 'meetings', 'references', 'tasks'];

// Claves de Google Drive/auth que son device-specific y no deben exportarse
const _SETTINGS_EXCLUDE = new Set([
  'google_access_token', 'google_token_expiry',
  'google_drive_file_id', 'google_user_email',
  'backup-dir-handle', 'sync-dir-handle',       // handles de carpeta: no son serializables ni sirven en otro navegador
]);

// Claves device-specific que se preservan aunque se haga un reemplazo total
const _SETTINGS_PRESERVE = new Set([
  'google_access_token', 'google_token_expiry', 'google_drive_file_id',
  'google_user_email',   'google_sync_last',    'google_auto_sync',
  'google_auto_save_on_change', 'backup-dir-handle', 'sync-dir-handle',
]);

async function exportAllData() {
  const [projects, ideas, snippets, resources, collaborators,
         kanbanColumns, snippetCollections, submissions, meetings, references, tasks,
         allSettings] =
    await Promise.all([
      db.projects.toArray(),
      db.ideas.toArray(),
      db.snippets.toArray(),
      db.resources.toArray(),
      db.collaborators.toArray(),
      db.kanbanColumns.toArray(),
      db.snippetCollections.toArray(),
      db.submissions.toArray(),
      db.meetings.toArray(),
      db.references.toArray(),
      db.tasks.toArray(),
      db.settings.toArray(),
    ]);

  // Excluir credenciales y tokens device-specific
  const settings = allSettings.filter(s => !_SETTINGS_EXCLUDE.has(s.key));

  return JSON.stringify(
    { _app: 'ResearchOS', _version: 3, exportedAt: new Date().toISOString(),
      projects, ideas, snippets, resources, collaborators,
      kanbanColumns, snippetCollections,
      submissions, meetings, references, tasks, settings },
    null, 2
  );
}

/**
 * Valida y normaliza un backup antes de tocar la BD.
 * - Rechaza JSON que no parezca de ResearchOS (evita que "Reemplazar" vacíe la BD con un archivo cualquiera).
 * - Fuerza los tipos que luego se interpolan en HTML (fechas, colores, ids, lenguajes).
 * Devuelve un objeto nuevo; no modifica la entrada.
 */
function sanitizeBackup(raw) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(raw))
    throw new Error('El archivo no es un backup de ResearchOS');
  if (!BACKUP_TABLES.some(t => Array.isArray(raw[t])))
    throw new Error('El archivo no contiene datos de ResearchOS (proyectos, ideas, snippets…)');

  const num   = v => (v === null || v === '' || v === undefined || !Number.isFinite(+v)) ? null : +v;
  const nums  = a => Array.isArray(a) ? a.map(num).filter(v => v !== null) : [];
  const strs  = a => Array.isArray(a) ? a.map(x => String(x ?? '').trim()).filter(Boolean) : [];
  const str   = v => v == null ? '' : String(v);
  const rows  = t => (Array.isArray(raw[t]) ? raw[t] : []).filter(isObj).map(r => ({ ...r }));
  const withId = r => {
    const id = num(r.id); if (id !== null && id > 0) r.id = id; else delete r.id;
    if (typeof r.uid !== 'string' || !/^[\w:.-]{6,80}$/.test(r.uid)) delete r.uid;       // uid ajeno inválido → se regenera
    return r;
  };
  const items = (a, textKey = 'text') => (Array.isArray(a) ? a : []).filter(isObj).map((x, i) => ({
    ...x, id: num(x.id) ?? (Date.now() + i), [textKey]: str(x[textKey]), done: !!x.done,
    due: isoDateOrNull(x.due), assigneeId: num(x.assigneeId), doneAt: x.done ? (str(x.doneAt) || null) : null }));

  // Los registros sin sello de tiempo desaparecerían de las listas ordenadas por createdAt/updatedAt (índices de IndexedDB).
  const now = new Date().toISOString();
  const stamps = r => ({ createdAt: str(r.createdAt) || now, updatedAt: str(r.updatedAt) || str(r.createdAt) || now });

  const out = {};
  out.kanbanColumns = rows('kanbanColumns').map((r, i) => withId({
    ...r, title: str(r.title) || 'Columna', color: cssColor(r.color, '#38bdf8'),
    order: num(r.order) ?? i, wip: num(r.wip) || null,
    ...(r.types !== undefined ? { types: strs(r.types).filter(t => ['Proyecto', 'Grant', 'Paper', 'Análisis', 'Dataset', 'Presentación', 'Curso'].includes(t)) } : {}) }));
  out.snippetCollections = rows('snippetCollections').map(r => withId({
    ...r, name: str(r.name) || 'Colección', color: cssColor(r.color, '#38bdf8') }));
  out.collaborators = rows('collaborators').map(r => withId({ ...r, name: str(r.name) || '?', createdAt: str(r.createdAt) || now,
    lastContact: isoDateOrNull(r.lastContact), followSnoozeUntil: isoDateOrNull(r.followSnoozeUntil),
    followUpDays: [7, 14, 30, 90, 180].includes(+r.followUpDays) ? +r.followUpDays : null,
    ...(r.private !== undefined ? { private: !!r.private } : {}) }));
  out.projects = rows('projects').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), tags: strs(r.tags), coauthors: strs(r.coauthors),
    deadline: isoDateOrNull(r.deadline), columnId: num(r.columnId), parentId: num(r.parentId),
    areaId: num(r.areaId), responsibleId: num(r.responsibleId), coauthorIds: nums(r.coauthorIds),
    archived: !!r.archived, starred: !!r.starred,
    ...(r.submittedAt !== undefined ? { submittedAt: isoDateOrNull(r.submittedAt) } : {}),
    ...(r.rank !== undefined ? { rank: Tasks.cleanRank(r.rank) } : {}),
    ...(r.paused !== undefined ? { paused: !!r.paused } : {}),
    ...(r.pausedUntil !== undefined || r.pauseReason !== undefined ? { pausedUntil: isoDateOrNull(r.pausedUntil), pauseReason: str(r.pauseReason).slice(0, 300) } : {}),
    ...(r.private !== undefined ? { private: !!r.private } : {}),
    ...(Array.isArray(r.submissionRounds) ? { submissionRounds: r.submissionRounds.filter(isObj).map(x => ({
        ...x, submittedAt: isoDateOrNull(x.submittedAt), decisionDate: isoDateOrNull(x.decisionDate),
        decision: ['major', 'minor', 'reject', 'accept', 'pending'].includes(x.decision) ? x.decision : 'pending' })) } : {}),
    ...(Array.isArray(r.columnHistory) ? { columnHistory: r.columnHistory.filter(isObj).map(h => ({ ...h, colId: num(h.colId) })) } : {}),
  }));
  out.ideas = rows('ideas').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), content: str(r.content), tags: strs(r.tags),
    projectId: num(r.projectId), projectIds: nums(r.projectIds), source: Tasks.cleanSource(r.source),
    deadline: isoDateOrNull(r.deadline) }));
  out.snippets = rows('snippets').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), code: str(r.code),
    language: str(r.language).replace(/[^\w+#. -]/g, '').trim() || 'Other', tags: strs(r.tags),
    projectId: num(r.projectId), projectIds: nums(r.projectIds), collectionId: num(r.collectionId) }));
  out.meetings = rows('meetings').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), date: isoDateOrNull(r.date) || localDateISO(),
    time: timeOrNull(r.time), duration: durationOrNull(r.duration), source: Tasks.cleanSource(r.source),
    projectId: num(r.projectId), actionItems: items(r.actionItems),
    ...(r.recurrence !== undefined ? { recurrence: Tasks.cleanRecurrence(r.recurrence) } : {}),
    ...(r.seriesId !== undefined ? { seriesId: str(r.seriesId).slice(0, 80) } : {}),
    ...(r.private !== undefined ? { private: !!r.private } : {}) }));
  out.references = rows('references').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), tags: strs(r.tags), projectId: num(r.projectId),
    year: Number.isInteger(+r.year) && +r.year > 0 ? +r.year : null,
    readStatus: ['toread', 'reading', 'read'].includes(r.readStatus) ? r.readStatus : null, citeKey: str(r.citeKey),
    readAt: r.readStatus === 'read' ? (str(r.readAt) || null) : null }));
  // Tareas. Los backups anteriores guardaban "subtareas" dentro de proyectos e ideas: se convierten en tareas.
  const mkTask = (t, extra) => ({ title: str(t.title ?? t.text), done: !!t.done, doneAt: t.done ? (str(t.doneAt) || now) : null,
    due: isoDateOrNull(t.due), projectId: null, ideaId: null, areaId: num(t.areaId),
    assigneeId: num(t.assigneeId), recurrence: Tasks.cleanRecurrence(t.recurrence), effort: Tasks.cleanEffort(t.effort), planDate: isoDateOrNull(t.planDate),
    notes: Tasks.cleanNotes(t.notes), link: Tasks.cleanLink(t.link), source: Tasks.cleanSource(t.source),
    ownerId: num(t.ownerId), afterIds: Tasks.cleanAfter(t.afterIds), rank: Tasks.cleanRank(t.rank), spent: Tasks.cleanSpent(t.spent), event: Tasks.cleanSource(t.event), private: !!t.private,
    priority: ['Alta', 'Media', 'Baja'].includes(t.priority) ? t.priority : null, ...(t.uid !== undefined ? { uid: t.uid } : {}), ...stamps(t), ...extra });
  if (Array.isArray(raw.tasks)) {
    out.tasks = rows('tasks').map(r => withId(mkTask(r, { projectId: num(r.projectId), ideaId: num(r.ideaId) })));
  } else {
    out.tasks = [];
    for (const p of out.projects) for (const t of (Array.isArray(p.subtasks) ? p.subtasks : []).filter(isObj))
      if (p.id != null) out.tasks.push(mkTask(t, { projectId: p.id }));
    for (const i of out.ideas) for (const t of (Array.isArray(i.subtasks) ? i.subtasks : []).filter(isObj))
      if (i.id != null) out.tasks.push(mkTask(t, { ideaId: i.id, projectId: i.projectId ?? null }));
  }
  out.projects.forEach(p => { p.subtasks = []; });
  out.ideas.forEach(i => { i.subtasks = []; });

  out.submissions = rows('submissions').map(r => withId({ ...r, projectId: num(r.projectId) }));
  out.resources   = rows('resources').map(r => withId({ ...r, projectId: num(r.projectId), ideaId: num(r.ideaId) }));

  // settings: solo pares {key, value}; los JSON con colores se normalizan
  const COLOR_JSON = new Set(['ros-areas', 'ros-sub-stages']);
  out.settings = (Array.isArray(raw.settings) ? raw.settings : []).filter(s => isObj(s) && typeof s.key === 'string')
    .map(s => {
      if (!COLOR_JSON.has(s.key)) return { ...s };
      try {
        const arr = JSON.parse(s.value);
        if (!Array.isArray(arr)) return null;
        return { key: s.key, value: JSON.stringify(arr.filter(isObj).map(x => ({ ...x, color: cssColor(x.color) }))) };
      } catch { return null; }
    }).filter(Boolean);

  return out;
}

function _parseBackup(input) {
  return sanitizeBackup(typeof input === 'string' ? JSON.parse(input) : input);
}

/** Reemplaza TODOS los datos por los del backup. Valida antes de borrar; la transacción es atómica. */
async function importAllData(jsonString) {
  const data = _parseBackup(jsonString);
  SyncState.legacy++; SyncState.applying++;                // registros sin uid → uid determinista; sin tocar updatedAt
  try {
  await db.transaction('rw',
    [db.projects, db.ideas, db.snippets, db.resources, db.collaborators,
     db.kanbanColumns, db.snippetCollections, db.submissions, db.meetings,
     db.references, db.tasks, db.settings, db.tombstones],
    async () => {
      // Rescatar settings device-specific antes de limpiar
      const preserved = await db.settings
        .filter(s => _SETTINGS_PRESERVE.has(s.key))
        .toArray();
      // Lo que existía y ya no estará debe borrarse también en los demás dispositivos
      const previous = [];
      for (const t of SYNC_TABLES) for (const r of await db[t].toArray()) if (r.uid) previous.push({ uid: r.uid, table: t });
      await db.tombstones.clear();

      await Promise.all([
        db.projects.clear(),           db.ideas.clear(),
        db.snippets.clear(),           db.resources.clear(),
        db.collaborators.clear(),      db.kanbanColumns.clear(),
        db.snippetCollections.clear(), db.submissions.clear(),
        db.meetings.clear(),           db.references.clear(),
        db.tasks.clear(),              db.settings.clear(),
      ]);

      // Settings del backup (sin credenciales) + settings device-specific preservadas
      const importedSettings = data.settings.filter(s => !_SETTINGS_PRESERVE.has(s.key));

      await Promise.all([
        db.projects.bulkAdd(data.projects),
        db.ideas.bulkAdd(data.ideas),
        db.snippets.bulkAdd(data.snippets),
        db.resources.bulkAdd(data.resources),
        db.collaborators.bulkAdd(data.collaborators),
        db.kanbanColumns.bulkAdd(data.kanbanColumns),
        db.snippetCollections.bulkAdd(data.snippetCollections),
        db.submissions.bulkAdd(data.submissions),
        db.meetings.bulkAdd(data.meetings),
        db.references.bulkAdd(data.references),
        db.tasks.bulkAdd(data.tasks),
        db.settings.bulkPut([...importedSettings, ...preserved]),
      ]);
      const kept = new Set();
      for (const t of SYNC_TABLES) for (const r of await db[t].toArray()) kept.add(r.uid);
      const now = new Date().toISOString();
      const gone = previous.filter(x => !kept.has(x.uid)).map(x => ({ ...x, deletedAt: now }));
      if (gone.length) await db.tombstones.bulkAdd(gone);
    }
  );
  } finally { SyncState.legacy--; SyncState.applying--; }
  // Un backup sin columnas dejaría el Kanban vacío e inutilizable.
  await seedDefaults();
  return Object.fromEntries(BACKUP_TABLES.map(t => [t, data[t].length]));
}

/**
 * Importa en modo merge: añade lo que falta sin tocar lo existente.
 * - Un registro "ya existe" si coincide su identidad (createdAt+título/nombre; columnas y colecciones por nombre),
 *   no por id: dos dispositivos generan los mismos ids para registros distintos.
 * - Los registros nuevos cuyo id choca con uno local reciben un id nuevo, y las referencias
 *   (columna, proyecto, padre, colaboradores, colección, área) se reescriben.
 * Devuelve { added: {tabla: n}, skipped: {tabla: n} }.
 */
async function mergeAllData(jsonString) {
  const data = _parseBackup(jsonString);
  const summary = { added: {}, skipped: {} };
  const bump = (kind, t) => { summary[kind][t] = (summary[kind][t] || 0) + 1; };

  SyncState.legacy++; SyncState.applying++;
  try {
  await db.transaction('rw',
    [db.projects, db.ideas, db.snippets, db.resources,
     db.collaborators, db.kanbanColumns, db.snippetCollections,
     db.submissions, db.meetings, db.references, db.tasks, db.settings],
    async () => {
      const maps = { kanbanColumns: new Map(), collaborators: new Map(), snippetCollections: new Map(),
                     projects: new Map(), ideas: new Map(), areas: new Map() };
      const label = r => foldText(r.title ?? r.name ?? '').trim();
      const keyByTitle    = r => label(r);
      const keyByIdentity = r => `${r.createdAt || ''}|${label(r)}`;
      // Identidad real = uid. Un registro sin uid (backup antiguo) se reconoce por su uid determinista o, si no, por contenido.
      const uidOf = (name, r) => r.uid || legacyUid(name, r);
      const mapId  = (m, v) => (v == null ? null : (m.get(v) ?? null));
      const mapIds = (m, a) => (a || []).map(v => m.get(v)).filter(v => v != null);

      const mergeTable = async (name, keyFn, translate) => {
        const table    = db[name];
        const existing = await table.toArray();
        const byKey    = new Map(existing.map(r => [keyFn(r), r]));
        const byUid    = new Map(existing.filter(r => r.uid).map(r => [r.uid, r]));
        const usedIds  = new Set(existing.map(r => r.id));
        const added    = [];
        for (const raw of data[name]) {
          const rec   = translate ? translate({ ...raw }) : { ...raw };
          const twin  = byUid.get(uidOf(name, rec)) || (rec.uid ? null : byKey.get(keyFn(rec)));
          if (twin) { maps[name]?.set(raw.id, twin.id); bump('skipped', name); continue; }
          if (rec.id != null && usedIds.has(rec.id)) delete rec.id;
          const newId = await table.add(rec);
          usedIds.add(newId);
          byKey.set(keyFn(rec), { ...rec, id: newId });
          if (rec.uid || SyncState.legacy) byUid.set(uidOf(name, rec), { ...rec, id: newId });
          maps[name]?.set(raw.id, newId);
          added.push({ newId, raw });
          bump('added', name);
        }
        return added;
      };

      // 1) Áreas (viven en settings como JSON): se unifican por nombre y se reasignan ids
      const incomingAreasS = data.settings.find(s => s.key === 'ros-areas');
      if (incomingAreasS) {
        const local = JSON.parse((await db.settings.get('ros-areas'))?.value || '[]');
        const used  = new Set(local.map(a => a.id));
        let nextId  = Math.max(0, ...local.map(a => +a.id || 0)) + 1;
        for (const a of JSON.parse(incomingAreasS.value)) {
          const twin = local.find(l => foldText(l.name) === foldText(a.name));
          if (twin) { maps.areas.set(a.id, twin.id); continue; }
          const id = (a.id != null && !used.has(a.id)) ? a.id : nextId++;
          used.add(id); local.push({ ...a, id }); maps.areas.set(a.id, id);
        }
        await db.settings.put({ key: 'ros-areas', value: JSON.stringify(local) });
      }

      // 2) Entidades sin dependencias
      await mergeTable('kanbanColumns', keyByTitle);
      await mergeTable('collaborators', r => `${foldText(r.name)}|${foldText(r.email || '')}`);
      await mergeTable('snippetCollections', keyByTitle);

      // 3) Proyectos (parentId se resuelve después, cuando ya existen todos)
      const firstCol = (await db.kanbanColumns.orderBy('order').first())?.id ?? null;
      const addedProjects = await mergeTable('projects', keyByIdentity, r => ({
        ...r,
        columnId:      mapId(maps.kanbanColumns, r.columnId) ?? firstCol,
        responsibleId: mapId(maps.collaborators, r.responsibleId),
        coauthorIds:   mapIds(maps.collaborators, r.coauthorIds),
        areaId:        mapId(maps.areas, r.areaId),
        columnHistory: r.columnHistory?.map(h => ({ ...h, colId: maps.kanbanColumns.get(h.colId) ?? h.colId })),
      }));
      for (const { newId, raw } of addedProjects) {
        await db.projects.update(newId, { parentId: mapId(maps.projects, raw.parentId) });
      }

      // 4) Entidades que cuelgan de proyectos
      const proj = r => ({ ...r, projectId: mapId(maps.projects, r.projectId) });
      const multi = r => ({ ...proj(r), projectIds: mapIds(maps.projects, r.projectIds) });
      await mergeTable('ideas',      keyByIdentity, multi);
      await mergeTable('snippets',   keyByIdentity, r => ({ ...multi(r), collectionId: mapId(maps.snippetCollections, r.collectionId) }));
      await mergeTable('meetings',   keyByIdentity, r => ({ ...proj(r), actionItems: (r.actionItems || []).map(a => ({ ...a, assigneeId: mapId(maps.collaborators, a.assigneeId) })) }));   // los pasos asignados siguen apuntando a la persona correcta
      await mergeTable('references', keyByIdentity, proj);
      await mergeTable('submissions', keyByIdentity, proj);
      await mergeTable('resources',  keyByIdentity, r => ({ ...proj(r), ideaId: null }));
      await mergeTable('tasks',      keyByIdentity, r => ({ ...proj(r), ideaId: mapId(maps.ideas, r.ideaId),
                                                            assigneeId: mapId(maps.collaborators, r.assigneeId),
                                                            areaId: r.projectId ? null : mapId(maps.areas, r.areaId) }));

      // 5) Settings: solo claves que no existen localmente (y nunca credenciales)
      const have = new Set((await db.settings.toArray()).map(s => s.key));
      const fresh = data.settings.filter(s => !_SETTINGS_PRESERVE.has(s.key) && !have.has(s.key));
      if (fresh.length) await db.settings.bulkAdd(fresh);
    }
  );
  } finally { SyncState.legacy--; SyncState.applying--; }
  return summary;
}

/**
 * Elimina una idea junto con sus tareas (eran su lista de subtareas). Devuelve `undo()` que lo restaura todo.
 */
async function deleteIdeaCascade(id) {
  let idea = null, tasks = [];
  await db.transaction('rw', [db.ideas, db.tasks], async () => {
    idea  = await db.ideas.get(id);
    if (!idea) return;
    tasks = await db.tasks.where('ideaId').equals(id).toArray();
    await db.tasks.bulkDelete(tasks.map(t => t.id));
    await db.ideas.delete(id);
  });
  return async () => { if (!idea) return; await db.ideas.put(idea); if (tasks.length) await db.tasks.bulkPut(tasks); };
}

/** Texto legible de un resultado de merge: "12 nuevos · 3 ya existían". */
function describeMerge(summary) {
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  const n = sum(summary.added), k = sum(summary.skipped);
  return `${n} registro(s) nuevo(s)${k ? ` · ${k} ya existía(n)` : ''}`;
}

/** Borra los datos del usuario (todas las tablas) y vuelve al estado inicial. Conserva la sesión de Google. */
async function clearAllData() {
  await db.transaction('rw',
    [db.projects, db.ideas, db.snippets, db.resources, db.collaborators,
     db.kanbanColumns, db.snippetCollections, db.submissions, db.meetings,
     db.references, db.tasks, db.settings, db.tombstones],
    async () => {
      const now = new Date().toISOString(), gone = [];
      for (const t of SYNC_TABLES) for (const r of await db[t].toArray()) if (r.uid) gone.push({ uid: r.uid, table: t, deletedAt: now });
      await db.tombstones.clear();
      await db.tombstones.bulkAdd(gone);
      await Promise.all([
        db.projects.clear(),           db.ideas.clear(),
        db.snippets.clear(),           db.resources.clear(),
        db.collaborators.clear(),      db.kanbanColumns.clear(),
        db.snippetCollections.clear(), db.submissions.clear(),
        db.meetings.clear(),           db.references.clear(),
        db.tasks.clear(),
      ]);
      await db.settings.filter(s => !_SETTINGS_PRESERVE.has(s.key)).delete();
    });
  await seedDefaults();
}

/**
 * Elimina un proyecto sin dejar referencias colgantes:
 * los subproyectos suben un nivel y ideas/snippets/reuniones/referencias/submissions/recursos quedan "sin proyecto".
 * Devuelve una función `undo()` que restaura todo tal como estaba.
 */
async function deleteProjectCascade(id) {
  const restore = [];   // [tabla, id, campos previos]
  let snapshot = null;
  await db.transaction('rw',
    [db.projects, db.ideas, db.snippets, db.meetings, db.references, db.submissions, db.resources, db.tasks],
    async () => {
      snapshot = await db.projects.get(id);
      if (!snapshot) return;
      // Las tareas del proyecto pasan a ser tareas sueltas y conservan su área, para no perderlas.
      for (const t of await db.tasks.where('projectId').equals(id).toArray()) {
        restore.push(['tasks', t.id, { projectId: id, areaId: t.areaId ?? null }]);
        await db.tasks.update(t.id, { projectId: null, areaId: snapshot.areaId ?? null });
      }
      for (const c of await db.projects.where('parentId').equals(id).toArray()) {
        restore.push(['projects', c.id, { parentId: c.parentId }]);
        await db.projects.update(c.id, { parentId: snapshot.parentId ?? null });
      }
      for (const t of ['ideas', 'snippets']) {
        const hits = await db[t].filter(r => r.projectId === id || (r.projectIds || []).includes(id)).toArray();
        for (const r of hits) {
          const projectIds = (r.projectIds || []).filter(x => x !== id);
          restore.push([t, r.id, { projectId: r.projectId ?? null, projectIds: r.projectIds }]);
          await db[t].update(r.id, { projectId: r.projectId === id ? (projectIds[0] ?? null) : r.projectId, projectIds });
        }
      }
      for (const t of ['meetings', 'references', 'submissions', 'resources']) {
        for (const r of await db[t].where('projectId').equals(id).toArray()) {
          restore.push([t, r.id, { projectId: id }]);
          await db[t].update(r.id, { projectId: null });
        }
      }
      await db.projects.delete(id);
    });
  return async () => {
    if (!snapshot) return;
    await db.projects.put(snapshot);
    for (const [t, rid, fields] of restore) await db[t].update(rid, fields);
  };
}

// -- Importar referencias: BibTeX y RIS ------------------------
/** Convierte los comandos LaTeX más comunes de un campo BibTeX en texto plano (acentos, &, %, llaves). */
function _unTeX(v) {
  const acc = { "'": '\u0301', '`': '\u0300', '"': '\u0308', '^': '\u0302', '~': '\u0303', 'c': '\u0327' };
  return String(v ?? '')
    .replace(/\\([`'"^~c])\s*\{?\\?([A-Za-z])\}?/g, (m, a, ch) => (ch + acc[a]).normalize('NFC'))
    .replace(/\\(&|%|_|#|\$)/g, '$1')
    .replace(/\\ss\b/g, 'ß').replace(/\\o\b/g, 'ø').replace(/\\O\b/g, 'Ø').replace(/\\aa\b/g, 'å').replace(/\\ae\b/g, 'æ')
    .replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function _bibClosing(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return text.length - 1;
}

/** Lee un archivo .bib → [{ type, key, fields }] (campos en minúsculas, ya sin LaTeX). */
function parseBibtex(text) {
  const src = String(text ?? '');
  const out = [];
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    const m = /^@\s*([A-Za-z]+)\s*([{(])/.exec(src.slice(at, at + 60));
    if (!m) { i = at + 1; continue; }
    const type = m[1].toLowerCase();
    const open = at + m[0].length - 1;
    if (['comment', 'string', 'preamble'].includes(type)) { i = _bibClosing(src, open) + 1; continue; }
    const end = m[2] === '{' ? _bibClosing(src, open) : src.indexOf(')', open);
    const body = src.slice(open + 1, end < 0 ? src.length : end);
    const comma = body.indexOf(',');
    const key = (comma < 0 ? body : body.slice(0, comma)).trim();
    const fields = {};
    let pos = comma < 0 ? body.length : comma + 1;
    while (pos < body.length) {
      while (pos < body.length && /[\s,]/.test(body[pos])) pos++;
      const eq = body.indexOf('=', pos);
      if (eq < 0) break;
      const name = body.slice(pos, eq).trim().toLowerCase();
      pos = eq + 1;
      while (pos < body.length && /\s/.test(body[pos])) pos++;
      let value = '';
      if (body[pos] === '{') { const e = _bibClosing(body, pos); value = body.slice(pos + 1, e); pos = e + 1; }
      else if (body[pos] === '"') {
        let e = pos + 1, depth = 0;
        while (e < body.length && !(body[e] === '"' && depth === 0)) { if (body[e] === '\\') e++; else if (body[e] === '{') depth++; else if (body[e] === '}') depth--; e++; }
        value = body.slice(pos + 1, e); pos = e + 1;
      } else { const t = /^[^,\s]+/.exec(body.slice(pos)); value = t ? t[0] : ''; pos += value.length; }
      if (name) fields[name] = _unTeX(value);
    }
    if (Object.keys(fields).length) out.push({ type, key, fields });
    i = (end < 0 ? src.length : end) + 1;
  }
  return out;
}

/** Entradas .bib → registros de referencia de la app. */
function bibtexToReferences(entries) {
  return entries.map(({ key, fields: f }) => ({
    title: f.title || '', citeKey: key || '',
    authors: (f.author || '').split(/\s+and\s+/i).map(a => a.trim()).filter(Boolean).join('; '),
    year: Number.isInteger(+(String(f.year || f.date || '').match(/\d{4}/) || [])[0]) ? +String(f.year || f.date).match(/\d{4}/)[0] : null,
    journal: f.journal || f.booktitle || f.publisher || '', doi: (f.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''),
    url: f.url || '', volume: f.volume || '', pages: (f.pages || '').replace(/--+/g, '–'),
    tags: (f.keywords || '').split(/[,;]/).map(t => t.trim()).filter(Boolean), notes: (f.abstract || f.note || '').slice(0, 1500),
  })).filter(r => r.title);
}

/** Lee un archivo RIS → registros de referencia. */
function parseRIS(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/.exec(raw);
    if (!m) continue;
    const [, tag, val] = m, v = val.trim();
    if (tag === 'TY') { cur = { authors: [], tags: [], sp: '', ep: '' }; continue; }
    if (!cur) continue;
    if (tag === 'ER') {
      out.push({ title: cur.title || '', citeKey: '', authors: cur.authors.join('; '), year: cur.year || null,
        journal: cur.journal || '', doi: cur.doi || '', url: cur.url || '', volume: cur.volume || '',
        pages: [cur.sp, cur.ep].filter(Boolean).join('–'), tags: cur.tags, notes: (cur.notes || '').slice(0, 1500) });
      cur = null; continue;
    }
    if (tag === 'AU' || tag === 'A1') cur.authors.push(v);
    else if (tag === 'TI' || tag === 'T1') cur.title = cur.title || v;
    else if (tag === 'JO' || tag === 'JF' || tag === 'T2' || tag === 'JA') cur.journal = cur.journal || v;
    else if (tag === 'PY' || tag === 'Y1' || tag === 'DA') { const y = (v.match(/\d{4}/) || [])[0]; if (y && !cur.year) cur.year = +y; }
    else if (tag === 'DO') cur.doi = v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    else if (tag === 'UR') cur.url = cur.url || v;
    else if (tag === 'VL') cur.volume = v;
    else if (tag === 'SP') cur.sp = v;
    else if (tag === 'EP') cur.ep = v;
    else if (tag === 'KW') cur.tags.push(v);
    else if (tag === 'AB' || tag === 'N2') cur.notes = v;
  }
  return out.filter(r => r.title);
}

/** Clave de duplicados de una referencia: DOI si hay, si no título+año sin tildes. */
const refDedupeKey = r => r.doi ? `doi:${foldText(r.doi).trim()}` : `t:${foldText(r.title).replace(/[^a-z0-9]/g, '')}|${r.year || ''}`;

/** Guarda referencias nuevas (omite las que ya existen). Devuelve { added, skipped }. */
async function importReferences(records, { projectId = null } = {}) {
  const existing = new Set((await db.references.toArray()).map(refDedupeKey));
  const now = new Date().toISOString();
  const fresh = [];
  for (const r of records) {
    const k = refDedupeKey(r);
    if (existing.has(k)) continue;
    existing.add(k);
    fresh.push({ ...r, projectId, readStatus: 'toread', createdAt: now, updatedAt: now });
  }
  if (fresh.length) await db.references.bulkAdd(fresh);
  return { added: fresh.length, skipped: records.length - fresh.length };
}

// -- Calendario .ics ---------------------------------------------
const _icsEsc = v => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const _icsDate = iso => iso.replace(/-/g, '');
function _icsFold(line) {                                  // líneas de ≤ 70 caracteres, continuación con espacio
  const out = []; let rest = line;
  while (rest.length > 70) { out.push(rest.slice(0, 70)); rest = ' ' + rest.slice(70); }
  out.push(rest);
  return out.join('\r\n');
}

/** Genera un .ics (eventos de día completo) con fechas límite, tareas con fecha y reuniones. */
async function buildICS() {
  const [projects, tasks, meetings, collabs] = await Promise.all([
    db.projects.toArray(), db.tasks.toArray(), db.meetings.toArray(), db.collaborators.toArray()]);
  const who = Object.fromEntries(collabs.map(c => [c.id, c.name]));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ResearchOS//ES', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:ResearchOS'];
  const event = ({ uid, date, summary, desc = '', rrule = '', time = null, duration = null, url = '' }) => {
    if (time) {                                            // reunión con hora: evento con hora (hora local «flotante») y duración
      const t = x => x.replace(':', '') + '00';
      lines.push('BEGIN:VEVENT', `UID:${uid}@researchos`, `DTSTAMP:${stamp}`, `DTSTART:${_icsDate(date)}T${t(time)}`,
        `DTEND:${_icsDate(date)}T${t(addMinutesToTime(time, duration || 60))}`, `SUMMARY:${_icsEsc(summary)}`);
    } else {
      const end = new Date(date + 'T12:00:00'); end.setDate(end.getDate() + 1);
      lines.push('BEGIN:VEVENT', `UID:${uid}@researchos`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${_icsDate(date)}`,
        `DTEND;VALUE=DATE:${_icsDate(localDateISO(end))}`, `SUMMARY:${_icsEsc(summary)}`);
    }
    if (url) lines.push(`URL:${url}`);
    if (desc) lines.push(`DESCRIPTION:${_icsEsc(desc)}`);
    if (rrule) lines.push(rrule);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  };
  for (const p of projects.filter(p => !p.archived && p.deadline))
    event({ uid: `p${p.id}`, date: p.deadline, summary: `⏱ Entrega: ${p.title}`, desc: `${p.type} · prioridad ${p.priority || '—'}` });
  for (const t of tasks.filter(t => !t.done && t.due)) {
    const r = t.recurrence;
    const rrule = r ? `RRULE:FREQ=${r.freq.toUpperCase()};INTERVAL=${r.interval}${r.until ? `;UNTIL=${_icsDate(r.until)}` : ''}` : '';
    event({ uid: `t${t.id}`, date: t.due, summary: `${t.assigneeId ? '⏳' : '☐'} ${t.title}`, rrule,
            desc: [t.assigneeId ? `Esperando a ${who[t.assigneeId] || 'otra persona'}` : '', t.notes || ''].filter(Boolean).join(' · '), url: t.link || '' });
  }
  for (const m of meetings.filter(m => m.date))
    event({ uid: `m${m.id}`, date: m.date, time: m.time, duration: m.duration, summary: `🗓 ${m.title}`, desc: m.participants ? `Participantes: ${m.participants}` : '' });
  lines.push('END:VCALENDAR');
  return lines.map(_icsFold).join('\r\n') + '\r\n';
}

/**
 * Lee un .ics → [{ title, date }] con los eventos de [from, to] (expande repeticiones diarias, semanales y mensuales).
 * Soporta DTSTART con fecha, fecha-hora local o UTC (Z), INTERVAL, COUNT, UNTIL y BYDAY.
 */
function parseICS(text, { from = localDateISO(), to = null, cap = 400 } = {}) {
  const unfolded = String(text ?? '').replace(/\r?\n[ \t]/g, '');
  const toDate = new Date(from + 'T12:00:00'); toDate.setDate(toDate.getDate() + 90);
  const limit = to || localDateISO(toDate);
  const blocks = unfolded.split(/BEGIN:VEVENT/i).slice(1).map(b => b.split(/END:VEVENT/i)[0]);
  const prop = (b, name) => { const m = new RegExp(`^${name}([;:][^\\r\\n]*)$`, 'im').exec(b); return m ? m[1] : null; };
  const unesc = v => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
  // → { date, time|null }: fecha local y, si el evento tiene hora, «HH:MM» (UTC se pasa a hora local; la hora con zona o flotante se toma tal cual)
  const parseDT = raw => {
    const m = /(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
    if (!m) return null;
    if (m[7]) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])); return { date: localDateISO(d), time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }; }
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] != null ? `${m[4]}:${m[5]}` : null };
  };
  const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const events = [];
  for (const b of blocks) {
    const sm = prop(b, 'SUMMARY'); const ds = prop(b, 'DTSTART');
    if (!sm || !ds) continue;
    const dt = parseDT(ds.split(':').pop());
    if (!dt) continue;
    const start = dt.date;
    const de = prop(b, 'DTEND'), end = de && dt.time ? parseDT(de.split(':').pop()) : null;      // duración: solo si ambas puntas tienen hora y caen el mismo día
    const duration = end?.time && end.date === dt.date ? durationOrNull((+end.time.slice(0, 2) * 60 + +end.time.slice(3)) - (+dt.time.slice(0, 2) * 60 + +dt.time.slice(3))) : null;
    const title = unesc(sm.slice(sm.indexOf(':') + 1));
    const rr = prop(b, 'RRULE');
    const rule = rr ? Object.fromEntries(rr.slice(1).split(';').map(kv => kv.split('='))) : null;
    const dates = [];
    if (!rule || !['DAILY', 'WEEKLY', 'MONTHLY'].includes(rule.FREQ)) dates.push(start);
    else {
      const interval = Math.max(1, +rule.INTERVAL || 1);
      // UNTIL se toma por su fecha tal cual (sin pasar a hora local): «hasta el 18» incluye el 18 aunque el sello venga en UTC
      const until = rule.UNTIL ? `${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}` : null;
      const count = rule.COUNT ? +rule.COUNT : Infinity;
      const days = rule.BYDAY ? rule.BYDAY.split(',').map(d => WD[d.slice(-2)]).filter(d => d !== undefined) : null;
      let produced = 0;
      const cur = new Date(start + 'T12:00:00');
      for (let guard = 0; guard < 4000 && produced < count; guard++) {
        const iso = localDateISO(cur);
        if (iso > limit || (until && iso > until)) break;
        if (rule.FREQ === 'WEEKLY' && days) {
          // todos los días BYDAY de esta semana (a partir del inicio), luego salta `interval` semanas
          const weekStart = new Date(cur); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
          for (const d of days.slice().sort((a, b) => a - b)) {
            const day = new Date(weekStart); day.setDate(day.getDate() + d);
            const di = localDateISO(day);
            if (di < start || di > limit || (until && di > until) || produced >= count) continue;
            dates.push(di); produced++;
          }
          cur.setDate(cur.getDate() + 7 * interval);
          continue;
        }
        dates.push(iso); produced++;
        if (rule.FREQ === 'DAILY') cur.setDate(cur.getDate() + interval);
        else if (rule.FREQ === 'WEEKLY') cur.setDate(cur.getDate() + 7 * interval);
        else cur.setMonth(cur.getMonth() + interval);
      }
    }
    for (const date of dates) if (date >= from && date <= limit) events.push({ title, date, time: dt.time, duration });
    if (events.length >= cap) break;
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title)).slice(0, cap);
}

// -- Meetings helpers -----------------------------------------
async function getMeetings(projectId = null) {
  if (projectId) return db.meetings.where('projectId').equals(projectId).toArray();
  return db.meetings.orderBy('date').reverse().toArray();
}

// -- References helpers ---------------------------------------
// Se ordena en JS: `orderBy('year')` omitiría las referencias sin año (null no es una clave válida de IndexedDB).
async function getReferences(projectId = null) {
  const all = projectId
    ? await db.references.where('projectId').equals(projectId).toArray()
    : await db.references.toArray();
  return all.sort((a, b) => (b.year || 0) - (a.year || 0) || String(a.title).localeCompare(String(b.title)));
}

/** Escapa los caracteres especiales de LaTeX/BibTeX en un campo de texto. */
function _bibEscape(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Convierte el campo libre "autores" al formato BibTeX ("Apellido, N. and Apellido2, N2.").
 * Acepta "García, J., Vega, M." (apellido, iniciales), "Juan García, Marta Vega", "A and B" o "A; B".
 */
function _bibAuthors(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/\s+and\s+|;|\n/.test(text)) return text.split(/\s+and\s+|;|\n/).map(a => a.trim()).filter(Boolean).map(_bibEscape).join(' and ');
  const parts = text.split(',').map(t => t.trim()).filter(Boolean);
  const looksInitials = t => t.length <= 12 && /^([A-ZÀ-Ý][\p{L}.\-]*\.?\s*){1,3}$/u.test(t);
  const paired = parts.length >= 2 && parts.length % 2 === 0 && parts.every((t, i) => i % 2 === 0 || looksInitials(t));
  if (paired) {
    const out = [];
    for (let i = 0; i < parts.length; i += 2) out.push(`${parts[i]}, ${parts[i + 1]}`);
    return out.map(_bibEscape).join(' and ');
  }
  return parts.map(_bibEscape).join(' and ');
}

function _bibAscii(s) { return foldText(s).replace(/[^a-z0-9]/g, ''); }

async function exportBibtex(projectId = null) {
  const refs = await getReferences(projectId);
  const used = new Map();
  return refs.map(r => {
    const firstAuthor = String(r.authors || '').split(/\s+and\s+|;|,/)[0].trim().split(/\s+/).pop();
    const base = (_bibAscii(firstAuthor) || 'ref') + (r.year || 'nd');
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    const key = n ? `${base}${String.fromCharCode(96 + n)}` : base;      // garcia2021, garcia2021a, garcia2021b…
    const venue = String(r.journal || '');
    const isConf = /conference|proceedings|symposium|workshop|congress|congreso|meeting/i.test(venue);
    const fields = [
      ['author',    _bibAuthors(r.authors)],
      ['title',     _bibEscape(r.title)],
      [isConf ? 'booktitle' : 'journal', _bibEscape(venue)],
      ['year',      r.year || ''],
      ['volume',    _bibEscape(r.volume)],
      ['pages',     _bibEscape(r.pages).replace(/\s*[-–—]+\s*/g, '--')],
      ['doi',       String(r.doi || '').trim()],
      ['url',       String(r.url || '').trim()],
    ].filter(([, v]) => String(v).trim() !== '');
    const w = Math.max(...fields.map(([k]) => k.length));
    return `@${isConf ? 'inproceedings' : 'article'}{${key},\n` +
      fields.map(([k, v]) => `  ${k.padEnd(w)} = {${v}}`).join(',\n') + '\n}';
  }).join('\n\n');
}

// -- Snippet Collections helpers ------------------------------
async function getCollections() {
  return db.snippetCollections.orderBy('name').toArray();
}

async function createCollection(name, color = '#38bdf8') {
  return db.snippetCollections.add({ name, color, createdAt: new Date().toISOString() });
}
