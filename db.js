// ============================================================
//  ResearchOS — Database Layer  (Dexie.js 3.x)
//  Local-first, IndexedDB-backed, zero-backend.
// ============================================================

const db = new Dexie('ResearchOS_v1');

// v1: schema original — no modificar, permite abrir BDs existentes
db.version(1).stores({
  projects:      '++id, title, type, status, columnId, responsible, deadline, priority, createdAt, updatedAt',
  ideas:         '++id, title, content, status, projectId, createdAt, updatedAt',
  snippets:      '++id, title, language, code, description, projectId, createdAt, updatedAt',
  resources:     '++id, title, url, filePath, type, projectId, ideaId, createdAt',
  collaborators: '++id, name, email, role, affiliation, createdAt',
  kanbanColumns: '++id, title, [order+color], isDefault',
  settings:      'key, value'
});

// v2: añade starred/archived/parentId en projects, starred en ideas,
//     collectionId/starred en snippets, nueva tabla snippetCollections
db.version(2).stores({
  projects:          '++id, title, type, status, columnId, responsible, deadline, priority, createdAt, updatedAt, archived, starred, parentId',
  ideas:             '++id, title, content, status, projectId, starred, createdAt, updatedAt',
  snippets:          '++id, title, language, code, description, projectId, collectionId, starred, createdAt, updatedAt',
  snippetCollections:'++id, name, color, createdAt',
  resources:         '++id, title, url, filePath, type, projectId, ideaId, createdAt',
  collaborators:     '++id, name, email, role, affiliation, createdAt',
  kanbanColumns:     '++id, title, [order+color], isDefault',
  settings:          'key, value'
}).upgrade(tx => {
  return tx.table('projects').toCollection().modify(p => {
    if (p.archived === undefined) p.archived = false;
    if (p.starred  === undefined) p.starred  = false;
    if (p.parentId === undefined) p.parentId = null;
  });
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

  const projCount = await db.projects.count();
  if (projCount === 0) {
    const cols = await db.kanbanColumns.orderBy('order').toArray();
    const colId = (n) => cols[n]?.id ?? 1;
    const now   = new Date().toISOString();

    await db.projects.bulkAdd([
      {
        title: 'Impacto del Cambio Climático en Biodiversidad',
        type: 'Paper', status: 'active', columnId: colId(2),
        responsible: 'Dr. García', coauthors: ['Dr. Martínez', 'Lic. López'],
        deadline: '2025-09-30', priority: 'Alta',
        description: 'Análisis de series temporales de datos de biodiversidad correlacionados con variables climáticas en ecosistemas andinos usando GAMs y modelos mixtos en R.',
        tags: ['climate', 'biodiversity', 'R', 'GAM'], createdAt: now, updatedAt: now
      },
      {
        title: 'Grant: Fondecyt Regular 2025',
        type: 'Grant', status: 'active', columnId: colId(3),
        responsible: 'Dr. García', coauthors: ['Dr. Vega'],
        deadline: '2025-03-15', priority: 'Alta',
        description: 'Postulación a Fondecyt Regular para financiamiento de investigación en ecología cuantitativa.',
        tags: ['funding', 'grant', 'writing'], createdAt: now, updatedAt: now
      },
      {
        title: 'Pipeline de Datos GBIF → SDM',
        type: 'Análisis', status: 'active', columnId: colId(1),
        responsible: 'Lic. López', coauthors: [],
        deadline: '2025-07-01', priority: 'Media',
        description: 'Automatizar la descarga, limpieza y modelado de distribución de especies usando datos GBIF.',
        tags: ['Python', 'SDM', 'GBIF', 'automation'], createdAt: now, updatedAt: now
      }
    ]);

    await db.ideas.bulkAdd([
      { title: 'Usar GAMs para respuesta no lineal temperatura-diversidad', content: 'Probar mgcv::gam() con thin plate splines. Ver Wood (2017). Comparar con modelos lineales mixtos.', status: 'unread',    projectId: 1, tags: ['R','GAM','stats'], createdAt: now, updatedAt: now },
      { title: 'Dataset CHELSA V2 para variables climáticas',               content: 'https://chelsa-climate.org — bioclim variables a 1km. Descargar bio1, bio4, bio12, bio15.', status: 'reviewed',  projectId: 1, tags: ['climate','data'], createdAt: now, updatedAt: now },
      { title: 'Revisar criterios AIC vs BIC para selección de modelos',    content: 'AIC penaliza menos, BIC prefiere modelos parsimoniosos. Para n grande BIC es más conservador.',  status: 'unread', projectId: null, tags: ['stats','theory'], createdAt: now, updatedAt: now },
    ]);

    await db.snippets.bulkAdd([
      {
        title: 'Load & Clean Species Occurrences',
        language: 'R',
        code: `library(tidyverse)\nlibrary(janitor)\n\n# Load raw occurrence data\nspecies_raw <- read_csv("data-raw/species_occurrences.csv") |>\n  clean_names() |>\n  filter(!is.na(latitude), !is.na(longitude)) |>\n  distinct(species, latitude, longitude, .keep_all = TRUE)\n\n# Remove spatial duplicates at 0.1° resolution\nspecies_clean <- species_raw |>\n  mutate(\n    lat_r = round(latitude, 1),\n    lon_r = round(longitude, 1)\n  ) |>\n  distinct(species, lat_r, lon_r, .keep_all = TRUE)\n\ncat("Records after cleaning:", nrow(species_clean), "\\n")`,
        description: 'Loads species occurrence CSV, cleans names, removes NA and spatial duplicates.',
        projectId: 1, tags: ['R','tidyverse','cleaning'], createdAt: now, updatedAt: now
      },
      {
        title: 'Fit GAM — Biodiversity ~ Climate',
        language: 'R',
        code: `library(mgcv)\nlibrary(gratia)\n\n# Fit GAM with thin-plate splines\nmod_gam <- gam(\n  species_richness ~ s(bio1, k = 8) + s(bio12, k = 8) +\n                     s(bio1, bio12, k = 20) +\n                     s(site_id, bs = "re"),\n  data   = analysis_df,\n  family = nb(),     # Negative binomial for count data\n  method = "REML"\n)\n\nsummary(mod_gam)\ndraw(mod_gam)  # gratia::draw for smooth plots`,
        description: 'GAM with negative binomial family for species richness modelling.',
        projectId: 1, tags: ['R','GAM','mgcv'], createdAt: now, updatedAt: now
      },
      {
        title: 'Download CHELSA Bioclim Variables',
        language: 'Bash',
        code: `#!/bin/bash\nBASE="https://os.zhdk.cloud.switch.ch/envicloud/chelsa/chelsa_V2/GLOBAL/climatologies/1981-2010/bio"\nVARS=("bio1" "bio4" "bio12" "bio15")\nmkdir -p data-raw/climate\n\nfor VAR in "\${VARS[@]}"; do\n  echo "⬇ Downloading \$VAR..."\n  wget -q "\${BASE}/CHELSA_\${VAR}_1981-2010_V.2.1.tif" \\\n    -O "data-raw/climate/\${VAR}.tif" && echo "  ✓ \$VAR"\ndone\necho "Done."`,
        description: 'Downloads CHELSA V2 bioclimatic rasters via wget.',
        projectId: 1, tags: ['bash','climate','wget'], createdAt: now, updatedAt: now
      },
      {
        title: 'GBIF Occurrence Download (rgbif)',
        language: 'R',
        code: `library(rgbif)\n\n# Trigger a download (requires GBIF account in .Renviron)\nocc_download(\n  pred("taxonKey", 212),          # Birds\n  pred("country",  "CL"),          # Chile\n  pred_gte("year", 2000),\n  pred("occurrenceStatus", "PRESENT"),\n  format = "SIMPLE_CSV"\n)\n\n# After download completes:\ndata <- occ_download_get("DOWNLOAD_KEY") |>\n  occ_download_import()`,
        description: 'Downloads species occurrences from GBIF using the Darwin Core Archive.',
        projectId: 3, tags: ['R','GBIF','rgbif'], createdAt: now, updatedAt: now
      }
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
  return db.ideas.where('projectId').equals(projectId).toArray();
}

async function getRelatedSnippets(projectId) {
  return db.snippets.where('projectId').equals(projectId).toArray();
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
  const [projects, ideas, snippets, resources, collaborators, kanbanColumns, snippetCollections] =
    await Promise.all([
      db.projects.toArray(),
      db.ideas.toArray(),
      db.snippets.toArray(),
      db.resources.toArray(),
      db.collaborators.toArray(),
      db.kanbanColumns.toArray(),
      db.snippetCollections.toArray()
    ]);
  return JSON.stringify(
    { _version: 2, exportedAt: new Date().toISOString(),
      projects, ideas, snippets, resources, collaborators, kanbanColumns, snippetCollections },
    null, 2
  );
}

async function importAllData(jsonString) {
  const data = JSON.parse(jsonString);
  await db.transaction('rw',
    [db.projects, db.ideas, db.snippets, db.resources, db.collaborators, db.kanbanColumns, db.snippetCollections],
    async () => {
      await Promise.all([
        db.projects.clear(),     db.ideas.clear(),
        db.snippets.clear(),     db.resources.clear(),
        db.collaborators.clear(), db.kanbanColumns.clear(),
        db.snippetCollections.clear()
      ]);
      await Promise.all([
        db.projects.bulkAdd(data.projects || []),
        db.ideas.bulkAdd(data.ideas || []),
        db.snippets.bulkAdd(data.snippets || []),
        db.resources.bulkAdd(data.resources || []),
        db.collaborators.bulkAdd(data.collaborators || []),
        db.kanbanColumns.bulkAdd(data.kanbanColumns || []),
        db.snippetCollections.bulkAdd(data.snippetCollections || [])
      ]);
    }
  );
}

// ── Snippet Collections helpers ──────────────────────────────
async function getCollections() {
  return db.snippetCollections.orderBy('name').toArray();
}

async function createCollection(name, color = '#38bdf8') {
  return db.snippetCollections.add({ name, color, createdAt: new Date().toISOString() });
}
