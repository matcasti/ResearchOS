
// ============================================================
//  ResearchOS — Database Layer  (Dexie.js 3.x)
//  Local-first, IndexedDB-backed, zero-backend.
// ============================================================

const db = new Dexie('ResearchOS_v2');   // ← nombre nuevo = BD limpia para todos

// Schema final consolidado — versión única, sin cadena de migraciones
db.version(1).stores({
  projects:           '++id, title, type, status, columnId, responsible, deadline, priority, createdAt, updatedAt, archived, starred, parentId',
  ideas:              '++id, title, content, status, projectId, starred, createdAt, updatedAt',
  snippets:           '++id, title, language, code, description, projectId, collectionId, starred, createdAt, updatedAt',
  snippetCollections: '++id, name, color, createdAt',
  resources:          '++id, title, url, filePath, type, projectId, ideaId, createdAt',
  collaborators:      '++id, name, email, role, affiliation, createdAt',
  kanbanColumns:      '++id, title, order, color, isDefault, wip',
  settings:           'key, value',
  // ── Features nuevas ──────────────────────────────────
  submissions:        '++id, title, type, status, projectId, targetVenue, deadlineAt, submittedAt, createdAt, updatedAt',
  meetings:           '++id, title, date, projectId, createdAt, updatedAt',
  references:         '++id, title, authors, year, journal, doi, projectId, createdAt, updatedAt'
});

// ── Seed defaults on first run ───────────────────────────────
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

// ── Query helpers ────────────────────────────────────────────

async function getKanbanData() {
  const [cols, projects] = await Promise.all([
    db.kanbanColumns.orderBy('order').toArray(),
    db.projects.toArray()
  ]);
  return cols.map(col => ({
    ...col,
    cards: projects.filter(p => p.columnId === col.id && !p.archived)
  }));
}

async function getProjectById(id) {
  return db.projects.get(id);
}

async function getRelatedIdeas(projectId) {
  // Busca por projectId (legacy) O por projectIds (multi-proyecto)
  const all = await db.ideas.where('projectId').equals(projectId).toArray();
  const multi = await db.ideas.filter(i =>
    Array.isArray(i.projectIds) && i.projectIds.includes(projectId) && i.projectId !== projectId
  ).toArray();
  return [...all, ...multi];
}

async function getRelatedSnippets(projectId) {
  const all = await db.snippets.where('projectId').equals(projectId).toArray();
  const multi = await db.snippets.filter(s =>
    Array.isArray(s.projectIds) && s.projectIds.includes(projectId) && s.projectId !== projectId
  ).toArray();
  return [...all, ...multi];
}

/**
 * Records that a project moved to a new column.
 * Stores a `columnHistory` array: [{ colId, enteredAt, exitedAt? }]
 */
async function recordColumnChange(projectId, newColId) {
  const p       = await db.projects.get(projectId);
  const now     = new Date().toISOString();
  const history = Array.isArray(p.columnHistory) ? [...p.columnHistory] : [];

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

// ── snapshotIdea ────────────────────────────────────
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
  const stamp = iso => iso?.split('T')[0];
  [...projects, ...ideas, ...snippets].forEach(item => {
    const d = stamp(item.updatedAt);
    if (d) map[d] = (map[d] || 0) + 1;
  });
  return map;
}

// ── Full export / import ─────────────────────────────────────

async function exportAllData() {
  const [projects, ideas, snippets, resources, collaborators,
         kanbanColumns, snippetCollections, submissions, meetings, references] =
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
      db.references.toArray()
    ]);
  return JSON.stringify(
    { _version: 3, exportedAt: new Date().toISOString(),
      projects, ideas, snippets, resources, collaborators,
      kanbanColumns, snippetCollections,
      submissions, meetings, references },
    null, 2
  );
}

async function importAllData(jsonString) {
  const data = JSON.parse(jsonString);
  await db.transaction('rw',
    [db.projects, db.ideas, db.snippets, db.resources, db.collaborators,
     db.kanbanColumns, db.snippetCollections, db.submissions, db.meetings, db.references],
    async () => {
      await Promise.all([
        db.projects.clear(),          db.ideas.clear(),
        db.snippets.clear(),          db.resources.clear(),
        db.collaborators.clear(),     db.kanbanColumns.clear(),
        db.snippetCollections.clear(), db.submissions.clear(),
        db.meetings.clear(),          db.references.clear()
      ]);
      await Promise.all([
        db.projects.bulkAdd(data.projects || []),
        db.ideas.bulkAdd(data.ideas || []),
        db.snippets.bulkAdd(data.snippets || []),
        db.resources.bulkAdd(data.resources || []),
        db.collaborators.bulkAdd(data.collaborators || []),
        db.kanbanColumns.bulkAdd(data.kanbanColumns || []),
        db.snippetCollections.bulkAdd(data.snippetCollections || []),
        db.submissions.bulkAdd(data.submissions || []),
        db.meetings.bulkAdd(data.meetings || []),
        db.references.bulkAdd(data.references || [])
      ]);
    }
  );
}

// ── Importar en modo merge (sin borrar datos actuales) ──
async function mergeAllData(jsonString) {
  const data = JSON.parse(jsonString);
  await db.transaction('rw',
    [db.projects, db.ideas, db.snippets, db.resources,
     db.collaborators, db.kanbanColumns, db.snippetCollections,
     db.submissions, db.meetings, db.references],
    async () => {
      const addNew = async (table, items = []) => {
        const existing = new Set((await table.toArray()).map(r => r.id));
        const fresh = items.filter(r => !existing.has(r.id));
        if (fresh.length) await table.bulkAdd(fresh);
        return fresh.length;
      };
      const counts = await Promise.all([
        addNew(db.projects,           data.projects           || []),
        addNew(db.ideas,              data.ideas              || []),
        addNew(db.snippets,           data.snippets           || []),
        addNew(db.resources,          data.resources          || []),
        addNew(db.collaborators,      data.collaborators      || []),
        addNew(db.kanbanColumns,      data.kanbanColumns      || []),
        addNew(db.snippetCollections, data.snippetCollections || []),
        addNew(db.submissions,        data.submissions        || []),
        addNew(db.meetings,           data.meetings           || []),
        addNew(db.references,         data.references         || []),
      ]);
      return counts.reduce((a,b) => a+b, 0);
    }
  );
}

// ── Submission Tracker helpers ───────────────────────────────
async function getSubmissions(projectId = null) {
  if (projectId) return db.submissions.where('projectId').equals(projectId).toArray();
  return db.submissions.orderBy('createdAt').reverse().toArray();
}

// ── Meetings helpers ─────────────────────────────────────────
async function getMeetings(projectId = null) {
  if (projectId) return db.meetings.where('projectId').equals(projectId).toArray();
  return db.meetings.orderBy('date').reverse().toArray();
}

// ── References helpers ───────────────────────────────────────
async function getReferences(projectId = null) {
  if (projectId) return db.references.where('projectId').equals(projectId).toArray();
  return db.references.orderBy('year').reverse().toArray();
}

async function exportBibtex(projectId = null) {
  const refs = await getReferences(projectId);
  return refs.map(r => {
    const key = `${(r.authors||'').split(',')[0].trim().split(' ').pop()}${r.year||'xxxx'}`;
    return `@article{${key},\n  author  = {${r.authors||''}},\n  title   = {${r.title||''}},\n  journal = {${r.journal||''}},\n  year    = {${r.year||''}},\n  doi     = {${r.doi||''}}\n}`;
  }).join('\n\n');
}

// ── Snippet Collections helpers ──────────────────────────────
async function getCollections() {
  return db.snippetCollections.orderBy('name').toArray();
}

async function createCollection(name, color = '#38bdf8') {
  return db.snippetCollections.add({ name, color, createdAt: new Date().toISOString() });
}
