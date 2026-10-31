
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
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
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

// -- Seed defaults on first run -------------------------------
async function seedDefaults() {
  const colCount = await db.kanbanColumns.count();
  if (colCount === 0) {
    await db.kanbanColumns.bulkAdd([
      { title: 'Ideación',          order: 0, color: '#3b82f6', isDefault: true },
      { title: 'Limpieza de Datos', order: 1, color: '#f59e0b', isDefault: true },
      { title: 'Análisis',          order: 2, color: '#8b5cf6', isDefault: true },
      { title: 'Escritura',         order: 3, color: '#10b981', isDefault: true },
      { title: 'Peer Review',       order: 4, color: '#f97316', isDefault: true },
      { title: 'Completado',        order: 5, color: '#14b8a6', isDefault: true },
    ]);
  }
}

// -- Query helpers --------------------------------------------

async function getKanbanData() {
  const [cols, projects] = await Promise.all([
    db.kanbanColumns.orderBy('order').toArray(),
    db.projects.filter(p => !p.archived).toArray()
  ]);
  return cols.map(col => ({
    ...col,
    cards: projects.filter(p => p.columnId === col.id)
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

/** Returns a map { 'YYYY-MM-DD': count } of activity over the last 365 days */
async function getActivityHeatmap() {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const sinceISO = since.toISOString();

  const [projects, ideas, snippets] = await Promise.all([
    db.projects.where('updatedAt').above(sinceISO).toArray(),
    db.ideas.where('updatedAt').above(sinceISO).toArray(),
    db.snippets.where('updatedAt').above(sinceISO).toArray(),
  ]);

  const map = {};
  const stamp = iso => iso ? localDateISO(new Date(iso)) : null;
  [...projects, ...ideas, ...snippets].forEach(item => {
    const d = stamp(item.updatedAt);
    if (d) map[d] = (map[d] || 0) + 1;
  });
  return map;
}

// -- Full export / import -------------------------------------

const BACKUP_TABLES = ['projects', 'ideas', 'snippets', 'resources', 'collaborators',
                       'kanbanColumns', 'snippetCollections', 'submissions', 'meetings', 'references'];

// Claves de Google Drive/auth que son device-specific y no deben exportarse
const _SETTINGS_EXCLUDE = new Set([
  'google_access_token', 'google_token_expiry',
  'google_drive_file_id', 'google_user_email',
]);

// Claves device-specific que se preservan aunque se haga un reemplazo total
const _SETTINGS_PRESERVE = new Set([
  'google_access_token', 'google_token_expiry', 'google_drive_file_id',
  'google_user_email',   'google_sync_last',    'google_auto_sync',
  'google_auto_save_on_change',
]);

async function exportAllData() {
  const [projects, ideas, snippets, resources, collaborators,
         kanbanColumns, snippetCollections, submissions, meetings, references,
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
      db.settings.toArray(),
    ]);

  // Excluir credenciales y tokens device-specific
  const settings = allSettings.filter(s => !_SETTINGS_EXCLUDE.has(s.key));

  return JSON.stringify(
    { _app: 'ResearchOS', _version: 3, exportedAt: new Date().toISOString(),
      projects, ideas, snippets, resources, collaborators,
      kanbanColumns, snippetCollections,
      submissions, meetings, references, settings },
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
  const withId = r => { const id = num(r.id); if (id !== null && id > 0) r.id = id; else delete r.id; return r; };
  const items = (a, textKey = 'text') => (Array.isArray(a) ? a : []).filter(isObj).map((x, i) => ({
    ...x, id: num(x.id) ?? (Date.now() + i), [textKey]: str(x[textKey]), done: !!x.done }));

  // Los registros sin sello de tiempo desaparecerían de las listas ordenadas por createdAt/updatedAt (índices de IndexedDB).
  const now = new Date().toISOString();
  const stamps = r => ({ createdAt: str(r.createdAt) || now, updatedAt: str(r.updatedAt) || str(r.createdAt) || now });

  const out = {};
  out.kanbanColumns = rows('kanbanColumns').map((r, i) => withId({
    ...r, title: str(r.title) || 'Columna', color: cssColor(r.color, '#38bdf8'),
    order: num(r.order) ?? i, wip: num(r.wip) || null }));
  out.snippetCollections = rows('snippetCollections').map(r => withId({
    ...r, name: str(r.name) || 'Colección', color: cssColor(r.color, '#38bdf8') }));
  out.collaborators = rows('collaborators').map(r => withId({ ...r, name: str(r.name) || '?', createdAt: str(r.createdAt) || now }));
  out.projects = rows('projects').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), tags: strs(r.tags), coauthors: strs(r.coauthors),
    deadline: isoDateOrNull(r.deadline), columnId: num(r.columnId), parentId: num(r.parentId),
    areaId: num(r.areaId), responsibleId: num(r.responsibleId), coauthorIds: nums(r.coauthorIds),
    archived: !!r.archived, starred: !!r.starred,
    ...(r.submittedAt !== undefined ? { submittedAt: isoDateOrNull(r.submittedAt) } : {}),
    ...(Array.isArray(r.submissionRounds) ? { submissionRounds: r.submissionRounds.filter(isObj).map(x => ({
        ...x, submittedAt: isoDateOrNull(x.submittedAt), decisionDate: isoDateOrNull(x.decisionDate) })) } : {}),
    ...(Array.isArray(r.columnHistory) ? { columnHistory: r.columnHistory.filter(isObj).map(h => ({ ...h, colId: num(h.colId) })) } : {}),
  }));
  out.ideas = rows('ideas').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), content: str(r.content), tags: strs(r.tags),
    projectId: num(r.projectId), projectIds: nums(r.projectIds),
    deadline: isoDateOrNull(r.deadline), subtasks: items(r.subtasks) }));
  out.snippets = rows('snippets').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), code: str(r.code),
    language: str(r.language).replace(/[^\w+#. -]/g, '').trim() || 'Other', tags: strs(r.tags),
    projectId: num(r.projectId), projectIds: nums(r.projectIds), collectionId: num(r.collectionId) }));
  out.meetings = rows('meetings').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), date: isoDateOrNull(r.date) || localDateISO(),
    projectId: num(r.projectId), actionItems: items(r.actionItems) }));
  out.references = rows('references').map(r => withId({
    ...r, ...stamps(r), title: str(r.title), tags: strs(r.tags), projectId: num(r.projectId),
    year: Number.isInteger(+r.year) && +r.year > 0 ? +r.year : null }));
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
  await db.transaction('rw',
    [db.projects, db.ideas, db.snippets, db.resources, db.collaborators,
     db.kanbanColumns, db.snippetCollections, db.submissions, db.meetings,
     db.references, db.settings],
    async () => {
      // Rescatar settings device-specific antes de limpiar
      const preserved = await db.settings
        .filter(s => _SETTINGS_PRESERVE.has(s.key))
        .toArray();

      await Promise.all([
        db.projects.clear(),           db.ideas.clear(),
        db.snippets.clear(),           db.resources.clear(),
        db.collaborators.clear(),      db.kanbanColumns.clear(),
        db.snippetCollections.clear(), db.submissions.clear(),
        db.meetings.clear(),           db.references.clear(),
        db.settings.clear(),
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
        db.settings.bulkPut([...importedSettings, ...preserved]),
      ]);
    }
  );
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

  await db.transaction('rw',
    [db.projects, db.ideas, db.snippets, db.resources,
     db.collaborators, db.kanbanColumns, db.snippetCollections,
     db.submissions, db.meetings, db.references, db.settings],
    async () => {
      const maps = { kanbanColumns: new Map(), collaborators: new Map(),
                     snippetCollections: new Map(), projects: new Map(), areas: new Map() };
      const label = r => foldText(r.title ?? r.name ?? '').trim();
      const keyByTitle    = r => label(r);
      const keyByIdentity = r => `${r.createdAt || ''}|${label(r)}`;
      const mapId  = (m, v) => (v == null ? null : (m.get(v) ?? null));
      const mapIds = (m, a) => (a || []).map(v => m.get(v)).filter(v => v != null);

      const mergeTable = async (name, keyFn, translate) => {
        const table    = db[name];
        const existing = await table.toArray();
        const byKey    = new Map(existing.map(r => [keyFn(r), r]));
        const usedIds  = new Set(existing.map(r => r.id));
        const added    = [];
        for (const raw of data[name]) {
          const rec   = translate ? translate({ ...raw }) : { ...raw };
          const twin  = byKey.get(keyFn(rec));
          if (twin) { maps[name]?.set(raw.id, twin.id); bump('skipped', name); continue; }
          if (rec.id != null && usedIds.has(rec.id)) delete rec.id;
          const newId = await table.add(rec);
          usedIds.add(newId);
          byKey.set(keyFn(rec), { ...rec, id: newId });
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
      await mergeTable('meetings',   keyByIdentity, proj);
      await mergeTable('references', keyByIdentity, proj);
      await mergeTable('submissions', keyByIdentity, proj);
      await mergeTable('resources',  keyByIdentity, r => ({ ...proj(r), ideaId: null }));

      // 5) Settings: solo claves que no existen localmente (y nunca credenciales)
      const have = new Set((await db.settings.toArray()).map(s => s.key));
      const fresh = data.settings.filter(s => !_SETTINGS_PRESERVE.has(s.key) && !have.has(s.key));
      if (fresh.length) await db.settings.bulkAdd(fresh);
    }
  );
  return summary;
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
     db.references, db.settings],
    async () => {
      await Promise.all([
        db.projects.clear(),           db.ideas.clear(),
        db.snippets.clear(),           db.resources.clear(),
        db.collaborators.clear(),      db.kanbanColumns.clear(),
        db.snippetCollections.clear(), db.submissions.clear(),
        db.meetings.clear(),           db.references.clear(),
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
    [db.projects, db.ideas, db.snippets, db.meetings, db.references, db.submissions, db.resources],
    async () => {
      snapshot = await db.projects.get(id);
      if (!snapshot) return;
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
