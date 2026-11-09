// ============================================================
//  ResearchOS — Recorrido guiado y primeros pasos
//
//  · Recorrido interactivo: ilumina el elemento real de cada pantalla, lleva a la vista correcta y, en los pasos
//    «Tu turno», espera a que la persona lo haga (crear una tarea, abrir un proyecto, abrir la paleta…) y avanza solo.
//    Se puede salir en cualquier momento y retomar donde quedó. Con la app vacía ofrece cargar datos de ejemplo.
//  · «Primeros pasos»: lista en Hoy que se marca sola según lo que la persona va haciendo.
//  · Aviso de datos de ejemplo (con atajos para quitarlos o reiniciar sus fechas) y su bloque en Ajustes.
// ============================================================

'use strict';

// ==============================================================
//  1) Primeros pasos: lo que ya hizo la persona
// ==============================================================
const Onboard = {
  KEY: 'ros-onboard',
  get() { try { return JSON.parse(localStorage.getItem(Onboard.KEY)) || {}; } catch { return {}; } },
  set(p) { try { localStorage.setItem(Onboard.KEY, JSON.stringify({ ...Onboard.get(), ...p })); } catch {} },
  /** Anota algo que no se deduce de la base de datos (abrir la paleta, mover un proyecto…). */
  mark(name) {
    if (Onboard.get()[name]) return;
    Onboard.set({ [name]: true });
    if (typeof App !== 'undefined' && App.view === 'dashboard' && $('onboardHost')) renderOnboarding($('onboardHost')).catch(() => {});
  },
};

/** Espera a que la vista esté pintada y ejecuta `fn` (para acciones que dependen de algo de esa vista). */
function afterView(view, fn, tries = 0) {
  if (typeof mainContent !== 'undefined' && mainContent.dataset.view === view) return fn();
  if (tries < 40) setTimeout(() => afterView(view, fn, tries + 1), 100);
}

const _isSample = r => String(r?.uid || '').startsWith(SAMPLE_PREFIX);

async function _appIsEmpty() {
  const [p, i, t] = await Promise.all([db.projects.count(), db.ideas.count(), db.tasks.count()]);
  return p + i + t === 0;
}

async function _onboardItems() {
  const flags = Onboard.get();
  const any = t => db[t].filter(r => !_isSample(r)).first().then(Boolean);              // basta con saber si hay alguno propio: no se cargan las tablas enteras
  const [areas, hasTask, hasProject, hasIdea] = await Promise.all([_getAreas(), any('tasks'), any('projects'), any('ideas')]);
  return [
    { id: 'areas',   done: areas.length > 0,                 text: 'Define tus áreas (Investigación, Docencia, Gestión…)', btn: 'Crear sugeridas',
      run: async () => { await seedSuggestedAreas(); showToast('Áreas creadas ✓ — elige una en el menú', 'success'); } },
    { id: 'capture', done: hasTask,            text: 'Captura tu primera tarea', btn: 'Escribirla', run: () => focusCapture() },
    { id: 'project', done: hasProject,         text: 'Crea tu primer proyecto', btn: '+ Proyecto', run: () => showAddProjectModal() },
    { id: 'idea',    done: hasIdea,            text: 'Anota una idea', btn: 'Ir a Ideas',
      run: () => { navigate('ideas'); afterView('ideas', () => $('ideaTitleInput')?.focus()); } },
    { id: 'moved',   done: !!flags.moved,                     text: 'Mueve un proyecto a otra columna del tablero', btn: 'Ir al tablero',
      run: () => { navigate('kanban'); showToast('Arrastra una tarjeta a otra columna', 'info'); } },
    { id: 'search',  done: !!flags.search,                    text: `Prueba el buscador (${MOD_KEY} K)`, btn: 'Abrirlo', run: () => openPalette() },
    { id: 'backup',  done: BackupMeta.last() !== null || !!(AutoBackup.enabled() && AutoBackup.lastRun()), text: 'Protege tus datos: elige una carpeta de copia automática o exporta un backup', btn: 'Ir a Ajustes', run: () => navigate('settings') },
  ];
}

/** Pinta en Hoy el aviso de datos de ejemplo y la lista de primeros pasos. */
async function renderOnboarding(host) {
  if (!host) return;
  let html = '';
  const sampleCnt = await sampleCount();
  if (sampleCnt > 0) {
    let loaded = null, age = 0;
    try { loaded = localStorage.getItem('ros-sample-date'); } catch {}
    if (loaded) age = Math.round((new Date(localDateISO() + 'T12:00:00') - new Date(loaded + 'T12:00:00')) / 86400000);
    const stale = age >= 7;
    html += `<div class="sample-banner ${stale ? 'is-stale' : ''}" role="status">
      <div class="sample-banner-text"><strong>Estás viendo datos de ejemplo.</strong>
        ${stale ? `Los cargaste hace ${age} días, así que sus fechas ya se quedaron atrás.` : 'Sus fechas se calcularon a partir de hoy; puedes editar, mover y borrar lo que quieras.'}</div>
      <div class="sample-banner-actions">
        <button class="btn btn-ghost btn-sm" id="sbTour">▶ Recorrido guiado</button>
        <button class="btn ${stale ? 'btn-primary' : 'btn-ghost'} btn-sm" id="sbRefresh" title="Vuelve a cargar el ejemplo con fechas de hoy (los cambios que le hiciste se pierden)">↻ Reiniciar con fechas de hoy</button>
        <button class="btn btn-ghost btn-sm" id="sbRemove" title="Quita solo los datos de ejemplo; lo que creaste tú se conserva">Quitar ejemplo</button>
      </div></div>`;
  }

  const st = Onboard.get();
  let items = [];
  const firstRun = !!host.closest('#todayRoot')?.querySelector('.first-run');         // con la app vacía ya hay un panel de bienvenida: la lista aparece después
  if (!st.dismissed && !firstRun) {
    const many = (await db.projects.count()) + (await db.ideas.count()) > 60;        // quien ya tiene mucho material no necesita la guía
    if (many) Onboard.set({ dismissed: true }); else items = await _onboardItems();
  }
  const doneN = items.filter(i => i.done).length;
  const all = items.length && doneN === items.length;
  if (items.length && !(all && st.celebrated)) {
    const collapsed = st.collapsed ?? sampleCnt > 0;                                  // con el ejemplo cargado ya hay mucho en pantalla: la lista empieza plegada
    html += `<section class="onboard ${collapsed ? 'is-collapsed' : ''}" aria-labelledby="obTitle">
      <div class="onb-head">
        <button class="onb-toggle" id="obToggle" aria-expanded="${!collapsed}" aria-controls="obList" aria-label="${collapsed ? 'Mostrar' : 'Ocultar'} la lista de primeros pasos">${collapsed ? '▸' : '▾'}</button>
        <h2 class="onb-title" id="obTitle">${all ? '¡Listo! Ya conoces lo esencial 🎉' : 'Primeros pasos'} <span class="onb-count">${doneN}/${items.length}</span></h2>
        <div class="onb-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${items.length}" aria-valuenow="${doneN}" aria-label="Primeros pasos completados"><i style="width:${Math.round(doneN / items.length * 100)}%"></i></div>
        <div class="onb-head-actions">
          ${sampleCnt > 0 ? '' : '<button class="btn btn-ghost btn-sm" id="obTour">▶ Recorrido guiado</button>'}
          <button class="btn btn-ghost btn-sm" id="obHide" aria-label="Ocultar los primeros pasos" title="Ocultar (puedes volver a verlos desde el Tutorial)">${all ? 'Cerrar' : '✕'}</button>
        </div>
      </div>
      <ul class="onb-list" id="obList" ${collapsed ? 'hidden' : ''}>
        ${items.map(i => `<li class="onb-item ${i.done ? 'done' : ''}">
          <span class="onb-check" aria-hidden="true">${i.done ? '✓' : ''}</span>
          <span class="onb-text">${esc(i.text)}${i.done ? '<span class="sr-only"> (hecho)</span>' : ''}</span>
          ${i.done ? '' : `<button class="btn btn-ghost btn-sm" data-ob="${i.id}">${esc(i.btn)}</button>`}</li>`).join('')}
      </ul></section>`;
  }
  host.innerHTML = html;
  if (!html) return;

  $('sbTour')?.addEventListener('click', () => Tour.start({ restart: true }));
  $('sbRefresh')?.addEventListener('click', () => refreshSampleDates());
  $('sbRemove')?.addEventListener('click', () => confirmRemoveSample());
  $('obTour')?.addEventListener('click', () => Tour.start());
  $('obToggle')?.addEventListener('click', () => { Onboard.set({ collapsed: $('obToggle').getAttribute('aria-expanded') === 'true' }); renderOnboarding(host); });
  $('obHide')?.addEventListener('click', () => { Onboard.set({ dismissed: true, celebrated: true }); host.innerHTML = ''; renderOnboarding(host); });
  host.querySelectorAll('[data-ob]').forEach(b => b.addEventListener('click', () => items.find(i => i.id === b.dataset.ob)?.run()));
  if (all && !st.celebrated) Onboard.set({ celebrated: true });                     // la felicitación se ve una vez
}

// ==============================================================
//  2) Datos de ejemplo: acciones con confirmación y bloque de Ajustes
// ==============================================================
async function refreshSampleDates() {
  if (!(await askConfirm('Se vuelve a cargar el laboratorio de ejemplo con fechas de hoy. Lo que hayas cambiado en esos datos se pierde; lo que creaste tú se conserva.',
        { title: '¿Reiniciar el ejemplo con fechas de hoy?', confirmLabel: 'Reiniciar' }))) return;
  await loadSampleData({ replace: true });
  showToast('Ejemplo actualizado: las fechas vuelven a estar al día ✓', 'success');
}

async function confirmRemoveSample() {
  if (!(await hasSampleData())) { showToast('No hay datos de ejemplo cargados', 'info'); return; }
  if (!(await askConfirm('Se quitan los proyectos, ideas, tareas, reuniones y demás datos del laboratorio de ejemplo. Lo que creaste tú se conserva (las áreas también).',
        { title: '¿Quitar los datos de ejemplo?', confirmLabel: 'Quitar ejemplo', danger: true }))) return;
  await removeSampleData();
}

/** Carga el ejemplo y lleva a Hoy. Lo usan el modal de bienvenida, el panel de primeros pasos y Ajustes. */
async function loadSampleAndShow() {
  const summary = await loadSampleData();
  const added = Object.values(summary.added || {}).reduce((a, b) => a + b, 0);
  showToast(added ? 'Datos de ejemplo cargados ✓ — con fechas de hoy' : 'Los datos de ejemplo ya estaban cargados', added ? 'success' : 'info');
  navigate('dashboard');
}

function sampleSettingsHTML() {
  return `
    <div class="settings-section" id="sampleSection">
      <div class="settings-section-title">🧪 Recorrido y datos de ejemplo</div>
      <div class="settings-body">
        <div class="settings-row">
          <div><div class="settings-row-label">Recorrido guiado</div>
            <div class="settings-row-desc">Un paseo de unos 3 minutos por lo esencial, con pasos para probar tú. Retoma donde lo dejaste.</div></div>
          <button class="btn btn-ghost btn-sm" id="setTourBtn">▶ Iniciar</button>
        </div>
        <div class="settings-row">
          <div><div class="settings-row-label">Laboratorio de ejemplo</div>
            <div class="settings-row-desc" id="sampleStateDesc">Datos de muestra de un laboratorio de ecología, con fechas calculadas a partir de hoy. Se pueden quitar sin tocar lo tuyo.</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" id="setSampleLoad">Cargar</button>
            <button class="btn btn-ghost btn-sm" id="setSampleRefresh" hidden>↻ Fechas de hoy</button>
            <button class="btn btn-ghost btn-sm" id="setSampleRemove" hidden>Quitar</button>
          </div>
        </div>
        <div class="settings-row">
          <div><div class="settings-row-label">Primeros pasos en Hoy</div>
            <div class="settings-row-desc">La lista que se marca sola mientras usas la app.</div></div>
          <button class="btn btn-ghost btn-sm" id="setOnbShow">Mostrar de nuevo</button>
        </div>
      </div>
    </div>`;
}

async function wireSampleSettings() {
  $('setTourBtn')?.addEventListener('click', () => Tour.start({ restart: true }));
  $('setOnbShow')?.addEventListener('click', () => { Onboard.set({ dismissed: false, celebrated: false }); showToast('Los primeros pasos vuelven a aparecer en Hoy', 'success'); });
  const sync = async () => {
    const has = await hasSampleData();
    if (!$('setSampleLoad')) return;
    $('setSampleLoad').hidden = has; $('setSampleRefresh').hidden = !has; $('setSampleRemove').hidden = !has;
    $('sampleStateDesc').textContent = has ? 'Hay datos de ejemplo cargados. Puedes reiniciarlos con fechas de hoy o quitarlos sin tocar lo tuyo.'
      : 'Datos de muestra de un laboratorio de ecología, con fechas calculadas a partir de hoy. Se pueden quitar sin tocar lo tuyo.';
  };
  $('setSampleLoad')?.addEventListener('click', async e => { e.currentTarget.disabled = true; await loadSampleAndShow(); });
  $('setSampleRefresh')?.addEventListener('click', async () => { await refreshSampleDates(); sync(); });
  $('setSampleRemove')?.addEventListener('click', async () => { await confirmRemoveSample(); sync(); });
  sync();
}

// ==============================================================
//  3) Recorrido guiado
// ==============================================================
const Tour = {
  KEY: 'ros-tour',
  active: false, i: 0, steps: [], token: 0,
  _raf: 0, _poll: 0, _lastKey: '', _taskDone: false, _base: null,

  state() { try { return JSON.parse(localStorage.getItem(Tour.KEY)) || {}; } catch { return {}; } },
  save(p) { try { localStorage.setItem(Tour.KEY, JSON.stringify({ ...Tour.state(), ...p })); } catch {} },

  /** Inicia el recorrido. Sin `restart`, retoma donde se dejó si quedó a medias. */
  async start({ restart = false } = {}) {
    if (Tour.active) return;
    closeInspector?.();
    if (modalOverlay.classList.contains('visible')) closeModal();
    const mobile = matchMedia('(max-width: 600px)').matches;
    Tour.steps = _tourSteps(mobile);
    const st = Tour.state();
    Tour.i = !restart && st.step > 0 && !st.done && st.step < Tour.steps.length ? st.step : 0;
    Tour.active = true; Tour._build();
    document.body.classList.add('tour-on');
    Tour._raf = requestAnimationFrame(Tour._tick);
    Tour.save({ done: false, startedAt: Date.now() });
    await Tour.show(Tour.i, 1);
  },

  end(finished = false) {
    if (!Tour.active) return;
    Tour.active = false; Tour.token++;
    cancelAnimationFrame(Tour._raf); clearInterval(Tour._poll);
    document.getElementById('tourLayer')?.remove();
    document.body.classList.remove('tour-on');
    Tour.save(finished ? { done: true, step: 0 } : { step: Tour.i });
    if (finished) { Onboard.mark('tour'); showToast('¡Recorrido completado! Tus primeros pasos siguen en Hoy', 'success'); }
    else showToast('Recorrido en pausa: lo retomas desde la paleta o el Tutorial', 'info');
    if (typeof closePalette === 'function' && $('paletteOverlay')?.classList.contains('open')) closePalette();
    if (App.view === 'dashboard') renderOnboarding($('onboardHost')).catch(() => {});
  },

  next() { if (Tour.i >= Tour.steps.length - 1) return Tour.end(true); return Tour.show(Tour.i + 1, 1); },
  back() { if (Tour.i > 0) return Tour.show(Tour.i - 1, -1); },

  // ── Construcción del DOM ───────────────────────────────────────────────────────────────
  _build() {
    document.getElementById('tourLayer')?.remove();
    const layer = document.createElement('div');
    layer.id = 'tourLayer'; layer.className = 'tour-layer';
    layer.innerHTML = `
      <div class="tour-dim" data-side="t"></div><div class="tour-dim" data-side="b"></div>
      <div class="tour-dim" data-side="l"></div><div class="tour-dim" data-side="r"></div>
      <div class="tour-ring" hidden></div>
      <div class="tour-card" role="dialog" aria-modal="false" aria-labelledby="tourTitle" tabindex="-1">
        <div class="tour-progress"><span class="tour-count"></span><div class="tour-bar"><i></i></div></div>
        <h3 class="tour-title" id="tourTitle" aria-live="polite"></h3>
        <div class="tour-body"></div>
        <div class="tour-task" hidden></div>
        <div class="tour-choices" hidden></div>
        <div class="tour-actions">
          <button class="btn btn-ghost btn-sm" data-tour="skip">Salir</button>
          <span class="tour-spacer"></span>
          <button class="btn btn-ghost btn-sm" data-tour="back">← Atrás</button>
          <button class="btn btn-primary btn-sm" data-tour="next">Siguiente →</button>
        </div>
      </div>`;
    document.body.appendChild(layer);
    Tour.layer = layer; Tour.card = layer.querySelector('.tour-card'); Tour.ring = layer.querySelector('.tour-ring');
    Tour.dims = Object.fromEntries([...layer.querySelectorAll('.tour-dim')].map(d => [d.dataset.side, d]));
    layer.addEventListener('click', e => {
      const b = e.target.closest('[data-tour]');
      if (b) { if (b.dataset.tour === 'next') Tour.next(); else if (b.dataset.tour === 'back') Tour.back(); else if (b.dataset.tour === 'skip') Tour.end(false); return; }
      const c = e.target.closest('[data-choice]');
      if (c) Tour._choice(+c.dataset.choice);
      const t = e.target.closest('[data-task-fill]');
      if (t) Tour._fillExample();
    });
  },

  // ── Mostrar un paso ────────────────────────────────────────────────────────────────────
  async show(i, dir = 1) {
    const my = ++Tour.token;
    clearInterval(Tour._poll);
    Tour.i = i; Tour._taskDone = false; Tour._lastKey = '';
    if (i < 0) return Tour.show(0, 1);
    const step = Tour.steps[i];
    if (!step) return Tour.end(true);
    if (step.skipIf?.()) return Tour.show(i + dir, dir);                    // condiciones fijas (p. ej. «en el móvil no aplica»)

    Tour.save({ step: i });
    // Mientras se prepara la vista, el cartel espera sin saltar de sitio
    Tour.card.classList.add('is-loading');
    if (step.view && App.view !== step.view) { navigate(step.view); await _waitFor(() => mainContent.dataset.view === step.view, 5000); }
    if (my !== Tour.token) return;
    await step.onEnter?.();
    if (my !== Tour.token) return;
    // Pasos que necesitan algo de la pantalla (una tarea, una tarjeta): se espera a que se pinte y, si no hay, se saltan
    if (step.needs && !(await _waitFor(step.needs, 1500))) { if (my === Tour.token) return Tour.show(i + dir, dir); return; }
    if (my !== Tour.token) return;
    const dyn = step.dynamic ? await step.dynamic() : {};
    if (my !== Tour.token) return;
    Tour._dyn = dyn;

    // Contenido
    const total = Tour.steps.length;
    Tour.card.querySelector('.tour-count').textContent = `Paso ${i + 1} de ${total}`;
    Tour.card.querySelector('.tour-bar i').style.width = `${Math.round((i + 1) / total * 100)}%`;
    Tour.card.querySelector('#tourTitle').textContent = step.title;
    Tour.card.querySelector('.tour-body').innerHTML = (step.body || '') + (dyn.extra || '');
    // Elecciones (p. ej. «con datos de ejemplo» / «vacía»)
    const choices = dyn.choices || [];
    Tour._choices = choices;
    const chBox = Tour.card.querySelector('.tour-choices');
    chBox.hidden = !choices.length;
    chBox.innerHTML = choices.map((c, n) => `<button class="btn ${c.primary ? 'btn-primary' : 'btn-ghost'} btn-sm ${c.danger ? 'btn-danger' : ''}" data-choice="${n}">${esc(c.label)}</button>`).join('');
    // Tarea «Tu turno»
    const task = step.task, taskBox = Tour.card.querySelector('.tour-task');
    taskBox.hidden = !task;
    if (task) {
      Tour._base = await task.base?.();
      taskBox.className = 'tour-task';
      taskBox.innerHTML = `<span class="tour-dot" aria-hidden="true"></span><span class="tour-task-text"><strong>Tu turno:</strong> ${task.text}</span>
        ${task.example ? '<button class="btn btn-ghost btn-sm" data-task-fill>Escribir el ejemplo</button>' : ''}`;
      Tour._poll = setInterval(async () => {
        if (Tour._taskDone || my !== Tour.token) return;
        let ok = false; try { ok = await task.done(Tour._base); } catch {}
        if (ok) Tour._finishTask(my);
      }, 300);
    }
    // Botones
    const next = Tour.card.querySelector('[data-tour="next"]'), back = Tour.card.querySelector('[data-tour="back"]');
    next.hidden = !!choices.length; back.hidden = i === 0 || !!choices.length;
    next.textContent = i === total - 1 ? 'Terminar ✓' : task ? 'Saltar este paso →' : 'Siguiente →';
    next.className = `btn btn-sm ${task ? 'btn-ghost' : 'btn-primary'}`;
    Tour.card.classList.remove('is-loading');

    // Encuadre del elemento (si existe): se espera un momento a que termine de pintarse
    const el = await _waitFor(() => Tour._target(), 2500);
    if (my !== Tour.token) return;
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top < 70 || r.bottom > innerHeight - 70) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    if (!task) Tour.card.focus({ preventScroll: true });
    else if (task.focus) (await _waitFor(() => task.focus(), 1500))?.focus?.();
  },

  _target() {
    const step = Tour.steps[Tour.i]; if (!step) return null;
    const t = step.target;
    const el = typeof t === 'function' ? t() : (t ? document.querySelector(t) : null);
    return el && _visible(el) ? el : null;
  },

  _choice(n) { const c = Tour._choices?.[n]; if (c) Promise.resolve(c.run?.()).catch(err => showToast(err.message, 'error')); },

  _fillExample() {
    const ex = Tour.steps[Tour.i]?.task?.example; const inp = $('captureInput');
    if (!ex || !inp) return;
    inp.value = ex; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  },

  _finishTask(my) {
    Tour._taskDone = true; clearInterval(Tour._poll);
    const box = Tour.card.querySelector('.tour-task');
    box.className = 'tour-task is-done';
    box.innerHTML = `<span class="tour-dot" aria-hidden="true">✓</span><span class="tour-task-text"><strong>¡Muy bien!</strong> ${Tour.steps[Tour.i].task.ok || 'Lo lograste.'}</span>`;
    const next = Tour.card.querySelector('[data-tour="next"]'); next.textContent = 'Siguiente →'; next.className = 'btn btn-sm btn-primary';
    setTimeout(() => { if (Tour.active && my === Tour.token) Tour.next(); }, 1300);
  },

  // ── Foco y colocación (se recalcula solo si algo se movió) ─────────────────────────────
  _tick() {
    if (!Tour.active) return;
    const el = Tour._target();
    const r = el ? el.getBoundingClientRect() : null;
    const key = (r ? `${r.left | 0},${r.top | 0},${r.width | 0},${r.height | 0}` : 'none') + `|${innerWidth}x${innerHeight}|${Tour.card.offsetHeight}`;
    if (key !== Tour._lastKey) { Tour._lastKey = key; Tour._layout(r); }
    Tour._raf = requestAnimationFrame(Tour._tick);
  },

  _layout(r) {
    const vw = innerWidth, vh = innerHeight, set = (el, x, y, w, h) => { el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`; };
    const step = Tour.steps[Tour.i] || {}, pad = step.pad ?? 8, card = Tour.card;
    const mobile = vw <= 600;
    if (!r) {                                                            // sin elemento: pantalla atenuada y cartel al centro
      set(Tour.dims.t, 0, 0, vw, vh); for (const s of ['b', 'l', 'r']) set(Tour.dims[s], 0, 0, 0, 0);
      Tour.ring.hidden = true;
      card.style.cssText = mobile ? 'left:12px;right:12px;bottom:84px;top:auto;width:auto' : `left:${Math.max(12, (vw - Math.min(380, vw - 24)) / 2)}px;top:${Math.max(12, (vh - card.offsetHeight) / 2)}px;width:${Math.min(380, vw - 24)}px`;
      return;
    }
    const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
    const w = Math.min(vw - x, r.width + pad * 2), h = Math.min(vh - y, r.height + pad * 2);
    set(Tour.dims.t, 0, 0, vw, y); set(Tour.dims.b, 0, y + h, vw, Math.max(0, vh - (y + h)));
    set(Tour.dims.l, 0, y, x, h); set(Tour.dims.r, x + w, y, Math.max(0, vw - (x + w)), h);
    Tour.ring.hidden = false; set(Tour.ring, x, y, w, h);

    const ch = card.offsetHeight;
    if (mobile) {                                                        // en el móvil el cartel se ancla arriba o abajo, nunca encima del elemento
      const lower = (y + h / 2) > vh / 2;
      card.style.cssText = lower ? 'left:12px;right:12px;top:12px;bottom:auto;width:auto' : 'left:12px;right:12px;bottom:84px;top:auto;width:auto';
      return;
    }
    const cw = Math.min(380, vw - 24), gap = 16;
    const room = { bottom: vh - (y + h) - gap, top: y - gap, right: vw - (x + w) - gap, left: x - gap };
    const fits = { bottom: room.bottom >= ch, top: room.top >= ch, right: room.right >= cw, left: room.left >= cw };
    const order = [step.placement, 'bottom', 'right', 'top', 'left'].filter(Boolean);
    const side = order.find(s => fits[s]);
    let cx, cy;
    if (side === 'bottom') { cx = x + w / 2 - cw / 2; cy = y + h + gap; }
    else if (side === 'top') { cx = x + w / 2 - cw / 2; cy = y - gap - ch; }
    else if (side === 'right') { cx = x + w + gap; cy = y + h / 2 - ch / 2; }
    else if (side === 'left') { cx = x - gap - cw; cy = y + h / 2 - ch / 2; }
    else { cx = vw - cw - 20; cy = vh - ch - 20; }                      // el elemento ocupa casi toda la pantalla: el cartel va a una esquina
    cx = Math.min(Math.max(12, cx), vw - cw - 12); cy = Math.min(Math.max(12, cy), vh - ch - 12);
    card.style.cssText = `left:${cx}px;top:${cy}px;width:${cw}px`;
  },
};

const _visible = el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; };
async function _waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise(r => setTimeout(r, 90)); }
}

// ── Teclado: ← → navegan; Esc pausa (sin pisar a la paleta, una ventana o un diálogo abiertos) ──
document.addEventListener('keydown', e => {
  if (!Tour.active || e.defaultPrevented) return;
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  const overlay = $('paletteOverlay')?.classList.contains('open') || modalOverlay.classList.contains('visible') || document.querySelector('.confirm-overlay');
  if (e.key === 'Escape' && !overlay) { e.preventDefault(); e.stopImmediatePropagation(); Tour.end(false); }
  else if (!typing && !overlay && e.key === 'ArrowRight') { e.preventDefault(); Tour.next(); }
  else if (!typing && !overlay && e.key === 'ArrowLeft') { e.preventDefault(); Tour.back(); }
}, true);

// ── Definición de los pasos ────────────────────────────────────────────────────────────────
function _tourSteps(mobile) {
  const cards = () => document.querySelector('.kanban-card');
  const counts = async () => ({ t: await db.tasks.count(), i: await db.ideas.count(), p: await db.projects.count(), m: await db.meetings.count(), d: await db.tasks.filter(t => t.done).count() });
  const inspectorOpen = () => !document.body.classList.contains('inspector-closed');
  return [
    { id: 'welcome', view: 'dashboard', title: 'Bienvenido/a a ResearchOS',
      body: `<p>En unos 3 minutos verás lo esencial y harás un par de pruebas tú mismo/a. Puedes salir cuando quieras y retomar después.</p>
             <p class="tour-note">🔒 Tus datos viven solo en este navegador: no salen a ninguna parte.</p>`,
      dynamic: async () => {
        const empty = await _appIsEmpty(), sample = await hasSampleData();
        if (empty) return { extra: '<p>Tu app está vacía. ¿Quieres practicar con un laboratorio de ejemplo? Sus fechas son de hoy y se quita con un clic.</p>',
          choices: [{ label: 'Practicar con datos de ejemplo', primary: true, run: async () => { await loadSampleData(); await Tour.next(); } },
                    { label: 'Empezar con la app vacía', run: () => Tour.next() }] };
        return { extra: sample ? '<p>Estás con datos de ejemplo: toca todo sin miedo. Al final podrás quitarlos.</p>'
                               : '<p>El recorrido usa tus datos reales y solo cambia algo en los pasos marcados <strong>Tu turno</strong>.</p>' };
      } },

    { id: 'hoy', view: 'dashboard', title: 'Hoy: tu punto de partida',
      target: () => document.querySelector('#todayRoot .today-main') || document.querySelector('#todayRoot .first-run') || document.querySelector('#todayRoot'),
      body: `<p>Aquí ves lo <strong>atrasado</strong>, lo de <strong>hoy</strong> y lo que viene esta semana, más lo que esperas de otras personas y los proyectos sin próximo paso.</p>
             <p>Se arma solo con tus tareas, reuniones y fechas límite: no tienes que ordenarlo.</p>` },

    { id: 'captura', view: 'dashboard', title: 'Captura sin pensar dónde va', target: '#captureForm', placement: 'bottom',
      body: `<p>Escribe como hablarías. Entiende fechas (<code>mañana</code>, <code>viernes</code>), proyectos (<code>@alfa</code>), personas (<code>&gt;ana</code>) y prioridad (<code>!alta</code>). Debajo ves cómo la interpreta.</p>`,
      task: { text: 'escribe una tarea y pulsa Enter.', example: 'revisar el manuscrito mañana !alta', ok: 'Ya está en tu lista.',
              focus: () => $('captureInput'), base: counts, done: async b => { const c = await counts(); return c.t > b.t || c.i > b.i || c.p > b.p || c.m > b.m; } } },

    { id: 'completar', view: 'dashboard', title: 'Completa tareas con un clic', target: () => document.querySelector('#todayRoot .tw-check'),
      needs: () => document.querySelector('#todayRoot .tw-check'),
      body: `<p>El círculo marca la tarea como hecha. Si te equivocas, aparece <strong>Deshacer</strong> (y <kbd>${MOD_KEY} Z</kbd> también sirve). Las tareas que se repiten nacen de nuevo solas.</p>`,
      task: { text: 'completa cualquier tarea.', ok: 'Un pendiente menos.', base: counts, done: async b => (await counts()).d > b.d } },

    { id: 'plan', view: 'dashboard', title: 'Planifica el día y la semana', target: '#todayRoot .today-actions',
      body: `<p><strong>☀ Planificar mi día</strong> te deja elegir qué harás según el tiempo disponible y lo que estimaste para cada tarea (<code>~2h</code>).</p>
             <p><strong>🗓 Revisión semanal</strong> son diez minutos guiados: ideas, atrasos, proyectos quietos y copia de seguridad.</p>` },

    { id: 'menu', view: 'dashboard', title: 'Tu menú', target: mobile ? '#mobileBar' : '.sidebar-nav', placement: 'right',
      body: mobile ? `<p>La barra de abajo lleva a <strong>Hoy</strong>, <strong>Proyectos</strong> e <strong>Ideas</strong>, y el botón <strong>＋</strong> captura desde cualquier pantalla. <strong>Más</strong> abre el resto del menú.</p>`
                   : `<p><strong>Hoy, Proyectos, Ideas, Calendario y Red</strong> están siempre a la vista. <strong>Biblioteca</strong>, <strong>Personas</strong> y <strong>Más</strong> agrupan el resto; los puntos de color avisan si hay algo dentro.</p>` },

    { id: 'areas', view: 'dashboard', title: 'Áreas: una cosa a la vez', target: '#contextSwitcher', skipIf: () => mobile, placement: 'right',
      body: `<p>Las áreas son tus frentes: <strong>Investigación, Docencia, Gestión…</strong> Con un área activa, Hoy y el tablero muestran solo ese frente.</p>`,
      dynamic: async () => {
        const has = (await _getAreas()).length > 0;
        return has ? { extra: '<p>Elige una en el selector; vuelve a <strong>Todo</strong> para ver todo.</p>' }
                   : { extra: '<p>Aún no tienes áreas. Puedes crear las sugeridas con un clic.</p>',
                       choices: [{ label: 'Crear áreas sugeridas', primary: true, run: async () => { await seedSuggestedAreas(); showToast('Áreas creadas ✓', 'success'); await Tour.next(); } },
                                 { label: 'Más tarde', run: () => Tour.next() }] };
      } },

    { id: 'tablero', view: 'kanban', title: 'Proyectos en un tablero', target: '.kanban-board', placement: 'bottom',
      body: `<p>Cada tarjeta es un proyecto y cada columna una etapa. <strong>Arrástralas</strong> para cambiar su estado: el historial queda anotado.</p>`,
      onEnter: () => closeInspector() },

    { id: 'abrir', view: 'kanban', title: 'Abre un proyecto', target: cards, needs: cards,
      body: `<p>Cada tarjeta guarda mucho más de lo que muestra.</p>`,
      task: { text: 'haz clic en una tarjeta.', ok: 'Esta es su ficha.', done: async () => inspectorOpen() } },

    { id: 'ficha', view: 'kanban', title: 'La ficha del proyecto', target: '#inspectorPanel',
      needs: () => cards() || inspectorOpen(),
      onEnter: async () => { if (!inspectorOpen()) { const id = +cards()?.dataset.projectId; if (id) await inspectProject(id); } },
      body: `<p>Aquí está todo: tareas, ideas, reuniones y referencias del proyecto. <strong>Haz clic en cualquier dato</strong> (título, prioridad, fecha…) para editarlo al instante.</p>
             <p><kbd>Esc</kbd> cierra la ficha.</p>` },

    { id: 'pestanas', view: 'kanban', title: 'Varias formas de ver tus proyectos', target: '.proj-tabs', placement: 'bottom',
      onEnter: () => closeInspector(),
      body: `<p><strong>Tablero</strong> para el flujo, <strong>Lista</strong> para filtrar y guardar vistas, <strong>Línea de tiempo</strong> para los plazos, <strong>Jerarquía</strong> para proyectos «paraguas» con subproyectos y <strong>Submissions</strong> para seguir tus papers desde el borrador hasta la revista.</p>` },

    { id: 'ideas', view: 'ideas', title: 'Ideas: anótalas y decide después', placement: 'bottom',
      target: () => document.querySelector('#ideaTitleInput')?.closest('.inbox-card, .inbox, .card') || $('ideaTitleInput'),
      body: `<p>Apunta lo que se te ocurra sin pensar en dónde va. Luego la <strong>Revisión rápida</strong> (con teclado) las procesa, y una idea se vuelve <strong>tarea</strong> o <strong>proyecto</strong> con un clic.</p>
             <p>Escribe <code>[[</code> en cualquier nota para enlazar con otro elemento.</p>` },

    { id: 'red', view: 'network', title: 'La Red: tu mapa de conexiones', target: '#netCanvas', placement: 'bottom',
      body: `<p>Cada punto es un proyecto, idea, persona o referencia; las líneas son sus vínculos y los enlaces <code>[[Título]]</code> que escribas. Haz clic en un punto para abrirlo.</p>` },

    { id: 'buscar', view: 'dashboard', title: 'Encuentra cualquier cosa',
      target: () => ($('paletteOverlay')?.classList.contains('open') ? $('paletteInput') : null),
      body: `<p>La paleta busca en proyectos, ideas, tareas, personas, referencias y hasta en el código de tus snippets, y ejecuta acciones («nuevo proyecto», «cambiar de tema»).</p>`,
      onEnter: () => { if ($('paletteOverlay')?.classList.contains('open')) closePalette(); },
      task: { text: `pulsa <kbd>${MOD_KEY} K</kbd>.`, ok: 'Escribe lo que quieras buscar; Esc la cierra.', base: async () => 0,
              done: async () => $('paletteOverlay')?.classList.contains('open') } },

    { id: 'copia', view: 'settings', title: 'Haz copias de seguridad', target: '#exportJsonBtn', placement: 'bottom',
      onEnter: () => { if ($('paletteOverlay')?.classList.contains('open')) closePalette(); },
      body: `<p>Todo vive en este navegador, así que <strong>exporta una copia</strong> de vez en cuando (puedes cifrarla con contraseña). En esta pantalla también activas la copia automática a una carpeta.</p>` },

    { id: 'fin', view: 'dashboard', title: '¡Listo, ya conoces lo esencial!',
      body: `<p>En <strong>Hoy</strong> tienes una lista de <strong>Primeros pasos</strong> que se va marcando sola. Repite este recorrido cuando quieras desde la paleta (<kbd>${MOD_KEY} K</kbd>) o el Tutorial, y mira todos los atajos con <kbd>?</kbd>.</p>`,
      dynamic: async () => (await hasSampleData())
        ? { extra: '<p>Todavía tienes los datos de ejemplo. ¿Los dejas para seguir explorando o los quitas para empezar con lo tuyo?</p>',
            choices: [{ label: 'Quitar el ejemplo y empezar', primary: true, run: async () => { await removeSampleData(); Tour.end(true); } },
                      { label: 'Dejarlos por ahora', run: () => Tour.end(true) }] }
        : {} },
  ];
}
