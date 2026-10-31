// ============================================================
//  ResearchOS — Copia cifrada con contraseña (WebCrypto: PBKDF2-SHA256 → AES-256-GCM)
//
//  El archivo cifrado es un JSON con la sal, el IV y los datos en base64. Sin la contraseña no hay
//  forma de recuperarlo: la clave no se guarda en ningún sitio. Pensado para backups que viajan por
//  correo o nube (datos de estudiantes, evaluaciones, borradores de grants).
// ============================================================

'use strict';

const Vault = {
  ITER: 310000,                 // iteraciones de PBKDF2 (recomendación OWASP 2023 para SHA-256: 600 000; 310 000 equilibra móviles lentos)
  MIN_LEN: 8,
  AAD: 'researchos:v1',
  supported: () => !!(globalThis.crypto?.subtle),

  _b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); },
  _unb64(str) { const s = atob(str), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; },

  isEncrypted(text) {
    try { const o = JSON.parse(text); return !!o && o.researchos === 'encrypted' && o.v === 1 && typeof o.data === 'string'; } catch { return false; }
  },

  async _key(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pass).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },

  /** Cifra `text`. Devuelve el contenido del archivo (JSON). */
  async encrypt(text, pass) {
    if (!Vault.supported()) throw new Error('Este navegador no admite cifrado (WebCrypto)');
    if (String(pass || '').length < Vault.MIN_LEN) throw new Error(`La contraseña debe tener al menos ${Vault.MIN_LEN} caracteres`);
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await Vault._key(pass, salt, Vault.ITER);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(Vault.AAD) }, key, new TextEncoder().encode(text)));
    return JSON.stringify({ researchos: 'encrypted', v: 1, kdf: 'PBKDF2-SHA256', iter: Vault.ITER, cipher: 'AES-256-GCM', salt: Vault._b64(salt), iv: Vault._b64(iv), data: Vault._b64(data) });
  },

  /** Descifra el contenido de un archivo cifrado. Lanza «Contraseña incorrecta…» si no coincide o el archivo fue alterado. */
  async decrypt(fileText, pass) {
    if (!Vault.isEncrypted(fileText)) throw new Error('El archivo no está cifrado con ResearchOS');
    if (!Vault.supported()) throw new Error('Este navegador no admite cifrado (WebCrypto)');
    const o = JSON.parse(fileText);
    const iter = Math.min(5e6, Math.max(1e5, +o.iter || Vault.ITER));                  // acota: un archivo hostil no puede colgar el navegador
    try {
      const key = await Vault._key(pass, Vault._unb64(o.salt), iter);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Vault._unb64(o.iv), additionalData: new TextEncoder().encode(Vault.AAD) }, key, Vault._unb64(o.data));
      return new TextDecoder().decode(plain);
    } catch { throw new Error('Contraseña incorrecta o archivo dañado'); }
  },

  /**
   * Devuelve el texto en claro de un archivo: si está cifrado pide la contraseña (permite reintentar).
   * Devuelve null si la persona cancela.
   */
  open(raw) {
    if (!Vault.isEncrypted(raw)) return Promise.resolve(raw);
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; obs.disconnect(); resolve(v); };
      showModal('🔐 Archivo cifrado', `
        <div class="modal-body">
          <p class="form-hint" style="margin-bottom:10px">Este backup está protegido con contraseña. Escríbela para abrirlo; no sale de tu navegador.</p>
          <input class="form-input" type="password" id="vaultPass" autocomplete="off" aria-label="Contraseña del backup" placeholder="Contraseña">
          <div class="form-hint" id="vaultErr" role="alert" style="color:var(--red);min-height:1.2em;margin-top:6px"></div>
        </div>
        <div class="modal-footer"><button class="btn btn-ghost" id="vaultCancel">Cancelar</button><button class="btn btn-primary" id="vaultOk">Descifrar</button></div>`);
      const obs = new MutationObserver(() => { if (!modalOverlay.classList.contains('visible')) finish(null); });
      obs.observe(modalOverlay, { attributes: true, attributeFilter: ['class'] });
      focusField($('vaultPass'));
      const attempt = async () => {
        const btn = $('vaultOk'); btn.disabled = true; btn.textContent = 'Descifrando…';
        try { const text = await Vault.decrypt(raw, $('vaultPass').value); finish(text); closeModal(); }
        catch (e) { $('vaultErr').textContent = e.message; btn.disabled = false; btn.textContent = 'Descifrar'; $('vaultPass').select(); }
      };
      $('vaultOk').addEventListener('click', attempt);
      $('vaultPass').addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
      $('vaultCancel').addEventListener('click', () => { finish(null); closeModal(); });
    });
  },

  /** Pide la contraseña (dos veces) y descarga todos los datos cifrados. */
  exportEncrypted() {
    showModal('🔐 Exportar copia cifrada', `
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Contraseña (mínimo ${Vault.MIN_LEN} caracteres)</label>
          <input class="form-input" type="password" id="vxPass" autocomplete="new-password"></div>
        <div class="form-group"><label class="form-label">Repite la contraseña</label>
          <input class="form-input" type="password" id="vxPass2" autocomplete="new-password"></div>
        <div class="form-hint" id="vxErr" role="alert" style="color:var(--red);min-height:1.2em"></div>
        <div class="form-hint"><strong>Guárdala bien:</strong> no se almacena en ningún sitio y, sin ella, el archivo no se puede recuperar.</div>
      </div>
      <div class="modal-footer"><button class="btn btn-ghost" id="vxCancel">Cancelar</button><button class="btn btn-primary" id="vxOk">Cifrar y descargar</button></div>`);
    focusField($('vxPass'));
    $('vxCancel').addEventListener('click', closeModal);
    const go = async () => {
      const p1 = $('vxPass').value, p2 = $('vxPass2').value;
      if (p1.length < Vault.MIN_LEN) return void ($('vxErr').textContent = `Usa al menos ${Vault.MIN_LEN} caracteres`);
      if (p1 !== p2) return void ($('vxErr').textContent = 'Las contraseñas no coinciden');
      const btn = $('vxOk'); btn.disabled = true; btn.textContent = 'Cifrando…';
      try {
        const out = await Vault.encrypt(await exportAllData(), p1);
        downloadFile(`researchos-backup-cifrado-${localDateISO()}.json`, out);
        BackupMeta.mark();
        closeModal(); showToast('Copia cifrada descargada ✓', 'success');
      } catch (e) { $('vxErr').textContent = e.message; btn.disabled = false; btn.textContent = 'Cifrar y descargar'; }
    };
    $('vxOk').addEventListener('click', go);
    $('vxPass2').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  },
};

function vaultSettingsHTML() {
  return `
    <div class="settings-section" id="vaultSection">
      <div class="settings-section-title">🔐 Copia cifrada</div>
      <div class="settings-body">
        <div class="settings-row">
          <div><div class="settings-row-label">Exportar con contraseña</div>
            <div class="settings-row-desc">Para guardar o enviar un backup con datos sensibles (estudiantes, evaluaciones, borradores). AES-256; al importarlo la app pide la contraseña. ${Vault.supported() ? '' : '<strong>Tu navegador no admite cifrado.</strong>'}</div></div>
          <button class="btn btn-ghost btn-sm" id="vaultExportBtn" ${Vault.supported() ? '' : 'disabled'}>Exportar cifrado…</button>
        </div>
      </div>
    </div>`;
}
function wireVaultSettings() { $('vaultExportBtn')?.addEventListener('click', () => Vault.exportEncrypted()); }
