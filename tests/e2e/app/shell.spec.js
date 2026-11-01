// Copia cifrada, barra móvil con captura rápida y primeros pasos.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, expect, openApp, gotoView, seed } = require('../helpers');

const tmpFile = (name, content) => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ros-')), name); fs.writeFileSync(p, content); return p; };

test.describe('Copia cifrada', () => {
  test('cifra y descifra (también texto grande y con tildes); no revela el contenido', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const text = JSON.stringify({ nota: 'Ñandú — evaluación «final» 🔬', big: 'x'.repeat(2_000_000) });
      const t0 = performance.now();
      const enc = await Vault.encrypt(text, 'una-clave-larga');
      const dt = performance.now() - t0;
      const dec = await Vault.decrypt(enc, 'una-clave-larga');
      const enc2 = await Vault.encrypt(text, 'una-clave-larga');
      const o = JSON.parse(enc), o2 = JSON.parse(enc2);
      return { same: dec === text, isEnc: Vault.isEncrypted(enc), plainIsEnc: Vault.isEncrypted(text), leaks: enc.includes('Ñandú') || enc.includes('xxxxxxxx'),
               fields: Object.keys(o).sort(), meta: [o.researchos, o.v, o.kdf, o.cipher, o.iter], differs: o.salt !== o2.salt && o.iv !== o2.iv && o.data !== o2.data, ms: dt };
    });
    expect(r.same).toBe(true);
    expect(r.isEnc).toBe(true); expect(r.plainIsEnc).toBe(false); expect(r.leaks).toBe(false);
    expect(r.fields).toEqual(['cipher', 'data', 'iter', 'iv', 'kdf', 'researchos', 'salt', 'v']);
    expect(r.meta).toEqual(['encrypted', 1, 'PBKDF2-SHA256', 'AES-256-GCM', 310000]);
    expect(r.differs).toBe(true);
    expect(r.ms).toBeLessThan(5000);
  });

  test('contraseña incorrecta, archivo alterado, contraseña corta y archivos hostiles', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const err = async f => { try { await f(); return null; } catch (e) { return e.message; } };
      const enc = await Vault.encrypt('{"a":1}', 'clave-correcta');
      const o = JSON.parse(enc);
      const flipped = JSON.stringify({ ...o, data: o.data.slice(0, 8) + (o.data[8] === 'A' ? 'B' : 'A') + o.data.slice(9) });
      const t0 = performance.now();
      const hostile = await err(() => Vault.decrypt(JSON.stringify({ ...o, iter: 9e15 }), 'clave-correcta'));      // se acota a 5 M: no cuelga
      return {
        wrong: await err(() => Vault.decrypt(enc, 'otra-clave-xx')), tampered: await err(() => Vault.decrypt(flipped, 'clave-correcta')),
        short: await err(() => Vault.encrypt('x', '1234567')), notEnc: await err(() => Vault.decrypt('{"projects":[]}', 'x')),
        garbageB64: await err(() => Vault.decrypt(JSON.stringify({ ...o, salt: '***' }), 'clave-correcta')), hostile, hostileMs: performance.now() - t0,
        unicodePass: await Vault.decrypt(await Vault.encrypt('hola', 'contraseña-ñ-éé'), 'contraseña-ñ-éé'),
        openPlain: await Vault.open('{"projects":[]}'),
      };
    });
    expect(r.wrong).toBe('Contraseña incorrecta o archivo dañado');
    expect(r.tampered).toBe('Contraseña incorrecta o archivo dañado');
    expect(r.garbageB64).toBe('Contraseña incorrecta o archivo dañado');
    expect(r.hostile).toBe('Contraseña incorrecta o archivo dañado');
    expect(r.hostileMs).toBeLessThan(20000);
    expect(r.short).toContain('al menos 8 caracteres');
    expect(r.notEnc).toContain('no está cifrado');
    expect(r.unicodePass).toBe('hola');
    expect(r.openPlain).toBe('{"projects":[]}');
  });

  test('Ajustes: exportar valida la contraseña y descarga un archivo sin datos legibles', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'settings');
    await page.click('#vaultExportBtn');
    await page.fill('#vxPass', 'corta'); await page.fill('#vxPass2', 'corta');
    await page.click('#vxOk');
    await expect(page.locator('#vxErr')).toContainText('al menos 8');
    await page.fill('#vxPass', 'una-buena-clave'); await page.fill('#vxPass2', 'otra-distinta');
    await page.click('#vxOk');
    await expect(page.locator('#vxErr')).toContainText('no coinciden');
    await page.fill('#vxPass2', 'una-buena-clave');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#vxOk')]);
    expect(dl.suggestedFilename()).toMatch(/^researchos-backup-cifrado-\d{4}-\d{2}-\d{2}\.json$/);
    const content = fs.readFileSync(await dl.path(), 'utf8');
    expect(JSON.parse(content).researchos).toBe('encrypted');
    expect(content).not.toContain('Paper Alfa');
    await expect(page.locator('.toast.success').last()).toContainText('Copia cifrada descargada');
  });

  test('importar un backup cifrado pide la contraseña, admite reintentos y restaura los datos', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const enc = await page.evaluate(async () => Vault.encrypt(await exportAllData(), 'clave-del-lab-2026'));
    await page.evaluate(async () => { await clearAllData(); await _afterDataReplaced(); });
    expect(await page.evaluate(() => db.projects.count())).toBe(0);
    await gotoView(page, 'settings');
    const file = tmpFile('backup-cifrado.json', enc);
    // cancelar: no importa nada ni muestra errores
    await page.setInputFiles('#importJsonInput', file);
    await expect(page.locator('#vaultPass')).toBeVisible();
    await page.click('#vaultCancel');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    expect(await page.evaluate(() => db.projects.count())).toBe(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
    // contraseña mala → mensaje y el cuadro sigue abierto; la buena abre el flujo normal de importación
    await page.setInputFiles('#importJsonInput', file);
    await page.fill('#vaultPass', 'equivocada-123');
    await page.press('#vaultPass', 'Enter');
    await expect(page.locator('#vaultErr')).toContainText('Contraseña incorrecta');
    await expect(page.locator('#vaultPass')).toBeVisible();
    await page.fill('#vaultPass', 'clave-del-lab-2026');
    await page.press('#vaultPass', 'Enter');
    await expect(page.locator('#modalContent')).toContainText('El archivo contiene');
    await page.click('#importModeOk');                                       // «merge» por defecto
    await expect(page.locator('.toast.success').last()).toContainText('Importado');
    expect(await page.evaluate(() => db.projects.count())).toBe(3);
    expect(await page.evaluate(() => db.ideas.count())).toBe(2);
  });

  test('cerrar el cuadro con Escape equivale a cancelar (no deja la importación colgada)', async ({ page }) => {
    await openApp(page);
    const enc = await page.evaluate(() => Vault.encrypt('{"projects":[]}', 'clave-larga-1'));
    await gotoView(page, 'settings');
    await page.setInputFiles('#importJsonInput', tmpFile('b.json', enc));
    await expect(page.locator('#vaultPass')).toBeVisible();
    await page.evaluate(() => closeModal());
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    await gotoView(page, 'dashboard');                                       // la app sigue respondiendo
    await expect(page.locator('#captureInput')).toBeVisible();
  });
});

test.describe('Móvil', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('la barra inferior navega, marca la vista activa y abre el menú', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const bar = page.locator('#mobileBar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.mb-tab.active')).toHaveText(/Hoy/);
    await bar.getByRole('button', { name: 'Ideas' }).click();
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'ideas');
    await expect(bar.locator('.mb-tab.active')).toHaveText(/Ideas/);
    await bar.getByRole('button', { name: 'Proyectos' }).click();
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'kanban');
    await page.evaluate(() => navigate('timeline'));                           // la pestaña usada se recuerda
    await bar.getByRole('button', { name: 'Hoy' }).click();
    await bar.getByRole('button', { name: 'Proyectos' }).click();
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'timeline');
    await expect(bar.locator('.mb-tab.active')).toHaveText(/Proyectos/);
    await bar.getByRole('button', { name: 'Más' }).click();
    await expect(page.locator('body')).toHaveClass(/sidebar-mobile-open/);
  });

  test('«＋» captura desde cualquier vista sin cambiar de pantalla', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.locator('#mobileBar').getByRole('button', { name: 'Ideas' }).click();           // en móvil el menú lateral es un cajón: se navega con la barra
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'ideas');
    await page.locator('#mobileBar').getByRole('button', { name: 'Capturar' }).click();
    await expect(page.locator('#qcInput')).toBeFocused();
    await page.fill('#qcInput', 'llamar a Ana mañana ~15m @alfa');
    await expect(page.locator('#qcPreview')).toContainText('⏱ 15 min');
    await page.press('#qcInput', 'Enter');
    await expect(page.locator('.toast.success').last()).toContainText('Tarea creada');
    await expect(page.locator('#mainContent')).toHaveAttribute('data-view', 'ideas');
    const t = await page.evaluate(() => db.tasks.filter(x => x.title === 'llamar a Ana').first());
    expect(t).toMatchObject({ effort: 15, projectId: expect.any(Number) });
    // vacío: avisa y no cierra
    await page.locator('#mobileBar').getByRole('button', { name: 'Capturar' }).click();
    await page.press('#qcInput', 'Enter');
    await expect(page.locator('.toast.error').last()).toContainText('Escribe algo');
    await expect(page.locator('#qcInput')).toBeVisible();
  });

  test('la barra no tapa el contenido y en escritorio no existe', async ({ page }) => {
    await openApp(page);
    const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('mainContent')).paddingBottom));
    expect(pad).toBeGreaterThanOrEqual(64);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('#mobileBar')).toBeHidden();
  });
});

test.describe('Primeros pasos', () => {
  test('Hoy vacío ofrece traer lo que ya tienes y crear áreas', async ({ page }) => {
    await openApp(page);
    const fr = page.locator('.first-run');
    await expect(fr).toContainText('Empieza escribiendo');
    await expect(fr.locator('.fr-steps li')).toHaveCount(4);
    await page.click('#frAreas');
    await expect(page.locator('#frAreas')).toHaveText('✓ Creadas');
    expect((await page.evaluate(() => _getAreas())).map(a => a.name)).toEqual(['Investigación', 'Docencia', 'Gestión', 'Personal']);
  });

  test('importar .bib, CSV y backup desde el panel; el panel desaparece al haber datos', async ({ page }) => {
    await openApp(page);
    await page.setInputFiles('#frBib', tmpFile('lib.bib', '@article{garcia2020, title={Modelos jerárquicos}, author={García, Juan and Vega, María}, year={2020}, journal={Ecology}}'));
    await expect(page.locator('#modalContent')).toContainText('1 referencia(s)');
    await page.click('#impRefOk');
    await expect(page.locator('.toast.success').last()).toContainText('1 referencia(s) importada(s)');
    expect(await page.evaluate(() => db.references.count())).toBe(1);
    await page.setInputFiles('#frCsv', tmpFile('t.csv', 'Tarea,Fecha\nEscribir informe,2026-12-01\n'));
    await page.click('#tiOk');
    await expect(page.locator('.toast.success').last()).toContainText('1 tarea(s) importada(s)');
    // ya hay tareas: Hoy deja de mostrar los primeros pasos
    await expect(page.locator('.first-run')).toHaveCount(0);
    await expect(page.locator('.tw-row', { hasText: 'Escribir informe' })).toBeVisible();
  });

  test('un backup elegido desde los primeros pasos pasa por el mismo flujo (incluido el cifrado)', async ({ page }) => {
    await openApp(page);
    const enc = await page.evaluate(async () => {
      const now = new Date().toISOString();
      return Vault.encrypt(JSON.stringify({ projects: [{ id: 1, title: 'Desde backup', type: 'Paper', createdAt: now, updatedAt: now }], ideas: [], snippets: [] }), 'clave-del-backup');
    });
    await page.setInputFiles('#frBackup', tmpFile('b.json', enc));
    await page.fill('#vaultPass', 'clave-del-backup');
    await page.press('#vaultPass', 'Enter');
    await expect(page.locator('#modalContent')).toContainText('El archivo contiene');
    await page.click('#importModeOk');
    await expect(page.locator('.toast.success').last()).toContainText('Importado');
    expect(await page.evaluate(() => db.projects.filter(p => p.title === 'Desde backup').count())).toBe(1);
  });

  test('«Cargar ejemplo» trae el laboratorio de muestra', async ({ page }) => {
    await openApp(page);
    await page.click('#frDemo');
    await expect(page.locator('.toast.success').last()).toContainText('Datos de ejemplo cargados');
    expect(await page.evaluate(() => db.projects.count())).toBeGreaterThan(3);
  });
});
