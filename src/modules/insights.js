// ============================================================
//  ResearchOS — Predicciones locales, sin IA
//
//  Todo se calcula en este navegador, con conteos, medianas y reglas sobre TU historial (nada se envía ni se entrena).
//  · Learn: al capturar una tarea, sugiere proyecto, tiempo y persona según tus tareas parecidas; avisa de duplicados
//           y continúa secuencias («Clase 4» → «Clase 5»).
//  · Load:  ¿cabe lo que viene en tu capacidad? Compara, fecha límite por fecha límite, el trabajo pendiente con las horas disponibles
//           (criterio del «plazo más cercano primero») y señala los plazos en riesgo.
//  · Load.planWeek: propone en qué día hacer cada tarea sin plan, llenando cada día hasta tu capacidad.
//  Son funciones puras: reciben datos y devuelven resultados (por eso se prueban sin abrir ninguna vista).
// ============================================================

'use strict';

const _LEARN_STOP = new Set('de la el los las un una unos unas y o a en con por para del al que se lo mi tu su es como mas muy ya sobre entre hasta desde sin'.split(' '));
const _stem = w => (w.length > 5 ? w.slice(0, 5) : w);                  // raíz tosca: «corregir», «corregí» y «correcciones» comparten «corre»
/** Raíces distintas de un título (sin artículos, números ni palabras de menos de 3 letras). */
function _stems(title) {
  return [...new Set(foldText(title).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 3 && !_LEARN_STOP.has(w) && !/^\d+$/.test(w)).map(_stem))];
}
const _median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const _plurality = (vals, minShare, minCount) => {
  const m = new Map(); for (const v of vals) m.set(v, (m.get(v) || 0) + 1);
  const best = [...m].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= minCount && best[1] / vals.length >= minShare ? best[0] : null;
};
/** Cómo escribir la referencia a un proyecto o persona en la captura: una palabra que lo identifique sola o, si no, el nombre entre comillas. */
function _shortRef(prefix, label, all, wordsOf) {
  const words = w => wordsOf(w).filter(x => x.length >= 4);
  const mine = words(label);
  const uniq = mine.find(w => all.filter(o => words(o).some(x => x.startsWith(w))).length === 1);
  return uniq ? `${prefix}${uniq}` : `${prefix}"${label}"`;
}
const _effortToken = min => (min < 60 ? `~${min}m` : `~${Math.floor(min / 60)}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}`);

const Learn = {
  MIN_SIMILAR: 3,                                                          // con menos de tres casos parecidos no se sugiere nada

  /** Índice del historial: cada tarea con las raíces de su título y el peso (IDF) de cada raíz: las palabras raras pesan más. */
  index(tasks, projects = [], people = []) {
    const rows = tasks.map(t => ({ t, stems: _stems(t.title) })).filter(r => r.stems.length);
    const df = new Map();
    for (const r of rows) for (const s of r.stems) df.set(s, (df.get(s) || 0) + 1);
    const N = rows.length || 1;
    return { rows, known: new Set(df.keys()), idf: s => Math.log(1 + N / (1 + (df.get(s) || 0))), N,
      projects: projects.filter(p => !p.archived), people };
  },

  /** Tareas del historial que se parecen a `title` (cubren al menos la mitad del peso de lo escrito). */
  similar(ix, title, limit = 12) {
    const q = _stems(title).filter(s => ix.known.has(s));                  // una palabra nueva («conclusiones») no dice nada de lo anterior: no resta
    if (!q.length) return [];
    const total = q.reduce((a, s) => a + ix.idf(s), 0);
    return ix.rows
      .map(r => { const shared = q.filter(s => r.stems.includes(s)); return { t: r.t, n: shared.length, score: shared.reduce((a, s) => a + ix.idf(s), 0) / total }; })
      .filter(x => x.n >= 1 && x.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, limit);
  },

  /**
   * Lo que probablemente falta en la captura `c` (resultado de parseCapture), según tus tareas parecidas:
   * { basis, parts: [texto legible], add: 'texto que se añade a la captura', projectId, effort, assigneeId } o null.
   */
  suggest(ix, c) {
    if (!c?.title || c.kind === 'project' || c.kind === 'meeting' || (c.kind === 'idea' && c.explicit)) return null;
    const sim = Learn.similar(ix, c.title);
    if (sim.length < Learn.MIN_SIMILAR) return null;
    const out = { basis: sim.length, parts: [], tokens: [], projectId: null, effort: null, assigneeId: null };

    if (!c.projectId) {                                                    // proyecto: el que más se repite entre las parecidas (sueltas cuentan como «ninguno»)
      const pid = _plurality(sim.map(x => x.t.projectId ?? null), 0.6, 3);
      const p = pid != null ? ix.projects.find(q => q.id === pid) : null;
      if (p) {
        out.projectId = p.id;
        out.parts.push(`en «${p.title}»`);
        out.tokens.push(_shortRef('@', p.title, ix.projects.map(q => q.title), t => foldText(t).split(/[\s:—–-]+/)));
      }
    }
    if (!c.assigneeId) {                                                   // «esperando a»: casi siempre la misma persona
      const aid = _plurality(sim.map(x => x.t.assigneeId ?? null), 0.75, 3);
      const who = aid != null ? ix.people.find(q => q.id === aid) : null;
      if (who) {
        out.assigneeId = who.id;
        out.parts.push(`esperando a ${who.name}`);
        out.tokens.push(_shortRef('>', who.name, ix.people.map(q => q.name), t => foldText(t).split(/[\s.,]+/)));
      }
    }
    if (!c.effort) {                                                       // tiempo: la mediana, si tus estimaciones parecidas son consistentes
      const e = sim.map(x => x.t.effort).filter(Boolean).sort((a, b) => a - b);
      if (e.length >= 3 && e[Math.floor(e.length * 0.75)] <= 2.5 * e[Math.floor(e.length * 0.25)]) {
        out.effort = Math.max(5, Math.round(_median(e) / 5) * 5);
        out.parts.push(`⏱ ${fmtEffort(out.effort)}`);
        out.tokens.push(_effortToken(out.effort));
      }
    }
    if (!out.tokens.length) return null;
    out.add = out.tokens.join(' ');
    return out;
  },

  /** Una tarea abierta casi idéntica a lo que se está escribiendo (para no crearla dos veces). */
  duplicate(ix, c) {
    if (!c?.title || c.kind === 'idea' && c.explicit) return null;
    const q = _stems(c.title);
    if (!q.length) return null;
    let best = null;
    for (const r of ix.rows) {
      if (r.t.done) continue;
      const union = new Set([...q, ...r.stems]).size;
      const j = q.filter(s => r.stems.includes(s)).length / union;
      if (j >= 0.8 && (q.length >= 2 || foldText(r.t.title) === foldText(c.title)) && (!best || j > best.j)) best = { t: r.t, j };
    }
    return best?.t || null;
  },

  /** «Clase» tras «Clase 3» y «Clase 4» → «Clase 5». Solo si lo escrito es exactamente el comienzo de una serie. */
  next(titles, typed) {
    const q = foldText(typed).trim();
    if (q.length < 4) return null;
    const nums = new Set(); let label = null, max = 0;
    for (const t of titles) {
      const m = String(t).match(/^(.*?)(\d{1,3})(?=\D|$)/);
      if (!m) continue;
      const pre = foldText(m[1]).replace(/[\s:.\-–—#°ºn]+$/, '').trim();
      if (pre !== q) continue;
      const n = +m[2];
      nums.add(n);
      if (n >= max) { max = n; label = m[1].replace(/[\s:.\-–—]+$/, ''); }
    }
    return nums.size >= 2 ? `${label} ${max + 1}` : null;
  },
};

// ==============================================================
//  CARGA Y PLAZOS
// ==============================================================
const _isWeekday = iso => { const w = new Date(iso + 'T12:00:00').getDay(); return w !== 0 && w !== 6; };
const _addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localDateISO(d); };

const Load = {
  /** Mediana de las estimaciones propias (para las tareas sin estimar); 30 min si hay muy pocas. */
  typical(tasks) { const e = tasks.map(t => t.effort).filter(Boolean); return e.length >= 5 ? _median(e) : 30; },

  /** Minutos de trabajo disponibles entre dos fechas (inclusive), contando solo días laborables. */
  available(from, to, capacity) {
    let n = 0;
    for (let d = from; d <= to; d = _addDays(d, 1)) if (_isWeekday(d)) n += capacity;
    return n;
  },

  /** Tareas propias abiertas, con su plazo efectivo (el más cercano entre la tarea y su proyecto) y su duración. */
  _items(tasks, projects, today) {
    const live = new Map(projects.filter(p => !p.archived).map(p => [p.id, p]));
    const typical = Load.typical(tasks);
    return tasks.filter(t => !t.done && !t.assigneeId && !(t.projectId && !live.has(t.projectId))).map(t => {
      const p = t.projectId ? live.get(t.projectId) : null;
      const deadline = [t.due, p?.deadline].filter(Boolean).sort()[0] || null;
      return { t, project: p || null, deadline: deadline && deadline < today ? today : deadline, overdue: !!deadline && deadline < today,
               minutes: t.effort || typical, estimated: !!t.effort };
    });
  },

  /**
   * ¿Cabe todo? Para cada fecha límite compara el trabajo que vence en esa fecha o antes con las horas disponibles hasta ella.
   * Devuelve { violations: [{date, demand, available, over, items}], atRisk: [{project, deadline, over}], guessed } (vacío si todo cabe).
   */
  analyze({ tasks, projects, today = localDateISO(), capacity = Capacity.get() }) {
    const items = Load._items(tasks, projects, today).filter(x => x.deadline);
    const dates = [...new Set(items.map(x => x.deadline))].sort();
    const violations = [];
    for (const date of dates) {
      const within = items.filter(x => x.deadline <= date);
      const demand = within.reduce((a, x) => a + x.minutes, 0), available = Load.available(today, date, capacity);
      if (demand > available) violations.push({ date, demand, available, over: demand - available, items: within.sort((a, b) => b.minutes - a.minutes) });
    }
    // solo se cuentan los que añaden carga nueva (si el 10 ya va justo, el 11 no repite lo mismo)
    const shown = [];
    for (const v of violations) if (!shown.length || v.over - shown[shown.length - 1].over >= 60) shown.push(v);
    const atRisk = projects.filter(p => !p.archived && p.deadline && items.some(x => x.project?.id === p.id)).map(p => {
      const d = p.deadline < today ? today : p.deadline;                    // ¿cabe todo lo que vence hasta el plazo del proyecto?
      const over = items.filter(x => x.deadline <= d).reduce((a, x) => a + x.minutes, 0) - Load.available(today, d, capacity);
      return over > 0 ? { project: p, deadline: p.deadline, over } : null;
    }).filter(Boolean).sort((a, b) => a.deadline.localeCompare(b.deadline));
    return { violations: shown.slice(0, 3), atRisk, guessed: items.filter(x => !x.estimated).length, typical: Load.typical(tasks) };
  },

  /**
   * Propuesta de plan: qué tareas hacer cada día de los próximos días laborables. Entran las atrasadas, las que vencen en las próximas dos
   * semanas (por su fecha o la de su proyecto) y las de prioridad alta sin fecha, siempre que aún no tengan día; cada una va al primer día con hueco, sin pasar de su plazo si cabe antes.
   * Devuelve { plan: [{task, project, day, minutes, estimated, late}], unplaced, days: [{day, used, capacity}] }.
   */
  planWeek({ tasks, projects, today = localDateISO(), capacity = Capacity.get(), horizon = 7 }) {
    const days = []; for (let i = 0; i < horizon; i++) { const d = _addDays(today, i); if (_isWeekday(d)) days.push(d); }
    const used = new Map(days.map(d => [d, 0]));
    const all = Load._items(tasks, projects, today);
    for (const x of all) { const d = x.t.planDate || x.t.due; if (d && used.has(d)) used.set(d, used.get(d) + x.minutes); }      // lo que ya tiene día ocupa ese día
    const near = _addDays(today, 14), last = days[days.length - 1];
    const rank = x => (x.overdue ? 0 : x.deadline ? 1 : 2);
    const prio = x => ({ Alta: 0, Media: 1, Baja: 2 }[x.t.priority] ?? 3);
    const candidates = all
      .filter(x => !x.t.planDate && !(x.t.due && x.t.due <= last && !x.overdue)             // con día propio dentro de la semana: ya cuenta como ocupado
        && (x.overdue || (x.deadline ? x.deadline <= near : x.t.priority === 'Alta')))     // atrasadas, con plazo en dos semanas o de prioridad alta sin fecha
      .sort((a, b) => rank(a) - rank(b) || (a.deadline || '9').localeCompare(b.deadline || '9') || prio(a) - prio(b) || a.t.id - b.t.id);
    const plan = [], unplaced = [];
    for (const x of candidates) {
      const fits = d => used.get(d) === 0 || used.get(d) + x.minutes <= capacity;
      let day = days.find(d => fits(d) && (!x.deadline || d <= x.deadline));
      let late = false;
      if (!day) { day = days.find(fits); late = !!day && !!x.deadline && day > x.deadline; }
      if (!day) { unplaced.push(x); continue; }
      used.set(day, used.get(day) + x.minutes);
      plan.push({ task: x.t, project: x.project, day, minutes: x.minutes, estimated: x.estimated, late });
    }
    return { plan, unplaced, days: days.map(day => ({ day, used: used.get(day), capacity })) };
  },
};
