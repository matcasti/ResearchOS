// ============================================================
//  ResearchOS — Integraciones: copia automática a una carpeta, calendario .ics,
//  captura compartida (PWA) y panel de Ajustes ampliado.
//  Se carga después de today.js y usa los globales de app.js / db.js.
// ============================================================

'use strict';

// ==============================================================
//  COPIA AUTOMÁTICA A UNA CARPETA  (File System Access API)
//  Los datos viven en el navegador: esto los duplica, sin servidores, en una carpeta que tú eliges
//  (por ejemplo la de Dropbox, Drive o Syncthing) cada vez que cambias algo.
// ==============================================================
const AutoBackup = {
  HANDLE_KEY: 'backup-dir-handle',
  KEEP_DAILY: 14,
  _timer: null,
  _dirty: false,

  supported: () => typeof window.showDirectoryPicker === 'function',
  enabled:   () => localStorage.getItem('ros-autobackup') === '1',
  lastRun:   () => +localStorage.getItem('ros-autobackup-last') || null,

  async handle() { return (await db.settings.get(this.HANDLE_KEY))?.value || null; },

  async permission(handle, { ask = false } = {}) {
    const opts = { mode: 'readwrite' };
    let p = await handle.queryPermission?.(opts);
    if (p !== 'granted' && ask) p = await handle.requestPermission?.(opts);
    return p || 'denied';
  },

  async choose() {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'researchos-backup' });
    await db.settings.put({ key: this.HANDLE_KEY, value: handle });
    localStorage.setItem('ros-autobackup', '1');
    this.paused = false;
    await this.run();
    return handle;
  },

  async disable() {
    await db.settings.delete(this.HANDLE_KEY);
    localStorage.removeItem('ros-autobackup');
    localStorage.removeItem('ros-autobackup-last');
    this.paused = false;
  },

  /** Escribe researchos-backup-latest.json y una copia fechada por día (se conservan las últimas 14). */
  async run({ ask = false } = {}) {
    if (!this.enabled()) return false;
    const handle = await this.handle();
    if (!handle) return false;
    if ((await this.permission(handle, { ask })) !== 'granted') { this.paused = true; return false; }
    this.paused = false;
    const json = await exportAllData();
    const write = async (name, data) => {
      const fh = await handle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(data); await w.close();
    };
    await write('researchos-backup-latest.json', json);
    const today = `researchos-backup-${localDateISO()}.json`;
    await write(today, json);
    // rotación: borra las copias diarias más antiguas
    const dated = [];
    for await (const [name] of handle.entries?.() ?? []) if (/^researchos-backup-\d{4}-\d{2}-\d{2}\.json$/.test(name)) dated.push(name);
    dated.sort();
    for (const old of dated.slice(0, Math.max(0, dated.length - this.KEEP_DAILY))) await handle.removeEntry(old).catch(() => {});
    localStorage.setItem('ros-autobackup-last', String(Date.now()));
    this._dirty = false;
    return true;
  },

  /** Llamado en cada escritura: programa una copia 90 s después del último cambio. */
  schedule() {
    if (!this.enabled()) return;
    this._dirty = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.run().catch(() => {}), 90_000);
  },
};
window.AutoBackup = AutoBackup;
SyncState.listeners.push(() => AutoBackup.schedule());          // cualquier cambio local, pase o no por dbWrite

// al cerrar o ocultar la pestaña, guarda lo pendiente
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && AutoBackup._dirty) AutoBackup.run().catch(() => {});
});

// «Último backup» = el más reciente entre exportar a mano y la copia automática
(() => {
  const manual = BackupMeta.last.bind(BackupMeta);
  BackupMeta.last = () => Math.max(manual() || 0, AutoBackup.lastRun() || 0) || null;
})();

/** Al abrir la app: si la copia automática estaba activa, la ejecuta (o avisa de que necesita permiso). */
async function initAutoBackup() {
  if (!AutoBackup.enabled() || !AutoBackup.supported()) return;
  try {
    const handle = await AutoBackup.handle();
    if (!handle) return;
    if ((await AutoBackup.permission(handle)) === 'granted') {
      if (!AutoBackup.lastRun() || Date.now() - AutoBackup.lastRun() > 3600_000) AutoBackup.run().catch(() => {});
    } else AutoBackup.paused = true;
  } catch { /* la carpeta ya no existe o el navegador no la reconoce */ }
}

// ==============================================================
//  CAPTURA COMPARTIDA (PWA): «Compartir → ResearchOS» desde el móvil crea una idea
// ==============================================================
async function handleSharedCapture() {
  const q = new URLSearchParams(location.search);
  const title = (q.get('title') || '').trim(), text = (q.get('text') || '').trim(), url = (q.get('url') || '').trim();
  const focus = q.get('capture') === '1';
  if (!title && !text && !url && !focus) return;
  history.replaceState(null, '', location.pathname);               // limpia la URL para no duplicar al recargar
  if (title || text || url) {
    const body = [text, url].filter(Boolean).join('\n\n');
    const first = title || text.split('\n')[0] || url;
    const now = new Date().toISOString();
    await dbWrite(() => db.ideas.add({ title: first.slice(0, 160), content: body === first ? '' : body, status: 'unread', projectId: null,
      projectIds: [], deadline: null, tags: ['compartido'], subtasks: [], createdAt: now, updatedAt: now }));
    showToast('Guardado en tu bandeja de ideas ✓', 'success');
    updateBadges();
  }
  if (focus) setTimeout(() => focusCapture(), 400);
}

// ==============================================================
//  AJUSTES: copia automática · calendario · uso · avanzado plegado
// ==============================================================
function _fmtAgo(ts) {
  if (!ts) return 'nunca';
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'hace un momento' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`;
}

async function enhanceSettings() {
  const view = mainContent.querySelector('.view');
  const anchor = [...mainContent.querySelectorAll('.settings-section')].find(s => s.textContent.includes('Importar backup'));
  if (!view || !anchor) return;

  // -- 1) Copia automática + calendario ---------------------------------
  const handle = AutoBackup.supported() && AutoBackup.enabled() ? await AutoBackup.handle().catch(() => null) : null;
  const perm = handle ? await AutoBackup.permission(handle).catch(() => 'denied') : null;
  const sections = document.createElement('div');
  sections.innerHTML = `
    <div class="settings-section" id="autoBackupSection">
      <div class="settings-section-title">🗄 Copia automática a una carpeta</div>
      <div class="settings-body">
        ${!AutoBackup.supported() ? `<div class="settings-row-desc">Tu navegador no permite elegir carpetas (hace falta Chrome, Edge u otro basado en Chromium). Usa «Exportar» con regularidad.</div>` : `
        <div class="settings-row">
          <div>
            <div class="settings-row-label">${handle ? `Activa → <code>${esc(handle.name)}</code>` : 'Desactivada'}</div>
            <div class="settings-row-desc" id="autoBackupDesc">
              ${handle ? (perm === 'granted' ? `Última copia: ${_fmtAgo(AutoBackup.lastRun())}. Se actualiza unos segundos después de cada cambio y se conservan las últimas ${AutoBackup.KEEP_DAILY} copias diarias.`
                                                : '⚠ En pausa: el navegador pide permiso de nuevo para escribir en la carpeta.')
                       : 'Guarda una copia de tus datos en una carpeta que elijas (p. ej. la de Dropbox, Drive o Syncthing) cada vez que cambias algo. Sin servidores.'}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${handle && perm !== 'granted' ? `<button class="btn btn-primary btn-sm" id="autoBackupResume">Reactivar</button>` : ''}
            ${handle ? `<button class="btn btn-ghost btn-sm" id="autoBackupNow">Copiar ahora</button><button class="btn btn-ghost btn-sm" id="autoBackupOff">Desactivar</button>`
                     : `<button class="btn btn-primary btn-sm" id="autoBackupOn">Elegir carpeta…</button>`}
          </div>
        </div>`}
      </div>
    </div>

    <div class="settings-section" id="syncSection"></div>

    <div class="settings-section" id="assistantSection"></div>

    ${plannerSettingsHTML()}

    ${academicSettingsHTML()}

    ${vaultSettingsHTML()}

    ${sampleSettingsHTML()}

    ${diagnosticsSettingsHTML()}

    <div class="settings-section" id="calendarSection">
      <div class="settings-section-title">📅 Calendario (.ics)</div>
      <div class="settings-body">
        <div class="settings-row">
          <div>
            <div class="settings-row-label">Exportar a tu calendario</div>
            <div class="settings-row-desc">Fechas límite, tareas con fecha (con su repetición) y reuniones, para abrir en Google Calendar, Apple Calendar u Outlook.</div>
          </div>
          <button class="btn btn-primary btn-sm" id="icsExportBtn">Exportar .ics</button>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-row-label">Importar eventos (horario de clases, comités…)</div>
            <div class="settings-row-desc">Lee un .ics y crea reuniones para los próximos 90 días (las repeticiones semanales se expanden).</div>
          </div>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer">Importar .ics
            <input type="file" id="icsImportInput" accept=".ics,text/calendar" hidden></label>
        </div>
      </div>
    </div>`;
  if (!anchor.isConnected || mainContent.querySelector('#autoBackupSection')) return;     // otra llamada ya montó las secciones en esta vista (un repintado a mitad de camino las duplicaba)
  anchor.after(...sections.children);
  await renderSyncSection();                  // sync.js
  await renderAssistantSection();             // assistant.js
  wirePlannerSettings();                      // planner.js
  wireAcademicSettings();                     // academic.js
  wireVaultSettings();                        // vault.js
  wireSampleSettings();                       // tour.js
  wireDiagnostics();

  $('autoBackupOn')?.addEventListener('click', async () => {
    try { await AutoBackup.choose(); showToast('Copia automática activada ✓', 'success'); renderSettings(); }
    catch (e) { if (e?.name !== 'AbortError') showToast('No se pudo activar: ' + e.message, 'error'); }
  });
  $('autoBackupOff')?.addEventListener('click', async () => { await AutoBackup.disable(); showToast('Copia automática desactivada', 'info'); renderSettings(); });
  $('autoBackupNow')?.addEventListener('click', async () => {
    try { (await AutoBackup.run({ ask: true })) ? showToast('Copia guardada ✓', 'success') : showToast('No se pudo escribir en la carpeta', 'error'); }
    catch (e) { showToast('Error: ' + e.message, 'error'); }
    renderSettings();
  });
  $('autoBackupResume')?.addEventListener('click', async () => {
    try { (await AutoBackup.run({ ask: true })) ? showToast('Copia automática reactivada ✓', 'success') : showToast('Permiso denegado', 'error'); } catch (e) { showToast(e.message, 'error'); }
    renderSettings();
  });

  $('icsExportBtn').addEventListener('click', async () => {
    downloadFile(`researchos-${localDateISO()}.ics`, await buildICS(), 'text/calendar;charset=utf-8');
    showToast('Calendario exportado ✓', 'success');
  });
  $('icsImportInput').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const events = parseICS(await file.text());
    if (!events.length) return showToast('No hay eventos en los próximos 90 días en ese archivo', 'info');
    const have = new Set((await db.meetings.toArray()).map(m => `${m.date}|${foldText(m.title)}`));
    const fresh = events.filter(ev => !have.has(`${ev.date}|${foldText(ev.title)}`));
    showModal('📅 Importar eventos', `
      <div class="modal-body">
        <p style="font-size:.85rem;color:var(--text-2)">${events.length} evento(s) en los próximos 90 días; <strong style="color:var(--text-1)">${fresh.length}</strong> nuevos
          ${events.length - fresh.length ? `(${events.length - fresh.length} ya estaban)` : ''}. Se crearán como reuniones.</p>
        <div class="import-preview">${fresh.slice(0, 8).map(ev => `<div>${esc(formatDate(ev.date))} — ${esc(ev.title)}</div>`).join('')}${fresh.length > 8 ? `<div>…y ${fresh.length - 8} más</div>` : ''}</div>
      </div>
      <div class="modal-footer"><button class="btn btn-ghost" id="icsCancel">Cancelar</button>
        <button class="btn btn-primary" id="icsOk" ${fresh.length ? '' : 'disabled'}>Importar ${fresh.length}</button></div>`);
    $('icsCancel').addEventListener('click', closeModal);
    $('icsOk').addEventListener('click', async () => {
      const now = new Date().toISOString();
      await dbWrite(() => db.meetings.bulkAdd(fresh.map(ev => ({ title: ev.title, date: ev.date, participants: '', projectId: null, agreements: '', actionItems: [], createdAt: now, updatedAt: now }))));
      closeModal(); showToast(`${fresh.length} evento(s) importado(s) ✓`, 'success'); renderSettings();
    });
  });

  // -- 2) Uso de las vistas (solo local) --------------------------------
  const u = Usage.read(); const since = u._since; delete u._since;
  const names = { dashboard: 'Hoy', kanban: 'Tablero', projects: 'Lista de proyectos', timeline: 'Línea de tiempo', nested: 'Jerarquía', ideas: 'Ideas', weekly: 'Calendario',
    snippets: 'Snippets', references: 'Referencias', starred: 'Favoritos', meetings: 'Reuniones', collaborators: 'Colaboradores', review: 'Revisión semanal',
    submissions: 'Submissions', areas: 'Áreas', archived: 'Archivados', filesystem: 'FS Bridge', tutorial: 'Tutorial', settings: 'Ajustes', orphans: 'Huérfanos',
    triage: 'Revisión rápida de ideas', network: 'Red', report: 'Informe de avance', 'project-hub': 'Hub de proyecto', 'collaborator-hub': 'Perfil de colaborador', focus: 'Hoy' };
  const rows = Object.entries(u).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 1;
  const usage = document.createElement('div');
  usage.className = 'settings-section';
  usage.id = 'usageSection';
  usage.innerHTML = `
    <div class="settings-section-title">📈 Qué vistas usas</div>
    <div class="settings-body">
      <div class="settings-row-desc" style="margin-bottom:8px">Solo se cuenta en este navegador (nada se envía). Sirve para decidir qué merece estar a mano${since ? ` · desde ${esc(formatDate(since))}` : ''}.</div>
      ${rows.length ? rows.map(([v, n]) => `
        <div class="usage-row"><span class="usage-name">${esc(names[v] || v)}</span>
          <span class="usage-bar"><span style="width:${Math.max(3, Math.round(n / max * 100))}%"></span></span><span class="usage-n">${n}</span></div>`).join('')
        : `<div class="settings-row-desc">Aún sin datos: navega un poco y vuelve.</div>`}
      ${rows.length ? `<button class="btn btn-ghost btn-sm" id="usageReset" style="margin-top:8px">Reiniciar contadores</button>` : ''}
    </div>`;
  document.getElementById('calendarSection').after(usage);
  $('usageReset')?.addEventListener('click', () => { Usage.reset(); renderSettings(); });

  // -- 3) Lo avanzado, plegado -------------------------------------------
  const adv = document.createElement('details');
  adv.className = 'settings-advanced';
  adv.id = 'settingsAdvanced';
  adv.innerHTML = `<summary>Avanzado · campos personalizados, Google Drive y sincronización de papers</summary>`;
  const advanced = [mainContent.querySelector('#cfSettingsSection'), mainContent.querySelector('#paperSyncSection'),
    mainContent.querySelector('#googleSyncSection')?.closest('.settings-section')].filter(Boolean);
  const danger = mainContent.querySelector('.settings-danger-zone');
  if (advanced.length && danger) { danger.before(adv); advanced.forEach(sec => adv.appendChild(sec)); }
}

// ==============================================================
//  PWA: el manifiesto se enlaza desde index.html; aquí, el aviso de instalación
// ==============================================================
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  App._installPrompt = e;
});


// ==============================================================
//  DIAGNÓSTICO (Ajustes): errores inesperados y estado del navegador, solo en este equipo
// ==============================================================
function diagnosticsSettingsHTML() {
  return `
    <div class="settings-section" id="diagSection">
      <div class="settings-section-title">🩺 Diagnóstico</div>
      <div class="settings-body">
        <div class="settings-row">
          <div><div class="settings-row-label">Errores inesperados <span id="diagCount" class="form-hint"></span></div>
            <div class="settings-row-desc">Si algo no funciona, aquí queda el detalle. Se guarda solo en este navegador; no se envía a ninguna parte.</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" id="diagCopy">Copiar informe</button>
            <button class="btn btn-ghost btn-sm" id="diagClear">Borrar registro</button>
          </div>
        </div>
        <pre class="diag-list" id="diagList" tabindex="0" aria-label="Registro de errores"></pre>
      </div>
    </div>`;
}

async function _diagnosticReport() {
  const counts = await Promise.all(['projects', 'ideas', 'tasks', 'meetings', 'references', 'snippets', 'collaborators'].map(async t => `${t}: ${await db[t].count()}`));
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const errs = ErrorLog.all();
  return [`ResearchOS · informe de diagnóstico · ${new Date().toISOString()}`, `Navegador: ${navigator.userAgent}`,
    `Pantalla: ${innerWidth}×${innerHeight} · vista: ${App.view} · idioma: ${navigator.language}`,
    `Almacenamiento: ${persisted ? 'persistente' : 'no persistente'}${est ? ` · ${(est.usage / 1048576).toFixed(1)} MB usados` : ''}`,
    `Datos: ${counts.join(' · ')}`, '', errs.length ? 'Errores:' : 'Sin errores registrados.',
    ...errs.map(e => `- ${e.t} [${e.kind}${e.view ? ' · ' + e.view : ''}] ${e.msg}${e.stack ? '\n    ' + e.stack : ''}`)].join('\n');
}

function wireDiagnostics() {
  const paint = () => {
    const errs = ErrorLog.all();
    if ($('diagCount')) $('diagCount').textContent = errs.length ? `(${errs.length})` : '(ninguno)';
    if ($('diagList')) $('diagList').textContent = errs.length ? errs.slice().reverse().map(e => `${new Date(e.t).toLocaleString('es-CL')} · ${e.kind}${e.view ? ' · ' + e.view : ''}\n${e.msg}`).join('\n\n') : 'Todo en orden: no hay errores registrados.';
  };
  paint();
  $('diagCopy')?.addEventListener('click', async () => {
    const text = await _diagnosticReport();
    if (!(await copyText(text, 'Informe copiado ✓'))) downloadFile('researchos-diagnostico.txt', text, 'text/plain');
  });
  $('diagClear')?.addEventListener('click', () => { ErrorLog.clear(); paint(); showToast('Registro borrado', 'success'); });
}
