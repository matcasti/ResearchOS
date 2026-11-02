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
const ASST_API_VERSION = 3;      // sube cuando cambian los campos u operaciones admitidos (estado.json lo publica para que la IA no tenga que probarlos)

// -- referencias por uid (completo o prefijo de 8+) o por nombre ---------------------------------------------------------------
const _asstRepeat = v => {
  if (_asstEmpty(v)) return { recurrence: null };
  const r = Tasks.cleanRecurrence(typeof v === 'string' ? { freq: v, interval: 1 } : v);
  if (!r) throw new Error('repeat no válido: usa {"freq":"daily|weekly|monthly","interval":1,"until":"AAAA-MM-DD"}');
  return { recurrence: r };
};
//  Referencias temporales: una operación «add» lleva "id":"p1" y las siguientes del mismo lote la usan como "#p1" (donde iría un uid o un nombre).
let _asstTemp = new Map();                                                   // id temporal → { type, uid } del lote que se está aplicando
function _asstFind(rows, ref, labelOf, what) {
  let q = String(ref ?? '').trim();
  if (q[0] === '#') {
    const hit = _asstTemp.get(q.slice(1));
    if (!hit) throw new Error(`la referencia «${q}» no está definida: la operación que la crea no se aplicó (o va después)`);
    q = hit.uid;
  }
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

const ASST_PROJECT_TYPES = ['Proyecto', 'Grant', 'Paper', 'Análisis', 'Dataset', 'Presentación', 'Curso'];     // los de la app: solo los «Paper» aparecen en Submissions
const ASST_DECISIONS = ['major', 'minor', 'reject', 'accept', 'pending'];
const ASST_READ = { toread: 'toread', 'por leer': 'toread', reading: 'reading', leyendo: 'reading', read: 'read', leido: 'read', leida: 'read' };
const _asstProjectType = v => {
  const t = ASST_PROJECT_TYPES.find(x => foldText(x) === foldText(String(v ?? '')));
  if (!t) throw new Error(`type «${v}» no válido (${ASST_PROJECT_TYPES.join(', ')})`);
  return t;
};
/** Etapa de submission por clave o etiqueta (las etapas son las que la persona tenga configuradas en la app). */
const _asstStage = v => {
  const f = foldText(String(v ?? ''));
  const st = SUB_STATUSES.find(x => foldText(x.key) === f || foldText(x.label) === f || foldText(x.shortLabel) === f);
  if (!st) throw new Error(`submissionStatus «${v}» no válido (${SUB_STATUSES.map(x => x.key).join(', ')})`);
  return st;
};
/** Los campos de submission solo se ven en proyectos de tipo Paper: sin ese tipo, el cambio pasaría sin efecto visible. */
const _asstNeedPaper = (field, v, set, existing) => {
  if (_asstEmpty(v)) return;
  const type = set?.type !== undefined ? _asstProjectType(set.type) : (existing?.type || 'Proyecto');
  if (type !== 'Paper') throw new Error(`«${field}» solo aplica a proyectos de tipo Paper (pon también "type": "Paper")`);
};
const _asstRounds = list => {
  if (!Array.isArray(list)) throw new Error('las rondas deben ser una lista de {submittedAt, decision, decisionDate, venue, notes}');
  return list.map((r, i) => {
    const o = r && typeof r === 'object' ? r : {}, dec = _asstEmpty(o.decision) ? 'pending' : foldText(String(o.decision));
    if (!ASST_DECISIONS.includes(dec)) throw new Error(`ronda ${i + 1}: decision «${o.decision}» no válida (${ASST_DECISIONS.join(', ')})`);
    return { id: Date.now() + i, submittedAt: _asstDate(o.submittedAt) || '', decision: dec, decisionDate: _asstDate(o.decisionDate) || '',
      venue: _asstText(o.venue, 200, 'venue'), notes: _asstText(o.notes, 2000, 'notes') };
  });
};

//  Lo marcado como privado (proyectos, personas, tareas) y todo lo que cuelga de ello no existe para la IA: ni se publica ni se puede nombrar.
let _asstPriv = { projects: new Set(), people: new Set(), names: [] };
async function _asstRefreshPrivacy() {
  const [projects, people] = await Promise.all([db.projects.toArray(), db.collaborators.toArray()]);
  const hidden = new Set(projects.filter(p => p.private).map(p => p.id));
  for (let grew = true; grew;) { grew = false; for (const p of projects) if (!hidden.has(p.id) && p.parentId != null && hidden.has(p.parentId)) { hidden.add(p.id); grew = true; } }     // los subproyectos de uno privado también
  const priv = people.filter(c => c.private);
  _asstPriv = { projects: hidden, people: new Set(priv.map(c => c.id)), names: priv.map(c => foldText(c.name)).filter(Boolean) };
}
const _asstHidden = (type, r) => {
  const P = _asstPriv, inP = ids => (ids || []).some(i => P.projects.has(i));
  switch (type) {
    case 'project': return P.projects.has(r.id);
    case 'person': return P.people.has(r.id);
    case 'task': return !!r.private || P.projects.has(r.projectId) || P.people.has(r.assigneeId) || P.people.has(r.ownerId);
    case 'idea': case 'reference': case 'snippet': return P.projects.has(r.projectId) || inP(r.projectIds);
    case 'meeting': return !!r.private || P.projects.has(r.projectId) || P.names.some(n => foldText(r.participants || '').includes(n));      // los participantes son texto libre: se compara por nombre
    default: return false;
  }
};

/** Acceso a las entidades por referencia. Se consulta la BD en cada llamada: un lote puede crear un proyecto y usarlo después. */
const _asstCx = {
  project: async ref => _asstFind((await db.projects.toArray()).filter(r => !_asstHidden('project', r)), ref, p => p.title, 'proyecto'),
  idea:    async ref => _asstFind((await db.ideas.toArray()).filter(r => !_asstHidden('idea', r)), ref, i => i.title, 'idea'),
  person:  async ref => _asstFind((await db.collaborators.toArray()).filter(r => !_asstHidden('person', r)), ref, c => c.name, 'persona'),
  task:    async ref => _asstFind((await db.tasks.toArray()).filter(r => !_asstHidden('task', r)), ref, t => t.title, 'tarea'),
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
    repeat:   _asstRepeat,
    minutes:  v => { if (_asstEmpty(v)) return { effort: null }; const m = Tasks.cleanEffort(v); if (m == null) throw new Error('minutes debe ser un número positivo'); return { effort: m }; },
    planDate: v => ({ planDate: _asstDate(v) }),
    area:     _asstRef('area', 'areaId'),
    notes:    v => ({ notes: Tasks.cleanNotes(v) }),
    link:     v => { if (_asstEmpty(v)) return { link: null }; const l = Tasks.cleanLink(v); if (!l) throw new Error('link debe ser una dirección http(s) válida'); return { link: l }; },
    source:   v => ({ source: Tasks.cleanSource(v) }),
    owner:    _asstRef('person', 'ownerId'),                                   // quién la hace (distinto de «assignee»: de quién esperas el resultado)
    after:    async (v, existing) => {                                         // se oculta hasta completar estas tareas
      const refs = _asstEmpty(v) ? [] : Array.isArray(v) ? v : [v], ids = [];
      for (const r of refs) {
        const t = await _asstCx.task(r);
        if (existing && t.id === existing.id) throw new Error('una tarea no puede ir después de sí misma');
        if (existing) { const byId = Tasks.index(await db.tasks.toArray()), seen = new Set(); const dep = x => (x.afterIds || []).some(i => i === existing.id || (!seen.has(i) && byId.get(i) && (seen.add(i), dep(byId.get(i))))); if (dep(t)) throw new Error(`«${t.title}» ya depende de esta tarea: sería un ciclo`); }
        ids.push(t.id);
      }
      return { afterIds: Tasks.cleanAfter(ids) };
    },
    rank:     v => { if (_asstEmpty(v)) return { rank: null }; const r = Tasks.cleanRank(v); if (r === null) throw new Error('rank debe ser un número (menor = antes)'); return { rank: r }; },
    spent:    v => { if (_asstEmpty(v)) return { spent: null }; const m = Tasks.cleanSpent(v); if (m == null) throw new Error('spent son los minutos realmente dedicados (≥ 1)'); return { spent: m }; },
    event:    v => ({ event: Tasks.cleanSource(v) }),                          // el «source» de la reunión (bloque del calendario) a la que está ligada
  },
  idea: {
    title:    v => ({ title: _asstText(v, 300, 'title', { required: true }) }),
    content:  v => ({ content: _asstText(v, 20000, 'content') }),
    status:   v => { if (!['unread', 'reviewed'].includes(v)) throw new Error('status debe ser unread o reviewed'); return { status: v }; },
    tags:     v => ({ tags: _asstTags(v) }),
    project:  _asstRef('project', 'projectId', p => ({ projectIds: p ? [p.id] : [] })),
    deadline: v => ({ deadline: _asstDate(v) }),
    starred:  v => ({ starred: !!v }),
    source:   v => ({ source: Tasks.cleanSource(v) }),
  },
  project: {
    title:       v => ({ title: _asstText(v, 200, 'title', { required: true }) }),
    description: v => ({ description: _asstText(v, 20000, 'description') }),
    type:        v => ({ type: _asstProjectType(v) }),
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
    rank:        v => { if (_asstEmpty(v)) return { rank: null }; const r = Tasks.cleanRank(v); if (r === null) throw new Error('rank debe ser un número (menor = antes en su columna)'); return { rank: r }; },
    paused:      v => ({ paused: !!v }),                                       // en pausa: sale de Hoy y de la carga hasta que se reanude
    pauseReason: v => ({ pauseReason: _asstText(v, 300, 'pauseReason') }),
    pausedUntil: v => ({ pausedUntil: _asstDate(v) }),                         // fecha para revisar la pausa
    coauthors:   async v => {                                                  // personas de la agenda (con su id) o nombres sueltos
      const names = (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map(x => String(x).trim()).filter(Boolean).slice(0, 30), people = await db.collaborators.toArray();
      const hit = names.map(n => people.find(c => foldText(c.name) === foldText(n)));
      return { coauthors: names.map((n, i) => hit[i]?.name ?? n), coauthorIds: hit.filter(Boolean).map(c => c.id) };
    },
    // Submissions (solo proyectos «Paper»): estado del pipeline, venue, envío, notas y rondas de revisión
    submissionStatus: async (v, existing, set) => {
      if (_asstEmpty(v)) return { submissionStatus: null };
      _asstNeedPaper('submissionStatus', v, set, existing);
      const st = _asstStage(v), out = { submissionStatus: st.key };
      if ((existing?.submissionStatus ?? null) !== st.key) {                 // igual que mover el paper en el pipeline: historial y fecha de envío
        out.submissionStatusHistory = [...(existing?.submissionStatusHistory || []), { from: existing?.submissionStatus ?? null, to: st.key, date: new Date().toISOString() }];
        if (st.key === 'enviado' && !existing?.submittedAt && set.submittedAt === undefined) out.submittedAt = localDateISO();
      }
      return out;
    },
    targetVenue:      (v, e, set) => { _asstNeedPaper('targetVenue', v, set, e); return { targetVenue: _asstText(v, 200, 'targetVenue') }; },
    submittedAt:      (v, e, set) => { _asstNeedPaper('submittedAt', v, set, e); return { submittedAt: _asstDate(v) }; },
    submissionNotes:  (v, e, set) => { _asstNeedPaper('submissionNotes', v, set, e); return { submissionNotes: _asstText(v, 5000, 'submissionNotes') }; },
    submissionRounds: (v, e, set) => { _asstNeedPaper('submissionRounds', v, set, e); return { submissionRounds: _asstEmpty(v) ? [] : _asstRounds(v) }; },
    addSubmissionRounds: (v, e, set) => { _asstNeedPaper('addSubmissionRounds', v, set, e); return { submissionRounds: [...(e?.submissionRounds || []), ..._asstRounds(v)] }; },
    customFields: async (v, existing, set) => {                                // los campos extra de cada tipo de proyecto (ver «projectFields» en los ajustes)
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('customFields debe ser un objeto {campo: valor}');
      const type = set.type !== undefined ? _asstProjectType(set.type) : (existing?.type || 'Proyecto'), schema = (await _getTypeSchemas())[type] || [];
      const out = { ...(existing?.customFields || {}) };
      for (const [k, val] of Object.entries(v)) {
        const f = schema.find(x => x.key === k);
        if (!f) throw new Error(`customFields.${k} no existe en los proyectos ${type}. Campos: ${schema.map(x => x.key).join(', ') || '(ninguno)'}`);
        if (_asstEmpty(val)) delete out[k];
        else if (f.type === 'number') { if (!Number.isFinite(+val)) throw new Error(`customFields.${k} debe ser un número`); out[k] = +val; }
        else out[k] = _asstText(val, 500, k);
      }
      return { customFields: out };
    },
  },
  meeting: {
    title:        v => ({ title: _asstText(v, 200, 'title', { required: true }) }),
    date:         v => ({ date: _asstDate(v) || localDateISO() }),
    time:         v => { if (_asstEmpty(v)) return { time: null, duration: null }; const t = timeOrNull(v); if (!t) throw new Error(`hora no válida «${v}» (usa HH:MM)`); return { time: t }; },
    duration:     v => { if (_asstEmpty(v)) return { duration: null }; const d = durationOrNull(v); if (d == null) throw new Error('duration son minutos (5 o más)'); return { duration: d }; },
    source:       v => ({ source: Tasks.cleanSource(v) }),
    project:      _asstRef('project', 'projectId'),
    repeat:       _asstRepeat,                                                 // reunión que se repite: se crean sus próximas ocurrencias
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
    followUpDays: v => {
      if (_asstEmpty(v)) return { followUpDays: null };
      if (![7, 14, 30, 90, 180].includes(+v)) throw new Error('followUpDays debe ser 7, 14, 30, 90 o 180 (cada cuántos días hay que escribirle)');
      return { followUpDays: +v };
    },
    lastContact: v => ({ lastContact: _asstDate(v) }),
  },
  reference: {
    title:      v => ({ title: _asstText(v, 500, 'title', { required: true }) }),
    authors:    v => ({ authors: _asstText(v, 1000, 'authors') }),
    year:       v => { if (_asstEmpty(v)) return { year: null }; const y = +v; if (!Number.isInteger(y) || y < 1000 || y > 2100) throw new Error(`year no válido «${v}»`); return { year: y }; },
    journal:    v => ({ journal: _asstText(v, 300, 'journal') }),
    doi:        v => ({ doi: _asstText(v, 200, 'doi') }),
    url:        v => { if (_asstEmpty(v)) return { url: '' }; const l = Tasks.cleanLink(v); if (!l) throw new Error('url debe ser una dirección http:// o https://'); return { url: l }; },
    notes:      v => ({ notes: _asstText(v, 20000, 'notes') }),
    tags:       v => ({ tags: _asstTags(v) }),
    project:    _asstRef('project', 'projectId'),
    citeKey:    v => ({ citeKey: _asstText(v, 100, 'citeKey') }),
    readStatus: (v, existing) => {
      if (_asstEmpty(v)) return { readStatus: null, readAt: null };
      const s = ASST_READ[foldText(String(v))];
      if (!s) throw new Error(`readStatus no válido «${v}» (toread, reading o read)`);
      return { readStatus: s, readAt: s === 'read' ? (existing?.readStatus === 'read' && existing.readAt) || new Date().toISOString() : null };
    },
    source:     v => ({ source: Tasks.cleanSource(v) }),
  },
  snippet: {
    title:       v => ({ title: _asstText(v, 300, 'title', { required: true }) }),
    code:        v => ({ code: _asstText(v, 100000, 'code', { required: true }) }),
    language:    v => { const l = _asstText(v, 40, 'language').replace(/[^\w+#. -]/g, '').trim(); return { language: LANGS.find(x => foldText(x) === foldText(l) && x !== 'all') || l || 'Other' }; },
    description: v => ({ description: _asstText(v, 2000, 'description') }),
    tags:        v => ({ tags: _asstTags(v) }),
    project:     _asstRef('project', 'projectId', p => ({ projectIds: p ? [p.id] : [] })),
    starred:     v => ({ starred: !!v }),
  },
  collection: {
    name:  v => ({ name: _asstText(v, 100, 'name', { required: true }) }),
    color: v => ({ color: cssColor(v, '#38bdf8') }),
  },
  // -- ajustes de la app (solo con «Ajustes de la app» activado) --
  area: {
    name:        v => ({ name: _asstText(v, 100, 'name', { required: true }) }),
    description: v => ({ description: _asstText(v, 500, 'description') }),
    color:       v => ({ color: cssColor(v, AREA_COLORS[0]) }),
    parent:      async (v, existing) => {                                      // áreas anidadas
      if (_asstEmpty(v)) return { parentId: null };
      const a = await _asstCx.area(v);
      if (existing && areaWithDescendants(await _getAreas(), existing.id).has(a.id)) throw new Error('un área no puede estar dentro de sí misma ni de sus subáreas');
      return { parentId: a.id };
    },
  },
  column: {
    title:    v => ({ title: _asstText(v, 60, 'title', { required: true }) }),
    color:    v => ({ color: cssColor(v, '#38bdf8') }),
    wip:      v => { if (_asstEmpty(v)) return { wip: null }; const n = +v; if (!Number.isInteger(n) || n < 1) throw new Error('wip es el límite de proyectos en la columna (entero ≥ 1, o null)'); return { wip: n }; },
    position: v => { const n = +v; if (!Number.isInteger(n) || n < 1) throw new Error('position es el lugar en el tablero (1 = la primera columna)'); return { __position: n }; },
    types:    v => ({ types: (_asstEmpty(v) ? [] : Array.isArray(v) ? v : String(v).split(/[,;]/)).map(x => _asstProjectType(String(x).trim())) }),      // columna solo para estos tipos de proyecto ([] = todos)
  },
  setting: {
    dailyMinutes: v => { const n = +v; if (!Number.isFinite(n) || n < 30 || n > 960) throw new Error('dailyMinutes son los minutos útiles al día (30–960)'); return { dailyMinutes: Math.round(n) }; },
    submissionStages: async v => {
      if (!Array.isArray(v) || !v.length) throw new Error('submissionStages debe ser una lista con al menos una etapa: [{"key","label","shortLabel","color","icon"}]');
      const plain = x => String(x ?? '').replace(/[<>"'`]/g, '').trim(), seen = new Set();
      const stages = v.map((st, i) => {
        const o = st && typeof st === 'object' ? st : {}, key = String(o.key ?? '').replace(/[^\w-]/g, '');
        if (!key) throw new Error(`etapa ${i + 1}: falta «key» (letras, números y _)`);
        if (seen.has(key)) throw new Error(`etapa ${i + 1}: la clave «${key}» está repetida`);
        seen.add(key);
        const label = plain(o.label ?? key).slice(0, 40) || key;
        return { key, label, shortLabel: plain(o.shortLabel ?? label).slice(0, 20) || label, color: cssColor(o.color, '#64748b'), icon: plain(o.icon ?? '•').slice(0, 4) || '•', order: i };
      });
      const huerfano = await db.projects.filter(p => p.submissionStatus && !seen.has(p.submissionStatus)).first();
      if (huerfano) throw new Error(`no se pueden quitar etapas en uso: «${huerfano.title}» está en «${huerfano.submissionStatus}» (muévelo antes)`);
      return { submissionStages: stages };
    },
    projectFields: async (v, existing) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('projectFields debe ser un objeto {"Paper":[{"key","label","type":"text|number","placeholder"}]}');
      const out = { ...(existing?.projectFields || {}) };
      for (const [t, list] of Object.entries(v)) {
        const type = _asstProjectType(t), keys = new Set();
        if (!Array.isArray(list)) throw new Error(`projectFields.${type} debe ser una lista de campos`);
        out[type] = list.map((f, i) => {
          const o = f && typeof f === 'object' ? f : {}, key = String(o.key ?? '').trim();
          if (!/^[A-Za-z]\w{0,39}$/.test(key)) throw new Error(`projectFields.${type}[${i}]: «key» debe empezar por una letra (solo letras, números y _)`);
          if (keys.has(key)) throw new Error(`projectFields.${type}: la clave «${key}» está repetida`);
          keys.add(key);
          if (!_asstEmpty(o.type) && !['text', 'number'].includes(o.type)) throw new Error(`projectFields.${type}.${key}: type es text o number`);
          return { key, label: _asstText(o.label ?? key, 80, 'label') || key, type: o.type === 'number' ? 'number' : 'text', placeholder: _asstText(o.placeholder, 120, 'placeholder') };
        });
      }
      return { projectFields: out };
    },
    submissionColumnMap: async (v, existing) => {                              // a qué columna del tablero va cada etapa (con «syncPaperColumn»)
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('submissionColumnMap debe ser un objeto {"enviado":"Columna"}');
      const out = { ...(existing?.submissionColumnMap || {}) };
      for (const [k, name] of Object.entries(v)) { const st = _asstStage(k); if (_asstEmpty(name)) delete out[st.key]; else out[st.key] = (await _asstCx.column(name)).id; }
      return { submissionColumnMap: out };
    },
    syncPaperColumn: v => ({ syncPaperColumn: !!v }),
    profile: v => {
      const f = foldText(String(v ?? '')), p = NAV_PROFILES.find(x => x.key === f || foldText(x.label) === f);
      if (!p) throw new Error(`profile no válido «${v}» (${NAV_PROFILES.map(x => x.key).join(', ')})`);
      return { profile: p.key };
    },
    theme: v => { const t = { dark: 'dark', oscuro: 'dark', light: 'light', claro: 'light' }[foldText(String(v ?? ''))]; if (!t) throw new Error('theme es dark o light'); return { theme: t }; },
    accent: v => { const a = { blue: 'blue', azul: 'blue', green: 'green', verde: 'green', purple: 'purple', morado: 'purple' }[foldText(String(v ?? ''))]; if (!a) throw new Error('accent es blue, green o purple'); return { accent: a }; },
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
//  ops: siempre disponibles · full: solo con «Control total de los datos» · config: el tipo pertenece a los ajustes de la app y solo existe con «Ajustes de la app»
const ASST_TYPES = {
  task:    { table: 'tasks',         noun: 'tarea',    key: 'title', ops: ['add', 'update', 'complete', 'delete'], label: r => r.title },
  idea:    { table: 'ideas',         noun: 'idea',     key: 'title', ops: ['add', 'update', 'delete'],             label: r => r.title },
  project: { table: 'projects',      noun: 'proyecto', key: 'title', ops: ['add', 'update'], full: ['delete'],    label: r => r.title },
  meeting: { table: 'meetings',      noun: 'reunión',  key: 'title', ops: ['add', 'update'], full: ['delete'],    label: r => r.title },
  person:  { table: 'collaborators', noun: 'persona',  key: 'name',  ops: ['add', 'update'], full: ['delete'],    label: r => r.name },
  reference: { table: 'references',  noun: 'referencia', key: 'title', ops: ['add', 'update', 'delete'],          label: r => r.title },
  snippet: { table: 'snippets',      noun: 'snippet',  key: 'title', ops: ['add', 'update', 'delete'],             label: r => r.title },
  collection: { table: 'snippetCollections', noun: 'colección de snippets', key: 'name', ops: ['add', 'update'], full: ['delete'], label: r => r.name },
  area:    { store: () => _asstAreaStore,     noun: 'área',    key: 'name',  config: true, ops: ['add', 'update', 'delete'], label: r => r.name },
  column:  { table: 'kanbanColumns', noun: 'columna del tablero', key: 'title', config: true, ops: ['add', 'update', 'delete'], label: r => r.title },
  setting: { store: () => _asstSettingsStore, noun: 'ajuste', key: 'name', config: true, singleton: true, ops: ['update'], label: r => r.name },
};
const _asstTable = T => T.store ? T.store() : db[T.table];                    // los tipos que no viven en una tabla (áreas, ajustes) hablan con la misma interfaz
const _asstOps = T => [...T.ops, ...(T.full && Assistant.fullControl() ? T.full : [])];

/** Las áreas viven en `settings` (JSON); este adaptador les da la interfaz de una tabla. */
const _asstAreaStore = {
  toArray: () => _getAreas(),
  get: async id => (await _getAreas()).find(a => a.id === id),
  add: async o => { const all = await _getAreas(), id = Math.max(Date.now(), ...all.map(a => +a.id || 0)) + 1; all.push({ ...o, id }); await _saveAreas(all); return id; },
  update: async (id, patch) => { const all = await _getAreas(), i = all.findIndex(a => a.id === id); if (i < 0) throw new Error('área ya no existe'); all[i] = { ...all[i], ...patch }; await _saveAreas(all); },
  delete: async id => { const all = await _getAreas(), gone = all.find(a => a.id === id); await _saveAreas(all.filter(a => a.id !== id).map(a => a.parentId === id ? { ...a, parentId: gone?.parentId ?? null } : a)); },
};
/** Los ajustes de la app son un único registro: cada clave se lee y se escribe donde la app la guarda. */
const _asstSettingsRow = { id: 1, uid: 'app-settings', name: 'ajustes' };
const _asstSettingsRead = async () => ({
  dailyMinutes: Capacity.get(), submissionStages: SUB_STATUSES.map(x => ({ ...x })), projectFields: await _getTypeSchemas(), submissionColumnMap: await _getSubColMapping(),
  syncPaperColumn: (await db.settings.get('ros-auto-sync-paper-col'))?.value === 'true', profile: NavProfile.get(),
  theme: document.documentElement.getAttribute('data-theme') || 'dark', accent: document.documentElement.getAttribute('data-accent') || 'blue' });
const _asstSettingsStore = {
  toArray: async () => [_asstSettingsRow],
  get: async () => ({ ..._asstSettingsRow, ...await _asstSettingsRead() }),
  update: async (_id, p) => {
    if ('dailyMinutes' in p) Capacity.set(p.dailyMinutes);
    if ('submissionStages' in p) await _saveSubStages(p.submissionStages);
    if ('projectFields' in p) await _saveTypeSchemas(p.projectFields);
    if ('submissionColumnMap' in p) await _saveSubColMapping(p.submissionColumnMap);
    if ('syncPaperColumn' in p) await db.settings.put({ key: 'ros-auto-sync-paper-col', value: p.syncPaperColumn ? 'true' : 'false' });
    if ('profile' in p) NavProfile.set(p.profile);
    if ('theme' in p) { document.documentElement.setAttribute('data-theme', p.theme); try { localStorage.setItem('ros-theme', p.theme); } catch {} }
    if ('accent' in p) _applyAccent(p.accent);
    Live.touch();
  },
};

/** Convierte los campos recibidos en campos de la BD (resolviendo nombres a ids). Lanza un Error legible si algo no vale. */
async function _asstBuild(type, set, existing) {
  const defs = ASST_FIELDS[type], out = {};
  for (const [k, v] of Object.entries(set)) {
    if (!defs[k]) throw new Error(`campo «${k}» no admitido en ${ASST_TYPES[type].noun}. Admitidos: ${Object.keys(defs).join(', ')} (apiVersion ${ASST_API_VERSION})`);
    Object.assign(out, await defs[k](v, existing, set));
  }
  return out;
}

/** Deja a una persona sin referencias colgantes antes de borrarla; devuelve cómo volver atrás. */
async function _asstDetachPerson(id) {
  const restore = [];
  for (const t of await db.tasks.filter(t => t.assigneeId === id).toArray()) { restore.push(['tasks', t.id, { assigneeId: id }]); await db.tasks.update(t.id, { assigneeId: null }); }
  for (const p of await db.projects.filter(p => p.responsibleId === id || (p.coauthorIds || []).includes(id)).toArray()) {
    restore.push(['projects', p.id, { responsibleId: p.responsibleId ?? null, coauthorIds: p.coauthorIds }]);
    await db.projects.update(p.id, { responsibleId: p.responsibleId === id ? null : p.responsibleId, coauthorIds: (p.coauthorIds || []).filter(x => x !== id) });
  }
  for (const m of await db.meetings.filter(m => (m.actionItems || []).some(a => a.assigneeId === id)).toArray()) {
    restore.push(['meetings', m.id, { actionItems: m.actionItems }]);
    await db.meetings.update(m.id, { actionItems: m.actionItems.map(a => a.assigneeId === id ? { ...a, assigneeId: null } : a) });
  }
  return async () => { for (const [t, rid, fields] of restore) await db[t].update(rid, fields); };
}
/** Coloca una columna en el lugar indicado (1 = la primera) y devuelve cómo dejar el orden como estaba. */
async function _asstPlaceColumn(id, pos) {
  const cols = await db.kanbanColumns.orderBy('order').toArray(), before = cols.map(c => [c.id, c.order]);
  const rest = cols.filter(c => c.id !== id); rest.splice(Math.max(0, Math.min(rest.length, pos - 1)), 0, cols.find(c => c.id === id));
  for (const [i, c] of rest.entries()) if (c.order !== i) await db.kanbanColumns.update(c.id, { order: i });
  return async () => { for (const [cid, o] of before) await db.kanbanColumns.update(cid, { order: o }); };
}

/** Borra un registro dejando los demás coherentes. Devuelve { uid, undo }. */
async function _asstDelete(type, row, table) {
  const back = () => table.add(row);
  switch (type) {
    case 'task': await Tasks.remove(row.id); return { uid: row.uid, undo: back };
    case 'idea': return { uid: row.uid, undo: await deleteIdeaCascade(row.id) };
    case 'project': return { uid: row.uid, undo: await deleteProjectCascade(row.id) };
    case 'person': { const undo = await _asstDetachPerson(row.id); await table.delete(row.id); return { uid: row.uid, undo: async () => { await back(); await undo(); } }; }
    case 'collection': {
      const snips = await db.snippets.where('collectionId').equals(row.id).toArray();
      for (const sn of snips) await db.snippets.update(sn.id, { collectionId: null });
      await table.delete(row.id);
      return { uid: row.uid, undo: async () => { await back(); for (const sn of snips) await db.snippets.update(sn.id, { collectionId: row.id }); } };
    }
    case 'area': {
      const projs = await db.projects.filter(p => p.areaId === row.id).toArray(), tasks = await db.tasks.filter(t => t.areaId === row.id).toArray();
      const kids = (await _getAreas()).filter(a => a.parentId === row.id).map(a => a.id);        // sus subáreas suben un nivel (y vuelven si se deshace)
      for (const p of projs) await db.projects.update(p.id, { areaId: null });
      for (const t of tasks) await db.tasks.update(t.id, { areaId: null });
      await table.delete(row.id);
      return { uid: row.uid, undo: async () => {
        await db.tombstones.where('uid').equals(row.uid).delete();                         // si no, la lápida del borrado lo volvería a quitar al sincronizar
        await _saveAreas([...(await _getAreas()).map(a => kids.includes(a.id) ? { ...a, parentId: row.id } : a), row]);
        for (const p of projs) await db.projects.update(p.id, { areaId: row.id });
        for (const t of tasks) await db.tasks.update(t.id, { areaId: row.id });
      } };
    }
    case 'column': {
      const cols = await db.kanbanColumns.orderBy('order').toArray(), pos = cols.findIndex(c => c.id === row.id);
      if (cols.length <= 1) throw new Error('no se puede borrar la única columna del tablero');
      const dest = (cols[pos - 1] ?? cols[pos + 1]).id, moved = await db.projects.where('columnId').equals(row.id).toArray();      // como en la app: pasan a la anterior (o a la siguiente)
      const snap = moved.map(p => ({ id: p.id, columnId: p.columnId, columnHistory: p.columnHistory }));
      for (const p of moved) await recordColumnChange(p.id, dest);
      await table.delete(row.id);
      return { uid: row.uid, undo: async () => { await back(); for (const sn of snap) await db.projects.update(sn.id, { columnId: sn.columnId, columnHistory: sn.columnHistory }); } };
    }
    default: await table.delete(row.id); return { uid: row.uid, undo: back };       // reunión, referencia, snippet
  }
}

/** Una tarea nueva ligada a un bloque del calendario: lo que no fijó lo toma de la reunión, y si fijó algo, la reunión lo sigue. */
async function _asstLinkTask(id) {
  const t = await db.tasks.get(id), m = await db.meetings.filter(x => x.source === t.event).first();
  if (!m) return;
  await db.tasks.update(id, { planDate: t.planDate ?? m.date, effort: t.effort ?? m.duration ?? null });
  await EventLinks.fromTask(await db.tasks.get(id));
}

/** Pone en marcha una operación ya validada. Devuelve { uid, undo, warnings? }. */
async function _asstRun(it) {
  const { type, op } = it, T = ASST_TYPES[type], table = _asstTable(T), now = new Date().toISOString();
  if (op === 'add') {
    const c = await _asstBuild(type, it.set, null);
    if (c.source) {                                                            // mismo origen que algo que ya existe: no se duplica
      const dup = (await table.toArray()).find(r => r.source === c.source);
      if (dup) return { uid: dup.uid, undo: async () => {}, skipped: 'ya existe (mismo origen)' };
    }
    let id, placeUndo = null;
    if (type === 'task') {
      const { __done, __ideaProject, ...f } = c;
      if (__ideaProject != null && f.projectId === undefined) f.projectId = __ideaProject;
      id = await Tasks.add({ title: f.title, due: f.due, projectId: f.projectId, ideaId: f.ideaId, areaId: f.areaId, priority: f.priority,
        assigneeId: f.assigneeId, recurrence: f.recurrence, effort: f.effort, planDate: f.planDate, notes: f.notes, link: f.link, source: f.source,
        ownerId: f.ownerId, afterIds: f.afterIds, rank: f.rank, spent: f.spent, event: f.event });
      if (__done) await Tasks.setDone(id, true);
      if (f.event) await _asstLinkTask(id);
    } else if (type === 'idea') {
      id = await table.add({ title: '', content: '', status: 'unread', projectId: null, projectIds: [], tags: [], subtasks: [], starred: false, deadline: null, createdAt: now, updatedAt: now, ...c });
    } else if (type === 'project') {
      const col = c.columnId ?? columnForType(await db.kanbanColumns.orderBy('order').toArray(), c.type || 'Proyecto');       // las columnas pensadas para ese tipo, si las hay
      id = await table.add({ status: 'active', archived: false, starred: false, tags: [], coauthors: [], type: 'Proyecto', priority: 'Media', responsible: '', deadline: null, description: '', createdAt: now, updatedAt: now, ...c, columnId: col });
    } else if (type === 'meeting') {
      id = await table.add({ title: '', date: localDateISO(), participants: '', agreements: '', projectId: null, actionItems: [], createdAt: now, updatedAt: now, ...c });
      if (c.recurrence) await Meetings.expandSeries(id);
    } else if (type === 'reference') {
      id = await table.add({ title: '', authors: '', year: null, journal: '', doi: '', url: '', projectId: null, notes: '', tags: [], createdAt: now, updatedAt: now, ...c });
    } else if (type === 'snippet') {
      id = await table.add({ title: '', code: '', language: 'Other', description: '', projectId: null, projectIds: [], tags: [], collectionId: null, starred: false, createdAt: now, updatedAt: now, ...c });
    } else if (type === 'collection') {
      id = await table.add({ name: '', color: '#38bdf8', createdAt: now, ...c });
    } else if (type === 'area') {
      id = await table.add({ name: '', description: '', color: AREA_COLORS[0], ...c });
    } else if (type === 'column') {
      const { __position, ...f } = c, last = (await table.toArray()).reduce((m, x) => Math.max(m, x.order ?? 0), -1);
      id = await table.add({ title: '', color: '#38bdf8', wip: null, isDefault: false, order: last + 1, ...f });
      if (__position) placeUndo = await _asstPlaceColumn(id, __position);
    } else {
      if ((await table.toArray()).some(p => foldText(p.name) === foldText(c.name))) throw new Error(`ya existe la persona «${c.name}»`);
      id = await table.add({ email: '', role: '', affiliation: '', notes: '', createdAt: now, ...c });
    }
    if (type === 'project' && c.submissionStatus && c.columnId === undefined) await _syncPaperColumn(id, c.submissionStatus);      // el tablero sigue al pipeline si la persona lo activó
    const created = await table.get(id);
    return { uid: created.uid, undo: async () => {
      await placeUndo?.();
      if (type === 'meeting' && c.recurrence) await db.meetings.where('seriesId').equals(created.uid).delete().catch(async () => { for (const x of await db.meetings.filter(m => m.seriesId === created.uid).toArray()) await db.meetings.delete(x.id); });
      await table.delete(id);
    } };
  }

  if (it.deferred) {                                                           // «#p1»: el registro lo crea una operación anterior del mismo lote
    const hit = _asstTemp.get(it.deferred.slice(1));
    if (!hit) throw new Error(`la referencia «${it.deferred}» no está definida: la operación que la crea no se aplicó`);
    const found = (await table.toArray()).find(r => r.uid === hit.uid);
    if (!found) throw new Error(`${T.noun} «${it.deferred}» ya no existe`);
    it.id = found.id; it.uid = found.uid;
  }
  const row = await table.get(it.id);
  if (!row) throw new Error(`${T.noun} ya no existe`);
  if (op === 'delete') return _asstDelete(type, row, table);
  // update / complete
  const set = op === 'complete' ? { done: true } : it.set;
  const c = await _asstBuild(type, set, row);
  let spawned = null, position = null;
  if (type === 'task') {
    const { __done, __ideaProject } = c;
    delete c.__done; delete c.__ideaProject;
    if (__ideaProject != null && c.projectId === undefined) c.projectId = __ideaProject;
    if (__done !== undefined && __done !== !!row.done) spawned = await Tasks.setDone(row.id, __done);
  }
  if (type === 'column' && c.__position !== undefined) { position = c.__position; delete c.__position; }
  const keys = Object.keys(c);
  const before = Object.fromEntries(keys.map(k => [k, row[k]]));
  const warnings = [];
  if (keys.length && keys.every(k => JSON.stringify(row[k] ?? null) === JSON.stringify(c[k] ?? null))) warnings.push('sin cambios: ya tenía esos valores');
  const linked = [];                                                           // tareas y reuniones ligadas por «event»/«source»: se guardan para poder deshacer
  if (type === 'meeting' && row.source) linked.push(...(await db.tasks.filter(t => t.event === row.source).toArray()).map(r => ['tasks', r]));
  if (type === 'task' && (row.event || c.event)) linked.push(...(await db.meetings.filter(m => m.source === (c.event ?? row.event)).toArray()).map(r => ['meetings', r]));
  if (type === 'project' && 'columnId' in c) {
    before.columnHistory = row.columnHistory; before.columnId = row.columnId;
    const { columnId, ...rest } = c;
    await recordColumnChange(row.id, columnId);
    if (Object.keys(rest).length) await table.update(row.id, rest);
  } else if (keys.length) {
    if (type === 'project' && c.submissionStatus !== undefined && c.submissionStatus !== row.submissionStatus) {      // el tablero sigue al pipeline si la persona lo activó
      before.columnId = row.columnId; before.columnHistory = row.columnHistory;
      await table.update(row.id, c);
      await _syncPaperColumn(row.id, c.submissionStatus);
    } else await table.update(row.id, c);
  }
  const placeUndo = position ? await _asstPlaceColumn(row.id, position) : null;
  if (type === 'meeting' && ('recurrence' in c)) await Meetings.expandSeries(row.id);
  if (type === 'meeting' && (c.date || c.time !== undefined || c.duration !== undefined)) await EventLinks.fromMeeting(await table.get(row.id));
  if (type === 'task' && ('planDate' in c || 'effort' in c || 'event' in c)) await EventLinks.fromTask(await table.get(row.id));
  return {
    uid: row.uid, warnings,
    undo: async () => {
      for (const [t, r] of linked) await db[t].put(r);
      if (spawned) await db.tasks.delete(spawned);
      if (type === 'task' && 'done' in set) await db.tasks.update(row.id, { done: !!row.done, doneAt: row.doneAt ?? null });
      await placeUndo?.();
      if (Object.keys(before).length) await table.update(row.id, before);
      if (type === 'meeting' && 'recurrence' in c) await Meetings.expandSeries(row.id);
    },
  };
}

const Assistant = {
  KEY: 'assistant-dir-handle',
  paused: false, _busy: false, _dirty: false, _timer: null, _poll: null,
  _queue: [], _handled: new Set(), _hash: '', _md: '',

  /** Orígenes (correo, evento…) que la persona descartó o borró: si la IA vuelve a proponerlos, se omiten sin preguntar otra vez. */
  _ignored() { try { return JSON.parse(localStorage.getItem('ros-asst-ignored') || '[]'); } catch { return []; } },
  isIgnored(src) { return !!src && this._ignored().includes(Tasks.cleanSource(src)); },
  rememberSource(src) {
    const s = Tasks.cleanSource(src);
    if (!s) return;
    try { localStorage.setItem('ros-asst-ignored', JSON.stringify([...new Set([...this._ignored(), s])].slice(-500))); } catch {}
  },
  supported: () => typeof window.showDirectoryPicker === 'function',
  enabled:   () => localStorage.getItem('ros-assistant') === '1',
  mode:      () => localStorage.getItem('ros-assistant-mode') === 'auto' ? 'auto' : 'review',
  setMode(m) { try { localStorage.setItem('ros-assistant-mode', m === 'auto' ? 'auto' : 'review'); } catch {} },
  // Dos permisos, ambos desactivados por defecto: con el primero la IA puede borrar cualquier dato (y, en modo automático, sin revisión);
  // con el segundo llega a los ajustes de la app (áreas, columnas del tablero, etapas de Submissions, campos por tipo, horas útiles…).
  fullControl: () => { try { return localStorage.getItem('ros-assistant-full') === '1'; } catch { return false; } },
  appSettings: () => { try { return localStorage.getItem('ros-assistant-config') === '1'; } catch { return false; } },
  /** Qué registros tocó la IA y cuándo (para distinguir en `recentChanges` lo que hizo ella de lo que hizo la persona). */
  touch(uid) { try { const m = this.touched(); m[uid] = new Date().toISOString(); const cut = Date.now() - 4 * 86400000; for (const k of Object.keys(m)) if (new Date(m[k]) < cut) delete m[k]; localStorage.setItem('ros-asst-touched', JSON.stringify(m)); } catch {} },
  touched() { try { return JSON.parse(localStorage.getItem('ros-asst-touched') || '{}') || {}; } catch { return {}; } },
  setPermission(which, on) { try { localStorage.setItem(which === 'full' ? 'ros-assistant-full' : 'ros-assistant-config', on ? '1' : '0'); } catch {} },
  lastRun:   () => +localStorage.getItem('ros-assistant-last') || null,
  async handle() { return (await db.settings.get(this.KEY))?.value || null; },
  async permission(h, { ask = false } = {}) {
    const o = { mode: 'readwrite' };
    let p = await h.queryPermission?.(o);
    if (p !== 'granted' && ask) p = await h.requestPermission?.(o);
    return p || 'denied';
  },
  async choose() { return this.use(await window.showDirectoryPicker({ mode: 'readwrite', id: 'researchos-assistant' })); },
  /** Activa el asistente en una carpeta ya elegida (p. ej. la que usa otra función). */
  async use(handle) {
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
    await _asstRefreshPrivacy();
    const [rawProjects, rawTasks, rawIdeas, rawMeetings, rawPeople, columns, rawRefs, rawSnippets, collections, tombstones] = await Promise.all([
      db.projects.toArray(), db.tasks.toArray(), db.ideas.toArray(), db.meetings.toArray(), db.collaborators.toArray(), db.kanbanColumns.orderBy('order').toArray(),
      db.references.toArray(), db.snippets.toArray(), db.snippetCollections.toArray(), db.tombstones.toArray()]);
    const vis = (type, rows) => rows.filter(r => !_asstHidden(type, r));                 // lo privado (y lo que cuelga de ello) no se publica
    const projects = vis('project', rawProjects), tasks = vis('task', rawTasks), ideas = vis('idea', rawIdeas), meetings = vis('meeting', rawMeetings),
          people = vis('person', rawPeople), references = vis('reference', rawRefs), snippets = vis('snippet', rawSnippets);
    const hiddenCount = rawProjects.length - projects.length + rawTasks.length - tasks.length + rawPeople.length - people.length;
    const full = Assistant.fullControl(), cap = n => full ? Infinity : n;                // con el control total la IA ve todo, sin recortes
    const areas = await _getAreas();
    const name = (rows, key) => new Map(rows.map(r => [r.id, r[key]]));
    const P = name(projects, 'title'), I = name(ideas, 'title'), C = name(people, 'name'), K = name(columns, 'title'), A = name(areas, 'name');
    const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => !(v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length))));
    const cut_ = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
    const open = tasks.filter(t => !t.done), byTaskId = Tasks.index(rawTasks), me = Me.id();
    const T = new Map(rawTasks.map(t => [t.id, t.title]));
    const blockedBy = t => Tasks.isBlocked(t, byTaskId) ? (t.afterIds || []).map(i => byTaskId.get(i)).filter(x => x && !x.done && !_asstHidden('task', x)).map(x => x.title) : [];
    const state = {
      format: ASST_STATE_FORMAT, apiVersion: ASST_API_VERSION, today, weekday: new Date(today + 'T12:00:00').toLocaleDateString('es', { weekday: 'long' }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generated: new Date().toISOString(),
      note: 'Fechas AAAA-MM-DD en hora local. Los campos ausentes están vacíos o en falso. Para cambiar algo lee AGENTS.md y deja un archivo en cambios/.',
      summary: { openTasks: open.length, overdueTasks: open.filter(t => t.due && t.due < today).length, dueToday: open.filter(t => t.due === today).length,
        dueNext7Days: open.filter(t => t.due > today && t.due <= addDaysISO(7)).length, waitingOnOthers: open.filter(t => Me.waiting(t.assigneeId)).length,
        blockedTasks: open.filter(t => Tasks.isBlocked(t, byTaskId)).length, pausedProjects: projects.filter(p => p.paused && !p.archived).length,
        activeProjects: projects.filter(p => !p.archived).length, archivedProjects: projects.filter(p => p.archived).length, unreadIdeas: ideas.filter(i => i.status === 'unread').length },
      permissions: { fullControl: full, appSettings: Assistant.appSettings() },
      fields: Object.fromEntries(Object.entries(ASST_TYPES).filter(([, T]) => !T.config || Assistant.appSettings()).map(([k, T]) => [k, { ops: _asstOps(T), set: Object.keys(ASST_FIELDS[k]) }])),      // qué se puede escribir hoy en cada tipo
      me: me && C.get(me) ? C.get(me) : null,                                                // «yo» en la agenda de personas: lo asignado a esta persona no es esperar a nadie
      ...(hiddenCount ? { privacy: 'Hay registros marcados como privados por la persona: no aparecen aquí y no puedes referirte a ellos.' } : {}),
      estimateAccuracy: Tasks.accuracy(rawTasks.filter(t => !_asstHidden('task', t))),
      recentChanges: Assistant._recentChanges({ projects, tasks, ideas, meetings, people, references, snippets, tombstones }),
      columns: columns.map(c => c.title), columnsInfo: columns.map(c => clean({ uid: c.uid, title: c.title, color: c.color, wip: c.wip, order: c.order, types: c.types, count: projects.filter(p => !p.archived && p.columnId === c.id).length, overWip: !!c.wip && projects.filter(p => !p.archived && !p.paused && p.columnId === c.id).length > c.wip })),
      areas: areas.map(a => clean({ uid: a.uid, name: a.name, description: a.description, color: a.color, parent: A.get(a.parentId) })),
      collections: collections.map(c => clean({ uid: c.uid, name: c.name, color: c.color })),
      settings: await (async () => { const r = await _asstSettingsRead(); return { ...r, submissionStages: r.submissionStages.map(x => ({ key: x.key, label: x.label })),
        submissionColumnMap: Object.fromEntries(Object.entries(r.submissionColumnMap).map(([k, id]) => [k, K.get(+id)]).filter(([, v]) => v)) }; })(),
      archivedProjects: projects.filter(p => p.archived).map(p => clean({ uid: p.uid, title: p.title, type: p.type, submissionStatus: p.submissionStatus })),
      projectTypes: ASST_PROJECT_TYPES, submissionStages: SUB_STATUSES.map(x => ({ key: x.key, label: x.label })),
      people: people.map(c => clean({ uid: c.uid, name: c.name, role: c.role, affiliation: c.affiliation, email: c.email, followUpDays: c.followUpDays, lastContact: c.lastContact, notes: cut_(c.notes, 300) })),
      projects: projects.filter(p => !p.archived).map(p => clean({ uid: p.uid, title: p.title, type: p.type, column: K.get(p.columnId), priority: p.priority, deadline: p.deadline,
        responsible: p.responsible || C.get(p.responsibleId), area: A.get(p.areaId), parent: P.get(p.parentId), rank: p.rank, paused: p.paused, pauseReason: p.pauseReason, pausedUntil: p.pausedUntil, tags: p.tags, starred: p.starred, coauthors: p.coauthors, submissionStatus: p.submissionStatus, targetVenue: p.targetVenue, submittedAt: p.submittedAt,
        customFields: p.customFields, submissionNotes: cut_(p.submissionNotes, 300), submissionRounds: (p.submissionRounds || []).map(r => clean({ submittedAt: r.submittedAt, decision: r.decision, decisionDate: r.decisionDate, venue: r.venue, notes: cut_(r.notes, 200) })),
        description: cut_(p.description, 400) })),
      tasks: tasks.filter(t => !t.done || full || (t.doneAt || '') > recent).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, cap(600)).map(t => clean({
        uid: t.uid, title: t.title, done: t.done, doneAt: t.done ? t.doneAt : null, due: t.due, late: !t.done && t.due && t.due < today, priority: t.priority,
        notes: cut_(t.notes, 300), link: t.link, source: t.source,
        project: P.get(t.projectId), idea: I.get(t.ideaId), assignee: me && t.assigneeId === me ? null : C.get(t.assigneeId), owner: C.get(t.ownerId), repeat: t.recurrence, minutes: t.effort, spent: t.spent, rank: t.rank,
        after: (t.afterIds || []).map(i => T.get(i)).filter(Boolean), blockedBy: blockedBy(t), event: t.event, planDate: t.planDate, area: A.get(t.areaId) })),
      ideas: ideas.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, cap(200)).map(i => clean({
        uid: i.uid, title: i.title, status: i.status, project: P.get(i.projectId), tags: i.tags, deadline: i.deadline, starred: i.starred, source: i.source, content: cut_(i.content, 500) })),
      meetings: meetings.filter(m => full || (m.date || '') >= cut).sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(0, cap(60)).map(m => clean({
        uid: m.uid, title: m.title, date: m.date, time: m.time, duration: m.duration, source: m.source, repeat: m.recurrence, series: m.seriesId, project: P.get(m.projectId), participants: m.participants, agreements: cut_(m.agreements, 400),
        actionItems: (m.actionItems || []).map(a => clean({ text: a.text, done: a.done, due: a.due, assignee: C.get(a.assigneeId) })) })),
      references: references.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, cap(300)).map(r => clean({
        uid: r.uid, title: r.title, authors: r.authors, year: r.year, journal: r.journal, doi: r.doi, url: r.url, project: P.get(r.projectId), tags: r.tags,
        readStatus: r.readStatus, citeKey: r.citeKey, source: r.source, notes: cut_(r.notes, 300) })),
      snippets: snippets.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, cap(150)).map(r => clean({
        uid: r.uid, title: r.title, language: r.language, description: cut_(r.description, 200), project: P.get(r.projectId), tags: r.tags, starred: r.starred, code: cut_(r.code, 300) })),
    };
    return state;
  },

  /** Lo que cambió en las últimas 48 h y quién lo hizo: la persona o la propia IA (por lo que ella marcó como tocado). Sirve para no releer todo. */
  _recentChanges({ projects, tasks, ideas, meetings, people, references, snippets, tombstones }) {
    const since = Date.now() - 48 * 3600000, touched = this.touched(), out = [];
    const by = (uid, at) => touched[uid] && new Date(touched[uid]) >= new Date(at) - 5000 ? 'assistant' : 'user';       // si la última modificación es posterior a lo que tocó la IA, fue la persona
    const add = (type, key, rows) => {
      for (const r of rows) {
        const done = type === 'task' && r.done && r.doneAt && new Date(r.doneAt) >= since;
        const at = done ? r.doneAt : (r.updatedAt || r.createdAt);
        if (!at || new Date(at) < since) continue;
        const created = !done && r.createdAt && Math.abs(new Date(r.createdAt) - new Date(at)) < 3000;
        out.push({ type, uid: r.uid, title: r[key], change: done ? 'completed' : created ? 'created' : 'updated', at, by: by(r.uid, at) });
      }
    };
    add('task', 'title', tasks); add('project', 'title', projects); add('idea', 'title', ideas); add('meeting', 'title', meetings);
    add('person', 'name', people); add('reference', 'title', references); add('snippet', 'title', snippets);
    const kinds = { tasks: 'task', projects: 'project', ideas: 'idea', meetings: 'meeting', collaborators: 'person', references: 'reference', snippets: 'snippet' };
    for (const t of tombstones) if (kinds[t.table] && t.deletedAt && new Date(t.deletedAt) >= since) out.push({ type: kinds[t.table], uid: t.uid, change: 'deleted', at: t.deletedAt, by: by(t.uid, t.deletedAt) });
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
  },

  /** La misma información como agenda en Markdown (las referencias a registros usan los 8 primeros caracteres del uid). */
  markdown(s) {
    const short = u => '`' + String(u).slice(0, 8) + '`';
    const line = t => `- [${t.done ? 'x' : ' '}] ${t.title}${t.project ? ` — ${t.project}` : ''}${t.due ? ` · ${t.due}` : ''}${t.priority ? ` · ${t.priority}` : ''}${t.assignee ? ` · esperando a ${t.assignee}` : ''}${t.owner ? ` · responsable ${t.owner}` : ''}${t.blockedBy?.length ? ` · después de «${t.blockedBy[0]}»` : ''}${t.repeat ? ` · ↻ ${t.repeat.freq}` : ''} ${short(t.uid)}`;
    const open = s.tasks.filter(t => !t.done && !t.blockedBy?.length);              // lo que espera a otra tarea tiene su propia sección
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
      sect('Esperan a otra tarea', s.tasks.filter(t => !t.done && t.blockedBy?.length)) +
      (s.meetings.filter(m => m.date >= s.today).length ? `\n## Reuniones próximas\n\n${s.meetings.filter(m => m.date >= s.today).map(m => `- ${m.date} · ${m.title}${m.project ? ` — ${m.project}` : ''} ${short(m.uid)}`).join('\n')}\n` : '') +
      `\n## Proyectos activos (${s.projects.length})\n\n${s.projects.map(p => `- **${p.title}**${p.paused ? ' ⏸ en pausa' + (p.pauseReason ? ` (${p.pauseReason})` : '') : ''} · ${p.column || '—'}${p.deadline ? ` · vence ${p.deadline}` : ''}${p.priority ? ` · ${p.priority}` : ''} ${short(p.uid)}`).join('\n') || '_ninguno_'}\n` +
      (s.ideas.filter(i => i.status === 'unread').length ? `\n## Ideas sin leer\n\n${s.ideas.filter(i => i.status === 'unread').map(i => `- ${i.title}${i.project ? ` — ${i.project}` : ''} ${short(i.uid)}`).join('\n')}\n` : '');
  },

  /** Instrucciones para cualquier LLM, generadas desde los mismos campos que valida la app (nunca se desactualizan). */
  instructions() {
    const f = t => Object.keys(ASST_FIELDS[t]).map(k => '`' + k + '`').join(', ');
    const typeLines = Object.entries(ASST_TYPES).filter(([, T]) => !T.config || Assistant.appSettings())
      .map(([k, T]) => `${T.noun} \`${k}\` (${_asstOps(T).join(', ')})`).join(' · ');
    return `${ASST_MARK}
# ResearchOS — instrucciones para un asistente de IA

Esta carpeta es la puerta de entrada de un asistente de IA a ResearchOS (una app local de gestión de investigación). Tu trabajo: ayudar a la persona a mantener al día sus pendientes, tareas, ideas, reuniones, proyectos (incluidos los papers de *Submissions*), personas, referencias y snippets.

## Qué hay aquí

| Archivo | Quién lo escribe | Para qué |
|---|---|---|
| \`estado.json\` | la app (solo lectura para ti) | Todo el estado, con nombres legibles y \`uid\` estables. **Léelo siempre antes de proponer cambios.** |
| \`pendientes.md\` | la app (solo lectura) | La misma agenda en Markdown: atrasado, hoy, próximos días, esperando a otros. |
| \`cambios/\` | **tú** | Aquí dejas los cambios, uno o varios archivos \`.json\`. |
| \`resultados/\` | la app | Con el mismo nombre que tu archivo: qué se aplicó, qué falló y por qué. |

**No edites \`estado.json\` ni \`pendientes.md\`**: se regeneran y tus cambios se perderían. Todo cambio va por \`cambios/\`.

Si la persona usa esta carpeta también para la sincronización o la copia de seguridad, verás archivos \`researchos-sync-*.json\` y \`researchos-backup-*.json\`: son copias técnicas de todos los datos. **Ignóralos** (no los leas ni los modifiques): trabaja solo con \`estado.json\`, \`pendientes.md\` y \`cambios/\`.

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

- \`op\`: \`add\`, \`update\`, \`complete\` (solo tareas) o \`delete\`. Qué operaciones admite cada tipo depende de los permisos que la persona haya dado (ver «Permisos»).
- \`type\` y operaciones permitidas ahora: ${typeLines}.
- Para \`update\`, \`complete\` y \`delete\` indica el registro con \`uid\` (el completo o sus **8 primeros caracteres**, como en \`pendientes.md\`). Si no lo tienes, \`"match": "título exacto"\` también sirve cuando es único.
- \`set\` lleva los campos. Para borrar un valor ponlo en \`null\`.
- Los **nombres** de proyectos, personas, ideas, columnas y áreas sirven como referencia (sin importar mayúsculas ni tildes). Si son ambiguos, usa el \`uid\`.
- Fechas: \`AAAA-MM-DD\`, en la hora local de \`estado.json\` (\`today\`). Prioridades: \`Alta\`, \`Media\`, \`Baja\`.
- Un lote puede crear un proyecto y, después, tareas que lo mencionen por nombre. Máximo ${ASST_MAX_OPS} operaciones por archivo.

### Campos de \`set\` por tipo

- **task**: ${f('task')}. \`repeat\`: \`{"freq":"daily|weekly|monthly","interval":1,"until":"AAAA-MM-DD"}\` (o solo \`"weekly"\`). \`minutes\`: tiempo estimado. \`planDate\`: el día en que la harás. \`assignee\`: persona de la que esperas la tarea. \`owner\`: quién la hace (**no** cuenta como espera; para una tarea tuya o de la persona usa \`owner\`, no \`assignee\`). Si en \`estado.json\` aparece \`me\`, asignarle una tarea a esa persona tampoco es «esperar a nadie». \`after\`: lista de tareas (nombre, uid o \`#id\`) que deben completarse antes: la tarea queda oculta de Hoy y de la carga hasta entonces (\`blockedBy\` en el estado). \`rank\`: orden manual, menor = antes (desempata dentro del mismo día). \`spent\`: minutos realmente dedicados (la app compara con \`minutes\` en \`estimateAccuracy\`). \`event\`: el \`source\` de la reunión (bloque del calendario) a la que está ligada: el día de la reunión es el \`planDate\` de la tarea y su duración, los \`minutes\`, y se siguen en los dos sentidos.
- **idea**: ${f('idea')}. \`status\`: \`unread\` o \`reviewed\`.
- **project**: ${f('project')}. \`column\`: nombre de la columna del tablero (ver \`columns\`). \`type\` es uno de \`projectTypes\` (\`Proyecto\`, \`Grant\`, \`Paper\`…).
  - **Submissions:** un proyecto de \`type\` \`Paper\` aparece en la vista *Submissions*. Su etapa es \`submissionStatus\` (una clave de \`submissionStages\` en \`estado.json\`; por defecto \`preparacion\`, \`enviado\`, \`en_revision\`, \`revision_solicitada\`, \`aceptado\`, \`rechazado\`). Al pasar a \`enviado\` se anota la fecha de envío, y si la persona activó la sincronización con el tablero, la columna se mueve sola. \`targetVenue\`: revista o fondo objetivo; \`submittedAt\`: fecha de envío; \`submissionNotes\`: notas. \`submissionRounds\` reemplaza las rondas de revisión y \`addSubmissionRounds\` añade: lista de \`{"submittedAt","decision","decisionDate","venue","notes"}\` con \`decision\` = \`major\`, \`minor\`, \`reject\`, \`accept\` o \`pending\`. Estos campos solo se aceptan en proyectos Paper (pon \`"type":"Paper"\` en el mismo \`set\` si hace falta).
  - \`coauthors\`: nombres separados por coma o lista; los que coincidan con una persona se enlazan a ella.
  - \`rank\`: posición manual en su columna (menor = antes). \`paused\`: en pausa (sale de Hoy y de la carga), con \`pauseReason\` y \`pausedUntil\` (fecha para revisar la pausa).
- **meeting**: ${f('meeting')}. \`addActionItems\`: lista de \`{"text","due","assignee","done"}\` que se añade a los acuerdos. \`repeat\` (igual que en las tareas) crea las próximas ocurrencias (unos 4 meses) como reuniones independientes; en el estado traen \`series\`.
- **person**: ${f('person')}. \`followUpDays\`: cada cuántos días hay que escribirle (7, 14, 30, 90 o 180; \`null\` para quitarlo); \`lastContact\`: última vez que se hablaron.
- **reference** (bibliografía): ${f('reference')}. \`readStatus\`: \`toread\`, \`reading\` o \`read\`. \`doi\` sin la URL; \`url\` solo http(s).
- **snippet** (código): ${f('snippet')}. Para añadir hacen falta \`title\` y \`code\`; \`language\` es R, Python, Bash, SQL u Other.
- **collection** (colección de snippets): ${f('collection')}.${Assistant.appSettings() ? `
- **area** (frentes de trabajo, p. ej. Investigación o Docencia): ${f('area')}. Borrar un área deja sin área a sus proyectos y tareas. \`parent\`: área en la que se anida (elegir un área en el menú incluye sus subáreas).
- **column** (columnas del tablero): ${f('column')}. \`position\` es el lugar (1 = la primera); al borrar una columna sus proyectos pasan a la anterior (o a la siguiente). Siempre queda al menos una. \`types\`: lista de tipos de proyecto para los que existe la columna (vacía = todos); los proyectos de ese tipo empiezan en ella.
- **setting** (un único registro, sin \`uid\`: \`{"op":"update","type":"setting","set":{…}}\`): ${f('setting')}. \`dailyMinutes\`: minutos útiles al día (30–960) para la carga y el plan semanal; \`submissionStages\`: lista \`[{"key","label","shortLabel","color","icon"}]\` que **reemplaza** las etapas de Submissions (no se pueden quitar las que usa algún paper); \`projectFields\`: \`{"Paper":[{"key","label","type":"text|number","placeholder"}]}\` define los campos extra de cada tipo de proyecto, que luego se rellenan con \`customFields\` en el proyecto; \`submissionColumnMap\`: \`{"enviado":"Nombre de columna"}\`; \`syncPaperColumn\`: si el tablero sigue al pipeline; \`profile\`: \`all\`, \`research\`, \`teaching\` o \`management\`; \`theme\`: \`dark\`/\`light\`; \`accent\`: \`blue\`/\`green\`/\`purple\`. Los valores actuales están en \`settings\` de \`estado.json\`.` : ''}

## Permisos

La persona decide hasta dónde llegas (Ajustes → Asistente de IA). Ahora mismo:

- **Control total de los datos: ${Assistant.fullControl() ? 'ACTIVADO' : 'desactivado'}.** ${Assistant.fullControl() ? 'Puedes borrar cualquier dato (proyectos, personas, reuniones, colecciones, tareas, ideas, referencias y snippets) y `estado.json` trae todo sin recortes. Borrar un proyecto deja sus tareas, ideas y reuniones sueltas; borrar una persona la quita de responsables y coautores. Úsalo con criterio: aunque se pueda deshacer, no borres por tu cuenta lo que la persona no haya pedido.' : 'No puedes borrar proyectos, personas, reuniones ni colecciones, y los borrados de tareas, ideas, referencias y snippets los revisa la persona. `estado.json` recorta lo antiguo (tareas hechas hace más de 14 días, reuniones de hace más de 30 días…).'}
- **Ajustes de la app: ${Assistant.appSettings() ? 'ACTIVADOS' : 'desactivados'}.** ${Assistant.appSettings() ? 'Puedes tocar áreas, columnas del tablero y los ajustes (`setting`). Cambia solo lo que la persona pida.' : 'Los tipos `area`, `column` y `setting` se rechazan. Si la persona te pide algo de eso, dile que lo active.'}
- **Privado:** la persona puede marcar proyectos, personas y tareas como privados. No aparecen en \`estado.json\` ni en \`pendientes.md\` (ni lo que cuelga de ellos: sus tareas, ideas, reuniones…), y si los nombras la app responde que no existen. No intentes adivinarlos.
- Nunca están a tu alcance: restaurar o vaciar datos, la sincronización, las copias de seguridad, las carpetas vinculadas, los permisos del navegador y estos mismos permisos.


## Varias operaciones relacionadas en un mismo lote

Una operación \`add\` puede llevar un nombre temporal (\`"id": "p1"\`) y las siguientes del **mismo archivo** lo usan como \`"#p1"\` donde iría un nombre o un uid (\`project\`, \`after\`, \`uid\`, \`match\`…). Así creas y modificas en un solo paso y el orden importa: define el \`id\` antes de usarlo.

\`\`\`json
{ "ops": [
  { "op": "add", "id": "p1", "type": "project", "set": { "title": "Tesis cap. 3", "type": "Paper" } },
  { "op": "add", "id": "t1", "type": "task", "set": { "title": "Pedir datos", "project": "#p1" } },
  { "op": "add", "type": "task", "set": { "title": "Analizar", "project": "#p1", "after": ["#t1"] } },
  { "op": "update", "type": "project", "uid": "#p1", "set": { "submissionStatus": "preparacion" } }
] }
\`\`\`

## Lo que cambió desde la última vez

\`estado.json\` trae \`recentChanges\`: lo creado, modificado, completado o borrado en las últimas 48 h, con \`by\` = \`user\` o \`assistant\`. Léelo en vez de releer todo para enterarte de lo que hizo la persona. También trae \`estimateAccuracy\` (cuánto se desvían sus estimaciones) y, en cada columna, \`overWip\` si se pasó de su tope.


## Qué pasa después

1. La app (debe estar abierta en el navegador) lee \`cambios/\` cada pocos segundos.
2. Por defecto **la persona revisa y acepta** tus cambios; ${Assistant.fullControl() ? 'con el **control total** activado, los borrados siguen el mismo modo que el resto (en automático se aplican enseguida y se pueden deshacer)' : 'los borrados **siempre** se revisan'}. Si activó «aplicar automáticamente», ${Assistant.fullControl() ? 'todo se aplica enseguida y se puede deshacer' : 'lo que no es un borrado se aplica enseguida y se puede deshacer'}.
3. La app escribe \`resultados/<mismo nombre>.json\`: primero \`status: "received"\` en cuanto ve el archivo, luego \`pending\` (espera revisión) o \`done\` y, por operación, \`applied\`, \`rejected\`, \`skipped\` o \`error\` (con el motivo y el \`uid\` creado), más \`warnings\` cuando algo no hizo lo que parecía (p. ej. «sin cambios: ya tenía esos valores»). **Léelo** y corrige lo que haya fallado en un archivo nuevo.
4. \`estado.json\` se actualiza con lo aplicado.

## Buenas prácticas

- Lee primero \`estado.json\` (o \`pendientes.md\`) y no inventes \`uid\`: cópialos.
- Propón cambios pequeños y explicados en \`note\`; no reorganices todo de golpe.
- Antes de añadir una tarea, comprueba que no existe ya una igual.
- \`estado.json\` trae \`apiVersion\` y \`fields\` (las operaciones y campos que la app admite **ahora**, por tipo): consúltalos en lugar de probar. Si un campo que aparece aquí es rechazado como «no admitido», la pestaña de ResearchOS está desactualizada: pide a la persona que la recargue.
- Un lote no puede modificar lo que ese mismo lote acaba de crear (todavía no tiene \`uid\`): hazlo en un segundo archivo, o localízalo luego por su \`source\`.
- **Si lo que traes viene de fuera (un correo, un evento del calendario…), pon siempre \`source\`** (p. ej. \`gmail:<id del hilo>\`, \`gcal:<id del evento>\`) y, si existe, \`link\` a la página original. La app **omite** lo que ya entró con ese \`source\` y lo que la persona descartó o borró (así puedes repasar el correo cada día sin duplicar), y te deja completar o modificar sin conocer el \`uid\`: \`{ "op": "complete", "type": "task", "source": "gmail:18c3" }\`. En \`add\`, \`source\` va dentro de \`set\`; en \`update\`/\`complete\`/\`delete\` va al lado de \`op\`.
- Las reuniones llevan \`date\`, \`time\` (HH:MM, hora local) y \`duration\` (minutos); las tareas pueden llevar \`notes\` (contexto) y \`link\`.
- No borres salvo que la persona lo pida. Completar una tarea es \`complete\`, no \`delete\`.

## Herramienta incluida (opcional)

Si hay un archivo \`researchos.js\` en esta carpeta (Node 18+, sin dependencias) hace estos pasos por ti, desde esta misma carpeta:

- \`node researchos.js resumen\` · \`node researchos.js tareas --hasta semana\` · \`node researchos.js buscar "figuras"\`
- \`node researchos.js añadir-tarea "Enviar borrador" --fecha 2026-11-06 --proyecto "Paper Alfa" --prioridad Alta --esperar\`
- \`node researchos.js completar "Enviar borrador"\` · \`node researchos.js modificar <uid> --fecha 2026-11-10\` · \`node researchos.js ayuda\`
- Cualquier tipo: \`node researchos.js cambiar proyecto "Paper Alfa" submissionStatus=en_revision targetVenue=Nature\` · \`node researchos.js añadir referencia "Título" year=2020\`
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
    await _asstRefreshPrivacy();
    const tempTypes = new Map();                                                           // «id» temporales declarados por los «add» de este lote
    for (const [i, raw] of change.ops.entries()) {
      const it = { i, op: raw?.op, type: raw?.type, status: 'pending', label: '', set: null, id: null, destructive: false, warnings: [] };
      try {
        const T = ASST_TYPES[raw?.type];
        if (!T) throw new Error(`type «${raw?.type}» no existe (${Object.keys(ASST_TYPES).join(', ')})`);
        if (T.config && !Assistant.appSettings()) throw new Error(`«${raw.type}» es parte de los ajustes de la app: la persona debe activar «Ajustes de la app» en Ajustes → Asistente de IA`);
        const allowed = _asstOps(T);
        if (!allowed.includes(raw.op)) throw new Error(`«${raw.op}» no está permitido para ${T.noun} (admite: ${allowed.join(', ')})${T.full?.includes(raw.op) ? '. Para borrar la persona debe activar «Control total de los datos» en Ajustes → Asistente de IA' : ''}`);
        const reserved = new Set(['op', 'type', 'uid', 'match', 'note', ...(raw.op === 'add' ? ['id'] : ['source'])]);     // fuera de «add», «source» solo localiza el registro; «id» es un nombre temporal para el lote
        if (raw.op !== 'add' && raw.source !== undefined && (raw.uid !== undefined || raw.match !== undefined)) it.warnings.push('«source» solo sirve para localizar el registro (ya lo señalaste con uid/match): no se modifica');
        it.set = raw.set && typeof raw.set === 'object' && !Array.isArray(raw.set) ? raw.set
          : Object.fromEntries(Object.entries(raw).filter(([k]) => !reserved.has(k)));
        if (raw.op !== 'complete' && raw.op !== 'delete') {
          const known = ASST_FIELDS[raw.type];
          const bad = Object.keys(it.set).filter(k => !known[k]);
          if (bad.length) throw new Error(`campo «${bad[0]}» no admitido en ${T.noun}. Admitidos: ${Object.keys(known).join(', ')} (apiVersion ${ASST_API_VERSION}; si ResearchOS se actualizó hace poco, hay que recargar su pestaña para que use la versión nueva)`);
          if (raw.op === 'add' && !it.set[T.key]) throw new Error(`falta ${T.key} en «set»`);
          if (raw.op === 'add' && raw.type === 'snippet' && !it.set.code) throw new Error('falta code en «set»');
          if (raw.op === 'update' && !Object.keys(it.set).length) throw new Error('«set» está vacío');
        }
        if (raw.op === 'add') {
          if (raw.id !== undefined) {
            if (!/^[\w-]{1,40}$/.test(String(raw.id))) throw new Error('«id» (nombre temporal) debe tener letras, números, _ o - (máx. 40)');
            if (tempTypes.has(String(raw.id))) throw new Error(`el «id» «${raw.id}» está repetido en este lote`);
            tempTypes.set(String(raw.id), raw.type); it.tempId = String(raw.id);
          }
          const s = it.set, bits = [s.due && `vence ${s.due}`, (s.project) && `proyecto ${s.project}`, s.assignee && `esperando a ${s.assignee}`, s.date && s.date].filter(Boolean);
          it.label = `Añadir ${T.noun} «${s.title ?? s.name}»${bits.length ? ' · ' + bits.join(' · ') : ''}`;
          const src = s.source != null ? Tasks.cleanSource(s.source) : '';                      // lo que ya entró desde ese origen (o que descartaste) no se vuelve a proponer
          if (src) {
            const dup = (await _asstTable(T).toArray()).find(r => r.source === src);
            if (dup) { it.status = 'skipped'; it.reason = 'ya existe (mismo origen)'; it.uid = dup.uid; }
            else if (Assistant.isIgnored(src)) { it.status = 'skipped'; it.reason = 'la descartaste antes'; }
          }
        } else if (!T.singleton && typeof (raw.uid ?? raw.match) === 'string' && String(raw.uid ?? raw.match)[0] === '#') {      // «#p1»: lo crea una operación anterior de este lote
          const ref = String(raw.uid ?? raw.match), name = ref.slice(1);
          if (!tempTypes.has(name)) throw new Error(`«${ref}» no está definido antes en este lote (crea el registro con "id":"${name}" en una operación anterior)`);
          if (tempTypes.get(name) !== raw.type) throw new Error(`«${ref}» es ${ASST_TYPES[tempTypes.get(name)].noun}, no ${T.noun}`);
          it.deferred = ref;
          const fmt = v => v === null ? 'vacío' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          it.label = raw.op === 'delete' ? `Eliminar ${T.noun} «${ref}»` : raw.op === 'complete' ? `Completar tarea «${ref}»` : `Modificar ${T.noun} «${ref}»: ${Object.entries(it.set).map(([k, v]) => `${k} → ${fmt(v)}`).join(', ')}`;
          it.destructive = raw.op === 'delete';
        } else {
          const bySource = !T.singleton && _asstEmpty(raw.uid) && _asstEmpty(raw.match) && !_asstEmpty(raw.source);
          if (!T.singleton && _asstEmpty(raw.uid) && _asstEmpty(raw.match) && !bySource) throw new Error('falta «uid» (o «match» con el título exacto, o «source» con el origen)');
          const rows = (await _asstTable(T).toArray()).filter(r => !_asstHidden(raw.type, r));      // lo privado no existe para la IA
          let row;
          if (T.singleton) row = rows[0];
          else if (bySource) {
            const src = Tasks.cleanSource(raw.source), hits = rows.filter(r => r.source === src);
            if (hits.length !== 1) throw new Error(hits.length ? `hay ${hits.length} ${T.noun}s con el origen «${src}»: usa su uid` : `no hay ${T.noun} con el origen «${src}»`);
            row = hits[0];
          } else row = _asstFind(rows, raw.uid ?? raw.match, T.label, T.noun);
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
    const text = JSON.stringify({ format: 'researchos-result/1', file: batch.name, status: batch.received ? 'received' : pending ? 'pending' : 'done', mode: this.mode(), at: new Date().toISOString(),
      ...(batch.error ? { error: batch.error } : {}),
      ops: batch.items.map(({ i, op, type, status, label, uid, error, reason, warnings }) => ({ index: i, op, type, status, label, ...(uid ? { uid } : {}), ...(error ? { error } : {}), ...(reason ? { reason } : {}),
        ...(warnings?.length ? { warnings } : {}) })) }, null, 1);
    try { await this._write(await batch.dir.getDirectoryHandle('resultados', { create: true }), batch.name, text); } catch (e) { console.warn('Asistente: no se pudo escribir el resultado', e); }
  },

  /** Ejecuta en orden las operaciones indicadas. Cada una es independiente: si una falla, las demás siguen. */
  async _apply(batch, items) {
    const undos = [];
    await _asstRefreshPrivacy();
    _asstTemp = batch.refs || (batch.refs = new Map());                                   // los «id» temporales del lote sobreviven a una revisión por partes
    for (const it of items) {
      try {
        const r = await _asstRun(it);
        it.status = r.skipped ? 'skipped' : 'applied'; it.reason = r.skipped; it.uid = r.uid || it.uid; undos.push(r.undo);
        if (r.warnings?.length) it.warnings = [...(it.warnings || []), ...r.warnings];
        if (it.tempId) _asstTemp.set(it.tempId, { type: it.type, uid: r.uid });
        if (it.status === 'applied' && r.uid) Assistant.touch(r.uid);
      }
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
        if (st !== 'pending' && st !== 'received') {
          this._handled.add(name);
          if (Date.now() - file.lastModified > 60 * 86400000) { await cambios.removeEntry(name).catch(() => {}); await resultados.removeEntry(name).catch(() => {}); }   // limpieza de lo viejo
          continue;
        }
      }
      if (Date.now() - file.lastModified < 1500) {                            // todavía se está escribiendo: se lee en la siguiente vuelta
        if (!prev) await this._result({ name, dir, items: [], received: true });          // pero la IA ya sabe que lo vimos
        continue;
      }
      const batch = { name, dir, author: 'asistente', note: '', items: [], error: null };
      let change;
      try { change = JSON.parse(await file.text()); }
      catch (e) {
        if (Date.now() - file.lastModified < 15000) { if (!prev) await this._result({ name, dir, items: [], received: true }); continue; }      // puede estar a medias: se espera un poco antes de darlo por inválido
        batch.error = 'JSON no válido: ' + e.message; await this._result(batch); this._handled.add(name); continue;
      }
      try { Object.assign(batch, await this.plan(change)); }
      catch (e) { batch.error = e.message; await this._result(batch); this._handled.add(name); continue; }
      const todo = batch.items.filter(i => i.status === 'pending');
      if (!todo.length) { await this._result(batch); this._handled.add(name); continue; }
      const auto = this.mode() === 'auto';
      const now = auto ? todo.filter(i => !i.destructive || this.fullControl()) : [];         // los borrados solo se aplican solos con el «Control total»
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
        ${b.items.some(i => i.status === 'skipped') ? `<div class="settings-row-desc">${b.items.filter(i => i.status === 'skipped').length} omitida(s): ya existían o las descartaste antes.</div>` : ''}
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
      pending.filter(i => !yes.includes(i)).forEach(i => { i.status = 'rejected'; if (i.op === 'add' && i.set?.source) Assistant.rememberSource(i.set.source); });
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
    Assistant._poll = setInterval(() => { if (document.visibilityState === 'visible' && !Assistant.paused) Assistant.syncNow().catch(() => {}); }, 5_000);       // la IA espera la respuesta: se mira la carpeta cada pocos segundos
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
  const groups = handle || !Assistant.supported() ? [] : await Folders.inUse('assistant');      // integrations.js
  const shared = handle ? await Folders.sharedWith('assistant', handle) : [];
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
          ${sharedFolderNote(shared)}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${handle ? `${perm !== 'granted' ? `<button class="btn btn-primary btn-sm" id="assistantResume">Reactivar</button>` : ''}
                      <button class="btn btn-ghost btn-sm" id="assistantNow">Actualizar ahora</button>
                      <button class="btn btn-ghost btn-sm" id="assistantOff">Desactivar</button>`
                   : folderButtonsHTML('assistant', groups)}
        </div>
      </div>
      ${handle ? `<div class="settings-row">
        <div><div class="settings-row-label">Cuando la IA propone cambios</div>
          <div class="settings-row-desc">«Revisar» te enseña la lista y eliges qué aplicar. «Automático» aplica de inmediato lo que no sea un borrado (con «Deshacer»). Los borrados siempre se revisan, salvo que actives el control total.</div></div>
        <select class="form-select" id="assistantMode" aria-label="Cuando la IA propone cambios" style="max-width:230px">
          <option value="review"${Assistant.mode() === 'review' ? ' selected' : ''}>Revisar antes de aplicar</option>
          <option value="auto"${Assistant.mode() === 'auto' ? ' selected' : ''}>Aplicar automáticamente</option>
        </select>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Control total de los datos</div>
          <div class="settings-row-desc">Deja que la IA también <strong>borre</strong> (proyectos, personas, reuniones, colecciones…) y vea todo sin recortes. Con «Aplicar automáticamente», los borrados se hacen sin pedirte permiso (siempre puedes pulsar «Deshacer»). Para delegar más y revisar menos. Desactivado por defecto.</div></div>
        <label class="toggle-switch"><input type="checkbox" id="assistantFull"${Assistant.fullControl() ? ' checked' : ''} aria-label="Control total de los datos"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Ajustes de la app</div>
          <div class="settings-row-desc">Deja que la IA toque también la configuración: áreas, columnas del tablero, etapas de Submissions, campos extra por tipo de proyecto, horas útiles al día, perfil y apariencia. Desactivado por defecto.</div></div>
        <label class="toggle-switch"><input type="checkbox" id="assistantConfig"${Assistant.appSettings() ? ' checked' : ''} aria-label="Ajustes de la app"><span class="toggle-slider"></span></label>
      </div>` : ''}`}
    </div>`;
  wireSameFolder('assistant', groups, async h => { await Assistant.use(h); await initAssistant(); }, refreshFolderUI);
  $('assistantOn')?.addEventListener('click', async () => {
    try { await Assistant.choose(); await initAssistant(); showToast('Asistente activado ✓', 'success'); } catch (e) { if (e?.name !== 'AbortError') showToast('No se pudo activar: ' + e.message, 'error'); }
    refreshFolderUI();
  });
  $('assistantOff')?.addEventListener('click', async () => { await Assistant.disable(); showToast('Asistente desactivado', 'info'); refreshFolderUI(); });
  const run = async ask => { try { const r = await Assistant.syncNow({ ask }); showToast(r ? 'Carpeta del asistente al día ✓' : 'No se pudo actualizar', r ? 'success' : 'error'); } catch (e) { showToast('Error: ' + e.message, 'error'); } renderAssistantSection(); };
  $('assistantNow')?.addEventListener('click', () => run(true));
  $('assistantResume')?.addEventListener('click', async () => { await run(true); await initAssistant(); });
  $('assistantMode')?.addEventListener('change', e => Assistant.setMode(e.target.value));
  const permission = (id, which, ask) => $(id)?.addEventListener('change', async e => {
    const on = e.target.checked;
    if (on && ask && !(await askConfirm(ask.text, { title: ask.title, confirmLabel: 'Activar', danger: true }))) { e.target.checked = false; return; }
    Assistant.setPermission(which, on);
    showToast(on ? 'Permiso activado' : 'Permiso desactivado', on ? 'success' : 'info');
    try { await Assistant.syncNow(); } catch {}                                          // AGENTS.md y estado.json cuentan lo que ahora se puede hacer
    renderAssistantSection();
  });
  permission('assistantFull', 'full', { title: '¿Dar control total de los datos a la IA?', text: 'Podrá borrar proyectos, personas, reuniones y el resto de tus datos, y con «Aplicar automáticamente» lo hará sin pedirte permiso. Siempre podrás deshacer lo último desde el aviso, pero te conviene tener una copia de seguridad reciente.' });
  permission('assistantConfig', 'config', { title: '¿Dejar que la IA cambie los ajustes de la app?', text: 'Podrá crear, editar y borrar áreas y columnas del tablero, y cambiar etapas de Submissions, campos por tipo de proyecto, horas útiles y apariencia.' });
}

/**
 * Pestaña desactualizada: la app que lee `cambios/` es la que está abierta, así que tras actualizar ResearchOS hay que recargarla o la IA
 * seguirá viendo (y la app validando) los campos de la versión anterior. Se compara la «huella» (ETag o fecha) de los archivos principales.
 */
const StaleTab = {
  FILES: ['src/core/app.js', 'src/core/db.js', 'src/services/assistant.js', 'src/modules/today.js'], base: null, timer: null,
  async stamp() {
    const out = [];
    for (const f of this.FILES) {
      try { const r = await fetch(f, { method: 'HEAD', cache: 'no-cache' }); out.push(r.headers.get('etag') || r.headers.get('last-modified') || String(r.status)); } catch { return null; }
    }
    return out.join('|');
  },
  async start() {
    this.base = await this.stamp();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.check(); });
    clearInterval(this.timer); this.timer = setInterval(() => this.check(), 5 * 60_000);
  },
  async check() {
    if (!this.base) return false;
    const now = await this.stamp();
    if (now && now !== this.base) { this.show(); return true; }
    return false;
  },
  show() {
    if (document.getElementById('staleBar')) return;
    const bar = document.createElement('div');
    bar.id = 'staleBar'; bar.className = 'reload-bar'; bar.setAttribute('role', 'alert');
    bar.innerHTML = `<span>Hay una versión nueva de ResearchOS. Recarga para usarla (el asistente de IA solo conoce los campos de la versión abierta).</span><button class="btn btn-primary btn-sm" id="staleReload">Recargar</button>`;
    document.body.appendChild(bar);
    bar.querySelector('#staleReload').onclick = () => location.reload();
  },
};
window.addEventListener('load', () => setTimeout(() => StaleTab.start().catch(() => {}), 2500));
