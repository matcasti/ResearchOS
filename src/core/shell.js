// ============================================================
//  ResearchOS — Pie de la aplicación: barra móvil, captura rápida y primeros pasos
//
//  · Barra inferior (solo en pantallas estrechas) con las vistas principales y un botón «＋» para capturar
//    desde cualquier lugar sin cambiar de vista.
//  · Panel de primeros pasos cuando la app está vacía: áreas, captura y traer lo que ya tienes.
// ============================================================

'use strict';

// ==============================================================
//  1) CAPTURA RÁPIDA (modal)
// ==============================================================
async function openQuickCapture() {
  const [projects, people] = await Promise.all([db.projects.toArray(), db.collaborators.toArray()]);
  showModal('✎ Captura rápida', `
    <div class="modal-body">
      <input class="form-input capture-input" id="qcInput" maxlength="300" autocomplete="off" enterkeyhint="send" aria-label="Captura rápida"
             placeholder="«llamar a Ana mañana ~15m» · «idea: …» · «@proyecto»">
      <div class="capture-preview" id="qcPreview" aria-live="polite" style="margin-top:8px"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-ghost" id="qcCancel">Cancelar</button><button class="btn btn-primary" id="qcSave">Guardar</button></div>`);
  const input = $('qcInput'), preview = $('qcPreview');
  const parsed = () => parseCapture(input.value, projects, new Date(), people);
  input.addEventListener('input', () => { const c = parsed(); preview.innerHTML = c.title ? `<span class="capture-arrow">→</span> ${describeCapture(c)}` : ''; });
  let saving = false;                           // Enter mantenido pulsado o doble clic: se guarda una sola vez
  const save = async () => {
    if (saving) return;
    saving = true;
    const c = parsed();
    try {
      const msg = await runCapture(c);
      closeModal(); showToast(msg + ' ✓', 'success'); updateBadges();
      if (App.view === 'dashboard') renderToday();
    } catch (err) { saving = false; showToast(err.message, 'error'); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  $('qcSave').addEventListener('click', save);
  $('qcCancel').addEventListener('click', closeModal);
  focusField(input);
}

// ==============================================================
//  2) BARRA INFERIOR MÓVIL
// ==============================================================
const MOBILE_TABS = [
  { view: 'dashboard', views: ['dashboard', 'focus'], icon: uiIcon('today', 21), label: 'Hoy' },
  { view: 'kanban', views: ['kanban', 'projects', 'timeline', 'nested', 'project-hub'], icon: uiIcon('projects', 21), label: 'Proyectos' },
  { capture: true, icon: uiIcon('plus', 24), label: 'Capturar' },
  { view: 'ideas', views: ['ideas', 'triage'], icon: uiIcon('ideas', 21), label: 'Ideas' },
  { more: true, icon: uiIcon('menu', 21), label: 'Más' },
];

function initMobileBar() {
  if (document.getElementById('mobileBar')) return;
  const bar = document.createElement('nav');
  bar.id = 'mobileBar'; bar.className = 'mobile-bar'; bar.setAttribute('aria-label', 'Navegación principal');
  bar.innerHTML = MOBILE_TABS.map(t => `<button class="mb-tab ${t.capture ? 'mb-capture' : ''}" ${t.view ? `data-mb-view="${t.view}"` : ''} ${t.capture ? 'data-mb-capture' : ''} ${t.more ? 'data-mb-more' : ''}
      aria-label="${t.label}"><span class="mb-icon" aria-hidden="true">${t.icon}</span><span class="mb-label">${t.label}</span></button>`).join('');
  document.body.appendChild(bar);
  bar.addEventListener('click', e => {
    const b = e.target.closest('.mb-tab'); if (!b) return;
    closeMobileMenu?.();
    if (b.dataset.mbView) {
      const t = MOBILE_TABS.find(x => x.view === b.dataset.mbView);
      const remembered = t.view === 'kanban' ? (() => { try { return localStorage.getItem('ros-proj-tab'); } catch { return null; } })() : null;
      navigate(remembered && PROJECT_TABS.some(p => p.view === remembered) ? remembered : t.view);
    } else if (b.hasAttribute('data-mb-capture')) openQuickCapture();
    else if (b.hasAttribute('data-mb-more')) $('mobileMenuBtn')?.click();
  });
  const mark = () => bar.querySelectorAll('[data-mb-view]').forEach(b => {
    const t = MOBILE_TABS.find(x => x.view === b.dataset.mbView);
    b.classList.toggle('active', t.views.includes(App.view));
  });
  new MutationObserver(mark).observe(mainContent, { attributes: true, attributeFilter: ['data-view'] });
  mark();
}
window.addEventListener('load', () => setTimeout(initMobileBar, 0));

// ==============================================================
//  3) PRIMEROS PASOS (Hoy vacío)
// ==============================================================
function firstRunHTML() {
  return `
    <div class="empty-state today-welcome first-run">
      <span class="empty-state-icon">⬡</span>
      <h3>Empieza escribiendo algo arriba… o trae lo que ya tienes</h3>
      <p>Todo lo que captures aparece aquí cuando toque. Si es tu primera vez, lo más fácil:</p>
      <div class="fr-hero">
        <button class="btn btn-primary" id="frTour">▶ Recorrido guiado (3 min)</button>
        <button class="btn btn-ghost" id="frDemo">🧪 Explorar con datos de ejemplo</button>
      </div>
      <p class="fr-or">…o para no partir de cero:</p>
      <ol class="fr-steps">
        <li><div><strong>Tus áreas</strong><span>Investigación, Docencia, Gestión y Personal: te dejan ver una cosa a la vez.</span></div>
          <button class="btn btn-ghost btn-sm" id="frAreas">Crear áreas sugeridas</button></li>
        <li><div><strong>Tus referencias</strong><span>Un .bib o .ris de Zotero, Mendeley o EndNote.</span></div>
          <button class="btn btn-ghost btn-sm" id="frBibBtn">Importar .bib / .ris</button></li>
        <li><div><strong>Tus tareas</strong><span>Un CSV de Todoist, Notion o Excel.</span></div>
          <button class="btn btn-ghost btn-sm" id="frCsvBtn">Importar CSV</button></li>
        <li><div><strong>Un backup anterior</strong><span>Un archivo de ResearchOS (también los cifrados).</span></div>
          <button class="btn btn-ghost btn-sm" id="frBackupBtn">Abrir backup</button></li>
      </ol>
      <input type="file" id="frBib" accept=".bib,.ris,.txt,text/plain" multiple hidden>
      <input type="file" id="frCsv" accept=".csv,.tsv,text/csv,text/plain" hidden>
      <input type="file" id="frBackup" accept=".json,application/json" hidden>
    </div>`;
}

function wireFirstRun() {
  $('frAreas')?.addEventListener('click', async () => { await seedSuggestedAreas(); showToast('Áreas creadas ✓ — elige una arriba a la izquierda', 'success'); $('frAreas').disabled = true; $('frAreas').textContent = '✓ Creadas'; });
  $('frBibBtn')?.addEventListener('click', () => $('frBib').click());
  $('frCsvBtn')?.addEventListener('click', () => $('frCsv').click());
  $('frBackupBtn')?.addEventListener('click', () => $('frBackup').click());
  $('frBib')?.addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) startReferenceImport(f); });
  $('frCsv')?.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) startTaskCsvImport(f); });
  $('frBackup')?.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) startBackupImport(f); });
  $('frTour')?.addEventListener('click', () => Tour.start({ restart: true }));
  $('frDemo')?.addEventListener('click', async () => {
    const btn = $('frDemo'); btn.disabled = true; btn.textContent = '⏳ Cargando…';
    try { await loadSampleAndShow(); }
    catch (err) { btn.disabled = false; btn.textContent = '🧪 Explorar con datos de ejemplo'; showToast('No se pudo cargar el ejemplo: ' + err.message, 'error'); }
  });
}
