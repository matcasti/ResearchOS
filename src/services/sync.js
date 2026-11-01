// ============================================================
//  ResearchOS — Sincronización entre dispositivos (sin servidor)
//
//  Cada dispositivo escribe SU PROPIO archivo `researchos-sync-<dispositivo>.json` en una carpeta
//  compartida (Dropbox, Drive, Syncthing, OneDrive…) y lee los de los demás. Como nadie escribe el
//  archivo de otro, el servicio de la nube nunca genera conflictos de archivo.
//
//  Reglas de fusión (por registro, identificado por `uid`):
//   · existe solo en un lado           → se copia;
//   · existe en ambos                  → gana el cambio más reciente (`updatedAt`);
//   · borrado en un lado (lápida)      → se borra en el otro, salvo que se editara DESPUÉS del borrado.
//  Las referencias entre registros viajan como uid y se traducen a los ids locales de cada navegador.
// ============================================================

'use strict';

const SYNC_FK = {
  projects:    { columnId: 'kanbanColumns', parentId: 'projects', responsibleId: 'collaborators', coauthorIds: ['collaborators'], areaId: '@areas' },
  ideas:       { projectId: 'projects', projectIds: ['projects'] },
  snippets:    { projectId: 'projects', projectIds: ['projects'], collectionId: 'snippetCollections' },
  meetings:    { projectId: 'projects' },
  references:  { projectId: 'projects' },
  tasks:       { projectId: 'projects', ideaId: 'ideas', assigneeId: 'collaborators', areaId: '@areas' },
  resources:   { projectId: 'projects', ideaId: 'ideas' },
  submissions: { projectId: 'projects' },
};
// Dependencias primero: una idea necesita que su proyecto ya exista, una tarea necesita su idea…
const SYNC_ORDER = ['kanbanColumns', 'collaborators', 'snippetCollections', 'projects', 'ideas', 'snippets',
                    'meetings', 'references', 'tasks', 'resources', 'submissions'];
const SYNC_TOMBSTONE_DAYS = 180;

/** Traduce todas las referencias de un registro con `resolve(tablaDestino, valor)`. */
function _mapRefs(table, rec, resolve) {
  const out = { ...rec };
  for (const [field, target] of Object.entries(SYNC_FK[table] || {})) {
    if (!(field in out)) continue;
    out[field] = Array.isArray(target)
      ? (out[field] || []).map(v => resolve(target[0], v)).filter(v => v != null)
      : resolve(target, out[field]);
  }
  if (table === 'projects') {
    if (Array.isArray(out.columnHistory)) out.columnHistory = out.columnHistory.map(h => ({ ...h, colId: resolve('kanbanColumns', h.colId) }));
    if (Array.isArray(out._history))      out._history      = out._history.map(h => ({ ...h, columnId: resolve('kanbanColumns', h.columnId) }));
  }
  if (table === 'meetings' && Array.isArray(out.actionItems))
    out.actionItems = out.actionItems.map(a => ({ ...a, assigneeId: a.assigneeId == null ? null : resolve('collaborators', a.assigneeId) }));
  return out;
}

const Sync = {
  deviceId() {
    let id = localStorage.getItem('ros-device');
    if (!id) { id = 'd' + Math.random().toString(36).slice(2, 8); localStorage.setItem('ros-device', id); }
    return id;
  },
  deviceName() { return localStorage.getItem('ros-device-name') || `Dispositivo ${this.deviceId().slice(1, 5)}`; },
  setDeviceName(n) { try { localStorage.setItem('ros-device-name', String(n).trim().slice(0, 40)); } catch {} },

  /** Estado completo de esta base, con referencias expresadas en uid. */
  async snapshot() {
    const rowsBy = {};
    for (const t of SYNC_TABLES) rowsBy[t] = (await db[t].toArray()).filter(r => r.uid);
    const uidOf = Object.fromEntries(SYNC_TABLES.map(t => [t, new Map(rowsBy[t].map(r => [r.id, r.uid]))]));
    const areas = await _getAreas();
    const areaUid = new Map(areas.map(a => [a.id, a.uid]));
    const resolve = (target, id) => id == null ? null : target === '@areas' ? (areaUid.get(id) ?? null) : (uidOf[target]?.get(id) ?? null);
    const tables = {};
    for (const t of SYNC_TABLES) tables[t] = rowsBy[t].map(r => { const { id, ...rest } = _mapRefs(t, r, resolve); return rest; });
    const tombstones = (await db.tombstones.toArray()).map(({ uid, table, deletedAt, name }) => ({ uid, table, deletedAt, ...(name ? { name } : {}) }));
    return { _sync: 1, device: { id: this.deviceId(), name: this.deviceName() }, exportedAt: new Date().toISOString(), tables, areas, tombstones };
  },

  /** Fusiona la instantánea de otro dispositivo. Devuelve { added, updated, deleted }. */
  async apply(snap) {
    if (!snap || snap._sync !== 1 || typeof snap.tables !== 'object') throw new Error('Archivo de sincronización no reconocido');
    const stats = { added: 0, updated: 0, deleted: 0 };
    SyncState.applying++;
    try {
      await db.transaction('rw', [...SYNC_TABLES.map(t => db[t]), db.tombstones, db.settings], async () => {
        const localTombs = await db.tombstones.toArray();
        const tomb = new Map();                                              // «tabla:uid» → fecha de borrado más reciente
        const addTomb = t => { const k = `${t.table}:${t.uid}`; if (!tomb.has(k) || tomb.get(k) < t.deletedAt) tomb.set(k, t.deletedAt); };
        localTombs.forEach(addTomb); (snap.tombstones || []).forEach(addTomb);

        const byUid = {}, idOf = {};
        for (const t of SYNC_TABLES) {
          const rows = (await db[t].toArray()).filter(r => r.uid);
          byUid[t] = new Map(rows.map(r => [r.uid, r]));
          idOf[t]  = new Map(rows.map(r => [r.uid, r.id]));
        }

        // -- áreas (viven en Ajustes como JSON); la misma área creada en dos dispositivos se unifica por nombre --
        const localAreas = await _getAreas();
        const areaIdByUid = new Map(localAreas.map(a => [a.uid, a.id]));
        let nextAreaId = Math.max(0, ...localAreas.map(a => +a.id || 0)) + 1;
        let areasChanged = false;
        for (const ra of snap.areas || []) {
          const dead = tomb.get(`areas:${ra.uid}`);
          const local = localAreas.find(a => a.uid === ra.uid) || localAreas.find(a => foldText(a.name) === foldText(ra.name));
          if (dead && dead >= (ra.updatedAt || '')) {
            if (local && (local.updatedAt || '') <= dead) { localAreas.splice(localAreas.indexOf(local), 1); stats.deleted++; areasChanged = true; }
            continue;
          }
          if (!local) { const a = { ...ra, id: nextAreaId++ }; localAreas.push(a); areaIdByUid.set(ra.uid, a.id); stats.added++; areasChanged = true; }
          else {
            areaIdByUid.set(ra.uid, local.id);
            if (local.uid !== ra.uid) { local.uid = ra.uid < local.uid ? ra.uid : local.uid; areasChanged = true; }   // la misma área en dos dispositivos converge al uid menor
            if ((ra.updatedAt || '') > (local.updatedAt || '')) { Object.assign(local, { ...ra, id: local.id, uid: local.uid }); stats.updated++; areasChanged = true; }
          }
        }
        for (const t of (snap.tombstones || []).filter(t => t.table === 'areas')) {
          const i = localAreas.findIndex(a => (a.uid === t.uid || (t.name && foldText(a.name) === foldText(t.name))) && (a.updatedAt || '') <= t.deletedAt);
          if (i >= 0) { localAreas.splice(i, 1); stats.deleted++; areasChanged = true; }
        }
        if (areasChanged) await db.settings.put({ key: 'ros-areas', value: JSON.stringify(localAreas) });

        const resolveLocal = (target, uid) => uid == null ? null : target === '@areas' ? (areaIdByUid.get(uid) ?? null) : (idOf[target]?.get(uid) ?? null);

        // -- tablas, en orden de dependencia --
        const parents = [];
        for (const table of SYNC_ORDER) {
          for (const r of snap.tables[table] || []) {
            if (!r.uid) continue;
            const dead  = tomb.get(`${table}:${r.uid}`);
            const local = byUid[table].get(r.uid);
            if (dead && dead >= (r.updatedAt || '')) {                       // borrado después de su última edición
              if (local && (local.updatedAt || '') <= dead) { await db[table].delete(local.id); byUid[table].delete(r.uid); idOf[table].delete(r.uid); stats.deleted++; }
              continue;
            }
            if (local && (r.updatedAt || '') <= (local.updatedAt || '')) continue;          // lo local es igual o más reciente
            const rec = _mapRefs(table, r, resolveLocal);
            if (table === 'projects') parents.push([r.uid, r.parentId]);
            if (local) { await db[table].put({ ...rec, id: local.id }); stats.updated++; }
            else {
              const id = await db[table].add(rec);
              idOf[table].set(r.uid, id); byUid[table].set(r.uid, { ...rec, id });
              stats.added++;
            }
          }
        }
        // un hijo puede llegar antes que su padre: se resuelve cuando ya existen todos
        for (const [uid, parentUid] of parents) {
          const id = idOf.projects.get(uid), pid = parentUid ? idOf.projects.get(parentUid) : null;
          if (id) await db.projects.update(id, { parentId: pid ?? null });
        }

        // -- borrados remotos de registros que ya no aparecen en las tablas remotas --
        for (const t of snap.tombstones || []) {
          if (t.table === 'areas') continue;
          const local = byUid[t.table]?.get(t.uid);
          if (local && (local.updatedAt || '') <= t.deletedAt) { await db[t.table].delete(local.id); byUid[t.table].delete(t.uid); stats.deleted++; }
        }
        // -- lápidas: conservar las remotas (para propagarlas) y retirar las que quedaron obsoletas por una edición posterior --
        const had = new Set(localTombs.map(t => `${t.table}:${t.uid}`));
        const fresh = (snap.tombstones || []).filter(t => !had.has(`${t.table}:${t.uid}`));
        if (fresh.length) await db.tombstones.bulkAdd(fresh.map(({ uid, table, deletedAt, name }) => ({ uid, table, deletedAt, ...(name ? { name } : {}) })));
        const limit = new Date(Date.now() - SYNC_TOMBSTONE_DAYS * 86400000).toISOString();
        for (const t of await db.tombstones.toArray()) {
          const l = byUid[t.table]?.get(t.uid);
          if ((l && (l.updatedAt || '') > t.deletedAt) || t.deletedAt < limit) await db.tombstones.delete(t.id);
        }
      });
    } finally { SyncState.applying--; }
    return stats;
  },
};
window.Sync = Sync;

// ==============================================================
//  TRANSPORTE: carpeta compartida (File System Access API)
// ==============================================================
const SyncFolder = {
  KEY: 'sync-dir-handle',
  paused: false,
  _timer: null, _poll: null, _dirty: false, _busy: false,

  supported: () => typeof window.showDirectoryPicker === 'function',
  enabled:   () => localStorage.getItem('ros-sync') === '1',
  lastSync:  () => +localStorage.getItem('ros-sync-last') || null,
  fileName:  () => `researchos-sync-${Sync.deviceId()}.json`,
  async handle() { return (await db.settings.get(this.KEY))?.value || null; },
  _seen() { try { return JSON.parse(localStorage.getItem('ros-sync-seen') || '{}'); } catch { return {}; } },

  async permission(h, { ask = false } = {}) {
    const o = { mode: 'readwrite' };
    let p = await h.queryPermission?.(o);
    if (p !== 'granted' && ask) p = await h.requestPermission?.(o);
    return p || 'denied';
  },

  async choose() { return this.use(await window.showDirectoryPicker({ mode: 'readwrite', id: 'researchos-sync' })); },
  /** Activa la sincronización en una carpeta ya elegida (p. ej. la que usa otra función). */
  async use(handle) {
    await db.settings.put({ key: this.KEY, value: handle });
    localStorage.setItem('ros-sync', '1');
    this.paused = false;
    return this.syncNow({ ask: true });
  },
  async disable() {
    await db.settings.delete(this.KEY);
    localStorage.removeItem('ros-sync'); localStorage.removeItem('ros-sync-last'); localStorage.removeItem('ros-sync-seen');
    clearInterval(this._poll); clearTimeout(this._timer);
    this.paused = false;
  },

  /** Escribe el archivo propio con el estado actual. */
  async push(handle) {
    const fh = await handle.getFileHandle(this.fileName(), { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(await Sync.snapshot()));
    await w.close();
    this._dirty = false;
  },

  /** Lee los archivos de los demás dispositivos que cambiaron desde la última vez y los fusiona. */
  async pull(handle) {
    const seen = this._seen();
    const total = { added: 0, updated: 0, deleted: 0, from: [] };
    for await (const [name, entry] of handle.entries()) {
      if (!/^researchos-sync-[\w-]+\.json$/.test(name) || name === this.fileName() || entry.kind !== 'file') continue;
      const file = await entry.getFile();
      if (seen[name] === file.lastModified + ':' + file.size) continue;
      try {
        const snap = JSON.parse(await file.text());
        const st = await Sync.apply(snap);
        total.added += st.added; total.updated += st.updated; total.deleted += st.deleted;
        if (st.added + st.updated + st.deleted) total.from.push(snap.device?.name || name);
        seen[name] = file.lastModified + ':' + file.size;
      } catch (e) { console.warn('Sincronización: no se pudo leer', name, e); }
    }
    localStorage.setItem('ros-sync-seen', JSON.stringify(seen));
    return total;
  },

  /** Ciclo completo: traer lo de los demás, aplicar y dejar el estado propio al día. */
  async syncNow({ ask = false, quiet = false } = {}) {
    if (this._busy || !this.enabled()) return null;
    const handle = await this.handle();
    if (!handle) return null;
    if ((await this.permission(handle, { ask })) !== 'granted') { this.paused = true; return null; }
    this._busy = true; this.paused = false;
    try {
      const res = await this.pull(handle);
      const changed = res.added + res.updated + res.deleted;
      if (changed || this._dirty || !(await handle.getFileHandle(this.fileName()).then(() => true).catch(() => false))) await this.push(handle);
      localStorage.setItem('ros-sync-last', String(Date.now()));
      if (changed) {
        await _afterDataReplaced({ local: false });             // lo que llegó de la carpeta no se vuelve a subir
        updateBadges();
        if (!modalOverlay.classList.contains('visible')) renderView(App.view);
        if (!quiet) showToast(`Sincronizado con ${res.from.join(', ') || 'otro dispositivo'}: ${res.added} nuevo(s), ${res.updated} actualizado(s), ${res.deleted} borrado(s)`, 'success');
      }
      return res;
    } finally { this._busy = false; }
  },

  /** Llamado tras cada escritura: sube los cambios 15 s después del último. */
  schedule() {
    if (!this.enabled()) return;
    this._dirty = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.syncNow({ quiet: true }).catch(() => {}), 15_000);
  },
};
window.SyncFolder = SyncFolder;

document.addEventListener('visibilitychange', () => {
  if (!SyncFolder.enabled() || SyncFolder.paused) return;
  if (document.visibilityState === 'visible') SyncFolder.syncNow().catch(() => {});     // al volver a la pestaña, traer lo nuevo
  else if (SyncFolder._dirty) SyncFolder.syncNow({ quiet: true }).catch(() => {});      // al salir, dejar lo pendiente
});

/** Al abrir la app: sincroniza y mantiene un sondeo suave mientras la pestaña esté visible. */
SyncState.listeners.push(() => SyncFolder.schedule());          // cualquier cambio local programa la subida

async function initSync() {
  if (!SyncFolder.enabled() || !SyncFolder.supported()) return;
  try {
    const handle = await SyncFolder.handle();
    if (!handle) return;
    if ((await SyncFolder.permission(handle)) !== 'granted') { SyncFolder.paused = true; return; }
    await SyncFolder.syncNow();
    clearInterval(SyncFolder._poll);
    SyncFolder._poll = setInterval(() => { if (document.visibilityState === 'visible' && !SyncFolder.paused) SyncFolder.syncNow().catch(() => {}); }, 60_000);
  } catch (e) { console.warn('Sincronización: no disponible', e); }
}

// ==============================================================
//  AJUSTES: sección «Sincronizar entre dispositivos»
// ==============================================================
async function renderSyncSection() {
  const host = $('syncSection');
  if (!host) return;
  const handle = SyncFolder.supported() && SyncFolder.enabled() ? await SyncFolder.handle().catch(() => null) : null;
  const perm = handle ? await SyncFolder.permission(handle).catch(() => 'denied') : null;
  const groups = handle || !SyncFolder.supported() ? [] : await Folders.inUse('sync');          // integrations.js
  const shared = handle ? await Folders.sharedWith('sync', handle) : [];
  const peers = [];
  if (handle && perm === 'granted') {
    for await (const [name, entry] of handle.entries())
      if (/^researchos-sync-[\w-]+\.json$/.test(name) && name !== SyncFolder.fileName() && entry.kind === 'file') {
        try { const f = await entry.getFile(); peers.push({ name: (JSON.parse(await f.text()).device?.name) || name, at: f.lastModified }); } catch {}
      }
  }
  host.innerHTML = `
    <div class="settings-section-title">🔄 Sincronizar entre dispositivos</div>
    <div class="settings-body">
      ${!SyncFolder.supported() ? `<div class="settings-row-desc">Hace falta un navegador basado en Chromium (Chrome, Edge). En otros navegadores usa «Exportar» / «Importar».</div>` : `
      <div class="settings-row">
        <div>
          <div class="settings-row-label">${handle ? `Activa → <code>${esc(handle.name || 'carpeta')}</code>` : 'Desactivada'}</div>
          <div class="settings-row-desc" id="syncDesc">
            ${handle ? (perm === 'granted'
                ? `Este dispositivo: <strong>${esc(Sync.deviceName())}</strong>. Última sincronización: ${_fmtAgo(SyncFolder.lastSync())}.${peers.length ? ` Otros dispositivos vistos: ${peers.map(p => `${esc(p.name)} (${_fmtAgo(p.at)})`).join(', ')}.` : ' Aún no se ve ningún otro dispositivo en esa carpeta.'}`
                : '⚠ En pausa: el navegador necesita que reactives el permiso de la carpeta.')
              : 'Elige en cada dispositivo la <strong>misma carpeta</strong> de Dropbox, Drive, Syncthing u OneDrive. Cada uno escribe su propio archivo y lee los de los demás: los cambios más recientes ganan y los borrados se propagan. Los archivos no van cifrados: usa una carpeta privada.'}
          </div>
          ${sharedFolderNote(shared)}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${handle ? `${perm !== 'granted' ? `<button class="btn btn-primary btn-sm" id="syncResume">Reactivar</button>` : ''}
                      <button class="btn btn-ghost btn-sm" id="syncNow">Sincronizar ahora</button>
                      <button class="btn btn-ghost btn-sm" id="syncOff">Desactivar</button>`
                   : folderButtonsHTML('sync', groups)}
        </div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Nombre de este dispositivo</div>
          <div class="settings-row-desc">Aparece en los avisos de sincronización de los demás.</div></div>
        <input class="form-input" id="syncDeviceName" value="${esc(Sync.deviceName())}" style="max-width:200px">
      </div>`}
    </div>`;
  wireSameFolder('sync', groups, async h => { await SyncFolder.use(h); await initSync(); }, refreshFolderUI);
  $('syncOn')?.addEventListener('click', async () => {
    try { await SyncFolder.choose(); await initSync(); showToast('Sincronización activada ✓', 'success'); } catch (e) { if (e?.name !== 'AbortError') showToast('No se pudo activar: ' + e.message, 'error'); }
    refreshFolderUI();
  });
  $('syncOff')?.addEventListener('click', async () => { await SyncFolder.disable(); showToast('Sincronización desactivada', 'info'); refreshFolderUI(); });
  const run = async ask => { try { const r = await SyncFolder.syncNow({ ask }); showToast(r ? 'Sincronizado ✓' : 'No se pudo sincronizar', r ? 'success' : 'error'); } catch (e) { showToast('Error: ' + e.message, 'error'); } renderSyncSection(); };
  $('syncNow')?.addEventListener('click', () => run(true));
  $('syncResume')?.addEventListener('click', async () => { await run(true); await initSync(); });
  $('syncDeviceName')?.addEventListener('change', e => { Sync.setDeviceName(e.target.value); SyncFolder._dirty = true; });
}
