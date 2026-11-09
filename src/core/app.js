// ============================================================
//  ResearchOS — Application Core
//  Architecture: Single-Page, local-first, IndexedDB-backed.
//  No framework. Vanilla JS with event delegation.
// ============================================================

'use strict';

// -- App state ------------------------------------------------
const App = {
  view:             'dashboard',
  draggedId:        null,
  filterLang:       'all',
  lastDirHandle:    null,
  navHistory:       [],
  navIndex:         -1,
  filters:          { type: 'all', priority: 'all', column: 'all' },
  filterCollection: 'all',
  bulkSelected:     new Set(),
  bulkMode:         false,
  projectHubId:     null,
  triageIdx:        0,
  triageQueue:      [],
  _latexOpen:       false,
  _refFilterProject:  'all',
  groupBy:            'none',   // 'none'|'type'|'priority'|'column'|'responsible'|'area'
  filterResponsible:  'all',
  _projPage:          1,
  _lastFilterKey:     '',
  _searchIdx:         new Map(),
  projViewMode:       'grid',   // 'grid' | 'list'
  agendaViewMode:    'week',   // 'week' | 'month'
  agendaMonthOffset: 0,        // meses desde el actual (0 = este mes)
  filterArea:        'all',    // filtro de área en vista Proyectos
  _tutorialTab:    'quickstart',
  activeColPreset:   'all',   // id del preset activo en Kanban
  inspectedType:     null,    // 'project'|'idea'|'snippet'|'meeting'|'reference'|'collaborator'
  inspectedId:       null,    // id del ítem actualmente en el inspector
  inspectorHistory:  [],      // [{type, id, label}] – historial de navegación del inspector
  kanbanGroupBy:     'none',  // 'none' | 'type' | 'area'
  kanbanDensity:     'detailed', // 'detailed' | 'compact'
  projSortKey:        '',      // '' | 'title' | 'type' | 'priority' | 'column' | 'responsible' | 'area' | 'deadline'
  projSortDir:        'asc',   // 'asc' | 'desc'
  _projScrollRestore: undefined,
  _mdEditing:         false,
  _isNavigating:      false,   // true solo durante navigate() → activa view-enter
  _projDataOnly:      false,
  collaboratorHubId:  null,
  _inspectedProjectId: null,  // proyecto activo en el inspector (para palette contextual)
  _savedInspector:    null,   // {type, id} — estado del inspector a restaurar tras navegación
  submissionsViewMode: 'pipeline',   // 'list' | 'pipeline'
  ideaBulkMode:        false,
  ideaBulkSelected:    new Set(),
  orphanBulkSelected:  new Map(),
  _triageKeyHandler:   null,
  _hubMenuClickHandler: null,
};

// -- DOM refs -------------------------------------------------
const $ = id => document.getElementById(id);
const mainContent    = $('mainContent');
const inspectorBody  = $('inspectorBody');
const modalOverlay   = $('modalOverlay');
const modalTitle     = $('modalTitle');
const modalContent   = $('modalContent');

// -- Auto-save Indicator --------------------------------------
const SaveIndicator = {
  _timer: null,
  show() {
    const el = $('saveIndicator'); const tx = $('saveIndicatorText');
    if (!el) return;
    el.className = 'save-indicator saving';
    if (tx) tx.textContent = 'Guardando…';
  },
  done() {
    const el = $('saveIndicator'); const tx = $('saveIndicatorText');
    if (!el) return;
    el.className = 'save-indicator saved';
    if (tx) tx.textContent = '✓ Guardado';
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      el.className = 'save-indicator';
      if (tx) tx.textContent = 'Solo local';
    }, 2200);
  },
  error() {
    const el = $('saveIndicator'); const tx = $('saveIndicatorText');
    if (!el) return;
    el.className = 'save-indicator';
    if (tx) tx.textContent = '⚠ Error';
  }
};

// -- Undo Stack ------------------------------------------------
const UndoStack = {
  _stack: [],
  MAX: 8,

  push({ label, undo }) {
    this._stack.push({ label, undo });
    if (this._stack.length > this.MAX) this._stack.shift();
  },
  peek()  { return this._stack[this._stack.length - 1] || null; },
  async pop() {
    const entry = this._stack.pop();
    if (!entry) return null;
    await entry.undo();
    return entry.label;
  },
  clear() { this._stack = []; }
};

/**
 * Toast con botón "↩ Deshacer" que dispara la última acción del UndoStack.
 * Si no hay nada en el stack, cae back a showToast normal.
 */
function showToastWithUndo(message, type = 'info') {
  if (!UndoStack.peek()) { showToast(message, type); return; }
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.style.cssText = 'display:flex;align-items:center;gap:6px;';
  toast.innerHTML = `
    <span>${icons[type] || '•'}</span>
    <span style="flex:1">${esc(message)}</span>
    <button class="toast-undo-btn">↩ Deshacer</button>`;
  const stop = _mountToast(toast, 6500);

  toast.querySelector('.toast-undo-btn').addEventListener('click', async () => {
    stop();
    toast.remove();
    try {
      const label = await UndoStack.pop();
      if (label) {
        showToast(`↩ Deshecho: ${label}`, 'success');
        renderView(App.view);
        updateBadges();
      }
    } catch (e) {
      showToast('No se pudo deshacer', 'error');
      console.error(e);
    }
  });
}

// -- Deadline Reminder Module -----------------------
const DeadlineReminder = {
  _interval: null,

  async requestPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const p = await Notification.requestPermission();
    return p === 'granted';
  },

  async checkDeadlines() {
    if (Notification.permission !== 'granted') return;
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const projects = await db.projects.filter(p =>
      !p.archived && !!p.deadline
    ).toArray();

    for (const p of projects) {
      const d = new Date(p.deadline + 'T00:00:00');
      const daysLeft = Math.round((d - today) / 86400000);
      // Notificar si vence hoy o mañana (y no se notificó ya hoy)
      const notifKey = `notif_${p.id}_${localDateISO(today)}`;
      if (daysLeft <= 1 && daysLeft >= 0 && !sessionStorage.getItem(notifKey)) {
        const label = daysLeft === 0 ? 'VENCE HOY' : 'vence mañana';
        new Notification(`⏱ ResearchOS — ${label}`, {
          body: `"${p.title}" ${daysLeft === 0 ? 'tiene fecha límite hoy.' : 'tiene deadline mañana.'}`,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="28" font-size="28">⬡</text></svg>',
          tag: notifKey,
        });
        sessionStorage.setItem(notifKey, '1');
      }
      // Alerta de overdue (sólo una vez al día)
      if (daysLeft < 0) {
        const overdueKey = `overdue_${p.id}_${localDateISO(today)}`;
        if (!sessionStorage.getItem(overdueKey)) {
          new Notification(`🔴 ResearchOS — Proyecto vencido`, {
            body: `"${p.title}" venció hace ${Math.abs(daysLeft)} día(s).`,
            tag: overdueKey,
          });
          sessionStorage.setItem(overdueKey, '1');
        }
      }
    }
  },

  start() {
    // Comprobar al iniciar y cada 30 min
    this.checkDeadlines();
    this._interval = setInterval(() => this.checkDeadlines(), 30 * 60 * 1000);
  },

  stop() { clearInterval(this._interval); }
};

let _searchIdxTimer = null;
function _scheduleSearchIndex() {
  App._searchIdxDirty = true;           // la paleta reconstruye el índice al instante si lo encuentra sucio
  clearTimeout(_searchIdxTimer);
  _searchIdxTimer = setTimeout(() => _buildSearchIndex().catch(() => {}), 1500);
}

/** Wraps any IndexedDB write: shows saving → saved indicator. */
async function dbWrite(fn) {
  SaveIndicator.show();
  try {
    const r = await fn();
    SaveIndicator.done();
    localStorage.setItem('ros-last-active', String(Date.now()));
    GoogleSync.scheduleAutoSave().catch(() => {});
    _scheduleSearchIndex();
    if (typeof AutoBackup !== 'undefined') AutoBackup.schedule();     // integrations.js
    if (typeof SyncFolder !== 'undefined') SyncFolder.schedule();     // sync.js
    return r;
  } catch(e) {
    SaveIndicator.error();
    if (e?.name === 'QuotaExceededError')
      showToast('Se llenó el almacenamiento del navegador y no se pudo guardar. Exporta una copia (Ajustes) y libera espacio.', 'error');
    throw e;
  }
}

/**
 * Copia al portapapeles. Si el navegador lo niega (permisos, página sin https, Safari sin gesto) prueba el método antiguo y,
 * si tampoco, avisa en vez de dejar un error en la consola. Devuelve true/false.
 */
async function copyText(text, okMsg = 'Copiado ✓') {
  try { await navigator.clipboard.writeText(text); showToast(okMsg, 'success'); return true; }
  catch {
    try {
      const ta = Object.assign(document.createElement('textarea'), { value: String(text), readOnly: true });
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove();
      if (ok) { showToast(okMsg, 'success'); return true; }
    } catch { /* sin alternativa */ }
    showToast(`No se pudo copiar solo. Selecciona el texto y usa ${MOD_KEY} C`, 'error');
    return false;
  }
}

// ==============================================================
//  REGISTRO DE ERRORES INESPERADOS
//  Lo que antes se perdía en la consola (una promesa rechazada, un fallo al pintar) queda guardado —solo en este navegador— y se
//  muestra en Ajustes → Diagnóstico, con un aviso discreto como máximo cada 30 s. Sin envíos a ningún servidor.
// ==============================================================
const ErrorLog = {
  KEY: 'ros-errors', _last: 0,
  all() { try { return JSON.parse(localStorage.getItem(ErrorLog.KEY)) || []; } catch { return []; } },
  add(kind, err, { quiet = false } = {}) {
    const msg = String(err?.message ?? err ?? '').slice(0, 300);
    if (/ResizeObserver|^Script error|Non-Error promise rejection/i.test(msg)) return;      // ruido del navegador, no de la app
    const entry = { t: new Date().toISOString(), kind, view: typeof App !== 'undefined' ? (App.view || '') : '', msg, stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 500) };
    try { localStorage.setItem(ErrorLog.KEY, JSON.stringify([...ErrorLog.all(), entry].slice(-20))); } catch {}
    const now = Date.now();
    if (!quiet && now - ErrorLog._last > 30000 && typeof showToast === 'function') {
      ErrorLog._last = now;
      showToast('Algo no salió como esperaba. Tus datos están a salvo; el detalle quedó en Ajustes → Diagnóstico.', 'error');
    }
  },
  clear() { try { localStorage.removeItem(ErrorLog.KEY); } catch {} },
};
window.addEventListener('error', e => { if (e.target && e.target !== window) return; ErrorLog.add('error', e.error || e.message); });   // los fallos de carga de recursos no entran
window.addEventListener('unhandledrejection', e => ErrorLog.add('promesa', e.reason));

// ==============================================================
//  REFRESCO INMEDIATO
//  Cualquier cambio en los datos (venga del inspector, de un modal, de una tarjeta o de un atajo) se refleja en la vista
//  abierta y en el inspector sin que cada manejador tenga que acordarse de repintar. Si el manejador ya repintó, no se
//  repite; si la persona está escribiendo, se espera a que suelte el campo para no pisarle el texto.
// ==============================================================
const Live = {
  ready: false,                 // true cuando termina el arranque (antes pinta init)
  dirtyAt: 0, timer: 0, waiting: false, pressedAt: 0,
  DELAY: 70,
  SKIP_VIEWS: new Set(['network', 'tutorial', 'settings', 'filesystem']),   // vistas con estado propio que un repintado reiniciaría

  touch() {
    if (!Live.ready) return;
    Live.dirtyAt = performance.now();
    clearTimeout(Live.timer);
    Live.timer = setTimeout(Live.flush, Live.DELAY);
  },

  /** ¿Hay un botón del ratón o un dedo pulsado? Repintar entre «pulsar» y «soltar» cambia el elemento bajo el puntero y el clic se pierde. */
  pressing() { return Live.pressedAt > 0 && performance.now() - Live.pressedAt < 3000; },    // el límite evita que un «soltar» perdido (fuera de la ventana) la deje esperando

  /** ¿Hay algo a medias que un repintado destruiría? */
  editing() {
    const a = document.activeElement;
    if (a && a !== document.body && (mainContent.contains(a) || inspectorBody.contains(a)) &&
        a.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=file]):not([type=range]):not([type=color]), textarea, [contenteditable="true"]')) return true;
    return !!document.querySelector('.kanban-card.dragging, .sub-pipe-card.dragging, .inplace-input');
  },

  async flush() {
    if (!Live.ready || !App.view || Live.SKIP_VIEWS.has(App.view)) { Live.waiting = false; return; }
    if (App._renderStartedAt >= Live.dirtyAt) { Live.waiting = false; return; }      // el manejador ya repintó con el dato nuevo
    if (document.hidden) { Live.waiting = true; return; }                             // se retoma al volver a la pestaña
    if (Live.pressing()) { Live.waiting = true; clearTimeout(Live.timer); Live.timer = setTimeout(Live.flush, 60); return; }   // se repinta al soltar, no entre pulsar y soltar
    if (Live.editing()) {                                                              // se retoma al soltar el campo (Firefox y Safari no avisan si el campo se quita con el foco puesto: se vuelve a mirar)
      Live.waiting = true; clearTimeout(Live.timer); Live.timer = setTimeout(Live.flush, 400); return;
    }
    Live.waiting = false;
    // Freno: si un repintado escribiera en la base de datos (y eso provocara otro repintado), no se encadena sin fin.
    const now = performance.now();
    Live.runs = (Live.runs || []).filter(t => now - t < 4000);
    if (Live.runs.length >= 8) { console.warn('Refresco automático en pausa: demasiados repintados seguidos'); return; }
    Live.runs.push(now);
    if (Live.settingsDirty) { Live.settingsDirty = false; renderContextSwitcher().catch(() => {}); }     // el selector de área del menú lateral
    try { await renderView(App.view); } catch (e) { console.error('Refresco', e); }
  },

  resume() { if (Live.waiting) { clearTimeout(Live.timer); Live.timer = setTimeout(Live.flush, 120); } },
};
// Las áreas, los presets de columnas, las etapas y los campos por tipo viven en `settings` y también cambian lo que se ve.
const _LIVE_SETTINGS = /^ros-(areas|col-presets|sub-stages|sub-col-map|type-schemas|auto-sync-paper-col)$/;
/** Se llama desde init() una vez comprobado que Dexie cargó (sin Dexie, db.js no define ni `db` ni `SyncState`). */
function _wireDbEvents() {
  // Otra pestaña abrió una versión más nueva de la base de datos: esta se cierra para no bloquear la actualización y se avisa.
  db.on('versionchange', () => {
    const bar = document.createElement('div');
    bar.className = 'reload-bar'; bar.setAttribute('role', 'alert');
    bar.innerHTML = '<span>ResearchOS se actualizó en otra pestaña. Recarga esta para seguir trabajando sin perder nada.</span><button class="btn btn-primary btn-sm" id="reloadNow">Recargar</button>';
    document.body.appendChild(bar);
    $('reloadNow').addEventListener('click', () => location.reload());
  });
  db.on('blocked', () => showToast('Cierra las otras pestañas de ResearchOS para terminar de actualizar', 'info'));
}

function _wireLive() {
  // Con la app abierta en dos pestañas (o la instalada y una pestaña) comparten la misma base de datos: cada cambio local
  // avisa a las demás, que se ponen al día solas. Lo que llega de fuera no se reenvía (no hay eco) ni toca copias/sincronización.
  let bc = null, posted = 0;
  try { bc = 'BroadcastChannel' in window ? new BroadcastChannel('researchos-live') : null; } catch { /* sin soporte: solo esta pestaña */ }
  if (bc) bc.onmessage = () => { _scheduleSearchIndex(); Live.touch(); };
  SyncState.listeners.push(() => {                       // cualquier cambio local en la base de datos, pase o no por dbWrite
    Live.touch();
    if (bc && !posted) posted = setTimeout(() => { posted = 0; try { bc.postMessage(1); } catch {} }, 120);   // un aviso por ráfaga de escrituras
  });
  const touchSetting = key => { if (_LIVE_SETTINGS.test(key)) { Live.settingsDirty = true; Live.touch(); } };
  db.settings.hook('creating', key => { touchSetting(key); });
  db.settings.hook('updating', (mods, key) => { touchSetting(key); });
  db.settings.hook('deleting', key => { touchSetting(key); });
}
document.addEventListener('focusout', () => Live.resume());
document.addEventListener('pointerdown', () => { Live.pressedAt = performance.now(); }, true);
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => setTimeout(() => { Live.pressedAt = 0; Live.resume(); }, 0), true);   // tras el «click», que se dispara justo después de soltar
document.addEventListener('visibilitychange', () => { if (!document.hidden) Live.resume(); });

// -- Breadcrumbs ----------------------------------------------

function breadcrumbHTML(items) {
  if (!items || !items.length) return '';
  return `<div class="breadcrumb-bar" id="bcBar">
    ${items.map((it, i) => {
      const last = i === items.length - 1;
      const sep  = i > 0 ? '<span class="bc-sep">›</span>' : '';
      return last
        ? `${sep}<span class="bc-item current">${esc(it.label)}</span>`
        : `${sep}<span class="bc-item link" data-bc-nav="${it.view}">${esc(it.label)}</span>`;
    }).join('')}
  </div>`;
}

// -- Sanitizador HTML (lista blanca) ---------------------------
// El HTML que produce marked incluye cualquier HTML en crudo del texto, así que se filtra con una lista
// blanca de etiquetas/atributos y de esquemas de URL. Se parsea con DOMParser (documento inerte: no ejecuta nada).
const _SAFE_TAGS = new Set(['A','B','BLOCKQUOTE','BR','CODE','DEL','DETAILS','DIV','EM','H1','H2','H3','H4','H5','H6',
  'HR','I','IMG','INPUT','KBD','LI','MARK','OL','P','PRE','S','SPAN','STRONG','SUB','SUMMARY','SUP','TABLE','TBODY',
  'TD','TFOOT','TH','THEAD','TR','U','UL']);
const _DROP_TAGS = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','LINK','META','BASE','FORM','TEMPLATE','NOSCRIPT',
  'SVG','MATH','TEXTAREA','SELECT','BUTTON','AUDIO','VIDEO','SOURCE','FRAME','FRAMESET','APPLET','TITLE','HEAD']);
const _SAFE_ATTRS = {
  A: ['href', 'title'], IMG: ['src', 'alt', 'title', 'width', 'height'], INPUT: ['type', 'checked', 'disabled'],
  TD: ['align', 'colspan', 'rowspan'], TH: ['align', 'colspan', 'rowspan'], OL: ['start'],
  CODE: ['class'], PRE: ['class'], '*': ['title'],
};

function _safeUrl(value, { image = false } = {}) {
  const v = String(value).replace(/[\u0000- \u007f-\u009f]/g, '');          // "java\tscript:" → "javascript:"
  const m = v.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!m) return true;                                                           // relativa o #ancla
  const scheme = m[1].toLowerCase();
  if (['http', 'https'].includes(scheme)) return true;
  if (!image && ['mailto', 'tel'].includes(scheme)) return true;
  return image && scheme === 'data' && /^data:image\/(png|gif|jpe?g|webp);/i.test(v);
}

function sanitizeHTML(html, { wikilinks = false } = {}) {
  if (typeof DOMParser === 'undefined') return esc(html);
  const doc = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
  const clean = node => {
    for (const el of [...node.childNodes]) {
      if (el.nodeType === 3) continue;                                           // texto
      if (el.nodeType !== 1) { el.remove(); continue; }                          // comentarios, CDATA…
      if (_DROP_TAGS.has(el.tagName)) { el.remove(); continue; }
      clean(el);
      if (!_SAFE_TAGS.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }   // etiqueta desconocida: conserva el texto
      const allowed = [...(_SAFE_ATTRS[el.tagName] || []), ..._SAFE_ATTRS['*']];
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase();
        const ok = allowed.includes(n)
          && !(n === 'href' && !_safeUrl(attr.value))
          && !(n === 'src'  && !_safeUrl(attr.value, { image: true }))
          && !(n === 'class' && !/^language-[\w+#-]+$/.test(attr.value));
        if (!ok) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A' && el.hasAttribute('href')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      if (el.tagName === 'INPUT') {
        if (el.getAttribute('type') !== 'checkbox') { el.remove(); continue; }
        el.setAttribute('disabled', '');
      }
    }
  };
  clean(doc.body);
  if (wikilinks && typeof _linkifyWikilinks === 'function') _linkifyWikilinks(doc.body);   // today.js
  return doc.body.innerHTML;
}

// -- Render Markdown seguro -------------------------
function renderMd(text) {
  if (!text || typeof marked === 'undefined') return esc(text || '');
  marked.setOptions({ breaks: true, gfm: true });
  return sanitizeHTML(marked.parse(String(text)), { wikilinks: true });
}

// -- Render LaTeX con KaTeX -------------------------
/** Resalta un bloque de código si highlight.js cargó (si no, se muestra como texto plano). */
function _highlightBlock(el) {
  if (typeof hljs !== 'undefined') return hljs.highlightElement(el);
  loadLib('hljs').then(() => el.isConnected && hljs.highlightElement(el)).catch(() => {});      // se descarga la primera vez que hay código
}

// -- Librerías pesadas y opcionales: se descargan solo cuando se necesitan ------------------------------
// (highlight.js ~120 KB, KaTeX ~300 KB + fuentes, Google Identity: un arranque sin código, fórmulas ni Drive no los pide).
const LAZY_LIBS = {
  hljs: [
    { css: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark-dimmed.min.css', integrity: 'sha384-PiLidnnRuzFgp4qiN8oGNmktrV8ETL+6a8heAxljUX4A+3XWlocwaMn9duBUepfK' },
    { js: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js', integrity: 'sha384-F/bZzf7p3Joyp5psL90p/p89AZJsndkSoGwRpXcZhleCWhd8SnRuoYo4d0yirjJp' },
  ],
  katex: [
    { css: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css', integrity: 'sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV' },
    { js: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js', integrity: 'sha384-XjKyOOlGwcjNTAIQHIpgOno0Hl1YQqzUOEleOLALmuqehneUG+vnGctmUb0ZY0l8' },
    { js: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js', integrity: 'sha384-+VBxd3r6XgURycqtZ117nYw44OOcIax56Z4dCRWbxyPt0Koah1uHoK0o4+/RRE05' },
  ],
  gsi: [{ js: 'https://accounts.google.com/gsi/client' }],          // sin SRI: Google no publica una versión fija
};
const _libLoads = {};
/** Descarga una librería (una sola vez). Los scripts se cargan en orden; las hojas de estilo no bloquean. */
function loadLib(name) {
  if (_libLoads[name]) return _libLoads[name];
  const p = (async () => {
    for (const part of LAZY_LIBS[name]) {
      const el = document.createElement(part.css ? 'link' : 'script');
      if (part.css) { el.rel = 'stylesheet'; el.href = part.css; } else { el.src = part.js; el.async = false; }
      if (part.integrity) { el.integrity = part.integrity; el.crossOrigin = 'anonymous'; }
      if (part.css) { document.head.appendChild(el); continue; }
      await new Promise((ok, fail) => { el.onload = ok; el.onerror = () => fail(new Error(`No se pudo cargar ${name}`)); document.head.appendChild(el); });
    }
  })();
  p.catch(() => { delete _libLoads[name]; });                    // un fallo (sin red) no impide reintentar luego
  return _libLoads[name] = p;
}

function renderLatex(container) {
  if (!container || !/\$|\\\(|\\\[/.test(container.textContent || '')) return;      // sin fórmulas: ni se carga KaTeX ni se recorre el DOM
  if (typeof renderMathInElement === 'undefined') {
    loadLib('katex').then(() => container.isConnected && renderLatex(container)).catch(() => {});
    return;
  }
  renderMathInElement(container, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$',  right: '$',  display: false },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
    ],
    throwOnError: false,
  });
}

/** Enfoca un campo recién creado de inmediato (sin carreras con quien escribe rápido); si aún no es visible, reintenta en el siguiente fotograma. */
function focusField(el, { select = false } = {}) {
  if (!el) return;
  const go = () => { el.focus({ preventScroll: true }); if (select) el.select?.(); return document.activeElement === el; };
  if (!go()) requestAnimationFrame(go);
}

/**
 * Red de seguridad de accesibilidad: todo campo sin etiqueta recibe un nombre (placeholder, la etiqueta de su grupo o el texto de su fila),
 * para que los lectores de pantalla no anuncien «cuadro de edición» a secas. Se aplica a vistas, modales e inspector.
 */
function autoLabelControls(root) {
  if (!root) return;
  for (const el of root.querySelectorAll('input:not([type=hidden]), select, textarea')) {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title || el.closest('label') ||
        (el.id && root.querySelector(`label[for="${CSS.escape(el.id)}"]`))) continue;
    const box = el.closest('.form-group, .settings-row');
    let text = el.placeholder || box?.querySelector('.form-label, .settings-row-label')?.textContent || '';
    if (!text.trim() && /^(checkbox|radio)$/.test(el.type)) text = 'Seleccionar: ' + (el.parentElement?.textContent || '');
    if (!text.trim()) text = el.previousElementSibling?.textContent || '';
    text = text.replace(/\s+/g, ' ').trim().replace(/[*:]+$/, '').slice(0, 80);
    if (text) el.setAttribute('aria-label', text);
  }
  // Botones que son solo un símbolo (✕, ⋯, ⊞…): el tooltip pasa a ser su nombre accesible y, si solo tenían nombre, también tooltip
  for (const el of root.querySelectorAll('button')) {
    if (/[A-Za-zÁ-ú]{2,}/.test(el.textContent) || el.querySelector('svg')) continue;
    const label = el.getAttribute('aria-label'), tip = el.title;
    if (!label && tip) el.setAttribute('aria-label', tip);
    else if (label && !tip) el.title = label;
  }
  enableKeyboardClicks(root);
}

/** Filas y tarjetas que se abren con un clic: también con Tab + Enter/Espacio (el manejador global está en init()). */
const KB_CLICKABLE = '.tw-row, .bc-item.link, .tut-mod-card, .card.clickable, .nested-node-row, .idea-item, .sub-pipeline-stage, .snippet-card, .ref-card, .meeting-card, .collab-card, .kanban-card, .alert-msg';
function enableKeyboardClicks(root) {
  for (const el of root.querySelectorAll(KB_CLICKABLE)) {
    if (el.hasAttribute('data-kb')) continue;
    el.setAttribute('data-kb', '');
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    // Con controles dentro (casilla, menú…) no se declara «botón»: sería un control dentro de otro control
    if (!el.hasAttribute('role') && !el.querySelector('a, button, input, select, textarea, summary'))
      el.setAttribute('role', el.classList.contains('bc-item') ? 'link' : 'button');
  }
}

const MOD_KEY = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl';

/** Ventana con los atajos de teclado (tecla «?»). */
function openShortcutsHelp() {
  const row = (keys, text) => `<div class="kb-row"><span class="kb-keys">${keys.map(k => `<kbd>${esc(k)}</kbd>`).join('<span class="kb-plus">+</span>')}</span><span class="kb-text">${esc(text)}</span></div>`;
  const sec = (title, rows) => `<div class="kb-sec"><div class="kb-title">${esc(title)}</div>${rows.join('')}</div>`;
  showModal('Atajos de teclado', `
    <div class="modal-body kb-help">
      ${sec('En cualquier lugar', [
        row([MOD_KEY, 'K'], 'Buscar y ejecutar acciones (paleta de comandos)'),
        row([MOD_KEY, 'Shift', 'K'], 'Ir al tablero de proyectos'),
        row(['Alt', '←'], 'Vista anterior'), row(['Alt', '→'], 'Vista siguiente'),
        row(['Esc'], 'Cerrar lo que esté abierto: paleta, ventana o inspector'),
        row(['?'], 'Mostrar esta ayuda')])}
      ${sec('Sin estar escribiendo en un campo', [
        row(['C'], 'Capturar una tarea o idea'), row(['N'], 'Crear un elemento nuevo en la vista actual'),
        row(['E'], 'Editar el elemento abierto en el inspector'), row(['S'], 'Marcar o quitar favorito'),
        row(['/'], 'Filtrar la lista que estás viendo'), row([MOD_KEY, 'Z'], 'Deshacer lo último (borrar, archivar, mover…)'),
        row(['F5'], 'Modo presentación del tablero')])}
      ${sec('Inspector', [
        row(['Clic'], 'Editar un campo (con teclado: Tab hasta el campo y Enter)'),
        row(['Enter'], 'Guardar la edición'), row(['Esc'], 'Cancelar la edición')])}
      ${sec('Listas y tarjetas', [
        row(['Tab'], 'Moverte entre filas y tarjetas'), row(['Enter'], 'Abrir la fila o tarjeta enfocada')])}
      ${sec('Revisión rápida de ideas', [
        row(['→'], 'Marcar como revisada y pasar a la siguiente'), row(['A'], 'Eliminar la idea'),
        row(['P'], 'Asignar a un proyecto'), row(['E'], 'Editar'), row(['Esc'], 'Salir')])}
    </div>
    <div class="modal-footer"><button class="btn btn-primary" id="kbClose">Entendido</button></div>`);
  $('kbClose').addEventListener('click', closeModal);
  focusField($('kbClose'));
}


/** Deshace la última acción registrada (la misma que ofrece el aviso «Deshacer»). */
async function undoLast() {
  if (!UndoStack.peek()) { showToast('No hay nada que deshacer', 'info'); return; }
  try {
    const label = await UndoStack.pop();
    if (label) { showToast(`↩ Deshecho: ${label}`, 'success'); updateBadges(); }
  } catch (err) { showToast('No se pudo deshacer', 'error'); console.error(err); }
}

// ==============================================================
//  FILTRO DENTRO DE LAS LISTAS (Ideas, Snippets, Referencias, Reuniones, Colaboradores)
//  Se superpone a lo ya pintado, así que no depende de cada vista; el texto escrito sobrevive a los repintados.
// ==============================================================
const LIST_FILTERS = {
  ideas:         { item: '.idea-item',    noun: 'ideas' },
  snippets:      { item: '.snippet-card', noun: 'snippets' },
  references:    { item: '.ref-card',     noun: 'referencias' },
  meetings:      { item: '.meeting-card', noun: 'reuniones' },
  collaborators: { item: '.collab-card',  noun: 'colaboradores' },
};
App._listFilter = App._listFilter || {};

function _applyListFilter(view, items) {
  const q = foldText(App._listFilter[view] || '').trim();
  const words = q.split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const el of items) {
    const ok = !words.length || words.every(w => foldText(el.textContent).includes(w));
    el.classList.toggle('lf-hide', !ok);
    if (ok) shown++;
  }
  const count = $('listFilterCount');
  if (count) count.textContent = words.length ? `${shown} de ${items.length}` : '';
  mainContent.querySelector('.list-filter-empty')?.remove();
  if (words.length && !shown) {
    const none = document.createElement('div');
    none.className = 'list-filter-empty';
    none.textContent = `Ninguna coincide con «${App._listFilter[view].trim()}».`;
    $('listFilterInput').closest('.list-filter').after(none);
  }
}

/** Añade (o repone tras repintar) el filtro de la vista, si es una de las listas y tiene suficientes elementos. */
function setupListFilter(view) {
  const cfg = LIST_FILTERS[view];
  if (!cfg) return;
  const items = [...mainContent.querySelectorAll(cfg.item)];
  if (items.length < 4) return;
  const header = mainContent.querySelector('.view-header');
  if (!header || $('listFilterInput')) return;
  const anchor = view === 'ideas' ? items[0].parentElement : null;       // Ideas: el formulario de captura ocupa la parte alta; el filtro va sobre la lista
  const bar = document.createElement('div');
  bar.className = 'list-filter'; bar.setAttribute('role', 'search');
  bar.innerHTML = `<span class="list-filter-ico" aria-hidden="true">${uiIcon('search', 15)}</span>
    <input type="search" id="listFilterInput" class="list-filter-input" autocomplete="off" aria-label="Filtrar ${cfg.noun}" placeholder="Filtrar ${cfg.noun}…   ( / )">
    <span class="list-filter-count" id="listFilterCount" aria-live="polite"></span>`;
  if (anchor) anchor.before(bar); else header.after(bar);
  const input = $('listFilterInput');
  input.value = App._listFilter[view] || '';
  input.addEventListener('input', () => { App._listFilter[view] = input.value; _applyListFilter(view, [...mainContent.querySelectorAll(cfg.item)]); });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (input.value) { input.value = ''; App._listFilter[view] = ''; _applyListFilter(view, [...mainContent.querySelectorAll(cfg.item)]); } else input.blur();
  });
  if (input.value) _applyListFilter(view, items);
}

function attachBreadcrumbHandlers() {
  mainContent.querySelectorAll('[data-bc-nav]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.bcNav));
  });
}

// ==============================================================
//  PROYECTOS: una sola pantalla con pestañas (Tablero · Lista · Línea de tiempo · Jerarquía)
// ==============================================================
const PROJECT_TABS = [
  { view: 'kanban',      label: 'Tablero' },
  { view: 'projects',    label: 'Lista' },
  { view: 'timeline',    label: 'Línea de tiempo' },
  { view: 'nested',      label: 'Jerarquía' },
  { view: 'submissions', label: 'Submissions', badge: 'subActive' },        // los papers también son proyectos: se ven como un flujo de envíos
];
// Revisar: la revisión semanal y el informe de avance comparten una sola entrada del menú
const REVIEW_TABS = [
  { view: 'review', label: 'Revisión semanal' },
  { view: 'report', label: 'Informe de avance' },
];
const TAB_GROUPS = [
  { tabs: PROJECT_TABS, aria: 'Vistas de proyectos' },
  { tabs: REVIEW_TABS,  aria: 'Revisión e informe' },
];

/** Inserta (o repone) la barra de pestañas al principio del contenido cuando la vista activa pertenece a un grupo de pestañas. */
function ensureProjectTabs() {
  const group = TAB_GROUPS.find(g => g.tabs.some(t => t.view === App.view));
  const existing = mainContent.querySelector(':scope > .proj-tabs');
  if (!group) { existing?.remove(); return; }
  if (existing?.dataset.active === App.view) return;
  existing?.remove();
  const hidden = typeof NavProfile !== 'undefined' ? new Set(NavProfile.hidden()) : new Set();      // el perfil de uso oculta también las pestañas que no usas (salvo la abierta)
  const tabs = group.tabs.filter(t => t.view === App.view || !hidden.has(t.view));
  const bar = document.createElement('nav');
  bar.className = 'proj-tabs';
  bar.dataset.active = App.view;
  bar.setAttribute('aria-label', group.aria);
  bar.innerHTML = tabs.map(t => {
    const n = t.badge ? App._tabCounts?.[t.badge] : 0;
    return `<button class="proj-tab ${t.view === App.view ? 'active' : ''}" data-tab="${t.view}" ${t.view === App.view ? 'aria-current="page"' : ''}>${t.label}${n ? ` <span class="proj-tab-count" data-count="${t.badge}">${n}</span>` : ''}</button>`;
  }).join('');
  bar.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b && b.dataset.tab !== App.view) navigate(b.dataset.tab); });
  mainContent.insertBefore(bar, mainContent.firstChild);
  const active = bar.querySelector('.proj-tab.active');                              // en pantallas estrechas la barra se desliza: la pestaña abierta no puede quedar fuera de vista
  if (active && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = Math.max(0, active.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2);
}
new MutationObserver(ensureProjectTabs).observe(mainContent, { childList: true });

// ==============================================================
//  USO LOCAL (qué vistas se abren) — nunca sale del navegador; sirve para decidir qué sobra
// ==============================================================
const Usage = {
  KEY: 'ros-usage',
  read() { try { return JSON.parse(localStorage.getItem(this.KEY) || '{}'); } catch { return {}; } },
  hit(view) {
    if (!view) return;
    const u = this.read();
    u[view] = (u[view] || 0) + 1;
    u._since = u._since || localDateISO();
    try { localStorage.setItem(this.KEY, JSON.stringify(u)); } catch {}
  },
  reset() { try { localStorage.removeItem(this.KEY); } catch {} },
};

// ==============================================================
//  ROUTER
// ==============================================================
function navigate(view, addToHistory = true) {
  // Limpiar handler de teclado del Triage si existe
  if (App._triageKeyHandler) {
    document.removeEventListener('keydown', App._triageKeyHandler);
    App._triageKeyHandler = null;
  }
  // Limpiar handler del menú "+ Agregar" del hub si existe
  if (App._hubMenuClickHandler) {
    document.removeEventListener('click', App._hubMenuClickHandler);
    App._hubMenuClickHandler = null;
  }
  // Persiste el inspector si el panel está abierto al momento de navegar
  if (!document.body.classList.contains('inspector-closed') &&
      App.inspectedType && App.inspectedId) {
    App._savedInspector = { type: App.inspectedType, id: App.inspectedId };
  }
  closeMobileMenu();
  revealNavItem(view);
  App.view = view;
  // Resetear offset de agenda mensual al navegar explícitamente a la vista
  if (view === 'weekly' && addToHistory) App.agendaMonthOffset = 0;
  if (addToHistory) {
    // Truncate forward stack when branching
    App.navHistory = App.navHistory.slice(0, App.navIndex + 1);
    App.navHistory.push(view);
    App.navIndex = App.navHistory.length - 1;
  }
  _updateNavHistoryBtns();
  if (PROJECT_TABS.some(t => t.view === view)) { try { localStorage.setItem('ros-proj-tab', view); } catch {} }
  Usage.hit(view);
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', (el.dataset.views || el.dataset.view).split(' ').includes(view));
  });
  // Si el menú tiene scroll, el elemento activo no puede quedar escondido (se espera a que el grupo termine de abrirse)
  requestAnimationFrame(() => document.querySelector('.sidebar-nav .nav-item.active')?.scrollIntoView({ block: 'nearest' }));
  setTimeout(() => document.querySelector('.sidebar-nav .nav-item.active')?.scrollIntoView({ block: 'nearest' }), 260);
  App._isNavigating = true;
  renderView(view);
}

function closeMobileMenu() {
  document.body.classList.remove('sidebar-mobile-open');
  $('mobileMenuBtn')?.setAttribute('aria-expanded', 'false');
}

function navBack() {
  if (App.navIndex > 0) {
    App.navIndex--;
    navigate(App.navHistory[App.navIndex], false);
  }
}

function navForward() {
  if (App.navIndex < App.navHistory.length - 1) {
    App.navIndex++;
    navigate(App.navHistory[App.navIndex], false);
  }
}

function _updateNavHistoryBtns() {
  const b = $('navBack');    if (b) b.disabled = App.navIndex <= 0;
  const f = $('navForward'); if (f) f.disabled = App.navIndex >= App.navHistory.length - 1;
}

/**
 * Pinta una vista. Si ya hay un pintado en curso de la misma vista (p. ej. un cambio de datos que llega mientras
 * se está repintando), no se lanza otro en paralelo: se repite una sola vez al terminar, con los datos más recientes.
 */
function renderView(view) {
  if (App._rendering && !App._isNavigating && view === App.view) {
    App._renderAgain = true;
    return App._rendering;
  }
  const run = (async () => {
    let v = view;
    await _renderViewNow(v);
    // Se repinta si pidieron otro pintado mientras tanto o si, al terminar, ya se estaba en otra vista
    // (el pintado lento de la vista anterior habría pisado a la nueva).
    while (App._renderAgain || App.view !== v) { App._renderAgain = false; v = App.view; await _renderViewNow(v); }
  })().finally(() => { if (App._rendering === run) App._rendering = null; });
  App._rendering = run;
  return run;
}

/** Posición de scroll de la vista y de sus listas internas (columnas del tablero…), para devolverla tras repintar. */
function _viewSnapshot() {
  const snap = { top: mainContent.scrollTop, left: mainContent.scrollLeft, inner: [], focusId: null };
  for (const el of mainContent.querySelectorAll('*')) {
    if (!el.scrollTop && !el.scrollLeft) continue;
    const first = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    const sel = el.id ? `#${CSS.escape(el.id)}` : first ? `.${CSS.escape(first)}` : '';
    if (!sel) continue;
    snap.inner.push({ sel, idx: [...mainContent.querySelectorAll(sel)].indexOf(el), top: el.scrollTop, left: el.scrollLeft });
  }
  const a = document.activeElement;
  if (a && a.id && mainContent.contains(a)) snap.focusId = a.id;
  return snap;
}
function _viewRestore(snap) {
  if (!snap) return;
  mainContent.scrollTop = snap.top; mainContent.scrollLeft = snap.left;
  for (const s of snap.inner) {
    const el = mainContent.querySelectorAll(s.sel)[s.idx];
    if (el) { el.scrollTop = s.top; el.scrollLeft = s.left; }
  }
  if (snap.focusId && (!document.activeElement || document.activeElement === document.body)) $(snap.focusId)?.focus({ preventScroll: true });
}

/** Vuelve a pintar el elemento abierto en el inspector con los datos actuales (sin vaciarlo ni perder el scroll). */
async function refreshInspector() {
  const type = App.inspectedType, id = App.inspectedId;
  if (!type || id == null || document.body.classList.contains('inspector-closed')) return;
  const a = document.activeElement;
  if (inspectorBody.querySelector('#mdDescEditor') ||                          // hay texto a medio escribir
      (a && inspectorBody.contains(a) && a.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=range]):not([type=color]), textarea'))) return;
  const table = { project: 'projects', idea: 'ideas', snippet: 'snippets', meeting: 'meetings', reference: 'references', collaborator: 'collaborators' }[type];
  if (!table) return;
  if (!(await db[table].get(id))) { closeInspector(); return; }                // el elemento ya no existe
  const top = inspectorBody.scrollTop;
  await _restoreInspector({ type, id });
  inspectorBody.scrollTop = top;
}

async function _renderViewNow(view) {
  const _wasNavigating = App._isNavigating;
  App._isNavigating = false;
  App._renderStartedAt = performance.now();
  // Repintar la vista en la que ya se está (tras un cambio de datos) no es navegar: conserva scroll, foco e inspector.
  const isRefresh = !_wasNavigating && view === App.view;
  const snap = isRefresh ? _viewSnapshot() : null;
  mainContent.removeAttribute('data-view');      // se vuelve a poner al terminar de pintar (ver abajo)
  if (view !== 'ideas') App._ideasLimit = 0;       // al salir de Ideas, la próxima vez vuelve a empezar por las primeras

  // Preservar inspector en refresh data-only (sort/inline edit), sin pasar por navigate()
  if (!isRefresh && view === 'projects' && App._projDataOnly && App.view === 'projects' &&
      App.inspectedType && App.inspectedId && !App._savedInspector) {
    App._savedInspector = { type: App.inspectedType, id: App.inspectedId };
  }

  if (!isRefresh) _softResetInspector();

  // ── Refresh data-only: no blanquear mainContent, solo repoblar #projectsContainer ──
  if (view === 'projects' && App._projDataOnly && App.view === 'projects') {
    await renderProjects();           // lee y resetea _projDataOnly internamente
    await updateBadges();
    if (App._savedInspector) await _restoreInspector(App._savedInspector);
    else if (isRefresh) await refreshInspector();
    _viewRestore(snap);
    mainContent.dataset.view = view;
    return;
  }

  const bcMap = {
    dashboard:  [],     // Hoy es la raíz: sin migas de pan
    kanban: [],
    projects: [],
    ideas:      [{label:'Hoy', view:'dashboard'}, {label:'Ideas', view:'ideas'}],
    snippets:   [{label:'Hoy', view:'dashboard'}, {label:'Snippets', view:'snippets'}],
    filesystem: [{label:'Hoy', view:'dashboard'}, {label:'Carpetas del proyecto', view:'filesystem'}],
    settings:   [{label:'Hoy', view:'dashboard'}, {label:'Ajustes', view:'settings'}],
    timeline: [],
    archived:   [{label:'Hoy', view:'dashboard'}, {label:'Archivados', view:'archived'}],
    starred:      [{label:'Hoy', view:'dashboard'}, {label:'Favoritos',   view:'starred'}],
    nested: [],
    weekly:       [{label:'Hoy', view:'dashboard'}, {label:'Calendario',  view:'weekly'}],
    submissions:  [{label:'Hoy', view:'dashboard'}, {label:'Submissions', view:'submissions'}],
    meetings:     [{label:'Hoy', view:'dashboard'}, {label:'Reuniones',   view:'meetings'}],
    references:   [{label:'Hoy', view:'dashboard'}, {label:'Referencias', view:'references'}],
    collaborators: [{label:'Hoy', view:'dashboard'}, {label:'Colaboradores',view:'collaborators'}],
    'project-hub': [{label:'Hoy', view:'dashboard'}, {label:'Proyectos',    view:'projects'}, {label:'Hub',view:'project-hub'}],
    focus:         [{label:'Hoy', view:'dashboard'}, {label:'Hoy',   view:'focus'}],
    orphans:       [{label:'Hoy', view:'dashboard'}, {label:'Huérfanos',    view:'orphans'}],
    triage:        [{label:'Hoy', view:'dashboard'}, {label:'Ideas',  view:'ideas'}, {label:'Revisión rápida', view:'triage'}],
    areas:         [{label:'Hoy', view:'dashboard'}, {label:'Áreas', view:'areas'}],
    tutorial: [{label:'Hoy', view:'dashboard'}, {label:'Tutorial', view:'tutorial'}],
    'collaborator-hub': [{label:'Hoy', view:'dashboard'}, {label:'Colaboradores', view:'collaborators'}, {label:'Perfil', view:'collaborator-hub'}],
    review:        [{label:'Hoy', view:'dashboard'}, {label:'Revisión semanal', view:'review'}],
    network:       [],
    report:        [{label:'Hoy', view:'dashboard'}, {label:'Informe de avance', view:'report'}],
  };

  // Render first, then inject BC at top so innerHTML overwrites don't destroy it
  try {
  switch (view) {
    case 'dashboard':  await renderDashboard();  break;
    case 'kanban':     await renderKanban();     break;
    case 'projects':   await renderProjects();   break;
    case 'ideas':      await renderIdeas();      break;
    case 'snippets':   await renderSnippets();   break;
    case 'filesystem': await renderFilesystem(); break;
    case 'settings':   await renderSettings();   break;
    case 'archived':   await renderArchived();   break;
    case 'starred':    await renderStarred();    break;
    case 'timeline':   await renderTimeline();   break;
    case 'nested':       await renderNestedProjects();  break;
    case 'weekly':       await renderWeeklyAgenda();    break;
    case 'submissions':  await renderSubmissions();     break;
    case 'meetings':     await renderMeetings();        break;
    case 'references':   await renderReferences();      break;
    case 'collaborators':await renderCollaborators();   break;
    case 'project-hub':  await renderProjectHub();      break;
    case 'focus':        await renderDashboard();       break;   // «Hoy» quedó integrado en Hoy
    case 'orphans':      await renderOrphans();         break;
    case 'triage':       await renderIdeaTriage();      break;
    case 'areas':        await renderAreas();           break;
    case 'tutorial':     await renderTutorial();        break;
    case 'collaborator-hub': await renderCollaboratorHub(); break;
    case 'review':       await renderWeeklyReview();    break;
    case 'network':      await renderNetwork();         break;
    case 'report':       await renderReport();          break;
    default:             await renderDashboard();
  }
  } catch (err) {                                  // una vista que falla no deja la pantalla a medias ni en blanco
    // Un pintado que ya quedó obsoleto (se navegó a otra vista, o se pidió repintar) falla porque otro lo pisó: lo repite renderView, sin pantalla de error
    if (view !== App.view || App._renderAgain) { console.debug('Pintado obsoleto de «' + view + '» descartado', err); return; }
    console.error('Error al pintar «' + view + '»', err);
    ErrorLog.add('vista ' + view, err, { quiet: true });
    mainContent.innerHTML = `
      <div class="view"><div class="empty-state view-error" role="alert">
        <span class="empty-state-icon">⚠</span>
        <h3>No se pudo mostrar esta pantalla</h3>
        <p>Tus datos están a salvo. Prueba de nuevo o vuelve a Hoy; si se repite, descarga una copia y revisa Ajustes → Diagnóstico.</p>
        <p class="form-hint">${esc(String(err?.message || err).slice(0, 200))}</p>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:10px">
          <button class="btn btn-primary btn-sm" id="viewRetry">↻ Reintentar</button>
          <button class="btn btn-ghost btn-sm" id="viewHome">Ir a Hoy</button>
          <button class="btn btn-ghost btn-sm" id="viewBackup">Descargar copia de seguridad</button>
        </div></div></div>`;
    $('viewRetry')?.addEventListener('click', () => renderView(App.view));
    $('viewHome')?.addEventListener('click', () => navigate('dashboard'));
    $('viewBackup')?.addEventListener('click', () => downloadBackup('researchos-diagnostico').catch(e => showToast(e.message, 'error')));
    mainContent.dataset.view = view;
    return;
  }

  setupListFilter(view);                   // antes de devolver el scroll: la barra del filtro ocupa sitio arriba

  const bcHTML = breadcrumbHTML(bcMap[view] || []);
  if (bcHTML) {
    const wrap = document.createElement('div');
    wrap.innerHTML = bcHTML;
    const bcEl = wrap.firstElementChild;
    if (bcEl && mainContent.firstChild) {
      mainContent.insertBefore(bcEl, mainContent.firstChild);
    }
  }

  attachBreadcrumbHandlers();
  await updateBadges();
  _viewRestore(snap);

  // Restaurar inspector si estaba abierto cuando se inició la navegación
  if (App._savedInspector) {
    await _restoreInspector(App._savedInspector);
  } else if (isRefresh) {
    await refreshInspector();
  }
  if (isRefresh) requestAnimationFrame(() => { if (App.view === view) _viewRestore(snap); });   // algunas vistas ajustan su altura un frame después

  // ── Animación de entrada solo en navegaciones reales, no en refreshes de datos ──
  if (_wasNavigating) {
    mainContent.classList.remove('view-enter');
    void mainContent.offsetWidth;          // fuerza reflow para reiniciar animación
    mainContent.classList.add('view-enter');
  }
  autoLabelControls(mainContent);
  if (_wasNavigating) {                    // se anuncia el cambio de pantalla, no cada repintado por un cambio de datos
    const name = (mainContent.querySelector('.view-title')?.textContent || '').trim();
    if ($('srStatus') && name) { $('srStatus').textContent = ''; setTimeout(() => { if ($('srStatus')) $('srStatus').textContent = name; }, 60); }
  }
  mainContent.dataset.view = view;         // «esta vista ya está pintada» (lo usan los tests y las lectoras de pantalla)
}

// ==============================================================
//  VIEW: HOY (landing) + PANORAMA (métricas, plegadas)
// ==============================================================
async function renderDashboard() { await renderToday(); }      // today.js

/** Métricas y actividad: lo que antes era todo el dashboard. Solo se calcula si el usuario abre «Panorama». */
async function renderPanorama(host) {
  const today = new Date(); today.setHours(0,0,0,0);
  const [statsResult, cols, allProjects] = await Promise.all([
    getDashboardStats(),
    db.kanbanColumns.orderBy('order').toArray(),
    db.projects.toArray(),
  ]);
  const { projects, ideas, snippets, ideaUnread, recentProjects } = statsResult;
  const colMap = Object.fromEntries(cols.map(c => [c.id, c]));

  // Compute deadline urgency
  const withDeadlines = allProjects
    .filter(p => p.deadline)
    .map(p => {
      const d = new Date(p.deadline + 'T00:00:00');
      const daysLeft = Math.round((d - today) / 86400000);
      return { ...p, daysLeft };
    })
    .filter(p => p.daysLeft <= 30)
    .sort((a,b) => a.daysLeft - b.daysLeft);

  const overdue  = withDeadlines.filter(p => p.daysLeft < 0);
  const dueSoon  = withDeadlines.filter(p => p.daysLeft >= 0 && p.daysLeft <= 7);
  const upcoming = withDeadlines.filter(p => p.daysLeft > 7 && p.daysLeft <= 30);
  const allAlert = [...withDeadlines].slice(0, 7);

  const urgencyBadge = (p) => {
    if (p.daysLeft < 0)  return `<span class="deadline-urgency urgency-overdue">Vencido</span>`;
    if (p.daysLeft === 0) return `<span class="deadline-urgency urgency-soon">Hoy</span>`;
    if (p.daysLeft <= 7) return `<span class="deadline-urgency urgency-soon">${p.daysLeft}d</span>`;
    return `<span class="deadline-urgency urgency-ok">${p.daysLeft}d</span>`;
  };

  host.innerHTML = `
    <div class="panorama-inner">
      <!-- Mini chart distribución por tipo y por columna -->
      <div class="dash-charts-row">
        <div class="dash-chart-card">
          <div class="dash-chart-title">Distribución por tipo</div>
          <div class="dash-chart-bars" id="typeDistChart">
            ${(() => {
              const types = {};
              allProjects.forEach(p => { types[p.type] = (types[p.type]||0)+1; });
              const max = Math.max(...Object.values(types), 1);
              return Object.entries(types)
                .sort((a,b) => b[1]-a[1])
                .map(([t, n]) => `
                  <div class="dash-bar-row">
                    <span class="dash-bar-label">${esc(t)}</span>
                    <div class="dash-bar-track">
                      <div class="dash-bar-fill" data-w="${(n/max*100).toFixed(1)}"
                           style="width:0;background:var(--accent)"></div>
                    </div>
                    <span class="dash-bar-val">${n}</span>
                  </div>`).join('') || '<span style="color:var(--text-3);font-size:.75rem">Sin datos</span>';
            })()}
          </div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">Proyectos por columna</div>
          <div class="dash-chart-bars" id="colDistChart">
            ${(() => {
              const colCount = {};
              allProjects.forEach(p => { colCount[p.columnId] = (colCount[p.columnId]||0)+1; });
              const max = Math.max(...Object.values(colCount), 1);
              return cols
                .filter(c => colCount[c.id])
                .map(c => `
                  <div class="dash-bar-row">
                    <span class="dash-bar-label">${esc(c.title)}</span>
                    <div class="dash-bar-track">
                      <div class="dash-bar-fill" data-w="${((colCount[c.id]||0)/max*100).toFixed(1)}"
                           style="width:0;background:${cssColor(c.color)}"></div>
                    </div>
                    <span class="dash-bar-val">${colCount[c.id]||0}</span>
                  </div>`).join('') || '<span style="color:var(--text-3);font-size:.75rem">Sin datos</span>';
            })()}
          </div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title" style="display:flex;align-items:center;
               justify-content:space-between">
            <span>Pipeline de papers</span>
            <button class="btn btn-ghost btn-sm" style="font-size:.6rem;padding:1px 6px"
                    data-dash-nav="submissions">Ver todo →</button>
          </div>
          <div class="dash-chart-bars">
            ${await (async () => {
              const papers = await db.projects.filter(p => p.type === 'Paper' && !p.archived).toArray();
              if (!papers.length) return '<span style="color:var(--text-3);font-size:.75rem">Sin papers activos</span>';
              const counts = {};
              SUB_STATUSES.forEach(s => { counts[s.key] = 0; });
              papers.forEach(p => {
                const k = p.submissionStatus || _defaultSubKey();
                if (counts[k] !== undefined) counts[k]++;
              });
              const max = Math.max(...Object.values(counts), 1);
              return SUB_STATUSES
                .filter(s => counts[s.key] > 0)
                .map(s => `
                  <div class="dash-bar-row">
                    <span class="dash-bar-label" style="color:${cssColor(s.color)}">${s.shortLabel}</span>
                    <div class="dash-bar-track">
                      <div class="dash-bar-fill" data-w="${(counts[s.key]/max*100).toFixed(1)}"
                           style="width:0;background:${cssColor(s.color)}"></div>
                    </div>
                    <span class="dash-bar-val">${counts[s.key]}</span>
                  </div>`).join('') ||
                '<span style="color:var(--text-3);font-size:.75rem">Sin actividad de submission</span>';
            })()}
          </div>
        </div>
      </div>

    </div>`;

  // Trigger bar & arc animations after paint
  requestAnimationFrame(() => requestAnimationFrame(() => {
    host.querySelectorAll('.dash-bar-fill[data-w]').forEach(el => {
      el.style.width = el.dataset.w + '%';
    });
    host.querySelectorAll('.anim-arc[data-dash]').forEach(el => {
      el.setAttribute('stroke-dasharray', `${el.dataset.dash} 100`);
    });
  }));

  host.querySelectorAll('[data-inspect-project]').forEach(el => {
    el.addEventListener('click',      () => inspectProject(+el.dataset.inspectProject));
    el.addEventListener('mouseenter', () => HoverCard.show(+el.dataset.inspectProject, el));
    el.addEventListener('mouseleave', () => HoverCard.hide());
  });

}

// ==============================================================
//  HOVER CONTEXT CARD — popover no-modal sobre proyectos
// ==============================================================
const HoverCard = {
  _el: null, _timer: null, _hideTimer: null,

  init() {
    if ($('hoverCard')) return;
    const el = document.createElement('div');
    el.id = 'hoverCard';
    el.className = 'hover-card';
    el.innerHTML = '';
    document.body.appendChild(el);
    this._el = el;
    el.addEventListener('mouseenter', () => clearTimeout(this._hideTimer));
    el.addEventListener('mouseleave', () => this.hide());
  },

  async show(projectId, anchorEl) {
    if (App._isDragging) return;
    this.init();
    clearTimeout(this._timer);
    clearTimeout(this._hideTimer);
    this._timer = setTimeout(async () => {
      const [p, cols, ideas, meetings] = await Promise.all([
        db.projects.get(projectId),
        db.kanbanColumns.toArray(),
        db.ideas.where('projectId').equals(projectId).toArray(),
        typeof db.meetings !== 'undefined'
          ? db.meetings.where('projectId').equals(projectId).toArray()
          : Promise.resolve([])
      ]);
      if (!p) return;
      const colMap   = Object.fromEntries(cols.map(c => [c.id, c]));
      const col      = colMap[p.columnId];
      const unread   = ideas.filter(i => i.status === 'unread').length;
      const pending  = meetings.flatMap(m => (m.actionItems||[]).filter(a => !a.done)).length;
      const today    = new Date(); today.setHours(0,0,0,0);
      const daysDiff = p.deadline
        ? Math.round((new Date(p.deadline + 'T00:00:00') - today) / 86400000) : null;
      const deadlineColor = daysDiff === null ? 'var(--text-3)'
        : daysDiff < 0 ? 'var(--red)' : daysDiff <= 7 ? 'var(--amber)' : 'var(--green)';
      const lastEdit = p.updatedAt
        ? Math.floor((Date.now() - new Date(p.updatedAt)) / 86400000) : null;
      const stale = lastEdit !== null && lastEdit > 14;

      this._el.innerHTML = `
        <div class="hc-title">${esc(p.title)}</div>
        <div class="hc-meta">
          <span class="hc-chip" style="background:var(--accent-d);color:var(--accent)">${esc(col?.title || '—')}</span>
          <span class="hc-chip">${esc(p.type)}</span>
          <span class="hc-chip badge ${prioBadgeClass(p.priority)}">${esc(p.priority)}</span>
        </div>
        <div class="hc-row">
          <span class="hc-key">Deadline</span>
          <span style="font-family:var(--font-mono);font-size:.72rem;color:${deadlineColor}">
            ${daysDiff === null ? '—'
              : daysDiff < 0  ? `Vencido hace ${Math.abs(daysDiff)}d`
              : daysDiff === 0 ? '¡Hoy!'
              : `en ${daysDiff}d`}
          </span>
        </div>
        ${unread || pending ? `
        <div class="hc-row">
          ${unread  ? `<span class="hc-chip" style="color:var(--amber)">◎ ${unread} sin revisar</span>` : ''}
          ${pending ? `<span class="hc-chip" style="color:var(--red)">⚑ ${pending} acción(es)</span>` : ''}
        </div>` : ''}
        ${stale ? `<div class="hc-stale">Sin actividad hace ${lastEdit}d</div>` : ''}
        ${p.responsible ? `<div class="hc-row"><span class="hc-key">Responsable</span><span style="font-size:.72rem">${esc(p.responsible)}</span></div>` : ''}
        <div class="hc-hint">Click para abrir inspector · Hub para ver todo</div>`;

      const rect = anchorEl.getBoundingClientRect();
      const cardW = 260;
      let left = rect.right + 10;
      if (left + cardW > window.innerWidth - 16) left = rect.left - cardW - 10;
      let top = rect.top;
      this._el.style.cssText = `left:${left}px;top:${top}px;display:block`;

      // Ajuste vertical si se sale del viewport
      const cardH = this._el.offsetHeight;
      if (top + cardH > window.innerHeight - 16)
        this._el.style.top = `${window.innerHeight - cardH - 16}px`;
    }, 550);
  },

  hide() {
    clearTimeout(this._timer);
    this._hideTimer = setTimeout(() => {
      if (this._el) this._el.style.display = 'none';
    }, 150);
  }
};

// -- Helper: board estándar — extrae la lógica de columnas --
function _kanbanBoardHTML(kanbanData, filterFn, unreadByProject, activeSubByProject, pendingAIByProject) {
  return kanbanData.map(col => {
    const visibleCards = filterFn(col.cards).filter(p =>
      App.filterResponsible === 'all' || (p.responsible || '') === App.filterResponsible
    );
    return `
    <div class="kanban-col" data-col-id="${col.id}" data-col-wip="${col.wip || ''}" id="col-${col.id}"
           ondragover="kanbanDragOver(event)"
           ondragleave="kanbanDragLeave(event)"
           ondrop="kanbanDrop(event)">
      <div class="kanban-col-header">
        <span class="kanban-col-dot" style="background:${cssColor(col.color)}"></span>
        <span class="kanban-col-title">${esc(col.title)}</span>
        <span class="kanban-col-count ${col.wip && visibleCards.length > col.wip ? 'kanban-wip-exceeded' : ''}">
          ${visibleCards.length}${col.wip ? `<span class="kanban-wip-badge">/${col.wip}</span>` : ''}
        </span>
      </div>
      <div class="kanban-cards" id="cards-${col.id}"
           data-col="${col.id}"
           ondragover="kanbanDragOver(event)"
           ondragleave="kanbanDragLeave(event)"
           ondrop="kanbanDrop(event)">
        ${visibleCards.map(p => kanbanCardHTML(
          p,
          unreadByProject[p.id]    || 0,
          activeSubByProject[p.id] || null,
          pendingAIByProject[p.id] || 0
        )).join('')}
      </div>
      <button class="kanban-add-btn" data-add-col="${col.id}">+ Añadir tarjeta</button>
    </div>`;
  }).join('');
}

// -- Helper: board en modo swimlane 2D ----------
function _kanbanSwimlaneHTML(kanbanData, filterFn, unreadByProject, activeSubByProject, pendingAIByProject, groupBy, areaMap) {
  const TYPE_ICONS = {
    Paper:'📄', Grant:'💰', Análisis:'📊', Dataset:'🗄',
    Proyecto:'◉', Presentación:'🎤', Curso:'🎓'
  };

  const allCards = kanbanData.flatMap(col =>
    filterFn(col.cards)
      .filter(p => App.filterResponsible === 'all' || (p.responsible || '') === App.filterResponsible)
      .map(p => ({ ...p, _colId: col.id }))
  );

  const getKey = p => groupBy === 'type'
    ? (p.type || 'Sin tipo')
    : (areaMap[p.areaId]?.name || 'Sin área');

  const groupKeys = [...new Set(allCards.map(getKey))].sort();
  if (!groupKeys.length) return `
    <div class="timeline-empty" style="padding:60px 32px">
      Sin proyectos para el preset y agrupación activos.
    </div>`;

  const N    = kanbanData.length;
  const colW = 240;
  const lblW = 116;

  return `
    <div class="kanban-swim-board">
      <div class="kanban-swim-grid"
           style="grid-template-columns:${lblW}px ${Array(N).fill(`${colW}px`).join(' ')}">

        <!-- Fila 0: cabeceras de columna -->
        <div></div>
        ${kanbanData.map(col => `
          <div class="kanban-swim-col-header">
            <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;
                         display:inline-block;background:${cssColor(col.color)}"></span>
            <span style="font-family:var(--font-display);font-size:.8rem;
                         font-weight:600;color:var(--text-1)">${esc(col.title)}</span>
            <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--text-3);margin-left:auto">
              ${allCards.filter(p => p._colId === col.id).length}
            </span>
          </div>`).join('')}

        <!-- Filas de swimlane -->
        ${groupKeys.map(key => {
          const icon        = groupBy === 'type' ? (TYPE_ICONS[key] || '◉') : '⊡';
          const groupTotal  = allCards.filter(p => getKey(p) === key).length;
          return `
            <div class="kanban-swim-row-label">
              <span style="font-size:1.2rem;line-height:1">${icon}</span>
              <span style="font-size:.72rem;font-weight:600;color:var(--text-1);
                           word-break:break-word;text-align:center">${esc(key)}</span>
              <span style="font-family:var(--font-mono);font-size:.6rem;color:var(--text-3)">${groupTotal}</span>
            </div>
            ${kanbanData.map(col => {
              const cellCards = allCards.filter(p => getKey(p) === key && p._colId === col.id);
              return `
                <div class="kanban-swim-cell"
                     data-swim-col="${col.id}" data-swim-group="${esc(key)}"
                     ondragover="kanbanDragOver(event)"
                     ondragleave="kanbanDragLeave(event)"
                     ondrop="kanbanDrop(event)">
                  ${cellCards.length
                    ? cellCards.map(p => kanbanCardHTML(
                        p,
                        unreadByProject[p.id]    || 0,
                        activeSubByProject[p.id] || null,
                        pendingAIByProject[p.id] || 0
                      )).join('')
                    : `<div class="kanban-swim-cell-empty">—</div>`}
                </div>`;
            }).join('')}`;
        }).join('')}
      </div>
    </div>`;
}

// ==============================================================
//  VIEW: KANBAN
// ==============================================================
async function renderKanban() {
  const [kanbanData, colPresets, areas, unreadIdeas, allKanbanMeets, taskStats] = await Promise.all([
    getKanbanData(),
    _getColPresets(),
    _getAreas(),
    db.ideas.where('status').equals('unread').toArray(),
    db.meetings.toArray(),
    Tasks.statsByProject(),
  ]);
  App._taskStats = taskStats;
  const areaMap = Object.fromEntries(areas.map(a => [a.id, a]));
  const unreadByProject = {};
  unreadIdeas.forEach(i => {
    if (i.projectId) unreadByProject[i.projectId] = (unreadByProject[i.projectId] || 0) + 1;
  });

  // Estado de submission derivado directamente del proyecto Paper
  const activeSubByProject = {};
  kanbanData.flatMap(c => c.cards).forEach(p => {
    if (p.submissionStatus)
      activeSubByProject[p.id] = {
        status:      p.submissionStatus,
        targetVenue: p.targetVenue || '',
        updatedAt:   p.updatedAt,
      };
  });

  // Action items pendientes por proyecto
  const pendingAIByProject = {};
  allKanbanMeets.forEach(m => {
    if (!m.projectId) return;
    const n = (m.actionItems || []).filter(a => !a.done).length;
    if (n > 0) pendingAIByProject[m.projectId] = (pendingAIByProject[m.projectId] || 0) + n;
  });

  const kanbanResps = [...new Set(
    kanbanData.flatMap(c => c.cards).map(p => p.responsible).filter(Boolean)
  )].sort();

  // -- Filtro por preset activo ------------------------------
  const activePreset  = colPresets.find(pr => pr.id === App.activeColPreset);
  const filterByPreset = cards =>
    ((App.activeColPreset === 'all' || !activePreset)
      ? cards
      : cards.filter(p => activePreset.types.includes(p.type))).filter(inContext);

  // Una columna «solo para» ciertos tipos se esconde cuando la vista activa no incluye ninguno de ellos (p. ej. «Corrección» en la vista de docencia).
  const colApplies = c => !c.types?.length || !activePreset || App.activeColPreset === 'all' || c.types.some(t => activePreset.types.includes(t));
  const shownData = kanbanData.filter(colApplies);

  // -- Contar visibles para el subtitle ---------------------
  const totalVisible = shownData.reduce((s, c) =>
    s + filterByPreset(c.cards).filter(p =>
      App.filterResponsible === 'all' || (p.responsible || '') === App.filterResponsible
    ).length, 0);

  // -- Generar board (estándar o swimlane) -------------------
  const boardHTML = App.kanbanGroupBy === 'none'
    ? _kanbanBoardHTML(shownData, filterByPreset, unreadByProject, activeSubByProject, pendingAIByProject)
    : _kanbanSwimlaneHTML(shownData, filterByPreset, unreadByProject, activeSubByProject, pendingAIByProject, App.kanbanGroupBy, areaMap);

  mainContent.innerHTML = `
    <div class="kanban-view-header">
      <div>
        <div class="view-title">Tablero</div>
        <div class="view-subtitle">${totalVisible} proyecto(s) visibles</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-ghost btn-sm" id="kanbanPresBtn" title="Modo presentación (F5)">⛶</button>
        <button class="btn btn-ghost btn-sm" id="kanbanManageCols">⚙ Columnas</button>
        <!-- Swimlane toggle -->
          <div class="tl-btn-group">
            <button class="btn btn-ghost btn-sm ${App.kanbanGroupBy==='none'?'active':''}"
                    data-swim="none" title="Vista board estándar">⊞</button>
            <button class="btn btn-ghost btn-sm ${App.kanbanGroupBy==='type'?'active':''}"
                    data-swim="type" title="Swimlanes por tipo">⊟ Tipo</button>
            <button class="btn btn-ghost btn-sm ${App.kanbanGroupBy==='area'?'active':''}"
                    data-swim="area" title="Swimlanes por área">⊡ Área</button>
          </div>
          <!-- Density toggle -->
          <div class="tl-btn-group">
            <button class="btn btn-ghost btn-sm ${App.kanbanDensity==='detailed'?'active':''}"
                    data-density="detailed" title="Vista detallada">☰</button>
            <button class="btn btn-ghost btn-sm ${App.kanbanDensity==='compact'?'active':''}"
                    data-density="compact"  title="Vista compacta">⊟</button>
          </div>
          <button class="btn btn-primary btn-sm" id="kanbanAddProject">+ Proyecto</button>
      </div>
    </div>

    <!-- Preset tabs -->
    <div style="display:flex;align-items:center;gap:5px;padding:8px 32px 0;flex-wrap:wrap">
      <span style="font-family:var(--font-mono);font-size:.6rem;color:var(--text-3);
                   text-transform:uppercase;letter-spacing:.08em;margin-right:2px">Vista:</span>
      <button class="filter-chip ${App.activeColPreset==='all'?'active':''}"
              data-kpreset="all" style="font-size:.72rem">Todos</button>
      ${colPresets.map(pr => `
        <button class="filter-chip ${App.activeColPreset===pr.id?'active':''}"
                data-kpreset="${pr.id}" style="font-size:.72rem">${pr.icon} ${esc(pr.name)}</button>`).join('')}
      <button class="btn btn-ghost btn-sm" id="managePresetsBtn"
              style="font-size:.62rem;padding:2px 8px;color:var(--text-3)">⚙ Editar</button>
    </div>

    ${kanbanResps.length ? `
    <div class="kanban-resp-bar" style="padding-top:6px">
      <button class="resp-chip ${App.filterResponsible==='all'?'active':''}" data-kfilt-resp="all">Todos</button>
      ${kanbanResps.map(r => `<button class="resp-chip ${App.filterResponsible===r?'active':''}" data-kfilt-resp="${esc(r)}">${esc(r)}</button>`).join('')}
    </div>` : ''}

    ${App.kanbanGroupBy === 'none'
      ? `<div class="kanban-board">${boardHTML}</div>`
      : boardHTML}`;

  $('kanbanAddProject').addEventListener('click', showAddProjectModal);
  mainContent.querySelectorAll('[data-kfilt-resp]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.filterResponsible = btn.dataset.kfiltResp;
      renderKanban();
    });
  });
  $('kanbanManageCols')?.addEventListener('click', showManageColumnsModal);

  // Swimlane toggle
  mainContent.querySelectorAll('[data-swim]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.kanbanGroupBy = btn.dataset.swim;
      localStorage.setItem('ros-kanban-groupby', App.kanbanGroupBy);
      renderKanban();
    });
  });

  // Density toggle
  mainContent.querySelectorAll('[data-density]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.kanbanDensity = btn.dataset.density;
      localStorage.setItem('ros-kanban-density', App.kanbanDensity);
      renderKanban();
    });
  });

  // Preset tabs
  mainContent.querySelectorAll('[data-kpreset]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.activeColPreset = btn.dataset.kpreset;
      renderKanban();
    });
  });
  $('managePresetsBtn')?.addEventListener('click', showManagePresetsModal);

  $('kanbanPresBtn').addEventListener('click', () => {
    document.body.classList.add('presentation-mode');
    document.body.classList.add('inspector-closed');
  });
  mainContent.querySelectorAll('.kanban-add-btn').forEach(btn => {
    btn.addEventListener('click', () => showAddProjectModal(+btn.dataset.addCol));
  });
  mainContent.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('mouseenter', () => HoverCard.show(+card.dataset.projectId, card));
    card.addEventListener('mouseleave', () => HoverCard.hide());
    card.addEventListener('click', (e) => {
      if (!e.target.closest('.kanban-card-footer') && !e.target.closest('[data-inline-rename]')) {
        inspectProject(+card.dataset.projectId);
      }
    });
    card.addEventListener('dragstart', kanbanDragStart);
    card.addEventListener('dragend', kanbanDragEnd);
  });

  // Inline rename — doble clic en el título de la tarjeta
  mainContent.querySelectorAll('[data-inline-rename]').forEach(el => {
    el.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const projId  = +el.dataset.inlineRename;
      const oldTitle = el.dataset.inlineRenameValue || el.textContent.trim();
      const input = document.createElement('input');
      input.className = 'kanban-inline-input';
      input.value = oldTitle;
      el.replaceWith(input);
      input.focus(); input.select();
      let done = false;
      const commit = async () => {
        if (done) return; done = true;                 // Enter y la pérdida de foco que le sigue no deben guardar dos veces
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== oldTitle) {
          await dbWrite(() => db.projects.update(projId, {
            title: newTitle, updatedAt: new Date().toISOString()
          }));
          showToast('Proyecto renombrado ✓', 'success');
          SaveIndicator.done();
        }
        renderView(App.view);
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { done = true; renderView(App.view); }
      });
    });
  });
}

// -- Gestionar columnas Kanban -----------------------
async function showManageColumnsModal() {
  // Cada fila lleva una clave propia (_k): las columnas nuevas aún no tienen id y no pueden compartir `null`.
  let _newSeq = 0;
  const cols = (await db.kanbanColumns.orderBy('order').toArray()).map(c => ({ ...c, _k: String(c.id) }));
  const originalOrder = cols.map(c => c.id);

  /** Vuelca lo escrito en los inputs a `cols` antes de cualquier re-render (si no, se pierden las ediciones). */
  const syncFromInputs = () => {
    document.querySelectorAll('.col-manage-title').forEach(inp => {
      const col = cols.find(c => c._k === inp.dataset.colId);
      if (col) col.title = inp.value.trim() || col.title;
    });
    document.querySelectorAll('.col-manage-color').forEach(inp => {
      const col = cols.find(c => c._k === inp.dataset.colId);
      if (col) col.color = inp.value;
    });
    document.querySelectorAll('.col-manage-wip').forEach(inp => {
      const col = cols.find(c => c._k === inp.dataset.colId);
      if (col) col.wip = +inp.value || null;
    });
    document.querySelectorAll('.col-manage-types').forEach(box => {
      const col = cols.find(c => c._k === box.dataset.colId);
      if (col) col.types = [...box.querySelectorAll('input:checked')].map(i => i.value);
    });
  };

  const renderRows = () => cols.map((c, i) => `
    <div class="col-manage-row" data-col-id="${c._k}" data-col-idx="${i}">
      <span class="col-manage-handle" title="Reordenar" style="cursor:grab">⠿</span>
      <input class="form-input col-manage-title" aria-label="Nombre de la columna"
             value="${esc(c.title)}" data-col-id="${c._k}"
             style="flex:1;padding:5px 8px;font-size:.82rem">
      <input type="color" class="col-manage-color" aria-label="Color de la columna"
             value="${esc(cssColor(c.color, '#38bdf8'))}" data-col-id="${c._k}"
             style="width:32px;height:32px;border:none;background:none;cursor:pointer;border-radius:6px">
      <input type="number" class="form-input col-manage-wip"
             value="${c.wip||''}" placeholder="WIP" data-col-id="${c._k}"
             style="width:64px;padding:5px 8px;font-size:.82rem"
             title="Límite de trabajo en curso (dejar vacío = sin límite)">
      <button class="btn btn-ghost btn-sm col-manage-del" data-col-id="${c._k}" aria-label="Eliminar columna"
              style="color:var(--red)" ${cols.length <= 1 ? 'disabled' : ''}>✕</button>
      <details class="col-manage-typesbox" style="flex-basis:100%">
        <summary style="font-size:.7rem;color:var(--text-3);cursor:pointer">Solo para: ${(c.types || []).length ? esc((c.types || []).join(', ')) : 'todos los tipos'}</summary>
        <div class="col-manage-types" data-col-id="${c._k}" style="display:flex;flex-wrap:wrap;gap:4px 12px;padding:6px 2px">
          ${['Proyecto', 'Grant', 'Paper', 'Análisis', 'Dataset', 'Presentación', 'Curso'].map(t => `<label style="font-size:.74rem"><input type="checkbox" value="${t}" ${(c.types || []).includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}
        </div>
      </details>
    </div>`).join('');

  showModal('⚙ Gestionar columnas Kanban', `
    <div class="modal-body">
      <div style="font-size:.75rem;color:var(--text-3);margin-bottom:10px">
        Edita títulos, colores y límites WIP. Los cambios se aplican al guardar.
      </div>
      <div id="colManageList">${renderRows()}</div>
      <button class="btn btn-ghost btn-sm" id="colAddNew" style="margin-top:10px;width:100%">
        + Nueva columna
      </button>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="colManageCancel">Cancelar</button>
      <button class="btn btn-primary" id="colManageSave">Guardar cambios</button>
    </div>`);

  $('colManageCancel').addEventListener('click', closeModal);

  $('colAddNew').addEventListener('click', () => {
    syncFromInputs();
    cols.push({
      id: null, _k: `new${++_newSeq}`, title: 'Nueva columna',
      order: cols.length, color: '#38bdf8', wip: null, types: []
    });
    $('colManageList').innerHTML = renderRows();
    attachColRowHandlers();
    attachDragToRows();
  });

  const attachColRowHandlers = () => {
    document.querySelectorAll('.col-manage-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        syncFromInputs();
        const idx = cols.findIndex(c => c._k === btn.dataset.colId);
        if (idx < 0) return;
        const col = cols[idx];
        if (col.id) {
          const count = await db.projects.where('columnId').equals(col.id).count();
          const dest  = cols[idx > 0 ? idx - 1 : idx + 1];
          if (count > 0 && !(await askConfirm(`Esta columna tiene ${count} proyecto(s). Se moverán a «${dest.title}».`, { title: '¿Quitar la columna?', confirmLabel: 'Quitar y mover' }))) return;
        }
        cols.splice(idx, 1);
        $('colManageList').innerHTML = renderRows();
        attachColRowHandlers();
        attachDragToRows();
      });
    });
  };
  attachColRowHandlers();

  const attachDragToRows = () => {
    const list = $('colManageList');
    if (!list) return;
    let dragSrcIdx = null;
    list.querySelectorAll('.col-manage-row').forEach(row => {
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', e => {
        dragSrcIdx = +row.dataset.colIdx;
        e.dataTransfer.effectAllowed = 'move';
        row.style.opacity = '0.4';
      });
      row.addEventListener('dragend', () => {
        row.style.opacity = '';
        list.querySelectorAll('.col-manage-row').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        if (+row.dataset.colIdx !== dragSrcIdx) row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const tgtIdx = +row.dataset.colIdx;
        if (dragSrcIdx === null || dragSrcIdx === tgtIdx) return;
        syncFromInputs();
        const [moved] = cols.splice(dragSrcIdx, 1);
        cols.splice(tgtIdx, 0, moved);
        $('colManageList').innerHTML = renderRows();
        attachColRowHandlers();
        attachDragToRows();
      });
    });
  };
  attachDragToRows();

  $('colManageSave').addEventListener('click', async () => {
    syncFromInputs();

    await dbWrite(async () => {
      const retainedIds = new Set(cols.filter(c => c.id).map(c => c.id));
      const toDelete    = originalOrder.filter(id => !retainedIds.has(id));

      // 1) Crear/actualizar (las nuevas reciben su id aquí)
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        c.order = i;
        if (c.id) {
          await db.kanbanColumns.update(c.id, { title: c.title, color: c.color, order: c.order, wip: c.wip, types: c.types || [] });
        } else {
          c.id = await db.kanbanColumns.add({ title: c.title, color: c.color, order: c.order, wip: c.wip, types: c.types || [], isDefault: false });
        }
      }

      // 2) Los proyectos de columnas eliminadas pasan a la columna anterior (o a la siguiente si era la primera).
      //    Sin esto quedarían apuntando a una columna inexistente y desaparecerían del tablero.
      for (const gone of toDelete) {
        const pos  = originalOrder.indexOf(gone);
        const dest = originalOrder.slice(0, pos).reverse().concat(originalOrder.slice(pos + 1)).find(id => retainedIds.has(id)) ?? cols[0].id;
        for (const p of await db.projects.where('columnId').equals(gone).toArray())
          await recordColumnChange(p.id, dest);
      }
      if (toDelete.length) await db.kanbanColumns.bulkDelete(toDelete);
    });

    closeModal();
    showToast('Columnas actualizadas ✓', 'success');
    renderView('kanban');
  });
}

// -- Gestionar presets de Kanban -----------------
async function showManagePresetsModal() {
  const presets  = await _getColPresets();
  const ALL_TYPES = ['Proyecto','Grant','Paper','Análisis','Dataset','Presentación','Curso'];

  const renderRows = () => presets.map((pr, i) => `
    <div class="preset-row" style="display:flex;align-items:flex-start;gap:8px;padding:10px 0;
                border-bottom:1px solid var(--border)">
      <input class="form-input preset-icon" value="${esc(pr.icon || '⭐')}"
             data-pi="${i}"
             style="width:44px;font-size:1.1rem;text-align:center;padding:5px 4px;flex-shrink:0">
      <input class="form-input preset-name" value="${esc(pr.name)}"
             data-pi="${i}"
             style="width:120px;padding:5px 8px;font-size:.82rem;flex-shrink:0">
      <div style="display:flex;flex-wrap:wrap;gap:5px;flex:1;align-items:center">
        ${ALL_TYPES.map(t => `
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;
                        font-size:.72rem;color:var(--text-2)">
            <input type="checkbox" data-pi="${i}" data-type="${t}"
                   ${(pr.types || []).includes(t) ? 'checked' : ''}
                   style="accent-color:var(--accent)">
            ${t}
          </label>`).join('')}
      </div>
      <button class="btn btn-ghost btn-sm preset-del" data-pi="${i}"
              style="color:var(--red);flex-shrink:0" ${presets.length <= 1 ? 'disabled' : ''}>✕</button>
    </div>`).join('');

  showModal('⚙ Presets del Kanban', `
    <div class="modal-body">
      <p style="font-size:.75rem;color:var(--text-3);margin-bottom:12px">
        Los presets filtran qué tipos de proyecto se muestran en el Kanban. Icono · Nombre · Tipos incluidos.
      </p>
      <div id="presetsRows">${renderRows()}</div>
      <button class="btn btn-ghost btn-sm" id="presetAddNew"
              style="margin-top:10px;width:100%">+ Nuevo preset</button>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="presetCancel">Cancelar</button>
      <button class="btn btn-primary" id="presetSave">Guardar presets</button>
    </div>`);

  const attachHandlers = () => {
    document.querySelectorAll('.preset-del').forEach(btn => {
      btn.addEventListener('click', () => {
        presets.splice(+btn.dataset.pi, 1);
        $('presetsRows').innerHTML = renderRows();
        attachHandlers();
      });
    });
  };
  attachHandlers();

  $('presetAddNew').addEventListener('click', () => {
    presets.push({ id: `preset_${Date.now()}`, name: 'Nuevo', icon: '⭐', types: [] });
    $('presetsRows').innerHTML = renderRows();
    attachHandlers();
  });

  $('presetCancel').addEventListener('click', closeModal);

  $('presetSave').addEventListener('click', async () => {
    document.querySelectorAll('.preset-name').forEach(inp => {
      const i = +inp.dataset.pi;
      if (presets[i]) presets[i].name = inp.value.trim() || presets[i].name;
    });
    document.querySelectorAll('.preset-icon').forEach(inp => {
      const i = +inp.dataset.pi;
      if (presets[i]) presets[i].icon = inp.value.trim() || presets[i].icon;
    });
    presets.forEach((pr, i) => {
      pr.types = [];
      document.querySelectorAll(`input[data-pi="${i}"][data-type]`).forEach(cb => {
        if (cb.checked) pr.types.push(cb.dataset.type);
      });
    });
    await _saveColPresets(presets);
    closeModal();
    showToast('Presets guardados ✓', 'success');
    renderKanban();
  });
}

/** «→ Próxima acción»: la tarea abierta propia con fecha más cercana del proyecto. */
function nextActionHTML(projectId) {
  const n = App._taskStats?.[projectId]?.next;
  return n ? `<div class="next-action" title="Próxima acción"><span aria-hidden="true">→</span> <span class="next-title">${esc(n.title)}</span>${n.due ? ` <span class="next-due">${esc(dueLabel(n.due))}</span>` : ''}</div>` : '';
}

/** Insignia «✓ 2/5» con el avance de tareas de un proyecto (rojo si hay vencidas). */
function taskPillHTML(projectId) {
  const t = App._taskStats?.[projectId];
  if (!t || !t.total) return '';
  const cls = t.late ? 'late' : t.done === t.total ? 'done' : '';
  return `<span class="task-pill ${cls}" title="${t.done} de ${t.total} tareas hechas${t.late ? ` · ${t.late} vencida(s)` : ''}">✓ ${t.done}/${t.total}</span>`;
}

function kanbanCardHTML(p, unreadCount = 0, activeSub = null, pendingAIs = 0) {
  // ── Compact mode ────────────────────────────────────────────
  if ((App.kanbanDensity || 'detailed') === 'compact') {
    const TYPE_EMOJI  = { Paper:'📄', Grant:'💰', Análisis:'📊', Dataset:'🗄', Proyecto:'◉', Presentación:'🎤', Curso:'🎓' };
    const PRIO_COLOR  = { Alta:'var(--red)', Media:'var(--amber)', Baja:'var(--green)' };
    const prioColor   = PRIO_COLOR[p.priority] || 'var(--text-3)';
    const daysSince   = p.updatedAt ? Math.floor((Date.now() - new Date(p.updatedAt)) / 86400000) : 0;
    const staleClass  = daysSince > 14 ? ' kanban-card-stale' : '';
    return `
      <div class="kanban-card compact${staleClass}" draggable="true" data-project-id="${p.id}"
           title="${esc(p.title)} · ${esc(p.type)} · ${esc(p.priority)}${p.deadline ? ' · ⏱ ' + formatDate(p.deadline) : ''}">
        <div class="kanban-compact-row">
          <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${prioColor}"></span>
          <span style="font-size:.82rem;flex-shrink:0;line-height:1">${TYPE_EMOJI[p.type] || '◉'}</span>
          <span class="kanban-card-title-text"
                data-inline-rename="${p.id}"
                data-inline-rename-value="${esc(p.title)}">${esc(p.title)}</span>
          ${p.paused ? `<span class="kanban-card-star" title="En pausa${p.pauseReason ? ': ' + esc(p.pauseReason) : ''}" role="img" aria-label="En pausa">⏸</span>` : ''}
          ${p.starred ? '<span class="kanban-card-star" title="Favorito" role="img" aria-label="Favorito">★</span>' : ''}
          ${unreadCount > 0
            ? `<span style="font-size:.55rem;font-family:var(--font-mono);color:var(--amber);
                           flex-shrink:0">◎${unreadCount}</span>` : ''}
          ${pendingAIs > 0
            ? `<span style="font-size:.55rem;color:var(--red);flex-shrink:0">⚑${pendingAIs}</span>` : ''}
          ${activeSub
            ? `<span style="font-size:.55rem;font-family:var(--font-mono);flex-shrink:0;
                           color:${SUB_COLOR_MAP[activeSub.status]||'var(--text-3)'}">📤</span>` : ''}
        </div>
      </div>`;
  }
  // ── Detailed mode (existing) ─────────────────────────────────
  const deadline = p.deadline
    ? `<span class="kanban-card-date">⏱ ${formatDate(p.deadline)}</span>` : '';
  const tags = (p.tags || []).slice(0,3).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const ideaBadge = unreadCount > 0
    ? `<span class="kanban-idea-badge" title="${unreadCount} idea(s) sin revisar">◎ ${unreadCount}</span>` : '';
  const daysSince = p.updatedAt
    ? Math.floor((Date.now() - new Date(p.updatedAt)) / 86400000) : 0;
  const staleClass = daysSince > 14 ? ' kanban-card-stale' : '';
  const staleTip   = daysSince > 14 ? ` title="Sin actividad hace ${daysSince} días"` : '';

  // Health badges
  const healthBadges = [];
  if (pendingAIs > 0)
    healthBadges.push(`<span style="font-size:.58rem;font-family:var(--font-mono);
      color:var(--red);background:rgba(248,113,113,.12);
      padding:1px 5px;border-radius:99px;border:1px solid rgba(248,113,113,.2)">⚑ ${pendingAIs}</span>`);
  if (activeSub) {
    const sc = SUB_COLOR_MAP[activeSub.status]   || 'var(--text-3)';
    const sl = SUB_SHORT_LABEL[activeSub.status] || activeSub.status;
    healthBadges.push(`<span style="font-size:.58rem;font-family:var(--font-mono);
      color:${sc};background:color-mix(in srgb,${sc} 12%,transparent);
      padding:1px 5px;border-radius:99px;border:1px solid color-mix(in srgb,${sc} 28%,transparent)">
      📤 ${sl}</span>`);
  }

  const badgesRow = [ideaBadge, taskPillHTML(p.id), ...healthBadges].filter(Boolean).join('');

  return `
    <div class="kanban-card${staleClass}" draggable="true" data-project-id="${p.id}"${staleTip}>
      <div class="kanban-card-title-text" data-inline-rename="${p.id}"
           data-inline-rename-value="${esc(p.title)}"
           title="Doble clic para renombrar">${p.paused ? '⏸ ' : ''}${esc(p.title)}</div>
      ${badgesRow ? `<div class="kanban-card-badges" style="display:flex;gap:3px;flex-wrap:wrap;align-items:center;margin-bottom:4px">${badgesRow}</div>` : ''}
      <div class="kanban-card-meta">
        <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
        ${p.priority && p.priority !== 'Media' ? `<span class="badge ${prioBadgeClass(p.priority)}" title="Prioridad ${esc(p.priority.toLowerCase())}">${esc(p.priority)}</span>` : ''}
        ${p.starred ? '<span class="kanban-card-star" title="Favorito" role="img" aria-label="Favorito">★</span>' : ''}
      </div>
      ${nextActionHTML(p.id)}
      <div class="kanban-card-footer">
        <span class="kanban-card-person">
          ${p.responsible
            ? _personChipHTML(p.responsible, p.responsibleId || null, { small: true })
            : '<span style="color:var(--text-3);font-size:.65rem;font-family:var(--font-mono)">—</span>'}
        </span>
        ${deadline}
      </div>
    </div>`;
}

// Drag & Drop
function kanbanDragStart(e) {
  App.draggedId    = +e.currentTarget.dataset.projectId;
  App._isDragging  = true;
  HoverCard.hide();
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function kanbanDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  App._isDragging = false;
}
/**
 * Mueve una tarjeta Kanban en el DOM sin reconstruir el tablero.
 * Actualiza contadores de columna y badges WIP.
 * Devuelve true si tuvo éxito, false si hay que hacer full-render.
 */
function _kanbanSurgicalMove(projectId, newColId) {
  const card     = document.querySelector(`.kanban-card[data-project-id="${projectId}"]`);
  const destList = document.querySelector(`#cards-${newColId}`);
  if (!card || !destList) return false;

  card.classList.remove('dragging');
  destList.appendChild(card);

  // Actualizar contadores de todas las columnas afectadas
  document.querySelectorAll('.kanban-col[data-col-id]').forEach(colEl => {
    const countEl = colEl.querySelector('.kanban-col-count');
    if (!countEl) return;
    const wip      = +colEl.dataset.colWip || null;
    const n        = colEl.querySelectorAll('.kanban-card').length;
    const exceeded = wip && n > wip;
    countEl.className = 'kanban-col-count' + (exceeded ? ' kanban-wip-exceeded' : '');
    countEl.textContent = n;
    if (wip) countEl.insertAdjacentHTML('beforeend',
      `<span class="kanban-wip-badge">/${wip}</span>`);
  });
  return true;
}
function kanbanDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const t = e.currentTarget.closest('[data-swim-col]')
       || e.currentTarget.closest('.kanban-col')
       || e.currentTarget.closest('.sub-pipe-col');
  t?.classList.add('drag-over');
}
function kanbanDragLeave(e) {
  const col = (e.currentTarget.classList.contains('kanban-col') ||
             e.currentTarget.classList.contains('sub-pipe-col'))
    ? e.currentTarget
    : e.currentTarget.closest('[data-swim-col]')
   || e.currentTarget.closest('.kanban-col')
   || e.currentTarget.closest('.sub-pipe-col');
  // Solo quitar la clase si el puntero salió completamente de la columna
  if (col && !col.contains(e.relatedTarget)) {
    col.classList.remove('drag-over');
  }
}
async function kanbanDrop(e) {
  e.preventDefault();
  const swimCell  = e.currentTarget.closest('[data-swim-col]');
  const kanbanCol = e.currentTarget.closest('.kanban-col');
  const target    = swimCell || kanbanCol;
  target?.classList.remove('drag-over');
  const newColId  = swimCell ? +swimCell.dataset.swimCol : +kanbanCol?.dataset.colId;
  const draggedId = App.draggedId;
  App.draggedId   = null;
  if (!draggedId || !newColId) return;
  try {
    const proj = await db.projects.get(draggedId);
    const oldColId = proj?.columnId;
    if (oldColId === newColId && !swimCell) { _kanbanSurgicalMove(draggedId, newColId); return; }   // misma columna: no es un movimiento
    const groupUpdates = {};

    if (swimCell && App.kanbanGroupBy === 'type') {
      const newType = swimCell.dataset.swimGroup;
      if (newType && newType !== 'Sin tipo') groupUpdates.type = newType;
    } else if (swimCell && App.kanbanGroupBy === 'area') {
      const groupName = swimCell.dataset.swimGroup;
      const areas     = await _getAreas();
      const area      = areas.find(a => a.name === groupName);
      groupUpdates.areaId = area ? area.id : null;
    }

    if (Object.keys(groupUpdates).length) {
      await dbWrite(() => db.projects.update(draggedId, {
        ...groupUpdates, updatedAt: new Date().toISOString()
      }));
    }
    await dbWrite(() => recordColumnChange(draggedId, newColId));

    // Registrar undo solo para movimientos simples de columna
    if (!Object.keys(groupUpdates).length && oldColId && oldColId !== newColId) {
      UndoStack.push({
        label: `Mover "${(proj?.title||'').slice(0,28)}"`,
        undo:  async () => { await dbWrite(() => recordColumnChange(draggedId, oldColId)); }
      });
    }

    const canSurgical = App.kanbanGroupBy === 'none' && !Object.keys(groupUpdates).length;
    if (canSurgical && _kanbanSurgicalMove(draggedId, newColId)) {
      showToastWithUndo('Tarjeta movida', 'success');
    } else {
      await renderKanban();
      const msg = Object.keys(groupUpdates).length
        ? `Movida · ${App.kanbanGroupBy==='type'?`tipo → ${groupUpdates.type}`:'área actualizada'}`
        : 'Tarjeta movida';
      showToastWithUndo(msg, 'success');
    }
  } catch (err) {
    showToast('Error al mover tarjeta', 'error');
    console.error(err);
    renderKanban();
  }
}
// Expose drag handlers globally for inline ondragover/ondrop
window.kanbanDragOver  = kanbanDragOver;
window.kanbanDragLeave = kanbanDragLeave;
window.kanbanDrop      = kanbanDrop;

// ── DROP handler específico del pipeline de submission
// Reutiliza App.draggedId (seteado por kanbanDragStart) y _updatePipelineStage existente
async function subPipelineDrop(e) {
  e.preventDefault();
  const col    = e.currentTarget.closest('.sub-pipe-col');
  col?.classList.remove('drag-over');
  const newKey    = col?.dataset.subStage;
  const draggedId = App.draggedId;
  App.draggedId   = null;
  if (!draggedId || !newKey) return;
  const proj = await db.projects.get(draggedId);
  if (!proj || proj.type !== 'Paper') return;
  if ((proj.submissionStatus || DEFAULT_SUB_STAGES[0].key) === newKey) return;
  await _updatePipelineStage(draggedId, newKey);
}
window.subPipelineDrop = subPipelineDrop;

// -- Saved Views helpers (localStorage, sin BD) ---------------
function _getSavedViews() {
  try { return JSON.parse(localStorage.getItem('ros-saved-views') || '[]'); }
  catch { return []; }
}
function _saveSavedView(name, filters) {
  const views = _getSavedViews().filter(v => v.name !== name);
  views.push({ name, ...filters });
  localStorage.setItem('ros-saved-views', JSON.stringify(views.slice(-12)));
}
function _deleteSavedView(name) {
  const views = _getSavedViews().filter(v => v.name !== name);
  localStorage.setItem('ros-saved-views', JSON.stringify(views));
}
function _currentSavedView(v) {
  return App.filters.type === (v.type||'all') &&
         App.filters.priority === (v.priority||'all') &&
         App.filters.column === (v.column||'all');
}

// ── Inline editing para la vista tabla de Proyectos ─────────
function _attachTableInlineEditing(tableEl) {
  tableEl.querySelectorAll('.tbl-editable').forEach(cell => {
    cell.addEventListener('click', async e => {
      e.stopPropagation();
      if (cell.querySelector('input, select')) return; // ya editando

      const projId   = +cell.dataset.projId;
      const cellType = cell.dataset.cellType;
      const curVal   = cell.dataset.cellVal || '';
      const orig     = cell.innerHTML;
      let input;

      if (cellType === 'priority') {
        input = document.createElement('select');
        input.style.cssText =
          'font-size:.75rem;padding:3px 5px;background:var(--bg-elevated);' +
          'border:1px solid var(--accent);border-radius:var(--radius-sm);' +
          'color:var(--text-1);width:92px';
        ['Alta','Media','Baja'].forEach(v => {
          const o = document.createElement('option');
          o.value = v; o.textContent = v;
          if (v === curVal) o.selected = true;
          input.appendChild(o);
        });
      } else if (cellType === 'deadline') {
        input = document.createElement('input');
        input.type  = 'date';
        input.value = curVal;
        input.style.cssText =
          'font-size:.72rem;padding:3px 5px;background:var(--bg-elevated);' +
          'border:1px solid var(--accent);border-radius:var(--radius-sm);' +
          'color:var(--text-1);font-family:var(--font-mono);width:145px';
      } else {
        input = document.createElement('input');
        input.type  = 'text';
        input.value = curVal;
        input.style.cssText =
          'font-size:.75rem;padding:3px 5px;background:var(--bg-elevated);' +
          'border:1px solid var(--accent);border-radius:var(--radius-sm);' +
          'color:var(--text-1);width:128px';
        setTimeout(() => _attachCollaboratorAutocomplete(input), 30);
      }

      cell.innerHTML = '';
      cell.appendChild(input);
      input.focus();
      if (input.select && cellType !== 'deadline') input.select();

      const commit = async () => {
        const nv = input.value.trim();
        // Para deadline: siempre guardar (puede ser vacío = borrar)
        if (cellType !== 'deadline' && nv === curVal) { cell.innerHTML = orig; return; }
        const upd = { updatedAt: new Date().toISOString() };
        if (cellType === 'priority')    upd.priority      = nv || null;
        if (cellType === 'deadline')    upd.deadline      = nv || null;
        if (cellType === 'responsible') {
          upd.responsible   = nv;
          upd.responsibleId = _getPersonId(input) || null;
        }
        await dbWrite(() => db.projects.update(projId, upd));
        showToast('Actualizado ✓', 'success');
        App._projScrollRestore = mainContent.scrollTop;
        App._projDataOnly = true;   // ← refresh solo datos, sin blanquear la vista
        renderView('projects');
      };

      input.addEventListener('blur',    commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.stopPropagation(); cell.innerHTML = orig; }
      });
    });
  });
}

// ==============================================================
//  VIEW: PROJECTS
// ==============================================================
async function renderProjects() {
  const _dataOnly = App._projDataOnly;
  App._projDataOnly = false;

  let allProjects = await db.projects.toArray();
  const cols      = await db.kanbanColumns.toArray();
  const colMap    = Object.fromEntries(cols.map(c => [c.id, c]));
  const f         = App.filters;
  App._taskStats  = await Tasks.statsByProject();     // para la insignia «✓ n/m» de cada tarjeta

  // Apply compound filters
  let projects = allProjects.filter(p =>
    (f.type     === 'all' || p.type     === f.type) &&
    (f.priority === 'all' || p.priority === f.priority) &&
    (f.column   === 'all' || p.columnId === +f.column) &&
    (App.filterResponsible === 'all' || (p.responsible || '') === App.filterResponsible) &&
    (App.filterArea        === 'all' || p.areaId === +App.filterArea) &&
    inContext(p)
  );
  App._filteredProjectIds = projects.map(p => p.id);     // "Seleccionar todos" actúa solo sobre lo filtrado

  const types        = ['all','Proyecto','Grant','Paper','Análisis','Dataset','Presentación','Curso'];
  const prios        = ['all','Alta','Media','Baja'];
  const responsables = [...new Set(allProjects.map(p => p.responsible).filter(Boolean))].sort();
  const hasActiveFilters = f.type !== 'all' || f.priority !== 'all' || f.column !== 'all' ||
                           App.filterResponsible !== 'all' || App.filterArea !== 'all';

  const activePills = [];
  if (f.type             !== 'all') activePills.push({ key:'type',        label:`Tipo: ${f.type}` });
  if (f.priority         !== 'all') activePills.push({ key:'priority',    label:`Prioridad: ${f.priority}` });
  if (f.column           !== 'all') activePills.push({ key:'column',      label:`Columna: ${colMap[+f.column]?.title || f.column}` });
  if (App.filterResponsible !== 'all') activePills.push({ key:'responsible', label:`Responsable: ${App.filterResponsible}` });

  const _areasCache = await _getAreas();   // una sola lectura, reutilizada abajo
  if (App.filterArea !== 'all') {
    const _area = _areasCache.find(a => a.id === +App.filterArea);
    activePills.push({ key:'area', label:`Área: ${_area?.name || App.filterArea}` });
  }

  if (!_dataOnly) {
  mainContent.innerHTML = '';   // limpiar DESPUÉS del fetch → no hay frame en blanco
  mainContent.insertAdjacentHTML('beforeend', `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Proyectos</div>
          <div class="view-subtitle">${projects.length} de ${allProjects.length} proyecto(s)</div>
        </div>
        <!-- Vistas guardadas -->
        ${(() => {
          const saved = _getSavedViews();
          if (!saved.length) return '';
          return `<div class="saved-views-bar">
            <span style="font-size:.65rem;color:var(--text-3);font-family:var(--font-mono)">Vistas:</span>
            ${saved.map(v => `
              <button class="saved-view-chip ${_currentSavedView(v) ? 'active' : ''}"
                      data-load-view="${encodeURIComponent(JSON.stringify(v))}">
                ${esc(v.name)}
                <span class="saved-view-del" data-del-view="${esc(v.name)}">✕</span>
              </button>`).join('')}
          </div>`;
        })()}
        <div style="display:flex;gap:8px;align-items:center">
          <div class="view-toggle-group">
            <button class="view-toggle-btn ${App.projViewMode==='grid'?'active':''}"
                    id="viewModeGrid" title="Vista cuadrícula">⊞</button>
            <button class="view-toggle-btn ${App.projViewMode==='list'?'active':''}"
                    id="viewModeList" title="Vista lista / tabla">☰</button>
          </div>
          <button class="btn btn-ghost" id="bulkToggleBtn"
            style="color:${App.bulkMode ? 'var(--accent)' : 'var(--text-2)'}">
            ${App.bulkMode ? '✕ Cancelar selección' : '⊞ Seleccionar'}
          </button>
          <button class="btn btn-ghost btn-sm" id="saveViewBtn" title="Guardar filtro actual como vista">⊞ Guardar vista</button>
          <button class="btn btn-primary" id="projAddBtn">+ Nuevo Proyecto</button>
        </div>
      </div>

      <details class="filters-fold" id="filtersFold" ${hasActiveFilters || localStorage.getItem('ros-proj-filters-open') === '1' ? 'open' : ''}>
      <summary>Filtros y agrupación${hasActiveFilters ? ` <span class="filters-on">${activePills.length} activo${activePills.length !== 1 ? 's' : ''}</span>` : ''}</summary>
      <div class="cross-filter-bar">
        <div class="cross-filter-group">
          <div class="cross-filter-label">Tipo</div>
          <div class="cross-filter-chips">
            ${types.map(t => `<button class="filter-chip ${f.type===t?'active':''}" data-ftype="${t}">${t==='all'?'Todos':t}</button>`).join('')}
          </div>
        </div>
        <div class="cross-filter-group">
          <div class="cross-filter-label">Prioridad</div>
          <div class="cross-filter-chips">
            ${prios.map(pr => `<button class="filter-chip ${f.priority===pr?'active':''}${pr!=='all'?' prio-'+pr.toLowerCase():''}" data-fprio="${pr}">${pr==='all'?'Todas':pr}</button>`).join('')}
          </div>
        </div>
        <div class="cross-filter-group">
          <div class="cross-filter-label">Columna Kanban</div>
          <div class="cross-filter-chips">
            <button class="filter-chip ${f.column==='all'?'active':''}" data-fcol="all">Todas</button>
            ${cols.map(c => `<button class="filter-chip ${f.column==c.id?'active':''}" data-fcol="${c.id}">${esc(c.title)}</button>`).join('')}
          </div>
        </div>
        <div class="cross-filter-group">
          <div class="cross-filter-label">Responsable</div>
          <div class="cross-filter-chips">
            <button class="filter-chip ${App.filterResponsible==='all'?'active':''}" data-fresp="all">Todos</button>
            ${responsables.map(r => `<button class="filter-chip ${App.filterResponsible===r?'active':''}" data-fresp="${esc(r)}">${esc(r)}</button>`).join('')}
          </div>
        </div>
        <div class="cross-filter-group">
          <div class="cross-filter-label">Agrupar por</div>
          <div class="cross-filter-chips">
            <select class="form-select" id="groupBySelect" aria-label="Agrupar proyectos por" style="font-size:.73rem;padding:4px 10px;height:auto">
              <option value="none"        ${App.groupBy==='none'        ?'selected':''}>Sin agrupación</option>
              <option value="type"        ${App.groupBy==='type'        ?'selected':''}>Tipo</option>
              <option value="priority"    ${App.groupBy==='priority'    ?'selected':''}>Prioridad</option>
              <option value="column"      ${App.groupBy==='column'      ?'selected':''}>Columna</option>
              <option value="responsible" ${App.groupBy==='responsible' ?'selected':''}>Responsable</option>
              <option value="area"        ${App.groupBy==='area'        ?'selected':''}>Área</option>
            </select>
          </div>
        </div>
        ${hasActiveFilters ? `<button class="btn btn-ghost btn-sm" id="clearFiltersBtn" style="align-self:flex-end">✕ Limpiar filtros</button>` : ''}
      </div>
      </details>

      ${activePills.length ? `<div class="active-filters-row">
        ${activePills.map(p => `<span class="active-filter-pill" data-clear-filter="${p.key}">${esc(p.label)} ✕</span>`).join('')}
      </div>` : ''}

      <div id="projectsContainer">
        <div style="text-align:center;padding:20px;color:var(--text-3);font-size:.8rem">
          Calculando métricas…
        </div>
      </div>
    </div>`);

  $('projAddBtn').addEventListener('click', () => showAddProjectModal());
  $('filtersFold')?.addEventListener('toggle', e => { try { localStorage.setItem('ros-proj-filters-open', e.target.open ? '1' : '0'); } catch {} });
  $('viewModeGrid')?.addEventListener('click', () => {
    App.projViewMode = 'grid';
    localStorage.setItem('ros-proj-view-mode', 'grid');
    renderView('projects');
  });
  $('viewModeList')?.addEventListener('click', () => {
    App.projViewMode = 'list';
    localStorage.setItem('ros-proj-view-mode', 'list');
    renderView('projects');
  });
  $('saveViewBtn')?.addEventListener('click', async () => {
    const name = await askText('Guardar esta vista de filtros', { placeholder: 'p. ej. Papers de prioridad alta', message: 'Ponle un nombre para volver a ella con un clic.' });
    if (!name) return;
    _saveSavedView(name.trim(), { ...App.filters });
    showToast(`Vista "${name}" guardada ✓`, 'success');
    renderView('projects');
  });
  mainContent.querySelectorAll('[data-load-view]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('[data-del-view]')) return;
      const v = JSON.parse(decodeURIComponent(btn.dataset.loadView));
      App.filters = { type: v.type||'all', priority: v.priority||'all', column: v.column||'all' };
      renderView('projects');
    });
  });
  mainContent.querySelectorAll('[data-del-view]').forEach(span => {
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      _deleteSavedView(span.dataset.delView);
      renderView('projects');
    });
  });
  $('clearFiltersBtn')?.addEventListener('click', () => {
    App.filters = { type:'all', priority:'all', column:'all' };
    App.filterResponsible = 'all';
    App.filterArea = 'all';
    App.groupBy = 'none';
    App.projSortKey = '';
    App.projSortDir = 'asc';
    App._projPage = 1;
    renderView('projects');
  });
  mainContent.querySelectorAll('[data-ftype]').forEach(btn => {
    btn.addEventListener('click', () => { App.filters.type = btn.dataset.ftype; App._projPage = 1; renderView('projects'); });
  });
  mainContent.querySelectorAll('[data-fprio]').forEach(btn => {
    btn.addEventListener('click', () => { App.filters.priority = btn.dataset.fprio; App._projPage = 1; renderView('projects'); });
  });
  mainContent.querySelectorAll('[data-fcol]').forEach(btn => {
    btn.addEventListener('click', () => { App.filters.column = btn.dataset.fcol; App._projPage = 1; renderView('projects'); });
  });
  mainContent.querySelectorAll('[data-clear-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
      if (pill.dataset.clearFilter === 'responsible') App.filterResponsible = 'all';
      else if (pill.dataset.clearFilter === 'area')   App.filterArea = 'all';
      else App.filters[pill.dataset.clearFilter] = 'all';
      App._projPage = 1;
      renderView('projects');
    });
  });

  // -- Responsable + Agrupación ---------------------------
  mainContent.querySelectorAll('[data-fresp]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.filterResponsible = btn.dataset.fresp; App._projPage = 1; renderView('projects');
    });
  });
  $('groupBySelect')?.addEventListener('change', e => {
    App.groupBy = e.target.value; App._projPage = 1; renderView('projects');
  });

  // -- Panel de alertas --------------------------------
  } // fin if (!_dataOnly)

  // Async: compute completeness for each card then render
  (async () => {
    const container = $('projectsContainer');
    if (!container) return;
    // Para bulk mode seguimos necesitando un ref al grid
    const grid = container;
    if (!projects.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <span class="empty-state-icon">◉</span>
        <h3>Sin proyectos</h3>
        <p>Prueba cambiando los filtros activos</p></div>`;
      return;
    }

    // -- Datos auxiliares: unread, áreas, hijos (rollup) ---
    const [unreadIdeas] = await Promise.all([
      db.ideas.where('status').equals('unread').toArray(),
    ]);
    const areas = _areasCache;   // reutilizar el fetch ya realizado

    // Estado de submission derivado directamente del proyecto (Papers)
    const activeSubForTable = {};
    projects.forEach(p => {
      if (p.submissionStatus)
        activeSubForTable[p.id] = {
          status:      p.submissionStatus,
          targetVenue: p.targetVenue || '',
          updatedAt:   p.updatedAt,
        };
    });
    const areaMap   = Object.fromEntries(areas.map(a => [a.id, a]));
    const unreadMap = {};
    unreadIdeas.forEach(i => { if (i.projectId) unreadMap[i.projectId] = (unreadMap[i.projectId]||0)+1; });
    const allActive = await db.projects.filter(p => !p.archived).toArray();
    const childMap  = {};
    allActive.filter(p => p.parentId).forEach(p => {
      if (!childMap[p.parentId]) childMap[p.parentId] = [];
      childMap[p.parentId].push(p);
    });

    const nowMs      = Date.now();
    const isZombie   = p => isIdle(p);     // sin movimiento; no cuenta lo que espera respuesta ni lo terminado
    const getRollup  = pid => {
      const ch = childMap[pid] || [];
      if (!ch.length) return null;
      const unread   = ch.reduce((s, c) => s + (unreadMap[c.id]||0), 0);
      const nearest  = ch.filter(c => c.deadline).map(c => c.deadline).sort()[0] || null;
      return { count: ch.length, unread, nearest };
    };
    const getGroupKey = p => {
      if (App.groupBy === 'type')        return p.type        || 'Sin tipo';
      if (App.groupBy === 'priority')    return p.priority    || 'Sin prioridad';
      if (App.groupBy === 'column')      return colMap[p.columnId]?.title || 'Sin columna';
      if (App.groupBy === 'responsible') return p.responsible || 'Sin responsable';
      if (App.groupBy === 'area')        return areaMap[p.areaId]?.name   || 'Sin área';
      return 'all';
    };

    // -- Paginación -----------------------------------------
    const PAGE_SIZE  = 25;
    const filterKey  = JSON.stringify([App.filters, App.filterResponsible, App.groupBy]);
    if (App._lastFilterKey !== filterKey) { App._projPage = 1; App._lastFilterKey = filterKey; }
    const totalFiltered = projects.length;
    const visible       = projects.slice(0, App._projPage * PAGE_SIZE);

    const renderCard = async p => {
      const pct    = projectCompleteness(p);
      const zombie = isZombie(p);
      const area   = p.areaId ? areaMap[p.areaId] : null;
      const rollup = getRollup(p.id);
      return projectCardHTML(p, colMap[p.columnId], pct, zombie, area, rollup);
    };

    if (App.projViewMode === 'list') {

      // Ordenar según estado de sort
      if (App.projSortKey) {
        const PRIO = { Alta: 0, Media: 1, Baja: 2 };
        visible.sort((a, b) => {
          let cmp = 0;
          switch (App.projSortKey) {
            case 'title':       cmp = (a.title||'').localeCompare(b.title||''); break;
            case 'type':        cmp = (a.type||'').localeCompare(b.type||''); break;
            case 'priority':    cmp = (PRIO[a.priority]??99) - (PRIO[b.priority]??99); break;
            case 'column':      cmp = (colMap[a.columnId]?.title||'').localeCompare(colMap[b.columnId]?.title||''); break;
            case 'responsible': cmp = (a.responsible||'').localeCompare(b.responsible||''); break;
            case 'area':        cmp = (areaMap[a.areaId]?.name||'').localeCompare(areaMap[b.areaId]?.name||''); break;
            case 'deadline':    cmp = (a.deadline||'9999').localeCompare(b.deadline||'9999'); break;
          }
          return App.projSortDir === 'desc' ? -cmp : cmp;
        });
      }

      // -- VISTA TABLA --------------------------------------
      const rows = await Promise.all(visible.map(async p => {
        const pct     = projectCompleteness(p);
        const zombie  = isZombie(p);
        const area    = p.areaId ? areaMap[p.areaId] : null;
        const rollup  = getRollup(p.id);
        const col     = colMap[p.columnId];
        const today   = new Date(); today.setHours(0,0,0,0);
        const daysLeft = p.deadline
          ? Math.round((new Date(p.deadline + 'T00:00:00') - today) / 86400000) : null;
        const dlColor  = daysLeft === null ? 'var(--text-3)'
          : daysLeft < 0 ? 'var(--red)' : daysLeft <= 7 ? 'var(--amber)' : 'var(--text-2)';
        return `
          <tr class="proj-table-row ${zombie?'proj-table-zombie':''}"
              data-inspect-project="${p.id}">
            <td class="ptd ptd-title">
              ${p.starred ? '<span style="color:var(--amber);margin-right:4px">★</span>' : ''}
              ${esc(p.title)}
              ${rollup ? `<span class="rollup-badge" style="vertical-align:middle;margin-left:4px">⊕${rollup.count}</span>` : ''}
              ${zombie ? `<span class="zombie-badge" style="vertical-align:middle;margin-left:4px">quieto</span>` : ''}
            </td>
            <td class="ptd"><span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span></td>
            <td class="ptd tbl-editable"
                data-cell-type="priority"
                data-proj-id="${p.id}"
                data-cell-val="${esc(p.priority||'')}"
                title="Clic para editar prioridad">
              <span class="badge ${prioBadgeClass(p.priority)}">${esc(p.priority||'—')}</span>
            </td>
            <td class="ptd" style="color:var(--text-2);font-size:.74rem">
              ${(() => {
                if (p.type === 'Paper' && activeSubForTable[p.id]) {
                  const s  = activeSubForTable[p.id];
                  const sc = SUB_COLOR_MAP[s.status] || 'var(--text-3)';
                  return `<span style="font-family:var(--font-mono);font-size:.62rem;
                    color:${sc};background:color-mix(in srgb,${sc} 12%,transparent);
                    border:1px solid color-mix(in srgb,${sc} 28%,transparent);
                    padding:1px 6px;border-radius:99px">
                    📤 ${SUB_SHORT_LABEL[s.status] || s.status}
                  </span>`;
                }
                return esc(col?.title || '—');
              })()}
            </td>
            <td class="ptd tbl-editable"
                data-cell-type="responsible"
                data-proj-id="${p.id}"
                data-cell-val="${esc(p.responsible||'')}"
                title="Clic para editar responsable"
                style="color:var(--text-2);font-size:.74rem">${esc(p.responsible||'—')}</td>
            ${area
              ? `<td class="ptd"><span class="area-chip" style="border-color:${cssColor(area.color)};color:${cssColor(area.color)}">⊡ ${esc(area.name)}</span></td>`
              : `<td class="ptd" style="color:var(--text-3);font-size:.72rem">—</td>`}
            <td class="ptd tbl-editable"
                data-cell-type="deadline"
                data-proj-id="${p.id}"
                data-cell-val="${esc(p.deadline||'')}"
                title="Clic para editar deadline"
                style="color:${dlColor};font-family:var(--font-mono);font-size:.72rem">
              ${p.deadline ? formatDate(p.deadline) : '—'}
              ${daysLeft !== null ? `<span style="font-size:.62rem">(${daysLeft < 0 ? 'vencido' : daysLeft+'d'})</span>` : ''}
            </td>
            <td class="ptd">
              <div class="ptd-pct-bar">
                <div style="width:${pct}%;height:100%;background:${pct>=80?'var(--green)':pct>=50?'var(--amber)':'var(--red)'};border-radius:99px"></div>
              </div>
              <span style="font-size:.6rem;font-family:var(--font-mono);color:var(--text-3)">${pct}%</span>
            </td>
          </tr>`;
      }));
      const _si = k => App.projSortKey === k ? (App.projSortDir === 'asc' ? ' ↑' : ' ↓') : '';
      container.innerHTML = `
        <table class="proj-table">
          <thead>
            <tr>
              <th class="pth" data-sk="title"       style="cursor:pointer;user-select:none">Título${_si('title')}</th>
              <th class="pth" data-sk="type"        style="cursor:pointer;user-select:none">Tipo${_si('type')}</th>
              <th class="pth" data-sk="priority"    style="cursor:pointer;user-select:none">Prioridad${_si('priority')}</th>
              <th class="pth" data-sk="column"      style="cursor:pointer;user-select:none">Columna${_si('column')}</th>
              <th class="pth" data-sk="responsible" style="cursor:pointer;user-select:none">Responsable${_si('responsible')}</th>
              <th class="pth" data-sk="area"        style="cursor:pointer;user-select:none">Área${_si('area')}</th>
              <th class="pth" data-sk="deadline"    style="cursor:pointer;user-select:none">Deadline${_si('deadline')}</th>
              <th class="pth">Completitud</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
        </table>`;

      // Listeners de ordenación
      container.querySelectorAll('th[data-sk]').forEach(th => {
        th.addEventListener('click', () => {
          App._projScrollRestore = mainContent.scrollTop;
          const key = th.dataset.sk;
          if (App.projSortKey === key) {
            App.projSortDir = App.projSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            App.projSortKey = key;
            App.projSortDir = 'asc';
          }
          App._projPage = 1;
          App._projDataOnly = true;   // ← refresh solo datos, sin blanquear la vista
          renderView('projects');
        });
      });

      _attachTableInlineEditing(container);
    } else if (App.groupBy === 'none') {
      const cards = await Promise.all(visible.map(renderCard));
      container.className = 'projects-grid';
      container.innerHTML = cards.join('');
    } else {
      container.className = '';
      const groups = new Map();
      for (const p of visible) {
        const key = getGroupKey(p);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      const sections = [];
      for (const [key, grp] of groups) {
        const cards = await Promise.all(grp.map(renderCard));
        sections.push(`
          <div class="proj-group">
            <div class="proj-group-header">
              <span>${esc(key)}</span>
              <span class="proj-group-count">${grp.length}</span>
            </div>
            <div class="proj-group-body">${cards.join('')}</div>
          </div>`);
      }
      container.innerHTML = sections.join('');
    }

    // -- "Cargar más" --------------------------------------
    if (totalFiltered > App._projPage * PAGE_SIZE) {
      container.insertAdjacentHTML('beforeend', `
        <div style="grid-column:1/-1;text-align:center;padding:12px 0">
          <button class="btn btn-ghost" id="loadMoreProj">
            ▼ Cargar más · ${totalFiltered - App._projPage * PAGE_SIZE} restante(s)
          </button>
        </div>`);
      $('loadMoreProj')?.addEventListener('click', () => { App._projPage++; renderView('projects'); });
    }
    container.querySelectorAll('[data-inspect-project]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (App.bulkMode) return;
        inspectProject(+el.dataset.inspectProject);
      });
    });

    // -- Bulk Actions Bar (insertar al final de renderProjects) ----
    $('bulkToggleBtn')?.addEventListener('click', () => {
      App.bulkMode = !App.bulkMode;
      App.bulkSelected.clear();
      renderView('projects');
    });

    if (App.bulkMode) {
      $('bulkBar')?.remove();
      const bulkBar = document.createElement('div');
      bulkBar.id = 'bulkBar';
      bulkBar.style.cssText = `
        position:sticky; bottom:16px; left:0; right:0; margin:16px 0 0;
        background:var(--bg-card); border:1px solid var(--accent);
        border-radius:var(--radius-lg); padding:10px 16px;
        display:flex; align-items:center; gap:10px;
        box-shadow:0 4px 24px rgba(0,0,0,.4); z-index:50;
      `;
      bulkBar.innerHTML = `
        <span id="bulkCount" style="font-size:.78rem;color:var(--text-2);
              font-family:var(--font-mono);min-width:80px">
          0 seleccionados
        </span>
        <button class="btn btn-ghost btn-sm" id="bkSelectAll">Selec. todos</button>
        <div style="flex:1"></div>
        <button class="btn btn-ghost btn-sm" id="bkMoveCol">⬡ Mover columna</button>
        <button class="btn btn-ghost btn-sm" id="bkPrio">⚑ Prioridad</button>
        <button class="btn btn-ghost btn-sm" id="bkArchive">⊟ Archivar</button>
        <button class="btn btn-ghost btn-sm" id="bkStar">★ Favorito</button>
        <button class="btn btn-ghost btn-sm" id="bkDelete"
          style="color:var(--red)">✕ Eliminar</button>
      `;
      mainContent.querySelector('.view').appendChild(bulkBar);

      const updateBulkCount = () => {
        const el = $('bulkCount');
        if (el) el.textContent = `${App.bulkSelected.size} seleccionados`;
      };

      // Poner checkboxes en las tarjetas ya renderizadas
      const patchCards = () => {
        mainContent.querySelectorAll('[data-inspect-project]').forEach(card => {
          const pid = +card.dataset.inspectProject;
          if (card.querySelector('.bulk-check')) return;
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'bulk-check';
          cb.checked = App.bulkSelected.has(pid);
          cb.style.cssText = 'position:absolute;top:10px;left:10px;accent-color:var(--accent);width:16px;height:16px;cursor:pointer;z-index:5';
          card.style.position = 'relative';
          card.prepend(cb);
          cb.addEventListener('change', (e) => {
            e.stopPropagation();
            if (cb.checked) App.bulkSelected.add(pid);
            else App.bulkSelected.delete(pid);
            updateBulkCount();
          });
          // En modo bulk, click en la tarjeta = toggle checkbox
          card.addEventListener('click', (e) => {
            if (!e.target.closest('.bulk-check') && App.bulkMode) {
              cb.checked = !cb.checked;
              cb.dispatchEvent(new Event('change'));
            }
          }, { once: false });
        });
      };

      // Observar cuando el grid async se puebla
      const gcont = $('projectsContainer');
      if (gcont) {
        const mo = new MutationObserver(patchCards);
        mo.observe(gcont, { childList: true, subtree: true });
        patchCards();
      }

      $('bkSelectAll')?.addEventListener('click', async () => {
        (App._filteredProjectIds || []).forEach(id => App.bulkSelected.add(id));
        mainContent.querySelectorAll('.bulk-check').forEach(cb => cb.checked = true);
        updateBulkCount();
      });

      $('bkArchive')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        await dbWrite(() => db.projects.where('id').anyOf([...App.bulkSelected]).modify({ archived: true, updatedAt: new Date().toISOString() }));
        showToast(`${App.bulkSelected.size} proyectos archivados`, 'success');
        App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
      });

      $('bkStar')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        await dbWrite(() => db.projects.where('id').anyOf([...App.bulkSelected]).modify({ starred: true, updatedAt: new Date().toISOString() }));
        showToast(`${App.bulkSelected.size} marcados como favorito`, 'success');
        App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
      });

      $('bkDelete')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        if (!(await askConfirm(`Se eliminarán ${App.bulkSelected.size} proyectos (con «Deshacer» podrás recuperarlos unos segundos).`, { title: `¿Eliminar ${App.bulkSelected.size} proyectos?`, confirmLabel: 'Eliminar', danger: true }))) return;
        const n = App.bulkSelected.size;
        const undos = [];
        await dbWrite(async () => { for (const pid of [...App.bulkSelected]) undos.push(await deleteProjectCascade(pid)); });
        UndoStack.push({
          label: `Eliminar ${n} proyectos`,
          undo: async () => { await dbWrite(async () => { for (const u of undos.reverse()) await u(); }); }
        });
        showToastWithUndo(`${n} proyectos eliminados`, 'success');
        App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
      });

      $('bkMoveCol')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        const cols = await db.kanbanColumns.orderBy('order').toArray();
        showModal('Mover a columna', `
          <div class="modal-body">
            <select class="form-select" id="bkColSel">
              ${cols.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}
            </select>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="bkColCancel">Cancelar</button>
            <button class="btn btn-primary" id="bkColOk">Mover</button>
          </div>`);
        $('bkColCancel').addEventListener('click', closeModal);
        $('bkColOk').addEventListener('click', async () => {
          const colId = +$('bkColSel').value;
          await dbWrite(async () => { for (const pid of [...App.bulkSelected]) await recordColumnChange(pid, colId); });
          closeModal();
          showToast(`${App.bulkSelected.size} proyectos movidos`, 'success');
          App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
        });
      });

      $('bkPrio')?.addEventListener('click', async () => {
        if (!App.bulkSelected.size) return showToast('Selecciona al menos un proyecto', 'error');
        showModal('Cambiar prioridad', `
          <div class="modal-body">
            <select class="form-select" id="bkPrioSel">
              ${['Alta','Media','Baja'].map(p => `<option>${p}</option>`).join('')}
            </select>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="bkPrioCancel">Cancelar</button>
            <button class="btn btn-primary" id="bkPrioOk">Aplicar</button>
          </div>`);
        $('bkPrioCancel').addEventListener('click', closeModal);
        $('bkPrioOk').addEventListener('click', async () => {
          const prio = $('bkPrioSel').value;
          await dbWrite(() => db.projects.where('id').anyOf([...App.bulkSelected]).modify({ priority: prio, updatedAt: new Date().toISOString() }));
          closeModal();
          showToast(`Prioridad actualizada en ${App.bulkSelected.size} proyectos`, 'success');
          App.bulkSelected.clear(); App.bulkMode = false; renderView('projects');
        });
      });
    }
    // Restaurar posición de scroll tras reordenar tabla o edición inline
    if (App._projScrollRestore !== undefined) {
      const _savedScroll = App._projScrollRestore;
      App._projScrollRestore = undefined;
      // Doble rAF: garantiza que el layout esté completo antes de restaurar
      requestAnimationFrame(() =>
        requestAnimationFrame(() => { mainContent.scrollTop = _savedScroll; })
      );
    }
  })();
}

function projectCardHTML(p, col, completeness = null, zombie = false, area = null, rollup = null) {
  const tags   = (p.tags || []).slice(0,4).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const starEl = p.starred
    ? `<span title="Favorito" style="color:var(--amber);margin-right:4px">★</span>` : '';
  const archEl = p.archived
    ? `<span class="badge" style="background:rgba(120,120,120,.15);color:var(--text-3)">Archivado</span>` : '';
  return `
    <div class="card clickable" data-inspect-project="${p.id}">
      ${zombie ? `<span class="zombie-badge" title="Sin movimiento hace más de 30 días">⊘ quieto</span>` : ''}
      ${area   ? `<span class="area-chip" style="border-color:${cssColor(area.color)};color:${cssColor(area.color)}"
                        title="Área: ${esc(area.name)}">⊡ ${esc(area.name)}</span>` : ''}
      ${rollup ? `<span class="rollup-badge" title="${rollup.count} subproyecto(s)">
                    ⊕ ${rollup.count} sub${rollup.unread ? ` · ${rollup.unread} ◎` : ''}${rollup.nearest ? ` · ⏱ ${formatDate(rollup.nearest)}` : ''}
                  </span>` : ''}
      ${p.parentId ? `<div class="project-card-parent-label">↳ subproyecto</div>` : ''}
      <div class="project-card-header">
        <div class="project-card-title">${starEl}${esc(p.title)}</div>
        <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
          ${archEl}
          <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
        </div>
      </div>
      <div class="project-card-desc">${esc(plainPreview(p.description) || 'Sin descripción.')}</div>
      ${nextActionHTML(p.id)}
      ${tags ? `<div class="project-card-tags">${tags}</div>` : ''}
      ${completeness !== null ? completenessBarHTML(completeness) : ''}
      <div class="project-card-footer">
        <div>
          <div class="project-card-meta">👤 ${esc(p.responsible || '—')}</div>
          ${p.deadline ? `<div class="project-card-meta">⏱ ${formatDate(p.deadline)}</div>` : ''}
          ${taskPillHTML(p.id)}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <span class="badge ${prioBadgeClass(p.priority)}">${esc(p.priority)}</span>
          ${col ? `<span style="font-size:.65rem;color:var(--text-3);font-family:var(--font-mono)">⬡ ${esc(col.title)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ==============================================================
//  VIEW: IDEAS INBOX
// ==============================================================
const IDEAS_PAGE = 150;           // las bandejas enormes se pintan por tandas: 1 500 tarjetas tardaban ~3 s
async function renderIdeas() {
  const ideas    = await db.ideas.orderBy('createdAt').reverse().toArray();
  const ideasLimit = App._ideasLimit || IDEAS_PAGE;
  const projects = await db.projects.toArray();
  const projMap  = Object.fromEntries(projects.map(p => [p.id, p]));
  const stMap    = await Tasks.countsByIdea();

  const _draftTitle   = sessionStorage.getItem('ros-idea-draft-title')   || '';
  const _draftContent = sessionStorage.getItem('ros-idea-draft-content') || '';

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Ideas</div>
          <div class="view-subtitle">${ideas.filter(i=>i.status==='unread').length} sin revisar</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${ideas.filter(i=>i.status==='unread').length > 2
            ? `<button class="btn btn-primary btn-sm" id="startTriageBtn">◎ Revisión rápida (${ideas.filter(i=>i.status==='unread').length})</button>`
            : ''}
          <button class="btn btn-ghost btn-sm" id="ideaBulkToggle"
                  style="color:${App.ideaBulkMode?'var(--accent)':'var(--text-2)'}">
            ${App.ideaBulkMode ? '✕ Cancelar' : '⊞ Seleccionar'}
          </button>
        </div>
      </div>

      <!-- Quick capture -->
      <div class="inbox-capture">
        <div class="inbox-capture-title">⚡ Captura rápida</div>
        <input class="inbox-input" id="ideaTitleInput"
               placeholder="Título de la idea…" maxlength="200"
               value="${esc(_draftTitle)}">
        <textarea class="inbox-input inbox-textarea" id="ideaContentInput"
                  style="font-family:var(--font-mono);font-size:.82rem"
                  placeholder="Contenido en Markdown: **negrita**, \`código\`, - lista…">${esc(_draftContent)}</textarea>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start;margin-top:4px">
          <div style="flex:2;min-width:180px">
            <label class="form-label" style="display:block;margin-bottom:5px">Proyectos</label>
            ${_projectPickerHTML('quickCaptureProjs')}
          </div>
          <div style="flex:1;min-width:140px">
            <label class="form-label" style="display:block;margin-bottom:5px">Deadline</label>
            <input type="date" class="form-input" id="quickCaptureDeadline">
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px">
          <button class="btn btn-primary" id="saveIdeaBtn">Guardar</button>
        </div>
      </div>

      <!-- Panel de ecuaciones LaTeX -->
      <div class="inbox-capture" id="latexPanel" style="margin-top:0">
        <div class="inbox-capture-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>∑ Ecuaciones LaTeX</span>
          <button class="btn btn-ghost btn-sm" id="latexToggleBtn" style="font-size:.7rem">
            ${App._latexOpen ? '▲ Ocultar' : '▼ Mostrar'}
          </button>
        </div>
        ${App._latexOpen ? `
          <div style="display:flex;gap:8px;margin-bottom:8px">
            <textarea class="inbox-input inbox-textarea" id="latexInput"
              style="font-family:var(--font-mono);font-size:.8rem;min-height:64px"
              placeholder="Escribe LaTeX: \\frac{d}{dx} f(x) o $$E = mc^2$$"></textarea>
          </div>
          <div class="latex-preview" id="latexPreview"
            style="background:var(--bg-elevated);padding:12px;border-radius:var(--radius-md);
                   min-height:48px;font-size:1rem;color:var(--text-1);text-align:center">
            <span style="color:var(--text-3);font-size:.78rem">Vista previa aquí…</span>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\frac{a}{b}">Fracción</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\sum_{i=0}^{n} x_i">Suma</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\int_{a}^{b} f(x)\\,dx">Integral</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\sqrt{x^2 + y^2}">Raíz</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\lim_{x \\to \\infty}">Límite</button>
            <button class="btn btn-ghost btn-sm" data-latex-preset="\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}">Matriz</button>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button class="btn btn-primary btn-sm" id="latexSaveBtn">💾 Guardar como idea</button>
            <button class="btn btn-ghost btn-sm" id="latexCopyBtn">📋 Copiar</button>
          </div>
        ` : ''}
      </div>

      <!-- Bulk bar para ideas (visible solo en bulk mode) -->
      ${App.ideaBulkMode ? `
      <div id="ideaBulkBar" style="background:var(--bg-card);border:1px solid var(--accent);
           border-radius:var(--radius-lg);padding:10px 16px;margin-bottom:14px;
           display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span id="ideaBulkCount" style="font-family:var(--font-mono);font-size:.78rem;
              color:var(--text-2);min-width:80px">0 seleccionadas</span>
        <button class="btn btn-ghost btn-sm" id="ibSelectAll">Selec. todas</button>
        <div style="flex:1"></div>
        <button class="btn btn-ghost btn-sm" id="ibLink">⬡ Vincular proyecto</button>
        <button class="btn btn-ghost btn-sm" id="ibMarkReviewed">✓ Marcar revisadas</button>
        <button class="btn btn-danger btn-sm" id="ibDelete">✕ Eliminar</button>
      </div>` : ''}

      <!-- Ideas list -->
      <div class="ideas-list" id="ideasList">
        ${ideas.length ? ideas.slice(0, ideasLimit).map(i => {
          const proj = i.projectId ? projMap[i.projectId] : null;
          const stCount = stMap[i.id]?.total || 0;
          const stDone  = stMap[i.id]?.done  || 0;
          return `
            <div class="idea-item ${i.status==='unread'?'idea-unread':''}"
                 data-idea-id="${i.id}"
                 style="position:relative${App.ideaBulkMode?';cursor:pointer':''}"
                 ${App.ideaBulkMode?`data-bulk-idea="${i.id}"`:''}
            >
              ${App.ideaBulkMode ? `
                <input type="checkbox" class="idea-bulk-cb" data-idea-id="${i.id}"
                       ${App.ideaBulkSelected.has(i.id)?'checked':''}
                       style="position:absolute;top:12px;left:10px;
                              accent-color:var(--accent);width:16px;height:16px;
                              cursor:pointer;z-index:5"
                       onclick="event.stopPropagation()">
                <div style="margin-left:24px;flex:1;display:contents">
              ` : ''}
              <button class="idea-status-btn ${i.status==='reviewed'?'reviewed':''}"
                      data-idea-id="${i.id}" title="Marcar como revisada"></button>
              <div class="idea-body">
                <div class="idea-title">${esc(i.title)}</div>
                ${i.content ? `<div class="idea-content md-preview"
                  style="font-family:var(--font-mono);font-size:.73rem;
                         max-height:3.6em;overflow:hidden">${renderMd(String(i.content).slice(0, 360))}</div>` : ''}
                <div class="idea-footer">
                  ${(i.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}
                  ${(i.projectIds||[i.projectId]).filter(Boolean).map(pid=>{
                    const p=projMap[pid];
                    return p?`<span class="idea-linked" data-inspect-project="${pid}"
                      style="cursor:pointer" title="Ver proyecto">⬡ ${esc(p.title)}</span>`:'';
                  }).join('')}
                  ${stCount?`<span class="subtask-count-badge">${stDone}/${stCount} ✓</span>`:''}
                  <span style="font-size:.65rem;color:var(--text-3);font-family:var(--font-mono);
                               margin-left:auto">${relativeDate(i.createdAt)}</span>
                </div>
              </div>
              <button class="btn btn-ghost btn-sm idea-star-btn" data-idea-id="${i.id}"
                      title="${i.starred?'Quitar favorito':'Marcar favorito'}"
                      style="color:${i.starred?'var(--amber)':'var(--text-3)'}">${i.starred?'★':'☆'}</button>
              <button class="btn btn-ghost btn-sm idea-delete-btn" data-idea-id="${i.id}" title="Eliminar">✕</button>
              ${App.ideaBulkMode ? `</div>` : ''}
            </div>`;
        }).join('')
        : `<div class="empty-state"><span class="empty-state-icon">◎</span>
             <h3>Inbox vacío</h3><p>Captura tu primera idea arriba</p>
             <button class="btn btn-primary btn-sm" data-empty-cta="idea" style="margin-top:12px">Escribir una idea</button></div>`}
      </div>
      ${ideas.length > ideasLimit ? `<button class="btn btn-ghost" id="ideasMore" style="margin:12px auto 0;display:block">Mostrar ${Math.min(IDEAS_PAGE, ideas.length - ideasLimit)} más · quedan ${ideas.length - ideasLimit}</button>` : ''}
    </div>`;
  $('ideasMore')?.addEventListener('click', () => { const y = mainContent.scrollTop; App._ideasLimit = ideasLimit + IDEAS_PAGE; renderIdeas().then(() => { mainContent.scrollTop = y; }); });

  $('saveIdeaBtn').addEventListener('click', saveQuickIdea);
  $('ideaTitleInput').addEventListener('input', () =>
    sessionStorage.setItem('ros-idea-draft-title',   $('ideaTitleInput').value));
  $('ideaContentInput').addEventListener('input', () =>
    sessionStorage.setItem('ros-idea-draft-content', $('ideaContentInput').value));
  $('startTriageBtn')?.addEventListener('click', () => { App.triageIdx = 0; navigate('triage'); });
  $('ideaBulkToggle')?.addEventListener('click', () => {
    App.ideaBulkMode = !App.ideaBulkMode;
    App.ideaBulkSelected.clear();
    renderIdeas();
  });

  if (App.ideaBulkMode) {
    const updateIdeaBulkCount = () => {
      const el = $('ideaBulkCount');
      if (el) el.textContent = `${App.ideaBulkSelected.size} seleccionada${App.ideaBulkSelected.size!==1?'s':''}`;
    };

    mainContent.querySelectorAll('.idea-bulk-cb').forEach(cb => {
      cb.addEventListener('change', e => {
        e.stopPropagation();
        if (cb.checked) App.ideaBulkSelected.add(+cb.dataset.ideaId);
        else            App.ideaBulkSelected.delete(+cb.dataset.ideaId);
        updateIdeaBulkCount();
      });
    });

    // Click en fila en modo bulk = toggle checkbox
    mainContent.querySelectorAll('[data-bulk-idea]').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        const cb = row.querySelector('.idea-bulk-cb');
        if (!cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
    });

    $('ibSelectAll')?.addEventListener('click', () => {
      ideas.forEach(i => App.ideaBulkSelected.add(i.id));
      mainContent.querySelectorAll('.idea-bulk-cb').forEach(cb => cb.checked = true);
      updateIdeaBulkCount();
    });

    $('ibMarkReviewed')?.addEventListener('click', async () => {
      if (!App.ideaBulkSelected.size) return showToast('Selecciona ideas primero', 'error');
      const now = new Date().toISOString();
      await dbWrite(() =>
        db.ideas.where('id').anyOf([...App.ideaBulkSelected])
          .modify({ status: 'reviewed', updatedAt: now })
      );
      showToast(`${App.ideaBulkSelected.size} marcadas como revisadas ✓`, 'success');
      App.ideaBulkSelected.clear();
      App.ideaBulkMode = false;
      renderIdeas();
    });

    $('ibDelete')?.addEventListener('click', async () => {
      if (!App.ideaBulkSelected.size) return showToast('Selecciona ideas primero', 'error');
      const n = App.ideaBulkSelected.size;
      if (!(await askConfirm(`Se eliminarán ${n} idea(s) y sus tareas.`, { title: `¿Eliminar ${n} idea(s)?`, confirmLabel: 'Eliminar', danger: true }))) return;
      const restores = [];
      await dbWrite(async () => { for (const iid of [...App.ideaBulkSelected]) restores.push(await deleteIdeaCascade(iid)); });
      UndoStack.push({ label: `Eliminar ${n} ideas`, undo: async () => { await dbWrite(async () => { for (const r of restores.reverse()) await r(); }); } });
      showToastWithUndo(`${n} ideas eliminadas`, 'info');
      App.ideaBulkSelected.clear();
      App.ideaBulkMode = false;
      renderIdeas();
    });

    $('ibLink')?.addEventListener('click', async () => {
      if (!App.ideaBulkSelected.size) return showToast('Selecciona ideas primero', 'error');
      const _projs = await db.projects.toArray();
      showModal('Vincular a proyecto', `
        <div class="modal-body">
          <p style="font-size:.8rem;color:var(--text-2);margin-bottom:10px">
            Vincular <strong>${App.ideaBulkSelected.size}</strong> idea(s) al mismo proyecto:
          </p>
          <div class="form-group">
            <label class="form-label">Proyecto</label>
            <select class="form-select" id="ibProjSel">
              <option value="">— Elige un proyecto —</option>
              ${_projs.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="ibLinkCancel">Cancelar</button>
          <button class="btn btn-primary" id="ibLinkConfirm">Vincular</button>
        </div>`);
      $('ibLinkCancel').addEventListener('click', closeModal);
      $('ibLinkConfirm').addEventListener('click', async () => {
        const pid = +$('ibProjSel').value;
        if (!pid) { showToast('Elige un proyecto', 'error'); return; }
        const now = new Date().toISOString();
        await dbWrite(async () => {
          for (const ideaId of App.ideaBulkSelected) {
            const idea = await db.ideas.get(ideaId);
            const existingIds = idea.projectIds || (idea.projectId ? [idea.projectId] : []);
            if (!existingIds.includes(pid)) existingIds.push(pid);
            await db.ideas.update(ideaId, {
              projectId:  existingIds[0],
              projectIds: existingIds,
              updatedAt:  now
            });
          }
        });
        const n = App.ideaBulkSelected.size;
        closeModal();
        showToast(`${n} idea(s) vinculadas ✓`, 'success');
        App.ideaBulkSelected.clear();
        App.ideaBulkMode = false;
        renderIdeas();
      });
    });
  }

  $('ideaTitleInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveQuickIdea(); });

  _attachProjectPicker('quickCaptureProjs', projects);

  $('latexToggleBtn')?.addEventListener('click', () => {
    App._latexOpen = !App._latexOpen;
    renderView('ideas');
  });

  const latexInput = $('latexInput');
  const latexPreview = $('latexPreview');

  latexInput?.addEventListener('input', () => {
    if (!latexPreview) return;
    const val = latexInput.value.trim();
    latexPreview.innerHTML = val
      ? `\\[${val.replace(/^\$\$?|\$\$?$/g, '')}\\]`
      : '<span style="color:var(--text-3);font-size:.78rem">Vista previa aquí…</span>';
    if (val) renderLatex(latexPreview);
  });

  mainContent.querySelectorAll('[data-latex-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!latexInput) return;
      latexInput.value = btn.dataset.latexPreset;
      latexInput.dispatchEvent(new Event('input'));
    });
  });

  $('latexCopyBtn')?.addEventListener('click', () => {
    copyText(latexInput?.value || '', 'LaTeX copiado ✓');
  });

  $('latexSaveBtn')?.addEventListener('click', async () => {
    const latex = latexInput?.value.trim();
    if (!latex) return showToast('Escribe una ecuación primero', 'error');
    await dbWrite(() => db.ideas.add({
      title:     `Ecuación: ${latex.slice(0,40)}`,
      content:   `$$${latex}$$`,
      status:    'unread', projectId: null,
      tags:      ['latex', 'ecuación'],
      subtasks:  [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    showToast('Ecuación guardada como idea ✓', 'success');
    if (latexInput) latexInput.value = '';
    renderView('ideas');
  });

  mainContent.querySelectorAll('.idea-status-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = +btn.dataset.ideaId;
      const idea = await db.ideas.get(id);
      await dbWrite(() => db.ideas.update(id, {
        status: idea.status === 'reviewed' ? 'unread' : 'reviewed',
        updatedAt: new Date().toISOString()
      }));
      renderIdeas();
      updateBadges();
    });
  });

  mainContent.querySelectorAll('.idea-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.idea-linked[data-inspect-project]')) return;
      inspectIdea(+el.dataset.ideaId);
    });
  });
  mainContent.querySelectorAll('.idea-linked[data-inspect-project]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      inspectProject(+el.dataset.inspectProject);
    });
  });

  mainContent.querySelectorAll('.idea-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      {
        await deleteWithUndo('ideas', +btn.dataset.ideaId, 'Eliminar idea', 'Idea eliminada');
        renderIdeas();
        updateBadges();
      }
    });
  });

  mainContent.querySelectorAll('.idea-star-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idea = await db.ideas.get(+btn.dataset.ideaId);
      await db.ideas.update(+btn.dataset.ideaId, { starred: !idea.starred });
      renderIdeas();
      updateBadges();
    });
  });

  // -- renderizar LaTeX en ideas del listado -----------
  setTimeout(() => {
    const list = $('ideasList');
    if (list) renderLatex(list);
  }, 80);
}

function ideaItemHTML(idea, projMap, stMap = {}) {
  const proj = idea.projectId ? projMap[idea.projectId] : null;
  const stCount  = stMap[idea.id]?.total || 0;
  const stDone   = stMap[idea.id]?.done  || 0;
  return `
    <div class="idea-item ${idea.status === 'unread' ? 'idea-unread' : ''}" data-idea-id="${idea.id}">
      <button class="idea-status-btn ${idea.status === 'reviewed' ? 'reviewed' : ''}"
              data-idea-id="${idea.id}" title="Marcar como revisada"></button>
      <div class="idea-body">
        <div class="idea-title">${esc(idea.title)}</div>
        ${idea.content ? `<div class="idea-content md-preview"
        style="font-family:var(--font-mono);font-size:.73rem;
               max-height:3.6em;overflow:hidden">${renderMd(idea.content)}</div>` : ''}
        <div class="idea-footer">
          ${(idea.tags||[]).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
          ${(idea.projectIds||[idea.projectId]).filter(Boolean).map(pid => {
            const p = projMap[pid];
            return p ? `<span class="idea-linked" data-inspect-project="${pid}" style="cursor:pointer"
              title="Ver proyecto">⬡ ${esc(p.title)}</span>` : '';
          }).join('')}
          ${stCount ? `<span class="subtask-count-badge">${stDone}/${stCount} ✓</span>` : ''}
          <span style="font-size:.65rem;color:var(--text-3);font-family:var(--font-mono);margin-left:auto">${relativeDate(idea.createdAt)}</span>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm idea-star-btn" data-idea-id="${idea.id}"
              title="${idea.starred ? 'Quitar favorito' : 'Marcar favorito'}"
              style="color:${idea.starred ? 'var(--amber)' : 'var(--text-3)'}">${idea.starred ? '★' : '☆'}</button>
      <button class="btn btn-ghost btn-sm idea-delete-btn" data-idea-id="${idea.id}" title="Eliminar">✕</button>
    </div>`;
}

let _savingIdea = false;
async function saveQuickIdea() {
  if (_savingIdea) return;                      // Enter mantenido pulsado o doble clic: una sola idea
  const title = $('ideaTitleInput').value.trim();
  if (!title) { showToast('Escribe un título', 'error'); return; }
  const content    = $('ideaContentInput').value.trim();
  const projectIds = _getProjectPickerIds('quickCaptureProjs');
  const projectId  = projectIds[0] || null;
  const deadline   = $('quickCaptureDeadline')?.value || null;
  _savingIdea = true;
  try {
    await dbWrite(() => db.ideas.add({
      title, content, status: 'unread', projectId, projectIds,
      deadline,
      tags: [], subtasks: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
  } finally { _savingIdea = false; }
  showToast('Idea guardada ✓', 'success');
  sessionStorage.removeItem('ros-idea-draft-title');
  sessionStorage.removeItem('ros-idea-draft-content');
  renderIdeas();
  updateBadges(); // sincroniza badge de sidebar
}

// ==============================================================
//  VIEW: SNIPPETS
// ==============================================================
const LANGS = ['all','R','Python','Bash','SQL','Other'];

async function renderSnippets() {
  const [allSnippets, projects, collections] = await Promise.all([
    db.snippets.orderBy('createdAt').reverse().toArray(),
    db.projects.toArray(),
    getCollections(),
  ]);
  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));
  const colMap  = Object.fromEntries(collections.map(c => [c.id, c]));

  // Active collection filter
  const activeColId = App.filterCollection ?? 'all';
  let snippets;
  if (activeColId === 'none') {
    snippets = allSnippets.filter(s => !s.collectionId &&
      (App.filterLang === 'all' || s.language === App.filterLang));
  } else {
    snippets = allSnippets;
    if (App.filterLang !== 'all') snippets = snippets.filter(s => s.language === App.filterLang);
    if (activeColId !== 'all')    snippets = snippets.filter(s => s.collectionId === +activeColId);
  }

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Snippets</div>
          <div class="view-subtitle">${snippets.length} de ${allSnippets.length} snippet(s)</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="addCollectionBtn">+ Colección</button>
          <button class="btn btn-primary" id="addSnippetBtn">+ Snippet</button>
        </div>
      </div>

      <div class="snippets-layout">
        <!-- Collections sidebar -->
        <div class="snippet-collections-panel">
          <div class="snip-col-panel-title">Colecciones</div>
          <button class="snip-col-item ${activeColId==='all'?'active':''}" data-col-filter="all">
            ◈ Todos <span style="margin-left:auto">${allSnippets.length}</span>
          </button>
          <button class="snip-col-item ${activeColId==='none'?'active':''}" data-col-filter="none">
            ⊡ Sin colección <span style="margin-left:auto">${allSnippets.filter(s=>!s.collectionId).length}</span>
          </button>
          ${collections.map(c => `
            <button class="snip-col-item ${activeColId==c.id?'active':''}" data-col-filter="${c.id}">
              <span style="width:8px;height:8px;border-radius:50%;background:${cssColor(c.color)};flex-shrink:0;display:inline-block"></span>
              ${esc(c.name)}
              <span style="margin-left:auto">${allSnippets.filter(s=>s.collectionId===c.id).length}</span>
            </button>`).join('')}
        </div>

        <!-- Snippet main area -->
        <div style="flex:1;min-width:0">
          <div class="lang-tabs">
            ${LANGS.map(l => `
              <button class="lang-tab ${App.filterLang===l?'active':''}"
                      data-lang="${l}">${l === 'all' ? 'Todos' : l}</button>`).join('')}
          </div>
          <div class="snippets-list">
            ${snippets.length ? snippets.map(s => snippetCardHTML(s, projMap, colMap)).join('')
              : `<div class="empty-state"><span class="empty-state-icon">⟨/⟩</span>
                  <h3>Sin snippets</h3><p>Guarda tu primer fragmento de código</p>
                  <button class="btn btn-primary btn-sm" data-empty-cta="snippet" style="margin-top:12px">+ Snippet</button></div>`}
          </div>
        </div>
      </div>
    </div>`;

  mainContent.querySelectorAll('pre code').forEach(_highlightBlock);
  $('addSnippetBtn').addEventListener('click', showAddSnippetModal);
  $('addCollectionBtn').addEventListener('click', showAddCollectionModal);

  mainContent.querySelectorAll('[data-col-filter]').forEach(btn => {
    btn.addEventListener('click', () => { App.filterCollection = btn.dataset.colFilter; renderSnippets(); });
  });
  mainContent.querySelectorAll('.lang-tab').forEach(tab => {
    tab.addEventListener('click', () => { App.filterLang = tab.dataset.lang; renderSnippets(); });
  });
  mainContent.querySelectorAll('.copy-btn-float').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await copyText(decodeURIComponent(btn.dataset.code), 'Código copiado ✓')) { btn.textContent = '✓ Copiado'; setTimeout(() => btn.textContent = 'Copy', 1500); }
    });
  });
  mainContent.querySelectorAll('.snippet-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      {
        await deleteWithUndo('snippets', +btn.dataset.id, 'Eliminar snippet', 'Snippet eliminado');
        renderSnippets();
        updateBadges();
      }
    });
  });
  mainContent.querySelectorAll('.snippet-star-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = await db.snippets.get(+btn.dataset.id);
      await db.snippets.update(+btn.dataset.id, { starred: !s.starred });
      renderSnippets();
      updateBadges();
    });
  });

  mainContent.querySelectorAll('.snippet-edit-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = await db.snippets.get(+btn.dataset.id);
      if (s) showEditSnippetModal(s);
    });
  });

  mainContent.querySelectorAll('.snippet-card').forEach(card => {
    card.addEventListener('click', async (e) => {
      if (e.target.closest('button') || e.target.closest('.copy-btn-float')) return;
      const s = await db.snippets.get(+card.dataset.snippetId);
      if (s) inspectSnippet(s);
    });
  });
}

function snippetCardHTML(s, projMap, colMap = {}) {
  const proj     = s.projectId    ? projMap[s.projectId]    : null;
  const snipCol  = s.collectionId ? colMap[s.collectionId]  : null;
  const langCls  = `lang-${_langClass(s.language)}`;
  const encoded  = encodeURIComponent(s.code || '');
  const hlLang   = s.language === 'R' ? 'r'
                 : s.language === 'Python' ? 'python'
                 : s.language === 'Bash'   ? 'bash'
                 : s.language === 'SQL'    ? 'sql'
                 : 'plaintext';
  return `
    <div class="snippet-card" data-snippet-id="${s.id}" style="cursor:pointer">
      <div class="snippet-header">
        <span class="snippet-lang-badge ${langCls}">${esc(s.language || 'Other')}</span>
        <span class="snippet-title">${esc(s.title)}</span>
        <div class="snippet-actions">
          <button class="btn btn-ghost btn-sm snippet-star-btn" data-id="${s.id}"
                  title="${s.starred ? 'Quitar favorito' : 'Marcar favorito'}">${s.starred ? '★' : '☆'}</button>
          <button class="btn btn-ghost btn-sm snippet-edit-btn" data-id="${s.id}" title="Editar">✎</button>
          <button class="btn btn-ghost btn-sm snippet-delete-btn" data-id="${s.id}" title="Eliminar snippet">✕</button>
        </div>
      </div>
      ${s.description ? `<div class="snippet-desc">${esc(s.description)}</div>` : ''}
      <div class="snippet-code">
        <button class="copy-btn-float" data-code="${encoded}">Copy</button>
        <pre><code class="language-${hlLang}">${esc(s.code || '')}</code></pre>
      </div>
      <div class="snippet-footer">
        ${(s.tags||[]).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        ${snipCol ? `<span style="display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono);font-size:.65rem;color:var(--text-2)"><span style="width:7px;height:7px;border-radius:50%;background:${cssColor(snipCol.color)}"></span>${esc(snipCol.name)}</span>` : ''}
        ${proj ? `<span class="idea-linked" style="margin-left:auto">⬡ ${esc(proj.title)}</span>` : ''}
      </div>
    </div>`;
}

// ==============================================================
//  VIEW: FILE SYSTEM BRIDGE
// ==============================================================

// -- FS Templates ---------------------------------------------
const FS_TEMPLATES = {
  rstudio: {
    name: 'RStudio Project',
    desc: 'Estructura clásica R con data-raw, scripts, plots y manuscript.',
    dirs:  ['data-raw', 'data-processed', 'scripts', 'plots', 'manuscript'],
    files: [
      { name: '{safe}.Rproj',
        content: () => 'Version: 1.0\n\nRestoreWorkspace: Default\nSaveWorkspace: Default\nAlwaysSaveHistory: Default\n\nEnableCodeIndexing: Yes\nUseSpacesForTab: Yes\nNumSpacesForTab: 2\nEncoding: UTF-8\n' },
      { name: 'README.md',
        content: ({name,desc,author,date}) =>
          `# ${name}\n\n${desc||'Proyecto de investigación.'}\n\n**Autor:** ${author}  \n**Fecha:** ${date}\n` },
      { name: 'scripts/00_setup.R',
        content: ({name,author}) =>
          `# Project: ${name}\n# Author:  ${author}\n\nlibrary(tidyverse)\nlibrary(here)\n\nPATH_RAW  <- here("data-raw")\nPATH_DATA <- here("data-processed")\nPATH_FIGS <- here("plots")\n` },
    ]
  },
  python_ds: {
    name: 'Python Data Science',
    desc: 'Notebooks, src, data y reports para proyectos Python.',
    dirs:  ['data/raw', 'data/processed', 'notebooks', 'src', 'reports', 'tests'],
    files: [
      { name: 'README.md',
        content: ({name,desc,author,date}) =>
          `# ${name}\n\n${desc||'Data science project.'}\n\n**Author:** ${author}  \n**Date:** ${date}\n` },
      { name: 'requirements.txt',
        content: () => 'pandas\nnumpy\nmatplotlib\nseaborn\nscipy\nsklearn\njupyter\n' },
      { name: 'src/__init__.py', content: () => '# Source package\n' },
    ]
  },
  minimal: {
    name: 'Minimal',
    desc: 'Estructura mínima: data, scripts, output y README.',
    dirs:  ['data', 'scripts', 'output'],
    files: [
      { name: 'README.md',
        content: ({name,desc,author,date}) =>
          `# ${name}\n\n${desc||'Research project.'}\n\n**Author:** ${author}  \n**Date:** ${date}\n` },
    ]
  },
  custom: {
    name: 'Personalizado',
    desc: 'Define tus propias carpetas y archivos iniciales.',
    dirs:  [],
    files: []
  }
};

async function renderFilesystem() {
  const fsSupported = 'showDirectoryPicker' in window;
  const projects = await db.projects.toArray();
  const tplKeys = Object.keys(FS_TEMPLATES);
  const tplTabsHTML = tplKeys.map(k => `
    <button class="lang-tab ${k === 'rstudio' ? 'active' : ''}" data-tpl="${k}">
      ${FS_TEMPLATES[k].name}
    </button>`).join('');

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Carpetas del proyecto</div>
          <div class="view-subtitle">Genera estructura de proyecto en tu sistema de archivos local</div>
        </div>
      </div>

      ${!fsSupported ? `
        <div class="fs-unsupported">
          ⚠ La File System Access API no está disponible en este navegador.<br>
          Usa <strong>Chrome 86+</strong> o <strong>Edge 86+</strong> para esta funcionalidad.<br>
          <small style="opacity:.7">Firefox y Safari no soportan showDirectoryPicker() aún.</small>
        </div>` : ''}

      <div class="section-title">Template de carpetas</div>
      <div class="lang-tabs" id="tplTabs" style="margin-bottom:12px">${tplTabsHTML}</div>
      <p id="tplDescText" style="font-size:.8rem;color:var(--text-2);margin:0 0 16px">
        ${esc(FS_TEMPLATES.rstudio.desc)}
      </p>

      <div class="fs-layout">
        <div class="fs-form-section">
          <div class="form-group">
            <label class="form-label">Proyecto vinculado (opcional)</label>
            <select class="form-select" id="fsProjectSelect">
              <option value="">— Nuevo proyecto —</option>
              ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Nombre del directorio</label>
            <input class="form-input" id="fsDirName" placeholder="mi_proyecto_2025"
                   ${!fsSupported ? 'disabled' : ''}>
            <span class="form-hint">Se usará como nombre de carpeta en tu sistema</span>
          </div>
          <div class="form-group">
            <label class="form-label">Descripción del proyecto</label>
            <textarea class="form-textarea" id="fsDescription"
                      placeholder="Escribe una descripción breve del proyecto…"
                      ${!fsSupported ? 'disabled' : ''}></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Autor / Responsable</label>
            <input class="form-input" id="fsAuthor" placeholder="Dr. García"
                   ${!fsSupported ? 'disabled' : ''}>
          </div>

          <div id="customTplEditor" style="display:none">
            <div class="form-group">
              <label class="form-label">Carpetas a crear (una por línea)</label>
              <textarea class="form-textarea" id="fsCustomDirs" rows="4"
                        style="font-family:var(--font-mono);font-size:.78rem"
                        placeholder="data-raw&#10;scripts&#10;output"></textarea>
            </div>
            <div class="form-group">
              <label class="form-label">Archivos a crear (ruta:contenido, uno por línea)</label>
              <textarea class="form-textarea" id="fsCustomFiles" rows="4"
                        style="font-family:var(--font-mono);font-size:.78rem"
                        placeholder="README.md:# Mi Proyecto&#10;scripts/main.R:# Script principal"></textarea>
            </div>
          </div>

          <button class="dir-picker-btn ${!fsSupported ? 'disabled' : ''}"
                  id="pickDirBtn" ${!fsSupported ? 'disabled' : ''}>
            <span class="dir-picker-icon">📁</span>
            Seleccionar carpeta raíz y generar estructura
          </button>
        </div>

        <div class="fs-preview">
          <div class="section-title">Vista previa de estructura</div>
          <div class="fs-tree" id="fsTree">
            <span style="color:var(--text-3)">Elige un template y escribe el nombre del directorio.</span>
          </div>
        </div>
      </div>
    </div>`;

  let currentTpl = 'rstudio';
  const updateTplPreview = () => {
    const tpl  = FS_TEMPLATES[currentTpl];
    const tree = $('fsTree');
    if (!tree) return;
    if (currentTpl === 'custom') {
      tree.innerHTML = '<span style="color:var(--text-3)">Define tus carpetas y archivos arriba.</span>';
      return;
    }
    const name = ($('fsDirName')?.value.trim() || 'mi_proyecto').replace(/[^a-zA-Z0-9_\-]/g, '_');
    tree.innerHTML = [
      `<div class="success"><span class="dir">📁 ${name}/</span></div>`,
      ...tpl.dirs.map(d  => `<div class="success">  <span class="dir">📁 ${d}/</span></div>`),
      ...tpl.files.map(f => `<div class="success">  📄 ${f.name.replace('{safe}', name)}</div>`),
    ].join('');
  };
  updateTplPreview();

  mainContent.querySelectorAll('[data-tpl]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTpl = btn.dataset.tpl;
      mainContent.querySelectorAll('[data-tpl]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $('tplDescText').textContent = FS_TEMPLATES[currentTpl].desc;
      $('customTplEditor').style.display = currentTpl === 'custom' ? 'block' : 'none';
      updateTplPreview();
    });
  });

  $('fsDirName')?.addEventListener('input', updateTplPreview);

  if (fsSupported) {
    $('pickDirBtn').addEventListener('click', () => runFSBridge(currentTpl));
    $('fsProjectSelect').addEventListener('change', async () => {
      const id = +$('fsProjectSelect').value;
      if (!id) return;
      const p = await db.projects.get(id);
      if (p) {
        $('fsDirName').value     = p.title.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
        $('fsDescription').value = p.description || '';
        $('fsAuthor').value      = p.responsible || '';
        updateTplPreview();
      }
    });
  }
}

async function runFSBridge(templateKey = 'rstudio') {
  const name = $('fsDirName').value.trim() || 'research_project';
  const desc = $('fsDescription').value.trim();
  const auth = $('fsAuthor').value.trim() || 'Unknown';

  try {
    showToast('Selecciona la carpeta raíz…', 'info');
    const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    App.lastDirHandle = rootHandle;
    await createProjectStructure(rootHandle, { name, desc, author: auth }, templateKey);
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('Error: ' + err.message, 'error');
      console.error(err);
    }
  }
}

// File System Access API helpers
async function createDir(parentHandle, name) {
  return parentHandle.getDirectoryHandle(name, { create: true });
}

async function writeFile(parentHandle, name, content) {
  const fh       = await parentHandle.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(content);
  await writable.close();
}

async function createProjectStructure(rootHandle, { name, desc, author }, templateKey = 'rstudio') {
  const tree  = $('fsTree');
  const safe  = name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const date  = localDateISO();
  const ctx   = { name: safe, desc, author, date };
  const steps = [];

  const log = (msg, cls = '') => {
    steps.push(`<div class="${cls}">${msg}</div>`);
    tree.innerHTML = steps.join('');
  };

  let tpl;
  if (templateKey === 'custom') {
    const rawDirs  = ($('fsCustomDirs')?.value  || '').split('\n').map(s => s.trim()).filter(Boolean);
    const rawFiles = ($('fsCustomFiles')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    tpl = {
      dirs:  rawDirs,
      files: rawFiles.map(line => {
        const sep = line.indexOf(':');
        return sep > 0
          ? { name: line.slice(0, sep).trim(), content: () => line.slice(sep + 1).trim() }
          : { name: line.trim(), content: () => '' };
      })
    };
  } else {
    tpl = FS_TEMPLATES[templateKey] || FS_TEMPLATES.rstudio;
  }

  try {
    for (const dir of tpl.dirs) {
      const parts = dir.split('/').filter(Boolean);
      let handle  = rootHandle;
      for (const part of parts) handle = await handle.getDirectoryHandle(part, { create: true });
      log(`<span class="dir">📁 ${dir}/</span>`, 'success');
    }

    for (const file of tpl.files) {
      const fname   = file.name.replace('{safe}', safe);
      const content = typeof file.content === 'function' ? file.content(ctx) : (file.content || '');
      const parts   = fname.split('/').filter(Boolean);
      let handle    = rootHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        handle = await handle.getDirectoryHandle(parts[i], { create: true });
      }
      await writeFile(handle, parts[parts.length - 1], content);
      log(`📄 ${fname}`, 'success');
    }

    log(`<br><strong style="color:var(--green)">✓ Estructura "${safe}" generada correctamente</strong>`);
    showToast(`Estructura "${safe}" creada ✓`, 'success');
  } catch (err) {
    log(`<span style="color:var(--red)">⚠ Error: ${esc(err.message)}</span>`);
    showToast('Error al crear estructura: ' + err.message, 'error');
    console.error(err);
  }
}

// ==============================================================
//  VIEW: TIMELINE / GANTT
// ==============================================================
async function renderTimeline() {
  const [projects, allIdeasWithDL, allMeetsWithDate_pre] = await Promise.all([
    db.projects.toArray(),
    db.ideas.filter(i => !!i.deadline).toArray(),
    db.meetings.filter(m => !!m.date).toArray(),
  ]);
  const allWithDL = projects.filter(p => p.deadline)
    .sort((a,b) => new Date(a.deadline) - new Date(b.deadline));

  // -- Ideas con deadline ---------------------------------
  const ideasByProject = {};
  allIdeasWithDL.forEach(i => {
    // Respetar multi-proyecto: una idea aparece bajo cada proyecto vinculado
    const keys = (i.projectIds && i.projectIds.length)
      ? i.projectIds
      : (i.projectId ? [i.projectId] : ['_orphan']);
    keys.forEach(key => {
      if (!ideasByProject[key]) ideasByProject[key] = [];
      if (!ideasByProject[key].find(x => x.id === i.id))
        ideasByProject[key].push(i);
    });
  });

  // -- Reuniones con fecha --------------------------------
  const allMeetsWithDate = allMeetsWithDate_pre;
  const meetsByProject = {};
  allMeetsWithDate.forEach(m => {
    const key = m.projectId || '_orphan';
    if (!meetsByProject[key]) meetsByProject[key] = [];
    meetsByProject[key].push(m);
  });
  // -- Jerarquía de proyectos -----------------------------
  const childProjMap  = {};
  projects.filter(p => p.parentId).forEach(p => {
    if (!childProjMap[p.parentId]) childProjMap[p.parentId] = [];
    childProjMap[p.parentId].push(p);
  });
  const rootWithDL = allWithDL.filter(p => !p.parentId);

  const PRIO_COLORS = { Alta:'var(--red)', Media:'var(--amber)', Baja:'var(--green)' };
  const TYPE_COLORS = { Grant:'var(--amber)', Paper:'var(--accent)', 'Análisis':'var(--purple)', Dataset:'var(--teal)' };

  const today = new Date(); today.setHours(12,0,0,0);

  // -- Estado mutable del timeline ------------------------
  let colorMode    = 'priority';
  let showOverdue  = true;
  let zoomLevel    = 'year';   // 'week' | 'month' | 'year'

  // Rango de fechas según zoom
  const getDateRange = () => {
    const start = new Date(today);
    const end   = new Date(today);
    if (zoomLevel === 'week')  { start.setDate(today.getDate() - 2); end.setDate(today.getDate() + 7); }
    if (zoomLevel === 'month') { start.setDate(today.getDate() - 3); end.setMonth(today.getMonth() + 1); end.setDate(end.getDate() + 3); }
    if (zoomLevel === 'year')  { start.setMonth(today.getMonth() - 1); end.setFullYear(today.getFullYear() + 1); }
    return { start, end };
  };

  const getColor = p => colorMode === 'priority'
    ? (PRIO_COLORS[p.priority] || 'var(--text-2)')
    : (TYPE_COLORS[p.type]     || 'var(--text-2)');

  mainContent.innerHTML = '';   // limpiar DESPUÉS del fetch → no hay frame en blanco
  mainContent.insertAdjacentHTML('beforeend', `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Línea de tiempo</div>
          <div class="view-subtitle" id="tlSubtitle"></div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <!-- Zoom -->
          <div class="tl-btn-group">
            <button class="btn btn-ghost btn-sm tl-zoom ${zoomLevel==='week' ?'active':''}" data-zoom="week">Semana</button>
            <button class="btn btn-ghost btn-sm tl-zoom ${zoomLevel==='month'?'active':''}" data-zoom="month">Mes</button>
            <button class="btn btn-ghost btn-sm tl-zoom ${zoomLevel==='year' ?'active':''}" data-zoom="year">Año</button>
          </div>
          <!-- Color -->
          <div class="tl-btn-group">
            <button class="btn btn-ghost btn-sm tl-color active" data-color="priority">Prioridad</button>
            <button class="btn btn-ghost btn-sm tl-color"        data-color="type">Tipo</button>
          </div>
          <!-- Vencidos -->
          <button class="btn btn-ghost btn-sm" id="tlToggleOverdue">⏱ Ocultar vencidos</button>
        </div>
      </div>
      <div id="tlContainer"></div>
    </div>`);

  const viewEl    = mainContent.querySelector('.view');
  const container = $('tlContainer');

  const rebuild = () => {
    const { start, end } = getDateRange();
    const totalMs = end - start;
    const toX = d => {
      const pct = ((new Date(d + 'T12:00:00') - start) / totalMs * 100);
      return Math.max(-2, Math.min(102, pct)).toFixed(2) + '%';
    };
    const todayX = ((today - start) / totalMs * 100).toFixed(2) + '%';

    // -- Raíces visibles (+ raíces con hijos/sub-items visibles) --
    const inWindow = (isoDate) => {
      if (!isoDate) return false;
      const d = new Date(isoDate + (isoDate.length === 10 ? 'T12:00:00' : ''));
      return (showOverdue || d >= today) && d >= start && d <= end;
    };

    // Helper recursivo: verdadero si el proyecto o cualquier descendiente
    // tiene una fecha (deadline de idea/reunión o deadline propio de subproyecto)
    // que cae dentro de la ventana actual.
    const hasVisibleDescendant = (projId) => {
      if ((ideasByProject[projId]  || []).some(i => inWindow(i.deadline))) return true;
      if ((meetsByProject[projId]  || []).some(m => inWindow(m.date)))      return true;
      const children = childProjMap[projId] || [];
      return children.some(c => inWindow(c.deadline) || hasVisibleDescendant(c.id));
    };

    const visibleRoots = rootWithDL.filter(p => {
      const pd = new Date(p.deadline + 'T12:00:00');
      if (!showOverdue && pd < today) return false;
      return pd >= start && pd <= end;
    });
    // Incluir raíces que solo tienen sub-ítems en la ventana (sin su propio deadline visible).
    // Parte de TODOS los proyectos raíz (no solo los que tienen deadline propio) y usa
    // hasVisibleDescendant para buscar recursivamente en toda la jerarquía.
    const allRoots = projects.filter(p => !p.parentId);
    const rootsWithVisibleChildren = allRoots.filter(p => {
      if (visibleRoots.includes(p)) return false;
      return hasVisibleDescendant(p.id);
    });
    const allVisibleRoots = [...visibleRoots, ...rootsWithVisibleChildren];

    const totalVisible = allVisibleRoots.length + visibleRoots.length; // rough count
    $('tlSubtitle').textContent =
      `${allVisibleRoots.length} proyecto(s) en la ventana` +
      (!showOverdue && allWithDL.some(p => new Date(p.deadline+'T12:00:00') < today)
        ? ' · vencidos ocultos' : '');

    // -- Helper: filas de sub-ítems para un proyecto ---------
    const subRows = (projId, depth = 1) => {
      const pad = depth === 1 ? '16px' : '28px';
      const rows = [];

      (childProjMap[projId] || [])
        .filter(cp => inWindow(cp.deadline) ||
          (ideasByProject[cp.id]||[]).some(i => inWindow(i.deadline)) ||
          (meetsByProject[cp.id]||[]).some(m => inWindow(m.date)))
        .forEach(cp => {
          const cpHasDl = !!cp.deadline && inWindow(cp.deadline);
          const cpO = cpHasDl && new Date(cp.deadline + 'T12:00:00') < today;
          rows.push(`
            <div class="timeline-row ${cpO ? 'tl-row-overdue' : ''}"
                 style="background:var(--bg-surface)">
              <div class="timeline-row-label" data-inspect-project="${cp.id}"
                   style="padding-left:${pad}" title="${esc(cp.title)}">
                <span style="color:var(--text-3);margin-right:3px;font-size:.7rem">↳</span>
                ${cpO ? '<span class="tl-overdue-badge">vencido</span>' : ''}
                ${esc(cp.title)}
              </div>
              <div class="timeline-track">
                <div class="timeline-today-line" style="left:${todayX}"></div>
                ${cpHasDl ? `
                <div class="timeline-deadline-dot"
                     data-inspect-project="${cp.id}"
                     style="left:${toX(cp.deadline)};background:${getColor(cp)}"
                     title="${esc(cp.title)} — ${formatDate(cp.deadline)}"></div>
                <span class="timeline-deadline-label" style="left:${toX(cp.deadline)}">${formatDate(cp.deadline)}</span>
                ` : ''}
              </div>
            </div>`);
          rows.push(...subRows(cp.id, depth + 1).split('<!-- sep -->').filter(Boolean));
        });

      (ideasByProject[projId] || []).filter(i => inWindow(i.deadline)).forEach(i => {
        const ic = new Date(i.deadline+'T12:00:00') < today ? 'var(--red)'
          : (new Date(i.deadline+'T12:00:00') - today) < 7*86400000 ? 'var(--amber)' : 'var(--purple)';
        rows.push(`
          <div class="timeline-row timeline-idea-subrow">
            <div class="timeline-row-label timeline-idea-label"
                 data-inspect-idea="${i.id}" style="padding-left:${pad}"
                 title="${esc(i.title)}">◎ ${esc(i.title)}</div>
            <div class="timeline-track">
              <div class="timeline-today-line" style="left:${todayX}"></div>
              <div class="timeline-deadline-dot"
                   data-inspect-idea="${i.id}"
                   style="left:${toX(i.deadline)};background:${ic};width:8px;height:8px"
                   title="${esc(i.title)} — ${formatDate(i.deadline)}"></div>
              <span class="timeline-deadline-label" style="left:${toX(i.deadline)}">${formatDate(i.deadline)}</span>
            </div>
          </div>`);
      });

      (meetsByProject[projId] || []).filter(m => inWindow(m.date)).forEach(m => {
        const mc = new Date(m.date+'T12:00:00') < today ? 'var(--text-3)' : 'var(--teal)';
        rows.push(`
          <div class="timeline-row timeline-idea-subrow tl-sub-meeting">
            <div class="timeline-row-label timeline-idea-label"
                 data-inspect-meeting="${m.id}" style="padding-left:${pad}"
                 title="${esc(m.title)}">🗓 ${esc(m.title)}</div>
            <div class="timeline-track">
              <div class="timeline-today-line" style="left:${todayX}"></div>
              <div class="timeline-deadline-dot"
                   data-inspect-meeting="${m.id}"
                   style="left:${toX(m.date)};background:${mc};width:8px;height:8px"
                   title="${esc(m.title)} — ${formatDate(m.date)}"></div>
              <span class="timeline-deadline-label" style="left:${toX(m.date)}">${formatDate(m.date)}</span>
            </div>
          </div>`);
      });

      return rows.join('<!-- sep -->');
    };

    // -- Huérfanos (sin proyecto) ---------------------------
    const orphanSections = () => {
      const oIdeas = (ideasByProject['_orphan']||[]).filter(i => inWindow(i.deadline));
      const oMeets = (meetsByProject['_orphan']||[]).filter(m => inWindow(m.date));
      if (!oIdeas.length && !oMeets.length) return '';
      return `
        <div class="timeline-header-row" style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
          <div style="font-family:var(--font-mono);font-size:.67rem;color:var(--text-3)">Sin proyecto asociado</div>
          <div></div>
        </div>` + subRows('_orphan', 0).split('<!-- sep -->').join('');
    };

    // -- Etiquetas de escala temporal ----------------------
    const ticks = [];
    const _tickCur = new Date(start); _tickCur.setDate(1);
    if (zoomLevel === 'week') {
      const _d = new Date(start);
      while (_d <= end) {
        ticks.push({
          label: _d.toLocaleDateString('es-CL', { weekday:'short', day:'numeric' }),
          x: ((_d - start) / totalMs * 100).toFixed(2) + '%'
        });
        _d.setDate(_d.getDate() + 1);
      }
    } else if (zoomLevel === 'month') {
      const _d = new Date(start);
      while (_d <= end) {
        ticks.push({
          label: _d.toLocaleDateString('es-CL', { day:'numeric', month:'short' }),
          x: ((_d - start) / totalMs * 100).toFixed(2) + '%'
        });
        _d.setDate(_d.getDate() + 7);
      }
    } else {
      while (_tickCur <= end) {
        ticks.push({
          label: _tickCur.toLocaleDateString('es-CL', { month:'short', year:'2-digit' }),
          x: ((_tickCur - start) / totalMs * 100).toFixed(2) + '%'
        });
        _tickCur.setMonth(_tickCur.getMonth() + 1);
      }
    }

    const legendEntries = colorMode === 'priority' ? PRIO_COLORS : TYPE_COLORS;

    // -- Cálculo de carga de trabajo por período ----------------------
    const workloadPeriods = [];
    if (zoomLevel === 'year') {
      // Buckets mensuales — alinean con los tick labels
      let _wCur = new Date(start.getFullYear(), start.getMonth(), 1);
      while (_wCur <= end) {
        const _wEnd = new Date(_wCur.getFullYear(), _wCur.getMonth() + 1, 1);
        const count = allWithDL.filter(p => {
          const d = new Date(p.deadline + 'T12:00:00');
          return d >= _wCur && d < _wEnd && (showOverdue || d >= today);
        }).length;
        const xStart = Math.max(0, (_wCur - start) / totalMs * 100);
        const xEnd   = Math.min(100, (_wEnd - start) / totalMs * 100);
        if (xEnd > 0 && xStart < 100)
          workloadPeriods.push({
            x: xStart.toFixed(2), w: (xEnd - xStart).toFixed(2), count,
            label: _wCur.toLocaleDateString('es-CL', { month: 'short', year: '2-digit' })
          });
        _wCur = new Date(_wCur.getFullYear(), _wCur.getMonth() + 1, 1);
      }
    } else {
      const PERIOD_MS = zoomLevel === 'week' ? 86400000 : 7 * 86400000;
      let _wCur = new Date(start);
      while (_wCur < end) {
        const _wEnd = new Date(Math.min(_wCur.getTime() + PERIOD_MS, end.getTime()));
        const count = allWithDL.filter(p => {
          const d = new Date(p.deadline + 'T12:00:00');
          return d >= _wCur && d < _wEnd && (showOverdue || d >= today);
        }).length;
        workloadPeriods.push({
          x: ((_wCur - start) / totalMs * 100).toFixed(2),
          w: ((_wEnd  - _wCur) / totalMs * 100).toFixed(2),
          count,
          label: _wCur.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
        });
        _wCur = new Date(_wCur.getTime() + PERIOD_MS);
      }
    }

    const _maxLoad     = Math.max(...workloadPeriods.map(d => d.count), 1);
    const _hasOverload = workloadPeriods.some(d => d.count >= 4);

    const workloadHTML = workloadPeriods.some(d => d.count > 0) ? `
      <div style="display:grid;grid-template-columns:220px 1fr;align-items:center;gap:0;margin-bottom:10px">
        <div style="font-family:var(--font-mono);font-size:.6rem;text-transform:uppercase;
                    letter-spacing:.08em;color:var(--text-3);padding-right:12px">
          Carga · deadlines/período
        </div>
        <div class="tl-workload-track">
          ${workloadPeriods.filter(d => d.count > 0).map(d => {
            const pct   = d.count / _maxLoad;
            const color = pct > 0.65 ? 'var(--red)' : pct > 0.33 ? 'var(--amber)' : 'var(--green)';
            return `<div class="tl-workload-segment"
                         style="left:${d.x}%;width:${d.w}%;background:${color};
                                opacity:${(0.25 + pct * 0.65).toFixed(2)}"
                         title="${d.label}: ${d.count} deadline${d.count > 1 ? 's' : ''}"></div>`;
          }).join('')}
          <div style="position:absolute;left:${todayX};top:0;bottom:0;width:1px;
                      background:var(--accent);opacity:.7;z-index:2;pointer-events:none"></div>
        </div>
      </div>
      ${_hasOverload ? `
        <div style="display:grid;grid-template-columns:220px 1fr">
          <div></div>
          <div style="font-family:var(--font-mono);font-size:.62rem;color:var(--red);margin-bottom:8px">
            ⚠ Período con alta carga detectado — máx. ${_maxLoad} deadline${_maxLoad > 1 ? 's' : ''} en un período
          </div>
        </div>` : ''}` : '';

    container.innerHTML = !allVisibleRoots.length ? `
      <div class="timeline-empty">
        Sin elementos con fechas en esta ventana.
        ${!showOverdue ? 'Activa "Mostrar vencidos" o amplía el zoom.' : 'Ajusta el zoom para ampliar el rango.'}
      </div>` : `
      <div class="timeline-legend">
        ${Object.entries(legendEntries).map(([k,v]) =>
          `<span class="timeline-legend-item">
            <span class="tl-dot" style="background:${v}"></span>${k}
          </span>`).join('')}
        <span class="timeline-legend-item">
          <span style="display:inline-block;width:10px;height:2px;background:var(--accent);border-radius:1px"></span>Hoy
        </span>
        <span class="timeline-legend-item"><span class="tl-dot" style="background:var(--purple)"></span>◎ Idea</span>
        <span class="timeline-legend-item"><span class="tl-dot" style="background:var(--teal)"></span>🗓 Reunión</span>
      </div>
      ${workloadHTML}
      <div class="timeline-wrapper">
        <div class="timeline-grid">
          <div class="timeline-header-row">
            <div style="font-family:var(--font-mono);font-size:.68rem;color:var(--text-3);padding-bottom:8px">Elemento</div>
            <div style="position:relative;height:24px">
              ${ticks.map(t => `<span class="timeline-month-label" style="left:${t.x}">${t.label}</span>`).join('')}
            </div>
          </div>
          ${allVisibleRoots.map(p => {
            const isOverdue = new Date(p.deadline + 'T12:00:00') < today;
            const hasDeadlineInWindow = inWindow(p.deadline);
            return `
              <div class="timeline-row ${isOverdue ? 'tl-row-overdue' : ''}">
                <div class="timeline-row-label" data-inspect-project="${p.id}"
                     title="${esc(p.title)}">
                  ${isOverdue ? '<span class="tl-overdue-badge">vencido</span>' : ''}
                  ${esc(p.title)}
                </div>
                <div class="timeline-track">
                  <div class="timeline-today-line" style="left:${todayX}">
                    <span class="timeline-today-label">hoy</span>
                  </div>
                  ${hasDeadlineInWindow ? `
                    <div class="timeline-deadline-dot"
                         data-inspect-project="${p.id}"
                         style="left:${toX(p.deadline)};background:${getColor(p)}"
                         title="${esc(p.title)} — ${formatDate(p.deadline)}"></div>
                    <span class="timeline-deadline-label" style="left:${toX(p.deadline)}">${formatDate(p.deadline)}</span>
                  ` : ''}
                </div>
              </div>
              ${subRows(p.id).split('<!-- sep -->').join('')}`;
          }).join('')}
          ${orphanSections()}
        </div>
      </div>`;

    // -- Rebind inspect para todos los tipos ----------------
    container.querySelectorAll('[data-inspect-project]').forEach(el =>
      el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject)));
    container.querySelectorAll('[data-inspect-idea]').forEach(el =>
      el.addEventListener('click', () => inspectIdea(+el.dataset.inspectIdea)));
    container.querySelectorAll('[data-inspect-submission]').forEach(el =>
      el.addEventListener('click', () => inspectProject(+el.dataset.inspectSubmission)));
    container.querySelectorAll('[data-inspect-meeting]').forEach(el =>
      el.addEventListener('click', () => inspectMeeting(+el.dataset.inspectMeeting)));
  };

  // -- Evento inicial: zoom = año por defecto --------------
  rebuild();

  // -- Listeners de controles ------------------------------
  mainContent.querySelectorAll('.tl-zoom').forEach(btn => {
    btn.addEventListener('click', () => {
      zoomLevel = btn.dataset.zoom;
      mainContent.querySelectorAll('.tl-zoom').forEach(b =>
        b.classList.toggle('active', b === btn));
      rebuild();
    });
  });

  mainContent.querySelectorAll('.tl-color').forEach(btn => {
    btn.addEventListener('click', () => {
      colorMode = btn.dataset.color;
      mainContent.querySelectorAll('.tl-color').forEach(b =>
        b.classList.toggle('active', b === btn));
      rebuild();
    });
  });

  $('tlToggleOverdue')?.addEventListener('click', (e) => {
    showOverdue = !showOverdue;
    e.target.textContent = showOverdue ? '⏱ Ocultar vencidos' : '⏱ Mostrar vencidos';
    rebuild();
  });
}

// ==============================================================
//  VIEW: ARCHIVADOS & FAVORITOS
// ==============================================================
async function renderArchived() {
  const projects = (await db.projects.toArray()).filter(p => p.archived);
  const cols     = await db.kanbanColumns.toArray();
  const colMap   = Object.fromEntries(cols.map(c => [c.id, c]));

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Archivados</div>
          <div class="view-subtitle">${projects.length} proyecto(s) archivado(s)</div>
        </div>
      </div>
      <div class="projects-grid" id="archivedGrid">
        ${projects.length
          ? projects.map(p => projectCardHTML(p, colMap[p.columnId])).join('')
          : `<div class="empty-state" style="grid-column:1/-1">
               <span class="empty-state-icon">⊟</span>
               <h3>Sin archivados</h3>
               <p>Los proyectos archivados aparecerán aquí</p>
             </div>`}
      </div>
    </div>`;

  mainContent.querySelectorAll('[data-inspect-project]').forEach(el => {
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject));
  });
}

// -- Vista Proyectos Anidados ------------------------
async function renderNestedProjects() {
  const all  = await db.projects.filter(p => !p.archived).toArray();
  const cols = await db.kanbanColumns.toArray();
  const colMap = Object.fromEntries(cols.map(c => [c.id, c]));

  // Separar raíz (sin parentId) de hijos
  const roots    = all.filter(p => !p.parentId);
  const childMap = {};
  all.filter(p => p.parentId).forEach(p => {
    if (!childMap[p.parentId]) childMap[p.parentId] = [];
    childMap[p.parentId].push(p);
  });

  function nodeHTML(p, depth = 0) {
    const children = childMap[p.id] || [];
    const col = colMap[p.columnId];
    const indent = depth * 20;
    return `
      <div class="nested-node" data-depth="${depth}" style="margin-left:${indent}px">
        <div class="nested-node-row" data-inspect-project="${p.id}">
          <span class="nested-expand ${children.length ? '' : 'no-children'}"
                data-nest-toggle="${p.id}">${children.length ? '▶' : '·'}</span>
          <span class="nested-dot" style="background:${col?.color||'#888'}"></span>
          <span class="nested-title">${esc(p.title)}</span>
          <span class="badge ${typeBadgeClass(p.type)} nested-badge">${esc(p.type)}</span>
          <span class="badge ${prioBadgeClass(p.priority)} nested-badge">${esc(p.priority)}</span>
          ${p.deadline ? `<span class="nested-deadline">⏱ ${formatDate(p.deadline)}</span>` : ''}
          <span class="nested-col">${esc(col?.title||'—')}</span>
          <span class="nested-actions">
            <button class="btn btn-ghost btn-sm" data-nest-add-child="${p.id}" title="Añadir subproyecto">+</button>
          </span>
        </div>
        ${children.length ? `
          <div class="nested-children" id="nestChildren-${p.id}">
            ${children.map(ch => nodeHTML(ch, depth + 1)).join('')}
          </div>` : ''}
      </div>`;
  }

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Jerarquía de proyectos</div>
          <div class="view-subtitle">${roots.length} proyectos raíz · ${all.length} total</div>
        </div>
        <button class="btn btn-primary" id="nestAddRoot">+ Proyecto Raíz</button>
      </div>
      <div class="nested-tree" id="nestedTree">
        ${roots.length
          ? roots.map(r => nodeHTML(r, 0)).join('')
          : `<div class="empty-state">
               <span class="empty-state-icon">⬡</span>
               <h3>Sin proyectos</h3>
               <p>Crea tu primer proyecto raíz</p>
               <button class="btn btn-primary btn-sm" data-empty-cta="project" style="margin-top:12px">+ Proyecto</button>
             </div>`}
      </div>
    </div>`;

  // Inspect al hacer click en la fila
  mainContent.querySelectorAll('[data-inspect-project]').forEach(el => {
    el.addEventListener('click', e => {
      if (!e.target.closest('[data-nest-toggle]') && !e.target.closest('[data-nest-add-child]'))
        inspectProject(+el.dataset.inspectProject);
    });
  });

  // Toggle colapsar/expandir hijos
  mainContent.querySelectorAll('[data-nest-toggle]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pid  = +btn.dataset.nestToggle;
      const cont = document.getElementById(`nestChildren-${pid}`);
      if (!cont) return;
      const collapsed = cont.style.display === 'none';
      cont.style.display = collapsed ? '' : 'none';
      btn.textContent = collapsed ? '▶' : '▼';
    });
  });

  // Añadir subproyecto
  mainContent.querySelectorAll('[data-nest-add-child]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const parentId = +btn.dataset.nestAddChild;
      showAddProjectModal(null, parentId);
    });
  });

  $('nestAddRoot')?.addEventListener('click', () => showAddProjectModal(null, null));
}

// ==============================================================
//  VIEW: AGENDA SEMANAL (solo lectura — agrega deadlines,
//        submissions, reuniones y recordatorios de la semana)
// ==============================================================

async function renderWeeklyAgenda() {
  const today = new Date(); today.setHours(0,0,0,0);
  const viewMode = App.agendaViewMode || 'week';

  // -- Cargar todos los elementos con fecha ----------------
  const [projects, meetings, ideas, tasks] = await Promise.all([
    db.projects.filter(p => !p.archived).toArray(),
    db.meetings.toArray(),
    db.ideas.filter(i => !!i.deadline).toArray(),
    db.tasks.filter(t => !!t.due).toArray(),
  ]);
  const projById = new Map(projects.map(p => [p.id, p]));
  const taskShown = t => {                                         // como en Hoy: sin tareas de proyectos archivados y respetando el área activa
    if (t.projectId && !projById.has(t.projectId)) return false;
    return inAreaScope((t.projectId ? projById.get(t.projectId).areaId : t.areaId) ?? null);
  };

  const isoDay = d =>
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayIso = isoDay(today);
  const DAY_LABELS   = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const MONTH_SHORT  = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const MONTH_LONG   = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                        'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  /** Devuelve todos los eventos para un día ISO dado */
  const eventsForDay = (iso) => {
    const evs = [];
    projects.filter(p => p.deadline === iso).forEach(p =>
      evs.push({ color:'var(--red)', label:`⏱ ${p.title}`, kind:'project', id:p.id }));
    ideas.filter(i => i.deadline === iso).forEach(i =>
      evs.push({ color:'var(--purple)', label:`◎ ${i.title}`, kind:'idea', id:i.id }));
    // Fecha de envío efectivo de Papers (el deadline ya aparece vía projects)
    projects.filter(p => p.type === 'Paper' && p.submittedAt === iso).forEach(p =>
      evs.push({ color:'var(--green)', label:`✓ Enviado: ${p.title}`, kind:'project', id:p.id }));
    meetings.filter(m => m.date === iso).sort((a, b) => (a.time || '99').localeCompare(b.time || '99')).forEach(m =>
      evs.push({ color:'var(--teal)', label:`🗓 ${m.time ? m.time + ' ' : ''}${m.title}`, kind:'meeting', id:m.id }));
    // Tareas con fecha: las abiertas primero; las hechas se ven atenuadas (para repasar lo avanzado)
    tasks.filter(t => t.due === iso && taskShown(t))
      .sort((a, b) => (a.done - b.done) || a.id - b.id)
      .forEach(t => evs.push({ color: t.done ? 'var(--text-3)' : t.priority === 'Alta' ? 'var(--red)' : 'var(--accent)', label: `${t.done ? '☑' : '☐'} ${t.title}`,
        kind:'task', id:t.id, projectId:t.projectId, ideaId:t.ideaId, done:t.done }));
    return evs;
  };

  const actionAttr = ev => {
    if (ev.kind === 'project')    return `data-inspect-project="${ev.id}"`;
    if (ev.kind === 'idea')       return `data-inspect-idea="${ev.id}"`;
    if (ev.kind === 'meeting')    return `data-inspect-meeting="${ev.id}"`;
    if (ev.kind === 'task')       return ev.ideaId ? `data-inspect-idea="${ev.ideaId}"` : ev.projectId ? `data-inspect-project="${ev.projectId}"` : `data-open-today="1"`;
    return '';
  };

  // -- Construir contenido según el modo -----------------
  let contentHTML = '', subtitleHTML = '', navHTML = '';

  if (viewMode === 'week') {
    const days = Array.from({length:7}, (_, i) => {
      const d = new Date(today); d.setDate(today.getDate() + i); return d;
    });
    subtitleHTML = `${days[0].getDate()} ${MONTH_SHORT[days[0].getMonth()]} – ` +
      `${days[6].getDate()} ${MONTH_SHORT[days[6].getMonth()]} ${days[6].getFullYear()}`;

    contentHTML = `<div class="weekly-grid">` + days.map(d => {
      const iso  = isoDay(d);
      const evs  = eventsForDay(iso);
      const isToday = iso === todayIso;
      return `
        <div class="weekly-day ${isToday ? 'weekly-today' : ''}">
          <div class="weekly-day-header">
            <span class="weekly-day-name">${DAY_LABELS[d.getDay()]}</span>
            <span class="weekly-day-num ${isToday ? 'weekly-day-num-today' : ''}">
              ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}
            </span>
          </div>
          <div class="weekly-events">
            ${evs.length
              ? evs.map(ev => `
                  <div class="weekly-event${ev.done ? ' is-done' : ''}" ${actionAttr(ev)}>
                    <span class="weekly-event-dot" style="background:${cssColor(ev.color)}"></span>
                    <span class="weekly-event-text">${esc(ev.label)}</span>
                  </div>`).join('')
              : `<div class="weekly-free">—</div>`}
          </div>
        </div>`;
    }).join('') + `</div>`;

  } else {
    // -- Vista mensual -----------------------------------
    const offset = App.agendaMonthOffset || 0;
    const ref    = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const year   = ref.getFullYear();
    const month  = ref.getMonth();
    const first  = new Date(year, month, 1);
    const last   = new Date(year, month + 1, 0);
    const startDow = first.getDay();           // 0 = Dom
    const total  = Math.ceil((startDow + last.getDate()) / 7) * 7;

    subtitleHTML = `${MONTH_LONG[month]} ${year}`;
    navHTML = `
      <div style="display:flex;gap:4px;align-items:center">
        <button class="btn btn-ghost btn-sm" id="agendaPrev">←</button>
        <button class="btn btn-ghost btn-sm" id="agendaToday">Hoy</button>
        <button class="btn btn-ghost btn-sm" id="agendaNext">→</button>
      </div>`;

    const MAX_PILLS = 3;

    const cells = Array.from({length: total}, (_, i) => {
      const d = new Date(year, month, 1 - startDow + i);
      return { date: d, inMonth: d.getMonth() === month };
    });

    const dayHeadersHTML = DAY_LABELS.map(l =>
      `<div class="monthly-day-header-cell">${l}</div>`).join('');

    const gridHTML = cells.map(cell => {
      const iso  = isoDay(cell.date);
      const evs  = eventsForDay(iso);
      const isToday = iso === todayIso;
      const shown = evs.slice(0, MAX_PILLS);
      const more  = evs.length - MAX_PILLS;
      return `
        <div class="monthly-cell ${!cell.inMonth ? 'monthly-cell-other' : ''} ${isToday ? 'monthly-cell-today' : ''}">
          <div class="monthly-cell-num ${isToday ? 'monthly-cell-num-today' : ''}">${cell.date.getDate()}</div>
          ${shown.map(ev => `
            <span class="monthly-event-pill${ev.done ? ' is-done' : ''}" ${actionAttr(ev)}
                  style="border-left-color:${cssColor(ev.color)}"
                  title="${esc(ev.label.replace(/^[\S]+\s/,''))}">${esc(ev.label)}</span>`).join('')}
          ${more > 0 ? `<span class="monthly-more" data-month-day="${iso}">+${more} más</span>` : ''}
        </div>`;
    }).join('');

    contentHTML = `
      <div class="monthly-wrapper">
        <div class="monthly-day-headers">${dayHeadersHTML}</div>
        <div class="monthly-grid">${gridHTML}</div>
      </div>`;
  }

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Calendario</div>
          <div class="view-subtitle">${subtitleHTML}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${navHTML}
          <div class="view-toggle-group">
            <button class="view-toggle-btn ${viewMode==='week'?'active':''}" id="agendaWeekBtn">Semana</button>
            <button class="view-toggle-btn ${viewMode==='month'?'active':''}" id="agendaMonthBtn">Mes</button>
          </div>
          <button class="btn btn-ghost btn-sm" id="weeklyAddMeeting">+ Reunión</button>
          <button class="btn btn-ghost btn-sm" id="weeklyAddSubmission">+ Submission</button>
        </div>
      </div>
      ${contentHTML}
    </div>`;

  // -- Event listeners de navegación -----------------------
  $('agendaWeekBtn').addEventListener('click', () => { App.agendaViewMode = 'week';  renderView('weekly'); });
  $('agendaMonthBtn').addEventListener('click', () => { App.agendaViewMode = 'month'; renderView('weekly'); });
  $('agendaPrev')?.addEventListener('click', () => { App.agendaMonthOffset--; renderView('weekly'); });
  $('agendaNext')?.addEventListener('click', () => { App.agendaMonthOffset++; renderView('weekly'); });
  $('agendaToday')?.addEventListener('click', () => { App.agendaMonthOffset = 0; renderView('weekly'); });
  $('weeklyAddMeeting')?.addEventListener('click', showAddMeetingModal);
  $('weeklyAddSubmission')?.addEventListener('click', showAddSubmissionModal);

  // -- Handlers de clic sobre eventos ---------------------
  const attachInspectors = (root) => {
    root.querySelectorAll('[data-inspect-project]').forEach(el =>
      el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject)));
    root.querySelectorAll('[data-inspect-idea]').forEach(el =>
      el.addEventListener('click', () => inspectIdea(+el.dataset.inspectIdea)));
    root.querySelectorAll('[data-inspect-submission]').forEach(el =>
      el.addEventListener('click', () => inspectProject(+el.dataset.inspectSubmission)));
    root.querySelectorAll('[data-inspect-meeting]').forEach(el =>
      el.addEventListener('click', () => inspectMeeting(+el.dataset.inspectMeeting)));
    root.querySelectorAll('[data-open-today]').forEach(el =>              // tarea suelta: se gestiona en Hoy
      el.addEventListener('click', () => { closeModal(); navigate('dashboard'); }));
  };
  attachInspectors(mainContent);

  // -- Clic en "+N más" — modal con todos los eventos del día -
  mainContent.querySelectorAll('[data-month-day]').forEach(pill => {
    pill.addEventListener('click', () => {
      const iso = pill.dataset.monthDay;
      const evs = eventsForDay(iso);
      const d   = new Date(iso + 'T12:00:00');
      const lbl = d.toLocaleDateString('es-CL',
        { weekday:'long', year:'numeric', month:'long', day:'numeric' });
      showModal(`📅 ${lbl}`, `
        <div class="modal-body" style="padding:0">
          ${evs.map(ev => `
            <div ${actionAttr(ev)} class="modal-day-ev-row"
              style="display:flex;align-items:center;gap:10px;padding:9px 16px;
                     border-bottom:1px solid var(--border);cursor:pointer">
              <span style="width:9px;height:9px;border-radius:50%;
                           background:${cssColor(ev.color)};flex-shrink:0"></span>
              <span style="font-size:.82rem;color:var(--text-1);flex:1">${esc(ev.label)}</span>
              <span style="font-size:.7rem;color:var(--text-3)">›</span>
            </div>`).join('')}
        </div>`);
      document.querySelectorAll('.modal-day-ev-row').forEach(row => {
        row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-hover)');
        row.addEventListener('mouseleave', () => row.style.background = '');
      });
      attachInspectors(document.querySelector('.modal'));
    });
  });
}

// ==============================================================
//  VIEW: SUBMISSION TRACKER
// ==============================================================
const DEFAULT_SUB_STAGES = [
  { key:'preparacion',         label:'En preparación', shortLabel:'En prep.',      color:'#64748b', icon:'✍',  order:0 },
  { key:'enviado',             label:'Enviado',         shortLabel:'Enviado',       color:'#38bdf8', icon:'📤', order:1 },
  { key:'en_revision',         label:'En revisión',     shortLabel:'En revisión',   color:'#fbbf24', icon:'⏳', order:2 },
  { key:'revision_solicitada', label:'Rev. solicitada', shortLabel:'Rev. solicit.', color:'#a78bfa', icon:'✏',  order:3 },
  { key:'aceptado',            label:'Aceptado ✓',     shortLabel:'Aceptado ✓',   color:'#34d399', icon:'✅', order:4 },
  { key:'rechazado',           label:'Rechazado',       shortLabel:'Rechazado',     color:'#f87171', icon:'❌', order:5 },
];

// Estado mutable en runtime — reconstruido desde settings al iniciar y al guardar
let SUB_STATUSES    = [...DEFAULT_SUB_STAGES];
let SUB_COLOR_MAP   = Object.fromEntries(DEFAULT_SUB_STAGES.map(s => [s.key, s.color]));
let SUB_SHORT_LABEL = Object.fromEntries(DEFAULT_SUB_STAGES.map(s => [s.key, s.shortLabel]));

/** Devuelve la clave de la primera etapa activa (p.ej. 'preparacion'), respetando customizaciones. */
const _defaultSubKey = () => SUB_STATUSES[0]?.key ?? 'preparacion';

async function _getSubStages() {
  const s = await db.settings.get('ros-sub-stages');
  if (s?.value) try { return JSON.parse(s.value); } catch {}
  return [...DEFAULT_SUB_STAGES];
}

async function _saveSubStages(stages) {
  await db.settings.put({ key: 'ros-sub-stages', value: JSON.stringify(stages) });
  _applySubStages(stages);
}

function _applySubStages(stages) {
  // Los datos pueden venir de un backup ajeno: se limpian claves, etiquetas y colores antes de usarlos en HTML.
  const plain = v => String(v ?? '').replace(/[<>"'`]/g, '');
  stages = (Array.isArray(stages) ? stages : []).filter(s => s && typeof s === 'object').map((s, i) => ({
    ...s,
    key:        String(s.key ?? '').replace(/[^\w-]/g, '') || `etapa_${i}`,
    label:      plain(s.label ?? s.key),
    shortLabel: plain(s.shortLabel ?? s.label ?? s.key),
    color:      cssColor(s.color),
  }));
  if (!stages.length) stages = DEFAULT_SUB_STAGES.map(s => ({ ...s }));
  SUB_STATUSES    = stages;
  SUB_COLOR_MAP   = Object.fromEntries(stages.map(s => [s.key, s.color]));
  SUB_SHORT_LABEL = Object.fromEntries(stages.map(s => [s.key, s.shortLabel]));
}

function subStatusBadge(status) {
  const s = SUB_STATUSES.find(s => s.key === status) || SUB_STATUSES[0];
  return `<span class="badge" style="background:color-mix(in srgb,${cssColor(s.color)} 18%,transparent);
          color:${cssColor(s.color)};border:1px solid color-mix(in srgb,${cssColor(s.color)} 35%,transparent); margin-top: 5px">${s.label}</span>`;
}

// ==============================================================
//  RESEARCH PIPELINE — vista Kanban por etapas de publicación
// ==============================================================
async function _renderSubmissionPipeline(container) {
  const [paperProjects, areas] = await Promise.all([
    db.projects.filter(p => p.type === 'Paper' && !p.archived).toArray(),
    _getAreas(),
  ]);
  const areaMap  = Object.fromEntries(areas.map(a => [a.id, a]));
  const today    = new Date(); today.setHours(0,0,0,0);

  // Agrupar por estado de submission
  const buckets = {};
  SUB_STATUSES.forEach(s => { buckets[s.key] = []; });
  const _defKey = _defaultSubKey();
  paperProjects.forEach(p => {
    const key = p.submissionStatus || _defKey;
    if (buckets[key]) buckets[key].push(p);
    else              buckets[_defKey]?.push(p);
  });

  const deadlineChip = p => {
    if (!p.deadline) return '';
    const d   = Math.round((new Date(p.deadline+'T00:00:00') - today) / 86400000);
    const col  = d < 0 ? 'var(--red)' : d <= 7 ? 'var(--amber)' : 'var(--text-3)';
    const lbl  = d < 0  ? `Vencido ${Math.abs(d)}d`
               : d === 0 ? '¡Hoy!'
               : `${d}d`;
    return `<span style="font-family:var(--font-mono);font-size:.58rem;
                  color:${col};background:color-mix(in srgb,${col} 12%,transparent);
                  border:1px solid color-mix(in srgb,${col} 28%,transparent);
                  padding:1px 5px;border-radius:99px;flex-shrink:0">⏱ ${lbl}</span>`;
  };

  const staleChip = p => {
    if (!p.updatedAt) return '';
    const days = Math.floor((Date.now() - new Date(p.updatedAt)) / 86400000);
    if (days < 14) return '';
    return `<span class="sub-pipe-stale">sin actividad ${days}d</span>`;
  };

  const areaChip = p => {
    const a = p.areaId ? areaMap[p.areaId] : null;
    if (!a) return '';
    return `<span class="area-chip" style="border-color:${cssColor(a.color)};color:${cssColor(a.color)};font-size:.55rem">
      ⊡ ${esc(a.name)}</span>`;
  };

  const cardHTML = p => `
    <div class="sub-pipe-card"
         draggable="true"
         data-project-id="${p.id}"
         data-inspect-project="${p.id}">
      <div class="sub-pipe-card-title">${esc(p.title)}</div>
      ${p.targetVenue ? `<div class="sub-pipe-venue">→ ${esc(p.targetVenue)}</div>` : ''}
      <div class="sub-pipe-card-footer">
        ${deadlineChip(p)}
        ${staleChip(p)}
        ${areaChip(p)}
      </div>
    </div>`;

  const totalPapers = paperProjects.length;
  const inProgress  = paperProjects.filter(p =>
    ['enviado','en_revision','revision_solicitada'].includes(p.submissionStatus)).length;

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
                margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div style="font-family:var(--font-mono);font-size:.72rem;color:var(--text-2)">
        ${totalPapers} paper(s) · ${inProgress} en proceso activo
      </div>
      <div style="display:flex;gap:6px;align-items:center;font-size:.72rem;color:var(--text-3);
                  font-family:var(--font-mono)">
        ${Object.entries(buckets)
          .filter(([,cards]) => cards.length)
          .map(([key, cards]) => {
            const s = SUB_STATUSES.find(s => s.key === key);
            return `<span style="color:${cssColor(s.color)}">${s.shortLabel} ${cards.length}</span>`;
          }).join(' · ')}
      </div>
    </div>
    <div class="sub-pipe-board">
      ${SUB_STATUSES.map(s => `
        <div class="sub-pipe-col"
          data-sub-stage="${esc(s.key)}"
          ondragover="kanbanDragOver(event)"
          ondragleave="kanbanDragLeave(event)"
          ondrop="subPipelineDrop(event)">
          <div class="sub-pipe-col-header">
            <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;
                         display:inline-block;background:${cssColor(s.color)}"></span>
            <span class="sub-pipe-col-title">${s.label}</span>
            <span class="sub-pipe-col-count">${buckets[s.key].length}</span>
          </div>
          <div class="sub-pipe-cards">
            ${buckets[s.key].length
              ? buckets[s.key].map(cardHTML).join('')
              : `<div class="sub-pipe-empty">—</div>`}
          </div>
        </div>`).join('')}
    </div>`;

  container.querySelectorAll('[data-inspect-project]').forEach(el => el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject)));
  container.querySelectorAll('.sub-pipe-card[draggable]').forEach(card => {
    card.addEventListener('dragstart', kanbanDragStart);
    card.addEventListener('dragend',   kanbanDragEnd);
  });
}

// ── NUEVA FUNCIÓN: gestión de rondas de revisión ──────────
async function showSubmissionRoundsModal(projectId) {
  const p = await db.projects.get(projectId);
  if (!p || p.type !== 'Paper') return;
  const rounds = JSON.parse(JSON.stringify(p.submissionRounds || []));

  const DECISIONS = [
    { key: 'major',    label: 'Major Revision',  color: 'var(--red)'    },
    { key: 'minor',    label: 'Minor Revision',  color: 'var(--amber)'  },
    { key: 'reject',   label: 'Rechazado',        color: 'var(--red)'    },
    { key: 'accept',   label: 'Aceptado',         color: 'var(--green)'  },
    { key: 'pending',  label: 'Pendiente',        color: 'var(--text-3)' },
  ];
  const decColor = key => DECISIONS.find(d => d.key === key)?.color || 'var(--text-3)';
  const decLabel = key => DECISIONS.find(d => d.key === key)?.label || key;

  const renderRoundRows = () => rounds.map((r, i) => `
    <div style="background:var(--bg-elevated);border:1px solid var(--border);
                border-radius:var(--radius-md);padding:12px 14px;margin-bottom:8px;
                border-left:3px solid ${decColor(r.decision)}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-family:var(--font-mono);font-size:.72rem;font-weight:600;
                     color:var(--text-1)">Ronda ${i + 1}</span>
        <button class="btn btn-ghost btn-sm rd-del-btn" data-ri="${i}"
                style="color:var(--red);padding:2px 7px;font-size:.65rem">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Enviado</label>
          <input class="form-input rd-submitted" data-ri="${i}" type="date"
                 value="${esc(r.submittedAt || '')}" style="font-size:.78rem;padding:5px 8px">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Decisión</label>
          <select class="form-select rd-decision" data-ri="${i}"
                  style="font-size:.78rem;padding:5px 8px">
            ${DECISIONS.map(d =>
              `<option value="${d.key}" ${r.decision === d.key ? 'selected' : ''}>${d.label}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Fecha decisión</label>
          <input class="form-input rd-decdate" data-ri="${i}" type="date"
                 value="${esc(r.decisionDate || '')}" style="font-size:.78rem;padding:5px 8px">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Venue</label>
          <input class="form-input rd-venue" data-ri="${i}"
                 value="${esc(r.venue || p.targetVenue || '')}"
                 placeholder="Journal / Fondo…"
                 style="font-size:.78rem;padding:5px 8px">
        </div>
        <div class="form-group" style="grid-column:1/-1;margin:0">
          <label class="form-label">Notas (comentarios de revisores)</label>
          <textarea class="form-textarea rd-notes" data-ri="${i}" rows="2"
                    style="font-size:.76rem;font-family:var(--font-mono)"
                    placeholder="Síntesis de la retroalimentación recibida…">${esc(r.notes || '')}</textarea>
        </div>
      </div>
    </div>`).join('');

  showModal(`📤 Rondas de revisión — ${p.title}`, `
    <div class="modal-body">
      <div style="font-size:.78rem;color:var(--text-2);margin-bottom:12px">
        Registra cada envío/ronda de revisión. El historial queda vinculado al proyecto.
      </div>
      <div id="roundsContainer">${renderRoundRows()}</div>
      <button class="btn btn-ghost btn-sm" id="rdAddBtn" style="width:100%;margin-top:4px">
        + Agregar ronda
      </button>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="rdCancel">Cancelar</button>
      <button class="btn btn-primary" id="rdSave">Guardar rondas</button>
    </div>`);

  const reRender = () => {
    $('roundsContainer').innerHTML = renderRoundRows();
    attachRoundHandlers();
  };

  const attachRoundHandlers = () => {
    document.querySelectorAll('.rd-del-btn').forEach(btn => {
      btn.addEventListener('click', () => { rounds.splice(+btn.dataset.ri, 1); reRender(); });
    });
  };
  attachRoundHandlers();

  $('rdAddBtn').addEventListener('click', () => {
    rounds.push({
      id:           Date.now(),
      submittedAt:  localDateISO(),
      decision:     'pending',
      decisionDate: '',
      venue:        p.targetVenue || '',
      notes:        '',
    });
    reRender();
  });

  $('rdCancel').addEventListener('click', closeModal);
  $('rdSave').addEventListener('click', async () => {
    // Leer valores actuales del DOM antes de guardar
    document.querySelectorAll('.rd-submitted').forEach(el => {
      const i = +el.dataset.ri; if (rounds[i]) rounds[i].submittedAt = el.value;
    });
    document.querySelectorAll('.rd-decision').forEach(el => {
      const i = +el.dataset.ri; if (rounds[i]) rounds[i].decision = el.value;
    });
    document.querySelectorAll('.rd-decdate').forEach(el => {
      const i = +el.dataset.ri; if (rounds[i]) rounds[i].decisionDate = el.value;
    });
    document.querySelectorAll('.rd-venue').forEach(el => {
      const i = +el.dataset.ri; if (rounds[i]) rounds[i].venue = el.value.trim();
    });
    document.querySelectorAll('.rd-notes').forEach(el => {
      const i = +el.dataset.ri; if (rounds[i]) rounds[i].notes = el.value.trim();
    });

    await dbWrite(() => db.projects.update(projectId, {
      submissionRounds: rounds,
      updatedAt:        new Date().toISOString(),
    }));
    closeModal();
    showToast('Rondas guardadas ✓', 'success');
    if (App.view === 'project-hub')  renderProjectHub();
    if (App.view === 'submissions')  renderSubmissions();
    if (App.inspectedType === 'project' && App.inspectedId === projectId)
      setTimeout(() => inspectProject(projectId), 150);
  });
}

// ── Gestión de etapas del pipeline — mismo patrón que showManageColumnsModal
async function showManageSubStagesModal() {
  const stages = await _getSubStages();

  const renderRows = () => stages.map((s, i) => `
    <div class="col-manage-row" data-stage-idx="${i}">
      <span class="col-manage-handle" title="Reordenar" style="cursor:grab">⠿</span>
      <input class="form-input stage-manage-icon"  value="${esc(s.icon || '◯')}"
             data-si="${i}"
             style="width:44px;font-size:1rem;text-align:center;padding:5px 4px;flex-shrink:0"
             title="Icono">
      <input class="form-input stage-manage-label" value="${esc(s.label)}"
             data-si="${i}"
             style="flex:2;padding:5px 8px;font-size:.82rem"
             placeholder="Etiqueta larga">
      <input class="form-input stage-manage-short" value="${esc(s.shortLabel)}"
             data-si="${i}"
             style="flex:1;padding:5px 8px;font-size:.78rem"
             placeholder="Corta">
      <input type="color" class="stage-manage-color"
             value="${/^#/.test(s.color) ? s.color : '#64748b'}"
             data-si="${i}"
             style="width:32px;height:32px;border:none;background:none;cursor:pointer;border-radius:6px">
      <button class="btn btn-ghost btn-sm stage-manage-del" data-si="${i}"
              style="color:var(--red)" ${stages.length <= 1 ? 'disabled' : ''}>✕</button>
    </div>`).join('');

  showModal('⚙ Etapas del Pipeline de Submission', `
    <div class="modal-body">
      <div style="font-size:.75rem;color:var(--text-3);margin-bottom:10px">
        Icono · Etiqueta completa · Etiqueta corta · Color.
        Las claves internas se generan del nombre al crear etapas nuevas.
        Los cambios se propagan al Kanban, Hub, Submissions y Ajustes.
      </div>
      <div id="stageManageList">${renderRows()}</div>
      <button class="btn btn-ghost btn-sm" id="stageAddNew"
              style="margin-top:10px;width:100%">+ Nueva etapa</button>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="stageManageCancel">Cancelar</button>
      <button class="btn btn-primary" id="stageManageSave">Guardar cambios</button>
    </div>`);

  $('stageManageCancel').addEventListener('click', closeModal);

  const reRender = () => {
    $('stageManageList').innerHTML = renderRows();
    attachHandlers();
    attachDragToStageRows();
  };

  const attachHandlers = () => {
    document.querySelectorAll('.stage-manage-del').forEach(btn =>
      btn.addEventListener('click', () => { stages.splice(+btn.dataset.si, 1); reRender(); }));
  };
  attachHandlers();

  $('stageAddNew').addEventListener('click', () => {
    stages.push({
      key:        `stage_${Date.now()}`,
      label:      'Nueva etapa',
      shortLabel: 'Nueva',
      color:      '#38bdf8',
      icon:       '◯',
      order:      stages.length,
    });
    reRender();
  });

  // Drag-to-reorder — mismo patrón que showManageColumnsModal.attachDragToRows
  const attachDragToStageRows = () => {
    const list = $('stageManageList');
    if (!list) return;
    let srcIdx = null;
    list.querySelectorAll('.col-manage-row').forEach(row => {
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', e => {
        srcIdx = +row.dataset.stageIdx;
        e.dataTransfer.effectAllowed = 'move';
        row.style.opacity = '.4';
      });
      row.addEventListener('dragend',   () => {
        row.style.opacity = '';
        list.querySelectorAll('.col-manage-row').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover',  e => {
        e.preventDefault();
        if (+row.dataset.stageIdx !== srcIdx) row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const tgtIdx = +row.dataset.stageIdx;
        if (srcIdx === null || srcIdx === tgtIdx) return;
        const [moved] = stages.splice(srcIdx, 1);
        stages.splice(tgtIdx, 0, moved);
        reRender();
      });
    });
  };
  attachDragToStageRows();

  $('stageManageSave').addEventListener('click', async () => {
    // Leer valores del DOM antes de guardar
    document.querySelectorAll('.stage-manage-icon').forEach(inp => {
      const i = +inp.dataset.si;
      if (stages[i]) stages[i].icon       = inp.value.trim()  || stages[i].icon;
    });
    document.querySelectorAll('.stage-manage-label').forEach(inp => {
      const i = +inp.dataset.si;
      if (stages[i]) stages[i].label      = inp.value.trim()  || stages[i].label;
    });
    document.querySelectorAll('.stage-manage-short').forEach(inp => {
      const i = +inp.dataset.si;
      if (stages[i]) stages[i].shortLabel = inp.value.trim()  || stages[i].shortLabel;
    });
    document.querySelectorAll('.stage-manage-color').forEach(inp => {
      const i = +inp.dataset.si;
      if (stages[i]) stages[i].color      = inp.value;
    });
    // Normalizar orden; generar key para etapas nuevas (key temporal = stage_<ts>)
    stages.forEach((s, i) => {
      s.order = i;
      if (/^stage_\d+$/.test(s.key)) {
        s.key = s.label
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 32) || `stage_${i}`;
      }
    });

    await _saveSubStages(stages);   // actualiza SUB_STATUSES, SUB_COLOR_MAP, SUB_SHORT_LABEL

    // Limpiar claves huérfanas del mapping Submission→Kanban
    const _curMap    = await _getSubColMapping();
    const _validKeys = new Set(stages.map(s => s.key));
    const _cleanMap  = Object.fromEntries(
      Object.entries(_curMap).filter(([k]) => _validKeys.has(k))
    );
    if (Object.keys(_curMap).length !== Object.keys(_cleanMap).length) {
      await _saveSubColMapping(_cleanMap);
    }

    closeModal();
    showToast('Etapas guardadas ✓ — propagadas a Kanban, Hub y Submissions', 'success');
    renderView(App.view);           // refrescar la vista actual
  });
}

async function renderSubmissions() {
  const [paperProjects, cols] = await Promise.all([
    db.projects.filter(p => p.type === 'Paper' && !p.archived).toArray(),
    db.kanbanColumns.toArray(),
  ]);
  const colMap = Object.fromEntries(cols.map(c => [c.id, c]));
  paperProjects.sort((a,b) => (b.updatedAt||'').localeCompare(a.updatedAt||''));

  const counts = {};
  SUB_STATUSES.forEach(s => { counts[s.key] = 0; });
  paperProjects.forEach(p => {
    const st = p.submissionStatus || _defaultSubKey();
    if (counts[st] !== undefined) counts[st]++;
  });

  const mode = App.submissionsViewMode || 'pipeline';

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Submissions</div>
          <div class="view-subtitle">${paperProjects.length} paper(s) en seguimiento</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="view-toggle-group">
            <button class="view-toggle-btn ${mode==='list'?'active':''}"
                    id="subViewList" title="Vista lista">☰ Lista</button>
            <button class="view-toggle-btn ${mode==='pipeline'?'active':''}"
                    id="subViewPipeline" title="Vista pipeline">⊞ Pipeline</button>
          </div>
          <button class="btn btn-ghost btn-sm" id="manageSubStagesBtn"
                  title="Gestionar etapas del pipeline">⚙ Etapas</button>
          <button class="btn btn-primary" id="addSubmissionBtn">+ Nuevo Paper</button>
        </div>
      </div>

      <!-- Pipeline de conteos — siempre visible -->
      <div class="sub-pipeline" style="margin-bottom:${mode==='pipeline'?'8':'20'}px">
        ${SUB_STATUSES.map(s => `
          <div class="sub-pipeline-stage" style="cursor:pointer"
               data-sub-filter="${esc(s.key)}" title="Filtrar: ${esc(s.label)}">
            <div class="sub-pipeline-count" style="color:${cssColor(s.color)}">${counts[s.key]}</div>
            <div class="sub-pipeline-label">${s.label}</div>
          </div>`).join('')}
      </div>

      <!-- Contenido según modo -->
      <div id="subContentArea">
        ${mode === 'pipeline' ? '' : paperProjects.length ? `
          <div class="sub-list">
            ${paperProjects.map(p => {
              const status = p.submissionStatus || _defaultSubKey();
              const col    = colMap[p.columnId];
              const today  = new Date(); today.setHours(0,0,0,0);
              const daysToDeadline = p.deadline
                ? Math.round((new Date(p.deadline+'T00:00:00') - today) / 86400000) : null;
              return `
                <div class="sub-card" data-inspect-project="${p.id}">
                  <div class="sub-card-top">
                    <div class="sub-card-title">${esc(p.title)}</div>
                    ${subStatusBadge(status)}
                  </div>
                  <div class="sub-card-meta">
                    ${p.targetVenue ? `<span style="color:var(--text-2);font-size:.75rem">→ ${esc(p.targetVenue)}</span>` : ''}
                    ${col ? `<span style="font-family:var(--font-mono);font-size:.6rem;
                        background:color-mix(in srgb,${cssColor(col.color)} 14%,transparent);
                        color:${cssColor(col.color)};border:1px solid color-mix(in srgb,${cssColor(col.color)} 28%,transparent);
                        padding:1px 6px;border-radius:99px">⊞ ${esc(col.title)}</span>` : ''}
                    ${p.responsible ? `<span style="font-size:.72rem;color:var(--text-3)">👤 ${esc(p.responsible)}</span>` : ''}
                  </div>
                  <div class="sub-card-dates" style="align-items:center;gap:10px">
                    ${p.deadline ? `<span style="font-size:.72rem;font-family:var(--font-mono);
                        color:${daysToDeadline!==null&&daysToDeadline<=7?'var(--red)':'var(--text-3)'}">
                        ⏱ Deadline: ${formatDate(p.deadline)}
                        ${daysToDeadline!==null&&daysToDeadline>=0&&daysToDeadline<=30?`(${daysToDeadline}d)`:''}
                      </span>` : ''}
                    ${p.submittedAt ? `<span style="font-size:.72rem;font-family:var(--font-mono);color:var(--text-3)">
                        ✓ Enviado: ${formatDate(p.submittedAt)}
                      </span>` : ''}
                    ${(() => {
                      // ── NUEVO: tiempo en etapa actual ──────────────
                      const hist  = p.submissionStatusHistory || [];
                      const last  = hist.length ? hist[hist.length - 1].date : p.createdAt;
                      const days  = last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
                      if (days === null) return '';
                      const stale = days > 30;
                      return `<span style="font-size:.68rem;font-family:var(--font-mono);
                        color:${stale ? 'var(--amber)' : 'var(--text-3)'};
                        background:${stale ? 'rgba(251,191,36,.1)' : 'transparent'};
                        border:1px solid ${stale ? 'rgba(251,191,36,.25)' : 'transparent'};
                        padding:1px 6px;border-radius:99px"
                        title="Días en estado actual">
                        ${stale ? '⚠' : '⊙'} ${days}d en "${(SUB_STATUSES.find(s=>s.key===(p.submissionStatus||'preparacion'))||{shortLabel:'?'}).shortLabel}"
                      </span>`;
                    })()}
                    ${(p.submissionRounds||[]).length ? `
                      <span style="font-size:.68rem;font-family:var(--font-mono);
                        color:var(--purple);background:rgba(167,139,250,.1);
                        border:1px solid rgba(167,139,250,.25);
                        padding:1px 6px;border-radius:99px"
                        title="Rondas de revisión registradas">
                        📋 ${p.submissionRounds.length} ronda${p.submissionRounds.length>1?'s':''}
                      </span>` : ''}
                  </div>
                </div>`;
            }).join('')}
          </div>`
        : `<div class="empty-state">
             <span class="empty-state-icon">📤</span>
             <h3>Sin papers en seguimiento</h3>
             <p>Crea un proyecto tipo Paper para comenzar</p>
             <button class="btn btn-primary btn-sm" data-empty-cta="paper" style="margin-top:12px">+ Nuevo Paper</button>
           </div>`}
      </div>
    </div>`;

  // Toggle de vista
  $('subViewList').addEventListener('click', () => {
    App.submissionsViewMode = 'list'; renderSubmissions();
  });
  $('subViewPipeline').addEventListener('click', () => {
    App.submissionsViewMode = 'pipeline'; renderSubmissions();
  });
  $('manageSubStagesBtn')?.addEventListener('click', showManageSubStagesModal);

  // Render pipeline si corresponde
  if (mode === 'pipeline') {
    await _renderSubmissionPipeline($('subContentArea'));
  }

  $('addSubmissionBtn').addEventListener('click', _openNewPaperModal);

  mainContent.querySelectorAll('[data-inspect-project]').forEach(el =>
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject)));

  // Click en etapa del pipeline de conteos → filtrar lista
  mainContent.querySelectorAll('[data-sub-filter]').forEach(el =>
    el.addEventListener('click', () => {
      App.submissionsViewMode = 'list'; renderSubmissions();
      // Podría añadir filtro por status en el futuro
    }));
}

function _openNewPaperModal() {
  App._projectTemplate  = 'paper';
  App._skipTemplateStep = true;
  showAddProjectModal();
}

async function showAddSubmissionModal(prefillDate = null, preProjectId = null) {
  if (typeof prefillDate !== 'string') prefillDate = null;
  if (typeof preProjectId !== 'number') preProjectId = null;
  if (preProjectId) {
    // Editar campos de submission sobre un proyecto existente
    const p = await db.projects.get(preProjectId);
    if (!p) return;
    if (p.type !== 'Paper') {
      showToast('El seguimiento de submission aplica solo a proyectos tipo Paper', 'info');
      return;
    }
    showModal(`📤 Submission — ${p.title}`, `
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Estado</label>
          <select class="form-select" id="asub-status">
            ${SUB_STATUSES.map(s =>
              `<option value="${esc(s.key)}" ${(p.submissionStatus || _defaultSubKey())===s.key?'selected':''}>${esc(s.label)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Venue / Journal / Fondo objetivo</label>
          <input class="form-input" id="asub-venue" value="${esc(p.targetVenue||'')}"
                 placeholder="Nature, FONDECYT, ISMIR 2025…">
        </div>
        <div class="form-group">
          <label class="form-label">Deadline de envío</label>
          <input class="form-input" type="date" id="asub-deadline"
                 value="${esc(prefillDate || p.deadline || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Fecha de envío efectivo</label>
          <input class="form-input" type="date" id="asub-submitted" value="${esc(p.submittedAt||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Notas de submission</label>
          <textarea class="form-textarea" id="asub-notes" rows="2">${esc(p.submissionNotes||'')}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="asubCancel">Cancelar</button>
        <button class="btn btn-primary" id="asubSave">Guardar</button>
      </div>`);
    focusField($('asub-status'));
    $('asubCancel').addEventListener('click', closeModal);
    $('asubSave').addEventListener('click', async () => {
      const newStatus = $('asub-status').value;
      const now = new Date().toISOString();
      await snapshotProject(preProjectId);
      await dbWrite(() => db.projects.update(preProjectId, {
        submissionStatus: newStatus,
        targetVenue:      $('asub-venue').value.trim(),
        deadline:         $('asub-deadline').value || p.deadline || null,
        submittedAt:      $('asub-submitted').value || null,
        submissionNotes:  $('asub-notes').value.trim(),
        updatedAt:        now,
      }));
      await _syncPaperColumn(preProjectId, newStatus);
      closeModal();
      showToast('Submission actualizada ✓', 'success');
      if (App.view === 'submissions')  renderSubmissions();
      if (App.view === 'project-hub')  renderProjectHub();
      if (['projects','kanban'].includes(App.view)) renderView(App.view);
      updateBadges();
    });
  } else {
    // Crear nuevo proyecto tipo Paper
    _openNewPaperModal();
  }
}

// ==============================================================
//  VIEW: LOG DE REUNIONES
// ==============================================================
async function renderMeetings() {
  const [meetings, projects] = await Promise.all([
    db.meetings.orderBy('date').reverse().toArray(),
    db.projects.toArray()
  ]);
  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Reuniones</div>
          <div class="view-subtitle">${meetings.length} reunión(es) registrada(s)</div>
        </div>
        <button class="btn btn-primary" id="addMeetingBtn">+ Reunión</button>
      </div>
      <div class="meetings-list">
        ${meetings.length ? meetings.map(m => {
          const proj = m.projectId ? projMap[m.projectId] : null;
          const ais  = (m.actionItems || []).filter(a => !a.done);
          return `
            <div class="meeting-card" data-inspect-meeting="${m.id}">
              <div class="meeting-card-date">${formatDate(m.date)}${m.time ? ` · ${esc(meetingWhen(m))}` : ''}</div>
              <div class="meeting-card-title">${esc(m.title)}</div>
              ${m.participants ? `<div class="meeting-card-meta">👤 ${esc(m.participants)}</div>` : ''}
              ${proj ? `<div class="meeting-card-meta" style="color:var(--accent)">⬡ ${esc(proj.title)}</div>` : ''}
              ${ais.length ? `<div class="meeting-card-meta" style="color:var(--amber)">
                ⚑ ${ais.length} acción(es) pendiente(s)
              </div>` : ''}
            </div>`;
        }).join('')
        : `<div class="empty-state">
             <span class="empty-state-icon">🗓</span>
             <h3>Sin reuniones registradas</h3>
             <p>Registra reuniones con colaboradores, comités o directores</p>
             <button class="btn btn-primary btn-sm" data-empty-cta="meeting" style="margin-top:12px">+ Reunión</button>
           </div>`}
      </div>
    </div>`;

  $('addMeetingBtn').addEventListener('click', showAddMeetingModal);
  mainContent.querySelectorAll('[data-inspect-meeting]').forEach(el =>
    el.addEventListener('click', () => inspectMeeting(+el.dataset.inspectMeeting)));
}

async function showAddMeetingModal(prefillDate = null, preProjectId = null) {
  if (typeof prefillDate !== 'string') prefillDate = null;      // puede llegar un MouseEvent desde un handler de click
  if (typeof preProjectId !== 'number') preProjectId = null;
  const projects = await db.projects.toArray();
  showModal('🗓 Nueva Reunión', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título / Propósito *</label>
        <input class="form-input" id="am-title" placeholder="Reunión de avance, Defensa capítulo 3…">
      </div>
      <div class="form-group">
        <label class="form-label">Fecha *</label>
        <input class="form-input" type="date" id="am-date" value="${prefillDate || localDateISO()}">
      </div>
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">Hora <span class="form-hint">(opcional)</span></label>
          <input class="form-input" type="time" id="am-time"></div>
        <div class="form-group"><label class="form-label">Duración (min)</label>
          <input class="form-input" type="number" id="am-duration" min="5" max="1440" step="5" placeholder="60"></div>
      </div>
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">Se repite</label>
          <select class="form-select" id="am-repeat">${_repeatOptionsHTML(null)}</select></div>
        <div class="form-group"><label class="form-label">Hasta <span class="form-hint">(opcional)</span></label>
          <input class="form-input" type="date" id="am-until" value="${esc(null?.recurrence?.until || '')}"></div>
      </div>
      <div class="form-group">
        <label class="form-label">Participantes</label>
        <input class="form-input" id="am-participants" placeholder="Dr. García, Dr. Vega…">
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="am-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p => `<option value="${p.id}" ${p.id === preProjectId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Acuerdos / Resumen</label>
        <textarea class="form-textarea" id="am-agreements" rows="3"
          placeholder="Se acordó enviar borrador antes del 15…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Próximos pasos (uno por línea · <code>&gt;persona</code> y fechas como «viernes» funcionan)</label>
        <textarea class="form-textarea" id="am-actions" rows="3"
          placeholder="Revisar sección 2&#10;Enviar datos &gt;vega viernes&#10;Preparar slides mañana"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="amCancel">Cancelar</button>
      <button class="btn btn-primary" id="amSave">Guardar</button>
    </div>`);
  focusField($('am-title'));

  setTimeout(() => {
    const partInput = $('am-participants');
    _attachCollaboratorAutocomplete(partInput, { multi: true });
  }, 80);

  $('amCancel').addEventListener('click', closeModal);
  $('amSave').addEventListener('click', async () => {
    const title = $('am-title').value.trim();
    const date  = $('am-date').value;
    if (!title || !date) { showToast('Título y fecha son requeridos', 'error'); return; }
    // Cada línea admite «>persona» y una fecha: «Enviar datos >vega viernes»
    const people = await db.collaborators.toArray();
    const actionItems = $('am-actions').value.split('\n')
      .map(s => s.trim()).filter(Boolean)
      .map(line => { const c = parseCapture(line, [], new Date(), people);
        return { id: Date.now() + Math.random(), text: c.title || line, done: false, due: c.due, assigneeId: c.assigneeId }; });
    const now = new Date().toISOString(), recurrence = _repeatFromForm('am');
    const { id: newId } = await dbWrite(async () => {
      const id = await db.meetings.add({
        title, date, time: timeOrNull($('am-time').value), duration: $('am-time').value ? durationOrNull($('am-duration').value) : null,
        participants: $('am-participants').value.trim(),
        projectId:    +$('am-project').value || null,
        agreements:   $('am-agreements').value.trim(),
        actionItems, ...(recurrence ? { recurrence } : {}),
        createdAt: now, updatedAt: now
      });
      if (recurrence) await Meetings.expandSeries(id);
      return { id };
    });
    closeModal();
    showToast('Reunión guardada ✓', 'success');
    if (App.view === 'meetings')     renderMeetings();
    if (App.view === 'weekly')       renderWeeklyAgenda();
    if (App.view === 'project-hub')  renderProjectHub();
  });
}

const _REPEATS = [['', 'No se repite'], ['daily:1', 'Cada día'], ['weekly:1', 'Cada semana'], ['weekly:2', 'Cada 2 semanas'], ['monthly:1', 'Cada mes']];
const _repeatOptionsHTML = m => _REPEATS.map(([k, l]) => `<option value="${k}" ${m?.recurrence && `${m.recurrence.freq}:${m.recurrence.interval}` === k ? 'selected' : ''}>${l}</option>`).join('');
/** Regla de repetición de un formulario de reunión (prefijo «am» o «em»), o null. */
const _repeatFromForm = pre => {
  const [freq, interval] = ($(`${pre}-repeat`)?.value || '').split(':');
  return freq ? Tasks.cleanRecurrence({ freq, interval: +interval, until: $(`${pre}-until`)?.value || null }) : null;
};

async function inspectMeeting(id) {
  const m = await db.meetings.get(id);
  if (!m) return;
  _pushInspectorHistory('meeting', id, m.title);
  // resolver colaboradores para chips de participantes
  const _meetCollabs = await db.collaborators.orderBy('name').toArray();
  const _meetCollabByName = Object.fromEntries(
    _meetCollabs.map(c => [c.name.toLowerCase().trim(), c])
  );
  const _participantChips = m.participants
    ? m.participants.split(',').map(n => {
        const name = n.trim();
        const c    = _meetCollabByName[name.toLowerCase()];
        return _personChipHTML(name, c?.id || null, { small: true });
      }).join(' ')
    : null;
  const proj = m.projectId ? await db.projects.get(m.projectId) : null;
  const ais  = m.actionItems || [];
  const whoName = Object.fromEntries(_meetCollabs.map(c => [c.id, c.name]));
  // Pendientes con las personas que asisten (para saber qué tratar en la reunión)
  const attendees = (m.participants || '').split(',').map(n => _meetCollabByName[n.trim().toLowerCase()]).filter(Boolean);
  const attendeePending = [];
  for (const c of attendees) for (const it of await pendingWith(c.id)) attendeePending.push({ ...it, who: c.name });

  inspectorBody.innerHTML = `
    <div>
      <div class="inspector-project-title">${esc(m.title)}</div>
      <div class="inspector-meta">
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Fecha</span>
          <span class="inspector-meta-val">${formatDate(m.date)}${m.time ? ` · ${esc(meetingWhen(m))}` : ''}</span>
        </div>
        ${_participantChips ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Participantes</span>
          <span class="inspector-meta-val" style="display:flex;flex-wrap:wrap;gap:3px">
            ${_participantChips}
          </span>
        </div>` : ''}
        ${proj ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Proyecto</span>
          <span class="inspector-meta-val" style="cursor:pointer;color:var(--accent)"
                id="meetNavProj">${esc(proj.title)}</span>
        </div>` : ''}
      </div>
      ${m.agreements ? `
        <div class="inspector-related-title">Acuerdos / Resumen</div>
        <div class="inspector-desc">${esc(m.agreements)}</div>` : ''}

      <div class="inspector-related-title">
        Próximos pasos
        ${ais.length ? `<span class="subtask-count-badge">${ais.filter(a=>a.done).length}/${ais.length}</span>` : ''}
      </div>
      <div class="subtask-list">
        ${ais.map(a => `
          <div class="subtask-item">
            <button class="subtask-check ${a.done?'done':''}" data-toggle-ai="${esc(a.id)}">${a.done?'✓':''}</button>
            <span class="subtask-text ${a.done?'done':''}">${esc(a.text)}</span>
            ${a.assigneeId ? `<span class="tw-sub" title="Esperando a esta persona">→ ${esc(whoName[a.assigneeId] || '?')}</span>` : ''}
            ${a.due ? `<span class="subtask-due has-due ${!a.done && a.due < localDateISO() ? 'overdue' : ''}" style="cursor:default">${esc(dueLabel(a.due))}</span>` : ''}
          </div>`).join('')}
      </div>

      ${attendeePending.length ? `
        <div class="inspector-related-title">Para tratar con los asistentes (${attendeePending.length})</div>
        ${attendeePending.map(t => `<div class="inspector-related-item" style="display:flex;gap:6px">
          <span style="color:var(--amber)">⏳</span><span style="flex:1">${esc(t.title)}</span>
          <span class="tw-sub">${esc(t.who)}${t.due ? ' · ' + esc(dueLabel(t.due)) : ''}</span></div>`).join('')}` : ''}

      <div class="inspector-actions" style="margin-top:14px">
        <button class="btn btn-ghost btn-sm" id="meetEditBtn">✎ Editar</button>
        <button class="btn btn-danger btn-sm" id="meetDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();

  $('meetNavProj')?.addEventListener('click', () => {
    navigate('projects'); setTimeout(() => inspectProject(proj.id), 120);
  });

  inspectorBody.querySelectorAll('[data-toggle-ai]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const aid = btn.dataset.toggleAi;
      const updated = ais.map(a => a.id == aid ? {...a, done: !a.done, doneAt: a.done ? null : new Date().toISOString()} : a);
      await dbWrite(() => db.meetings.update(id, { actionItems: updated, updatedAt: new Date().toISOString() }));
      inspectMeeting(id);
    });
  });

  $('meetEditBtn').addEventListener('click', async () => {
    const projects = await db.projects.toArray();
    showModal('✎ Editar Reunión', `
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Título *</label>
          <input class="form-input" id="em-title" value="${esc(m.title)}">
        </div>
        <div class="form-group">
          <label class="form-label">Fecha *</label>
          <input class="form-input" type="date" id="em-date" value="${esc(m.date)}">
        </div>
        <div class="form-row-2">
          <div class="form-group"><label class="form-label">Hora <span class="form-hint">(opcional)</span></label>
            <input class="form-input" type="time" id="em-time" value="${esc(m.time || '')}"></div>
          <div class="form-group"><label class="form-label">Duración (min)</label>
            <input class="form-input" type="number" id="em-duration" min="5" max="1440" step="5" value="${esc(m.duration || '')}" placeholder="60"></div>
        </div>
        ${m.seriesId ? `<div class="form-hint" style="margin-bottom:10px">↻ Esta reunión forma parte de una serie: para cambiar cuándo se repite, edita la primera.</div>` : `
        <div class="form-row-2">
          <div class="form-group"><label class="form-label">Se repite</label>
            <select class="form-select" id="em-repeat">${_repeatOptionsHTML(m)}</select></div>
          <div class="form-group"><label class="form-label">Hasta <span class="form-hint">(opcional)</span></label>
            <input class="form-input" type="date" id="em-until" value="${esc(m.recurrence?.until || '')}"></div>
        </div>`}
        <div class="form-group">
          <label class="form-label">Participantes</label>
          <input class="form-input" id="em-participants" value="${esc(m.participants||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Proyecto</label>
          <select class="form-select" id="em-project">
            <option value="">Sin proyecto</option>
            ${projects.map(p => `<option value="${p.id}" ${p.id===m.projectId?'selected':''}>${esc(p.title)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Acuerdos</label>
          <textarea class="form-textarea" id="em-agreements" rows="3">${esc(m.agreements||'')}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="emCancel">Cancelar</button>
        <button class="btn btn-primary" id="emSave">Guardar</button>
      </div>`);
    setTimeout(() => _attachCollaboratorAutocomplete($('em-participants'), { multi: true }), 80);
    $('emCancel').addEventListener('click', closeModal);
    $('emSave').addEventListener('click', async () => {
      const title = $('em-title').value.trim();
      if (!title) { showToast('Título requerido', 'error'); return; }
      await dbWrite(async () => {
        await db.meetings.update(id, {
          title, date: $('em-date').value, time: timeOrNull($('em-time').value), duration: $('em-time').value ? durationOrNull($('em-duration').value) : null,
          participants: $('em-participants').value.trim(),
          projectId:    +$('em-project').value || null,
          agreements:   $('em-agreements').value.trim(),
          ...(m.seriesId ? {} : { recurrence: _repeatFromForm('em') }),
          updatedAt:    new Date().toISOString()
        });
        if (!m.seriesId) await Meetings.expandSeries(id);                       // crea las que falten, actualiza las futuras sin tocar o quita las intactas si ya no se repite
        await EventLinks.fromMeeting(await db.meetings.get(id));                // las tareas ligadas a este bloque siguen su día y su duración
      });
      closeModal(); showToast('Reunión actualizada ✓', 'success');
      inspectMeeting(id);
      if (App.view === 'meetings') renderMeetings();
    });
  });

  $('meetDeleteBtn').addEventListener('click', async () => {
    await deleteWithUndo('meetings', id, 'Eliminar reunión', 'Reunión eliminada');
    closeInspector();
    if (App.view === 'meetings') renderMeetings();
    updateBadges();
  });
}

// ==============================================================
//  VIEW: GESTOR DE REFERENCIAS / BibTeX
// ==============================================================
async function renderReferences() {
  const [refs, projects] = await Promise.all([
    getReferences(),            // ordena en JS: orderBy('year') omitiría las referencias sin año
    db.projects.toArray()
  ]);
  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));

  // Filter by project if set
  const filterProjId = App._refFilterProject || 'all';
  const readFilter = App._refReadFilter || 'all';
  const READ = { toread: ['📖', 'Por leer'], reading: ['👓', 'Leyendo'], read: ['✓', 'Leída'] };
  const visible = (filterProjId === 'all' ? refs : refs.filter(r => r.projectId === +filterProjId))
    .filter(r => readFilter === 'all' || (readFilter === 'none' ? !r.readStatus : r.readStatus === readFilter));

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Referencias</div>
          <div class="view-subtitle">${visible.length} de ${refs.length} referencia(s)</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="importRefsBtn" title="Importar desde Zotero, Mendeley o cualquier gestor (.bib, .ris)">⬆ Importar .bib / .ris</button>
          <input type="file" id="importRefsInput" accept=".bib,.ris,.txt,text/plain" multiple hidden>
          <button class="btn btn-ghost" id="exportBibtexBtn">⬇ .bib</button>
          <button class="btn btn-primary" id="addRefBtn">+ Referencia</button>
        </div>
      </div>

      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
        <div class="read-filter" role="group" aria-label="Estado de lectura">
          ${[['all', 'Todas'], ['toread', '📖 Por leer'], ['reading', '👓 Leyendo'], ['read', '✓ Leídas']].map(([k, l]) =>
            `<button class="filter-chip ${readFilter === k ? 'active' : ''}" data-read-filter="${k}">${l}</button>`).join('')}
        </div>
        <select class="form-select" id="refProjectFilter" style="max-width:240px;font-size:.8rem">
          <option value="all">Todos los proyectos</option>
          ${projects.map(p => `<option value="${p.id}" ${p.id == filterProjId?'selected':''}>${esc(p.title)}</option>`).join('')}
        </select>
      </div>

      <div class="ref-list">
        ${visible.length ? visible.map(r => {
          const proj = r.projectId ? projMap[r.projectId] : null;
          return `
            <div class="ref-card" data-inspect-ref="${r.id}">
              <div class="ref-card-main">
                <div class="ref-card-title">${esc(r.title)}</div>
                <div class="ref-card-authors">${esc(r.authors||'')}${r.year ? ` (${r.year})` : ''}</div>
                ${r.journal ? `<div class="ref-card-journal">${esc(r.journal)}</div>` : ''}
              </div>
              <div class="ref-card-side">
                <button class="read-chip ${r.readStatus || 'none'}" data-ref-read="${r.id}" title="Cambiar estado de lectura">${r.readStatus ? READ[r.readStatus].join(' ') : '＋ estado'}</button>
                ${r.doi ? `<a class="ref-doi-link" href="https://doi.org/${esc(encodeURI(r.doi))}" target="_blank" rel="noopener noreferrer"
                  onclick="event.stopPropagation()">DOI ↗</a>` : ''}
                ${proj ? `<span style="font-size:.65rem;color:var(--accent)">⬡ ${esc(proj.title)}</span>` : ''}
              </div>
            </div>`;
        }).join('')
        : `<div class="empty-state">
             <span class="empty-state-icon">📚</span>
             <h3>Sin referencias</h3>
             <p>Agrega papers y fuentes vinculadas a tus proyectos</p>
             <button class="btn btn-primary btn-sm" data-empty-cta="reference" style="margin-top:12px">+ Referencia</button>
             <button class="btn btn-ghost btn-sm" data-empty-cta="import-bib" style="margin-top:12px">Importar .bib / .ris</button>
           </div>`}
      </div>
    </div>`;

  $('addRefBtn').addEventListener('click', () => showAddReferenceModal());
  mainContent.querySelectorAll('[data-read-filter]').forEach(b => b.addEventListener('click', () => { App._refReadFilter = b.dataset.readFilter; renderReferences(); }));
  mainContent.querySelectorAll('[data-ref-read]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const id = +b.dataset.refRead, cur = refs.find(r => r.id === id)?.readStatus || null;
    const next = { null: 'toread', toread: 'reading', reading: 'read', read: null }[cur];
    const stamp = new Date().toISOString();
    await dbWrite(() => db.references.update(id, { readStatus: next, readAt: next === 'read' ? stamp : null, updatedAt: stamp }));
    renderReferences();
  }));
  $('importRefsBtn').addEventListener('click', () => $('importRefsInput').click());
  $('importRefsInput').addEventListener('change', e => {
    const files = [...e.target.files]; e.target.value = '';
    if (files.length) startReferenceImport(files);
  });

  $('exportBibtexBtn').addEventListener('click', async () => {
    const pid = filterProjId !== 'all' ? +filterProjId : null;
    const bib = await exportBibtex(pid);
    if (!bib.trim()) { showToast('Sin referencias para exportar', 'error'); return; }
    const blob = new Blob([bib], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url, download: `references-${localDateISO()}.bib`
    });
    a.click(); URL.revokeObjectURL(url);
    showToast('.bib exportado ✓', 'success');
  });

  $('refProjectFilter').addEventListener('change', (e) => {
    App._refFilterProject = e.target.value;
    renderReferences();
  });

  mainContent.querySelectorAll('[data-inspect-ref]').forEach(el =>
    el.addEventListener('click', () => inspectReference(+el.dataset.inspectRef)));
}

// -- DOI Lookup via CrossRef (sin auth) -----------------------
async function _lookupDOI(doi) {
  const clean = doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  if (!clean) return null;
  try {
    const res  = await fetch(`https://api.crossref.org/works/${encodeURIComponent(clean)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const m    = data.message;
    return {
      title:   (m.title || [])[0] || '',
      authors: (m.author || [])
        .map(a => [a.family, a.given ? a.given.charAt(0) + '.' : ''].filter(Boolean).join(', '))
        .join('; '),
      year:    m.published?.['date-parts']?.[0]?.[0] || null,
      journal: (m['container-title'] || [])[0] || '',
      doi:     m.DOI || clean,
    };
  } catch { return null; }
}

/** Lee archivos .bib / .ris y abre la vista previa de importación. */
async function startReferenceImport(files) {
  const records = [];
  for (const f of files) {
    const text = await f.text();
    records.push(...(/^\s*TY\s{2}-/m.test(text) ? parseRIS(text) : bibtexToReferences(parseBibtex(text))));
  }
  if (!records.length) return showToast('No se encontraron referencias en el archivo (¿es .bib o .ris?)', 'error');
  const projects = await db.projects.toArray();
  const existing = new Set((await db.references.toArray()).map(refDedupeKey));
  const fresh = records.filter(r => !existing.has(refDedupeKey(r)));
  showModal('⬆ Importar referencias', `
    <div class="modal-body">
      <p style="font-size:.85rem;color:var(--text-2);margin-bottom:12px">
        Se encontraron <strong style="color:var(--text-1)">${records.length}</strong> referencia(s);
        <strong style="color:var(--text-1)">${fresh.length}</strong> son nuevas${records.length - fresh.length ? ` y ${records.length - fresh.length} ya existen (se omitirán)` : ''}.
      </p>
      <div class="form-group">
        <label class="form-label">Vincular a un proyecto (opcional)</label>
        <select class="form-select" id="impRefProject"><option value="">Sin proyecto</option>
          ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}</select>
      </div>
      <div class="import-preview">${fresh.slice(0, 6).map(r => `<div>${esc(r.authors.split(';')[0] || '—')} (${r.year || 's/f'}) — ${esc(r.title.slice(0, 80))}</div>`).join('')}${fresh.length > 6 ? `<div>…y ${fresh.length - 6} más</div>` : ''}</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="impRefCancel">Cancelar</button>
      <button class="btn btn-primary" id="impRefOk" ${fresh.length ? '' : 'disabled'}>Importar ${fresh.length}</button>
    </div>`);
  $('impRefCancel').addEventListener('click', closeModal);
  $('impRefOk').addEventListener('click', async () => {
    const res = await dbWrite(() => importReferences(records, { projectId: +$('impRefProject').value || null }));
    closeModal();
    showToast(`${res.added} referencia(s) importada(s)${res.skipped ? ` · ${res.skipped} ya existían` : ''} ✓`, 'success');
    if (App.view === 'references') renderReferences();
  });
}

async function showAddReferenceModal(preProjectId = null) {
  if (typeof preProjectId !== 'number') preProjectId = null;
  const projects = await db.projects.toArray();
  showModal('📚 Nueva Referencia', `
    <div class="modal-body">
      <!-- DOI Lookup -->
      <div style="font-family:var(--font-mono);font-size:.6rem;text-transform:uppercase;
                  letter-spacing:.09em;color:var(--text-3);margin-bottom:6px">
        ⚡ Búsqueda automática por DOI
      </div>
      <div class="doi-lookup-row">
        <input class="form-input" id="ar-doi-search"
               placeholder="Pega el DOI (10.xxxx/…) y presiona Buscar"
               autocomplete="off">
        <button class="btn btn-ghost btn-sm" id="ar-doi-lookup-btn">🔍 Buscar</button>
      </div>
      <div class="doi-status" id="ar-doi-status">Pega un DOI para auto-rellenar los campos</div>

      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="ar-title" placeholder="A unifying framework for…">
      </div>
      <div class="form-group">
        <label class="form-label">Autores</label>
        <input class="form-input" id="ar-authors" placeholder="García, J., Vega, M.">
      </div>
      <div class="form-group" style="display:flex;gap:10px">
        <div style="flex:1">
          <label class="form-label">Año</label>
          <input class="form-input" type="number" id="ar-year" min="1900" max="2100"
            placeholder="${new Date().getFullYear()}">
        </div>
        <div style="flex:2">
          <label class="form-label">Journal / Conferencia</label>
          <input class="form-input" id="ar-journal" placeholder="Nature, PLOS ONE…">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">DOI</label>
        <input class="form-input" id="ar-doi" placeholder="10.1038/s41586-...">
      </div>
      <div class="form-group">
        <label class="form-label">URL alternativa</label>
        <input class="form-input" id="ar-url" placeholder="https://...">
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="ar-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p => `<option value="${p.id}" ${p.id === preProjectId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Notas personales</label>
        <textarea class="form-textarea" id="ar-notes" rows="2"
          placeholder="Metodología relevante, cita clave, crítica…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="ar-tags" placeholder="methods, review, R">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="arCancel">Cancelar</button>
      <button class="btn btn-primary" id="arSave">Guardar</button>
    </div>`);

  focusField($('ar-doi-search'));

  // DOI Lookup handler
  const doLookup = async () => {
    const doi    = $('ar-doi-search').value.trim();
    const status = $('ar-doi-status');
    if (!doi) { status.textContent = 'Escribe un DOI primero'; return; }
    status.style.color = 'var(--amber)';
    status.textContent = '⏳ Buscando en CrossRef…';
    const result = await _lookupDOI(doi);
    if (!result) {
      status.style.color = 'var(--red)';
      status.textContent = '✕ DOI no encontrado — rellena los campos manualmente';
      return;
    }
    // Rellenar campos
    if (result.title)   $('ar-title').value   = result.title;
    if (result.authors) $('ar-authors').value = result.authors;
    if (result.year)    $('ar-year').value    = result.year;
    if (result.journal) $('ar-journal').value = result.journal;
    if (result.doi)     $('ar-doi').value     = result.doi;
    status.style.color = 'var(--green)';
    status.textContent = `✓ Datos rellenados desde CrossRef · ${result.journal || 'sin journal detectado'}`;
    $('ar-title').focus();
  };

  $('ar-doi-lookup-btn').addEventListener('click', doLookup);
  $('ar-doi-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doLookup(); }
  });

  $('arCancel').addEventListener('click', closeModal);
  $('arSave').addEventListener('click', async () => {
    const title = $('ar-title').value.trim();
    if (!title) { showToast('Título requerido', 'error'); return; }
    const now = new Date().toISOString();
    await dbWrite(() => db.references.add({
      title,
      authors:   $('ar-authors').value.trim(),
      year:      +$('ar-year').value || null,
      journal:   $('ar-journal').value.trim(),
      doi:       $('ar-doi').value.trim(),
      url:       $('ar-url').value.trim(),
      projectId: +$('ar-project').value || null,
      notes:     $('ar-notes').value.trim(),
      tags:      $('ar-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      createdAt: now, updatedAt: now
    }));
    closeModal(); showToast('Referencia guardada ✓', 'success');
    if (App.view === 'references')   renderReferences();
    if (App.view === 'project-hub')  renderProjectHub();
  });
}

async function inspectReference(id) {
  const r = await db.references.get(id);
  if (!r) return;
  _pushInspectorHistory('reference', id, r.title);
  const proj = r.projectId ? await db.projects.get(r.projectId) : null;
  const bibtexKey = `${(r.authors||'').split(',')[0].trim().split(' ').pop()}${r.year||'xxxx'}`;
  const bibtexStr = `@article{${bibtexKey},\n  author  = {${r.authors||''}},\n  title   = {${r.title}},\n  journal = {${r.journal||''}},\n  year    = {${r.year||''}},\n  doi     = {${r.doi||''}}\n}`;

  inspectorBody.innerHTML = `
    <div>
      <div class="inspector-project-title">${esc(r.title)}</div>
      <div class="inspector-meta">
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Autores</span>
          <span class="inspector-meta-val">${esc(r.authors||'—')}</span>
        </div>
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Año</span>
          <span class="inspector-meta-val">${r.year || '—'}</span>
        </div>
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Journal</span>
          <span class="inspector-meta-val">${esc(r.journal||'—')}</span>
        </div>
        ${r.doi ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">DOI</span>
          <span class="inspector-meta-val">
            <a href="https://doi.org/${esc(r.doi)}" target="_blank"
               style="color:var(--accent)">${esc(r.doi)} ↗</a>
          </span>
        </div>` : ''}
        ${proj ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Proyecto</span>
          <span class="inspector-meta-val" style="cursor:pointer;color:var(--accent)"
                id="refNavProj">${esc(proj.title)}</span>
        </div>` : ''}
      </div>
      ${r.notes ? `<div class="inspector-related-title">Notas</div>
        <div class="inspector-desc">${esc(r.notes)}</div>` : ''}
      ${(r.tags||[]).length ? `
        <div class="inspector-related-title">Etiquetas</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
          ${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>` : ''}
      <div class="inspector-related-title">BibTeX</div>
      <div class="ref-bibtex-block">
        <pre style="font-size:.7rem;font-family:var(--font-mono);color:var(--text-2);
                    white-space:pre-wrap;margin:0">${esc(bibtexStr)}</pre>
        <button class="btn btn-ghost btn-sm" id="copyBibtexBtn"
                style="margin-top:6px;font-size:.7rem">📋 Copiar BibTeX</button>
      </div>
      <div class="inspector-actions" style="margin-top:14px">
        <button class="btn btn-ghost btn-sm" id="refEditBtn">✎ Editar</button>
        <button class="btn btn-danger btn-sm" id="refDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();
  $('refNavProj')?.addEventListener('click', () => {
    navigate('projects'); setTimeout(() => inspectProject(proj.id), 120);
  });

  // "Usado en" — backlink al hub del proyecto
  if (r.projectId) {
    db.projects.get(r.projectId).then(p => {
      if (!p) return;
      const usedEl = document.createElement('div');
      usedEl.innerHTML = `
        <div class="inspector-related-title" style="margin-top:14px">Usado en</div>
        <div class="inspector-related-item" style="cursor:pointer;display:flex;align-items:center;gap:6px"
             id="refUsedInHub">
          <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
          <span style="color:var(--accent);flex:1">${esc(p.title)}</span>
          <span style="font-size:.65rem;color:var(--text-3);font-family:var(--font-mono)">Abrir Hub →</span>
        </div>`;
      inspectorBody.querySelector('.inspector-actions')
        ?.insertAdjacentElement('beforebegin', usedEl);
      usedEl.querySelector('#refUsedInHub').addEventListener('click', () => {
        App.projectHubId = p.id; navigate('project-hub');
      });
    });
  }
  $('copyBibtexBtn').addEventListener('click', () => {
    copyText(bibtexStr, 'BibTeX copiado ✓');
  });
  $('refEditBtn').addEventListener('click', async () => {
    const projects = await db.projects.toArray();
    showModal('✎ Editar Referencia', `
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Título *</label>
          <input class="form-input" id="er-title" value="${esc(r.title)}"></div>
        <div class="form-group"><label class="form-label">Autores</label>
          <input class="form-input" id="er-authors" value="${esc(r.authors||'')}"></div>
        <div class="form-group" style="display:flex;gap:10px">
          <div style="flex:1"><label class="form-label">Año</label>
            <input class="form-input" type="number" id="er-year" value="${esc(r.year||'')}"></div>
          <div style="flex:2"><label class="form-label">Journal</label>
            <input class="form-input" id="er-journal" value="${esc(r.journal||'')}"></div>
        </div>
        <div class="form-group"><label class="form-label">DOI</label>
          <input class="form-input" id="er-doi" value="${esc(r.doi||'')}"></div>
        <div class="form-group"><label class="form-label">Proyecto</label>
          <select class="form-select" id="er-project">
            <option value="">Sin proyecto</option>
            ${projects.map(p => `<option value="${p.id}" ${p.id===r.projectId?'selected':''}>${esc(p.title)}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Notas</label>
          <textarea class="form-textarea" id="er-notes" rows="2">${esc(r.notes||'')}</textarea></div>
        <div class="form-group"><label class="form-label">Etiquetas</label>
          <input class="form-input" id="er-tags" value="${esc((r.tags||[]).join(', '))}"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="erCancel">Cancelar</button>
        <button class="btn btn-primary" id="erSave">Guardar</button>
      </div>`);
    $('erCancel').addEventListener('click', closeModal);
    $('erSave').addEventListener('click', async () => {
      const title = $('er-title').value.trim();
      if (!title) { showToast('Título requerido', 'error'); return; }
      await dbWrite(() => db.references.update(r.id, {
        title, authors: $('er-authors').value.trim(),
        year: +$('er-year').value || null,
        journal: $('er-journal').value.trim(),
        doi: $('er-doi').value.trim(),
        projectId: +$('er-project').value || null,
        notes: $('er-notes').value.trim(),
        tags: $('er-tags').value.split(',').map(s => s.trim()).filter(Boolean),
        updatedAt: new Date().toISOString()
      }));
      closeModal(); showToast('Referencia actualizada ✓', 'success');
      inspectReference(r.id);
      if (App.view === 'references') renderReferences();
    });
  });
  $('refDeleteBtn').addEventListener('click', async () => {
    await deleteWithUndo('references', id, 'Eliminar referencia', 'Referencia eliminada');
    closeInspector();
    if (App.view === 'references') renderReferences();
  });
}

// ==============================================================
//  COLLABORATOR HUB
// ==============================================================
async function renderCollaboratorHub() {
  const id = App.collaboratorHubId;
  if (!id) { navigate('collaborators'); return; }

  const [c, projects, meetings, cols] = await Promise.all([
    db.collaborators.get(id),
    db.projects.filter(p => !p.archived).toArray(),
    db.meetings.toArray(),
    db.kanbanColumns.toArray(),
  ]);
  if (!c) { navigate('collaborators'); return; }

  const colMap = Object.fromEntries(cols.map(col => [col.id, col]));

  const asResponsible = projects.filter(p => p.responsible === c.name);
  const asCoauthor    = projects.filter(p =>
    (p.coauthors || []).includes(c.name) && p.responsible !== c.name
  );
  const allLinked    = [...asResponsible, ...asCoauthor];
  const linkedIds    = new Set(allLinked.map(p => p.id));

  const linkedMeets  = meetings.filter(m =>
    (m.participants || '').split(',').map(s => s.trim())
      .some(n => n.toLowerCase() === c.name.toLowerCase()) ||
    (m.projectId && linkedIds.has(m.projectId))
  );
  const linkedPapers = allLinked.filter(p => p.type === 'Paper' && p.submissionStatus);
  const pendingAIs   = linkedMeets.flatMap(m => (m.actionItems || []).filter(a => !a.done));

  // Estadísticas rápidas de actividad
  const now     = Date.now();
  const recent  = allLinked.filter(p => p.updatedAt &&
    now - new Date(p.updatedAt) < 30 * 86400000).length;
  const deadlines = allLinked.filter(p => p.deadline).map(p => {
    const d = new Date(p.deadline + 'T00:00:00');
    return Math.round((d - new Date(new Date().setHours(0,0,0,0))) / 86400000);
  }).filter(d => d >= 0 && d <= 30).sort();

  const hubSection = (sid, label, count, content) => `
    <div class="hub-section">
      <div class="hub-section-header" data-hub-toggle="${sid}">
        <span class="hub-section-title">${label}</span>
        ${count > 0 ? `<span class="hub-section-count">${count}</span>` : ''}
        <span class="hub-chevron" id="chev-${sid}">▾</span>
      </div>
      <div class="hub-section-body" id="hubBody-${sid}">${content}</div>
    </div>`;

  mainContent.innerHTML = `
    <div class="view hub-view">
      <!-- Header -->
      <div class="hub-header">
        <div class="hub-header-flags">
          <span class="hub-flag" style="background:var(--accent-d);color:var(--accent);
                border-color:var(--accent)">👤 Colaborador</span>
          ${c.role ? `<span class="hub-flag hub-flag-arch">${esc(c.role)}</span>` : ''}
        </div>
        <h1 class="hub-title">${esc(c.name)}</h1>
        <div class="hub-meta-row">
          ${c.affiliation ? `<span class="hub-meta-chip">
            <span class="hub-meta-icon">🏛</span>${esc(c.affiliation)}</span>` : ''}
          ${c.email ? `<a href="mailto:${esc(c.email)}" class="hub-meta-chip"
              onclick="event.stopPropagation()"
              style="text-decoration:none;color:inherit">
              <span class="hub-meta-icon">✉</span>${esc(c.email)}</a>` : ''}
          <span class="hub-meta-chip">
            <span class="hub-meta-icon">◉</span>${allLinked.length} proyecto(s)</span>
          ${recent ? `<span class="hub-meta-chip" style="color:var(--green)">
            <span class="hub-meta-icon">⚡</span>${recent} activo(s) este mes</span>` : ''}
          ${pendingAIs.length ? `<span class="hub-meta-chip" style="color:var(--amber)">
            <span class="hub-meta-icon">⚑</span>${pendingAIs.length} acción(es) pendiente(s)</span>` : ''}
          ${deadlines.length ? `<span class="hub-meta-chip" style="color:var(--red)">
            <span class="hub-meta-icon">⏱</span>deadline en ${deadlines[0]}d</span>` : ''}
        </div>
        <div class="hub-action-bar">
          <div class="hub-action-primary">
            <button class="btn btn-ghost btn-sm" id="chubEditBtn">✎ Editar perfil</button>
            <button class="btn btn-ghost btn-sm" id="chubBackBtn">← Colaboradores</button>
          </div>
        </div>
      </div>

      <!-- Proyectos como responsable -->
      ${hubSection('ch-resp',
        `◉ Responsable de (${asResponsible.length})`,
        asResponsible.length,
        asResponsible.length ? asResponsible.map(p => {
          const col  = colMap[p.columnId];
          const today0 = new Date(); today0.setHours(0,0,0,0);
          const dl   = p.deadline
            ? Math.round((new Date(p.deadline + 'T00:00:00') - today0) / 86400000) : null;
          const dlC  = dl === null ? '' : dl < 0 ? 'color:var(--red)' : dl <= 7 ? 'color:var(--amber)' : '';
          return `
            <div class="hub-list-item" data-inspect-project="${p.id}">
              <span class="hub-item-dot" style="background:${col?.color||'var(--accent)'}"></span>
              <span class="hub-item-text">${esc(p.title)}</span>
              <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
              ${col ? `<span style="font-family:var(--font-mono);font-size:.62rem;
                               color:var(--text-3)">${esc(col.title)}</span>` : ''}
              ${p.deadline ? `<span class="hub-item-date" style="${dlC}">
                ⏱ ${formatDate(p.deadline)}</span>` : ''}
            </div>`;
        }).join('')
        : `<div class="hub-empty-hint">Sin proyectos como responsable principal.</div>`
      )}

      <!-- Proyectos como coautor -->
      ${asCoauthor.length ? hubSection('ch-co',
        `👥 Coautor en (${asCoauthor.length})`, asCoauthor.length,
        asCoauthor.map(p => {
          const col = colMap[p.columnId];
          return `
            <div class="hub-list-item" data-inspect-project="${p.id}">
              <span class="hub-item-dot" style="background:${col?.color||'var(--text-3)'}"></span>
              <span class="hub-item-text">${esc(p.title)}</span>
              <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
            </div>`;
        }).join('')
      ) : ''}

      <!-- Reuniones -->
      ${hubSection('ch-meets',
        `🗓 Reuniones (${linkedMeets.length})${pendingAIs.length
          ? ` · <span style="color:var(--amber)">${pendingAIs.length} acc. pendientes</span>` : ''}`,
        linkedMeets.length,
        linkedMeets.length ? linkedMeets.slice(0, 12).map(m => {
          const pending = (m.actionItems || []).filter(a => !a.done).length;
          return `
            <div class="hub-list-item" data-inspect-meeting="${m.id}">
              <span class="hub-item-date" style="min-width:76px">${formatDate(m.date)}</span>
              <span class="hub-item-text">${esc(m.title)}</span>
              ${pending ? `<span class="hub-item-badge-warn">⚑ ${pending}</span>` : ''}
            </div>`;
        }).join('')
        : `<div class="hub-empty-hint">Sin reuniones registradas con este colaborador.</div>`
      )}

      <!-- Papers en submission vinculados al colaborador -->
      ${linkedPapers.length ? hubSection('ch-subs',
        `📤 Papers en submission (${linkedPapers.length})`, linkedPapers.length,
        linkedPapers.map(p => `
          <div class="hub-list-item" data-inspect-project="${p.id}">
            <span class="hub-item-dot"></span>
            <span class="hub-item-text">${esc(p.title)}</span>
            ${subStatusBadge(p.submissionStatus)}
            ${p.targetVenue ? `<span style="font-size:.7rem;color:var(--text-3)">${esc(p.targetVenue)}</span>` : ''}
          </div>`).join('')
      ) : ''}

      <!-- Notas -->
      ${c.notes ? `
        <div class="hub-section">
          <div class="hub-section-header">
            <span class="hub-section-title">📋 Notas de relación</span>
          </div>
          <div class="hub-section-body">
            <div class="hub-desc">${esc(c.notes)}</div>
          </div>
        </div>` : ''}
    </div>`;

  // Section toggle
  mainContent.querySelectorAll('[data-hub-toggle]').forEach(header => {
    header.addEventListener('click', () => {
      const bid  = header.dataset.hubToggle;
      const body = $(`hubBody-${bid}`);
      const chev = $(`chev-${bid}`);
      if (!body) return;
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      if (chev) chev.textContent = hidden ? '▾' : '▸';
    });
  });

  mainContent.querySelectorAll('[data-inspect-project]').forEach(el =>
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject)));
  mainContent.querySelectorAll('[data-inspect-meeting]').forEach(el =>
    el.addEventListener('click', () => inspectMeeting(+el.dataset.inspectMeeting)));
  mainContent.querySelectorAll('[data-inspect-submission]').forEach(el =>
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectSubmission)));

  $('chubBackBtn').addEventListener('click', () => navigate('collaborators'));
  $('chubEditBtn').addEventListener('click', () => {
    inspectCollaborator(id);
    openInspector();
  });
}

// ==============================================================
//  VIEW: COLABORADORES
// ==============================================================
async function renderCollaborators() {
  const [collabs, projects] = await Promise.all([
    db.collaborators.orderBy('name').toArray(),
    db.projects.toArray()
  ]);

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Colaboradores</div>
          <div class="view-subtitle">${collabs.length} colaborador(es)</div>
        </div>
        <button class="btn btn-primary" id="addCollabBtn">+ Colaborador</button>
      </div>
      <div class="collabs-grid">
        ${collabs.length ? collabs.map(c => {
          // Proyectos donde aparece como responsable o coautor
          const linked = projects.filter(p =>
            p.responsible === c.name ||
            (p.coauthors||[]).includes(c.name)
          );
          return `
            <div class="collab-card" data-inspect-collab="${c.id}">
              <div class="collab-avatar">${(c.name||'?')[0].toUpperCase()}</div>
              <div class="collab-info">
                <div class="collab-name">${esc(c.name)}</div>
                ${c.role ? `<div class="collab-role">${esc(c.role)}</div>` : ''}
                ${c.affiliation ? `<div class="collab-affil">${esc(c.affiliation)}</div>` : ''}
                ${c.email ? `<a class="collab-email" href="mailto:${esc(c.email)}"
                  onclick="event.stopPropagation()">${esc(c.email)}</a>` : ''}
                ${linked.length ? `<div class="collab-projects">
                  ${linked.slice(0,3).map(p =>
                    `<span class="tag" style="cursor:pointer" data-inspect-project="${p.id}">⬡ ${esc(p.title)}</span>`
                  ).join('')}
                  ${linked.length > 3 ? `<span class="tag">+${linked.length-3}</span>` : ''}
                </div>` : ''}
              </div>
            </div>`;
        }).join('')
        : `<div class="empty-state" style="grid-column:1/-1">
             <span class="empty-state-icon">👥</span>
             <h3>Sin colaboradores</h3>
             <p>Registra coautores, directores y contactos de investigación</p>
             <button class="btn btn-primary btn-sm" data-empty-cta="collaborator" style="margin-top:12px">+ Colaborador</button>
           </div>`}
      </div>
    </div>`;

  $('addCollabBtn').addEventListener('click', showAddCollaboratorModal);
  mainContent.querySelectorAll('[data-inspect-collab]').forEach(el =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-inspect-project]')) return;
      inspectCollaborator(+el.dataset.inspectCollab);
    }));
  mainContent.querySelectorAll('[data-inspect-project]').forEach(el =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      inspectProject(+el.dataset.inspectProject);
    }));
}

async function showAddCollaboratorModal() {
  showModal('👥 Nuevo Colaborador', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Nombre completo *</label>
        <input class="form-input" id="ac-name" placeholder="Dr. Juan García">
      </div>
      <div class="form-group">
        <label class="form-label">Rol</label>
        <input class="form-input" id="ac-role"
          placeholder="Co-investigador, Director de tesis, Revisor externo…">
      </div>
      <div class="form-group">
        <label class="form-label">Institución / Afiliación</label>
        <input class="form-input" id="ac-affiliation"
          placeholder="Universidad de Chile, CONICET…">
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" type="email" id="ac-email"
          placeholder="jgarcia@universidad.cl">
      </div>
      <div class="form-group">
        <label class="form-label">Notas de relación</label>
        <textarea class="form-textarea" id="ac-notes" rows="2"
          placeholder="Especialista en modelos GAM. Contactar antes de congresos."></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="acCancel">Cancelar</button>
      <button class="btn btn-primary" id="acSave">Guardar</button>
    </div>`);
  focusField($('ac-name'));
  $('acCancel').addEventListener('click', closeModal);
  $('acSave').addEventListener('click', async () => {
    const name = $('ac-name').value.trim();
    if (!name) { showToast('Nombre requerido', 'error'); return; }
    await dbWrite(() => db.collaborators.add({
      name,
      role:        $('ac-role').value.trim(),
      affiliation: $('ac-affiliation').value.trim(),
      email:       $('ac-email').value.trim(),
      notes:       $('ac-notes').value.trim(),
      createdAt:   new Date().toISOString()
    }));
    closeModal(); showToast('Colaborador guardado ✓', 'success');
    if (App.view === 'collaborators') renderCollaborators();
  });
}

async function inspectCollaborator(id) {
  const c = await db.collaborators.get(id);
  if (!c) return;
  _pushInspectorHistory('collaborator', id, c.name);
  const projects = await db.projects.toArray();
  const linked = projects.filter(p =>
    p.responsible === c.name || (p.coauthors||[]).includes(c.name)
  );
  const pending = await pendingWith(id);

  inspectorBody.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div class="collab-avatar" style="width:48px;height:48px;font-size:1.4rem">
          ${(c.name||'?')[0].toUpperCase()}
        </div>
        <div>
          <div class="inspector-project-title" style="margin:0">${esc(c.name)}</div>
          ${c.role ? `<div style="font-size:.78rem;color:var(--text-3)">${esc(c.role)}</div>` : ''}
        </div>
      </div>
      <div class="inspector-meta">
        ${c.affiliation ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Institución</span>
          <span class="inspector-meta-val">${esc(c.affiliation)}</span>
        </div>` : ''}
        ${c.email ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Email</span>
          <span class="inspector-meta-val">
            <a href="mailto:${esc(c.email)}" style="color:var(--accent)">${esc(c.email)}</a>
          </span>
        </div>` : ''}
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Registrado</span>
          <span class="inspector-meta-val">${relativeDate(c.createdAt)}</span>
        </div>
      </div>
      ${c.notes ? `<div class="inspector-related-title">Notas</div>
        <div class="inspector-desc">${esc(c.notes)}</div>` : ''}
      ${pending.length ? `
        <div class="inspector-related-title">Esperando a ${esc(c.name.split(' ')[0])} (${pending.length})</div>
        ${pending.map(t => `<div class="inspector-related-item" style="display:flex;gap:6px;align-items:center">
          <span style="color:var(--amber)">⏳</span><span style="flex:1">${esc(t.title)}</span>
          <span class="tw-sub">${t.projectTitle ? esc(t.projectTitle.slice(0, 22)) : ''}${t.due ? ' · ' + esc(dueLabel(t.due)) : ''}</span></div>`).join('')}
        <button class="btn btn-ghost btn-sm" id="collabAgendaBtn" style="margin-top:6px">📋 Copiar agenda para la reunión</button>` : ''}
      ${linked.length ? `
        <div class="inspector-related-title">Proyectos compartidos (${linked.length})</div>
        ${linked.map(p => `
          <div class="inspector-related-item" data-inspect-project="${p.id}" style="cursor:pointer">
            ⬡ ${esc(p.title)}
          </div>`).join('')}` : ''}
      <div class="inspector-actions" style="margin-top:14px">
        <button class="btn btn-primary btn-sm" id="collabHubBtn">⬡ Abrir Hub</button>
        <button class="btn btn-ghost btn-sm" id="collabEditBtn">✎ Editar</button>
        <button class="btn btn-danger btn-sm" id="collabDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();
  enhanceCollaboratorInspector(c).catch(() => {});     // academic.js: último contacto, seguimiento, correo con la agenda
  $('collabAgendaBtn')?.addEventListener('click', async () => {
    await copyText(await agendaTextFor(c), 'Agenda copiada al portapapeles ✓');
  });
  $('collabHubBtn')?.addEventListener('click', () => {
    App.collaboratorHubId = id;
    navigate('collaborator-hub');
  });
  inspectorBody.querySelectorAll('[data-inspect-project]').forEach(el =>
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject)));

  $('collabEditBtn').addEventListener('click', () => {
    showModal('✎ Editar Colaborador', `
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Nombre *</label>
          <input class="form-input" id="ec-name" value="${esc(c.name)}"></div>
        <div class="form-group"><label class="form-label">Rol</label>
          <input class="form-input" id="ec-role" value="${esc(c.role||'')}"></div>
        <div class="form-group"><label class="form-label">Institución</label>
          <input class="form-input" id="ec-affiliation" value="${esc(c.affiliation||'')}"></div>
        <div class="form-group"><label class="form-label">Email</label>
          <input class="form-input" type="email" id="ec-email" value="${esc(c.email||'')}"></div>
        <div class="form-group"><label class="form-label">Notas</label>
          <textarea class="form-textarea" id="ec-notes" rows="2">${esc(c.notes||'')}</textarea></div>
        <label class="form-check"><input type="checkbox" id="ec-private" ${c.private ? 'checked' : ''}> Privada <span class="form-hint">(la IA no ve esta persona ni lo que la menciona)</span></label>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="ecCancel">Cancelar</button>
        <button class="btn btn-primary" id="ecSave">Guardar</button>
      </div>`);
    $('ecCancel').addEventListener('click', closeModal);
    $('ecSave').addEventListener('click', async () => {
      const name = $('ec-name').value.trim();
      if (!name) { showToast('Nombre requerido', 'error'); return; }
      await dbWrite(() => db.collaborators.update(id, {
        name, role: $('ec-role').value.trim(),
        affiliation: $('ec-affiliation').value.trim(),
        email: $('ec-email').value.trim(),
        notes: $('ec-notes').value.trim(),
        private: $('ec-private').checked
      }));
      closeModal(); showToast('Colaborador actualizado ✓', 'success');
      inspectCollaborator(id);
      if (App.view === 'collaborators') renderCollaborators();
    });
  });
  $('collabDeleteBtn').addEventListener('click', async () => {
    await deleteWithUndo('collaborators', id, `Eliminar a "${c.name}"`, 'Colaborador eliminado');
    closeInspector();
    if (App.view === 'collaborators') renderCollaborators();
  });
}

// ==============================================================
//  PAPER PIPELINE — barra de etapas unificada
// ==============================================================
function _paperPipelineHTML(p, cols) {
  const colMap  = Object.fromEntries(cols.map(c => [c.id, c]));
  const curCol  = colMap[p.columnId];
  const submissionStatus = p.submissionStatus || null;

  const STAGES = [
  // Etapa pre-pipeline — inferida de la columna Kanban cuando no hay submissionStatus
  {
    key:         'draft',
    statusKey:   null,
    label:       'Escritura',
    icon:        '✍',
    color:       'var(--text-3)',
    match:       s => !s,
    colKeywords: ['ideac','escritur','análisis','limpieza'],
  },
  // Etapas dinámicas desde SUB_STATUSES — siempre actualizadas
  ...SUB_STATUSES.map(s => ({
    key:         s.key,
    statusKey:   s.key,
    label:       s.label,
    icon:        s.icon || '◯',
    color:       s.color,
    match:       ss => ss === s.key,
    colKeywords: s.key === 'preparacion' ? ['peer','review','revisión'] : [],
  })),
];

  let activeIdx = 0;
  if (submissionStatus) {
    const idx = STAGES.findIndex(st => st.key !== 'draft' && st.key !== 'internal' && st.match(submissionStatus));
    if (idx >= 0) activeIdx = idx;
    else if (submissionStatus === _defaultSubKey()) activeIdx = 1;
  } else if (curCol) {
    const colTitle = (curCol.title || '').toLowerCase();
    const idx = STAGES.findIndex(st => st.colKeywords.some(kw => colTitle.includes(kw)));
    if (idx >= 0) activeIdx = idx;
  }

  const deadlineLabel = p.deadline
    ? `<span style="font-family:var(--font-mono);font-size:.62rem;color:var(--amber)">⏱ ${formatDate(p.deadline)}</span>`
    : '';

  return `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);
                padding:14px 16px;margin-bottom:14px;overflow-x:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="font-family:var(--font-mono);font-size:.62rem;text-transform:uppercase;
                     letter-spacing:.08em;color:var(--text-3)">Paper Pipeline</span>
        ${deadlineLabel}
      </div>
      <div style="display:flex;align-items:center;gap:2px;min-width:max-content">
        ${STAGES.map((st, i) => {
          const isPast   = i < activeIdx;
          const isActive = i === activeIdx;
          const isFuture = i > activeIdx;
          const color = isActive ? st.color : isPast ? 'var(--text-2)' : 'var(--text-3)';
          return `
            <div style="display:flex;align-items:center;gap:2px">
              <button class="pipeline-stage-btn"
                      data-pipeline-proj="${p.id}"
                      data-pipeline-status="${st.statusKey || ''}"
                      title="${isActive ? 'Estado actual' : 'Mover a: ' + st.label}">
                <div class="pipeline-stage-inner"
                     style="background:${isActive ? 'var(--accent-d)' : 'transparent'};
                            border-color:${isActive ? 'var(--accent)' : 'transparent'}">
                  <span style="font-size:.9rem;line-height:1;opacity:${isFuture ? '.35' : '1'}">${st.icon}</span>
                  <span style="font-size:.62rem;font-family:var(--font-mono);color:${color};
                               white-space:nowrap;font-weight:${isActive ? '600' : '400'}">${st.label}</span>
                </div>
              </button>
              ${i < STAGES.length - 1 ? `<span style="color:var(--text-3);font-size:.7rem;flex-shrink:0;opacity:${i < activeIdx ? '1' : '.3'}">→</span>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

async function _updatePipelineStage(projectId, newStatus) {
  const p = await db.projects.get(projectId);
  if (!p || p.type !== 'Paper') return;

  const current = p.submissionStatus || null;
  if (current === (newStatus || null)) return; // sin cambio

  const now = new Date().toISOString();
  const upd = { submissionStatus: newStatus || null, updatedAt: now };

  // Auto-registrar fecha de envío al marcar como "enviado"
  if (newStatus === 'enviado' && !p.submittedAt)
    upd.submittedAt = localDateISO();           // la fecha local, no la UTC (de noche en América sería «mañana»)

  const statusHistory = Array.isArray(p.submissionStatusHistory)
    ? [...p.submissionStatusHistory] : [];
  statusHistory.push({
    from: p.submissionStatus || null,
    to:   newStatus || null,
    date: now,
  });
  upd.submissionStatusHistory = statusHistory;

  await dbWrite(() => db.projects.update(projectId, upd));
  await _syncPaperColumn(projectId, newStatus);

  const label = newStatus
    ? (SUB_STATUSES.find(s => s.key === newStatus)?.label || newStatus)
    : 'En preparación';
  showToast(`Pipeline → ${label}`, 'success');

  if (App.view === 'project-hub')  renderProjectHub();
  if (App.view === 'submissions')  renderSubmissions();
  if (App.inspectedType === 'project' && App.inspectedId === projectId)
    setTimeout(() => inspectProject(projectId), 200);
}

// ==============================================================
//  PROJECT HUB — Vista unificada por proyecto
// ==============================================================
async function renderProjectHub() {
  const id = App.projectHubId;
  if (!id) { navigate('projects'); return; }

  const [p, cols, ideas, snippets, meetings, references, hubTasks] = await Promise.all([
    db.projects.get(id),
    db.kanbanColumns.toArray(),
    db.ideas.where('projectId').equals(id).toArray(),
    db.snippets.where('projectId').equals(id).toArray(),
    db.meetings.where('projectId').equals(id).toArray(),
    db.references.where('projectId').equals(id).toArray(),
    Tasks.forEntity('project', id),
  ]);
  if (!p) { navigate('projects'); return; }

  const col     = cols.find(c => c.id === p.columnId);
  const colMap  = Object.fromEntries(cols.map(c => [c.id, c]));
  const unreadIdeas = ideas.filter(i => i.status === 'unread').length;
  const pendingAIs  = meetings.flatMap(m => (m.actionItems||[]).filter(a => !a.done));

  const sectionToggle = (id, label, count, content) => `
    <div class="hub-section">
      <div class="hub-section-header" data-hub-toggle="${id}">
        <span class="hub-section-title">${label}</span>
        ${count > 0 ? `<span class="hub-section-count">${count}</span>` : ''}
        <span class="hub-chevron" id="chev-${id}">▾</span>
      </div>
      <div class="hub-section-body" id="hubBody-${id}">${content}</div>
    </div>`;

  // -- Deadline display con color de urgencia --------------
  const today0 = new Date(); today0.setHours(0,0,0,0);
  const dlDiff = p.deadline
    ? Math.round((new Date(p.deadline + 'T00:00:00') - today0) / 86400000) : null;
  const dlColor = dlDiff === null ? 'var(--text-3)'
    : dlDiff < 0  ? 'var(--red)'
    : dlDiff <= 7 ? 'var(--amber)'
    : 'var(--text-2)';
  const dlLabel = dlDiff === null ? null
    : dlDiff < 0  ? `Vencido hace ${Math.abs(dlDiff)}d`
    : dlDiff === 0 ? '¡Hoy!'
    : dlDiff <= 7  ? `en ${dlDiff}d`
    : formatDate(p.deadline);

  mainContent.innerHTML = `
    <div class="view hub-view">
      <!-- -- Hub Header ------------------------------------ -->
      <div class="hub-header">

        <!-- Fila 1: tipo + prioridad + flags -->
        <div class="hub-header-flags">
          <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
          <span class="badge ${prioBadgeClass(p.priority)}">${esc(p.priority)}</span>
          ${p.starred   ? `<span class="hub-flag hub-flag-star">★ Favorito</span>` : ''}
          ${p.archived  ? `<span class="hub-flag hub-flag-arch">Archivado</span>` : ''}
        </div>

        <!-- Fila 2: título -->
        <h1 class="hub-title">${esc(p.title)}</h1>

        <!-- Fila 3a: chips de estado/responsable/deadline -->
        <div class="hub-meta-row">
          ${col ? `
            <span class="hub-meta-chip">
              <span class="hub-meta-dot" style="background:${cssColor(col.color)}"></span>
              ${esc(col.title)}
            </span>` : ''}
          ${p.responsible ? `
            <span class="hub-meta-chip">
              <span class="hub-meta-icon">👤</span>${esc(p.responsible)}
            </span>` : ''}
          ${dlLabel ? `
            <span class="hub-meta-chip" style="color:${dlColor};${dlColor !== 'var(--text-2)' ? `border-color:color-mix(in srgb,${dlColor} 35%,transparent)` : ''}">
              <span class="hub-meta-icon">⏱</span>${dlLabel}
            </span>` : ''}
        </div>

        <!-- Fila 3b: tags (solo si existen) -->
        ${(p.tags||[]).length ? `
        <div class="hub-tags-row">
          ${(p.tags||[]).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>` : ''}
        <!-- Fila 3c: custom fields como chips -->
        ${await (async () => {
          const schemas = await _getTypeSchemas();
          const fields  = schemas?.[p.type] || [];
          const vals    = p.customFields || {};
          const chips   = fields
            .filter(f => vals[f.key] !== undefined && vals[f.key] !== '')
            .map(f => `
              <span class="hub-meta-chip"
                    title="${esc(f.label)}">
                <span class="hub-meta-icon" style="font-size:.65rem">
                  ${f.type === 'number' ? '#' : '·'}
                </span>
                <span style="color:var(--text-3);margin-right:2px">${esc(f.label)}:</span>
                ${f.key.includes('Url') || f.key.includes('url')
                  ? `<a href="${esc(String(vals[f.key]))}" target="_blank"
                        onclick="event.stopPropagation()"
                        style="color:var(--accent);text-decoration:none">↗</a>`
                  : esc(String(vals[f.key]))}
              </span>`);
          return chips.length
            ? `<div class="hub-tags-row">${chips.join('')}</div>`
            : '';
        })()}

        <!-- Fila 4: barra de acciones -->
        <div class="hub-action-bar">
          <!-- Acciones primarias -->
          <div class="hub-action-primary">
            <button class="btn btn-ghost btn-sm" id="hubEditBtn">✎ Editar</button>
            <button class="btn btn-ghost btn-sm" id="hubExportBtn">⬇ Exportar MD</button>
          </div>

          <!-- Menú "+ Agregar" -->
          <div class="hub-add-menu-wrap" id="hubAddMenuWrap">
            <button class="btn btn-primary btn-sm hub-add-trigger" id="hubAddTrigger">
              + Agregar <span class="hub-add-caret">▾</span>
            </button>
            <div class="hub-add-dropdown" id="hubAddDropdown">
              <button class="hub-add-item" id="hubAddIdeaBtn">◎ Idea</button>
              <button class="hub-add-item" id="hubAddMeetingBtn">🗓 Reunión</button>
              <button class="hub-add-item" id="hubAddRefBtn">📚 Referencia</button>
              ${p.type === 'Paper' ? `<button class="hub-add-item" id="hubAddSubBtn">📤 Submission</button>` : ''}
              <button class="hub-add-item" id="hubAddSnipBtn">⟨/⟩ Snippet</button>
            </div>
          </div>
        </div>

      </div>

      <!-- Paper Pipeline unificado -->
      ${p.type === 'Paper' ? _paperPipelineHTML(p, cols) : ''}

      <!-- Completeness bar -->
      <div id="hubCompleteness" style="margin-bottom:16px"></div>

      <!-- Descripción -->
      ${sectionToggle('desc', '📋 Descripción', 0,
        p.description
          ? `<div class="md-preview hub-desc">${renderMd(p.description)}</div>`
          : `<div class="hub-empty-hint">Sin descripción — haz clic en ✎ Editar para agregar una.</div>`
      )}

      <!-- Timeline de actividad reciente del proyecto -->
      ${(() => {
        // Recopilar eventos de todas las fuentes disponibles
        const events = [];
        // Cambios de columna (desde columnHistory)
        const colMap2 = Object.fromEntries(cols.map(c => [c.id, c]));
        (p.columnHistory || []).slice(-4).forEach(h => {
          const c = colMap2[h.colId];
          if (c) events.push({ ts: h.enteredAt, icon: '⬡', label: `Movido a "${c.title}"`, color: c.color });
        });
        // Ideas
        ideas.slice(0, 3).forEach(i => events.push({
          ts: i.createdAt, icon: '◎', label: `Idea: "${i.title.slice(0,35)}"`, color: 'var(--amber)'
        }));
        // Reuniones
        meetings.slice(0, 3).forEach(m => events.push({
          ts: m.date ? m.date + 'T12:00:00' : m.createdAt,
          icon: '🗓', label: `Reunión: "${m.title.slice(0,35)}"`, color: 'var(--teal)'
        }));
        // Submissions
        if (p.type === 'Paper' && p.submittedAt)
          events.push({ ts: p.submittedAt, icon: '📤',
            label: `Enviado: "${p.title.slice(0,30)}"`, color: 'var(--purple)' });

        if (!events.length) return '';
        const sorted = events
          .filter(e => e.ts)
          .sort((a, b) => (b.ts||'').localeCompare(a.ts||''))
          .slice(0, 6);

        return `
          <div class="hub-activity-strip">
            <span class="hub-activity-label">Actividad reciente</span>
            <div class="hub-activity-track">
              ${sorted.map(e => `
                <div class="hub-activity-event" title="${esc(e.label)} · ${relativeDate(e.ts)}">
                  <span class="hub-activity-dot" style="background:${cssColor(e.color)}"></span>
                  <span class="hub-activity-text">${e.icon} ${esc(e.label)}</span>
                  <span class="hub-activity-ts">${relativeDate(e.ts)}</span>
                </div>`).join('')}
            </div>
          </div>`;
      })()}

      <!-- Subtareas del proyecto -->
      ${(() => {
        const tasks = hubTasks;
        const done  = tasks.filter(t => t.done).length;
        return sectionToggle('proj-tasks',
          `✓ Tareas${tasks.length ? ` · <span style="color:var(--green)">${done}/${tasks.length}</span>` : ''}`,
          tasks.length,
          `<div style="padding:10px 14px">${subtaskListHTML(p, 'project', tasks)}</div>`
        );
      })()}

      <!-- Ideas -->
      ${sectionToggle('ideas', `◎ Ideas${unreadIdeas ? ` · <span style="color:var(--amber)">${unreadIdeas} sin revisar</span>` : ''}`, ideas.length,
        ideas.length ? ideas.map(i => `
          <div class="hub-list-item ${i.status==='unread'?'hub-item-unread':''}" data-inspect-idea="${i.id}">
            <span class="hub-item-dot ${i.status==='reviewed'?'reviewed':''}"></span>
            <span class="hub-item-text">${esc(i.title)}</span>
            ${(i.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}
            <span class="hub-item-date">${relativeDate(i.updatedAt)}</span>
          </div>`).join('')
        : `<div class="hub-empty-hint">Sin ideas — agrega la primera con + Idea arriba.</div>`
      )}

      <!-- Submission inline (solo Paper) -->
      ${p.type === 'Paper' ? sectionToggle('subs', '📤 Submission', 0,
        `<div style="padding:10px 14px;display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${subStatusBadge(p.submissionStatus || _defaultSubKey())}
            ${p.targetVenue ? `<span style="font-size:.75rem;color:var(--text-2)">→ ${esc(p.targetVenue)}</span>` : ''}
          </div>
          ${p.deadline    ? `<div style="font-size:.74rem;font-family:var(--font-mono);color:var(--text-3)">⏱ Deadline: ${formatDate(p.deadline)}</div>` : ''}
          ${p.submittedAt ? `<div style="font-size:.74rem;font-family:var(--font-mono);color:var(--green)">✓ Enviado: ${formatDate(p.submittedAt)}</div>` : ''}
          ${(p.submissionRounds||[]).length ? `<div style="font-size:.72rem;color:var(--text-3)">${p.submissionRounds.length} ronda(s) de revisión</div>` : ''}
          <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm hub-sub-edit-btn"
                    style="align-self:flex-start">✎ Editar submission</button>
            <button class="btn btn-ghost btn-sm hub-rounds-btn"
                    style="align-self:flex-start">
              📋 Rondas${(p.submissionRounds||[]).length ? ` (${p.submissionRounds.length})` : ''}
            </button>
          </div>
        </div>`
      ) : ''}

      <!-- Reuniones -->
      ${sectionToggle('meetings', `🗓 Reuniones${pendingAIs.length ? ` · <span style="color:var(--amber)">${pendingAIs.length} acciones pendientes</span>` : ''}`, meetings.length,
        meetings.length ? meetings.map(m => {
          const pending = (m.actionItems||[]).filter(a=>!a.done).length;
          return `
            <div class="hub-list-item" data-inspect-meeting="${m.id}">
              <span class="hub-item-dot"></span>
              <span class="hub-item-date" style="min-width:80px">${formatDate(m.date)}</span>
              <span class="hub-item-text">${esc(m.title)}</span>
              ${pending ? `<span class="hub-item-badge-warn">⚑ ${pending}</span>` : ''}
            </div>`;
        }).join('')
        : `<div class="hub-empty-hint">Sin reuniones registradas.</div>`
      )}

      <!-- Referencias -->
      ${sectionToggle('refs', '📚 Referencias', references.length,
        references.length ? references.map(r => `
          <div class="hub-list-item" data-inspect-ref="${r.id}">
            <span class="hub-item-dot"></span>
            <span class="hub-item-text">${esc(r.authors?.split(',')[0]||'')} (${r.year||'?'}) — ${esc(r.title)}</span>
            ${r.doi ? `<a href="https://doi.org/${esc(r.doi)}" target="_blank"
              onclick="event.stopPropagation()" style="font-size:.68rem;color:var(--accent)">DOI ↗</a>` : ''}
          </div>`).join('')
        : `<div class="hub-empty-hint">Sin referencias. Agrega con + Ref arriba.</div>`
      )}

      <!-- Snippets -->
      ${sectionToggle('snips', '⟨/⟩ Snippets', snippets.length,
        snippets.length ? snippets.map(s => `
          <div class="hub-list-item" data-inspect-snip="${s.id}">
            <span class="snippet-lang-badge lang-${_langClass(s.language)}" style="font-size:.6rem">${esc(s.language||'Other')}</span>
            <span class="hub-item-text">${esc(s.title)}</span>
            <span class="hub-item-date">${relativeDate(s.updatedAt)}</span>
          </div>`).join('')
        : `<div class="hub-empty-hint">Sin snippets vinculados a este proyecto.</div>`
      )}

      <!-- Historial -->
      ${(p._history||[]).length ? sectionToggle('hist', '⑆ Historial', (p._history||[]).length,
        [...(p._history||[])].reverse().slice(0,5).map(snap => `
          <div class="hub-list-item">
            <span class="hub-item-date">${relativeDate(snap.ts)}</span>
            <span class="hub-item-text" style="color:var(--text-3)">${esc(snap.title||'')}</span>
          </div>`).join('')
      ) : ''}
    </div>`;

  // Completeness
  const _hubPct = projectCompleteness(p);
  const _hubCEl = $('hubCompleteness');
  if (_hubCEl) _hubCEl.innerHTML = completenessBarHTML(_hubPct);

  // Section toggle
  mainContent.querySelectorAll('[data-hub-toggle]').forEach(header => {
    header.addEventListener('click', () => {
      const bid  = header.dataset.hubToggle;
      const body = $(`hubBody-${bid}`);
      const chev = $(`chev-${bid}`);
      if (!body) return;
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      if (chev) chev.textContent = hidden ? '▾' : '▸';
    });
  });

  mainContent.querySelectorAll('.pipeline-stage-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const projId = +btn.dataset.pipelineProj;
      const status = btn.dataset.pipelineStatus || null;
      _updatePipelineStage(projId, status);
    });
  });

  // Subtask handlers del Hub
  mainContent.querySelectorAll('[data-toggle-st]').forEach(btn =>
    btn.addEventListener('click', () =>
      toggleSubtask(id, +btn.dataset.toggleSt, 'project')));
  mainContent.querySelectorAll('[data-del-st]').forEach(btn =>
    btn.addEventListener('click', () =>
      deleteSubtask(id, +btn.dataset.delSt, 'project')));
  {
    const stInput  = mainContent.querySelector(`#stInput-${id}`);
    const stAddBtn = mainContent.querySelector(`#stAddBtn-${id}`);
    stAddBtn?.addEventListener('click', () => {
      if (!stInput) return;
      addSubtask(id, stInput.value, 'project');
      stInput.value = '';
    });
    stInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { addSubtask(id, stInput.value, 'project'); stInput.value = ''; }
    });
  }

  // Item inspect handlers
  mainContent.querySelectorAll('[data-inspect-idea]').forEach(el =>
    el.addEventListener('click', () => inspectIdea(+el.dataset.inspectIdea)));
  mainContent.querySelectorAll('[data-inspect-submission]').forEach(el =>
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectSubmission)));
  mainContent.querySelectorAll('[data-inspect-meeting]').forEach(el =>
    el.addEventListener('click', () => inspectMeeting(+el.dataset.inspectMeeting)));
  mainContent.querySelectorAll('[data-inspect-ref]').forEach(el =>
    el.addEventListener('click', () => inspectReference(+el.dataset.inspectRef)));
  mainContent.querySelectorAll('[data-inspect-snip]').forEach(el =>
    el.addEventListener('click', async () => {
      const s = await db.snippets.get(+el.dataset.inspectSnip);
      if (s) inspectSnippet(s);
    }));

  // Toggle del menú "+ Agregar"
  const addTrigger  = $('hubAddTrigger');
  const addDropdown = $('hubAddDropdown');
  addTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = addDropdown.classList.toggle('open');
    addTrigger.classList.toggle('active', open);
  });
  if (App._hubMenuClickHandler) {
    document.removeEventListener('click', App._hubMenuClickHandler);
  }
  App._hubMenuClickHandler = function closeHubMenu(e) {
    if (!$('hubAddMenuWrap')?.contains(e.target)) {
      addDropdown?.classList.remove('open');
      addTrigger?.classList.remove('active');
      document.removeEventListener('click', App._hubMenuClickHandler);
      App._hubMenuClickHandler = null;
    }
  };
  document.addEventListener('click', App._hubMenuClickHandler);
  // Cerrar dropdown al elegir una opción
  addDropdown?.querySelectorAll('.hub-add-item').forEach(btn => {
    btn.addEventListener('click', () => {
      addDropdown.classList.remove('open');
      addTrigger?.classList.remove('active');
    });
  });

  // Header actions
  $('hubEditBtn').addEventListener('click', () => showEditProjectModal(p));
  $('hubExportBtn').addEventListener('click', () => exportProjectAsMarkdown(p.id));

  $('hubAddIdeaBtn').addEventListener('click', () => {
    const now = new Date().toISOString();
    showModal(`+ Idea → ${p.title}`, `
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Título *</label>
          <input class="form-input" id="qi-title" placeholder="Nueva idea…">
        </div>
        <div class="form-group">
          <label class="form-label">Contenido / Nota</label>
          <textarea class="form-textarea" id="qi-content" rows="3"
            placeholder="Detalles, URL, referencia…"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Deadline (opcional)</label>
          <input type="date" class="form-input" id="qi-deadline">
        </div>
        <div class="form-group">
          <label class="form-label">Etiquetas (separadas por coma)</label>
          <input class="form-input" id="qi-tags" placeholder="R, stats, review">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="qiCancel">Cancelar</button>
        <button class="btn btn-primary" id="qiSave">Guardar Idea</button>
      </div>`);
    focusField($('qi-title'));
    $('qiCancel').addEventListener('click', closeModal);
    $('qiSave').addEventListener('click', async () => {
      const title = $('qi-title').value.trim();
      if (!title) { showToast('Título requerido', 'error'); return; }
      await dbWrite(() => db.ideas.add({
        title,
        content:    $('qi-content').value.trim(),
        status:     'unread',
        projectId:  p.id,
        projectIds: [p.id],
        deadline:   $('qi-deadline')?.value || null,
        tags:       $('qi-tags').value.split(',').map(s => s.trim()).filter(Boolean),
        subtasks:   [],
        createdAt:  now, updatedAt: now
      }));
      closeModal();
      showToast('Idea añadida ✓', 'success');
      updateBadges();
      renderProjectHub();   // refrescar el hub para reflejar el nuevo ítem
    });
  });

  $('hubAddMeetingBtn').addEventListener('click', () => showAddMeetingModal(null, p.id));
  $('hubAddRefBtn').addEventListener('click',     () => showAddReferenceModal(p.id));
  $('hubAddSubBtn')?.addEventListener('click',    () => showAddSubmissionModal(null, p.id));
  mainContent.querySelector('.hub-sub-edit-btn')?.addEventListener('click', () => showAddSubmissionModal(null, p.id));
  mainContent.querySelector('.hub-rounds-btn')?.addEventListener('click', () => showSubmissionRoundsModal(id));
  $('hubAddSnipBtn').addEventListener('click',    () => showAddSnippetModal(p.id));
}

// ==============================================================
//  ELEMENTOS HUÉRFANOS
// ==============================================================
async function renderOrphans() {
  const [ideas, snippets, projects, collections] = await Promise.all([
    db.ideas.toArray(),
    db.snippets.toArray(),
    db.projects.toArray(),
    db.snippetCollections.toArray(),
  ]);
  const [refs, meets] = await Promise.all([
    db.references.toArray(),
    db.meetings.toArray(),
  ]);

  // Un elemento también es huérfano si apunta a un proyecto que ya no existe (datos de versiones anteriores).
  const live   = new Set(projects.map(p => p.id));
  const linked = (...ids) => ids.flat().filter(Boolean).some(id => live.has(id));
  const orphanIdeas    = ideas.filter(i => !linked(i.projectId, i.projectIds || []));
  const orphanSnippets = snippets.filter(s => !linked(s.projectId, s.projectIds || []));
  const orphanRefs     = refs.filter(r => !linked(r.projectId));
  const orphanMeets    = meets.filter(m => !linked(m.projectId));
  const total = orphanIdeas.length + orphanSnippets.length + orphanRefs.length + orphanMeets.length;

  App.orphanBulkSelected = new Map(); // reset

  const rowHTML = (item, type, icon) => {
    const key   = `${type}-${item.id}`;
    const label = item.title || item.agreements || 'Sin título';
    return `
      <div class="orphan-row" data-orphan-key="${key}">
        <input type="checkbox" class="orphan-cb"
               data-key="${key}" data-otype="${type}" data-oid="${item.id}"
               data-otitle="${esc(label)}"
               style="accent-color:var(--accent);flex-shrink:0;cursor:pointer">
        <span class="orphan-icon">${icon}</span>
        <span class="orphan-title">${esc(label)}</span>
        <span class="orphan-date">${relativeDate(item.createdAt || item.date)}</span>
        <button class="btn btn-ghost btn-sm orphan-assign-btn"
                data-otype="${type}" data-oid="${item.id}"
                data-otitle="${esc(label)}">Asignar →</button>
        <button class="btn btn-ghost btn-sm orphan-delete-btn"
                data-otype="${type}" data-oid="${item.id}"
                style="color:var(--red)">✕</button>
      </div>`;
  };

  const section = (label, items, icon) => items.length ? `
    <div class="orphan-section">
      <div class="orphan-section-header">${label} <span class="hub-section-count">${items.length}</span></div>
      ${items.map(i => rowHTML(i, icon.type, icon.icon)).join('')}
    </div>` : '';

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Elementos huérfanos</div>
          <div class="view-subtitle">${total} elemento(s) sin proyecto asignado</div>
        </div>
        ${total > 0 ? `
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn btn-ghost btn-sm" id="orphSelectAll">Selec. todos</button>
          <button class="btn btn-ghost btn-sm" id="orphClearSel" style="display:none">Limpiar</button>
        </div>` : ''}
      </div>

      <!-- Bulk action bar — oculta hasta que haya selección -->
      <div id="orphBulkBar" style="display:none;background:var(--bg-card);
           border:1px solid var(--accent);border-radius:var(--radius-lg);
           padding:10px 16px;margin-bottom:14px;
           align-items:center;gap:10px;flex-wrap:wrap">
        <span id="orphBulkCount" style="font-family:var(--font-mono);font-size:.78rem;
              color:var(--text-2);min-width:80px">0 seleccionados</span>
        <div style="flex:1"></div>
        <button class="btn btn-primary btn-sm" id="orphBulkAssign">⬡ Asignar a proyecto</button>
        <button class="btn btn-danger btn-sm" id="orphBulkDelete">✕ Eliminar</button>
      </div>

      ${total === 0
        ? `<div class="empty-state">
             <span class="empty-state-icon">✓</span>
             <h3>Todo conectado</h3>
             <p>No hay ideas, snippets, referencias ni reuniones sin proyecto.</p>
           </div>`
        : `<div class="orphan-list">
             ${section('◎ Ideas sin proyecto', orphanIdeas,    {type:'idea',      icon:'◎'})}
             ${section('⟨/⟩ Snippets sin proyecto', orphanSnippets, {type:'snippet', icon:'⟨/⟩'})}
             ${section('📚 Referencias sin proyecto', orphanRefs,  {type:'reference', icon:'📚'})}
             ${section('🗓 Reuniones sin proyecto', orphanMeets,  {type:'meeting',   icon:'🗓'})}
           </div>`}
    </div>`;

  // -- Bulk checkbox handlers ------------------------------
  const bulkBar     = $('orphBulkBar');
  const bulkCount   = $('orphBulkCount');

  const updateBulkUI = () => {
    const n = App.orphanBulkSelected.size;
    if (bulkBar)   bulkBar.style.display    = n > 0 ? 'flex' : 'none';
    if (bulkCount) bulkCount.textContent    = `${n} seleccionado${n !== 1 ? 's' : ''}`;
    const clearBtn = $('orphClearSel');
    if (clearBtn)  clearBtn.style.display   = n > 0 ? '' : 'none';
  };

  // Mapa de tablas — fuente única para todos los handlers de huérfanos
  const ORPHAN_TABLE_MAP = {
    idea:      db.ideas,
    snippet:   db.snippets,
    reference: db.references,
    meeting:   db.meetings,
  };

  mainContent.querySelectorAll('.orphan-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked)
        App.orphanBulkSelected.set(cb.dataset.key, {
          type:  cb.dataset.otype,
          id:    +cb.dataset.oid,
          title: cb.dataset.otitle
        });
      else
        App.orphanBulkSelected.delete(cb.dataset.key);
      updateBulkUI();
    });
  });

  $('orphSelectAll')?.addEventListener('click', () => {
    mainContent.querySelectorAll('.orphan-cb').forEach(cb => {
      cb.checked = true;
      App.orphanBulkSelected.set(cb.dataset.key, {
        type: cb.dataset.otype, id: +cb.dataset.oid, title: cb.dataset.otitle
      });
    });
    updateBulkUI();
  });

  $('orphClearSel')?.addEventListener('click', () => {
    App.orphanBulkSelected.clear();
    mainContent.querySelectorAll('.orphan-cb').forEach(cb => cb.checked = false);
    updateBulkUI();
  });

  // -- Bulk assign -----------------------------------------
  $('orphBulkAssign')?.addEventListener('click', async () => {
    if (!App.orphanBulkSelected.size) return;
    showModal('Asignar a proyecto', `
      <div class="modal-body">
        <p style="font-size:.8rem;color:var(--text-2);margin-bottom:10px">
          Asignar <strong>${App.orphanBulkSelected.size}</strong> elemento(s) al mismo proyecto:
        </p>
        <div class="form-group">
          <label class="form-label">Proyecto destino</label>
          <select class="form-select" id="orphBulkProjSel">
            <option value="">— Elige un proyecto —</option>
            ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="obCancel">Cancelar</button>
        <button class="btn btn-primary" id="obConfirm">Asignar</button>
      </div>`);

    $('obCancel').addEventListener('click', closeModal);
    $('obConfirm').addEventListener('click', async () => {
      const pid = +$('orphBulkProjSel').value;
      if (!pid) { showToast('Elige un proyecto', 'error'); return; }
      const now = new Date().toISOString();
      await dbWrite(async () => {
        for (const { type, id } of App.orphanBulkSelected.values()) {
          const table = ORPHAN_TABLE_MAP[type];
          if (table) await table.update(id, { projectId: pid, updatedAt: now });
        }
      });
      const n = App.orphanBulkSelected.size;
      App.orphanBulkSelected.clear();
      closeModal();
      showToast(`${n} elemento(s) asignados ✓`, 'success');
      renderOrphans();
    });
  });

  // -- Bulk delete -----------------------------------------
  $('orphBulkDelete')?.addEventListener('click', async () => {
    if (!App.orphanBulkSelected.size) return;
    const n = App.orphanBulkSelected.size;
    if (!(await askConfirm(`Se eliminarán ${n} elemento(s) sin proyecto.`, { title: `¿Eliminar ${n} elemento(s)?`, confirmLabel: 'Eliminar', danger: true }))) return;
    await dbWrite(async () => {
      for (const { type, id } of App.orphanBulkSelected.values()) {
        const table = ORPHAN_TABLE_MAP[type];
        if (table) await table.delete(id);
      }
    });
    App.orphanBulkSelected.clear();
    showToast(`${n} elemento(s) eliminados`, 'info');
    renderOrphans();
  });

  // -- Assign individual -----------------------------------
  const assignModal = async (entityType, entityId, currentTitle) => {
    showModal(`Asignar proyecto — "${currentTitle}"`, `
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Asignar a proyecto</label>
          <select class="form-select" id="orphan-proj-sel">
            <option value="">Sin proyecto (mantener huérfano)</option>
            ${projects.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="orphCancel">Cancelar</button>
        <button class="btn btn-primary" id="orphSave">Asignar</button>
      </div>`);
    $('orphCancel').addEventListener('click', closeModal);
    $('orphSave').addEventListener('click', async () => {
      const pid = +$('orphan-proj-sel').value || null;
      if (!pid) { closeModal(); return; }
      const table = ORPHAN_TABLE_MAP[entityType];
      if (table) await dbWrite(() => table.update(entityId, {
        projectId: pid, updatedAt: new Date().toISOString()
      }));
      closeModal();
      showToast('Asignado ✓', 'success');
      renderOrphans();
    });
  };

  mainContent.querySelectorAll('.orphan-assign-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      assignModal(btn.dataset.otype, +btn.dataset.oid, btn.dataset.otitle));
  });

  mainContent.querySelectorAll('.orphan-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const table = ORPHAN_TABLE_MAP[btn.dataset.otype];
      if (table) await deleteWithUndo(table.name, +btn.dataset.oid, 'Eliminar elemento', 'Elemento eliminado');
      renderOrphans();
    });
  });
}

// ==============================================================
//  IDEA TRIAGE — Revisión rápida con teclado
// ==============================================================
async function renderIdeaTriage() {
  const ideas = await db.ideas.filter(i => i.status === 'unread').toArray();

  if (!ideas.length) {
    mainContent.innerHTML = `
      <div class="view">
        <div class="view-header">
          <div><div class="view-title">✓ Inbox vacío</div>
          <div class="view-subtitle">Todas las ideas han sido revisadas</div></div>
          <button class="btn btn-ghost" id="triageBack">← Volver a Ideas</button>
        </div>
        <div class="empty-state">
          <span class="empty-state-icon">◎</span>
          <h3>¡Inbox a cero!</h3>
          <p>No quedan ideas sin revisar.</p>
        </div>
      </div>`;
    $('triageBack').addEventListener('click', () => navigate('ideas'));
    return;
  }

  App.triageQueue = ideas;
  if (App.triageIdx >= ideas.length) App.triageIdx = 0;
  const idea    = ideas[App.triageIdx];
  const total   = ideas.length;
  const current = App.triageIdx + 1;
  const pct     = Math.round((App.triageIdx / total) * 100);
  const projects = await db.projects.toArray();

  mainContent.innerHTML = `
    <div class="view triage-view">
      <div class="view-header">
        <div>
          <div class="view-title">Revisión rápida</div>
          <div class="view-subtitle">${current} de ${total} ideas sin revisar</div>
        </div>
        <button class="btn btn-ghost" id="triageExitBtn">✕ Salir</button>
      </div>

      <!-- Progress bar + counter -->
      <div class="triage-progress-header">
        <div class="triage-progress-track">
          <div class="triage-progress-bar" style="width:${pct}%"></div>
        </div>
        <span class="triage-counter">${current} / ${total}</span>
      </div>

      <!-- Card -->
      <div class="triage-card" id="triageCard">
        <div class="triage-card-title">${esc(idea.title)}</div>
        ${idea.content ? `<div class="triage-card-content">${esc(idea.content)}</div>` : ''}
        ${(idea.tags||[]).length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:10px">
          ${idea.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}
        </div>` : ''}
        <div class="triage-card-meta">${relativeDate(idea.createdAt)}</div>
      </div>

      <!-- Acciones -->
      <div class="triage-actions">
        <button class="btn triage-btn triage-btn-archive" id="triageBtnArchive"
                title="Eliminar (A)">🗑 Eliminar</button>
        <button class="btn triage-btn triage-btn-project" id="triageBtnProject"
                title="Asignar proyecto (P)">⬡ Proyecto</button>
        <button class="btn triage-btn triage-btn-edit" id="triageBtnEdit"
                title="Expandir / editar (E)">✎ Editar</button>
        <button class="btn triage-btn triage-btn-done" id="triageBtnDone"
                title="Revisada, siguiente (→ o L)">✓ Revisada →</button>
      </div>

      <!-- Keyboard hint -->
      <div class="triage-kbd-hint">
        <kbd>→</kbd> Revisada · <kbd>A</kbd> Eliminar · <kbd>P</kbd> Proyecto · <kbd>E</kbd> Expandir · <kbd>Esc</kbd> Salir
      </div>
    </div>`;

  const next = async (skip = false) => {
    if (!skip) {
      await dbWrite(() => db.ideas.update(idea.id, {
        status: 'reviewed', updatedAt: new Date().toISOString()
      }));
    }
    App.triageIdx++;
    renderIdeaTriage();
  };

  $('triageExitBtn').addEventListener('click', () => navigate('ideas'));
  $('triageBtnDone').addEventListener('click', () => next(false));
  $('triageBtnArchive').addEventListener('click', async () => {
    {
      await deleteWithUndo('ideas', idea.id, 'Eliminar idea', 'Idea eliminada');
      App.triageIdx = Math.max(0, App.triageIdx - 1);
      renderIdeaTriage();
    }
  });
  $('triageBtnEdit').addEventListener('click', () => inspectIdea(idea.id));
  $('triageBtnProject').addEventListener('click', () => {
    showModal('Asignar proyecto', `
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Proyecto</label>
          <select class="form-select" id="triageProjSel">
            <option value="">Sin proyecto</option>
            ${projects.map(p=>`<option value="${p.id}">${esc(p.title)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="tpCancel">Cancelar</button>
        <button class="btn btn-primary" id="tpSave">Asignar y marcar revisada</button>
      </div>`);
    $('tpCancel').addEventListener('click', closeModal);
    $('tpSave').addEventListener('click', async () => {
      const pid = +$('triageProjSel').value || null;
      await dbWrite(() => db.ideas.update(idea.id, {
        projectId: pid,
        projectIds: pid ? [pid] : [],
        status: 'reviewed',
        updatedAt: new Date().toISOString()
      }));
      closeModal(); next(true);
    });
  });

  // Keyboard handler — se destruye al salir de la vista
  const onKey = (e) => {
    if (!mainContent.querySelector('.triage-view')) {
      document.removeEventListener('keydown', onKey);
      App._triageKeyHandler = null;
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (modalOverlay.classList.contains('visible')) return;
    if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'L') next(false);
    else if (e.key === 'a' || e.key === 'A') $('triageBtnArchive')?.click();
    else if (e.key === 'p' || e.key === 'P') $('triageBtnProject')?.click();
    else if (e.key === 'e' || e.key === 'E') $('triageBtnEdit')?.click();
    else if (e.key === 'Escape') {
      document.removeEventListener('keydown', onKey);
      App._triageKeyHandler = null;
      navigate('ideas');
    }
  };
  // Limpiar handler previo si existe
  if (App._triageKeyHandler) {
    document.removeEventListener('keydown', App._triageKeyHandler);
    App._triageKeyHandler = null;
  }
  App._triageKeyHandler = onKey;
  document.addEventListener('keydown', onKey);
}

// ==============================================================
//  VIEW: TUTORIAL & GUÍA DE USO
// ==============================================================
async function renderTutorial() {
  const tab = App._tutorialTab || 'quickstart';

  const TABS = [
    { id: 'quickstart', icon: '🚀', label: 'Inicio Rápido' },
    { id: 'research',   icon: '🔬', label: 'Investigación'  },
    { id: 'teaching',   icon: '🎓', label: 'Docencia'       },
    { id: 'grants',     icon: '💰', label: 'Fondos'         },
    { id: 'team',       icon: '👥', label: 'Equipo'         },
    { id: 'google',     icon: '☁',  label: 'Google & Datos' },
    { id: 'shortcuts',  icon: '⌨',  label: 'Atajos'        },
  ];

  // -- Helpers de bloques HTML --------------------------------
  const step = (n, icon, title, desc, btnLabel = null, btnAttrs = '') => `
    <div class="tut-step-card">
      <div class="tut-step-head">
        <span class="tut-step-num">${n}</span>
        <span style="font-size:1.4rem;line-height:1">${icon}</span>
      </div>
      <div class="tut-step-title">${title}</div>
      <div class="tut-step-desc">${desc}</div>
      ${btnLabel ? `<button class="btn btn-ghost btn-sm tut-action" ${btnAttrs}>→ ${btnLabel}</button>` : ''}
    </div>`;

  const modCard = (icon, title, desc, view) => `
    <div class="tut-mod-card" data-tut-nav="${view}" title="Ir a ${title}">
      <div class="tut-mod-icon">${icon}</div>
      <div class="tut-mod-title">${title}</div>
      <div class="tut-mod-desc">${desc}</div>
    </div>`;

  const wfStep = (icon, label, desc, color = 'var(--accent)') => `
    <div class="tut-wf-step" style="--wfc:${color}">
      <div class="tut-wf-icon">${icon}</div>
      <div class="tut-wf-label">${label}</div>
      <div class="tut-wf-desc">${desc}</div>
    </div>`;

  const sk = (keys, desc) => `
    <div class="tut-sk-row">
      <div class="tut-sk-keys">${keys.map(k => `<kbd class="tut-kbd">${esc(k)}</kbd>`).join(' / ')}</div>
      <div class="tut-sk-desc">${desc}</div>
    </div>`;

  const tip = text => `
    <div class="tut-tip-box">
      <span class="tut-tip-icon">💡</span><div>${text}</div>
    </div>`;

  const ucBox = steps => `
    <div class="tut-usecase-box">
      ${steps.map((s, i) => `
        <div class="tut-uc-step">
          <span class="tut-uc-num">${i + 1}</span><span>${s}</span>
        </div>`).join('')}
    </div>`;

  const featRow = cards => `<div class="tut-feat-row">${cards.join('')}</div>`;
  const feat = (icon, title, body, btnLabel = null, btnAttrs = '') => `
    <div class="tut-feat-card">
      <div class="tut-feat-icon">${icon}</div>
      <div class="tut-feat-title">${title}</div>
      <div class="tut-feat-body">${body}</div>
      ${btnLabel ? `<button class="btn btn-ghost btn-sm tut-action" ${btnAttrs}>${btnLabel} →</button>` : ''}
    </div>`;

  // -- Contenidos por pestaña ---------------------------------
  const CONTENT = {

    // ----------------------------------------------- INICIO RÁPIDO
    quickstart: `
      <div class="tut-section">
        <div class="tut-hero">
          <div style="font-size:2.8rem;line-height:1;flex-shrink:0;color:var(--accent)">⬡</div>
          <div>
            <div class="tut-hero-title">Bienvenido a ResearchOS</div>
            <div class="tut-hero-desc">Herramienta de productividad científica <em>local-first</em>. Sin backend, sin telemetría — tus datos nunca salen de tu navegador. Diseñada para investigadores que gestionan proyectos, docencia, fondos y colaboraciones en paralelo.</div>
          </div>
        </div>

        <div class="tut-tour-card">
          <div>
            <div class="tut-tour-title">▶ Recorrido guiado interactivo</div>
            <div class="tut-tour-desc">Tres minutos, con la app abierta: te lleva a cada pantalla, te ilumina lo importante y te pide hacer un par de cosas para que lo aprendas haciéndolo. Puedes salir y retomarlo cuando quieras.</div>
          </div>
          <div class="tut-tour-actions">
            <button class="btn btn-primary" id="tourStartBtn">${Tour.state().step > 0 && !Tour.state().done ? 'Retomar el recorrido' : 'Empezar el recorrido'}</button>
            <button class="btn btn-ghost" id="tourSampleBtn">Cargar datos de ejemplo</button>
          </div>
        </div>

        <div class="section-title">Primeros pasos</div>
        <div class="tut-step-grid">
          ${step(1, '◉', 'Crea tu primer proyecto', 'Todo gira en torno a proyectos: papers, grants, análisis, datasets, clases, tesis. Elige un tipo y una plantilla — se pre-rellena la estructura.', 'Nuevo Proyecto', 'data-tut-demo="add-project"')}
          ${step(2, '◎', 'Captura una idea', 'El Ideas Inbox es tu área de captura rápida. Anota cualquier cosa antes de que se te olvide — puedes vincularla a un proyecto después.', 'Ir a Ideas', 'data-tut-nav="ideas"')}
          ${step(3, '⊞', 'Organiza con el Kanban', 'Arrastra tarjetas entre columnas para reflejar el estado. ResearchOS guarda el historial de cada movimiento con fecha y hora.', 'Ver Kanban', 'data-tut-nav="kanban"')}
          ${step(4, '🎯', 'Mira la vista Hoy', '¿Qué hacer hoy? La vista Hoy calcula automáticamente qué proyectos necesitan atención según deadlines, acciones pendientes e ideas sin revisar.', 'Abrir Focus', 'data-tut-nav="focus"')}
        </div>

        <div class="section-title" style="margin-top:4px">Todos los módulos</div>
        <div class="tut-mod-grid">
          ${modCard('⊞', 'Kanban', 'Estado visual con drag & drop', 'kanban')}
          ${modCard('⏱', 'Timeline', 'Gantt de deadlines', 'timeline')}
          ${modCard('🎯', 'Hoy', 'Qué toca ahora', 'dashboard')}
          ${modCard('◎', 'Ideas', 'Captura rápida de notas', 'ideas')}
          ${modCard('📤', 'Submissions', 'Seguimiento de envíos', 'submissions')}
          ${modCard('🗓', 'Reuniones', 'Log con action items', 'meetings')}
          ${modCard('📚', 'Referencias', 'BibTeX vinculado', 'references')}
          ${modCard('⟨/⟩', 'Snippets', 'Código por lenguaje', 'snippets')}
          ${modCard('👥', 'Colaboradores', 'Directorio de contactos', 'collaborators')}
          ${modCard('⬡', 'Project Hub', 'Vista unificada', 'projects')}
          ${modCard('🔗', 'Huérfanos', 'Detecta elementos sueltos', 'orphans')}
          ${modCard('⊡', 'Áreas', 'Agrupa por línea de investigación', 'areas')}
          ${modCard('📅', 'Agenda', 'Calendario semanal/mensual', 'weekly')}
          ${modCard('⬡', 'Anidados', 'Árbol de subproyectos', 'nested')}
          ${modCard('⊟', 'Carpetas del proyecto', 'Estructura de directorios', 'filesystem')}
          ${modCard('⚙', 'Ajustes', 'Exportar, importar, Drive', 'settings')}
        </div>

        ${tip(`<strong>Tip de productividad:</strong> Presiona <kbd class="tut-kbd">Ctrl+K</kbd> (o <kbd class="tut-kbd">⌘K</kbd> en Mac) en cualquier momento para buscar en todos tus proyectos, ideas, snippets, reuniones y referencias a la vez — sin salir de la vista actual.`)}
      </div>`,

    // ----------------------------------------------- INVESTIGACIÓN
    research: `
      <div class="tut-section">
        <div class="section-title">Ciclo de vida de un paper</div>
        <div class="tut-workflow">
          ${wfStep('💡', 'Idea', 'Ideas Inbox', 'var(--accent)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('◉', 'Proyecto', 'Tipo Paper + Hub', 'var(--purple)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('📝', 'Escritura', 'Kanban: Escritura', 'var(--amber)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('📤', 'Envío', 'Submission Tracker', 'var(--orange)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('✓', 'Publicado', 'Columna Completado', 'var(--green)')}
        </div>

        <div class="tut-step-grid">
          ${step(1, '◉', 'Crea el proyecto tipo Paper', 'Usa la plantilla "📄 Paper" — pre-rellena tipo, prioridad y estructura Markdown con las secciones del manuscrito. El historial de ediciones queda registrado.', 'Crear Paper', 'data-tut-demo="add-project"')}
          ${step(2, '⬡', 'Abre el Project Hub', 'El Hub muestra en una sola página: descripción, ideas vinculadas, submissions, reuniones, referencias y snippets del proyecto. Accede desde el Inspector → "Abrir Hub".', 'Ver Proyectos', 'data-tut-nav="projects"')}
          ${step(3, '📚', 'Añade bibliografía', 'Agrega referencias vinculadas al proyecto. Exporta el archivo .bib completo con un clic desde la vista Referencias o desde el Hub.', 'Referencias', 'data-tut-nav="references"')}
          ${step(4, '📤', 'Registra el envío al journal', 'El Submission Tracker mantiene el historial completo: rounds de revisión, fechas y estados (preparación → enviado → en revisión → aceptado).', 'Submissions', 'data-tut-nav="submissions"')}
        </div>

        <div class="section-title" style="margin-top:4px">Herramientas para investigación</div>
        ${featRow([
          feat('◎', 'Ideas Inbox + Triage', 'Captura ideas durante la lectura. Usa la <strong>Revisión rápida</strong> para procesarlas con teclado: → revisar, A eliminar, P asignar proyecto.', 'Abrir', 'data-tut-nav="ideas"'),
          feat('⟨/⟩', 'Snippets de código', 'Scripts R, Python, SQL organizados por colecciones y vinculados a proyectos. Resaltado de sintaxis, copia rápida y exportación incluidos.', 'Abrir', 'data-tut-nav="snippets"'),
          feat('⊡', 'Áreas de investigación', 'Crea áreas (Ecología, Modelado, Teledetección) y vincúlalas a proyectos. Filtra la vista Proyectos por área para enfocar una línea a la vez.', 'Abrir', 'data-tut-nav="areas"'),
        ])}

        <div class="section-title" style="margin-top:4px">Ciclo de un análisis de datos</div>
        <div class="tut-workflow">
          ${wfStep('📥', 'Datos', 'Dataset como proyecto', 'var(--teal)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('⟨/⟩', 'Scripts', 'Snippets R/Python vinculados', 'var(--accent)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('◎', 'Ideas', 'Hallazgos e hipótesis', 'var(--purple)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('📊', 'Figuras', 'Snippets de visualización', 'var(--amber)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('📄', 'Paper', 'Proyecto Paper derivado', 'var(--green)')}
        </div>

        ${tip('<strong>Flujo recomendado:</strong> Para un análisis complejo, crea un proyecto tipo "Análisis" con área asignada, vincula los snippets R/Python relevantes, agrega ideas con los pasos metodológicos como subtareas, y registra las reuniones de revisión con fechas y acuerdos.')}
      </div>`,

    // ----------------------------------------------- DOCENCIA
    teaching: `
      <div class="tut-section">
        <div class="tut-hero tut-hero-sm">
          <div style="font-size:2.2rem;flex-shrink:0;line-height:1">🎓</div>
          <div>
            <div class="tut-hero-title">ResearchOS para Docencia</div>
            <div class="tut-hero-desc">Gestiona cursos, supervisa tesistas y registra el avance de tus estudiantes con las mismas herramientas que usas para investigación — sin duplicar sistemas.</div>
          </div>
        </div>

        <div class="section-title">Supervisión de tesistas — flujo paso a paso</div>
        <div class="tut-step-grid">
          ${step(1, '◉', 'Un proyecto por tesista', 'Tipo "Proyecto", responsable = nombre del alumno, deadline = fecha de defensa. La descripción Markdown guarda el título de tesis y el plan de trabajo.', 'Nuevo Proyecto', 'data-tut-demo="add-project"')}
          ${step(2, '🗓', 'Registra cada reunión de avance', 'Documenta acuerdos y próximos pasos. Los action items aparecen en el Hoy hasta completarse — ningún compromiso se pierde.', 'Nueva Reunión', 'data-tut-demo="add-meeting"')}
          ${step(3, '◎', 'Correcciones como ideas con subtareas', 'Cada vez que identifies algo que el tesista debe mejorar, créalo como Idea con subtareas desglosadas. El progreso queda visible y trazable.', 'Nueva Idea', 'data-tut-demo="add-idea"')}
          ${step(4, '⬡', 'El Hub como bitácora completa', 'El Hub del proyecto muestra en una sola página el historial completo: reuniones, correcciones, referencias, deadlines y progreso de cada capítulo.', 'Ver Proyectos', 'data-tut-nav="projects"')}
        </div>

        <div class="section-title" style="margin-top:4px">Gestión de cursos y asignaturas</div>
        ${featRow([
          feat('📋', 'Curso como Proyecto', 'Crea cada asignatura como proyecto tipo "Proyecto". Usa la descripción Markdown para el programa, los contenidos y los criterios de evaluación con formato estructurado.'),
          feat('📅', 'Agenda integrada', 'Las evaluaciones, reuniones de comité y entregas aparecen automáticamente en la Agenda Semanal y el Timeline junto con todos tus proyectos de investigación.', 'Ver Agenda', 'data-tut-nav="weekly"'),
          feat('⬡', 'Proyectos anidados', 'Estructura un programa con sus asignaturas como subproyectos, o una tesis con sus capítulos. La vista Anidados muestra el árbol completo con estado de cada nodo.', 'Ver Anidados', 'data-tut-nav="nested"'),
        ])}

        <div class="section-title" style="margin-top:4px">Caso de uso: tesista de magíster</div>
        ${ucBox([
          'Crea proyecto <strong>"Tesis Mg. [Nombre]"</strong> — tipo "Proyecto", responsable = nombre del alumno, deadline = fecha de defensa, área = "Docencia".',
          'Agrega ideas iniciales: "Cap. 1 — Introducción", "Cap. 2 — Metodología", "Cap. 3 — Resultados" con subtareas para cada sub-sección.',
          'Después de cada reunión, registra acuerdos y asigna próximos pasos como action items. Quedan en Hoy y en el Hoy hasta completarse.',
          'Usa el <strong>Hoy</strong> semanalmente para revisar todos los action items pendientes de tus tesistas de un vistazo.',
          'En reuniones de comisión, registra los comentarios de cada evaluador como ideas vinculadas al proyecto con subtareas de corrección.',
        ])}

        ${tip('<strong>Tip:</strong> Crea un Área "Docencia" y vincúlala a todos los proyectos de supervisión y cursos. Así puedes filtrar solo la carga docente en la vista Proyectos y separarla del trabajo de investigación puro.')}
      </div>`,

    // ----------------------------------------------- FONDOS
    grants: `
      <div class="tut-section">
        <div class="tut-hero tut-hero-sm">
          <div style="font-size:2.2rem;flex-shrink:0;line-height:1">💰</div>
          <div>
            <div class="tut-hero-title">Gestión de Postulaciones</div>
            <div class="tut-hero-desc">Desde la formulación de la propuesta hasta el seguimiento post-adjudicación, ResearchOS cubre todo el ciclo de vida de tus fondos de investigación.</div>
          </div>
        </div>

        <div class="section-title">Ciclo de una postulación FONDECYT</div>
        <div class="tut-workflow">
          ${wfStep('📋', 'Formulación', 'Grant + Submission "Preparación"', 'var(--text-3)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('✍', 'Escritura', 'Kanban → Escritura', 'var(--accent)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('📤', 'Enviado', 'Submission → Enviado', 'var(--amber)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('⏳', 'Revisión', 'Submission → En revisión', 'var(--purple)')}
          <div class="tut-wf-arrow">→</div>
          ${wfStep('✓', 'Adjudicado', 'Submission → Aceptado', 'var(--green)')}
        </div>

        <div class="tut-step-grid">
          ${step(1, '💰', 'Crea el proyecto de postulación', 'Usa la plantilla "💰 Grant FONDECYT" — pre-rellena tipo, prioridad y estructura de secciones requeridas. Añade la convocatoria como deadline.', 'Crear Grant', 'data-tut-demo="add-project"')}
          ${step(2, '📤', 'Registra la submission', 'Crea el registro en Submission Tracker vinculado al proyecto con el fondo objetivo (FONDECYT Regular, Iniciación, ANID-FONIS…) y el deadline oficial.', 'Nueva Submission', 'data-tut-demo="add-sub"')}
          ${step(3, '📚', 'Vincula la bibliografía clave', 'Agrega las referencias del marco teórico y metodología. Exporta el .bib cuando necesites entregar el listado bibliográfico en la plataforma del fondo.', 'Nueva Referencia', 'data-tut-demo="add-ref"')}
          ${step(4, '👥', 'Registra co-investigadores', 'Agrega a los co-PI y colaboradores en Colaboradores. El autocompletado los sugiere al escribir en los campos "Responsable" y "Coautores" del proyecto.', 'Colaboradores', 'data-tut-nav="collaborators"')}
        </div>

        <div class="section-title" style="margin-top:4px">Gestión de deadlines críticos</div>
        ${featRow([
          feat('⏱', 'Timeline para planificación estratégica', 'Vista Gantt con zoom semana/mes/<strong>año</strong>. Visualiza simultáneamente los deadlines de todas las convocatorias activas, reuniones de equipo y hitos del proyecto.', 'Ver Timeline', 'data-tut-nav="timeline"'),
          feat('🎯', 'Hoy: lo que toca ahora', 'La vista Hoy junta tareas atrasadas y de hoy, fechas límite, reuniones y acciones pendientes de la semana, ideas por revisar y lo que está esperando respuesta. Marca una tarea con el círculo, pospónla con ⋯. Activa notificaciones del navegador en Ajustes para recordatorios.', 'Hoy', 'data-tut-nav="dashboard"'),
          feat('⚡', 'Captura rápida', 'Escribe en la barra de Hoy (atajo C, o Ctrl+K desde cualquier vista): «llamar a imprenta mañana @alfa !alta» crea una tarea en ese proyecto con fecha y prioridad. «idea: …», «p: …» o «r: …» fuerzan el tipo.', 'Hoy', 'data-tut-nav="dashboard"'),
          feat('⊡', 'Áreas como contexto', 'Define tus frentes (Investigación, Docencia, Gestión…) en Áreas y elige uno en el selector del menú: Hoy, el Tablero y Proyectos muestran solo ese frente. «Todas las áreas» vuelve a la vista completa.', 'Áreas', 'data-tut-nav="areas"'),
          feat('🔗', 'Enlaces [[ ]]', 'Escribe [[ en cualquier nota o descripción para enlazar con un proyecto, idea, snippet, referencia o reunión (con autocompletado). El elemento enlazado muestra desde dónde lo mencionan.', 'Ideas', 'data-tut-nav="ideas"'),
          feat('🗓', 'Revisión semanal', 'Un repaso guiado de diez minutos: ideas sin revisar, tareas atrasadas, proyectos quietos (no cuentan los que esperan respuesta ni los terminados), próximos 14 días y backup.', 'Revisión semanal', 'data-tut-nav="review"'),
          feat('☁', 'Respaldo en Google Drive', 'Conecta Drive para sincronizar entre dispositivos. El auto-guardado sube los cambios 60 segundos después de cada edición. Comparte el backup con tu equipo de co-PI.', 'Configurar', 'data-tut-nav="settings"'),
        ])}

        ${tip('<strong>Tip:</strong> Usa las Ideas vinculadas al proyecto del grant para anotar los puntos débiles que los revisores podrían señalar — con subtareas para cada corrección necesaria. Así nada queda pendiente antes del envío oficial.')}
      </div>`,

    // ----------------------------------------------- EQUIPO
    team: `
      <div class="tut-section">
        <div class="tut-hero tut-hero-sm">
          <div style="font-size:2.2rem;flex-shrink:0;line-height:1">👥</div>
          <div>
            <div class="tut-hero-title">Gestión de Equipo</div>
            <div class="tut-hero-desc">Coordina investigadores, tesistas, colaboradores externos y co-autores manteniendo toda la información del equipo centralizada y conectada a los proyectos.</div>
          </div>
        </div>

        <div class="tut-step-grid">
          ${step(1, '👤', 'Registra a tu equipo', 'Agrega cada persona en Colaboradores: nombre, rol (tesista, co-investigador, colaborador externo), institución y email. El autocompletado los sugiere en todos los campos del sistema.', 'Colaboradores', 'data-tut-nav="collaborators"')}
          ${step(2, '⬡', 'Vincula personas a proyectos', 'Al crear o editar un proyecto, escribe el nombre en "Responsable" o "Coautores". El autocompletado muestra las personas registradas en Colaboradores.', 'Ver Proyectos', 'data-tut-nav="projects"')}
          ${step(3, '🗓', 'Registra reuniones del laboratorio', 'Documenta cada reunión con acuerdos y próximos pasos. Los action items quedan en el Hoy hasta que se marquen como completados.', 'Nueva Reunión', 'data-tut-demo="add-meeting"')}
          ${step(4, '🔗', 'Revisa huérfanos regularmente', 'La vista Huérfanos muestra ideas, snippets y reuniones sin proyecto asignado. Pásate por ella semanalmente para mantener todo el equipo conectado.', 'Ver Huérfanos', 'data-tut-nav="orphans"')}
        </div>

        <div class="section-title" style="margin-top:4px">Coordinación y visibilidad del equipo</div>
        ${featRow([
          feat('⚑', 'Action Items por reunión', 'Los próximos pasos de cada reunión tienen checkboxes propios. El Hoy los muestra con la reunión de origen hasta completarse — ningún compromiso se pierde entre sesiones.'),
          feat('⊞', 'Filtrar por responsable', 'En el Kanban y la vista Proyectos, filtra por "Responsable" para ver solo los proyectos asignados a una persona. Útil para las reuniones de seguimiento individuales.', 'Ver Kanban', 'data-tut-nav="kanban"'),
          feat('📊', 'Heatmap de actividad', 'El Panorama (al final de Hoy, plegado) muestra la actividad diaria del año. Haz clic en cualquier fecha para ver exactamente qué se editó o creó ese día — ideal para reconstruir el historial del lab.', 'Hoy', 'data-tut-nav="dashboard"'),
        ])}

        <div class="section-title" style="margin-top:4px">Caso de uso: laboratorio de investigación</div>
        ${ucBox([
          'Crea <strong>Áreas</strong> por cada línea del laboratorio (ej: Ecología del Paisaje, Teledetección, Estadística Ecológica). Vincula cada proyecto a su área.',
          'Registra todos los miembros en <strong>Colaboradores</strong> con su rol. El autocompletado funciona en todos los modales del sistema sin configuración adicional.',
          'Asigna proyectos usando el campo <strong>Responsable</strong>. En el Kanban, usa el filtro "Responsable" para el seguimiento individual de cada persona.',
          'Cada semana: revisa el <strong>Hoy</strong> para ver deadlines próximos y action items pendientes de reuniones pasadas de todo el equipo.',
          'Exporta los datos a JSON desde Ajustes y backup y sube el archivo a Google Drive como respaldo compartido del laboratorio.',
        ])}

        ${tip('<strong>Tip:</strong> Usa la vista <strong>Proyectos Anidados</strong> para crear proyectos "paraguas" (ej: "Laboratorio Semestre 1/2026") con los proyectos de cada integrante del equipo como subproyectos anidados — la vista muestra el árbol completo con estados y deadlines.')}
      </div>`,

    // ------------------------------------------- GOOGLE & DATOS
    google: `
      <div class="tut-section">
        <div class="tut-hero">
          <div style="font-size:2.8rem;line-height:1;flex-shrink:0">☁</div>
          <div>
            <div class="tut-hero-title">Sincronización con Google Drive</div>
            <div class="tut-hero-desc">ResearchOS es <em>local-first</em> — tus datos viven en tu navegador. La integración con Google Drive añade respaldo en la nube y sincronización entre dispositivos.</div>
          </div>
        </div>

        <div class="section-title">Configurar la conexión con Google</div>
        <div class="tut-step-grid">
          ${step(1, '⚙', 'Abre Ajustes', 'Ve a «Ajustes y backup» desde el menú lateral. La sección "Sincronización con Google Drive" está en la parte inferior de la página.', 'Ir a Ajustes', 'data-tut-nav="settings"')}
          ${step(2, 'G', 'Conecta tu cuenta', 'Haz clic en "Conectar Google". Se abrirá la pantalla de autorización de Google — acepta los permisos de Drive para habilitar el respaldo.', 'Ir a Ajustes', 'data-tut-nav="settings"')}
          ${step(3, '☁', 'Sube tu primer backup', 'Haz clic en "☁ Subir a Drive". ResearchOS exportará todos tus datos (proyectos, ideas, snippets, reuniones, referencias, colaboradores) como un archivo JSON privado en Drive.', 'Ir a Ajustes', 'data-tut-nav="settings"')}
          ${step(4, '⬇', 'Restaura en otro dispositivo', 'En el otro dispositivo, conecta la misma cuenta Google y usa "⬇ Descargar (merge)" para sincronizar sin perder trabajo local.', 'Ir a Ajustes', 'data-tut-nav="settings"')}
        </div>

        <div class="section-title" style="margin-top:4px">Opciones de respaldo</div>
        ${featRow([
          feat('☁', 'Subir a Drive manualmente', 'El botón <strong>"☁ Subir a Drive"</strong> en Ajustes exporta todos tus datos como un archivo JSON en <code style="background:var(--bg-elevated);padding:1px 5px;border-radius:3px;font-size:.75rem">appDataFolder</code> — visible solo para ResearchOS, no en tu Drive normal.', 'Ir a Ajustes', 'data-tut-nav="settings"'),
          feat('⬇', 'Dos modos de descarga', '<strong>"Descargar (merge)"</strong> añade solo los registros nuevos sin borrar lo local — ideal para sincronizar entre dispositivos.<br><strong>"Descargar (reemplazar)"</strong> sustituye todos los datos locales — úsalo para restaurar un backup completo.'),
          feat('⏱', 'Auto-guardado tras cambios', 'Activa <strong>"Auto-guardar tras cambios"</strong> en Ajustes. ResearchOS subirá automáticamente a Drive 60 segundos después de cada modificación. El indicador <span style="font-family:var(--font-mono);font-size:.72rem;color:var(--green)">Drive ✓</span> confirma la sincronización.'),
        ])}

        <div class="section-title" style="margin-top:4px">Caso de uso: sincronización entre dispositivos</div>
        ${ucBox([
          'Conecta tu cuenta en <strong>Ajustes → Sincronización con Google Drive</strong>.',
          'Activa <strong>"Auto-sync al iniciar"</strong> y <strong>"Auto-guardar tras cambios"</strong> para respaldo automático.',
          'En el segundo dispositivo, abre ResearchOS, ve a Ajustes y conecta la misma cuenta Google.',
          'Haz clic en <strong>"⬇ Descargar (merge)"</strong> para traer todos los datos sin perder trabajo local.',
          'A partir de ese momento, ambos dispositivos se mantendrán sincronizados vía el auto-guardado.',
        ])}

        ${tip('<strong>Privacidad:</strong> El backup usa <code style="background:var(--bg-elevated);padding:1px 5px;border-radius:3px;font-family:var(--font-mono);font-size:.75rem">appDataFolder</code> — una carpeta especial de Google Drive que <strong>no es visible</strong> en la interfaz normal de Drive ni accesible para otras apps. Tus datos de investigación están protegidos.')}
      </div>`,

    // ----------------------------------------------- ATAJOS
    shortcuts: `
      <div class="tut-section">
        <div class="section-title">Atajos de teclado globales</div>
        <div class="tut-sk-table">
          ${sk(['Ctrl+K', '⌘K'], 'Abrir Paleta de Comandos — búsqueda unificada en proyectos, ideas, snippets, reuniones, referencias y submissions')}
          ${sk(['Ctrl+Shift+K', '⌘⇧K'], 'Ir directamente al Tablero (Kanban)')}
          ${sk(['C'], 'Capturar al vuelo (en «Hoy»): «llamar a imprenta mañana @alfa !alta» crea una tarea con fecha en ese proyecto')}
          ${sk(['[['], 'Dentro de cualquier nota o descripción, enlaza con un proyecto, idea, snippet, referencia o reunión (con autocompletado)')}
          ${sk(['F5'], 'Activar / desactivar modo presentación en la vista Kanban')}
          ${sk(['Esc'], 'Cerrar modal, inspector, paleta de comandos o salir de presentación')}
        </div>

        <div class="section-title" style="margin-top:24px">Revisión rápida de ideas (Triage)</div>
        <div class="tut-sk-table">
          ${sk(['→', 'L'], 'Marcar idea como revisada y avanzar a la siguiente')}
          ${sk(['A'], 'Eliminar la idea actual y avanzar')}
          ${sk(['P'], 'Abrir modal para asignar la idea a un proyecto')}
          ${sk(['E'], 'Expandir y editar la idea en el panel inspector')}
          ${sk(['Esc'], 'Salir del modo Triage y volver a Ideas')}
        </div>

        <div class="section-title" style="margin-top:24px">Inspector — edición in-place</div>
        <div class="tut-sk-table">
          ${sk(['Clic en un campo'], 'Editar título, responsable, deadline, prioridad, columna… directamente, sin abrir el formulario completo (con teclado: Tab hasta el campo y Enter)')}
          ${sk(['Enter'], 'Guardar la edición (en los desplegables basta con elegir una opción)')}
          ${sk(['Esc'], 'Cancelar la edición in-place sin guardar cambios')}
        </div>

        <div class="section-title" style="margin-top:24px">Kanban Board</div>
        <div class="tut-sk-table">
          ${sk(['Doble clic en título de tarjeta'], 'Renombrar la tarjeta directamente desde el tablero sin abrir el inspector')}
          ${sk(['Arrastrar tarjeta'], 'Mover a otra columna — el cambio queda registrado en el historial con fecha y hora')}
          ${sk(['F5'], 'Pantalla completa para presentaciones — oculta sidebar e inspector')}
        </div>

        <div class="section-title" style="margin-top:24px">Paleta de comandos</div>
        <div class="tut-sk-table">
          ${sk(['↑', '↓'], 'Navegar hacia arriba / abajo entre los resultados')}
          ${sk(['Enter'], 'Abrir el resultado seleccionado e ir a esa vista')}
          ${sk(['Esc'], 'Cerrar la paleta sin navegar')}
        </div>

        <div class="section-title" style="margin-top:24px">Acceso rápido a módulos — haz clic para navegar</div>
        <div class="tut-mod-grid" style="margin-top:10px">
          ${[
            ['◈', 'Hoy', 'dashboard'],
            ['⊞', 'Kanban', 'kanban'],
            ['◉', 'Proyectos', 'projects'],
            ['◎', 'Ideas', 'ideas'],
            ['📤', 'Submissions', 'submissions'],
            ['🗓', 'Reuniones', 'meetings'],
            ['📚', 'Referencias', 'references'],
            ['👥', 'Colaboradores', 'collaborators'],
            ['⟨/⟩', 'Snippets', 'snippets'],
            ['🎯', 'Hoy', 'focus'],
            ['⏱', 'Timeline', 'timeline'],
            ['📅', 'Agenda', 'weekly'],
            ['🔗', 'Huérfanos', 'orphans'],
            ['⊡', 'Áreas', 'areas'],
            ['⬡', 'Anidados', 'nested'],
            ['⊟', 'Carpetas del proyecto', 'filesystem'],
          ].map(([icon, label, view]) => `
            <div class="tut-mod-card" data-tut-nav="${view}">
              <div class="tut-mod-icon">${icon}</div>
              <div class="tut-mod-title">${label}</div>
            </div>`).join('')}
        </div>
      </div>`,
  };

  // -- Render -------------------------------------------------
  mainContent.innerHTML = `
    <div class="view tutorial-view">
      <div class="view-header">
        <div>
          <div class="view-title">Tutorial y guía de uso</div>
          <div class="view-subtitle">Aprende a usar ResearchOS para todos tus flujos de trabajo</div>
        </div>
      </div>

      <div class="tutorial-tabs">
        ${TABS.map(t => `
          <button class="tutorial-tab ${t.id === tab ? 'active' : ''}" data-ttab="${t.id}">
            ${t.icon} ${t.label}
          </button>`).join('')}
      </div>

      <div class="tutorial-content">
        ${CONTENT[tab] || CONTENT.quickstart}
      </div>
    </div>`;

  // -- Event handlers -----------------------------------------
  mainContent.querySelectorAll('[data-ttab]').forEach(btn => {
    btn.addEventListener('click', () => {
      App._tutorialTab = btn.dataset.ttab;
      renderTutorial();
    });
  });

  mainContent.querySelectorAll('[data-tut-nav]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.tutNav));
  });

  $('tourStartBtn')?.addEventListener('click', () => Tour.start());
  $('tourSampleBtn')?.addEventListener('click', async e => { e.currentTarget.disabled = true; try { await loadSampleAndShow(); } catch (err) { showToast(err.message, 'error'); } });
  mainContent.querySelectorAll('[data-tut-demo]').forEach(btn => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.tutDemo) {
        case 'add-project': showAddProjectModal(); break;
        case 'add-idea':    showAddIdeaModal();    break;
        case 'add-meeting': showAddMeetingModal(); break;
        case 'add-snippet': showAddSnippetModal(); break;
        case 'add-ref':     showAddReferenceModal(); break;
        case 'add-sub':     showAddSubmissionModal(); break;
      }
    });
  });
}

async function renderStarred() {
  const [allProjects, cols, ideas, snippets, stMap] = await Promise.all([
    db.projects.toArray(),
    db.kanbanColumns.toArray(),
    db.ideas.filter(i => i.starred).toArray(),
    db.snippets.filter(s => s.starred).toArray(),
    Tasks.countsByIdea(),
  ]);
  const projects = allProjects.filter(p => p.starred && !p.archived);
  const colMap   = Object.fromEntries(cols.map(c => [c.id, c]));
  const projMap  = Object.fromEntries(allProjects.map(p => [p.id, p]));

  mainContent.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Favoritos</div>
          <div class="view-subtitle">${projects.length + ideas.length + snippets.length} elementos marcados</div>
        </div>
      </div>
      ${projects.length ? `
        <div class="section-title">Proyectos</div>
        <div class="projects-grid" id="starredProjGrid">
          ${projects.map(p => projectCardHTML(p, colMap[p.columnId])).join('')}
        </div>` : ''}
      ${ideas.length ? `
        <div class="section-title mt-16">Ideas</div>
        <div class="ideas-list">
          ${ideas.map(i => ideaItemHTML(i, projMap, stMap)).join('')}
        </div>` : ''}
      ${snippets.length ? `
        <div class="section-title mt-16">Snippets</div>
        <div class="snippets-list">
          ${snippets.map(s => snippetCardHTML(s, {})).join('')}
        </div>` : ''}
      ${!projects.length && !ideas.length && !snippets.length ? `
        <div class="empty-state">
          <span class="empty-state-icon">★</span>
          <h3>Sin favoritos</h3>
          <p>Marca proyectos, ideas o snippets con ★ para verlos aquí</p>
        </div>` : ''}
    </div>`;

  mainContent.querySelectorAll('[data-inspect-project]').forEach(el => {
    el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject));
  });
  mainContent.querySelectorAll('.idea-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.idea-linked[data-inspect-project]')) return;
      inspectIdea(+el.dataset.ideaId);
    });
  });
  mainContent.querySelectorAll('.idea-linked[data-inspect-project]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      inspectProject(+el.dataset.inspectProject);
    });
  });
  mainContent.querySelectorAll('pre code').forEach(_highlightBlock);
  mainContent.querySelectorAll('.copy-btn-float').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await copyText(decodeURIComponent(btn.dataset.code), 'Código copiado ✓')) { btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Copy', 1500); }
    });
  });

  // Listeners de ideas en vista Favoritos (★, ✕, estado)
  mainContent.querySelectorAll('.idea-status-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = +btn.dataset.ideaId;
      const idea = await db.ideas.get(id);
      await db.ideas.update(id, {
        status: idea.status === 'reviewed' ? 'unread' : 'reviewed',
        updatedAt: new Date().toISOString()
      });
      renderStarred();
      updateBadges();
    });
  });
  mainContent.querySelectorAll('.idea-star-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idea = await db.ideas.get(+btn.dataset.ideaId);
      await db.ideas.update(+btn.dataset.ideaId, { starred: !idea.starred });
      renderStarred();
      updateBadges();
    });
  });
  mainContent.querySelectorAll('.idea-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      {
        await deleteWithUndo('ideas', +btn.dataset.ideaId, 'Eliminar idea', 'Idea eliminada');
        renderStarred();
        updateBadges();
      }
    });
  });

  // Snippets en Favoritos — clic para inspeccionar
  mainContent.querySelectorAll('.snippet-card').forEach(card => {
    card.addEventListener('click', async (e) => {
      if (e.target.closest('button') || e.target.closest('.copy-btn-float')) return;
      const s = await db.snippets.get(+card.dataset.snippetId);
      if (s) inspectSnippet(s);
    });
  });
}

// ==============================================================
//  SUBMISSION → KANBAN COLUMN SYNC
// ==============================================================
async function _getSubColMapping() {
  const s = await db.settings.get('ros-sub-col-map');
  return s?.value ? JSON.parse(s.value) : {};
}
async function _saveSubColMapping(map) {
  await db.settings.put({ key: 'ros-sub-col-map', value: JSON.stringify(map) });
}

/**
 * Cuando cambia el estado de una submission vinculada a un Paper,
 * mueve el proyecto a la columna Kanban mapeada (si el toggle está activo).
 */
async function _syncPaperColumn(projectId, newStatus) {
  const toggle = await db.settings.get('ros-auto-sync-paper-col');
  if (toggle?.value !== 'true') return;
  const proj = await db.projects.get(projectId);
  if (!proj || proj.type !== 'Paper') return;
  const mapping = await _getSubColMapping();
  const colId   = mapping[newStatus] ? +mapping[newStatus] : null;
  if (!colId || proj.columnId === colId) return;
  const col = await db.kanbanColumns.get(colId);
  if (!col) return;
  await dbWrite(() => recordColumnChange(proj.id, colId));
  showToast(`📄 "${proj.title.slice(0,28)}" → "${col.title}"`, 'success');
  if (App.view === 'kanban') renderKanban();
}

// ==============================================================
//  VIEW: SETTINGS & EXPORT
// ==============================================================
async function renderSettings() {
  const [cp, ci, cs, cmeet, cref, ccol, settingsCols, _subColMap, _autoSyncRow] =
    await Promise.all([
      db.projects.count(), db.ideas.count(), db.snippets.count(),
      db.meetings.count(),
      db.references.count(), db.collaborators.count(),
      db.kanbanColumns.orderBy('order').toArray(),
      _getSubColMapping(),
      db.settings.get('ros-auto-sync-paper-col'),
    ]);
  const paperSubCount = await db.projects
    .filter(p => p.type === 'Paper' && !p.archived).count();
  const counts = { p: cp, i: ci, s: cs, paper: paperSubCount, meet: cmeet, ref: cref, col: ccol };

  let storageHTML = '';
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    const usedMB  = ((est.usage  || 0) / 1048576).toFixed(2);
    const quotaMB = ((est.quota  || 0) / 1048576).toFixed(0);
    const pct     = est.quota ? Math.min(100, ((est.usage / est.quota) * 100)).toFixed(1) : 0;
    storageHTML = `
      <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:6px">
        <div style="display:flex;justify-content:space-between;width:100%">
          <span class="settings-row-label">Almacenamiento usado</span>
          <span style="font-family:var(--font-mono);font-size:.8rem;color:var(--text-2)">${usedMB} MB / ~${quotaMB} MB</span>
        </div>
        <div style="width:100%;height:4px;background:var(--bg-elevated);border-radius:99px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${+pct > 80 ? 'var(--red)' : 'var(--accent)'};border-radius:99px;transition:width 400ms"></div>
        </div>
        <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--text-3)">${pct}% utilizado</span>
      </div>`;
  }

  mainContent.innerHTML = `
    <div class="view" style="max-width:640px">
      <div class="view-header">
        <div>
          <div class="view-title">Ajustes y backup</div>
          <div class="view-subtitle">Gestión de datos y configuración</div>
        </div>
      </div>

      <!-- Data summary -->
      <div class="settings-section">
        <div class="settings-section-title">📊 Estado de la base de datos</div>
        <div class="settings-body">
          ${[
            { label: 'Proyectos',    val: counts.p,    color: 'var(--accent)'  },
            { label: 'Ideas',        val: counts.i,    color: 'var(--purple)'  },
            { label: 'Snippets',     val: counts.s,    color: 'var(--green)'   },
            { label: 'Papers activos', val: counts.paper, color: 'var(--accent)' },
            { label: 'Reuniones',    val: counts.meet, color: 'var(--teal)'    },
            { label: 'Referencias',  val: counts.ref,  color: 'var(--accent)'  },
            { label: 'Colaboradores',val: counts.col,  color: 'var(--text-2)'  },
          ].map(row => `
            <div class="settings-row">
              <div class="settings-row-label">${row.label}</div>
              <span style="font-family:var(--font-mono);font-size:.9rem;color:${cssColor(row.color)}">${row.val}</span>
            </div>`).join('')}
          ${storageHTML}
        </div>
      </div>

      <!-- Export -->
      <div class="settings-section">
        <div class="settings-section-title">💾 Exportar backup</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Exportar a JSON</div>
              <div class="settings-row-desc">Descarga un backup completo de todos tus datos</div>
              <div class="settings-row-desc" id="backupStatus" style="margin-top:4px;color:${
                BackupMeta.last() === null || BackupMeta.daysSince() >= BackupMeta.BACKUP_DAYS ? 'var(--amber)' : 'var(--text-3)'}">
                ${BackupMeta.last() === null ? '⚠ Aún no has exportado ningún backup desde este navegador'
                  : BackupMeta.daysSince() === 0 ? '✓ Último backup: hoy'
                  : `Último backup: hace ${BackupMeta.daysSince()} día(s)`}
              </div>
            </div>
            <button class="btn btn-primary btn-sm" id="exportJsonBtn">Exportar</button>
          </div>
        </div>
      </div>

      <!-- Import -->
      <div class="settings-section">
        <div class="settings-section-title">📂 Importar backup</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Importar desde JSON</div>
              <div class="settings-row-desc">Elige entre añadir lo nuevo (merge) o reemplazar todo — antes de reemplazar se descarga una copia</div>
            </div>
            <label class="btn btn-ghost btn-sm" style="cursor:pointer">
              Importar
              <input type="file" accept=".json" id="importJsonInput" style="display:none">
            </label>
          </div>
        </div>
      </div>

      <!-- CSV -->
      <div class="settings-section">
        <div class="settings-section-title">📋 CSV — Importar / Exportar proyectos</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Exportar proyectos a CSV</div>
              <div class="settings-row-desc">Columnas: title, type, responsible, priority, deadline, description, tags, status, column, parent</div>
            </div>
            <button class="btn btn-ghost btn-sm" id="exportCsvBtn">CSV ↓</button>
          </div>
          <div class="settings-row" style="margin-top:8px">
            <div>
              <div class="settings-row-label">Importar proyectos desde CSV</div>
              <div class="settings-row-desc">Las columnas title y type son obligatorias. Los proyectos existentes no se modifican.</div>
            </div>
            <label class="btn btn-ghost btn-sm" style="cursor:pointer">
              CSV ↑
              <input type="file" accept=".csv,text/csv" id="importCsvInput" style="display:none">
            </label>
          </div>
          <div id="csvPreviewArea"></div>
        </div>
      </div>

      <!-- Google Drive Sync -->
      <div class="settings-section">
        <div class="settings-section-title">☁ Sincronización con Google Drive</div>
        <div class="settings-body" id="googleSyncSection">
          <div style="color:var(--text-3);font-size:.8rem;padding:4px 0">Cargando estado…</div>
        </div>
      </div>

      <!-- Danger zone -->
      <div class="settings-section settings-danger-zone">
        <div class="settings-section-title">⚠ Zona de peligro</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Borrar todos los datos</div>
              <div class="settings-row-desc">Elimina permanentemente proyectos, ideas y snippets</div>
            </div>
            <button class="btn btn-danger btn-sm" id="clearAllBtn">Borrar todo</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">🔔 Notificaciones de Deadline</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-label">Recordatorios del navegador</div>
              <div class="settings-desc">Notificación el día anterior y el día del deadline</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="notifToggle"
                ${localStorage.getItem('ros-notif-enabled') === 'true' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <button class="btn btn-ghost btn-sm" id="testNotifBtn" style="margin-top:8px">
            🧪 Probar notificación
          </button>
        </div>
      </div>

      <!-- About -->
      <div class="settings-section">
        <div class="settings-section-title">ℹ Acerca de ResearchOS</div>
        <div class="settings-body">
          <div style="font-size:.8rem;color:var(--text-2);line-height:1.6">
            <strong style="color:var(--text-1)">ResearchOS v1.0</strong><br>
            Herramienta de productividad científica, <em>local-first</em>.<br>
            Sin backend. Sin telemetría. Tus datos nunca salen de tu navegador.<br><br>
            <strong style="color:var(--text-1)">Stack técnico:</strong>
            HTML5 · CSS Grid · Vanilla JS ES2022 · Dexie.js 3 (IndexedDB) · File System Access API · highlight.js
          </div>
        </div>
      </div>
    </div>`;

  renderGoogleSyncSection(); // poblar sección Google Sync

  $('exportJsonBtn').addEventListener('click', async () => {
    await downloadBackup();
    showToast('Backup exportado ✓', 'success');
    renderSettings();
  });

  // -- Import con opción merge vs. reemplazar ---------
  $('importJsonInput').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = ''; // reset para volver a disparar si mismo archivo
    if (file) startBackupImport(file);
  });

  $('exportCsvBtn').addEventListener('click', exportProjectsCSV);
  $('importCsvInput').addEventListener('change', e => previewImportCSV(e.target.files[0]));
  $('clearAllBtn').addEventListener('click', async () => {
    if (!(await askConfirm('Se borrarán todos tus proyectos, ideas, snippets, reuniones y referencias de este navegador. Antes se descargará una copia de seguridad.',
          { title: '¿Borrar TODOS los datos?', confirmLabel: 'Borrar todo', danger: true, typeToConfirm: 'BORRAR' }))) return;
    await downloadBackup('researchos-antes-de-borrar');
    await clearAllData();
    await _afterDataReplaced();
    showToast('Datos eliminados (copia descargada)', 'info');
    navigate('dashboard');
  });

  // -- Listeners del toggle de notificaciones ---------
  $('notifToggle')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    localStorage.setItem('ros-notif-enabled', String(enabled));
    if (enabled) {
      const ok = await DeadlineReminder.requestPermission();
      if (ok) { DeadlineReminder.start(); showToast('Notificaciones activadas ✓', 'success'); }
      else { e.target.checked = false; localStorage.setItem('ros-notif-enabled', 'false');
             showToast('Permiso denegado en el navegador', 'error'); }
    } else {
      DeadlineReminder.stop();
      showToast('Notificaciones desactivadas', 'info');
    }
  });

  $('testNotifBtn')?.addEventListener('click', async () => {
    const ok = await DeadlineReminder.requestPermission();
    if (!ok) return showToast('Permiso denegado', 'error');
    new Notification('⬡ ResearchOS — Prueba', {
      body: 'Las notificaciones de deadline funcionan correctamente.',
    });
  });

  // -- Paper Pipeline Sync section --------------
  const _dangerZone = mainContent.querySelector('.settings-danger-zone');
  if (_dangerZone) {
    _dangerZone.insertAdjacentHTML('beforebegin', `
      <div class="settings-section" id="paperSyncSection">
        <div class="settings-section-title">📤 Paper Pipeline — Sincronización automática</div>
        <div class="settings-body">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Auto-mover Paper al cambiar submission</div>
              <div class="settings-row-desc">
                Cuando una submission vinculada a un Paper cambia de estado,
                mueve automáticamente el proyecto a la columna Kanban mapeada.
              </div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="autoSyncPaperToggle"
                     ${_autoSyncRow?.value === 'true' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div id="subColMappingRows" style="${_autoSyncRow?.value === 'true' ? '' : 'opacity:.45;pointer-events:none'}">
            <div style="font-family:var(--font-mono);font-size:.62rem;text-transform:uppercase;
                        letter-spacing:.08em;color:var(--text-3);margin:10px 0 6px">
              Mapeo estado submission → columna Kanban
            </div>
            ${SUB_STATUSES.map(st => `
              <div class="settings-row" style="margin-bottom:6px">
                <span style="font-size:.78rem;color:var(--text-1);min-width:140px">${st.label}</span>
                <select class="form-select scm-select" data-status="${st.key}"
                        style="font-size:.78rem;padding:5px 8px;max-width:200px">
                  <option value="">— Sin cambio —</option>
                  ${settingsCols.map(c =>
                    `<option value="${c.id}" ${+(_subColMap[st.key]||0) === c.id ? 'selected' : ''}>
                      ${esc(c.title)}
                    </option>`
                  ).join('')}
                </select>
              </div>`).join('')}
            <button class="btn btn-primary btn-sm" id="saveSubColMapBtn"
                    style="margin-top:8px">Guardar mapeo</button>
          </div>
        </div>
      </div>`);

    $('autoSyncPaperToggle')?.addEventListener('change', async e => {
      await db.settings.put({ key: 'ros-auto-sync-paper-col', value: String(e.target.checked) });
      const rows = $('subColMappingRows');
      if (rows) {
        rows.style.opacity          = e.target.checked ? '1' : '.45';
        rows.style.pointerEvents    = e.target.checked ? 'auto' : 'none';
      }
      showToast(e.target.checked ? 'Auto-sync activado ✓' : 'Auto-sync desactivado', 'success');
    });

    $('saveSubColMapBtn')?.addEventListener('click', async () => {
      const map = {};
      mainContent.querySelectorAll('.scm-select').forEach(sel => {
        if (sel.value) map[sel.dataset.status] = +sel.value;
      });
      await _saveSubColMapping(map);
      showToast('Mapeo guardado ✓', 'success');
    });
  }

  // -- Custom Fields settings section -----------
  if (_dangerZone) {
    const _cfSchemas = await _getTypeSchemas();
    _dangerZone.insertAdjacentHTML('beforebegin', `
      <div class="settings-section" id="cfSettingsSection">
        <div class="settings-section-title">🗂 Campos personalizados por tipo</div>
        <div class="settings-body">
          <div style="font-size:.78rem;color:var(--text-2);margin-bottom:12px;line-height:1.55">
            Define campos extra que aparecen al crear o editar proyectos de cada tipo.
            Los cambios se aplican a nuevos proyectos; los datos existentes se conservan.
          </div>
          <div style="display:flex;flex-direction:column;gap:8px" id="cfSchemaList">
            ${Object.entries(_cfSchemas).map(([type, fields]) => `
              <div style="background:var(--bg-elevated);border:1px solid var(--border);
                          border-radius:var(--radius-md);overflow:hidden">
                <div style="display:flex;align-items:center;justify-content:space-between;
                            padding:8px 14px;border-bottom:1px solid var(--border)">
                  <span style="font-size:.82rem;font-weight:600;color:var(--text-1)">
                    <span class="badge ${typeBadgeClass(type)}">${esc(type)}</span>
                  </span>
                  <button class="btn btn-ghost btn-sm cf-edit-type-btn"
                          data-type="${type}"
                          style="font-size:.68rem">✎ Editar campos</button>
                </div>
                ${fields.length
                  ? `<div style="padding:8px 14px;display:flex;flex-wrap:wrap;gap:5px">
                      ${fields.map(f => `
                        <span style="font-family:var(--font-mono);font-size:.65rem;
                              background:var(--bg-card);border:1px solid var(--border-str);
                              padding:2px 8px;border-radius:99px;color:var(--text-2)">
                          ${esc(f.label)}
                          <span style="color:var(--text-3)">(${f.type})</span>
                        </span>`).join('')}
                     </div>`
                  : `<div style="padding:8px 14px;font-size:.74rem;color:var(--text-3);
                                font-style:italic">Sin campos extra.</div>`}
              </div>`).join('')}
          </div>
          <button class="btn btn-ghost btn-sm" id="cfResetDefaultsBtn"
                  style="margin-top:10px;font-size:.72rem;color:var(--text-3)">
            ↩ Restaurar schemas por defecto
          </button>
        </div>
      </div>`);

    // Editar campos de un tipo
    mainContent.querySelectorAll('.cf-edit-type-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const type   = btn.dataset.type;
        const schemas = await _getTypeSchemas();
        let fields    = JSON.parse(JSON.stringify(schemas[type] || []));

        const renderFieldRows = () => fields.map((f, i) => `
          <div style="display:grid;grid-template-columns:1fr 1fr 80px auto;
                      gap:6px;align-items:center;padding:6px 0;
                      border-bottom:1px solid var(--border)">
            <input class="form-input cf-edit-label" value="${esc(f.label)}"
                   data-fi="${i}" placeholder="Etiqueta"
                   style="font-size:.78rem;padding:5px 8px">
            <input class="form-input cf-edit-key" value="${esc(f.key)}"
                   data-fi="${i}" placeholder="key (sin espacios)"
                   style="font-size:.72rem;font-family:var(--font-mono);padding:5px 8px">
            <select class="form-select cf-edit-type" data-fi="${i}"
                    style="font-size:.75rem;padding:5px 6px">
              <option value="text"   ${f.type==='text'  ?'selected':''}>texto</option>
              <option value="number" ${f.type==='number'?'selected':''}>número</option>
            </select>
            <button class="btn btn-ghost btn-sm cf-del-field" data-fi="${i}"
                    style="color:var(--red);padding:4px 8px">✕</button>
          </div>`).join('');

        showModal(`✎ Campos de ${type}`, `
          <div class="modal-body">
            <div id="cfEditRows">${renderFieldRows()}</div>
            <button class="btn btn-ghost btn-sm" id="cfAddFieldBtn"
                    style="margin-top:10px;width:100%">+ Agregar campo</button>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="cfEditCancel">Cancelar</button>
            <button class="btn btn-primary" id="cfEditSave">Guardar</button>
          </div>`);

        const reRenderRows = () => {
          $('cfEditRows').innerHTML = renderFieldRows();
          attachCFRowHandlers();
        };
        const attachCFRowHandlers = () => {
          document.querySelectorAll('.cf-del-field').forEach(b => {
            b.addEventListener('click', () => {
              fields.splice(+b.dataset.fi, 1);
              reRenderRows();
            });
          });
        };
        attachCFRowHandlers();

        $('cfAddFieldBtn').addEventListener('click', () => {
          fields.push({ key: `field${fields.length+1}`, label: 'Nuevo campo', type: 'text', placeholder: '' });
          reRenderRows();
        });
        $('cfEditCancel').addEventListener('click', closeModal);
        $('cfEditSave').addEventListener('click', async () => {
          // Leer valores del DOM
          document.querySelectorAll('.cf-edit-label').forEach(inp => {
            const i = +inp.dataset.fi;
            if (fields[i]) fields[i].label = inp.value.trim() || fields[i].label;
          });
          document.querySelectorAll('.cf-edit-key').forEach(inp => {
            const i = +inp.dataset.fi;
            if (fields[i]) fields[i].key = inp.value.trim().replace(/\s+/g,'') || fields[i].key;
          });
          document.querySelectorAll('.cf-edit-type').forEach(sel => {
            const i = +sel.dataset.fi;
            if (fields[i]) fields[i].type = sel.value;
          });
          const fresh = await _getTypeSchemas();
          fresh[type] = fields;
          await _saveTypeSchemas(fresh);
          closeModal();
          showToast(`Campos de ${type} guardados ✓`, 'success');
          renderView('settings'); // refrescar la vista
        });
      });
    });

    // Restaurar defaults
    $('cfResetDefaultsBtn')?.addEventListener('click', async () => {
      if (!(await askConfirm('Los campos personalizados que añadiste se perderán.', { title: '¿Restaurar los campos por defecto?', confirmLabel: 'Restaurar', danger: true }))) return;
      await _saveTypeSchemas({ ...DEFAULT_TYPE_SCHEMAS });
      showToast('Schemas restaurados ✓', 'success');
      renderView('settings');
    });
  }

  if (typeof enhanceSettings === 'function') await enhanceSettings();    // integrations.js: copia automática, calendario, uso, avanzado
}

// -- Renderiza (o refresca) el bloque Google Sync dentro de Settings --
async function renderGoogleSyncSection() {
  const container = document.getElementById('googleSyncSection');
  if (!container) return;

  const connected       = GoogleSync.isConnected();
  const lastSync        = await GoogleSync.getLastSync();
  const autoInitRow     = await db.settings.get('google_auto_sync');
  const autoChangeRow   = await db.settings.get('google_auto_save_on_change');
  const lastLabel       = lastSync
    ? new Date(lastSync).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
    : 'Nunca';

  container.innerHTML = connected ? `
    <div class="settings-row">
      <div>
        <div class="settings-row-label">Cuenta conectada</div>
        <div class="settings-row-desc" id="gEmailDisplay" style="font-family:var(--font-mono)">Verificando cuenta…</div>
      </div>
      <button class="btn btn-ghost btn-sm" id="gSignOutBtn">Desconectar</button>
    </div>

    <div class="settings-row" style="margin-top:6px">
      <div>
        <div class="settings-row-label">Última sincronización</div>
        <div class="settings-row-desc" style="font-family:var(--font-mono)">${lastLabel}</div>
      </div>
    </div>

    <div class="settings-row" style="margin-top:6px">
      <div>
        <div class="settings-row-label">Auto-sync al iniciar</div>
        <div class="settings-row-desc">Sube los datos automáticamente al abrir la app</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="gAutoSyncToggle" ${autoInitRow?.value === 'true' ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>

    <div class="settings-row" style="margin-top:6px">
      <div>
        <div class="settings-row-label">Auto-guardar tras cambios</div>
        <div class="settings-row-desc">Sube a Drive 1 minuto después del último cambio realizado</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="gAutoSaveChangeToggle" ${autoChangeRow?.value === 'true' ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>

    <div class="gsync-actions" style="margin-top:12px">
      <button class="btn btn-primary btn-sm" id="gPushBtn">☁ Subir a Drive</button>
      <button class="btn btn-ghost btn-sm"   id="gPullMergeBtn">⬇ Descargar (merge)</button>
      <button class="btn btn-danger btn-sm"  id="gPullReplaceBtn">⬇ Descargar (reemplazar)</button>
    </div>
  ` : `
    <div class="settings-row">
      <div>
        <div class="settings-row-label">No conectado</div>
        <div class="settings-row-desc">Vincula tu cuenta para sincronizar entre dispositivos</div>
      </div>
      <button class="btn btn-primary btn-sm gsync-connect-btn" id="gSignInBtn">
        <span class="gsync-g-icon">G</span> Conectar Google
      </button>
    </div>
  `;

  // -- Listeners --------------------------------------------
  document.getElementById('gSignInBtn')?.addEventListener('click', () => GoogleSync.signIn());

  document.getElementById('gSignOutBtn')?.addEventListener('click', () => GoogleSync.signOut());

  document.getElementById('gPushBtn')?.addEventListener('click', () => GoogleSync.push());

  document.getElementById('gPullMergeBtn')?.addEventListener('click', () => GoogleSync.pull({ mode: 'merge' }));

  document.getElementById('gPullReplaceBtn')?.addEventListener('click', async () => {
    if (!(await askConfirm('Se reemplazarán todos los datos de este navegador por los de Drive. No se puede deshacer.', { title: '¿Reemplazar todo con lo de Drive?', confirmLabel: 'Reemplazar', danger: true }))) return;
    await GoogleSync.pull({ mode: 'replace' });
  });

  document.getElementById('gAutoSyncToggle')?.addEventListener('change', async e => {
    await db.settings.put({ key: 'google_auto_sync', value: String(e.target.checked) });
    showToast(e.target.checked ? 'Auto-sync al iniciar activado ✓' : 'Auto-sync al iniciar desactivado', 'success');
  });

  document.getElementById('gAutoSaveChangeToggle')?.addEventListener('change', async e => {
    await db.settings.put({ key: 'google_auto_save_on_change', value: String(e.target.checked) });
    showToast(e.target.checked ? 'Auto-guardado en Drive activado ✓' : 'Auto-guardado en Drive desactivado', 'success');
  });

  // Verificar acceso Gmail y mostrar email conectado
  if (connected) {
    GoogleSync.getUserProfile().then(email => {
      const display = $('gEmailDisplay');
      if (display && email) display.textContent = email;
    });
  }
}

// ==============================================================
//  MODALS — Add / Edit
// ==============================================================
const PROJECT_TEMPLATES = {
  paper: {
    label: '📄 Paper', type: 'Paper', priority: 'Alta',
    tags: ['writing', 'review'],
    description: 'Objetivo: publicar en revista indexada.\n\n## Estructura\n- Introducción\n- Métodos\n- Resultados\n- Discusión\n- Conclusiones',
    tasks: [
      { title: 'Definir pregunta y estructura del manuscrito', offset: -60 },
      { title: 'Redactar introducción y métodos',              offset: -45 },
      { title: 'Cerrar análisis y figuras principales',        offset: -35 },
      { title: 'Primer borrador completo',                     offset: -25 },
      { title: 'Revisión de coautores',                        offset: -14 },
      { title: 'Ajustar formato a la revista y carta de presentación', offset: -5 },
      { title: 'Enviar manuscrito',                            offset: 0 },
    ],
  },
  grant: {
    label: '💰 Grant FONDECYT', type: 'Grant', priority: 'Alta',
    tags: ['grant', 'funding', 'deadline-hard'],
    description: 'Postulación a concurso de financiamiento.\n\n## Secciones requeridas\n- Resumen ejecutivo\n- Objetivos\n- Metodología\n- Presupuesto\n- Equipo',
    tasks: [
      { title: 'Leer bases y confirmar elegibilidad',             offset: -60 },
      { title: 'Pedir cartas de apoyo y datos del equipo',        offset: -45 },
      { title: 'Borrador de objetivos y metodología',             offset: -30 },
      { title: 'Presupuesto y justificación',                     offset: -20 },
      { title: 'Revisión interna (colega externo)',               offset: -10 },
      { title: 'Subir postulación (la plataforma se satura el último día)', offset: -2 },
    ],
  },
  grantExec: {
    label: '📑 Ejecución de grant', type: 'Grant', priority: 'Media',
    tags: ['grant', 'ejecución'],
    description: '## Compromisos con la agencia\n- Informes de avance:\n- Rendiciones:\n- Entregables:\n\n## Equipo y presupuesto',
    // «every»: tarea que se repite hasta la fecha límite (término del proyecto); «first»: días hasta la primera
    tasks: [
      { title: 'Revisar la ejecución del presupuesto',   every: { freq: 'monthly', interval: 1 }, first: 30, effort: 45 },
      { title: 'Rendición de gastos',                    every: { freq: 'monthly', interval: 3 }, first: 90, effort: 120 },
      { title: 'Informe de avance a la agencia',         every: { freq: 'monthly', interval: 6 }, first: 150, effort: 240 },
      { title: 'Informe final y cierre administrativo',  offset: 0, effort: 300 },
    ],
  },
  course: {
    label: '🎓 Curso / Asignatura', type: 'Curso', priority: 'Media',
    tags: ['docencia', 'curso'],
    description: '## Información del curso\n- Código:\n- Semestre:\n- Créditos:\n\n## Contenidos mínimos',
    // «weekly»: se repite cada semana desde el próximo lunes hasta la fecha límite (fin del semestre)
    tasks: [
      { title: 'Preparar la clase de la semana', weekly: true },
      { title: 'Publicar programa y calendario de evaluaciones', offset: -120 },
      { title: 'Subir notas finales', offset: 0 },
    ],
  },
  talk: {
    label: '🎤 Ponencia / Congreso', type: 'Presentación', priority: 'Media',
    tags: ['congreso', 'slides'],
    description: '## Detalles\n- Evento:\n- Fecha:\n- Duración:\n\n## Estructura de la presentación',
    tasks: [
      { title: 'Esquema y mensaje central',   offset: -21 },
      { title: 'Primera versión de las diapositivas', offset: -14 },
      { title: 'Ensayo con tiempo cronometrado', offset: -4 },
    ],
  },
  dataset: {
    label: '🗄 Dataset / Pipeline', type: 'Dataset', priority: 'Media',
    tags: ['data', 'pipeline'],
    description: '## Descripción de datos\n- Fuente:\n- Formato:\n- Período:\n\n## Pipeline de procesamiento',
  },
  blank: { label: '⬡ En blanco', type: 'Proyecto', priority: 'Media', tags: [], description: '' },
};

// ==============================================================
//  CUSTOM FIELDS PER TYPE
// ==============================================================
const DEFAULT_TYPE_SCHEMAS = {
  Paper: [
    { key: 'targetJournal', label: 'Journal objetivo',  type: 'text',   placeholder: 'Nature, PLOS ONE, Ecology Letters…' },
    { key: 'impactFactor',  label: 'Factor de impacto', type: 'number', placeholder: '5.2' },
    { key: 'wordCount',     label: 'Palabras (~)',       type: 'number', placeholder: '8500' },
    { key: 'manuscriptUrl', label: 'URL manuscrito',    type: 'text',   placeholder: 'https://overleaf.com/…' },
  ],
  Grant: [
    { key: 'agency',   label: 'Agencia',              type: 'text',   placeholder: 'ANID, NSF, NIH…' },
    { key: 'callId',   label: 'ID convocatoria',       type: 'text',   placeholder: 'FONDECYT-11240001' },
    { key: 'amount',   label: 'Monto solicitado (CLP)',type: 'number', placeholder: '50000000' },
    { key: 'duration', label: 'Duración (meses)',      type: 'number', placeholder: '24' },
  ],
  Análisis: [
    { key: 'software',   label: 'Software / Lenguaje', type: 'text',   placeholder: 'R 4.3, Python 3.11' },
    { key: 'dataSource', label: 'Fuente de datos',     type: 'text',   placeholder: 'GBIF, INE, MODIS' },
    { key: 'sampleN',    label: 'N muestral',          type: 'number', placeholder: '1200' },
  ],
  Dataset: [
    { key: 'format',   label: 'Formato',       type: 'text',   placeholder: 'CSV, GeoTIFF, Shapefile' },
    { key: 'nRecords', label: 'N registros',   type: 'number', placeholder: '50000' },
    { key: 'doiDs',    label: 'DOI dataset',   type: 'text',   placeholder: '10.5061/dryad…' },
    { key: 'license',  label: 'Licencia',      type: 'text',   placeholder: 'CC-BY 4.0' },
  ],
  Presentación: [
    { key: 'event',     label: 'Evento / Congreso', type: 'text',   placeholder: 'ICES 2025, ISMIR 2025…' },
    { key: 'duration',  label: 'Duración (min)',    type: 'number', placeholder: '20' },
    { key: 'slidesUrl', label: 'URL slides',        type: 'text',   placeholder: 'https://…' },
  ],
  Curso: [
    { key: 'code',     label: 'Código',               type: 'text', placeholder: 'BIO-204' },
    { key: 'term',     label: 'Semestre / periodo',   type: 'text', placeholder: '2026-2' },
    { key: 'schedule', label: 'Horario',              type: 'text', placeholder: 'Lun y mié 10:00' },
    { key: 'room',     label: 'Sala / plataforma',    type: 'text', placeholder: 'Aula 3 · Zoom' },
  ],
  Proyecto: [],
};

async function _getTypeSchemas() {
  const s = await db.settings.get('ros-type-schemas');
  if (s?.value) {
    try {
      const saved = JSON.parse(s.value);
      // Merge: defaults provide fallback for types not yet customized
      return Object.fromEntries(
        Object.keys(DEFAULT_TYPE_SCHEMAS).map(t => [t, saved[t] ?? DEFAULT_TYPE_SCHEMAS[t]])
      );
    } catch { /* fallthrough */ }
  }
  return { ...DEFAULT_TYPE_SCHEMAS };
}
async function _saveTypeSchemas(schemas) {
  await db.settings.put({ key: 'ros-type-schemas', value: JSON.stringify(schemas) });
}

/** Renderiza los campos de formulario para un tipo. */
function _customFieldsFormHTML(type, schemas, values = {}) {
  const fields = schemas?.[type] || [];
  if (!fields.length) return '';
  return `
    <div id="cfSection" style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
      <div style="font-family:var(--font-mono);font-size:.6rem;text-transform:uppercase;
                  letter-spacing:.1em;color:var(--text-3);margin-bottom:8px">
        Campos de ${esc(type)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
        ${fields.map(f => `
          <div class="form-group" style="margin:0">
            <label class="form-label">${esc(f.label)}</label>
            <input class="form-input cf-field"
                   type="${f.type === 'number' ? 'number' : 'text'}"
                   data-cf-key="${f.key}"
                   value="${esc(String(values[f.key] ?? ''))}"
                   placeholder="${esc(f.placeholder || '')}">
          </div>`).join('')}
      </div>
    </div>`;
}

/** Lee los valores de los campos custom del DOM. */
function _readCustomFields() {
  const vals = {};
  document.querySelectorAll('.cf-field').forEach(inp => {
    const key = inp.dataset.cfKey;
    const v   = inp.value.trim();
    if (key && v !== '') vals[key] = inp.type === 'number' && v !== '' ? +v : v;
  });
  return Object.keys(vals).length ? vals : null;
}

/** Renderiza custom fields en el inspector / Hub (solo lectura). */
function _customFieldsDisplayHTML(customFields, schemas, type) {
  const fields  = schemas?.[type] || [];
  const entries = fields.filter(f =>
    customFields?.[f.key] !== undefined && customFields[f.key] !== ''
  );
  if (!entries.length) return '';
  return `
    <div class="inspector-related-title" style="margin-top:10px">
      Detalles de ${esc(type)}
    </div>
    <div class="inspector-meta">
      ${entries.map(f => `
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">${esc(f.label)}</span>
          <span class="inspector-meta-val" style="font-family:var(--font-mono);font-size:.75rem">
            ${f.key.includes('Url') || f.key.includes('url')
              ? `<a href="${esc(String(customFields[f.key]))}" target="_blank"
                    style="color:var(--accent);text-decoration:none"
                    onclick="event.stopPropagation()">
                   ${esc(String(customFields[f.key]).replace(/^https?:\/\//,'').slice(0,38))} ↗
                 </a>`
              : esc(String(customFields[f.key]))}
          </span>
        </div>`).join('')}
    </div>`;
}

// Helper: resuelve todos los campos de persona de un formulario de proyecto en paralelo
async function _collectProjectPersonFields(respInputId, coauthInputId) {
  const [responsible, coauthorNames] = await Promise.all([
    _resolveCanonicalName($(respInputId)),
    _resolveCanonicalNames($(coauthInputId))
  ]);
  return {
    responsible,
    responsibleId:  _getPersonId($(respInputId)) ?? null,
    coauthors:      coauthorNames,
    coauthorIds:    _getPersonIds($(coauthInputId)).map(p => p.id).filter(Boolean)
  };
}

async function showAddProjectModal(defaultColId, defaultParentId = null) {
  // Los botones lo registran como handler de click: el primer argumento puede ser un MouseEvent.
  if (typeof defaultColId !== 'number') defaultColId = undefined;
  if (typeof defaultParentId !== 'number') defaultParentId = null;
  // -- Paso 0: elegir template ------------------------
  if (!App._skipTemplateStep) {
    showModal('Nuevo Proyecto — Plantilla', `
      <div class="modal-body">
        <div style="font-size:.8rem;color:var(--text-2);margin-bottom:14px">
          Elige una plantilla para pre-rellenar el formulario:
        </div>
        <div class="template-grid">
          ${Object.entries(PROJECT_TEMPLATES).map(([k, t]) => `
            <button class="template-card" data-tpl="${k}">
              <div class="template-card-label">${t.label}</div>
            </button>`).join('')}
        </div>
      </div>`);
    modalContent.querySelectorAll('[data-tpl]').forEach(btn => {
      btn.addEventListener('click', () => {
        App._projectTemplate = btn.dataset.tpl;
        App._skipTemplateStep = true;
        closeModal();
        setTimeout(() => showAddProjectModal(defaultColId, defaultParentId), 80);
      });
    });
    return;
  }
  // Limpiar flag
  App._skipTemplateStep = false;
  const tpl = PROJECT_TEMPLATES[App._projectTemplate || 'blank'];
  App._projectTemplate = null;

  const [cols, _addSchemas] = await Promise.all([
    db.kanbanColumns.orderBy('order').toArray(),
    _getTypeSchemas(),
  ]);
  const body = `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="mp-title" placeholder="Título del proyecto">
      </div>
      <div class="form-group">
        <label class="form-label">Tipo</label>
        <select class="form-select" id="mp-type">
          ${['Proyecto','Grant','Paper','Análisis','Dataset','Presentación','Curso'].map(t =>
            `<option ${t === tpl.type ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Columna Kanban</label>
        <select class="form-select" id="mp-col">
          ${cols.map(c => `<option value="${c.id}" ${c.id === defaultColId ? 'selected':''}>${esc(c.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Responsable</label>
        <input class="form-input" id="mp-responsible" placeholder="Dr. García">
      </div>
      <div class="form-group">
        <label class="form-label">Coautores (separados por coma)</label>
        <input class="form-input" id="mp-coauthors" placeholder="Dr. Martínez, Lic. López">
      </div>
      <div class="form-group">
        <label class="form-label">Fecha límite</label>
        <input class="form-input" type="date" id="mp-deadline">
        ${tpl.tasks?.length ? `<div class="form-hint" id="mpTplHint">La plantilla añadirá ${tpl.tasks.length} tareas${tpl.tasks.some(t => t.offset !== undefined) ? ', programadas respecto a esta fecha' : ''}.</div>` : ''}
      </div>
      <div class="form-group">
        <label class="form-label">Prioridad</label>
        <select class="form-select" id="mp-priority">
          ${['Alta','Media','Baja'].map(pr => `<option ${pr===tpl.priority?'selected':''}>${pr}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <textarea class="form-textarea" id="mp-desc" rows="3" placeholder="Soporta **Markdown**…">${esc(tpl.description)}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="mp-tags" placeholder="R, ecology, time-series"
             value="${tpl.tags.join(', ')}">
      </div>
      <div class="form-group">
        <label class="form-label">Proyecto padre (subproyecto de…)</label>
        <select class="form-select" id="mp-parent">
          <option value="">— Proyecto raíz —</option>
          ${(await db.projects.toArray()).filter(p => !p.parentId)
            .map(p => `<option value="${p.id}" ${p.id === defaultParentId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Área de investigación</label>
        <select class="form-select" id="mp-area">
          <option value="">— Sin área —</option>
          ${(await _getAreas()).map(a =>
            `<option value="${a.id}" ${a.id === App.areaContext ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
      </div>
      <div id="mpCFContainer">
        ${_customFieldsFormHTML(tpl.type, _addSchemas)}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="mpCancel">Cancelar</button>
      <button class="btn btn-primary" id="mpSave">Guardar Proyecto</button>
    </div>`;

  showModal('Nuevo Proyecto', body);
  // actualizar custom fields al cambiar tipo
  $('mp-type')?.addEventListener('change', e => {
    const cf = $('mpCFContainer');
    if (cf) cf.innerHTML = _customFieldsFormHTML(e.target.value, _addSchemas);
    const col = columnForType(cols, e.target.value);                           // si hay columnas pensadas para este tipo, parte en la primera de ellas
    if (col && $('mp-col')) $('mp-col').value = String(col);
  });
  focusField($('mp-title'));

  setTimeout(() => {
    _attachCollaboratorAutocomplete($('mp-responsible'));
    _attachCollaboratorAutocomplete($('mp-coauthors'), { multi: true });
  }, 80);

  $('mpCancel').addEventListener('click', closeModal);
  $('mpSave').addEventListener('click', async () => {
    const title = $('mp-title').value.trim();
    if (!title) { showToast('El título es requerido', 'error'); return; }

    // nombres canonizados + IDs
    const { responsible, responsibleId, coauthors: coauthorNames, coauthorIds } =
      await _collectProjectPersonFields('mp-responsible', 'mp-coauthors');

    const projectDeadline = $('mp-deadline').value || null;
    const newProjectId = await dbWrite(() => db.projects.add({
      title,
      type:          $('mp-type').value,
      columnId:      +$('mp-col').value,
      responsible,
      responsibleId: responsibleId || null,
      coauthors:     coauthorNames,
      coauthorIds:   coauthorIds.length ? coauthorIds : [],
      deadline:      $('mp-deadline').value || null,
      priority:      $('mp-priority').value,
      description:   $('mp-desc').value.trim(),
      tags:          $('mp-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      parentId:      +$('mp-parent').value || null,
      areaId:        +$('mp-area').value   || null,
      status:        'active',
      archived:      false,
      starred:       false,
      createdAt:     new Date().toISOString(),
      updatedAt:     new Date().toISOString(),
      customFields:  _readCustomFields() || {},
      columnHistory: [{ colId: +$('mp-col').value, enteredAt: new Date().toISOString(), exitedAt: null }],
    }));
    // Tareas de la plantilla: fechas relativas a la fecha límite (si no hay fecha, quedan sin fecha)
    for (const t of (tpl.tasks || [])) {
      let due = null, recurrence = null;
      if (t.weekly) { due = nextWeekdayISO(1); recurrence = { freq: 'weekly', interval: 1, until: projectDeadline }; }
      else if (t.every) { due = addDaysISO(t.first ?? 30); recurrence = { ...t.every, until: projectDeadline }; }
      else if (projectDeadline && t.offset !== undefined) { const d = new Date(projectDeadline + 'T12:00:00'); d.setDate(d.getDate() + t.offset); due = localDateISO(d); }
      if (due && due < localDateISO() && !t.weekly && !t.every) due = null;        // no crear tareas ya vencidas por una plantilla
      await dbWrite(() => Tasks.add({ title: t.title, projectId: newProjectId, due, recurrence, effort: t.effort }));
    }
    closeModal();
    showToast('Proyecto creado ✓', 'success');
    renderView(App.view);
  });
}

async function showAddCollectionModal() {
  const COLORS = ['#38bdf8','#34d399','#a78bfa','#fbbf24','#f87171','#fb923c','#2dd4bf'];
  showModal('Nueva Colección', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Nombre *</label>
        <input class="form-input" id="nc-name" placeholder="Visualización ggplot2…">
      </div>
      <div class="form-group">
        <label class="form-label">Color</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${COLORS.map((c,i) => `
            <label style="cursor:pointer">
              <input type="radio" name="nc-color" value="${c}" ${i===0?'checked':''} style="display:none">
              <span style="display:block;width:24px;height:24px;border-radius:50%;background:${c};
                           border:2px solid transparent;transition:border 140ms"
                    onclick="this.style.borderColor='#fff'"></span>
            </label>`).join('')}
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="ncCancel">Cancelar</button>
      <button class="btn btn-primary" id="ncSave">Crear</button>
    </div>`);
  focusField($('nc-name'));
  $('ncCancel').addEventListener('click', closeModal);
  $('ncSave').addEventListener('click', async () => {
    const name  = $('nc-name').value.trim();
    if (!name) { showToast('Nombre requerido', 'error'); return; }
    const color = document.querySelector('input[name="nc-color"]:checked')?.value || '#38bdf8';
    await createCollection(name, color);
    closeModal(); showToast('Colección creada ✓', 'success'); renderSnippets();
  });
}

async function showAddIdeaModal() {
  const projects = await db.projects.toArray();
  const body = `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="mi-title" placeholder="Idea o recurso…">
      </div>
      <div class="form-group">
        <label class="form-label">Contenido / URL / Nota</label>
        <textarea class="form-textarea" id="mi-content"
                  style="font-family:var(--font-mono);font-size:.82rem"
                  placeholder="Contenido en Markdown: **negrita**, \`código\`, - lista…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Proyectos vinculados</label>
        ${_projectPickerHTML('miProjectPicker')}
      </div>
      <div class="form-group">
        <label class="form-label">Deadline (opcional)</label>
        <input type="date" class="form-input" id="mi-deadline">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="miCancel">Cancelar</button>
      <button class="btn btn-primary" id="miSave">Guardar</button>
    </div>`;

  showModal('Nueva Idea', body);
  focusField($('mi-title'));
  setTimeout(() => _attachProjectPicker('miProjectPicker', projects), 80);

  $('miCancel').addEventListener('click', closeModal);
  $('miSave').addEventListener('click', async () => {
    const title = $('mi-title').value.trim();
    if (!title) { showToast('El título es requerido', 'error'); return; }
    const _mIds = _getProjectPickerIds('miProjectPicker');
    await dbWrite(() => db.ideas.add({
      title, content: $('mi-content').value.trim(),
      status:     'unread',
      projectId:  _mIds[0] || null,
      projectIds: _mIds,
      deadline:   $('mi-deadline').value || null,
      tags: [], subtasks: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
    closeModal();
    showToast('Idea guardada ✓', 'success');
    if (App.view === 'ideas') renderIdeas();
    updateBadges();
  });
}

async function showEditIdeaModal(idea) {
  const projects = await db.projects.toArray();
  showModal('Editar Idea', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="ei-title" value="${esc(idea.title)}">
      </div>
      <div class="form-group">
        <label class="form-label">Contenido / URL / Nota</label>
        <textarea class="form-textarea" id="ei-content" rows="4"
                style="font-family:var(--font-mono);font-size:.82rem">${esc(idea.content || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Proyectos vinculados</label>
        ${_projectPickerHTML('eiProjectPicker')}
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="ei-tags" value="${esc((idea.tags || []).join(', '))}">
      </div>
      <div class="form-group">
        <label class="form-label">Deadline (opcional)</label>
        <input type="date" class="form-input" id="ei-deadline" value="${esc(idea.deadline || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Estado</label>
        <select class="form-select" id="ei-status">
          <option value="unread"   ${idea.status === 'unread'   ? 'selected' : ''}>Sin revisar</option>
          <option value="reviewed" ${idea.status === 'reviewed' ? 'selected' : ''}>Revisada</option>
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost"   id="eiCancel">Cancelar</button>
      <button class="btn btn-primary" id="eiSave">Guardar Cambios</button>
    </div>`);
  focusField($('ei-title'));

  const _eiInitIds = (idea.projectIds?.length)
    ? idea.projectIds : (idea.projectId ? [idea.projectId] : []);
  setTimeout(() => _attachProjectPicker('eiProjectPicker', projects, _eiInitIds), 80);

  $('eiCancel').addEventListener('click', closeModal);
  $('eiSave').addEventListener('click', async () => {
    const title = $('ei-title').value.trim();
    if (!title) { showToast('El título es requerido', 'error'); return; }
    const _eIds = _getProjectPickerIds('eiProjectPicker');
    await snapshotIdea(idea.id);
    await dbWrite(() => db.ideas.update(idea.id, {
      title,
      content:    $('ei-content').value.trim(),
      projectId:  _eIds[0] || null,
      projectIds: _eIds,
      deadline:   $('ei-deadline').value || null,
      tags:       $('ei-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      status:     $('ei-status').value,
      updatedAt:  new Date().toISOString()
    }));
    closeModal();
    showToast('Idea actualizada ✓', 'success');
    await inspectIdea(idea.id);
    if (App.view === 'ideas') renderIdeas();
    updateBadges();
  });
}

async function showAddSnippetModal(preProjectId = null) {
  if (typeof preProjectId !== 'number') preProjectId = null;
  const projects = await db.projects.toArray();
  const body = `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="ms-title" placeholder="Nombre del snippet…">
      </div>
      <div class="form-group">
        <label class="form-label">Lenguaje</label>
        <select class="form-select" id="ms-lang">
          ${['R','Python','Bash','SQL','Other'].map(l => `<option>${l}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Código *</label>
        <textarea class="form-textarea" id="ms-code" rows="7"
                  style="font-family:var(--font-mono);font-size:.8rem"
                  placeholder="# Pega tu código aquí…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <input class="form-input" id="ms-desc" placeholder="Qué hace este snippet…">
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="ms-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p =>
            `<option value="${p.id}" ${p.id === preProjectId ? 'selected' : ''}>${esc(p.title)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="ms-tags" placeholder="R, ggplot, cleaning">
      </div>
      <div class="form-group">
        <label class="form-label">Colección</label>
        <select class="form-select" id="ms-collection">
          <option value="">Sin colección</option>
          ${(await getCollections()).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="msCancel">Cancelar</button>
      <button class="btn btn-primary" id="msSave">Guardar Snippet</button>
    </div>`;

  showModal('Nuevo Snippet', body);
  focusField($('ms-title'));
  $('msCancel').addEventListener('click', closeModal);
  $('msSave').addEventListener('click', async () => {
    const title = $('ms-title').value.trim();
    const code  = $('ms-code').value;
    if (!title || !code) { showToast('Título y código son requeridos', 'error'); return; }
    await dbWrite(() => db.snippets.add({
      title, language: $('ms-lang').value, code,
      description: $('ms-desc').value.trim(),
      projectIds: [...($('ms-project')?.selectedOptions || [])].map(o => +o.value).filter(Boolean),
      projectId:  +($('ms-project')?.selectedOptions[0]?.value) || null,
      tags:         $('ms-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      collectionId: +$('ms-collection').value || null,
      starred:      false,
      createdAt:    new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
    closeModal();
    showToast('Snippet guardado ✓', 'success');
    if (App.view === 'snippets')     renderSnippets();
    if (App.view === 'project-hub')  renderProjectHub();
  });
}

// ==============================================================
//  INSPECTOR PANEL
// ==============================================================
function openInspector() {
  document.body.classList.remove('inspector-closed');
  autoLabelControls(inspectorBody);
}
/**
 * Resetea el inspector visualmente sin tocar App._savedInspector.
 * Llamado internamente por renderView() en cada navegación.
 */
function _softResetInspector() {
  // Cancelar cualquier hover card pendiente
  HoverCard.hide();
  clearTimeout(HoverCard._timer);
  App.inspectorHistory    = [];
  App.inspectedType       = null;
  App.inspectedId         = null;
  App._inspectedProjectId = null;
  const crumb = $('inspectorCrumb');
  if (crumb) crumb.innerHTML = '';
  document.body.classList.add('inspector-closed');
  inspectorBody.innerHTML = `
    <div class="inspector-empty">
      <span class="empty-icon">◈</span>
      <p>Selecciona un elemento para inspeccionar</p>
    </div>`;
}

/** Cierra el inspector y descarta el estado guardado (acción explícita del usuario). */
function closeInspector() {
  App._savedInspector = null;
  _softResetInspector();
}

// ==============================================================
//  IN-PLACE EDITING — helper reutilizable para el inspector
// ==============================================================
/**
 * Convierte cualquier elemento con [data-inplace] del inspectorBody
 * en campo editable con un clic (o Enter con el teclado). onSave(field, value) recibe el
 * nombre del campo y el nuevo valor.
 * @param {function} onSave  async (field, newValue) => void
 */
function _attachInplaceEditors(onSave) {
  inspectorBody.querySelectorAll('[data-inplace]').forEach(el => {
    const label = el.dataset.inplaceLabel || el.closest('.inspector-meta-row')?.querySelector('.inspector-meta-key')?.textContent.trim() || el.dataset.inplace;
    el.classList.add('inplace-field');
    el.setAttribute('title', 'Clic para editar');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Editar ${label}`);
    el.tabIndex = 0;

    const open = (e) => {
      if (e.target.closest?.('a, [data-collab-hub]')) return;        // los enlaces y chips de persona siguen navegando
      e.stopPropagation();
      if (el.nextElementSibling?.classList.contains('inplace-input')) return;   // ya se está editando
      const field    = el.dataset.inplace;
      const type     = el.dataset.inplaceType || 'text';
      const oldVal   = el.dataset.inplaceValue ?? el.textContent.trim();
      let _cancelled = false;
      const picker   = type === 'select' || type === 'id-select';

      let input;
      if (type === 'select') {
        input = document.createElement('select');
        input.className = 'inplace-input';
        (el.dataset.inplaceOpts || '').split('|').forEach(o => {
          const opt = document.createElement('option');
          opt.value = o; opt.textContent = o;
          if (o === oldVal) opt.selected = true;
          input.appendChild(opt);
        });
      } else if (type === 'id-select') {
        // opciones codificadas como "id=Etiqueta|id2=Etiqueta2"
        input = document.createElement('select');
        input.className = 'inplace-input';
        (el.dataset.inplaceMap || '').split('|').forEach(pair => {
          const sep = pair.indexOf('=');
          if (sep < 0) return;
          const id    = pair.slice(0, sep);
          const label = pair.slice(sep + 1);
          const opt   = document.createElement('option');
          opt.value = id; opt.textContent = label;
          if (id === String(oldVal)) opt.selected = true;
          input.appendChild(opt);
        });
      } else if (type === 'tags') {
        input = document.createElement('input');
        input.className = 'inplace-input wide';
        input.type  = 'text';
        input.value = oldVal;
        input.placeholder = 'tag1, tag2, tag3…';
      } else {
        input = document.createElement('input');
        input.className = 'inplace-input';
        input.type  = type;
        input.value = oldVal;
      }
      input.setAttribute('aria-label', `Editar ${label}`);

      let _committed = false;
      const commit = async () => {
        if (_cancelled || _committed) return;
        _committed = true;
        const newVal  = input.value.trim();
        const sameVal = type === 'id-select'
          ? String(newVal) === String(oldVal)
          : newVal === oldVal;
        const shown = picker ? input.selectedOptions[0]?.textContent : newVal;
        el.style.display = ''; input.remove();
        if (sameVal) return;
        // El valor nuevo se ve al instante; la base de datos y el resto de la pantalla se actualizan enseguida detrás.
        if (type === 'tags') el.innerHTML = newVal.split(',').map(s => s.trim()).filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('') || '<span style="color:var(--text-3);font-size:.72rem;font-style:italic">Sin etiquetas — clic para editar</span>';
        else if (type === 'date') el.textContent = newVal ? formatDate(newVal) : '—';
        else el.textContent = shown || '—';
        el.dataset.inplaceValue = newVal;
        try { await onSave(field, newVal); }
        catch (err) { showToast('No se pudo guardar: ' + err.message, 'error'); refreshInspector(); }
      };

      input.addEventListener('blur',    commit);
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { ev.stopPropagation(); _cancelled = true; el.style.display = ''; input.remove(); el.focus(); }
      });
      if (picker) input.addEventListener('change', commit);           // al elegir una opción se guarda: sin Enter ni clic fuera

      el.style.display = 'none';
      el.insertAdjacentElement('afterend', input);
      input.focus();
      if (type === 'text') input.select();
      if (picker || type === 'date') { try { input.showPicker?.(); } catch { /* el navegador no lo permite aquí */ } }
    };

    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); open(e); } });
  });
}

/**
 * Restaura el inspector al ítem guardado. Consume App._savedInspector
 * de inmediato para que una nueva navegación pueda guardar estado fresco.
 */
async function _restoreInspector(saved) {
  App._savedInspector = null; // consumir antes de restaurar
  try {
    switch (saved.type) {
      case 'project':      await inspectProject(saved.id);      break;
      case 'idea':         await inspectIdea(saved.id);         break;
      case 'snippet': {
        const s = await db.snippets.get(saved.id);
        if (s) await inspectSnippet(s);
        break;
      }
      case 'meeting':      await inspectMeeting(saved.id);      break;
      case 'reference':    await inspectReference(saved.id);    break;
      case 'collaborator': await inspectCollaborator(saved.id); break;
    }
  } catch {
    /* el ítem fue eliminado — el inspector permanece cerrado */
  }
}

// ── Inspector Navigation History ──────────────
function _pushInspectorHistory(type, id, label) {
  App.inspectedType = type;
  App.inspectedId   = id;
  const last = App.inspectorHistory[App.inspectorHistory.length - 1];
  if (last && last.type === type && last.id === id) {
    _renderInspectorCrumb(); return;
  }
  App.inspectorHistory.push({ type, id, label });
  if (App.inspectorHistory.length > 6) App.inspectorHistory.shift();
  _renderInspectorCrumb();
}

function _renderInspectorCrumb() {
  const el = $('inspectorCrumb');
  if (!el) return;
  const items = App.inspectorHistory;
  if (items.length <= 1) { el.innerHTML = ''; return; }
  const ICONS = {
    project:'◉', idea:'◎', snippet:'⟨/⟩',
    meeting:'🗓', reference:'📚', collaborator:'👤'
  };
  el.innerHTML = items.map((item, i) => {
    const isLast = i === items.length - 1;
    const sep    = i > 0 ? '<span class="ic-sep">›</span>' : '';
    const short  = item.label.length > 18 ? item.label.slice(0,16) + '…' : item.label;
    return isLast
      ? `${sep}<span class="ic-item current">${ICONS[item.type] || '·'} ${esc(short)}</span>`
      : `${sep}<span class="ic-item link" data-ic-idx="${i}">${esc(short)}</span>`;
  }).join('');
  el.querySelectorAll('[data-ic-idx]').forEach(span => {
    span.addEventListener('click', () => {
      const idx  = +span.dataset.icIdx;
      const item = items[idx];
      App.inspectorHistory = items.slice(0, idx); // truncar antes de re-abrir
      const INSPECT_FN = {
        project:      inspectProject,
        idea:         inspectIdea,
        snippet:      async id => { const s = await db.snippets.get(id); if (s) inspectSnippet(s); },
        meeting:      inspectMeeting,
        reference:    inspectReference,
        collaborator: inspectCollaborator,
      };
      INSPECT_FN[item.type]?.(item.id);
    });
  });
}

/**
 * Busca snippets e ideas que mencionen el título del proyecto
 * y los añade asíncronamente al inspector sin bloquear el render inicial.
 */
async function _appendCrossRefs(projectId, projectTitle) {
  if (!projectTitle?.trim()) return;
  const q = projectTitle.toLowerCase();

  const [mentionSnips, mentionIdeas] = await Promise.all([
    db.snippets.filter(s =>
      s.title.toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q)
    ).toArray(),
    db.ideas.filter(i =>
      // Excluir ideas ya directamente vinculadas al proyecto
      (i.projectId !== projectId && !(i.projectIds || []).includes(projectId)) &&
      (i.title.toLowerCase().includes(q) || (i.content || '').toLowerCase().includes(q))
    ).toArray(),
  ]);

  // Menciones explícitas [[Título]] (además de las implícitas por texto)
  const explicit = await findMentions(projectTitle, { type: 'project', id: projectId });
  const addUnique = (list, extra) => [...list, ...extra.filter(x => !list.some(y => y.id === x.id))];
  const mentionIdeasAll = addUnique(mentionIdeas, explicit.ideas);
  const mentionSnipsAll = addUnique(mentionSnips, explicit.snippets);
  if (!mentionSnipsAll.length && !mentionIdeasAll.length && !explicit.projects.length && !explicit.meetings.length) return;

  // Verificar que el inspector aún muestra este proyecto
  const actionsEl = inspectorBody.querySelector('.inspector-actions');
  if (!actionsEl || !document.body.contains(actionsEl)) return;

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="inspector-related-title" style="margin-top:12px">
      🔗 Mencionado en
    </div>
    ${explicit.projects.map(x => `
      <div class="inspector-related-item" data-xref-proj="${x.id}" style="cursor:pointer;display:flex;align-items:center;gap:6px">
        <span style="flex-shrink:0;color:var(--accent);font-size:.8rem">◉</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.title)}</span>
      </div>`).join('')}
    ${explicit.meetings.map(x => `
      <div class="inspector-related-item" data-xref-meet="${x.id}" style="cursor:pointer;display:flex;align-items:center;gap:6px">
        <span style="flex-shrink:0;font-size:.8rem">🗓</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.title)}</span>
      </div>`).join('')}
    ${mentionSnipsAll.map(s => `
      <div class="inspector-related-item" data-xref-snip="${s.id}"
           style="cursor:pointer;display:flex;align-items:center;gap:6px">
        <span style="flex-shrink:0;color:var(--green);font-size:.8rem">⟨/⟩</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${esc(s.title)}
        </span>
        <span style="font-size:.62rem;color:var(--text-3);flex-shrink:0">${esc(s.language||'')}</span>
      </div>`).join('')}
    ${mentionIdeasAll.map(i => `
      <div class="inspector-related-item" data-xref-idea="${i.id}"
           style="cursor:pointer;display:flex;align-items:center;gap:6px">
        <span style="flex-shrink:0;color:var(--purple);font-size:.8rem">◎</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${esc(i.title)}
        </span>
        <span style="font-size:.62rem;color:${i.status==='unread'?'var(--amber)':'var(--text-3)'};flex-shrink:0">
          ${i.status==='unread'?'sin revisar':''}
        </span>
      </div>`).join('')}`;

  actionsEl.parentNode.insertBefore(el, actionsEl);

  el.querySelectorAll('[data-xref-snip]').forEach(e =>
    e.addEventListener('click', async () => {
      const s = await db.snippets.get(+e.dataset.xrefSnip);
      if (s) inspectSnippet(s);
    }));
  el.querySelectorAll('[data-xref-idea]').forEach(e =>
    e.addEventListener('click', () => inspectIdea(+e.dataset.xrefIdea)));
  el.querySelectorAll('[data-xref-proj]').forEach(e =>
    e.addEventListener('click', () => inspectProject(+e.dataset.xrefProj)));
  el.querySelectorAll('[data-xref-meet]').forEach(e =>
    e.addEventListener('click', () => inspectMeeting(+e.dataset.xrefMeet)));
}

// ── Atajos contextuales de teclado ────────────
function _contextualNew() {
  const MAP = {
    ideas:         showAddIdeaModal,
    projects:      showAddProjectModal,
    snippets:      showAddSnippetModal,
    kanban:        showAddProjectModal,
    meetings:      showAddMeetingModal,
    references:    showAddReferenceModal,
    collaborators: showAddCollaboratorModal,
    submissions:   () => { App._projectTemplate = 'paper'; App._skipTemplateStep = true; showAddProjectModal(); },
    weekly:        showAddMeetingModal,
  };
  (MAP[App.view] || showAddProjectModal)();
}

function _inspectorEdit() {
  // Reutiliza el botón de edición ya renderizado en el inspector activo
  const btn = inspectorBody.querySelector(
    '#inspEditBtn, #ideaEditBtn, #snipEditBtn, #meetEditBtn, #refEditBtn, #collabEditBtn'
  );
  btn?.click();
}

function _inspectorStar() {
  const btn = inspectorBody.querySelector(
    '#inspStarBtn, #ideaStarInspBtn, #snipStarBtn'
  );
  btn?.click();
}

// ==============================================================
//  INSPECTOR — SECCIONES COLAPSABLES
// ==============================================================

/** Lee si una sección del inspector está abierta (persiste en localStorage). */
function _inspSecOpen(sectionId) {
  const stored = localStorage.getItem(`ros-insp-sec-${sectionId}`);
  if (stored !== null) return stored === 'true';
  // Defaults: estas secciones abren por defecto
  const defaultOpen = new Set([
    'p-meta','p-comp','p-desc','p-tasks','p-sub',
    'p-ideas','p-tags','p-cf'
  ]);
  return defaultOpen.has(sectionId);
}

/** Genera el HTML de una sección colapsable del inspector. */
function _inspSectionHTML(id, title, content) {
  const open = _inspSecOpen(id);
  return `
    <div class="insp-sec">
      <div class="insp-sec-header" data-insp-sec="${id}">
        <span class="insp-sec-title">${title}</span>
        <span class="insp-sec-chev">${open ? '▾' : '▸'}</span>
      </div>
      <div class="insp-sec-body"${open ? '' : ' style="display:none"'}>${content}</div>
    </div>`;
}

/** Adjunta handlers de toggle a todas las secciones del inspector. */
function _attachInspSectionToggles() {
  inspectorBody.querySelectorAll('[data-insp-sec]').forEach(header => {
    header.addEventListener('click', () => {
      const id   = header.dataset.inspSec;
      const body = header.nextElementSibling;
      const chev = header.querySelector('.insp-sec-chev');
      if (!body) return;
      const wasOpen = body.style.display !== 'none';
      body.style.display = wasOpen ? 'none' : '';
      if (chev) chev.textContent = wasOpen ? '▸' : '▾';
      localStorage.setItem(`ros-insp-sec-${id}`, String(!wasOpen));
    });
  });
}

async function inspectProject(id) {
  const p = await db.projects.get(id);
  if (!p) return;
  if (App.inspectedId !== id) App._mdEditing = false;
  App._inspectedProjectId = id;

  // ── Todos los fetches en paralelo ─────────────────────────
  const [cols, areas, relIdeas, relSnips, refs, meets, schemas, projTasks] = await Promise.all([
    db.kanbanColumns.toArray(),
    _getAreas(),
    getRelatedIdeas(id),
    getRelatedSnippets(id),
    getReferences(id),
    getMeetings(id),
    _getTypeSchemas(),
    Tasks.forEntity('project', id),
  ]);

  const col      = cols.find(c => c.id === p.columnId);
  const colMap   = Object.fromEntries(cols.map(c => [c.id, c]));
  const currentArea = areas.find(a => a.id === p.areaId) || null;
  const colMapStr   = cols.map(c => `${c.id}=${c.title.replace(/[|=]/g,'')}`).join('|');
  const areaMapStr  = ['=Sin área', ...areas.map(a => `${a.id}=${a.name.replace(/[|=]/g,'')}`)]
    .join('|');

  _pushInspectorHistory('project', id, p.title);

  // ── Completeness ──────────────────────────────────────────
  const pct = projectCompleteness(p);
  const pctMissing = [
    !p.description?.trim() && 'descripción',
    !p.deadline             && 'deadline',
    !p.responsible?.trim()  && 'responsable',
    !(p.tags||[]).length    && 'etiquetas',
  ].filter(Boolean);

  // ── HTML por sección ──────────────────────────────────────

  // META
  const metaHTML = `
    <div class="inspector-meta">
      <div class="inspector-meta-row">
        <span class="inspector-meta-key">Tipo</span>
        <span class="inspector-meta-val"
              data-inplace="type" data-inplace-type="select"
              data-inplace-opts="Proyecto|Grant|Paper|Análisis|Dataset|Presentación|Curso"
              data-inplace-value="${esc(p.type||'Proyecto')}">
          <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
        </span>
      </div>
      <div class="inspector-meta-row">
        <span class="inspector-meta-key">Responsable</span>
        <span class="inspector-meta-val"
              data-inplace="responsible" data-inplace-value="${esc(p.responsible||'')}">
          ${_personChipHTML(p.responsible||'', p.responsibleId||null)}
        </span>
      </div>
      ${p.coauthors?.length ? `
      <div class="inspector-meta-row">
        <span class="inspector-meta-key">Coautores</span>
        <span class="inspector-meta-val" style="display:flex;flex-wrap:wrap;gap:3px">
          ${p.coauthors.map((n,i) => _personChipHTML(n, p.coauthorIds?.[i]||null, {small:true})).join('')}
        </span>
      </div>` : ''}
      <div class="inspector-meta-row">
        <span class="inspector-meta-key">Deadline</span>
        <span class="inspector-meta-val"
              data-inplace="deadline" data-inplace-type="date"
              data-inplace-value="${esc(p.deadline||'')}">
          ${p.deadline ? formatDate(p.deadline) : '—'}
        </span>
      </div>
      <div class="inspector-meta-row">
        <span class="inspector-meta-key">Prioridad</span>
        <span class="inspector-meta-val"
              data-inplace="priority" data-inplace-type="select"
              data-inplace-opts="Alta|Media|Baja"
              data-inplace-value="${esc(p.priority||'Media')}">
          ${p.priority ? `<span class="badge ${prioBadgeClass(p.priority)}">${esc(p.priority)}</span>` : '—'}
        </span>
      </div>
      <div class="inspector-meta-row">
        <span class="inspector-meta-key">Columna</span>
        <span class="inspector-meta-val"
              data-inplace="columnId" data-inplace-type="id-select"
              data-inplace-value="${p.columnId}"
              data-inplace-map="${esc(colMapStr)}">
          ${esc(col?.title ?? '—')}
        </span>
      </div>
      <div class="inspector-meta-row">
        <span class="inspector-meta-key">Área</span>
        <span class="inspector-meta-val"
              data-inplace="areaId" data-inplace-type="id-select"
              data-inplace-value="${esc(p.areaId??'')}"
              data-inplace-map="${esc(areaMapStr)}">
          ${currentArea
            ? `<span class="area-chip" style="border-color:${cssColor(currentArea.color)};color:${cssColor(currentArea.color)}">⊡ ${esc(currentArea.name)}</span>`
            : `<span style="color:var(--text-3);font-size:.74rem">— Sin área —</span>`}
        </span>
      </div>
      <div class="inspector-meta-row">
        <span class="inspector-meta-key">Creado</span>
        <span class="inspector-meta-val">${relativeDate(p.createdAt)}</span>
      </div>
    </div>`;

  // COMPLETENESS
  const compHTML = `
    ${completenessBarHTML(pct)}
    <div style="font-size:.7rem;color:var(--text-3);margin-top:5px;font-family:var(--font-mono)">
      ${pct >= 100 ? '✓ Proyecto completo'
        : 'Faltan: ' + pctMissing.join(', ')}
    </div>`;

  // DESCRIPCIÓN
  const descHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
      <span></span>
      <button class="btn btn-ghost btn-sm" id="mdEditToggle" style="font-size:.68rem">
        ${App._mdEditing ? '👁 Preview' : '✏ Editar'}
      </button>
    </div>
    ${App._mdEditing
      ? `<textarea class="form-input" id="mdDescEditor"
            style="min-height:110px;font-family:var(--font-mono);font-size:.8rem;resize:vertical"
            placeholder="Soporta **Markdown**, - listas, \`código\`…"
          >${esc(p.description||'')}</textarea>
         <div style="display:flex;gap:6px;margin-top:6px">
           <button class="btn btn-primary btn-sm" id="mdDescSave">Guardar</button>
           <button class="btn btn-ghost btn-sm" id="mdDescCancel">Cancelar</button>
         </div>`
      : `<div class="inspector-desc md-preview" id="mdDescPreview">
           ${p.description ? renderMd(p.description)
             : '<span style="color:var(--text-3);font-size:.78rem">Sin descripción — haz clic en ✏ Editar</span>'}
         </div>`}`;

  // SUBTAREAS
  const tasksHTML = subtaskListHTML(p, 'project', projTasks);

  // SUBMISSION (Paper only)
  const subHTML = p.type === 'Paper' ? (() => {
    const st        = p.submissionStatus || _defaultSubKey();
    const curIdx    = SUB_STATUSES.findIndex(s => s.key === st);
    const nextStage = SUB_STATUSES[curIdx + 1] || null;
    const prevStage = SUB_STATUSES[curIdx - 1] || null;

    // Tiempo en etapa actual
    const statusHist  = p.submissionStatusHistory || [];
    const lastChange  = statusHist.length
      ? statusHist[statusHist.length - 1].date : p.createdAt;
    const daysInStage = lastChange
      ? Math.floor((Date.now() - new Date(lastChange)) / 86400000) : null;
    const staleStage  = daysInStage !== null && daysInStage > 30;

    // Rounds summary
    const rounds     = p.submissionRounds || [];
    const lastRound  = rounds[rounds.length - 1] || null;

    return `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${subStatusBadge(st)}
        ${daysInStage !== null ? `
          <span style="font-family:var(--font-mono);font-size:.62rem;
                 color:${staleStage ? 'var(--amber)' : 'var(--text-3)'};
                 background:${staleStage ? 'rgba(251,191,36,.1)' : 'var(--bg-elevated)'};
                 border:1px solid ${staleStage ? 'rgba(251,191,36,.25)' : 'var(--border)'};
                 padding:1px 7px;border-radius:99px"
                title="Tiempo en etapa actual">
            ${staleStage ? '⚠' : '⏱'} ${daysInStage}d en esta etapa
          </span>` : ''}
      </div>

      <!-- Acciones rápidas de etapa -->
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px">
        ${nextStage ? `
          <button class="btn btn-primary btn-sm" id="insp-next-stage-btn"
                  data-status="${nextStage.key}"
                  style="font-size:.68rem;background:color-mix(in srgb,${cssColor(nextStage.color)} 20%,transparent);
                         color:${cssColor(nextStage.color)};border:1px solid color-mix(in srgb,${cssColor(nextStage.color)} 40%,transparent)">
            → ${nextStage.label}
          </button>` : ''}
        ${prevStage ? `
          <button class="btn btn-ghost btn-sm" id="insp-prev-stage-btn"
                  data-status="${prevStage.key}"
                  style="font-size:.68rem;color:var(--text-3)">
            ← ${prevStage.label}
          </button>` : ''}
        <button class="btn btn-ghost btn-sm" id="insp-edit-sub-btn"
                style="font-size:.65rem;padding:2px 7px">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" id="insp-rounds-btn"
                style="font-size:.65rem;padding:2px 7px">
          📋 Rondas${rounds.length ? ` (${rounds.length})` : ''}
        </button>
      </div>

      <div class="inspector-meta">
        ${p.targetVenue ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Venue</span>
          <span class="inspector-meta-val">${esc(p.targetVenue)}</span>
        </div>` : ''}
        ${p.submittedAt ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Enviado</span>
          <span class="inspector-meta-val" style="font-family:var(--font-mono);font-size:.74rem">
            ${formatDate(p.submittedAt)}
          </span>
        </div>` : ''}
        ${p.deadline ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Deadline</span>
          <span class="inspector-meta-val" style="font-family:var(--font-mono);font-size:.74rem">
            ${formatDate(p.deadline)}
          </span>
        </div>` : ''}
        ${lastRound ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Última ronda</span>
          <span class="inspector-meta-val" style="font-size:.72rem">
            <span style="color:${(() => {
              const DECISIONS = {major:'var(--red)',minor:'var(--amber)',reject:'var(--red)',accept:'var(--green)',pending:'var(--text-3)'};
              return DECISIONS[lastRound.decision] || 'var(--text-3)';
            })()}">
              ${(() => {
                const LABELS = {major:'Major Rev.',minor:'Minor Rev.',reject:'Rechazado',accept:'Aceptado',pending:'Pendiente'};
                return LABELS[lastRound.decision] || esc(String(lastRound.decision ?? ''));
              })()}
            </span>
            ${lastRound.decisionDate ? ` · ${formatDate(lastRound.decisionDate)}` : ''}
          </span>
        </div>` : ''}
      </div>

      <!-- Historial de estados -->
      ${statusHist.length > 1 ? `
        <div style="margin-top:8px">
          <div style="font-family:var(--font-mono);font-size:.58rem;text-transform:uppercase;
                      letter-spacing:.08em;color:var(--text-3);margin-bottom:4px">Historial</div>
          <div style="border-left:1px dashed var(--border-str);margin-left:4px">
            ${[...statusHist].reverse().slice(0, 4).map(h => {
              const s   = SUB_STATUSES.find(x => x.key === h.to) || { label: h.to || 'Inicio', color: 'var(--text-3)' };
              return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0 2px 8px;
                                  font-size:.68rem;color:var(--text-2);position:relative">
                <span style="position:absolute;left:-4px;width:7px;height:7px;border-radius:50%;
                             background:${cssColor(s.color)};border:1.5px solid var(--bg-elevated)"></span>
                <span style="color:${cssColor(s.color)}">${s.label}</span>
                <span style="color:var(--text-3);font-family:var(--font-mono);margin-left:auto">
                  ${relativeDate(h.date)}
                </span>
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}`;
  })() : '';

  // IDEAS VINCULADAS
  const ideasHTML = relIdeas.length ? relIdeas.slice(0,5).map(i => `
    <div class="inspector-related-item" data-goto-idea="${i.id}"
         style="cursor:pointer;display:flex;align-items:center;gap:4px">
      <span style="flex-shrink:0;color:${i.status==='unread'?'var(--amber)':'var(--text-3)'};font-size:.8rem">◎</span>
      <span style="flex:1">${esc(i.title)}</span>
      <span style="font-size:.6rem;color:var(--text-3)">→</span>
    </div>`).join('')
  : `<div style="font-size:.73rem;color:var(--text-3);font-style:italic;padding:2px 0">
       Sin ideas vinculadas. Agrega con + Idea abajo.</div>`;

  // SNIPPETS
  const snipsHTML = relSnips.length ? relSnips.slice(0,4).map(s => `
    <div class="inspector-related-item" data-goto-snip="${s.id}"
         style="cursor:pointer;display:flex;align-items:center;gap:5px">
      <span class="snippet-lang-badge lang-${_langClass(s.language)}" style="font-size:.55rem;flex-shrink:0">
        ${esc(s.language||'Other')}</span>
      <span style="flex:1">${esc(s.title)}</span>
    </div>`).join('')
  : `<div style="font-size:.73rem;color:var(--text-3);font-style:italic;padding:2px 0">Sin snippets vinculados.</div>`;

  // REFERENCIAS
  const refsHTML = refs.length ? refs.slice(0,4).map(r => `
    <div class="inspector-related-item" data-inspect-ref="${r.id}" style="cursor:pointer">
      📚 ${esc(r.authors?.split(',')[0]||'')} (${r.year||'?'}) — ${esc(r.title.slice(0,40))}
    </div>`).join('')
  : `<div style="font-size:.73rem;color:var(--text-3);font-style:italic;padding:2px 0">Sin referencias vinculadas.</div>`;

  // REUNIONES
  const meetsHTML = meets.length ? meets.slice(0,4).map(m => {
    const pending = (m.actionItems||[]).filter(a=>!a.done).length;
    return `<div class="inspector-related-item" data-inspect-meeting="${m.id}" style="cursor:pointer;
            display:flex;align-items:center;gap:6px">
      <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--text-3);flex-shrink:0">
        ${formatDate(m.date)}</span>
      <span style="flex:1">${esc(m.title)}</span>
      ${pending ? `<span style="font-size:.62rem;color:var(--amber);flex-shrink:0">⚑ ${pending}</span>` : ''}
    </div>`;
  }).join('')
  : `<div style="font-size:.73rem;color:var(--text-3);font-style:italic;padding:2px 0">Sin reuniones registradas.</div>`;

  // ETIQUETAS + CAMPOS PERSONALIZADOS
  const cfFields   = schemas?.[p.type] || [];
  const cfVals     = p.customFields || {};
  const cfEntries  = cfFields.filter(f => cfVals[f.key] !== undefined && cfVals[f.key] !== '');
  const tagsAndCFHTML = `
    <div class="insp-tags-field"
         data-inplace="tags" data-inplace-type="tags"
         data-inplace-value="${esc((p.tags||[]).join(', '))}">
      ${(p.tags||[]).length
        ? p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')
        : `<span style="color:var(--text-3);font-size:.72rem;font-style:italic">Sin etiquetas — doble clic</span>`}
    </div>
    ${cfEntries.length ? `
      <div style="margin-top:8px;display:flex;flex-direction:column;gap:5px">
        ${cfEntries.map(f => `
          <div class="inspector-meta-row">
            <span class="inspector-meta-key">${esc(f.label)}</span>
            <span class="inspector-meta-val" style="font-family:var(--font-mono);font-size:.74rem">
              ${f.key.includes('Url')||f.key.includes('url')
                ? `<a href="${esc(String(cfVals[f.key]))}" target="_blank"
                      style="color:var(--accent);text-decoration:none">↗ ${esc(String(cfVals[f.key]).replace(/^https?:\/\//,'').slice(0,32))}</a>`
                : esc(String(cfVals[f.key]))}
            </span>
          </div>`).join('')}
      </div>` : ''}`;

  // HISTORIAL DE CAMBIOS
  const histHTML = (() => {
    const hist = [...(p._history||[])].reverse().slice(0, 5);
    if (!hist.length) return '';
    const FIELDS = { title:'Título', type:'Tipo', responsible:'Responsable',
                     priority:'Prioridad', deadline:'Deadline', description:'Descripción' };
    return hist.map((snap, si) => {
      const prev  = hist[si+1] || snap;
      const diffs = Object.entries(FIELDS)
        .filter(([k]) => snap[k] !== prev[k] && si < hist.length-1)
        .map(([k,l]) =>
          `<span class="history-diff">${l}: </span>` +
          `<span class="history-diff-old">${esc(String(prev[k]||'—').slice(0,40))}</span> → ` +
          `<span class="history-diff-new">${esc(String(snap[k]||'—').slice(0,40))}</span>`)
        .join('<br>');
      return `<div class="history-entry">
        <span class="history-ts">${relativeDate(snap.ts)}</span>
        ${diffs || '<span style="color:var(--text-3)">Snapshot inicial</span>'}
      </div>`;
    }).join('');
  })();

  // TIEMPO POR COLUMNA
  const durations = computeColumnDurations(p, colMap);
  const colHistHTML = (() => {
    if (!durations.length) return '';
    const maxD = Math.max(...durations.map(d => d.days), 1);
    return `<div class="col-duration-list">
      ${durations.map(d => `
        <div class="col-duration-item">
          <span class="col-duration-name">${esc(d.colTitle)}</span>
          <div class="col-duration-bar-wrap">
            <div class="col-duration-bar"
                 style="width:${(d.days/maxD*100).toFixed(1)}%;background:${d.colColor}"></div>
          </div>
          <span class="col-duration-label">${d.days}d</span>
        </div>`).join('')}
    </div>`;
  })();

  // ── Ensamblar HTML del inspector ──────────────────────────
  inspectorBody.innerHTML = `
    <div>
      <div style="margin-bottom:8px;display:flex;gap:4px;flex-wrap:wrap">
        <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
        <span class="badge ${prioBadgeClass(p.priority)}">${esc(p.priority)}</span>
      </div>
      <div class="inspector-project-title" data-inplace="title" data-inplace-label="Título" data-inplace-value="${esc(p.title)}">${esc(p.title)}</div>

      ${_inspSectionHTML('p-meta', 'Metadatos', metaHTML)}
      ${_inspSectionHTML('p-comp', 'Completitud', compHTML)}
      ${_inspSectionHTML('p-desc', 'Descripción', descHTML)}
      ${_inspSectionHTML('p-tasks', `Tareas${projTasks.length ? ` · ${projTasks.filter(t=>t.done).length}/${projTasks.length}` : ''}`, tasksHTML)}

      <div class="insp-quickadd-bar">
        <span style="font-size:.63rem;color:var(--text-3);font-family:var(--font-mono)">Agregar:</span>
        <button class="btn btn-ghost btn-sm insp-qa-btn" data-qa="idea">+ Idea</button>
        <button class="btn btn-ghost btn-sm insp-qa-btn" data-qa="meeting">+ Reunión</button>
        <button class="btn btn-ghost btn-sm insp-qa-btn" data-qa="reference">+ Referencia</button>
        ${p.type==='Paper'?`<button class="btn btn-ghost btn-sm insp-qa-btn" data-qa="submission">📤</button>`:''}
        <button class="btn btn-ghost btn-sm insp-qa-btn" data-qa="flow" title="Pausa, posición en su columna y privacidad">${p.paused ? '⏸' : '⚙'} Estado</button>
      </div>

      ${p.type==='Paper' ? _inspSectionHTML('p-sub', '📤 Submission', subHTML) : ''}

      ${_inspSectionHTML('p-ideas',
        `Ideas vinculadas (${relIdeas.length})`,
        ideasHTML)}
      ${_inspSectionHTML('p-snips',
        `Snippets (${relSnips.length})`,
        snipsHTML)}
      ${_inspSectionHTML('p-refs',
        `Referencias (${refs.length})`,
        refsHTML)}
      ${_inspSectionHTML('p-meets',
        `Reuniones (${meets.length})`,
        meetsHTML)}
      ${_inspSectionHTML('p-tags', 'Etiquetas & Campos', tagsAndCFHTML)}
      ${durations.length ? _inspSectionHTML('p-colhist', 'Tiempo por columna', colHistHTML) : ''}
      ${histHTML ? _inspSectionHTML('p-hist', `Historial (${(p._history||[]).length})`, histHTML) : ''}

      <div class="inspector-actions">
        <button class="btn btn-primary btn-sm" id="inspHubBtn">⬡ Abrir Hub</button>
        <button class="btn btn-ghost btn-sm" id="inspEditBtn">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" id="inspFSBtn" title="Crear estructura FS">📁 FS</button>
        <button class="btn btn-ghost btn-sm" id="inspStarBtn">${p.starred?'★ Quitar fav.':'☆ Favorito'}</button>
        <button class="btn btn-ghost btn-sm" id="inspArchiveBtn">${p.archived?'↩ Restaurar':'⊟ Archivar'}</button>
        <button class="btn btn-danger btn-sm" id="inspDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();
  _attachInspSectionToggles();
  enhanceProjectInspector(p);                 // academic.js: clases, evaluaciones, respuesta a revisores
  _attachInplaceEditors(async (field, newVal) => {
    if (field === 'title' && !newVal) { showToast('El título no puede estar vacío', 'error'); refreshInspector(); return; }
    await snapshotProject(id);
    const upd = { updatedAt: new Date().toISOString() };
    switch (field) {
      case 'deadline': upd.deadline = newVal || null; break;
      case 'columnId': {
        const target = +newVal || null;
        if (target) { await recordColumnChange(id, target); }   // registra el historial como el drag & drop
        else upd.columnId = null;
        break;
      }
      case 'areaId':   upd.areaId   = newVal ? +newVal : null; break;
      case 'tags':     upd.tags     = newVal.split(',').map(s=>s.trim()).filter(Boolean); break;
      default:         upd[field]   = newVal;
    }
    await dbWrite(() => db.projects.update(id, upd));
    showToast('Campo actualizado ✓', 'success');
    await renderView(App.view);        // repinta la vista y el inspector a la vez, sin vaciarlo
  });

  // Cross-refs y subproyectos — async fire-and-forget
  _appendCrossRefs(id, p.title).catch(() => {});
  db.projects.where('parentId').equals(id).toArray().then(children => {
    if (!children.length) return;
    const actionsEl = inspectorBody.querySelector('.inspector-actions');
    if (!actionsEl) return;
    const subEl = document.createElement('div');
    subEl.innerHTML = `
      <div class="inspector-related-title">Subproyectos (${children.length})</div>
      <div class="subproject-list">
        ${children.map(c => `
          <div class="subproject-item" data-inspect-project="${c.id}">
            <span class="badge ${typeBadgeClass(c.type)}" style="flex-shrink:0">${esc(c.type)}</span>
            ${esc(c.title)}
          </div>`).join('')}
      </div>`;
    actionsEl.parentNode.insertBefore(subEl, actionsEl);
    subEl.querySelectorAll('[data-inspect-project]').forEach(el =>
      el.addEventListener('click', () => inspectProject(+el.dataset.inspectProject)));
  });

  // ── Event listeners ───────────────────────────────────────
  $('insp-edit-sub-btn')?.addEventListener('click', () => showAddSubmissionModal(null, p.id));

  // Botones de avance/retroceso de etapa en inspector
  inspectorBody.querySelector('#insp-next-stage-btn')?.addEventListener('click', e => {
    const status = e.currentTarget.dataset.status;
    _updatePipelineStage(p.id, status);
  });
  inspectorBody.querySelector('#insp-prev-stage-btn')?.addEventListener('click', e => {
    const status = e.currentTarget.dataset.status;
    _updatePipelineStage(p.id, status);
  });
  inspectorBody.querySelector('#insp-rounds-btn')?.addEventListener('click', () => {
    showSubmissionRoundsModal(p.id);
  });

  $('mdEditToggle')?.addEventListener('click', () => {
    App._mdEditing = !App._mdEditing; inspectProject(p.id);
  });
  $('mdDescSave')?.addEventListener('click', async () => {
    const val = $('mdDescEditor')?.value ?? '';
    await snapshotProject(p.id);
    await dbWrite(() => db.projects.update(p.id, { description: val, updatedAt: new Date().toISOString() }));
    App._mdEditing = false;
    showToast('Descripción guardada ✓', 'success');
    inspectProject(p.id);
  });
  $('mdDescCancel')?.addEventListener('click', () => {
    App._mdEditing = false; inspectProject(p.id);
  });

  inspectorBody.querySelectorAll('[data-toggle-st]').forEach(btn =>
    btn.addEventListener('click', () => toggleSubtask(id, +btn.dataset.toggleSt, 'project')));
  inspectorBody.querySelectorAll('[data-del-st]').forEach(btn =>
    btn.addEventListener('click', () => deleteSubtask(id, +btn.dataset.delSt, 'project')));
  {
    const stInput  = $(`stInput-${id}`);
    const stAddBtn = $(`stAddBtn-${id}`);
    stAddBtn?.addEventListener('click', () => {
      if (!stInput) return; addSubtask(id, stInput.value, 'project'); stInput.value = '';
    });
    stInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { addSubtask(id, stInput.value, 'project'); stInput.value = ''; }
    });
  }

  inspectorBody.querySelectorAll('[data-goto-idea]').forEach(el =>
    el.addEventListener('click', () => inspectIdea(+el.dataset.gotoIdea)));
  inspectorBody.querySelectorAll('[data-goto-snip]').forEach(el =>
    el.addEventListener('click', async () => {
      const s = await db.snippets.get(+el.dataset.gotoSnip); if (s) inspectSnippet(s);
    }));
  inspectorBody.querySelectorAll('[data-inspect-ref]').forEach(el =>
    el.addEventListener('click', () => inspectReference(+el.dataset.inspectRef)));
  inspectorBody.querySelectorAll('[data-inspect-meeting]').forEach(el =>
    el.addEventListener('click', () => inspectMeeting(+el.dataset.inspectMeeting)));

  inspectorBody.querySelectorAll('.insp-qa-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      switch (btn.dataset.qa) {
        case 'flow': {
          showModal(`⚙ ${p.title}`, `
            <div class="modal-body">
              <label class="form-check"><input type="checkbox" id="pf-paused" ${p.paused ? 'checked' : ''}> <strong>En pausa</strong> <span class="form-hint">(sale de Hoy, del tablero de urgencias y de la carga hasta que lo reanudes)</span></label>
              <div class="form-row-2" style="margin-top:8px">
                <div class="form-group"><label class="form-label">Motivo</label>
                  <input class="form-input" id="pf-reason" maxlength="300" placeholder="Esperando a José, paro…" value="${esc(p.pauseReason || '')}"></div>
                <div class="form-group"><label class="form-label">Revisar el</label>
                  <input class="form-input" type="date" id="pf-until" value="${esc(p.pausedUntil || '')}"></div>
              </div>
              <div class="form-group"><label class="form-label">Posición en su columna <span class="form-hint">(menor = antes)</span></label>
                <input class="form-input" type="number" id="pf-rank" step="1" placeholder="—" value="${p.rank ?? ''}"></div>
              <label class="form-check"><input type="checkbox" id="pf-private" ${p.private ? 'checked' : ''}> Privado <span class="form-hint">(la IA no ve este proyecto ni sus tareas, ideas, reuniones…)</span></label>
            </div>
            <div class="modal-footer"><button class="btn btn-ghost" id="pfCancel">Cancelar</button><button class="btn btn-primary" id="pfSave">Guardar</button></div>`);
          $('pfCancel').addEventListener('click', closeModal);
          $('pfSave').addEventListener('click', async () => {
            await dbWrite(() => db.projects.update(p.id, { paused: $('pf-paused').checked, pauseReason: $('pf-reason').value.trim().slice(0, 300), pausedUntil: isoDateOrNull($('pf-until').value),
              rank: Tasks.cleanRank($('pf-rank').value), private: $('pf-private').checked, updatedAt: new Date().toISOString() }));
            closeModal(); showToast('Guardado ✓', 'success'); inspectProject(p.id);
          });
          break;
        }
        case 'idea': {
          showModal(`+ Idea → ${p.title}`, `
            <div class="modal-body">
              <div class="form-group"><label class="form-label">Título *</label>
                <input class="form-input" id="qi-title" placeholder="Nueva idea…"></div>
              <div class="form-group"><label class="form-label">Contenido / Nota</label>
                <textarea class="form-textarea" id="qi-content" rows="2"></textarea></div>
              <div class="form-group"><label class="form-label">Deadline (opcional)</label>
                <input type="date" class="form-input" id="qi-deadline"></div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" id="qiCancel">Cancelar</button>
              <button class="btn btn-primary" id="qiSave">Guardar Idea</button>
            </div>`);
          focusField($('qi-title'));
          $('qiCancel').addEventListener('click', closeModal);
          $('qiSave').addEventListener('click', async () => {
            const title = $('qi-title').value.trim();
            if (!title) { showToast('Título requerido', 'error'); return; }
            const now = new Date().toISOString();
            await dbWrite(() => db.ideas.add({
              title, content: $('qi-content').value.trim(),
              status:'unread', projectId:p.id, projectIds:[p.id],
              deadline:$('qi-deadline')?.value||null,
              tags:[], subtasks:[], createdAt:now, updatedAt:now
            }));
            closeModal(); showToast('Idea añadida ✓','success'); updateBadges();
          });
          break;
        }
        case 'meeting':    await showAddMeetingModal(null, p.id); break;
        case 'reference':  await showAddReferenceModal(p.id);    break;
        case 'submission': await showAddSubmissionModal(null, p.id); break;
      }
    });
  });

  $('inspHubBtn').addEventListener('click', () => { App.projectHubId = id; navigate('project-hub'); });
  $('inspFSBtn').addEventListener('click', () => {
    navigate('filesystem');
    setTimeout(() => {
      const sel = $('fsProjectSelect');
      if (sel) sel.value = id;
      sel?.dispatchEvent(new Event('change'));
    }, 300);
  });
  $('inspEditBtn').addEventListener('click', () => showEditProjectModal(p));
  $('inspStarBtn').addEventListener('click', async () => {
    await db.projects.update(id, { starred: !p.starred, updatedAt: new Date().toISOString() });
    showToast(p.starred ? 'Quitado de favoritos' : '★ Añadido a favoritos', 'success');
    inspectProject(id);
    if (['projects','starred'].includes(App.view)) renderView(App.view);
  });

  $('inspArchiveBtn').addEventListener('click', async () => {
    const wasArchived = !!p.archived;
    await db.projects.update(id, { archived: !wasArchived, updatedAt: new Date().toISOString() });
    if (!wasArchived) {
      UndoStack.push({
        label: `Archivar "${p.title.slice(0,30)}"`,
        undo: async () => {
          await dbWrite(() => db.projects.update(id, { archived: false, updatedAt: new Date().toISOString() }));
        }
      });
      showToastWithUndo('Proyecto archivado', 'info');
    } else {
      showToast('Proyecto restaurado', 'success');
    }
    closeInspector(); renderView(App.view);
  });

  $('inspDeleteBtn').addEventListener('click', async () => {
    const restore = await dbWrite(() => deleteProjectCascade(id));   // desvincula ideas/snippets/reuniones…
    UndoStack.push({
      label: `Eliminar "${p.title.slice(0,30)}"`,
      undo: async () => { await dbWrite(() => restore()); }
    });
    closeInspector();
    showToastWithUndo('Proyecto eliminado', 'info');
    renderView(App.view);
  });
}

async function inspectSnippet(s) {
  const proj    = s.projectId ? await db.projects.get(s.projectId) : null;
  _pushInspectorHistory('snippet', s.id, s.title);
  const colls   = await getCollections();
  const collMap = Object.fromEntries(colls.map(c => [c.id, c]));
  const snipCol = s.collectionId ? collMap[s.collectionId] : null;
  const encoded = encodeURIComponent(s.code || '');
  const hlLang  = { R:'r', Python:'python', Bash:'bash', SQL:'sql' }[s.language] || 'plaintext';

  inspectorBody.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span class="snippet-lang-badge lang-${s.language || 'Other'}">${esc(s.language || 'Other')}</span>
        ${s.starred ? '<span style="color:var(--amber)">★</span>' : ''}
      </div>
      <div class="inspector-project-title">${esc(s.title)}</div>
      <div class="inspector-meta">
        ${proj ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Proyecto</span>
          <span class="inspector-meta-val" style="cursor:pointer;color:var(--accent)"
                id="snipNavProj">${esc(proj.title)}</span>
        </div>` : ''}
        ${snipCol ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Colección</span>
          <span class="inspector-meta-val" style="display:flex;align-items:center;gap:5px">
            <span style="width:8px;height:8px;border-radius:50%;background:${cssColor(snipCol.color)}"></span>
            ${esc(snipCol.name)}
          </span>
        </div>` : ''}
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Editado</span>
          <span class="inspector-meta-val">${relativeDate(s.updatedAt)}</span>
        </div>
      </div>
      ${s.description ? `<div class="inspector-desc">${esc(s.description)}</div>` : ''}
      ${(s.tags||[]).length ? `
        <div class="inspector-related-title">Etiquetas</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
          ${s.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>` : ''}
      <div class="inspector-related-title">Código</div>
      <div class="snippet-code" style="max-height:300px;overflow-y:auto;border-radius:var(--radius-md);margin-bottom:10px">
        <button class="copy-btn-float" data-code="${encoded}">Copy</button>
        <pre><code class="language-${hlLang}">${esc(s.code || '')}</code></pre>
      </div>
      <div class="inspector-actions">
        <button class="btn btn-ghost btn-sm" id="snipEditBtn">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" id="snipStarBtn"
                style="color:${s.starred ? 'var(--amber)' : 'inherit'}">
          ${s.starred ? '★ Quitar fav.' : '☆ Favorito'}
        </button>
        <button class="btn btn-danger btn-sm" id="snipDeleteBtn">✕ Eliminar</button>
      </div>
    </div>`;

  openInspector();
  inspectorBody.querySelectorAll('pre code').forEach(_highlightBlock);

  // "Usado en" — backlink al hub del proyecto
  if (s.projectId) {
    db.projects.get(s.projectId).then(p => {
      if (!p) return;
      const usedEl = document.createElement('div');
      usedEl.innerHTML = `
        <div class="inspector-related-title" style="margin-top:14px">Usado en</div>
        <div class="inspector-related-item" style="cursor:pointer;display:flex;align-items:center;gap:6px"
             id="snipUsedInHub">
          <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
          <span style="color:var(--accent);flex:1">${esc(p.title)}</span>
          <span style="font-size:.65rem;color:var(--text-3);font-family:var(--font-mono)">Abrir Hub →</span>
        </div>`;
      inspectorBody.querySelector('.inspector-actions')
        ?.insertAdjacentElement('beforebegin', usedEl);
      usedEl.querySelector('#snipUsedInHub').addEventListener('click', () => {
        App.projectHubId = p.id; navigate('project-hub');
      });
    });
  }

  inspectorBody.querySelectorAll('.copy-btn-float').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await copyText(decodeURIComponent(btn.dataset.code), 'Código copiado ✓')) { btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Copy', 1500); }
    });
  });
  $('snipNavProj')?.addEventListener('click', () => {
    navigate('projects'); setTimeout(() => inspectProject(proj.id), 120);
  });
  $('snipEditBtn').addEventListener('click', () => showEditSnippetModal(s));
  $('snipStarBtn').addEventListener('click', async () => {
    await db.snippets.update(s.id, { starred: !s.starred });
    showToast(s.starred ? 'Quitado de favoritos' : '★ Favorito', 'success');
    inspectSnippet(await db.snippets.get(s.id));
    if (App.view === 'snippets') renderSnippets();
  });
  $('snipDeleteBtn').addEventListener('click', async () => {
    {
      await deleteWithUndo('snippets', s.id, 'Eliminar snippet', 'Snippet eliminado');
      closeInspector();
      if (App.view === 'snippets') renderSnippets();
      updateBadges();
    }
  });
}

async function showEditSnippetModal(s) {
  const [projects, collections] = await Promise.all([
    db.projects.toArray(), getCollections()
  ]);
  showModal('Editar Snippet', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título *</label>
        <input class="form-input" id="es-title" value="${esc(s.title)}">
      </div>
      <div class="form-group">
        <label class="form-label">Lenguaje</label>
        <select class="form-select" id="es-lang">
          ${['R','Python','Bash','SQL','Other'].map(l =>
            `<option ${l === s.language ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Código *</label>
        <textarea class="form-textarea" id="es-code" rows="8"
                  style="font-family:var(--font-mono);font-size:.8rem">${esc(s.code || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <input class="form-input" id="es-desc" value="${esc(s.description || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Vincular a proyecto</label>
        <select class="form-select" id="es-project">
          <option value="">Sin proyecto</option>
          ${projects.map(p =>
            `<option value="${p.id}" ${p.id === s.projectId ? 'selected' : ''}>${esc(p.title)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas (separadas por coma)</label>
        <input class="form-input" id="es-tags" value="${esc((s.tags||[]).join(', '))}">
      </div>
      <div class="form-group">
        <label class="form-label">Colección</label>
        <select class="form-select" id="es-collection">
          <option value="">Sin colección</option>
          ${collections.map(c =>
            `<option value="${c.id}" ${c.id === s.collectionId ? 'selected' : ''}>${esc(c.name)}</option>`
          ).join('')}
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost"   id="esCancel">Cancelar</button>
      <button class="btn btn-primary" id="esSave">Guardar Cambios</button>
    </div>`);
  focusField($('es-title'));
  $('esCancel').addEventListener('click', closeModal);
  $('esSave').addEventListener('click', async () => {
    const title = $('es-title').value.trim();
    const code  = $('es-code').value;
    if (!title || !code) { showToast('Título y código son requeridos', 'error'); return; }
    await dbWrite(() => db.snippets.update(s.id, {
      title,
      language:     $('es-lang').value,
      code,
      description:  $('es-desc').value.trim(),
      projectId:    +$('es-project').value    || null,
      tags:         $('es-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      collectionId: +$('es-collection').value || null,
      updatedAt:    new Date().toISOString()
    }));
    closeModal();
    showToast('Snippet actualizado ✓', 'success');
    inspectSnippet(await db.snippets.get(s.id));
    if (App.view === 'snippets') renderSnippets();
  });
}

function _epSubFieldsHTML(p) {
  return `
    <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
      <div style="font-family:var(--font-mono);font-size:.6rem;text-transform:uppercase;
                  letter-spacing:.1em;color:var(--text-3);margin-bottom:8px">
        Submission (Paper)
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">Estado de Submission</label>
          <select class="form-select" id="ep-sub-status">
            ${SUB_STATUSES.map(s =>
              `<option value="${esc(s.key)}" ${(p.submissionStatus || _defaultSubKey())===s.key?'selected':''}>${esc(s.label)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">Venue / Journal / Fondo objetivo</label>
          <input class="form-input" id="ep-sub-venue"
                 value="${esc(p.targetVenue||'')}"
                 placeholder="Nature, FONDECYT, ISMIR 2025…">
        </div>
        <div class="form-group">
          <label class="form-label">Fecha de envío efectivo</label>
          <input class="form-input" type="date" id="ep-sub-submitted"
                 value="${esc(p.submittedAt||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Notas de submission</label>
          <input class="form-input" id="ep-sub-notes"
                 value="${esc(p.submissionNotes||'')}"
                 placeholder="Observaciones del editor…">
        </div>
      </div>
    </div>`;
}

async function showEditProjectModal(p) {
  const [cols, _editSchemas] = await Promise.all([
    db.kanbanColumns.orderBy('order').toArray(),
    _getTypeSchemas(),
  ]);
  const body = `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Título</label>
        <input class="form-input" id="ep-title" value="${esc(p.title)}">
      </div>
      <div class="form-group">
        <label class="form-label">Tipo</label>
        <select class="form-select" id="ep-type">
          ${['Proyecto','Grant','Paper','Análisis','Dataset','Presentación','Curso'].map(t => `<option ${t===p.type?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Columna Kanban</label>
        <select class="form-select" id="ep-col">
          ${cols.map(c => `<option value="${c.id}" ${c.id===p.columnId?'selected':''}>${esc(c.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Responsable</label>
        <input class="form-input" id="ep-responsible" value="${esc(p.responsible || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Coautores (separados por coma)</label>
        <input class="form-input" id="ep-coauthors" value="${esc((p.coauthors||[]).join(', '))}">
      </div>
      <div class="form-group">
        <label class="form-label">Fecha límite</label>
        <input class="form-input" type="date" id="ep-deadline" value="${esc(p.deadline || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Prioridad</label>
        <select class="form-select" id="ep-priority">
          ${['Alta','Media','Baja'].map(pr => `<option ${pr===p.priority?'selected':''}>${pr}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <textarea class="form-textarea" id="ep-desc">${esc(p.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Etiquetas</label>
        <input class="form-input" id="ep-tags" value="${esc((p.tags||[]).join(', '))}">
      </div>
      <div class="form-group">
        <label class="form-label">Área de investigación</label>
        <select class="form-select" id="ep-area">
          <option value="">— Sin área —</option>
          ${(await _getAreas()).map(a =>
            `<option value="${a.id}" ${a.id === p.areaId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
      </div>
      <div id="epSubSection">
        ${p.type === 'Paper' ? _epSubFieldsHTML(p) : ''}
      </div>
      <div id="epCFContainer">
        ${_customFieldsFormHTML(p.type, _editSchemas, p.customFields || {})}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="epCancel">Cancelar</button>
      <button class="btn btn-primary" id="epSave">Guardar Cambios</button>
    </div>`;

  showModal('Editar Proyecto', body);

  // actualizar custom fields al cambiar tipo
  $('ep-type')?.addEventListener('change', e => {
    const t  = e.target.value;
    const cf = $('epCFContainer');
    if (cf) cf.innerHTML = _customFieldsFormHTML(t, _editSchemas, p.customFields || {});
    const ss = $('epSubSection');
    if (ss) ss.innerHTML = t === 'Paper' ? _epSubFieldsHTML(p) : '';
  });

  setTimeout(() => {
    const respInput   = $('ep-responsible');
    const coauthInput = $('ep-coauthors');

    // Fijar IDs canónicos antes de que _attachCollaboratorAutocomplete
    // intente restaurar _idMap desde los data-attributes
    if (p.responsibleId)
      respInput.dataset.selectedCollabId = String(p.responsibleId);
    if ((p.coauthorIds || []).length && (p.coauthors || []).length) {
      const pairs = p.coauthors
        .map((name, i) => [name, p.coauthorIds[i] || null])
        .filter(([, id]) => id);
      if (pairs.length)
        coauthInput.dataset.collabIdMap = JSON.stringify(pairs);
    }

    _attachCollaboratorAutocomplete(respInput);
    _attachCollaboratorAutocomplete(coauthInput, { multi: true });
  }, 80);

  $('epCancel').addEventListener('click', closeModal);
  $('epSave').addEventListener('click', async () => {
    // nombres canonizados + IDs
    const { responsible, responsibleId, coauthors: coauthorNames, coauthorIds } =
      await _collectProjectPersonFields('ep-responsible', 'ep-coauthors');

    await snapshotProject(p.id);
    const newType          = $('ep-type').value;
    const subStatusEl      = $('ep-sub-status');
    const subUpdates       = newType === 'Paper' && subStatusEl ? {
      submissionStatus: subStatusEl.value,
      targetVenue:      ($('ep-sub-venue')?.value  || '').trim() || null,
      submittedAt:      $('ep-sub-submitted')?.value || null,
      submissionNotes:  ($('ep-sub-notes')?.value   || '').trim(),
    } : {};

    const newCol = +$('ep-col').value;
    if (newCol && newCol !== p.columnId) await dbWrite(() => recordColumnChange(p.id, newCol));
    await dbWrite(() => db.projects.update(p.id, {
      title:         $('ep-title').value.trim(),
      type:          newType,
      columnId:      newCol,
      responsible,
      responsibleId: responsibleId || null,
      coauthors:     coauthorNames,
      coauthorIds:   coauthorIds.length ? coauthorIds : [],
      deadline:      $('ep-deadline').value || null,
      priority:      $('ep-priority').value,
      description:   $('ep-desc').value.trim(),
      tags:          $('ep-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      areaId:        +$('ep-area').value || null,
      updatedAt:     new Date().toISOString(),
      customFields:  _readCustomFields() || p.customFields || {},
      ...subUpdates,
    }));
    closeModal();
    showToast('Proyecto actualizado ✓', 'success');
    if (App.view === 'project-hub') {
      renderProjectHub();
    } else {
      renderView(App.view);
      setTimeout(() => inspectProject(p.id), 150);
    }
  });
}

async function inspectIdea(id) {
  const idea = await db.ideas.get(id);
  if (!idea) return;
  const proj = idea.projectId ? await db.projects.get(idea.projectId) : null;
  const ideaTasks = await Tasks.forEntity('idea', id);
  _pushInspectorHistory('idea', id, idea.title);

  inspectorBody.innerHTML = `
    <div>
      <div class="badge ${idea.status === 'reviewed' ? 'badge-paper' : 'badge-prio-alta'}"
           style="margin-bottom:12px">
        ${idea.status === 'reviewed' ? '✓ Revisada' : '● Sin revisar'}
      </div>
      <div class="inspector-project-title">${esc(idea.title)}</div>
      ${idea.content ? `<div class="inspector-desc md-preview"
        style="font-family:var(--font-mono);font-size:.78rem">${renderMd(idea.content)}</div>` : ''}
      ${(idea._history||[]).length ? (() => {
        const hist = [...(idea._history||[])].reverse().slice(0, 5);
        return `
          <div class="inspector-related-title" style="margin-top:12px">
            Historial (últimas ${hist.length} versiones)
          </div>
          <div class="history-list">
            ${hist.map((snap, si) => {
              const prev  = hist[si + 1] || snap;
              const FIELDS = { title:'Título', content:'Contenido', status:'Estado' };
              const diffs = Object.entries(FIELDS)
                .filter(([k]) => snap[k] !== prev[k] && si < hist.length - 1)
                .map(([k, label]) =>
                  `<span class="history-diff">${label}: </span>` +
                  `<span class="history-diff-old">${esc(String(prev[k]||'—').slice(0,60))}</span> → ` +
                  `<span class="history-diff-new">${esc(String(snap[k]||'—').slice(0,60))}</span>`)
                .join('<br>');
              return `
                <div class="history-entry">
                  <span class="history-ts">${relativeDate(snap.ts)}</span>
                  ${diffs || '<span style="color:var(--text-3)">Snapshot inicial</span>'}
                  <button class="btn btn-ghost btn-sm restore-idea-snap"
                    data-idea-id="${idea.id}" data-snap-idx="${si}"
                    style="font-size:.63rem;margin-top:4px;color:var(--accent)">
                    ↩ Restaurar esta versión
                  </button>
                </div>`;
            }).join('')}
          </div>`;
      })() : ''}
      <div class="inspector-meta">
        ${proj ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Proyecto</span>
          <span class="inspector-meta-val"
                style="cursor:pointer;color:var(--accent)"
                id="inspIdeaNavProj">${esc(proj.title)}</span>
        </div>` : ''}
        ${idea.deadline ? `<div class="inspector-meta-row">
          <span class="inspector-meta-key">Deadline</span>
          <span class="inspector-meta-val" style="color:${(() => {
            const t = new Date(); t.setHours(0,0,0,0);
            const d = Math.round((new Date(idea.deadline + 'T00:00:00') - t) / 86400000);
            return d < 0 ? 'var(--red)' : d <= 7 ? 'var(--amber)' : 'var(--text-2)';
          })()}">⏱ ${formatDate(idea.deadline)}</span>
        </div>` : ''}
        <div class="inspector-meta-row">
          <span class="inspector-meta-key">Creada</span>
          <span class="inspector-meta-val">${relativeDate(idea.createdAt)}</span>
        </div>
      </div>
      ${subtaskListHTML(idea, 'idea', ideaTasks)}
      <div class="inspector-actions" style="margin-top:14px">
        <button class="btn btn-ghost btn-sm" id="ideaEditBtn">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" id="ideaToggleReviewBtn">
          ${idea.status === 'reviewed' ? '○ Sin revisar' : '✓ Revisada'}
        </button>
        <button class="btn btn-ghost btn-sm" id="ideaStarInspBtn"
                style="color:${idea.starred ? 'var(--amber)' : 'var(--text-3)'}">
          ${idea.starred ? '★' : '☆'}
        </button>
        <button class="btn btn-ghost btn-sm" id="ideaToTaskBtn" title="Convertir esta idea en una tarea y quitarla de la bandeja">→ Tarea</button>
        <button class="btn btn-ghost btn-sm" id="ideaToProjectBtn" title="Convertir esta idea en un proyecto nuevo">→ Proyecto</button>
        <button class="btn btn-danger btn-sm" id="ideaDeleteBtn">✕ Eliminar</button>
      </div>`;

  openInspector();

  // Navigate to linked project
  $('inspIdeaNavProj')?.addEventListener('click', () => {
    navigate('projects'); setTimeout(() => inspectProject(proj.id), 120);
  });

  // Toggle review status
  $('ideaToggleReviewBtn').addEventListener('click', async () => {
    await snapshotIdea(id); // ← antes de cualquier db.ideas.update
    await dbWrite(() => db.ideas.update(id, {
      status: idea.status === 'reviewed' ? 'unread' : 'reviewed',
      updatedAt: new Date().toISOString()
    }));
    inspectIdea(id);
    if (App.view === 'ideas') renderIdeas();
    updateBadges();
  });

  _appendBacklinks('idea', id, idea.title).catch(() => {});
  $('ideaToTaskBtn')?.addEventListener('click', () => promoteIdea(id, 'task'));
  $('ideaToProjectBtn')?.addEventListener('click', () => promoteIdea(id, 'project'));

  // Subtask handlers
  inspectorBody.querySelectorAll('[data-toggle-st]').forEach(btn => {
    btn.addEventListener('click', () =>
      toggleSubtask(id, +btn.dataset.toggleSt, btn.dataset.entityType || 'idea'));
  });
  inspectorBody.querySelectorAll('[data-del-st]').forEach(btn => {
    btn.addEventListener('click', () =>
      deleteSubtask(id, +btn.dataset.delSt, btn.dataset.entityType || 'idea'));
  });
  // -- Listener restaurar snapshot de idea -------------
  inspectorBody.querySelectorAll('.restore-idea-snap').forEach(btn => {
    btn.addEventListener('click', async () => {
      const iid    = +btn.dataset.ideaId;
      const snapIdx = +btn.dataset.snapIdx;
      const idea   = await db.ideas.get(iid);
      const hist   = [...(idea._history||[])].reverse();
      const snap   = hist[snapIdx];
      if (!snap) return;
      await snapshotIdea(iid);
      await dbWrite(() => db.ideas.update(iid, {
        title:   snap.title,
        content: snap.content,
        updatedAt: new Date().toISOString()
      }));
      showToast('Versión restaurada ✓', 'success');
      inspectIdea(iid);
    });
  });

  const stInput  = $(`stInput-${id}`);
  const stAddBtn = $(`stAddBtn-${id}`);
  const stType   = stAddBtn?.dataset.entityType || 'idea';
  stAddBtn?.addEventListener('click', () => {
    if (!stInput) return;
    addSubtask(id, stInput.value, stType);
    stInput.value = '';
  });
  stInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { addSubtask(id, stInput.value, stType); stInput.value = ''; }
  });

  $('ideaEditBtn').addEventListener('click', () => showEditIdeaModal(idea));

  $('ideaStarInspBtn').addEventListener('click', async () => {
    await db.ideas.update(id, { starred: !idea.starred });
    showToast(idea.starred ? 'Quitado de favoritos' : '★ Favorito', 'success');
    inspectIdea(id);
    updateBadges();
  });

  $('ideaDeleteBtn').addEventListener('click', async () => {
    const restore = await dbWrite(() => deleteIdeaCascade(id));      // también elimina las tareas de la idea
    UndoStack.push({
      label: `Eliminar idea "${idea.title.slice(0,30)}"`,
      undo:  async () => { await dbWrite(() => restore()); }
    });
    closeInspector();
    showToastWithUndo('Idea eliminada', 'info');
    if (App.view === 'ideas') renderIdeas();
  });
}


// ==============================================================
//  DIÁLOGOS PROPIOS (en lugar de confirm() / prompt() del navegador)
//  No bloquean la página, siguen el tema, funcionan igual en la app instalada y en el móvil, y pueden abrirse encima de
//  otra ventana (p. ej. confirmar desde «Gestionar columnas»). Esc cancela; Enter acepta.
// ==============================================================
function askDialog({ title = '', message = '', confirmLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false, input = null, typeToConfirm = '' } = {}) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const ov = document.createElement('div');
    ov.className = 'confirm-overlay';
    ov.innerHTML = `
      <div class="confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle" ${message ? 'aria-describedby="confirmMsg"' : ''}>
        <h3 class="confirm-title" id="confirmTitle">${esc(title)}</h3>
        ${message ? `<p class="confirm-msg" id="confirmMsg">${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
        ${input ? `<input class="form-input confirm-input" id="confirmInput" maxlength="200" autocomplete="off" aria-label="${esc(input.label || title)}" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}">` : ''}
        ${typeToConfirm ? `<label class="confirm-type">Para confirmar, escribe <strong>${esc(typeToConfirm)}</strong>
          <input class="form-input confirm-input" id="confirmInput" autocomplete="off" aria-label="Escribe ${esc(typeToConfirm)} para confirmar"></label>` : ''}
        <div class="confirm-actions">
          <button class="btn btn-ghost" id="confirmNo" type="button">${esc(cancelLabel)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirmYes" type="button">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const yes = ov.querySelector('#confirmYes'), no = ov.querySelector('#confirmNo'), field = ov.querySelector('#confirmInput');
    if (typeToConfirm) {
      yes.disabled = true;
      field.addEventListener('input', () => { yes.disabled = field.value.trim().toLowerCase() !== typeToConfirm.toLowerCase(); });
    }
    const finish = ok => {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      if (prevFocus?.isConnected && prevFocus !== document.body) prevFocus.focus?.({ preventScroll: true });
      resolve(input ? (ok ? field.value.trim() : null) : !!ok);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
      else if (e.key === 'Enter' && field && e.target === field) { e.preventDefault(); e.stopImmediatePropagation(); if (!yes.disabled) finish(true); }
      else if (e.key === 'Tab') {                                   // el foco no sale del diálogo
        const f = [...ov.querySelectorAll('input, button:not([disabled])')];
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (!ov.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    ov.addEventListener('mousedown', e => { if (e.target === ov) finish(false); });
    (field || (danger ? no : yes)).focus();                          // lo destructivo empieza con «Cancelar» enfocado
    if (field && input) field.select();
  });
}
/** ¿Seguro? → true / false. */
const askConfirm = (message, opts = {}) => askDialog({ title: '¿Continuar?', message, confirmLabel: 'Continuar', ...opts });
/** Pide un texto → string (sin espacios sobrantes) o null si se cancela. */
const askText = (title, opts = {}) => askDialog({ title, confirmLabel: 'Guardar', input: { label: title, ...opts }, message: opts.message || '' });

/** Cierra la ventana; si hay algo escrito sin guardar pregunta antes (clic fuera, ✕ o Esc). */
async function requestCloseModal() {
  if (App._modalDirty && !(await askConfirm('Lo que escribiste en este formulario se perderá.',
        { title: '¿Descartar los cambios?', confirmLabel: 'Descartar', cancelLabel: 'Seguir editando', danger: true }))) return;
  closeModal();
}

/** Tras un «… es requerido»: marca el primer campo obligatorio vacío de la ventana abierta y le da el foco. */
function flagMissingRequired() {
  if (!modalOverlay.classList.contains('visible')) return;
  const fields = [...modalContent.querySelectorAll('.form-group')]
    .filter(g => /\*/.test(g.querySelector('.form-label')?.textContent || ''))
    .map(g => g.querySelector('input:not([type=hidden]), textarea, select')).filter(Boolean);
  const missing = fields.filter(f => !String(f.value || '').trim());
  const targets = missing.length ? missing : [modalContent.querySelector('input.form-input:not([type=hidden]):not([type=date])')].filter(f => f && !String(f.value || '').trim());
  targets.forEach(f => { f.classList.add('is-invalid'); f.setAttribute('aria-invalid', 'true'); });
  targets[0]?.focus();
}
document.addEventListener('input', e => { if (e.target?.classList?.contains('is-invalid')) { e.target.classList.remove('is-invalid'); e.target.removeAttribute('aria-invalid'); } });

// ==============================================================
//  MODAL SYSTEM
// ==============================================================
let _modalReturnFocus = null;
function showModal(title, bodyHTML) {
  if (!modalOverlay.classList.contains('visible')) _modalReturnFocus = document.activeElement;
  modalTitle.textContent = title;
  modalContent.innerHTML = bodyHTML;
  App._modalDirty = false;
  autoLabelControls(modalContent);
  modalOverlay.classList.add('visible');
}
function closeModal() {
  const wasOpen = modalOverlay.classList.contains('visible');
  modalOverlay.classList.remove('visible');
  modalContent.innerHTML = '';
  App._modalDirty = false;
  // Devuelve el foco al elemento que abrió el modal (accesibilidad por teclado).
  if (wasOpen && _modalReturnFocus && _modalReturnFocus.isConnected && _modalReturnFocus !== document.body) _modalReturnFocus.focus?.();
  _modalReturnFocus = null;
}

/**
 * Elimina un registro y muestra un aviso con «Deshacer» (reinserta el registro con su mismo id).
 * `message` es el texto del aviso (p. ej. 'Idea eliminada').
 */
async function deleteWithUndo(tableName, id, undoLabel, message) {
  if (tableName === 'ideas') {                                   // una idea arrastra sus tareas
    const restore = await dbWrite(() => deleteIdeaCascade(id));
    UndoStack.push({ label: undoLabel, undo: async () => { await dbWrite(() => restore()); } });
    showToastWithUndo(message, 'info');
    return;
  }
  const rec = await db[tableName].get(id);
  if (!rec) return;
  await dbWrite(() => db[tableName].delete(id));
  UndoStack.push({ label: undoLabel, undo: async () => { await dbWrite(() => db[tableName].put(rec)); } });
  showToastWithUndo(message, 'info');
}

// ==============================================================
//  DESCARGAS Y BACKUPS
// ==============================================================
/** Descarga un texto como archivo (el <a> se añade al DOM: Firefox ignora clics sobre anclas sueltas). */
function downloadFile(filename, content, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const BackupMeta = {
  BACKUP_DAYS: 14,
  mark()  { try { localStorage.setItem('ros-last-export', String(Date.now())); } catch {} window.updateBackupLine?.(); },
  last()  { try { return +localStorage.getItem('ros-last-export') || null; } catch { return null; } },
  daysSince() { const t = this.last(); return t ? Math.floor((Date.now() - t) / 86400000) : null; },
};

/** La red de seguridad a la vista: en el pie del menú, cuándo fue la última copia (exportada o automática) y un aviso si falta o es vieja. */
async function updateBackupLine() {
  const el = $('backupLine');
  if (!el) return;
  const hasData = (await db.projects.count()) + (await db.ideas.count()) + (await db.tasks.count()) > 0;
  const auto = typeof AutoBackup !== 'undefined' && AutoBackup.enabled() ? AutoBackup.lastRun() : null, manual = BackupMeta.last();
  const last = Math.max(auto || 0, manual || 0) || null;
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  el.hidden = !hasData && !last;
  el.classList.toggle('is-warn', !last || days >= BackupMeta.BACKUP_DAYS);
  el.textContent = !last ? '⚠ Sin copia de seguridad' : days === 0 ? `✓ Copia de hoy${auto && auto >= (manual || 0) ? ' · automática' : ''}` : `Última copia: hace ${days} d`;
  el.title = !last ? 'Tus datos viven solo en este navegador. Elige una carpeta de copia automática o exporta un backup.' : 'Abrir copias de seguridad en Ajustes';
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('click', () => { try { localStorage.setItem('ros-settings-tab', 'data'); } catch {} navigate('settings'); });
  }
}
window.updateBackupLine = updateBackupLine;

/** Descarga un backup completo y lo anota como "último backup". */
/** Lee un backup (JSON o cifrado) y ofrece fusionarlo o reemplazar los datos actuales. */
async function startBackupImport(file) {
  try {
    const raw = await file.text();
    const text = await Vault.open(raw);                // archivo cifrado: pide la contraseña (null = cancelado)
    if (text === null) return;
    const data = sanitizeBackup(JSON.parse(text));     // valida el formato antes de mostrar nada
    const counts = { projects: data.projects.length, ideas: data.ideas.length, snippets: data.snippets.length };

    showModal('📥 Importar datos', `
      <div class="modal-body">
        <p style="color:var(--text-2);font-size:.85rem;margin-bottom:14px">
          El archivo contiene <strong style="color:var(--text-1)">${counts.projects}</strong> proyectos,
          <strong style="color:var(--text-1)">${counts.ideas}</strong> ideas y
          <strong style="color:var(--text-1)">${counts.snippets}</strong> snippets.
        </p>
        <p style="font-size:.82rem;color:var(--text-2);margin-bottom:16px">¿Cómo deseas importarlos?</p>
        <div style="display:flex;flex-direction:column;gap:10px">
          <label class="import-option-card" id="importOptMerge" style="cursor:pointer">
            <input type="radio" name="importMode" value="merge" checked style="margin-right:8px">
            <div>
              <strong style="color:var(--text-1)">⊕ Merge (recomendado)</strong>
              <p style="font-size:.75rem;color:var(--text-3);margin:2px 0 0">
                Añade sólo los registros nuevos y reconecta sus referencias. No borra ni modifica los datos existentes.
              </p>
            </div>
          </label>
          <label class="import-option-card" id="importOptReplace" style="cursor:pointer">
            <input type="radio" name="importMode" value="replace" style="margin-right:8px">
            <div>
              <strong style="color:var(--red)">⚠ Reemplazar todo</strong>
              <p style="font-size:.75rem;color:var(--text-3);margin:2px 0 0">
                Borra todos los datos actuales y los sustituye. Antes se descarga una copia automática de tus datos actuales.
              </p>
            </div>
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="importModeCancel">Cancelar</button>
        <button class="btn btn-primary" id="importModeOk">Importar</button>
      </div>`);

    $('importModeCancel').addEventListener('click', closeModal);
    $('importModeOk').addEventListener('click', async () => {
      const mode = document.querySelector('input[name="importMode"]:checked')?.value;
      try {
        let msg;
        if (mode === 'replace') {
          if (!(await askConfirm('Se eliminarán todos tus datos actuales y se cargará el archivo. Antes se descargará una copia.', { title: '¿Reemplazar todos los datos?', confirmLabel: 'Reemplazar', danger: true }))) return;
          await downloadBackup('researchos-antes-de-reemplazar');
          const n = await importAllData(text);
          msg = `Datos reemplazados: ${n.projects} proyectos, ${n.ideas} ideas, ${n.snippets} snippets`;
        } else {
          msg = 'Importado (merge): ' + describeMerge(await mergeAllData(text));
        }
        await _afterDataReplaced();
        closeModal();
        showToast(msg + ' ✓', 'success');
        navigate('dashboard');
      } catch (err) {
        showToast('No se pudo importar: ' + err.message, 'error');
        console.error(err);
      }
    });
  } catch (err) {
    showToast('Error al leer el archivo: ' + err.message, 'error');
  }
}

async function downloadBackup(prefix = 'researchos-backup') {
  downloadFile(`${prefix}-${localDateISO()}.json`, await exportAllData());
  BackupMeta.mark();
}

/** Tras reemplazar/fusionar datos en bloque: reconstruye lo que vive en memoria. */
async function _afterDataReplaced({ local = true } = {}) {
  _applySubStages(await _getSubStages());
  UndoStack.clear();
  await _buildSearchIndex().catch(() => {});
  // Importar o cargar datos es un cambio local: se programa la copia automática y la subida a la carpeta compartida
  // (los hooks de la BD no lo hacen mientras importan). Lo que llega DESDE la carpeta (`local: false`) no se vuelve a subir.
  if (local) SyncState.touch();
  Live.settingsDirty = true; Live.touch();          // si quien llama no repinta la vista (ni el selector de área), el refresco central lo hace
}

// ==============================================================
//  TOAST NOTIFICATIONS
// ==============================================================
/** Monta un aviso: tope de 4 a la vez, botón de cierre y pausa al pasar el ratón; los errores se quedan más tiempo. */
function _mountToast(toast, ms) {
  const host = $('toastContainer');
  while (host.children.length >= 4) host.firstElementChild.remove();
  const close = document.createElement('button');
  close.className = 'toast-close'; close.setAttribute('aria-label', 'Cerrar aviso'); close.textContent = '✕';
  close.addEventListener('click', () => toast.remove());
  toast.appendChild(close);
  host.appendChild(toast);
  let timer = setTimeout(() => toast.remove(), ms);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => { timer = setTimeout(() => toast.remove(), 1800); });
  return () => clearTimeout(timer);
}

function showToast(message, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || '•'}</span> <span class="toast-msg">${esc(message)}</span>`;
  _mountToast(toast, type === 'error' ? 7000 : 3200);
  if (type === 'error' && /requerid/i.test(message)) flagMissingRequired();
}

// ==============================================================
//  BADGES & COUNTERS
// ==============================================================
async function updateBadges() {
  const [unread, allProjects] = await Promise.all([
    db.ideas.where('status').equals('unread').count(),
    db.projects.toArray(),
  ]);
  const archived  = allProjects.filter(p => !!p.archived).length;
  // La vista Favoritos lista proyectos, ideas y snippets: el badge cuenta lo mismo.
  const [starredIdeas, starredSnips] = await Promise.all([
    db.ideas.filter(i => !!i.starred).count(),
    db.snippets.filter(sn => !!sn.starred).count(),
  ]);
  const starred   = allProjects.filter(p => !!p.starred && !p.archived).length + starredIdeas + starredSnips;
  const subActive = allProjects.filter(p =>
    p.type === 'Paper' && !p.archived &&
    ['preparacion','enviado','en_revision','revision_solicitada'].includes(p.submissionStatus)
  ).length;
  const badge = $('ideasBadge');
  if (badge) { badge.textContent = unread; badge.classList.toggle('visible', unread > 0); }
  App._tabCounts = { ...App._tabCounts, subActive };                                          // contador de la pestaña «Submissions» de Proyectos
  document.querySelectorAll('.proj-tab[data-tab="submissions"]').forEach(b => {
    b.querySelector('.proj-tab-count')?.remove();
    if (subActive > 0) b.insertAdjacentHTML('beforeend', ` <span class="proj-tab-count" data-count="subActive">${subActive}</span>`);
  });
  const abadge = $('archivedBadge');
  if (abadge) { abadge.textContent = archived; abadge.classList.toggle('visible', archived > 0); }
  const sbadge = $('starredBadge');
  if (sbadge) { sbadge.textContent = starred; sbadge.classList.toggle('visible', starred > 0); }

  // Badge: reuniones con action items pendientes
  const mbadge = $('meetingsBadge');
  if (mbadge) {
    const allMeets = await db.meetings.toArray();
    const pendingActions = allMeets.reduce((acc, m) =>
      acc + (m.actionItems || []).filter(a => !a.done).length, 0);
    mbadge.textContent = pendingActions;
    mbadge.classList.toggle('visible', pendingActions > 0);
  }

  // Badge de «Hoy»: tareas y fechas límite que vencen hoy o ya vencieron (dentro del área activa)
  const todayBadge = $('todayBadge');
  if (todayBadge) {
    const iso = localDateISO();
    const byId = Object.fromEntries(allProjects.map(p => [p.id, p]));
    const nTasks = (await db.tasks.filter(t => !t.done && t.due && t.due <= iso).toArray())
      .filter(t => !t.projectId || (byId[t.projectId] && !byId[t.projectId].archived && inContext(byId[t.projectId]))).length;
    const nDue = allProjects.filter(p => !p.archived && p.deadline && p.deadline <= iso && !isFinished(p) && inContext(p)).length;
    todayBadge.textContent = nTasks + nDue;
    todayBadge.classList.toggle('visible', nTasks + nDue > 0);
  }
  if (typeof updateNavGroupDots === 'function') updateNavGroupDots();
  updateBackupLine().catch(() => {});

  await _renderResearchStatus();
}

// ==============================================================
//  UTILITIES
// ==============================================================
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Nombre de lenguaje apto para una clase CSS (`C++` → `C`). */
function _langClass(lang) {
  return String(lang || 'Other').replace(/[^A-Za-z0-9_-]/g, '') || 'Other';
}

/** Texto plano para vistas previas: sin # ni ** ni enlaces ni código, en una sola línea. */
function plainPreview(md, max = 180) {
  const t = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/^\s{0,3}(#{1,6}|[-*+>]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function typeBadgeClass(type) {
  const map = {
    Grant:'badge-grant', Paper:'badge-paper',
    Análisis:'badge-analisis', Dataset:'badge-dataset',
    Presentación:'badge-presentacion', Proyecto:'badge-proyecto', Curso:'badge-curso'
  };
  return map[type] || 'badge-type';
}

function prioBadgeClass(prio) {
  const map = { Alta:'badge-prio-alta', Media:'badge-prio-media', Baja:'badge-prio-baja' };
  return map[prio] || 'badge-type';
}

/**
 * Computes a 0–100 completeness score for a project.
 * Criteria: title(20) + description(15) + deadline(15) + responsible(10)
 *           + tags(10) + ideas(15) + snippets(15)
 */
function projectCompleteness(p) {
  let score = 0;
  if (p.title?.trim())       score += 20;
  if (p.description?.trim()) score += 20;
  if (p.deadline)            score += 20;
  if (p.responsible?.trim()) score += 20;
  if ((p.tags||[]).length)   score += 20;
  return Math.min(score, 100);
}

function completenessBarHTML(pct) {
  const color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)';
  return `
    <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
      <div style="flex:1;height:4px;background:var(--bg-elevated);border-radius:99px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:99px;transition:width 400ms var(--ease)"></div>
      </div>
      <span style="font-family:var(--font-mono);font-size:.65rem;color:${color}">${pct}%</span>
    </div>`;
}

// ==============================================================
//  ACCENT COLOR HELPER
// ==============================================================
function _applyAccent(accent) {
  if (accent === 'blue' || !accent) {
    document.documentElement.removeAttribute('data-accent');
  } else {
    document.documentElement.setAttribute('data-accent', accent);
  }
  document.querySelectorAll('.accent-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.accent === (accent || 'blue'));
  });
  localStorage.setItem('ros-accent', accent || 'blue');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00:00');             // acepta «YYYY-MM-DD» y también un sello de tiempo ISO
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('es-CL', { day:'2-digit', month:'short', year:'numeric' });
}

function relativeDate(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Ahora';
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d}d`;
  return formatDate(iso.split('T')[0]);
}

// ==============================================================
//  CSV IMPORT / EXPORT
// ==============================================================
const CSV_COLS = ['title','type','responsible','priority','deadline','description','tags','status','column','parent'];

function toCSVRow(vals, delim = ',') {
  return vals.map(v => {
    const s = String(v ?? '');
    return s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(delim);
}

async function exportProjectsCSV() {
  const [projects, cols] = await Promise.all([db.projects.toArray(), db.kanbanColumns.toArray()]);
  const colName  = Object.fromEntries(cols.map(c => [c.id, c.title]));
  const projName = Object.fromEntries(projects.map(p => [p.id, p.title]));
  const header   = toCSVRow(CSV_COLS);
  const rows     = projects.map(p => toCSVRow(CSV_COLS.map(k =>
    k === 'tags'   ? (p.tags || []).join('|')
  : k === 'column' ? (colName[p.columnId] || '')
  : k === 'parent' ? (projName[p.parentId] || '')
  : p[k])));
  const csv = [header, ...rows].join('\n');
  downloadFile(`researchos-projects-${localDateISO()}.csv`, '﻿' + csv, 'text/csv;charset=utf-8;');
  showToast(`${projects.length} proyectos exportados ✓`, 'success');
}

/**
 * Parser CSV (RFC 4180): campos entre comillas con comas, saltos de línea y comillas dobladas.
 * Detecta `;` como separador (Excel en configuración regional española) y descarta el BOM.
 */
function parseCSV(text) {
  text = String(text ?? '').replace(/^﻿/, '');
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';

  const records = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = ''; records.push(row); row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); records.push(row); }

  const filled = records.filter(r => r.some(c => c.trim() !== ''));
  if (filled.length < 2) return { headers: [], rows: [] };
  const headers = filled[0].map(h => h.trim().toLowerCase());
  const rows    = filled.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { headers, rows };
}

/** Acepta 2026-12-31 y 31/12/2026 (día primero, como en es-CL); cualquier otra cosa → null. */
function _csvDate(v) {
  const t = String(v || '').trim();
  if (isoDateOrNull(t)) return t;
  const m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

async function previewImportCSV(file) {
  if (!file) return;
  const text    = await file.text();
  const { headers, rows } = parseCSV(text);
  const preview = $('csvPreviewArea');
  if (!preview) return;

  if (!headers.includes('title')) {
    preview.innerHTML = `<div class="fs-unsupported" style="margin-top:10px">⚠ El CSV no tiene columna "title". Verifica el formato.</div>`;
    return;
  }

  const VALID_TYPES    = ['Proyecto','Grant','Paper','Análisis','Dataset','Presentación','Curso'];
  const VALID_PRIORITY = ['Alta','Media','Baja'];
  const fold = foldText;
  const [cols, existing] = await Promise.all([db.kanbanColumns.orderBy('order').toArray(), db.projects.toArray()]);
  const colByName = Object.fromEntries(cols.map(c => [fold(c.title), c.id]));
  const seen = new Set(existing.map(p => `${fold(p.title)}|${p.type}|${p.deadline || ''}`));

  let duplicates = 0;
  const toImport = [];
  for (const r of rows.filter(r => r.title?.trim())) {
    const type = VALID_TYPES.find(t => fold(t) === fold(r.type)) || 'Proyecto';
    const rec = {
      title:       r.title.trim(),
      type,
      responsible: r.responsible?.trim() || '',
      priority:    VALID_PRIORITY.find(t => fold(t) === fold(r.priority)) || 'Media',
      deadline:    _csvDate(r.deadline),
      description: r.description?.trim() || '',
      tags:        r.tags ? r.tags.split('|').map(t => t.trim()).filter(Boolean) : [],
      status:      r.status?.trim() || 'active',
      archived:    false, starred: false, coauthors: [],
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
      _columnName: r.column || '', _parentName: r.parent || '',
    };
    const key = `${fold(rec.title)}|${rec.type}|${rec.deadline || ''}`;
    if (seen.has(key)) { duplicates++; continue; }     // reimportar el mismo CSV no duplica proyectos
    seen.add(key);
    toImport.push(rec);
  }

  if (!toImport.length) {
    preview.innerHTML = `<div class="fs-unsupported" style="margin-top:10px">⚠ ${duplicates ? `Las ${duplicates} fila(s) ya existen como proyectos.` : 'No se encontraron filas válidas.'}</div>`;
    return;
  }

  preview.innerHTML = `
    <div style="margin-top:12px;background:var(--bg-elevated);border:1px solid var(--border);
                border-radius:var(--radius-md);overflow:hidden">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;
                  align-items:center;justify-content:space-between">
        <span style="font-size:.82rem;color:var(--text-1)">
          Vista previa: <strong>${toImport.length}</strong> proyectos a importar${duplicates ? ` · ${duplicates} duplicado(s) omitido(s)` : ''}
        </span>
        <button class="btn btn-primary btn-sm" id="confirmCsvImport">Importar ${toImport.length} proyectos</button>
      </div>
      <div style="max-height:200px;overflow-y:auto">
        <table style="width:100%;border-collapse:collapse;font-size:.75rem">
          <thead>
            <tr style="background:var(--bg-card)">
              ${['Título','Tipo','Prioridad','Deadline','Responsable'].map(h =>
                `<th style="padding:6px 12px;text-align:left;color:var(--text-2);
                            font-family:var(--font-mono);font-size:.65rem;
                            border-bottom:1px solid var(--border)">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${toImport.slice(0, 20).map((r, i) => `
              <tr style="${i % 2 === 0 ? '' : 'background:var(--bg-surface)'}">
                <td style="padding:5px 12px;color:var(--text-1);max-width:180px;
                           overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.title)}</td>
                <td style="padding:5px 12px"><span class="badge ${typeBadgeClass(r.type)}">${esc(r.type)}</span></td>
                <td style="padding:5px 12px"><span class="badge ${prioBadgeClass(r.priority)}">${esc(r.priority)}</span></td>
                <td style="padding:5px 12px;color:var(--text-2);font-family:var(--font-mono);font-size:.67rem">${r.deadline || '—'}</td>
                <td style="padding:5px 12px;color:var(--text-2)">${esc(r.responsible || '—')}</td>
              </tr>`).join('')}
            ${toImport.length > 20 ? `
              <tr><td colspan="5" style="padding:6px 12px;color:var(--text-3);font-size:.72rem">
                … y ${toImport.length - 20} más
              </td></tr>` : ''}
          </tbody>
        </table>
      </div>
    </div>`;

  $('confirmCsvImport').addEventListener('click', async () => {
    // Columna: la del CSV si existe en el tablero; si no, la primera.
    const defaultColId = cols[0]?.id ?? 1;
    const now = new Date().toISOString();
    const records = toImport.map(({ _columnName, _parentName, ...p }) => {
      const columnId = colByName[fold(_columnName)] ?? defaultColId;
      return { ...p, columnId, columnHistory: [{ colId: columnId, enteredAt: now, exitedAt: null }] };
    });
    await dbWrite(async () => {
      const ids = await db.projects.bulkAdd(records, { allKeys: true });
      // Subproyectos: se enlazan por título del padre (entre los importados o los ya existentes).
      const byTitle = new Map(existing.map(p => [fold(p.title), p.id]));
      toImport.forEach((r, i) => byTitle.set(fold(r.title), ids[i]));
      for (let i = 0; i < toImport.length; i++) {
        const parentId = byTitle.get(fold(toImport[i]._parentName));
        if (toImport[i]._parentName && parentId && parentId !== ids[i]) await db.projects.update(ids[i], { parentId });
      }
    });
    preview.innerHTML = '';
    showToast(`${records.length} proyectos importados ✓`, 'success');
    renderView(App.view);
  });
}

// ==============================================================
//  EXPORT DE PROYECTO COMO DOCUMENTO MARKDOWN
// ==============================================================
async function exportProjectAsMarkdown(projectId) {
  const [p, cols, ideas, snippets] = await Promise.all([
    db.projects.get(projectId),
    db.kanbanColumns.toArray(),
    db.ideas.where('projectId').equals(projectId).toArray(),
    db.snippets.where('projectId').equals(projectId).toArray(),
  ]);
  if (!p) return;

  const [refs, meets] = await Promise.all([
    db.references.where('projectId').equals(projectId).toArray(),
    db.meetings.where('projectId').equals(projectId).toArray(),
  ]);
  const col   = cols.find(c => c.id === p.columnId);

  const hr  = '\n\n---\n\n';
  const now = new Date().toLocaleDateString('es-CL', { year:'numeric', month:'long', day:'numeric' });

  let md = `# ${p.title}\n\n`;
  md += `> Exportado el ${now} desde ResearchOS\n\n`;
  md += `| Campo | Valor |\n|---|---|\n`;
  md += `| **Tipo** | ${p.type||'—'} |\n`;
  md += `| **Estado** | ${col?.title||'—'} |\n`;
  md += `| **Prioridad** | ${p.priority||'—'} |\n`;
  md += `| **Responsable** | ${p.responsible||'—'} |\n`;
  md += `| **Deadline** | ${p.deadline ? formatDate(p.deadline) : '—'} |\n`;
  if ((p.coauthors||[]).length)
    md += `| **Coautores** | ${p.coauthors.join(', ')} |\n`;
  if ((p.tags||[]).length)
    md += `| **Etiquetas** | ${p.tags.join(', ')} |\n`;
  md += '\n';

  if (p.description) {
    md += `## Descripción\n\n${p.description}\n`;
  }

  if (ideas.length) {
    md += `${hr}## Ideas (${ideas.length})\n\n`;
    ideas.forEach(i => {
      md += `### ${i.status === 'reviewed' ? '✓' : '○'} ${i.title}\n`;
      if (i.content) md += `\n${i.content}\n`;
      if ((i.tags||[]).length) md += `\n_Tags: ${i.tags.join(', ')}_\n`;
      md += '\n';
    });
  }

  if (p.type === 'Paper' && p.submissionStatus) {
    const subStatus = SUB_STATUSES.find(s => s.key === p.submissionStatus);
    md += `${hr}## Submission\n\n`;
    md += `| Campo | Valor |\n|---|---|\n`;
    md += `| **Estado** | ${subStatus?.label || p.submissionStatus} |\n`;
    if (p.targetVenue)      md += `| **Venue** | ${p.targetVenue} |\n`;
    if (p.deadline)         md += `| **Deadline** | ${formatDate(p.deadline)} |\n`;
    if (p.submittedAt)      md += `| **Enviado** | ${formatDate(p.submittedAt)} |\n`;
    if (p.submissionNotes)  md += `\n${p.submissionNotes}\n`;
    if ((p.submissionRounds || []).length) {
      md += `\n**Rondas:**\n`;
      p.submissionRounds.forEach(r => { md += `- ${r.submittedAt || '?'}: ${r.decision || '?'} — ${r.notes || ''}\n`; });
    }
    md += '\n';
  }

  if (meets.length) {
    md += `${hr}## Reuniones (${meets.length})\n\n`;
    meets.forEach(m => {
      md += `### ${formatDate(m.date)} — ${m.title}\n`;
      if (m.participants) md += `_Participantes: ${m.participants}_\n\n`;
      if (m.agreements)   md += `${m.agreements}\n\n`;
      if ((m.actionItems||[]).length) {
        md += `**Próximos pasos:**\n`;
        m.actionItems.forEach(a => { md += `- [${a.done?'x':' '}] ${a.text}\n`; });
        md += '\n';
      }
    });
  }

  if (refs.length) {
    md += `${hr}## Referencias (${refs.length})\n\n`;
    refs.forEach(r => {
      md += `- ${r.authors||'?'} (${r.year||'?'}). _${r.title}_.`;
      if (r.journal) md += ` ${r.journal}.`;
      if (r.doi) md += ` https://doi.org/${r.doi}`;
      md += '\n';
      if (r.notes) md += `  > ${r.notes}\n`;
    });
  }

  if (snippets.length) {
    md += `${hr}## Snippets de código (${snippets.length})\n\n`;
    snippets.forEach(s => {
      md += `### ${s.title}\n`;
      if (s.description) md += `_${s.description}_\n\n`;
      md += `\`\`\`${(s.language||'').toLowerCase()}\n${s.code||''}\n\`\`\`\n\n`;
    });
  }

  const blob = new Blob([md], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `${p.title.replace(/[^a-z0-9]/gi,'_').toLowerCase()}_${localDateISO()}.md`
  });
  a.click();
  URL.revokeObjectURL(url);
  showToast('Documento exportado ✓', 'success');
}

// ==============================================================
//  WELCOME MODAL — se muestra sólo la primera vez
// ==============================================================
function _showWelcomeModal() {
  const sections = [
    { icon:'◈', title:'Hoy',              desc:'Tu punto de partida: tareas y fechas de hoy y de la semana, captura rápida (tecla C) y lo que espera respuesta. Las métricas están plegadas en «Panorama».' },
    { icon:'⊡', title:'Áreas',            desc:'Define tus frentes (Investigación, Docencia, Gestión…) y elige uno en el menú para ver solo ese contexto en Hoy, Tablero y Proyectos.' },
    { icon:'⊞', title:'Kanban Board',     desc:'Gestiona el estado de tus proyectos arrastrando tarjetas entre columnas personalizables. Soporta límites WIP.' },
    { icon:'◉', title:'Proyectos',        desc:'Listado filtrable por tipo, prioridad y columna. Guarda filtros como vistas con nombre para acceso rápido.' },
    { icon:'⬡', title:'Project Hub',      desc:'Abre el Hub desde cualquier proyecto para ver en una sola página: ideas, submissions, reuniones, referencias y snippets vinculados.' },
    { icon:'🎯', title:'Hoy',       desc:'Calculado automáticamente: qué hacer ahora según deadlines, acciones pendientes e ideas sin revisar.' },
    { icon:'📤', title:'Submissions',      desc:'Seguimiento de papers, grants y ponencias a través de su ciclo: preparación → enviado → revisión → aceptado/rechazado.' },
    { icon:'🗓', title:'Reuniones',        desc:'Registra reuniones con acuerdos y próximos pasos. Las acciones pendientes aparecen en el Hoy.' },
    { icon:'📚', title:'Referencias',      desc:'Gestiona fuentes bibliográficas vinculadas a proyectos. Exporta a .bib con un clic.' },
    { icon:'◎', title:'Ideas Inbox',       desc:'Captura rápida de ideas. Usa la Revisión rápida (teclado) para procesar el inbox sin fricción.' },
    { icon:'⟨/⟩', title:'Snippets',       desc:'Biblioteca de código por lenguaje y colección, vinculada a proyectos. Resaltado de sintaxis incluido.' },
    { icon:'📅', title:'Agenda Semanal',   desc:'Vista de solo lectura que agrega todos los deadlines, submissions y reuniones de los próximos 7 días.' },
    { icon:'⏱', title:'Timeline',         desc:'Vista Gantt con zoom semana / mes / año. Filtra proyectos vencidos y colorea por prioridad o tipo.' },
    { icon:'🔗', title:'Huérfanos',        desc:'Detecta ideas, snippets, referencias y reuniones sin proyecto asignado para mantener todo conectado.' },
    { icon:'✺', title:'Red',              desc:'Grafo estilo Obsidian con todo lo que has guardado y cómo se conecta; filtra por tipo, busca y abre el grafo local de cualquier elemento.' },
    { icon:'☀', title:'Mi día',           desc:'Elige qué harás hoy según el tiempo disponible y los tiempos estimados (~2h al capturar). Lo pendiente pasa solo al día siguiente.' },
    { icon:'📈', title:'Informe de avance', desc:'Lo que lograste en una semana, un mes o el año, en Markdown, para tu memoria anual, tu CV o tu jefatura.' },
  ];
  showModal('Bienvenido/a a ResearchOS', `
    <div class="modal-body welcome-body">
      <p class="welcome-intro">
        Una herramienta para quienes llevan investigación, docencia y gestión a la vez. <strong>Local-first</strong>: tus datos
        viven solo en este navegador, sin cuenta, sin servidor y sin telemetría.
      </p>
      <div class="welcome-section-title">¿Cómo quieres empezar?</div>
      <div class="welcome-choices">
        <button class="welcome-choice is-primary" id="welcomeTour">
          <span class="wc-ico" aria-hidden="true">▶</span>
          <span class="wc-text"><strong>Recorrido guiado</strong><small>3 minutos: lo esencial, haciendo cosas tú mismo/a</small></span>
        </button>
        <button class="welcome-choice" id="welcomeLoadDemo" title="Un laboratorio de ecología con fechas calculadas a partir de hoy">
          <span class="wc-ico" aria-hidden="true">🧪</span>
          <span class="wc-text"><strong>Explorar con datos de ejemplo</strong><small>Un laboratorio con fechas de hoy; se quita con un clic</small></span>
        </button>
        <button class="welcome-choice" id="welcomeStart">
          <span class="wc-ico" aria-hidden="true">✎</span>
          <span class="wc-text"><strong>Empezar con mi app vacía</strong><small>Te dejo una lista de primeros pasos en Hoy</small></span>
        </button>
      </div>

      <details class="welcome-more">
        <summary>¿Qué incluye ResearchOS?</summary>
        <div class="welcome-grid">
          ${sections.map(s => `
            <div class="welcome-card">
              <div class="welcome-card-header">
                <span class="welcome-card-icon">${s.icon}</span>
                <span class="welcome-card-title">${s.title}</span>
              </div>
              <div class="welcome-card-desc">${s.desc}</div>
            </div>`).join('')}
        </div>
        <div class="welcome-section-title" style="margin-top:20px">Atajos de teclado</div>
        <div class="welcome-shortcuts">
          <div class="ws-row"><kbd>${MOD_KEY}K</kbd><span>Buscar y ejecutar acciones (paleta de comandos)</span></div>
          <div class="ws-row"><kbd>?</kbd><span>Ver todos los atajos</span></div>
          <div class="ws-row"><kbd>C</kbd><span>Capturar al vuelo: tarea, idea, proyecto o reunión</span></div>
          <div class="ws-row"><kbd>/</kbd><span>Filtrar la lista que estás viendo</span></div>
          <div class="ws-row"><kbd>${MOD_KEY}Z</kbd><span>Deshacer lo último (borrar, archivar, mover…)</span></div>
          <div class="ws-row"><kbd>[[</kbd><span>Escribe <code>[[</code> en cualquier nota para enlazar con otro elemento</span></div>
          <div class="ws-row"><kbd>Esc</kbd><span>Cerrar ventana / inspector / paleta</span></div>
        </div>
      </details>
    </div>
    <div class="modal-footer" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <span class="form-hint">Elijas lo que elijas, esta bienvenida no vuelve a salir. Todo está siempre en <strong>Tutorial</strong> y en la paleta (${MOD_KEY} K).</span>
    </div>`);

  const remember = () => { try { localStorage.setItem('ros-welcomed', '1'); } catch {} };   // al elegir un camino no se vuelve a mostrar
  $('welcomeStart').addEventListener('click', () => { remember(); closeModal(); });
  $('welcomeTour').addEventListener('click', () => { remember(); closeModal(); Tour.start({ restart: true }); });
  $('welcomeLoadDemo').addEventListener('click', async () => {
    const btn = $('welcomeLoadDemo');
    btn.disabled = true;
    btn.querySelector('strong').textContent = '⏳ Cargando…';
    try {
      remember();
      await loadSampleData();
      closeModal();
      showToast('Datos de ejemplo cargados ✓ — con fechas de hoy', 'success');
      navigate('dashboard');
    } catch (err) {
      btn.disabled = false;
      btn.querySelector('strong').textContent = 'Explorar con datos de ejemplo';
      showToast('No se pudieron cargar los datos de ejemplo: ' + err.message, 'error');
    }
  });
}

// ==============================================================
//  GOOGLE DRIVE SYNC
// ==============================================================
const GoogleSync = (() => {
  const CLIENT_ID  = '257501914353-5m71aadp4u4qr8qfq9g6d2nc6upm5hod.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid email';
  const DEFAULT_FILE_NAME = 'researchos-backup.json';
  const getFileName = async () => {
    const stored = await loadSetting('google_drive_file_name');
    return stored || DEFAULT_FILE_NAME;
  };

  let tokenClient  = null;
  let accessToken  = null;

  // INSERTAR después de: let accessToken = null;

  let _userEmail = null;

  // -- Obtener perfil del usuario via Gmail API --------------
  async function getUserProfile() {
    if (_userEmail) return _userEmail;
    const saved = await loadSetting('google_user_email');
    if (saved) { _userEmail = saved; return _userEmail; }
    return null;
  }

  // -- Helpers: reutilizan la tabla `settings` de Dexie ------
  const saveSetting = (k, v) => db.settings.put({ key: k, value: v });
  const loadSetting = async k => { const r = await db.settings.get(k); return r?.value ?? null; };

  // -- Estado visual del indicador en sidebar ----------------
  function setStatus(state) {
    const dot  = document.getElementById('syncDot');
    const text = document.getElementById('saveIndicatorText');
    const MAP  = {
      idle:        ['',        'Solo local'    ],
      syncing:     ['syncing', 'Sincronizando…'],
      ok:          ['ok',      'Drive ✓'       ],
      error:       ['error',   'Sync Error'    ],
      disconnected:['',        'Solo local'    ],
    };
    const [cls, label] = MAP[state] ?? MAP.idle;
    if (dot)  dot.className  = 'status-dot' + (cls ? ' sync-' + cls : '');
    if (text) text.textContent = label;
  }

  // -- Inicializar: restaurar token guardado -----------------
  async function init() {
    const token  = await loadSetting('google_access_token');
    const expiry = await loadSetting('google_token_expiry');

    // Restaurar email cacheado independientemente del estado del token
    const savedEmail = await loadSetting('google_user_email');
    if (savedEmail) _userEmail = savedEmail;

    if (token && expiry && Date.now() < Number(expiry)) {
      accessToken = token;
      setStatus('ok');
      const autoSync = await loadSetting('google_auto_sync');
      if (autoSync === 'true') await push({ silent: true });
    }

    if (token || savedEmail) ensureClient().catch(() => {});        // sesión previa: prepara el cliente de Google en segundo plano
  }

  /** Carga Google Identity Services solo cuando hace falta: no se contacta a Google en cada arranque. */
  async function ensureClient() {
    if (tokenClient) return tokenClient;
    await loadLib('gsi').catch(() => {});
    if (typeof google === 'undefined') return null;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: async resp => {
        if (resp.error) {
          setStatus('error');
          showToast('Error de autenticación con Google', 'error');
          return;
        }
        accessToken = resp.access_token;
        _userEmail  = null;
        await saveSetting('google_access_token', accessToken);
        await saveSetting('google_token_expiry',
          String(Date.now() + (resp.expires_in - 60) * 1000));

        // tokeninfo devuelve email + scope en una sola llamada segura
        try {
          const r    = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
          const info = await r.json();
          if (info?.email) {
            _userEmail = info.email;
            await saveSetting('google_user_email', _userEmail);
          }
        } catch { /* no crítico */ }

        setStatus('ok');
        showToast('Cuenta de Google conectada ✓', 'success');
        renderGoogleSyncSection();
      }
    });
    return tokenClient;
  }

  async function signIn() {
    const client = await ensureClient();
    if (!client) { showToast('Google Identity Services no disponible', 'error'); return; }
    client.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  }

  async function signOut() {
    if (accessToken && typeof google !== 'undefined') google.accounts.oauth2.revoke(accessToken);
    accessToken = null;
    _userEmail  = null;
    await Promise.all([
      saveSetting('google_access_token', null),
      saveSetting('google_token_expiry',  null),
      saveSetting('google_drive_file_id', null),
      saveSetting('google_user_email',    null),
    ]);
    setStatus('disconnected');
    showToast('Sesión de Google cerrada', 'success');
    renderGoogleSyncSection();
  }

  // -- Drive API: wrapper con manejo de token expirado -------
  async function driveRequest(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
    });
    if (res.status === 401) {
      accessToken = null;
      setStatus('disconnected');
      throw new Error('Token expirado — reconecta tu cuenta Google');
    }
    return res;
  }

  async function resolveFileId() {
    let fileId = await loadSetting('google_drive_file_id');
    if (fileId) return fileId;
    const fileName = await getFileName();
    const res  = await driveRequest(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name=%27${fileName}%27&fields=files(id)`
    );
    const data = await res.json();
    fileId = data.files?.[0]?.id ?? null;
    if (fileId) await saveSetting('google_drive_file_id', fileId);
    return fileId;
  }

  // -- Push: sube datos locales → Drive (reutiliza exportAllData) --
  async function push({ silent = false } = {}) {
    if (!accessToken) { showToast('Conecta tu cuenta Google primero', 'error'); return; }
    setStatus('syncing');
    try {
      const payload = await exportAllData();           // ← función existente en db.js
      const blob    = new Blob([payload], { type: 'application/json' });
      let   fileId  = await resolveFileId();

      if (fileId) {
        await driveRequest(
          `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: blob }
        );
      } else {
        const fileName = await getFileName();
        const meta = JSON.stringify({ name: fileName, parents: ['appDataFolder'] });
        const form = new FormData();
        form.append('metadata', new Blob([meta], { type: 'application/json' }));
        form.append('file', blob);
        const res  = await driveRequest(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
          { method: 'POST', body: form }
        );
        const newFile = await res.json();
        await saveSetting('google_drive_file_id', newFile.id);
      }

      await saveSetting('google_sync_last', new Date().toISOString());
      setStatus('ok');
      if (!silent) showToast('Datos subidos a Google Drive ✓', 'success');
    } catch (err) {
      setStatus('error');
      if (!silent) showToast('Error al subir: ' + err.message, 'error');
    }
  }

  // -- Pull: descarga Drive → local (reutiliza importAllData / mergeAllData) --
  async function pull({ mode = 'merge' } = {}) {
    if (!accessToken) { showToast('Conecta tu cuenta Google primero', 'error'); return; }
    setStatus('syncing');
    try {
      const fileId = await resolveFileId();
      if (!fileId) { setStatus('ok'); showToast('No hay backup en Drive todavía', 'error'); return; }

      const res  = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      const text = await res.text();

      if (mode === 'replace') {
        await importAllData(text);
      } else {
        await mergeAllData(text);
      }
      await _afterDataReplaced();

      await saveSetting('google_sync_last', new Date().toISOString());
      setStatus('ok');
      showToast(`Datos descargados de Drive (${mode}) ✓`, 'success');
      navigate('dashboard');
    } catch (err) {
      setStatus('error');
      showToast('Error al descargar: ' + err.message, 'error');
    }
  }

  // -- Auto-save tras cambios: dispara push 60 s después del último dbWrite --
  let _autoSaveTimer = null;

  async function scheduleAutoSave() {
    if (!accessToken) return;
    const enabled = await loadSetting('google_auto_save_on_change');
    if (enabled !== 'true') return;
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => push({ silent: true }), 60000);
  }

  return {
    init,
    signIn,
    signOut,
    push,
    pull,
    scheduleAutoSave,
    getUserProfile,
    isConnected: () => !!accessToken,
    getLastSync: ()  => loadSetting('google_sync_last'),
  };
})();

// ==============================================================
//  PROJECT CHIP PICKER — selector multi-proyecto con chips
// ==============================================================
function _attachProjectPicker(containerId, projects, initialIds = []) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let selected = [...initialIds];

  const renderChips = () => {
    const chipsEl = container.querySelector('.proj-chip-selected');
    if (!chipsEl) return;
    chipsEl.innerHTML = selected.map(id => {
      const p = projects.find(p => p.id === id);
      if (!p) return '';
      return `<span class="proj-chip" title="${esc(p.title)}">
        ${esc(p.title.length > 24 ? p.title.slice(0,22)+'…' : p.title)}
        <button class="proj-chip-remove" data-remove="${id}" tabindex="-1">×</button>
      </span>`;
    }).join('');
    container.dataset.selectedIds = JSON.stringify(selected);
    chipsEl.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        selected = selected.filter(id => id !== +btn.dataset.remove);
        renderChips();
      });
    });
  };

  const input    = container.querySelector('.proj-chip-input');
  const dropdown = container.querySelector('.proj-chip-dropdown');
  if (!input || !dropdown) return;

  const showDropdown = (q = '') => {
    const lq = q.toLowerCase();
    const matches = projects
      .filter(p => p.title.toLowerCase().includes(lq) && !selected.includes(p.id))
      .slice(0, 8);
    if (!matches.length) { dropdown.classList.remove('open'); return; }
    dropdown.innerHTML = matches.map(p => `
      <div class="proj-chip-option" data-pid="${p.id}">
        <span class="badge ${typeBadgeClass(p.type)}">${esc(p.type)}</span>
        ${esc(p.title)}
      </div>`).join('');
    dropdown.classList.add('open');
    dropdown.querySelectorAll('[data-pid]').forEach(opt => {
      opt.addEventListener('mousedown', e => {
        e.preventDefault();
        selected.push(+opt.dataset.pid);
        renderChips();
        input.value = '';
        dropdown.classList.remove('open');
        input.focus();
      });
    });
  };

  input.addEventListener('input',  () => showDropdown(input.value));
  input.addEventListener('focus',  () => showDropdown(input.value));
  input.addEventListener('blur',   () => setTimeout(() => dropdown.classList.remove('open'), 180));
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') dropdown.classList.remove('open');
    if (e.key === 'Backspace' && !input.value && selected.length) {
      selected.pop(); renderChips();
    }
  });

  renderChips();
}

function _getProjectPickerIds(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  try { return JSON.parse(container.dataset.selectedIds || '[]'); }
  catch { return []; }
}

/** HTML template reutilizable para el picker */
function _projectPickerHTML(id, placeholder = 'Buscar y añadir proyecto…') {
  return `<div class="proj-chip-picker" id="${id}" data-selected-ids="[]">
    <div class="proj-chip-selected"></div>
    <input class="form-input proj-chip-input" placeholder="${placeholder}" autocomplete="off">
    <div class="proj-chip-dropdown"></div>
  </div>`;
}

// ==============================================================
//  PERSON ID HELPERS
//  Leen los IDs de colaborador almacenados como data-attrs
//  en los inputs de persona tras selección desde autocomplete.
// ==============================================================

/** Devuelve el collaborator.id del responsable seleccionado, o null. */
function _getPersonId(inputEl) {
  const raw = inputEl?.dataset?.selectedCollabId;
  return raw ? +raw : null;
}

/**
 * Para inputs multi (coautores, participantes).
 * Devuelve [{name, id}] — id puede ser null si se escribió a mano.
 */
function _getPersonIds(inputEl) {
  const names = (inputEl?.value || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  let map = new Map();
  try {
    const stored = inputEl?.dataset?.collabIdMap;
    if (stored) map = new Map(JSON.parse(stored));
  } catch { /* map vacío */ }
  return names.map(name => ({ name, id: map.get(name) || null }));
}

/**
 * Normaliza nombre desde tabla de colaboradores si existe el ID.
 * Garantiza nombre canónico al guardar.
 */
async function _resolveCanonicalName(inputEl) {
  const id = _getPersonId(inputEl);
  const raw = inputEl?.value?.trim() || '';
  if (!id) return raw;
  const c = await db.collaborators.get(id);
  return c?.name || raw;
}

/** Idem para multi: devuelve [string] de nombres canonizados. */
async function _resolveCanonicalNames(inputEl) {
  const pairs = _getPersonIds(inputEl);
  return Promise.all(pairs.map(async ({ name, id }) => {
    if (!id) return name;
    const c = await db.collaborators.get(id);
    return c?.name || name;
  }));
}

// ==============================================================
//  PERSON CHIP — chip visual con link a Hub
// ==============================================================
function _personChipHTML(name, collabId = null, { small = false } = {}) {
  if (!name) return '<span style="color:var(--text-3)">—</span>';
  const sz      = small ? '.62rem' : '.72rem';
  const linked  = !!collabId;
  const bg      = linked
    ? 'color-mix(in srgb,var(--accent) 10%,transparent)'
    : 'var(--bg-elevated)';
  const border  = linked
    ? 'color-mix(in srgb,var(--accent) 32%,transparent)'
    : 'var(--border-str)';
  const color   = linked ? 'var(--accent)' : 'var(--text-2)';
  const dot     = linked ? 'var(--accent)' : 'var(--text-3)';
  return `<span class="person-chip"
    ${linked ? `data-collab-hub="${collabId}" title="Ver hub de ${esc(name)}"` : `title="${esc(name)}"`}
    style="display:inline-flex;align-items:center;gap:4px;
           font-family:var(--font-mono);font-size:${sz};
           background:${bg};border:1px solid ${border};color:${color};
           padding:1px 8px;border-radius:99px;white-space:nowrap;
           ${linked ? 'cursor:pointer;' : ''}">
    <span style="width:5px;height:5px;border-radius:50%;flex-shrink:0;background:${dot}"></span>
    <span class="person-chip-name">${esc(name)}</span>
  </span>`;
}

// ==============================================================
//  AUTOCOMPLETE DE COLABORADORES — reutilizable en todos los modales
// ==============================================================
async function _attachCollaboratorAutocomplete(inputEl, { multi = false } = {}) {
  if (!inputEl) return;
  const collabs = await db.collaborators.orderBy('name').toArray();
  if (!collabs.length) return;

  // Map local de nombre→id para el modo multi (vive en closure)
  const _idMap = new Map();
  // Si hay un mapa previo serializado, restaurarlo
  try {
    const stored = inputEl.dataset.collabIdMap;
    if (stored) JSON.parse(stored).forEach(([k, v]) => _idMap.set(k, v));
  } catch {}

  let popup = null;
  const removePopup = () => { popup?.remove(); popup = null; };

  const showPopup = (query) => {
    removePopup();
    const lq = query.toLowerCase().trim();
    if (!lq) return;
    const matches = collabs
      .filter(c => c.name.toLowerCase().includes(lq) ||
                   (c.role||'').toLowerCase().includes(lq) ||
                   (c.affiliation||'').toLowerCase().includes(lq))
      .slice(0, 6);
    if (!matches.length) return;

    const rect = inputEl.getBoundingClientRect();
    popup = document.createElement('div');
    popup.className = 'collab-suggest';
    popup.style.cssText =
      `left:${rect.left}px;top:${rect.bottom + 3}px;` +
      `min-width:${Math.max(rect.width, 240)}px;max-width:360px`;

    matches.forEach(c => {
      const item = document.createElement('div');
      item.className = 'collab-suggest-item';
      item.innerHTML = `
        <span class="collab-suggest-name">${esc(c.name)}</span>
        ${c.role || c.affiliation
          ? `<span class="collab-suggest-meta">${[c.role, c.affiliation].filter(Boolean).map(esc).join(' · ')}</span>`
          : ''}`;
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        if (multi) {
          const parts = inputEl.value.split(',').map(s => s.trim()).filter(Boolean);
          // Reemplazar el fragmento actual que el usuario estaba escribiendo
          const lastPart = parts[parts.length - 1] || '';
          if (c.name.toLowerCase().startsWith(lastPart.toLowerCase()))
            parts.pop();
          if (!parts.includes(c.name)) {
            parts.push(c.name);
            _idMap.set(c.name, c.id); // guardar ID canónico
          }
          inputEl.value = parts.join(', ');
          // Serializar mapa actualizado
          inputEl.dataset.collabIdMap = JSON.stringify([..._idMap.entries()]);
        } else {
          inputEl.value = c.name;
          inputEl.dataset.selectedCollabId = String(c.id);
        }
        removePopup();
        inputEl.focus();
        inputEl.dispatchEvent(new Event('input'));
      });
      popup.appendChild(item);
    });

    document.body.appendChild(popup);
  };

  const getQuery = () => {
    if (!multi) return inputEl.value;
    const parts = inputEl.value.split(',');
    return parts[parts.length - 1].trim();
  };

  // Al escribir manualmente (no desde dropdown), invalidar el ID almacenado
  inputEl.addEventListener('input', () => {
    if (!multi) {
      delete inputEl.dataset.selectedCollabId;
    } else {
      // Limpiar IDs de nombres que ya no están en el texto
      const currentNames = inputEl.value.split(',').map(s => s.trim()).filter(Boolean);
      for (const [name] of [..._idMap.entries()]) {
        if (!currentNames.includes(name)) _idMap.delete(name);
      }
      inputEl.dataset.collabIdMap = JSON.stringify([..._idMap.entries()]);
    }
    showPopup(getQuery());
  });
  inputEl.addEventListener('focus',  () => showPopup(getQuery()));
  inputEl.addEventListener('blur',   () => setTimeout(removePopup, 160));
  inputEl.addEventListener('keydown', e => {
    if (!popup) return;
    if (e.key === 'Escape') { e.stopPropagation(); removePopup(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); popup.firstElementChild?.focus(); }
  });
  popup?.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') e.target.nextElementSibling?.focus();
    if (e.key === 'ArrowUp')   { e.preventDefault(); e.target.previousElementSibling?.focus() || inputEl.focus(); }
  });
}

async function _checkSessionResume() {
  // Solo una vez por sesión del navegador
  if (sessionStorage.getItem('ros-session-checked')) return;
  sessionStorage.setItem('ros-session-checked', '1');

  const lastActive = localStorage.getItem('ros-last-active');
  if (!lastActive) {
    localStorage.setItem('ros-last-active', String(Date.now()));
    return;
  }

  const gapMs = Date.now() - Number(lastActive);
  if (gapMs < 24 * 60 * 60 * 1000) return;  // < 24h → el Daily Briefing cubre el resumen diario

  const [projects, ideas, snippets, meetings] = await Promise.all([
    db.projects.orderBy('updatedAt').reverse().limit(10).toArray(),
    db.ideas.orderBy('updatedAt').reverse().limit(10).toArray(),
    db.snippets.orderBy('updatedAt').reverse().limit(10).toArray(),
    db.meetings.toArray(),
  ]);

  // Últimos 3 ítems editados (proyectos, ideas, snippets mezclados)
  const recentItems = [
    ...projects.map(p => ({ type:'project', icon:'◉',    label:p.title, sub:p.type,           ts:p.updatedAt, id:p.id })),
    ...ideas.map(i    => ({ type:'idea',    icon:'◎',    label:i.title, sub:'Idea',             ts:i.updatedAt, id:i.id })),
    ...snippets.map(s => ({ type:'snippet', icon:'⟨/⟩', label:s.title, sub:s.language||'Snippet', ts:s.updatedAt, id:s.id })),
  ]
  .filter(x => x.ts)
  .sort((a, b) => b.ts.localeCompare(a.ts))
  .slice(0, 3);

  // Action items pendientes de reuniones
  const pendingAIs = meetings
    .flatMap(m => (m.actionItems || []).filter(a => !a.done)
      .map(ai => ({ text: ai.text, meetingTitle: m.title, meetingId: m.id })))
    .slice(0, 4);

  // Proyecto más urgente con deadline próximo
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const urgentProj = projects
    .filter(p => p.deadline && !p.archived)
    .map(p => ({ ...p, daysLeft: Math.round((new Date(p.deadline + 'T00:00:00') - today) / 86400000) }))
    .filter(p => p.daysLeft >= 0)
    .sort((a, b) => a.daysLeft - b.daysLeft)[0] || null;

  if (!recentItems.length && !pendingAIs.length && !urgentProj) return;

  const gapHours = Math.floor(gapMs / 3600000);
  const gapLabel = gapHours < 24 ? `${gapHours}h` : `${Math.floor(gapHours / 24)}d`;

  showModal('↩ Retomando tu sesión', `
    <div class="modal-body">
      <p style="font-size:.78rem;color:var(--text-3);font-family:var(--font-mono);margin-bottom:16px">
        Última actividad hace <strong style="color:var(--text-2)">${gapLabel}</strong>
      </p>

      ${recentItems.length ? `
        <div class="sr-section-label">Últimas ediciones</div>
        <div style="margin-bottom:16px">
          ${recentItems.map(item => `
            <div class="sr-item" data-sr-type="${item.type}" data-sr-id="${item.id}">
              <span style="font-size:.85rem;flex-shrink:0">${item.icon}</span>
              <span class="sr-item-label">${esc(item.label)}</span>
              <span class="sr-item-meta">${esc(item.sub)} · ${relativeDate(item.ts)}</span>
            </div>`).join('')}
        </div>` : ''}

      ${pendingAIs.length ? `
        <div class="sr-section-label">Acciones pendientes (${pendingAIs.length})</div>
        <div style="margin-bottom:16px">
          ${pendingAIs.map(ai => `
            <div class="sr-ai-item" data-sr-meeting="${ai.meetingId}">
              <span style="color:var(--amber);flex-shrink:0">⚑</span>
              <span class="sr-item-label">${esc(ai.text)}</span>
              <span class="sr-item-meta">${esc(ai.meetingTitle.slice(0, 24))}</span>
            </div>`).join('')}
        </div>` : ''}

      ${urgentProj ? `
        <div class="sr-section-label">Más urgente</div>
        <div class="sr-urgent-item" data-sr-type="project" data-sr-id="${urgentProj.id}">
          <span style="font-size:1rem;flex-shrink:0">⏱</span>
          <div style="flex:1;min-width:0">
            <div class="sr-urgent-title">${esc(urgentProj.title)}</div>
            <div class="sr-urgent-sub"
                 style="color:${urgentProj.daysLeft === 0 ? 'var(--red)' : urgentProj.daysLeft <= 3 ? 'var(--amber)' : 'var(--text-3)'}">
              ${urgentProj.daysLeft === 0 ? '¡Vence hoy!' : `Deadline en ${urgentProj.daysLeft}d · ${formatDate(urgentProj.deadline)}`}
            </div>
          </div>
        </div>` : ''}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="srDismiss">Ignorar</button>
      <button class="btn btn-primary" id="srContinue">Continuar →</button>
    </div>`);

  const navigateToItem = (type, id) => {
    closeModal();
    if      (type === 'project') { navigate('projects'); setTimeout(() => inspectProject(id), 120); }
    else if (type === 'idea')    { navigate('ideas');    setTimeout(() => inspectIdea(id),    120); }
    else if (type === 'snippet') {
      navigate('snippets');
      setTimeout(async () => { const s = await db.snippets.get(id); if (s) inspectSnippet(s); }, 120);
    }
  };

  document.querySelectorAll('.sr-item, .sr-urgent-item').forEach(el => {
    el.addEventListener('click', () => navigateToItem(el.dataset.srType, +el.dataset.srId));
  });
  document.querySelectorAll('.sr-ai-item').forEach(el => {
    el.addEventListener('click', () => {
      closeModal(); navigate('meetings'); setTimeout(() => inspectMeeting(+el.dataset.srMeeting), 120);
    });
  });
  $('srDismiss').addEventListener('click', closeModal);
  $('srContinue').addEventListener('click', closeModal);

  localStorage.setItem('ros-last-active', String(Date.now()));
}

// ==============================================================
//  INIT
// ==============================================================
function _showBootError() {
  mainContent.innerHTML = `
    <div class="boot-error" role="alert" style="max-width:560px;margin:12vh auto;padding:0 24px;line-height:1.55">
      <div style="font-size:1.1rem;font-weight:700;margin-bottom:10px">⚠ ResearchOS no pudo iniciar</div>
      <p style="color:var(--text-2);margin-bottom:10px">
        No se cargó <strong>Dexie.js</strong>, la librería de la base de datos local. Suele ocurrir al abrir la app
        por primera vez <em>sin conexión</em> o con un bloqueador que impide cargar <code>cdnjs.cloudflare.com</code>.
      </p>
      <ul style="color:var(--text-2);margin:0 0 16px 18px">
        <li>Conéctate a Internet y recarga: las librerías quedarán guardadas para uso sin conexión.</li>
        <li>Si usas un bloqueador de contenido, permite <code>cdnjs.cloudflare.com</code> para este sitio.</li>
        <li>Tus datos no se han perdido: siguen en el almacenamiento de este navegador.</li>
      </ul>
      <button class="btn btn-primary" onclick="location.reload()">Reintentar</button>
    </div>`;
}

async function init() {
  if (typeof Dexie === 'undefined') { _showBootError(); return; }
  _wireDbEvents();                                      // aviso si otra pestaña actualiza la base de datos
  _wireLive();                                          // refresco inmediato de la vista ante cualquier cambio de datos
  Meetings.expandAll().catch(() => {});                // reuniones que se repiten: crea las ocurrencias que falten

  // Librerías opcionales: la app funciona sin ellas, con menos funciones.
  const _optional = [['marked', 'Markdown']]
    .filter(([g]) => typeof window[g] === 'undefined').map(([, n]) => n);
  if (_optional.length) setTimeout(() => showToast(`No se cargaron: ${_optional.join(', ')}. La app funciona con funciones reducidas.`, 'info'), 600);

  // Seed database defaults
  await seedDefaults();
  await refreshColumnFlags();
  navigator.storage?.persist?.().catch(() => {});      // pide almacenamiento persistente: evita que el navegador evacúe la BD
  if (!localStorage.getItem('ros-first-seen')) localStorage.setItem('ros-first-seen', String(Date.now()));

  // Cargar etapas del pipeline desde settings (reconstruye SUB_STATUSES, maps derivados)
  const _initStages = await _getSubStages();
  _applySubStages(_initStages);

  // Google Drive Sync — restaurar sesión si hay token guardado
  await GoogleSync.init();

  // -- Iniciar deadline reminders ---------------------
  const notifEnabled = localStorage.getItem('ros-notif-enabled') === 'true';
  if (notifEnabled) {
    DeadlineReminder.requestPermission().then(ok => {
      if (ok) DeadlineReminder.start();
    });
  }

  // Persistir preferencias del Kanban
  App.kanbanDensity  = localStorage.getItem('ros-kanban-density')  || 'detailed';
  App.kanbanGroupBy  = localStorage.getItem('ros-kanban-groupby')  || 'none';
  App.projViewMode   = localStorage.getItem('ros-proj-view-mode')  || 'grid';

  // Theme persistence
  const savedTheme = localStorage.getItem('ros-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  $('themeToggle').addEventListener('click', () => {
    document.body.classList.add('theme-transitioning');
    setTimeout(() => document.body.classList.remove('theme-transitioning'), 420);
    const current = document.documentElement.getAttribute('data-theme');
    const next    = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ros-theme', next);
  });

  // -- Sidebar collapse ----------------------------------------
  const _updateCollapseBtn = () => {
    const btn = $('sidebarCollapseBtn');
    if (!btn) return;
    const isCol = document.body.classList.contains('sidebar-collapsed');
    btn.innerHTML = isCol ? '›' : '‹';
    btn.title     = isCol ? 'Expandir sidebar' : 'Contraer sidebar';
  };


  // El colapso de escritorio no aplica al drawer móvil (≤ 600 px): allí el sidebar siempre se ve completo.
  const mobileMQ = window.matchMedia('(max-width: 600px)');
  const applyCollapsed = () => {
    const pref = localStorage.getItem('ros-sidebar-collapsed') === '1';
    document.body.classList.toggle('sidebar-collapsed', pref && !mobileMQ.matches);
    if (!mobileMQ.matches) closeMobileMenu();
    _updateCollapseBtn();
  };
  applyCollapsed();
  mobileMQ.addEventListener?.('change', applyCollapsed);
  $('mobileMenuBtn')?.addEventListener('click', () => {
    const open = document.body.classList.toggle('sidebar-mobile-open');
    $('mobileMenuBtn').setAttribute('aria-expanded', String(open));
  });
  $('sidebarBackdrop')?.addEventListener('click', closeMobileMenu);
  $('sidebarCollapseBtn')?.addEventListener('click', () => {
    // En móvil (<600px): toggle drawer lateral, no colapsar
    if (window.innerWidth <= 600) {
      document.body.classList.toggle('sidebar-mobile-open');
      return;
    }
    // Desktop: colapsar/expandir sidebar
    document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem('ros-sidebar-collapsed',
      document.body.classList.contains('sidebar-collapsed') ? '1' : '0');
    _updateCollapseBtn();
  });

  // Accent color init + handlers
  _applyAccent(localStorage.getItem('ros-accent') || 'blue');
  document.querySelectorAll('.accent-swatch').forEach(sw => {
    sw.addEventListener('click', () => _applyAccent(sw.dataset.accent));
  });

  initNavGroups();                  // grupos plegables del menú (today.js)
  NavProfile.apply();               // perfil de uso: qué vistas muestra el menú (today.js)
  await renderContextSwitcher();    // selector de área activa

  // Navigation history buttons
  $('navBack')?.addEventListener('click', navBack);
  $('navForward')?.addEventListener('click', navForward);

  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-view]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      // «Proyectos» abre la última pestaña usada (Tablero, Lista, Línea de tiempo o Jerarquía)
      const remembered = link.dataset.remember === 'proj-tab' && localStorage.getItem('ros-proj-tab');
      navigate(remembered && PROJECT_TABS.some(t => t.view === remembered) ? remembered : link.dataset.view);
    });
  });

  // Presentation mode exit
  $('presExitBtn')?.addEventListener('click', () => {
    document.body.classList.remove('presentation-mode');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' && App.view === 'kanban') {
      e.preventDefault();
      document.body.classList.toggle('presentation-mode');
    }
    if (e.key === 'Escape') {
      document.body.classList.remove('presentation-mode');
    }
  });

  // Inspector close
  $('closeInspector').addEventListener('click', closeInspector);

  // Modal close
  $('modalClose').addEventListener('click', requestCloseModal);
  $('modalOverlay').addEventListener('click', (e) => {
    if (e.target === $('modalOverlay')) requestCloseModal();
  });
  const markDirty = e => { if (e.isTrusted) App._modalDirty = true; };      // solo lo que escribe la persona, no los eventos que lanza la app
  modalContent.addEventListener('input', markDirty); modalContent.addEventListener('change', markDirty);
  // Enter en un campo de una sola línea = botón principal de la ventana
  modalContent.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.shiftKey || e.isComposing) return;
    const t = e.target;
    if (!t.matches?.('input.form-input:not([type=checkbox]):not([type=radio]):not([type=file])') || t.closest('.proj-chip-picker, [data-no-enter]') || t.getAttribute('list') || t.getAttribute('aria-autocomplete')) return;
    if (modalContent.querySelector('.proj-chip-dropdown:not(:empty), .person-dropdown, .autocomplete-list')) return;
    const primary = modalContent.querySelector('.modal-footer .btn-primary:not([disabled])');
    if (primary) { e.preventDefault(); primary.click(); }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Una sola capa por pulsación: paleta → modal → inspector.
      if ($('paletteOverlay').classList.contains('open')) closePalette();
      else if (modalOverlay.classList.contains('visible')) requestCloseModal();
      else closeInspector();
    }
    // Atrapa el foco dentro del modal abierto (Tab / Shift+Tab)
    if (e.key === 'Tab' && modalOverlay.classList.contains('visible')) {
      const focusables = [...$('modal').querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.offsetParent !== null);
      if (focusables.length) {
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (!$('modal').contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    // Durante el recorrido guiado lo que se abre quedaría bajo la capa atenuada, sin poder usarse: solo vale la paleta en el paso del buscador
    const _tour = typeof Tour !== 'undefined' && Tour.active;
    if ((e.metaKey || e.ctrlKey) && e.key === 'k' && (!_tour || Tour.steps[Tour.i]?.id === 'buscar')) {
      e.preventDefault();
      $('paletteOverlay').classList.contains('open') ? closePalette() : openPalette();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'K' && !_tour) {
      e.preventDefault(); navigate('kanban');
    }
    // Atajos contextuales sin modificador — solo si no hay foco en input/modal/paleta
    const _noFocus   = !e.target.closest('input, textarea, select, [contenteditable]');
    const _noModal   = !modalOverlay.classList.contains('visible');
    const _noPalette = !$('paletteOverlay').classList.contains('open');
    const _plain = !e.metaKey && !e.ctrlKey && !e.altKey;       // Ctrl/⌘+C (copiar), ⌘+S (guardar), etc. son del navegador, no atajos de la app
    if (_noFocus && _noModal && _noPalette && _plain && !_tour) {
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); _contextualNew(); }
      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); focusCapture(); }
      if (e.key === 'e' || e.key === 'E') { e.preventDefault(); _inspectorEdit(); }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); _inspectorStar(); }
      if (e.key === '?') { e.preventDefault(); openShortcutsHelp(); }
    }
    // Deshacer lo último (borrados, archivados, movimientos…) aunque el aviso ya haya desaparecido
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z') && _noFocus && _noModal && _noPalette && !_tour) {
      e.preventDefault(); undoLast();
    }
    // «/» lleva el cursor al filtro de la lista
    if (e.key === '/' && _plain && _noFocus && _noModal && _noPalette && !_tour && $('listFilterInput')) { e.preventDefault(); $('listFilterInput').focus(); }
    // Historial de vistas, como anuncian los botones ← →
    if (e.altKey && !e.metaKey && !e.ctrlKey && _noFocus && _noModal && _noPalette && !_tour) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); navBack(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); navForward(); }
    }
    // Enter / Espacio abren la fila o tarjeta enfocada (ver enableKeyboardClicks)
    if ((e.key === 'Enter' || e.key === ' ') && e.target.hasAttribute?.('data-kb') && !e.target.matches('input, textarea, select, button, a')) {
      e.preventDefault(); e.target.click();
    }
  });

  // Botones de los estados vacíos («+ Reunión», «+ Snippet»…)
  mainContent.addEventListener('click', e => {
    const b = e.target.closest('[data-empty-cta]');
    if (!b) return;
    const go = {
      project: () => showAddProjectModal(), paper: () => { App._projectTemplate = 'paper'; App._skipTemplateStep = true; showAddProjectModal(); },
      idea: () => $('ideaTitleInput')?.focus(), snippet: () => showAddSnippetModal(), meeting: () => showAddMeetingModal(),
      reference: () => showAddReferenceModal(), collaborator: () => showAddCollaboratorModal(),
      'import-bib': () => $('importRefsBtn')?.click(),
    }[b.dataset.emptyCta];
    go?.();
  });
  // Enlace «Saltar al contenido»: enfoca el contenido sin cambiar la URL
  $('skipLink')?.addEventListener('click', e => { e.preventDefault(); mainContent.focus({ preventScroll: true }); });
  $('shortcutsBtn')?.addEventListener('click', () => openShortcutsHelp());
  const modHint = $('paletteModKey'); if (modHint) modHint.textContent = `${MOD_KEY}K`;

  _initPalette();

  // -- Bienvenida en primer uso ----------------------------
  if (!localStorage.getItem('ros-welcomed')) {
    // quien ya trabaja con la app (datos propios o de ejemplo) no necesita la bienvenida en cada apertura
    const hasData = (await db.projects.count()) + (await db.ideas.count()) + (await db.tasks.count()) > 0;
    if (hasData) localStorage.setItem('ros-welcomed', '1'); else _showWelcomeModal();
  }

  initAutoBackup().catch(() => {});             // integrations.js
  initSync().catch(() => {});                   // sync.js
  initAssistant().catch(() => {});              // assistant.js
  await handleSharedCapture().catch(() => {});  // «Compartir → ResearchOS» desde el móvil

  // Índice de búsqueda inicial
  _buildSearchIndex().catch(() => {});
  // Initial view
  navigate('dashboard');
  // Un repintado directo (renderIdeas(), renderToday()…) también cuenta como «ya repintó»: el refresco central no lo repite.
  for (const name of ['renderToday', 'renderKanban', 'renderProjects', 'renderIdeas', 'renderSnippets', 'renderArchived', 'renderStarred',
                      'renderTimeline', 'renderNestedProjects', 'renderWeeklyAgenda', 'renderSubmissions', 'renderMeetings', 'renderReferences',
                      'renderCollaborators', 'renderProjectHub', 'renderOrphans', 'renderIdeaTriage', 'renderAreas', 'renderCollaboratorHub',
                      'renderWeeklyReview', 'renderReport']) {
    const fn = window[name];
    if (typeof fn !== 'function') continue;
    window[name] = function (...args) {
      App._renderStartedAt = performance.now();
      const startView = App.view;
      const result = fn.apply(this, args);
      // Si la persona cambió de vista mientras este repintado directo esperaba a la base de datos, pudo pisar la vista nueva: se repinta la actual.
      if (result && typeof result.then === 'function') result.then(() => { if (App.view !== startView) renderView(App.view); }, () => {});
      return result;
    };
  }
  Live.ready = true;                // desde aquí, cualquier cambio de datos refresca la vista abierta
  // Resumen de sesión (se muestra si hubo ≥4h de inactividad)
  setTimeout(() => _checkSessionResume().catch(() => {}), 800);

  // delegación global para person-chip → collaborator hub
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-collab-hub]');
    if (!chip) return;
    const cid = +chip.dataset.collabHub;
    if (!cid) return;
    App.collaboratorHubId = cid;
    navigate('collaborator-hub');
  });
}

// ==============================================================
//  ÁREAS DE INVESTIGACIÓN  (almacenadas en settings como JSON)
// ==============================================================
async function _getAreas() {
  const s = await db.settings.get('ros-areas');
  const areas = s ? (JSON.parse(s.value) || []) : [];
  // Cada área lleva uid y updatedAt (como el resto de registros) para poder sincronizarse entre dispositivos
  let dirty = false;
  for (const a of areas) {
    if (!a.uid) { a.uid = legacyUid('areas', { name: a.name }); dirty = true; }
    if (!a.updatedAt) { a.updatedAt = '1970-01-01T00:00:00.000Z'; dirty = true; }
  }
  if (dirty) await db.settings.put({ key: 'ros-areas', value: JSON.stringify(areas) });
  return areas;
}
async function _saveAreas(areas) {
  const prev = await _getAreas();
  const prevByUid = new Map(prev.map(a => [a.uid, a]));
  const now = new Date().toISOString();
  const strip = a => JSON.stringify({ ...a, updatedAt: null });
  for (const a of areas) {
    if (!a.uid) a.uid = newUid();
    const p = prevByUid.get(a.uid);
    if (!p || strip(p) !== strip(a)) a.updatedAt = now;           // «gana el cambio más reciente» también para las áreas
  }
  for (const p of prev.filter(p => !areas.some(a => a.uid === p.uid)))
    await db.tombstones.add({ uid: p.uid, table: 'areas', deletedAt: now, name: p.name });         // el borrado de un área se propaga (también por nombre)
  await db.settings.put({ key: 'ros-areas', value: JSON.stringify(areas) });
  if (typeof renderContextSwitcher === 'function') renderContextSwitcher();
}

// ==============================================================
//  COLUMN PRESETS — vistas nombradas del Kanban
//  Almacenadas en settings['ros-col-presets'] como JSON
// ==============================================================
async function _getColPresets() {
  const s = await db.settings.get('ros-col-presets');
  if (s?.value) return JSON.parse(s.value);
  const defaults = [
    { id: 'research', name: 'Investigación', icon: '🔬',
      types: ['Paper', 'Grant', 'Análisis', 'Dataset'] },
    { id: 'teaching', name: 'Docencia', icon: '🎓',
      types: ['Proyecto', 'Presentación', 'Curso'] },
  ];
  await _saveColPresets(defaults);
  return defaults;
}

async function _saveColPresets(presets) {
  await db.settings.put({ key: 'ros-col-presets', value: JSON.stringify(presets) });
}

const AREA_COLORS = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#14b8a6','#f97316','#ec4899'];

async function renderAreas() {
  const [areas, projects] = await Promise.all([
    _getAreas(),
    db.projects.filter(p => !p.archived).toArray()
  ]);
  mainContent.innerHTML = '';   // limpiar DESPUÉS del fetch → no hay frame en blanco
  mainContent.insertAdjacentHTML('beforeend', `
    <div class="view">
      <div class="view-header">
        <div>
          <div class="view-title">Áreas de Investigación</div>
          <div class="view-subtitle">${areas.length} área(s)</div>
        </div>
        <button class="btn btn-primary" id="addAreaBtn">+ Nueva Área</button>
      </div>
      <div class="areas-grid" id="areasGrid">
        ${areas.length ? areas.map(area => {
          const count = projects.filter(p => p.areaId === area.id).length;
          return `
            <div class="area-card" style="border-top:3px solid ${cssColor(area.color)}">
              <div class="area-card-header">
                <span class="area-card-title">${esc(area.name)}${area.parentId && areas.find(a => a.id === area.parentId) ? ` <span class="form-hint">↳ ${esc(areas.find(a => a.id === area.parentId).name)}</span>` : ''}</span>
                <span class="area-card-count">${count} proyecto(s)</span>
              </div>
              ${area.description ? `<div class="area-card-desc">${esc(area.description)}</div>` : ''}
              <div class="area-card-actions">
                <button class="btn btn-ghost btn-sm" data-edit-area="${area.id}">✎ Editar</button>
                <button class="btn btn-ghost btn-sm" data-area-filter="${area.id}"
                        style="color:var(--accent)">◉ Ver proyectos</button>
                <button class="btn btn-ghost btn-sm" data-del-area="${area.id}"
                        style="color:var(--red)">✕</button>
              </div>
            </div>`;
        }).join('') : `
          <div class="empty-state" style="grid-column:1/-1">
            <span class="empty-state-icon">⊡</span>
            <h3>Sin áreas definidas</h3>
            <p>Las áreas son tus frentes (Investigación, Docencia, Gestión…). Con un área activa, Hoy, el Tablero y la lista solo muestran ese frente.</p>
            <button class="btn btn-primary" id="seedAreasBtn" style="margin-top:12px">Crear áreas sugeridas</button>
          </div>`}
      </div>
    </div>`);

  $('addAreaBtn').addEventListener('click', () => showAreaModal());
  $('seedAreasBtn')?.addEventListener('click', async () => { await seedSuggestedAreas(); showToast('Áreas creadas ✓ — elige una en el menú lateral', 'success'); renderAreas(); });
  mainContent.querySelectorAll('[data-edit-area]').forEach(btn => {
    const area = areas.find(a => a.id === +btn.dataset.editArea);
    if (area) btn.addEventListener('click', () => showAreaModal(area));
  });
  mainContent.querySelectorAll('[data-del-area]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await askConfirm('Los proyectos vinculados quedarán sin área.', { title: '¿Eliminar esta área?', confirmLabel: 'Eliminar', danger: true }))) return;
      const id = +btn.dataset.delArea;
      const all = await _getAreas(), gone = all.find(a => a.id === id);
      await _saveAreas(all.filter(a => a.id !== id).map(a => a.parentId === id ? { ...a, parentId: gone?.parentId ?? null } : a));       // las subáreas suben un nivel
      const linked = await db.projects.filter(p => p.areaId === id).toArray();
      await Promise.all(linked.map(p => db.projects.update(p.id, { areaId: null })));
      showToast('Área eliminada', 'info');
      renderView('areas');
    });
  });
  mainContent.querySelectorAll('[data-area-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.filterArea        = btn.dataset.areaFilter;
      App.filters           = { type:'all', priority:'all', column:'all' };
      App.filterResponsible = 'all';
      App.groupBy           = 'none';
      App._projPage         = 1;
      navigate('projects');
    });
  });
}

async function showAreaModal(area = null) {
  const isEdit = !!area;
  const all = await _getAreas(), blocked = isEdit ? areaWithDescendants(all, area.id) : new Set();          // una subárea no puede ser madre de su propia madre
  const parents = areaTree(all).filter(({ area: a }) => !blocked.has(a.id));
  showModal(isEdit ? 'Editar Área' : 'Nueva Área', `
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Nombre *</label>
        <input class="form-input" id="am-name" value="${esc(area?.name||'')}"
               placeholder="Ej: Ecología, Modelado estadístico…">
      </div>
      <div class="form-group">
        <label class="form-label">Descripción (opcional)</label>
        <input class="form-input" id="am-desc" value="${esc(area?.description||'')}">
      </div>
      <div class="form-group">
        <label class="form-label">Dentro de <span class="form-hint">(opcional: para anidar áreas)</span></label>
        <select class="form-select" id="am-parent"><option value="">— Es un área principal —</option>${parents.map(({ area: a, depth }) =>
          `<option value="${a.id}" ${a.id === area?.parentId ? 'selected' : ''}>${'\u00a0\u00a0'.repeat(depth)}${depth ? '↳ ' : ''}${esc(a.name)}</option>`).join('')}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Color</label>
        <div class="area-color-picker">
          ${AREA_COLORS.map(c => `
            <span class="area-color-swatch ${(area?.color||AREA_COLORS[0])===c?'selected':''}"
                  data-color="${c}" style="background:${c}"></span>`).join('')}
        </div>
        <input type="hidden" id="am-color" value="${esc(cssColor(area?.color, AREA_COLORS[0]))}">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="amCancel">Cancelar</button>
      <button class="btn btn-primary" id="amSave">${isEdit?'Guardar cambios':'Crear área'}</button>
    </div>`);

  modalContent.querySelectorAll('.area-color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      modalContent.querySelectorAll('.area-color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
      $('am-color').value = sw.dataset.color;
    });
  });
  $('amCancel').addEventListener('click', closeModal);
  $('amSave').addEventListener('click', async () => {
    const name = $('am-name').value.trim();
    if (!name) { showToast('El nombre es requerido', 'error'); return; }
    const fresh = await _getAreas();
    if (isEdit) {
      const idx = fresh.findIndex(a => a.id === area.id);
      if (idx >= 0) fresh[idx] = { ...fresh[idx], name,
        description: $('am-desc').value.trim(), color: $('am-color').value, parentId: +$('am-parent').value || null };
    } else {
      fresh.push({ id: Date.now(), name,
        description: $('am-desc').value.trim(), color: $('am-color').value, parentId: +$('am-parent').value || null });
    }
    await _saveAreas(fresh);
    closeModal();
    showToast(isEdit ? 'Área actualizada ✓' : 'Área creada ✓', 'success');
    renderView('areas');
  });
}

// ==============================================================
//  ESTADO DE INVESTIGACIÓN — Barra compacta en el sidebar
// ==============================================================
async function _renderResearchStatus() {
  const el = $('researchStatus');
  if (!el) return;
  await refreshColumnFlags();
  const today = new Date(); today.setHours(0,0,0,0);
  const all   = (await db.projects.filter(p => !p.archived).toArray()).filter(inContext);
  const idle   = all.filter(p => isIdle(p)).length;                    // sin movimiento (no cuenta lo que espera respuesta ni lo terminado)
  const urgent = all.filter(p => {
    if (!p.deadline || isFinished(p)) return false;
    const d = Math.round((new Date(p.deadline + 'T00:00:00') - today) / 86400000);
    return d >= 0 && d <= 7;
  }).length;
  const active = all.filter(p => !isFinished(p)).length;

  el.innerHTML = `
    <div class="research-status-bar">
      <button class="rs-chip rs-active" data-rs-nav="projects"
              title="${active} proyectos en curso">◉ ${active} en curso</button>
      ${urgent ? `<button class="rs-chip rs-urgent" data-rs-nav="timeline"
              title="${urgent} con fecha límite en ≤7 días">⏱ ${urgent} urgente${urgent!==1?'s':''}</button>` : ''}
      ${idle ? `<button class="rs-chip rs-zombie" data-rs-nav="review"
              title="${idle} sin movimiento en más de 30 días (no cuentan los que esperan respuesta ni los terminados)">⊘ ${idle} quieto${idle!==1?'s':''}</button>` : ''}
    </div>`;
  el.querySelectorAll('[data-rs-nav]').forEach(btn =>
    btn.addEventListener('click', () => navigate(btn.dataset.rsNav)));
}

// ==============================================================
//  SISTEMA DE ALERTAS — Panel dismissable
// ==============================================================
async function _evalAlerts() {
  // Las fechas límite y las tareas atrasadas ya viven en «Hoy»: aquí solo avisos que nadie más muestra,
  // agrupados (antes eran ~15 líneas rojas) y sin penalizar lo que espera respuesta o está terminado.
  await refreshColumnFlags();
  const all = (await db.projects.filter(p => !p.archived).toArray()).filter(inContext);
  const alerts = [];

  const idle = all.filter(p => isIdle(p, 30))
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  if (idle.length) {
    const names = idle.slice(0, 2).map(p => `«${p.title.length > 38 ? p.title.slice(0, 36) + '…' : p.title}»`).join(', ');
    alerts.push({ id: `idle-${idle.length}`, severity: 'warn', nav: 'review',
      msg: `⊘ ${idle.length} proyecto${idle.length > 1 ? 's' : ''} sin movimiento hace más de 30 días (${names}${idle.length > 2 ? '…' : ''}) · revísalo${idle.length > 1 ? 's' : ''} en la revisión semanal` });
  }

  if (typeof AutoBackup !== 'undefined' && AutoBackup.paused && AutoBackup.enabled())
    alerts.push({ id: 'ab-paused', severity: 'warn', nav: 'settings', msg: '🗄 La copia automática está en pausa: el navegador necesita que la reactives (Ajustes → Copia automática)' });

  // Recordatorio de backup: los datos viven solo en este navegador.
  if (all.length) {
    const sinceFirst = Math.floor((Date.now() - (+localStorage.getItem('ros-first-seen') || Date.now())) / 86400000);
    const days = BackupMeta.daysSince();
    if (days === null && sinceFirst >= 3)
      alerts.push({ id: 'bk-never', severity: 'warn', msg: '💾 Tus datos solo existen en este navegador y nunca has exportado un backup (Ajustes → Exportar)' });
    else if (days !== null && days >= BackupMeta.BACKUP_DAYS)
      alerts.push({ id: 'bk-old', severity: 'warn', msg: `💾 Tu último backup fue hace ${days} días (Ajustes → Exportar)` });
  }
  return alerts;
}

function _getDismissedAlerts() {
  try { return new Set(JSON.parse(sessionStorage.getItem('ros-dismissed')||'[]')); }
  catch { return new Set(); }
}

async function _renderAlertPanel(container) {
  if (!container) return;
  const dismissed = _getDismissedAlerts();
  const alerts    = (await _evalAlerts()).filter(a => !dismissed.has(a.id));
  if (!alerts.length) return;

  const panel = document.createElement('div');
  panel.className = 'alert-panel';
  panel.innerHTML = `
    <div class="alert-panel-header">
      <span>⚑ ${alerts.length} alerta${alerts.length>1?'s':''}</span>
      <button class="btn btn-ghost btn-sm ap-close-all">✕ Todas</button>
    </div>
    ${alerts.slice(0, 5).map(a => `
      <div class="alert-item alert-${a.severity}">
        <span class="alert-msg" ${a.nav ? `data-alert-nav="${a.nav}" style="cursor:pointer"` : ''}>${esc(a.msg)}</span>
        <button class="alert-dismiss" data-aid="${a.id}" title="Descartar">✕</button>
      </div>`).join('')}`;

  const bcBar = container.querySelector('.breadcrumb-bar');
  if (bcBar) bcBar.insertAdjacentElement('afterend', panel);
  else container.prepend(panel);

  panel.querySelectorAll('[data-alert-nav]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.alertNav)));
  panel.querySelectorAll('[data-aid]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = _getDismissedAlerts(); s.add(btn.dataset.aid);
      sessionStorage.setItem('ros-dismissed', JSON.stringify([...s]));
      btn.closest('.alert-item').remove();
      const n = panel.querySelectorAll('.alert-item').length;
      if (!n) panel.remove();
      else panel.querySelector('.alert-panel-header span').textContent =
        `⚑ ${n} alerta${n>1?'s':''}`;
    });
  });
  panel.querySelector('.ap-close-all')?.addEventListener('click', () => {
    const s = _getDismissedAlerts();
    alerts.forEach(a => s.add(a.id));
    sessionStorage.setItem('ros-dismissed', JSON.stringify([...s]));
    panel.remove();
  });
}

// ==============================================================
//  ÍNDICE DE BÚSQUEDA EN MEMORIA
// ==============================================================
/** Títulos → elemento, para resolver enlaces [[Título]] y autocompletarlos (el primero gana si hay repetidos). */
function makeTitleIndex({ projects = [], ideas = [], snippets = [], refs = [], meets = [], collabs = [] }) {
  const titles = new Map();
  const addTitle = (type, list, key = 'title') => list.forEach(x => {
    const k = foldText(x[key]).trim();
    if (k && !titles.has(k)) titles.set(k, { type, id: x.id, title: x[key] });
  });
  addTitle('project', projects); addTitle('idea', ideas); addTitle('snippet', snippets);
  addTitle('ref', refs); addTitle('meeting', meets); addTitle('collab', collabs, 'name');
  return titles;
}

/** Palabras buscables de un texto: sin tildes, separadas por espacios y signos («geom_point» → geom, point). */
const _searchTokens = str => foldText(str).split(/[\s,;:/\-_()\[\].=+*<>{}"'`|\\]+/).filter(t => t.length >= 2);

async function _buildSearchIndex() {
  const [projects, ideas, snippets, refs, meets, collabs, tasks] = await Promise.all([
    db.projects.toArray(), db.ideas.toArray(), db.snippets.toArray(),
    db.references.toArray(), db.meetings.toArray(), db.collaborators.toArray(), db.tasks.toArray(),
  ]);

  App._titleIndex = makeTitleIndex({ projects, ideas, snippets, refs, meets, collabs });

  const idx = new Map();
  const tokenize = _searchTokens;
  const add = (type, id, toks) => {
    [...new Set(toks)].forEach(tok => {
      if (!idx.has(tok)) idx.set(tok, []);
      idx.get(tok).push({ type, id });
    });
  };

  projects.forEach(p => add('project', p.id, [
    ...tokenize(p.title), ...tokenize(p.description), ...tokenize(p.responsible), ...tokenize(p.targetVenue),
    ...(p.tags||[]).flatMap(tokenize)
  ]));
  ideas.forEach(i => add('idea', i.id, [
    ...tokenize(i.title), ...tokenize(i.content), ...(i.tags||[]).flatMap(tokenize)
  ]));
  snippets.forEach(s => add('snippet', s.id, [
    ...tokenize(s.title), ...tokenize(s.description), ...tokenize(s.language), ...tokenize(String(s.code || '').slice(0, 8000)),
    ...(s.tags||[]).flatMap(tokenize)
  ]));
  refs.forEach(r => add('ref', r.id, [
    ...tokenize(r.title), ...tokenize(r.authors), ...tokenize(r.journal), ...tokenize(r.notes), ...tokenize(r.doi), ...tokenize(r.citeKey),
    ...tokenize(r.abstract), ...(r.tags||[]).flatMap(tokenize), ...(r.keywords||[]).flatMap(tokenize), ...tokenize(r.year)
  ]));
  meets.forEach(m => add('meeting', m.id, [
    ...tokenize(m.title), ...tokenize(m.agreements), ...tokenize(m.participants),
    ...(m.actionItems||[]).flatMap(a => tokenize(a.text))
  ]));
  tasks.forEach(t => add('task', t.id, tokenize(t.title)));
  collabs.forEach(c => add('collab', c.id, [
    ...tokenize(c.name), ...tokenize(c.role), ...tokenize(c.affiliation), ...tokenize(c.email), ...tokenize(c.notes)
  ]));

  App._searchIdx = idx;
  App._searchIdxDirty = false;
}

// ==============================================================
//  COMMAND PALETTE
// ==============================================================
let _paletteActiveIdx = -1;
let _paletteResults   = [];

function openPalette() {
  $('paletteOverlay').classList.add('open');
  if (typeof Onboard !== 'undefined') Onboard.mark('search');
  const input = $('paletteInput');
  input.value = '';
  input.focus();
  _searchPalette('');
}

function closePalette() {
  $('paletteOverlay').classList.remove('open');
  _paletteActiveIdx = -1;
}

function _paletteSetActive(idx) {
  _paletteActiveIdx = idx;
  $('paletteResults').querySelectorAll('.palette-item').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    if (i === idx) el.scrollIntoView({ block: 'nearest' });
  });
}

/** Puntúa una consulta de varias palabras: frase contigua, o todas las palabras repartidas entre los campos (algo menos). */
function _scoreQuery(lq, words, fields) {
  const whole = _scoreMatch(lq, fields);
  if (words.length < 2) return whole;
  const per = words.map(w => _scoreMatch(w, fields));
  const spread = per.every(s => s > 0) ? per.reduce((s, x) => s + x, 0) / per.length * 0.8 : 0;
  return Math.max(whole, spread);
}

// -- Relevance scorer para búsqueda unificada -------------
function _scoreMatch(lq, fields) {
  // fields: array de { text, weight }  → retorna 0-100
  let score = 0;
  for (const { text, weight } of fields) {
    if (!text) continue;
    const t = foldText(text);
    if (t === lq)               score += weight * 1.0;
    else if (t.startsWith(lq)) score += weight * 0.8;
    else if (t.includes(lq))   score += weight * 0.5;
  }
  return Math.min(100, score);
}

// Cada tecla lanza una búsqueda asíncrona. Solo vale la última: una respuesta lenta de una consulta anterior no puede pisar a la
// actual, y Enter espera a que termine la búsqueda en curso (si no, ejecutaría una acción de lo que se había escrito antes).
let _paletteSeq = 0, _paletteLast = Promise.resolve();
function _searchPalette(q) { const my = ++_paletteSeq; return _paletteLast = _searchPaletteNow(q, my); }

async function _searchPaletteNow(q, my) {
  if (App._searchIdxDirty) await _buildSearchIndex();      // hubo escrituras desde el último índice
  const lq = foldText(q).trim();
  const qScore = lq.split(/\s+/).filter(Boolean);                // para puntuar: cada palabra escrita, por corta que sea
  const qWords = [...new Set(_searchTokens(q))];                 // «geom_point» → geom, point · «paper alfa» → paper, alfa
  let projects, ideas, snippets, refs, meets, tasks, people;

  if (lq.length >= 2 && qWords.length && App._searchIdx.size > 0) {
    // Índice disponible: candidatos = elementos que contienen TODAS las palabras; luego se leen solo esos registros
    const types = ['project', 'idea', 'snippet', 'ref', 'meeting', 'task', 'collab'];
    const perWord = qWords.map(w => {
      const m = Object.fromEntries(types.map(t => [t, new Set()]));
      App._searchIdx.forEach((entries, tok) => { if (tok.includes(w)) entries.forEach(e => m[e.type]?.add(e.id)); });
      return m;
    });
    const hits = Object.fromEntries(types.map(t => [t, perWord.reduce((acc, m) => acc ? new Set([...acc].filter(id => m[t].has(id))) : m[t], null)]));
    const load = (table, type) => hits[type].size ? db[table].where('id').anyOf([...hits[type]]).toArray() : Promise.resolve([]);
    [projects, ideas, snippets, refs, meets, tasks, people] = await Promise.all([
      load('projects', 'project'), load('ideas', 'idea'), load('snippets', 'snippet'), load('references', 'ref'),
      load('meetings', 'meeting'), load('tasks', 'task'), load('collaborators', 'collab')]);
  } else {
    [projects, ideas, snippets, refs, meets, tasks, people] = await Promise.all([
      db.projects.toArray(), db.ideas.toArray(), db.snippets.toArray(), db.references.toArray(), db.meetings.toArray(),
      db.tasks.toArray(), db.collaborators.toArray(),
    ]);
  }

  const groups = [];

  // Vistas: mismos nombres que el menú, con sinónimos para encontrarlas escribiendo lo que uno recuerda
  const go = (view, extra) => () => { closePalette(); extra?.(); navigate(view); };
  const navItems = [
    { icon: uiIcon('today'),         label: 'Hoy',                     keys: 'inicio tareas pendientes dashboard', action: go('dashboard') },
    { icon: uiIcon('projects'),      label: 'Proyectos · Tablero',     keys: 'kanban columnas', action: go('kanban') },
    { icon: uiIcon('list'),          label: 'Proyectos · Lista',       keys: 'tarjetas tabla', action: go('projects') },
    { icon: uiIcon('timeline'),      label: 'Proyectos · Línea de tiempo', keys: 'timeline gantt plazos', action: go('timeline') },
    { icon: uiIcon('nested'),        label: 'Proyectos · Jerarquía',   keys: 'anidados subproyectos arbol', action: go('nested') },
    { icon: uiIcon('ideas'),         label: 'Ideas',                   keys: 'inbox bandeja captura', action: go('ideas') },
    { icon: uiIcon('triage'),        label: 'Revisión rápida de ideas', keys: 'triage', action: go('triage', () => { App.triageIdx = 0; }) },
    { icon: uiIcon('calendar'),      label: 'Calendario',              keys: 'agenda semana mes', action: go('weekly') },
    { icon: uiIcon('network'),       label: 'Red',                     keys: 'grafo conexiones obsidian relaciones', action: go('network') },
    { icon: uiIcon('references'),    label: 'Referencias',             keys: 'bibliografia papers bib zotero', action: go('references') },
    { icon: uiIcon('snippets'),      label: 'Snippets',                keys: 'codigo scripts', action: go('snippets') },
    { icon: uiIcon('star'),          label: 'Favoritos',               keys: 'destacados estrella', action: go('starred') },
    { icon: uiIcon('meetings'),      label: 'Reuniones',               keys: 'actas acuerdos', action: go('meetings') },
    { icon: uiIcon('collaborators'), label: 'Colaboradores',           keys: 'personas equipo contactos', action: go('collaborators') },
    { icon: uiIcon('review'),        label: 'Revisión semanal',        keys: 'repaso', action: go('review') },
    { icon: uiIcon('report'),        label: 'Informe de avance',       keys: 'reporte resumen', action: go('report') },
    { icon: uiIcon('submissions'),   label: 'Submissions',             keys: 'envios revistas papers revision', action: go('submissions') },
    { icon: uiIcon('areas'),         label: 'Áreas',                   keys: 'investigacion docencia gestion contexto', action: go('areas') },
    { icon: uiIcon('archived'),      label: 'Archivados',              keys: 'archivo', action: go('archived') },
    { icon: uiIcon('orphans'),       label: 'Elementos huérfanos',     keys: 'huerfanos sin proyecto', action: go('orphans') },
    { icon: uiIcon('filesystem'),    label: 'Carpetas del proyecto',   keys: 'fs bridge carpetas disco archivos', action: go('filesystem') },
    { icon: uiIcon('tutorial'),      label: 'Tutorial',                keys: 'ayuda guia', action: go('tutorial') },
    { icon: uiIcon('settings'),      label: 'Ajustes y backup',        keys: 'settings configuracion exportar importar copia seguridad drive cifrado', action: go('settings') },
  ].map(n => ({ sub: 'Vista', ...n })).filter(n => !lq || foldText(n.label + ' ' + n.keys).includes(lq));

  // Acciones: lo que se hace más seguido, sin tener que ir a la vista primero
  const actionItems = [
    { icon: uiIcon('capture'),  label: 'Capturar una tarea o idea', keys: 'nueva rapido anotar', hint: 'C', action: () => { closePalette(); focusCapture(); } },
    { icon: uiIcon('project'),  label: 'Nuevo proyecto',           keys: 'crear paper grant curso', hint: 'N', action: () => { closePalette(); showAddProjectModal(); } },
    { icon: uiIcon('ideas'),    label: 'Nueva idea',               keys: 'crear', action: () => { closePalette(); showAddIdeaModal(); } },
    { icon: uiIcon('meetings'), label: 'Nueva reunión',            keys: 'crear acta', action: () => { closePalette(); showAddMeetingModal(); } },
    { icon: uiIcon('today'),    label: 'Planificar mi día',        keys: 'agenda dia plan', action: () => { closePalette(); openDayPlanner(); } },
    { icon: uiIcon('today'),    label: 'Planificar la semana',     keys: 'semana plan carga plazos reparto', action: () => { closePalette(); openWeekPlanner(); } },
    { icon: uiIcon('theme'),    label: 'Cambiar tema claro / oscuro', keys: 'modo oscuro claro noche', action: () => { closePalette(); $('themeToggle').click(); } },
    { icon: uiIcon('keyboard'), label: 'Atajos de teclado',        keys: 'ayuda teclas', hint: '?', action: () => { closePalette(); openShortcutsHelp(); } },
    { icon: uiIcon('tutorial'), label: 'Recorrido guiado',         keys: 'tutorial ayuda empezar primeros pasos tour', action: () => { closePalette(); Tour.start({ restart: true }); } },
    { icon: uiIcon('star'),     label: 'Cargar datos de ejemplo',  keys: 'demo ejemplo practicar laboratorio', action: () => { closePalette(); loadSampleAndShow().catch(e => showToast(e.message, 'error')); } },
    { icon: uiIcon('archived'), label: 'Quitar datos de ejemplo',  keys: 'borrar demo ejemplo limpiar', action: () => { closePalette(); confirmRemoveSample(); } },
  ].map(n => ({ sub: n.hint ? `Acción · ${n.hint}` : 'Acción', ...n })).filter(n => !lq || foldText(n.label + ' ' + n.keys).includes(lq));
  // Sin texto: primero lo que se hace; escribiendo: primero lo que coincide en vistas
  const navGroup = navItems.length ? [{ label: 'Vistas', items: navItems }] : [];
  const actGroup = actionItems.length ? [{ label: 'Acciones', items: actionItems }] : [];
  groups.push(...(lq ? [...navGroup, ...actGroup] : [...actGroup, ...navGroup]));

  // -- Sugerencias contextuales: proyecto abierto en el Inspector --
  if (!lq && App._inspectedProjectId) {
    const pid = App._inspectedProjectId;
    const [ctxProj, ctxIdeas, ctxSnips, ctxMeets] = await Promise.all([
      db.projects.get(pid),
      db.ideas.where('projectId').equals(pid).toArray(),
      db.snippets.where('projectId').equals(pid).toArray(),
      db.meetings.where('projectId').equals(pid).toArray(),
    ]);
    if (ctxProj) {
      const ctxItems = [];
      ctxItems.push({
        icon: '⬡', label: `Abrir Hub — ${ctxProj.title}`, sub: 'Project Hub',
        action: () => { closePalette(); App.projectHubId = pid; navigate('project-hub'); }
      });
      ctxIdeas.slice(0, 3).forEach(i => ctxItems.push({
        icon: '◎', label: i.title, sub: 'Idea vinculada',
        action: () => { closePalette(); inspectIdea(i.id); }
      }));
      ctxSnips.slice(0, 2).forEach(s => ctxItems.push({
        icon: '⟨/⟩', label: s.title, sub: s.language || 'Snippet',
        action: () => { closePalette(); db.snippets.get(s.id).then(f => { if (f) inspectSnippet(f); }); }
      }));
      ctxMeets.slice(0, 2).forEach(m => ctxItems.push({
        icon: '🗓', label: m.title, sub: formatDate(m.date),
        action: () => { closePalette(); inspectMeeting(m.id); }
      }));
      if (ctxItems.length > 1)
        groups.push({ label: `◉ Contexto: "${ctxProj.title.slice(0, 32)}"`, items: ctxItems });
    }
  }

  // -- Cuando hay query: búsqueda unificada rankeada ------
  if (lq) {
    const allItems = [
      ...projects.map(p => ({
        score: _scoreQuery(lq, qScore, [
          { text: p.title,       weight: 60 },
          { text: p.description, weight: 25 },
          { text: p.responsible, weight: 15 },
          { text: p.targetVenue, weight: 10 },
          ...(p.tags||[]).map(t => ({ text: t, weight: 20 }))
        ]),
        icon: '◉', label: p.title, sub: p.type,
        action: () => { closePalette(); navigate('projects'); setTimeout(() => inspectProject(p.id), 120); }
      })),
      ...ideas.map(i => ({
        score: _scoreQuery(lq, qScore, [
          { text: i.title,   weight: 60 },
          { text: i.content, weight: 30 },
          ...(i.tags||[]).map(t => ({ text: t, weight: 20 }))
        ]),
        icon: '◎', label: i.title, sub: 'Idea',
        action: () => { closePalette(); navigate('ideas'); setTimeout(() => inspectIdea(i.id), 120); }
      })),
      ...snippets.map(s => ({
        score: _scoreQuery(lq, qScore, [
          { text: s.title,       weight: 60 },
          { text: s.description, weight: 25 },
          { text: s.code,        weight: 15 },
          { text: s.language,    weight: 10 }
        ]),
        icon: '⟨/⟩', label: s.title, sub: s.language || 'Snippet',
        action: () => { closePalette(); navigate('snippets'); setTimeout(async () => {
          const fresh = await db.snippets.get(s.id); if (fresh) inspectSnippet(fresh);
        }, 120); }
      })),
      ...refs.map(r => ({
        score: _scoreQuery(lq, qScore, [
          { text: r.title,   weight: 60 },
          { text: r.authors, weight: 30 },
          { text: r.journal, weight: 15 },
          { text: r.notes,   weight: 20 },
          { text: r.doi,     weight: 30 },
          { text: r.citeKey, weight: 30 },
          { text: [...(r.tags || []), ...(r.keywords || [])].join(' '), weight: 15 }
        ]),
        icon: '📚', label: r.title,
        sub: `${r.authors?.split(',')[0]||''} ${r.year||''}`.trim(),
        action: () => { closePalette(); navigate('references'); setTimeout(() => inspectReference(r.id), 120); }
      })),
      ...meets.map(m => ({
        score: _scoreQuery(lq, qScore, [
          { text: m.title,        weight: 60 },
          { text: m.agreements,   weight: 25 },
          { text: m.participants, weight: 15 },
          { text: (m.actionItems || []).map(a => a.text).join(' '), weight: 15 }
        ]),
        icon: '🗓', label: m.title, sub: formatDate(m.date),
        action: () => { closePalette(); navigate('meetings'); setTimeout(() => inspectMeeting(m.id), 120); }
      })),
      ...tasks.map(t => ({
        score: _scoreQuery(lq, qScore, [{ text: t.title, weight: 60 }]) * (t.done ? 0.6 : 1),
        icon: t.done ? '✔' : '✓', label: t.title,
        sub: `Tarea${t.done ? ' hecha' : ''}${t.due ? ' · ' + dueLabel(t.due) : ''}`,
        action: () => { closePalette(); if (t.projectId) { navigate('projects'); setTimeout(() => inspectProject(t.projectId), 120); } else navigate('dashboard'); }
      })),
      ...people.map(c => ({
        score: _scoreQuery(lq, qScore, [{ text: c.name, weight: 70 }, { text: c.role, weight: 20 }, { text: c.affiliation, weight: 20 }, { text: c.email, weight: 30 }, { text: c.notes, weight: 10 }]),
        icon: '👥', label: c.name, sub: [c.role, c.affiliation].filter(Boolean).join(' · ') || 'Persona',
        action: () => { closePalette(); navigate('collaborators'); setTimeout(() => inspectCollaborator(c.id), 120); }
      })),
    ].filter(item => item.score > 0)
     .sort((a, b) => b.score - a.score)
     .slice(0, 10);

    if (allItems.length) groups.push({ label: `Resultados para "${q}"`, items: allItems });
  } else {
    // Sin query: mostrar vistas de navegación (comportamiento original)
  }

  // «Crear»: lo escrito también puede convertirse en tarea / idea / proyecto / reunión (parser de captura rápida)
  let createOnly = false;
  if (lq.length >= 2) {
    const [all, people] = await Promise.all([db.projects.toArray(), db.collaborators.toArray()]);
    const base = parseCapture(q, all, new Date(), people);
    if (base.title) {
      const plain = c => [c.projectTitle && `en «${c.projectTitle}»`, c.assigneeName && `esperando a ${c.assigneeName}`, c.due && dueLabel(c.due),
                          c.recurrence && `↻ ${recurrenceLabel(c.recurrence)}`, c.priority && `prioridad ${c.priority.toLowerCase()}`].filter(Boolean).join(' · ');
      const mk = kind => {
        const c = { ...base, kind };
        return { icon: { task: '✓', idea: '◎', project: '◉', meeting: '🗓' }[kind], label: `Crear ${_KIND_LABEL[kind].toLowerCase()}: «${c.title}»`, sub: plain(c) || (kind === base.kind ? 'sugerido' : ''),
          action: async () => {
            closePalette();
            try { showToast((await runCapture(c)) + ' ✓', 'success'); renderView(App.view); updateBadges(); }
            catch (err) { showToast(err.message, 'error'); }
          } };
      };
      const order = [base.kind, ...['task', 'idea', 'project', 'meeting'].filter(k => k !== base.kind)];
      createOnly = !groups.length;
      groups.push({ label: 'Crear con lo que escribiste', items: (base.explicit ? [base.kind] : order.slice(0, 3)).map(mk) });
    }
  }

  if (my !== _paletteSeq) return;                          // mientras tanto se escribió otra cosa: este resultado ya no sirve

  // Flatten for keyboard navigation
  _paletteResults = groups.flatMap(g => g.items);
  _paletteActiveIdx = _paletteResults.length > 0 ? 0 : -1;

  const container = $('paletteResults');
  if (!_paletteResults.length) {
    container.innerHTML = lq
      ? `<div class="palette-empty">Sin resultados para "${esc(q)}"</div>`
      : `<div class="palette-empty" style="font-size:.8rem;color:var(--text-3);padding:16px">Escribe para buscar en proyectos, ideas, tareas, personas, snippets (también su código), reuniones y referencias…</div>`;
    return;
  }

  let html = createOnly ? `<div class="palette-empty">Sin resultados para "${esc(q)}"</div>` : ''; let globalIdx = 0;
  for (const group of groups) {
    html += `<div class="palette-group-label">${esc(group.label)}</div>`;
    for (const item of group.items) {
      html += `<div class="palette-item ${globalIdx === 0 ? 'active' : ''}" data-pidx="${globalIdx}">
        <span class="palette-item-icon">${item.icon}</span>
        <span class="palette-item-label">${esc(item.label)}</span>
        <span class="palette-item-sub">${esc(item.sub || '')}</span>
      </div>`;
      globalIdx++;
    }
  }
  container.innerHTML = html;

  container.querySelectorAll('.palette-item').forEach(el => {
    const idx = +el.dataset.pidx;
    el.addEventListener('click', () => _paletteResults[idx]?.action());
    el.addEventListener('mouseenter', () => _paletteSetActive(idx));
  });
}

function _initPalette() {
  const input   = $('paletteInput');
  const overlay = $('paletteOverlay');

  input.addEventListener('input',   e => _searchPalette(e.target.value));
  input.addEventListener('keydown', async e => {
    if (e.key === 'Enter') { e.preventDefault(); await _paletteLast.catch(() => {}); }          // resultados al día antes de actuar
    const len = _paletteResults.length;
    if (!len) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _paletteSetActive(Math.min(_paletteActiveIdx + 1, len - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _paletteSetActive(Math.max(_paletteActiveIdx - 1, 0));
    } else if (e.key === 'Enter') {
      if (_paletteActiveIdx >= 0) _paletteResults[_paletteActiveIdx]?.action();
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) closePalette(); });
}

// ==============================================================
//  SUBTASKS (Ideas)
// ==============================================================
// Las "subtareas" de proyectos e ideas son filas de la tabla `tasks` (ver Tasks en db.js): tienen fecha
// opcional y se agregan en la vista Hoy junto con las tareas sueltas.
const _stRefresh = (type, id) =>
  type === 'project' ? inspectProject(id) : inspectIdea(id);

async function _stAfterChange(entityType, entityId) {
  if (App.view === 'dashboard') renderView('dashboard');
  else if (App.view === 'project-hub' && entityType === 'project') renderProjectHub();
  else if (App.view === 'ideas') renderIdeas();
  _stRefresh(entityType, entityId);
  updateBadges();
}

async function toggleSubtask(entityId, taskId, entityType = 'idea') {
  const t = await db.tasks.get(taskId);
  if (!t) return;
  await dbWrite(() => Tasks.setDone(taskId, !t.done));
  _stAfterChange(entityType, entityId);
}

async function deleteSubtask(entityId, taskId, entityType = 'idea') {
  await dbWrite(() => Tasks.remove(taskId));
  _stAfterChange(entityType, entityId);
}

async function addSubtask(entityId, text, entityType = 'idea') {
  if (!text.trim()) return;
  const due = document.getElementById(`stDue-${entityId}`)?.value || null;
  let projectId = null, ideaId = null;
  if (entityType === 'project') projectId = entityId;
  else { ideaId = entityId; projectId = (await db.ideas.get(entityId))?.projectId ?? null; }
  await dbWrite(() => Tasks.add({ title: text, due, projectId, ideaId }));
  _stAfterChange(entityType, entityId);
}

/** Etiqueta corta y legible de una fecha límite: "hoy", "mañana", "vie 6 nov", "hace 3 d". */
function dueLabel(due) {
  if (!due) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = Math.round((new Date(due + 'T00:00:00') - today) / 86400000);
  if (d === 0) return 'hoy';
  if (d === 1) return 'mañana';
  if (d === -1) return 'ayer';
  if (d < 0) return `hace ${-d} d`;
  return new Date(due + 'T00:00:00').toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' });
}

function subtaskListHTML(entity, entityType = 'idea', tasks = []) {
  const id    = entity.id;
  const done  = tasks.filter(t => t.done).length;
  const todayISO = localDateISO();
  return `
    <div class="inspector-related-title">
      Tareas
      ${tasks.length ? `<span class="subtask-count-badge">${done}/${tasks.length}</span>` : ''}
    </div>
    <div class="subtask-list" id="stList-${id}">
      ${tasks.map(t => `
        <div class="subtask-item">
          <button class="subtask-check ${t.done ? 'done' : ''}"
                  data-toggle-st="${esc(t.id)}"
                  data-entity-type="${entityType}"
                  aria-label="${t.done ? 'Marcar como pendiente' : 'Marcar como hecha'}">
            ${t.done ? '✓' : ''}
          </button>
          <span class="subtask-text ${t.done ? 'done' : ''}">${esc(t.title)}</span>
          <button class="subtask-due ${t.due && !t.done && t.due < todayISO ? 'overdue' : ''} ${t.due ? 'has-due' : ''}"
                  data-st-due="${esc(t.id)}" data-st-value="${esc(t.due || '')}"
                  title="${t.due ? 'Cambiar fecha' : 'Añadir fecha'}">${t.due ? esc(dueLabel(t.due)) : '📅'}</button>
          <button class="subtask-del"
                  data-del-st="${t.id}"
                  data-entity-type="${entityType}" aria-label="Eliminar tarea">✕</button>
        </div>`).join('')}
    </div>
    <div class="subtask-add-row">
      <input class="subtask-add-input" id="stInput-${id}"
             placeholder="Nueva tarea…" maxlength="200">
      <input class="subtask-due-input" type="date" id="stDue-${id}" title="Fecha límite (opcional)" aria-label="Fecha límite">
      <button class="btn btn-ghost btn-sm" id="stAddBtn-${id}"
              data-entity-type="${entityType}" aria-label="Añadir tarea">+</button>
    </div>`;
}

window.addEventListener('DOMContentLoaded', init);
