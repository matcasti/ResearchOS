#!/usr/bin/env node
// <!-- researchos-asistente -->  (marca: ResearchOS mantiene esta copia al día en la carpeta del asistente)
// ============================================================
//  ResearchOS — herramienta para asistentes de IA (sin dependencias, Node 18+)
//
//  Lee `estado.json` y escribe lotes en `cambios/` dentro de la carpeta del asistente (Ajustes → Asistente de IA).
//  Tres usos con el mismo código:
//    · línea de comandos      node tools/researchos.js tareas --hasta semana
//    · servidor MCP (stdio)   node tools/researchos.js mcp      → Claude Desktop, Claude Code, Cursor, etc.
//    · esquemas de funciones  node tools/researchos.js schema --formato openai|anthropic|mcp
//  Como biblioteca: const R = require('./tools/researchos.js')  (todo se exporta).
//  La carpeta se indica con --dir, con RESEARCHOS_DIR o estando dentro de ella.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const CHANGES_FORMAT = 'researchos-changes/1';
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const pad = n => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// -- carpeta y estado ---------------------------------------------------------------------------------------------------------
function findDir(dir) {
  const cands = [dir, process.env.RESEARCHOS_DIR, process.cwd()].filter(Boolean).map(d => path.resolve(d));
  const hit = cands.find(d => fs.existsSync(path.join(d, 'estado.json')));
  if (!hit) throw new Error('No encuentro estado.json. Indica la carpeta del asistente con --dir o RESEARCHOS_DIR (Ajustes → Asistente de IA en ResearchOS, con la app abierta).');
  return hit;
}
function loadState(dir) {
  const d = findDir(dir), s = JSON.parse(fs.readFileSync(path.join(d, 'estado.json'), 'utf8'));
  s._dir = d; s._ageMin = Math.round((Date.now() - new Date(s.generated).getTime()) / 60000);
  return s;
}

/** Localiza un registro por uid (o prefijo de 8+) o por título/nombre; lanza un error legible si no hay uno solo. */
function find(rows, ref, key = 'title', what = 'registro') {
  const q = String(ref ?? '').trim();
  if (!q) throw new Error(`falta indicar ${what}`);
  const byUid = rows.filter(r => r.uid === q || (q.length >= 8 && String(r.uid).startsWith(q)));
  if (byUid.length === 1) return byUid[0];
  const f = fold(q), exact = rows.filter(r => fold(r[key]) === f);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`hay ${exact.length} ${what}s llamados «${q}»: usa su uid (${exact.map(r => r.uid.slice(0, 8)).join(', ')})`);
  const part = rows.filter(r => fold(r[key]).includes(f));
  if (part.length === 1) return part[0];
  throw new Error(part.length ? `«${q}» coincide con ${part.length} ${what}s (${part.slice(0, 5).map(r => `«${r[key]}» ${r.uid.slice(0, 8)}`).join('; ')}): usa el uid` : `no hay ${what} «${q}»`);
}

// -- consultas ----------------------------------------------------------------------------------------------------------------
function listTasks(s, { query, project, due, includeDone, assignee, limit = 100 } = {}) {
  let rows = s.tasks.filter(t => includeDone || !t.done);
  if (query) rows = rows.filter(t => fold(t.title + ' ' + (t.project || '')).includes(fold(query)));
  if (project) rows = rows.filter(t => fold(t.project).includes(fold(project)));
  if (assignee === true) rows = rows.filter(t => t.assignee); else if (assignee) rows = rows.filter(t => fold(t.assignee).includes(fold(assignee)));
  if (due) {
    const hoy = s.today, lim = due === 'hoy' || due === 'today' ? hoy : due === 'semana' || due === 'week' ? addDays(hoy, 7) : due;
    if (due === 'atrasadas' || due === 'overdue') rows = rows.filter(t => t.due && t.due < hoy);
    else if (due === 'sin-fecha' || due === 'nodate') rows = rows.filter(t => !t.due);
    else rows = rows.filter(t => t.due && t.due <= lim);
  }
  return rows.slice(0, limit);
}
function listOther(s, type, { query, limit = 100 } = {}) {
  const key = { projects: 'projects', ideas: 'ideas', meetings: 'meetings', people: 'people' }[type];
  if (!key) throw new Error(`tipo «${type}» desconocido (tasks, projects, ideas, meetings, people)`);
  let rows = s[key];
  if (query) rows = rows.filter(r => fold(JSON.stringify(r)).includes(fold(query)));
  return rows.slice(0, limit);
}
function overview(s) {
  const late = s.tasks.filter(t => !t.done && t.late);
  return { today: s.today, weekday: s.weekday, stateAgeMinutes: s._ageMin, summary: s.summary,
    overdue: late.slice(0, 15).map(t => ({ uid: t.uid, title: t.title, due: t.due, project: t.project })),
    dueToday: s.tasks.filter(t => !t.done && t.due === s.today).map(t => ({ uid: t.uid, title: t.title, project: t.project })),
    columns: s.columns, hint: s._ageMin > 30 ? 'El estado tiene más de 30 minutos: la app de ResearchOS probablemente está cerrada; los cambios se aplicarán cuando se abra.' : undefined };
}
function search(s, text) {
  const q = fold(text), hit = r => fold(JSON.stringify(r)).includes(q);
  return { tasks: s.tasks.filter(hit).slice(0, 25), projects: s.projects.filter(hit).slice(0, 15), ideas: s.ideas.filter(hit).slice(0, 15), meetings: s.meetings.filter(hit).slice(0, 15), people: s.people.filter(hit).slice(0, 15) };
}

// -- cambios: escribir un lote en cambios/ y esperar su resultado ------------------------------------------------------------
function makeChange(ops, { author = 'cli', note } = {}) { return { format: CHANGES_FORMAT, author, ...(note ? { note } : {}), ops }; }
function writeChange(dir, change) {
  const d = findDir(dir), folder = path.join(d, 'cambios');
  fs.mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const name = `${stamp}-${String(change.author).replace(/[^\w-]/g, '').slice(0, 20) || 'ia'}-${Math.random().toString(36).slice(2, 6)}.json`;
  const tmp = path.join(folder, name + '.tmp');                            // la app solo lee *.json: así nunca ve un archivo a medias
  fs.writeFileSync(tmp, JSON.stringify(change, null, 1));
  fs.renameSync(tmp, path.join(folder, name));
  return name;
}
function readResult(dir, name) {
  const f = path.join(findDir(dir), 'resultados', name.endsWith('.json') ? name : name + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
async function waitResult(dir, name, seconds) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const r = readResult(dir, name);
    if (r && r.status === 'done') return r;
    if (Date.now() >= end) return r;                                      // null (la app aún no lo ha visto) o 'pending' (esperando a la persona)
    await sleep(1000);
  }
}
/** Envía un lote y, si se pide, espera el resultado. Devuelve un objeto que cuenta qué pasó, listo para mostrar a una IA o a una persona. */
async function submit(dir, ops, opts = {}) {
  const name = writeChange(dir, makeChange(ops, opts));
  const result = opts.wait ? await waitResult(dir, name, opts.wait) : null;
  const status = !result ? 'enviado' : result.status === 'done' ? 'aplicado' : 'esperando revisión';
  return { file: `cambios/${name}`, status,
    message: !result ? 'Lote enviado. La app lo aplicará cuando esté abierta (por defecto la persona lo revisa antes). Consulta resultados/ con researchos_get_result.'
      : result.status === 'done' ? 'La app procesó el lote.' : 'La persona aún no ha revisado los cambios en ResearchOS.',
    ...(result ? { result } : {}) };
}

// -- definición de herramientas (una sola fuente: CLI, MCP y function-calling) ------------------------------------------------
const str = d => ({ type: 'string', description: d });
const WAIT = { wait_seconds: { type: 'number', description: 'Segundos que espera el resultado (la persona suele revisar en la app). 0 = no esperar.' } };
const TOOLS = [
  { name: 'researchos_overview', description: 'Resumen de ResearchOS: fecha de hoy, contadores, tareas atrasadas y de hoy, columnas del tablero. Empieza por aquí.',
    schema: { type: 'object', properties: {} }, run: (s) => overview(s) },
  { name: 'researchos_list', description: 'Lista tareas, proyectos, ideas, reuniones o personas con filtros sencillos. Cada elemento trae su uid.',
    schema: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['tasks', 'projects', 'ideas', 'meetings', 'people'] }, query: str('Texto a buscar'),
      project: str('(tasks) filtra por proyecto'), due: str('(tasks) overdue | today | week | nodate | AAAA-MM-DD (vence hasta esa fecha)'), assignee: str('(tasks) persona de la que se espera'),
      include_done: { type: 'boolean', description: '(tasks) incluir completadas recientes' }, limit: { type: 'number' } } },
    run: (s, a) => a.type === 'tasks' ? listTasks(s, { query: a.query, project: a.project, due: a.due, assignee: a.assignee, includeDone: a.include_done, limit: a.limit }) : listOther(s, a.type, a) },
  { name: 'researchos_search', description: 'Busca un texto en todas las entidades (tareas, proyectos, ideas, reuniones, personas).',
    schema: { type: 'object', required: ['text'], properties: { text: str('Texto a buscar') } }, run: (s, a) => search(s, a.text) },
  { name: 'researchos_add_task', description: 'Propone una tarea nueva. Los nombres de proyecto/persona se resuelven en la app.',
    schema: { type: 'object', required: ['title'], properties: { title: str('Título'), due: str('Fecha AAAA-MM-DD'), project: str('Nombre o uid del proyecto'), priority: { type: 'string', enum: ['Alta', 'Media', 'Baja'] },
      assignee: str('Persona de la que se espera la tarea'), repeat: str('daily | weekly | monthly'), minutes: { type: 'number' }, plan_date: str('Día en que se hará, AAAA-MM-DD'), ...WAIT } },
    write: (s, a) => [{ op: 'add', type: 'task', set: clean({ title: a.title, due: a.due, project: a.project, priority: a.priority, assignee: a.assignee, repeat: a.repeat, minutes: a.minutes, planDate: a.plan_date }) }] },
  { name: 'researchos_update_task', description: 'Propone modificar una tarea existente (por uid o título). Pon null en un campo para vaciarlo.',
    schema: { type: 'object', required: ['task'], properties: { task: str('uid (o sus 8 primeros caracteres) o título exacto'), title: str('Nuevo título'), due: str('AAAA-MM-DD o null'), priority: str('Alta | Media | Baja | null'),
      project: str('Proyecto o null'), assignee: str('Persona o null'), repeat: str('daily | weekly | monthly | null'), minutes: { type: 'number' }, plan_date: str('AAAA-MM-DD o null'), done: { type: 'boolean' }, ...WAIT } },
    write: (s, a) => [{ op: 'update', type: 'task', uid: find(s.tasks, a.task, 'title', 'tarea').uid, set: clean({ title: a.title, due: a.due, priority: a.priority, project: a.project, assignee: a.assignee, repeat: a.repeat, minutes: a.minutes, planDate: a.plan_date, done: a.done }) }] },
  { name: 'researchos_complete_task', description: 'Propone marcar una tarea como hecha (por uid o título).',
    schema: { type: 'object', required: ['task'], properties: { task: str('uid (o sus 8 primeros caracteres) o título exacto'), ...WAIT } },
    write: (s, a) => [{ op: 'complete', type: 'task', uid: find(s.tasks.filter(t => !t.done), a.task, 'title', 'tarea abierta').uid }] },
  { name: 'researchos_add_idea', description: 'Propone una idea nueva para la bandeja de ideas.',
    schema: { type: 'object', required: ['title'], properties: { title: str('Título'), content: str('Texto (Markdown)'), tags: { type: 'array', items: { type: 'string' } }, project: str('Proyecto'), ...WAIT } },
    write: (s, a) => [{ op: 'add', type: 'idea', set: clean({ title: a.title, content: a.content, tags: a.tags, project: a.project }) }] },
  { name: 'researchos_propose_changes', description: 'Envía un lote de operaciones con el formato completo de AGENTS.md (add/update/complete/delete sobre task, idea, project, meeting, person). Úsalo para varios cambios a la vez o para proyectos y reuniones.',
    schema: { type: 'object', required: ['ops'], properties: { ops: { type: 'array', items: { type: 'object' }, description: 'Operaciones, ver AGENTS.md' }, note: str('Explicación breve para la persona que revisa'), ...WAIT } },
    write: (s, a) => a.ops },
  { name: 'researchos_get_result', description: 'Lee el resultado de un lote enviado (nombre devuelto al proponerlo, p. ej. 2026-11-01T10-30-00-mcp-ab12.json).',
    schema: { type: 'object', required: ['file'], properties: { file: str('Nombre del archivo del lote') } }, result: (dir, a) => readResult(dir, path.basename(a.file)) || { status: 'sin resultado todavía' } },
];
function clean(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)); }

/** Ejecuta una herramienta por nombre con argumentos tipo JSON. */
async function callTool(name, args = {}, { dir, author = 'mcp' } = {}) {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error(`herramienta desconocida: ${name}`);
  if (t.result) return t.result(dir, args);
  const s = loadState(dir);
  if (t.run) return t.run(s, args);
  return submit(dir, t.write(s, args), { author, note: args.note, wait: args.wait_seconds ?? 0 });
}
function schemas(format) {
  return TOOLS.map(t => format === 'openai' ? { type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }
    : format === 'anthropic' ? { name: t.name, description: t.description, input_schema: t.schema }
    : { name: t.name, description: t.description, inputSchema: t.schema });
}

// -- servidor MCP (JSON-RPC 2.0 por stdio, un mensaje por línea) --------------------------------------------------------------
function serveMcp(opts = {}) {
  const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); }
  });
  async function handle(line) {
    let msg; try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'JSON no válido' } }); }
    const { id, method, params } = msg;
    if (id === undefined) return;                                          // notificaciones (initialized, cancelled…): sin respuesta
    try {
      if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'researchos', version: '1.0.0' },
        instructions: 'ResearchOS: pendientes, tareas, ideas y proyectos. Empieza con researchos_overview. Los cambios se proponen y la persona los revisa en la app.' } });
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') return send({ id, result: { tools: schemas('mcp') } });
      if (method === 'tools/call') {
        try {
          const out = await callTool(params.name, params.arguments || {}, { dir: opts.dir, author: 'mcp' });
          return send({ id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] } });
        } catch (e) { return send({ id, result: { isError: true, content: [{ type: 'text', text: 'Error: ' + e.message }] } }); }
      }
      send({ id, error: { code: -32601, message: `método no soportado: ${method}` } });
    } catch (e) { send({ id, error: { code: -32603, message: e.message } }); }
  }
}

// -- línea de comandos --------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const nxt = argv[i + 1]; if (nxt !== undefined && !nxt.startsWith('--')) { opt[k] = nxt; i++; } else opt[k] = true; }
    else pos.push(a);
  }
  return { pos, opt };
}
const ALIAS = { resumen: 'overview', overview: 'overview', tareas: 'tasks', tasks: 'tasks', proyectos: 'projects', projects: 'projects', ideas: 'ideas', reuniones: 'meetings', meetings: 'meetings',
  personas: 'people', people: 'people', buscar: 'search', search: 'search', 'añadir-tarea': 'add-task', 'anadir-tarea': 'add-task', 'add-task': 'add-task', completar: 'complete', complete: 'complete', done: 'complete',
  modificar: 'update', update: 'update', borrar: 'delete', delete: 'delete', 'nueva-idea': 'add-idea', 'add-idea': 'add-idea', aplicar: 'apply', apply: 'apply', resultado: 'result', result: 'result',
  schema: 'schema', mcp: 'mcp', ayuda: 'help', help: 'help' };
const HELP = `ResearchOS — herramienta para asistentes de IA
Uso: node tools/researchos.js [--dir CARPETA] <comando> [opciones]

Lectura   resumen · tareas [--hasta atrasadas|hoy|semana|sin-fecha|AAAA-MM-DD] [--proyecto X] [--buscar T] [--todas] · proyectos · ideas · reuniones · personas · buscar <texto>
Cambios   añadir-tarea "título" [--fecha F] [--proyecto P] [--prioridad Alta|Media|Baja] [--persona N] [--repite weekly] [--minutos 30]
          completar <uid|título> · modificar <uid|título> [--titulo T] [--fecha F|null] [--prioridad P] [--proyecto P] [--persona N] [--hecha true|false]
          borrar <uid|título> · nueva-idea "título" [--texto T] [--etiquetas a,b] [--proyecto P] · aplicar <lote.json>
Resultado resultado <archivo>   ·   cualquier cambio acepta --esperar [segundos] para esperar la respuesta de la app
Integración  mcp (servidor MCP por stdio) · schema --formato openai|anthropic|mcp (definiciones de funciones)
Todos los comandos aceptan --json. La carpeta también puede venir de RESEARCHOS_DIR.`;
const taskLine = t => `${t.done ? '[x]' : '[ ]'} ${t.title}${t.project ? ` — ${t.project}` : ''}${t.due ? ` · ${t.due}` : ''}${t.priority ? ` · ${t.priority}` : ''}${t.assignee ? ` · esperando a ${t.assignee}` : ''} (${t.uid.slice(0, 8)})`;

async function cli(argv) {
  const { pos, opt } = parseArgs(argv);
  const cmd = ALIAS[pos[0]] || (pos[0] ? null : 'help');
  if (!cmd) { console.error(`Comando desconocido: ${pos[0]}\n\n${HELP}`); return 1; }
  if (cmd === 'help') { console.log(HELP); return 0; }
  const dir = opt.dir, json = !!opt.json, out = (obj, human) => console.log(json || !human ? JSON.stringify(obj, null, 1) : human(obj));
  const wait = opt.esperar ? (opt.esperar === true ? 20 : +opt.esperar) : 0, author = process.env.RESEARCHOS_AUTHOR || 'cli';
  const text = pos.slice(1).join(' ');
  const set = (o) => clean(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === 'null' ? null : v])));
  try {
    if (cmd === 'schema') { console.log(JSON.stringify(schemas(opt.formato || 'mcp'), null, 1)); return 0; }
    if (cmd === 'mcp') { serveMcp({ dir }); return new Promise(() => {}); }
    if (cmd === 'result') { out(readResult(dir, text) || { status: 'sin resultado todavía' }); return 0; }
    if (cmd === 'apply') {
      const change = JSON.parse(fs.readFileSync(text, 'utf8'));
      out(await submit(dir, change.ops, { author: change.author || author, note: change.note, wait }), r => `${r.status}: ${r.file}\n${r.message}`); return 0;
    }
    const s = loadState(dir);
    if (cmd === 'overview') { const o = overview(s); out(o, o => `${o.weekday} ${o.today} · ${o.summary.openTasks} abiertas · ${o.summary.overdueTasks} atrasadas · ${o.summary.dueToday} hoy · ${o.summary.dueNext7Days} en 7 días\n${o.overdue.map(t => `  atrasada: ${t.title} (${t.due})`).join('\n')}${o.hint ? '\n' + o.hint : ''}`); return 0; }
    if (cmd === 'tasks') { const r = listTasks(s, { query: opt.buscar, project: opt.proyecto, due: opt.hasta, includeDone: !!opt.todas, assignee: opt.persona }); out(r, r => r.map(taskLine).join('\n') || '(ninguna)'); return 0; }
    if (['projects', 'ideas', 'meetings', 'people'].includes(cmd)) { const r = listOther(s, cmd, { query: opt.buscar }); out(r, r => r.map(x => `${x.title || x.name}${x.date ? ` · ${x.date}` : ''}${x.column ? ` · ${x.column}` : ''}${x.project ? ` — ${x.project}` : ''} (${x.uid.slice(0, 8)})`).join('\n') || '(ninguno)'); return 0; }
    if (cmd === 'search') { const r = search(s, text); out(r, r => Object.entries(r).map(([k, v]) => `${k}: ${v.length}`).join(' · ') + '\n' + r.tasks.map(taskLine).join('\n')); return 0; }
    let ops;
    if (cmd === 'add-task') ops = [{ op: 'add', type: 'task', set: set({ title: text, due: opt.fecha, project: opt.proyecto, priority: opt.prioridad, assignee: opt.persona, repeat: opt.repite, minutes: opt.minutos && +opt.minutos, planDate: opt.planificada }) }];
    else if (cmd === 'add-idea') ops = [{ op: 'add', type: 'idea', set: set({ title: text, content: opt.texto, tags: opt.etiquetas && String(opt.etiquetas).split(','), project: opt.proyecto }) }];
    else if (cmd === 'complete') ops = [{ op: 'complete', type: 'task', uid: find(s.tasks.filter(t => !t.done), text, 'title', 'tarea abierta').uid }];
    else if (cmd === 'delete') ops = [{ op: 'delete', type: 'task', uid: find(s.tasks, text, 'title', 'tarea').uid }];
    else if (cmd === 'update') ops = [{ op: 'update', type: 'task', uid: find(s.tasks, text, 'title', 'tarea').uid,
      set: set({ title: opt.titulo, due: opt.fecha, priority: opt.prioridad, project: opt.proyecto, assignee: opt.persona, repeat: opt.repite, minutes: opt.minutos && +opt.minutos, planDate: opt.planificada, done: opt.hecha === undefined ? undefined : opt.hecha !== 'false' }) }];
    out(await submit(dir, ops, { author, wait }), r => `${r.status}: ${r.file}\n${r.message}`);
    return 0;
  } catch (e) { console.error('Error: ' + e.message); return 1; }
}

module.exports = { findDir, loadState, find, listTasks, listOther, overview, search, makeChange, writeChange, readResult, waitResult, submit, TOOLS, callTool, schemas, serveMcp, CHANGES_FORMAT };
if (require.main === module) cli(process.argv.slice(2)).then(code => { if (typeof code === 'number') process.exitCode = code; });
