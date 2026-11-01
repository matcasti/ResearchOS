// Exportar / importar / backup — el contrato de "tus datos son tuyos".
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('../helpers');

const tables = ['projects', 'ideas', 'snippets', 'references', 'meetings', 'collaborators'];
const counts = page => page.evaluate(async t => Object.fromEntries(await Promise.all(
  t.map(async n => [n, await db[n].count()]))), tables);

async function exportJson(page) {
  await gotoView(page, 'settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#exportJsonBtn').click()]);
  return fs.promises.readFile(await dl.path(), 'utf8');
}

async function importJson(page, text, mode) {
  await gotoView(page, 'settings');
  await page.locator('#importJsonInput').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.locator(mode === 'replace' ? '#importOptReplace' : '#importOptMerge').click();
  await page.locator('#importModeOk').click();
  if (mode === 'replace') await page.locator('#confirmYes').click();   // además se descarga una copia previa (no hace falta esperarla)
}

test.describe('Backup JSON', () => {
  test('exportar genera un JSON completo y sin credenciales de Google', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => db.settings.bulkPut([
      { key: 'google_access_token', value: 'SECRET' }, { key: 'ros-areas', value: '[]' }]));
    const data = JSON.parse(await exportJson(page));
    expect(data._version).toBe(3);
    expect(data.projects).toHaveLength(3);
    expect(data.ideas).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain('SECRET');
    expect(data.settings.map(s => s.key)).toContain('ros-areas');
  });

  test('ida y vuelta: exportar → vaciar → importar (reemplazar) restaura todo', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    const before = await counts(page);
    const json = await exportJson(page);
    await page.evaluate(async () => { for (const t of ['projects', 'ideas', 'snippets', 'references', 'meetings', 'collaborators']) await db[t].clear(); });
    expect((await counts(page)).projects).toBe(0);
    await importJson(page, json, 'replace');
    await expect(page.locator('.toast.success').last()).toContainText('Datos reemplazados');
    expect(await counts(page)).toEqual(before);
    expect(errors).toEqual([]);
  });

  test('importar en modo merge añade registros nuevos sin tocar los existentes', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const json = JSON.parse(await exportJson(page));
    json.projects = [{ ...json.projects[0], id: 100, uid: 'otro-dispositivo-0001', title: 'Proyecto importado' }];   // otra identidad (uid)
    json.ideas = []; json.snippets = []; json.meetings = []; json.references = []; json.collaborators = [];
    await importJson(page, JSON.stringify(json), 'merge');
    await expect(page.locator('.toast.success').last()).toContainText('Importado (merge)');
    expect((await counts(page)).projects).toBe(4);
    expect(await page.evaluate(() => db.projects.get(100).then(p => p.title))).toBe('Proyecto importado');
  });

  test('archivo que no es JSON muestra error y no modifica datos', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'settings');
    await page.locator('#importJsonInput').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('esto no es json') });
    await expect(page.locator('.toast.error')).toContainText('Error al leer el archivo');
    expect((await counts(page)).projects).toBe(3);
  });

  test('cancelar el diálogo de importación no cambia nada', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const json = await exportJson(page);
    await gotoView(page, 'settings');
    await page.locator('#importJsonInput').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(json) });
    await page.locator('#importModeCancel').click();
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    expect((await counts(page)).projects).toBe(3);
  });
});

test.describe('CSV de proyectos', () => {
  test('exportar CSV: cabecera, BOM UTF-8 y una fila por proyecto', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#exportCsvBtn').click()]);
    const csv = await fs.promises.readFile(await dl.path(), 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    const lines = csv.slice(1).split('\n');
    expect(lines[0]).toBe('title,type,responsible,priority,deadline,description,tags,status,column,parent');
    expect(lines).toHaveLength(4);
    expect(csv).toContain('Paper Alfa');
    expect(csv).toContain('R|ecology');
  });

  test('importar CSV: vista previa y alta de proyectos', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'settings');
    const csv = 'title,type,priority,deadline,responsible,tags\n"Con, coma",Paper,Alta,2026-12-01,Dra. Vega,a|b\nSegundo,Grant,Baja,,,\n';
    await page.locator('#importCsvInput').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.locator('#csvPreviewArea')).toContainText('2');
    await page.locator('#confirmCsvImport').click();
    await expect(page.locator('.toast.success').last()).toContainText('2 proyectos importados');
    const ps = await page.evaluate(() => db.projects.toArray());
    expect(ps.map(p => p.title).sort()).toEqual(['Con, coma', 'Segundo']);
    expect(ps.find(p => p.title === 'Con, coma').tags).toEqual(['a', 'b']);
  });

  test('CSV sin columna title es rechazado', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'settings');
    await page.locator('#importCsvInput').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from('nombre,tipo\nx,y\n') });
    await expect(page.locator('#csvPreviewArea')).toContainText('no tiene columna "title"');
  });
});

test.describe('Markdown por proyecto', () => {
  test('exportar proyecto como Markdown descarga un .md con su contenido', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const id = await page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => p.id));
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(i => exportProjectAsMarkdown(i), id),
    ]);
    expect(dl.suggestedFilename()).toMatch(/\.md$/);
    const md = await fs.promises.readFile(await dl.path(), 'utf8');
    expect(md).toContain('Paper Alfa');
    expect(md).toContain('Estudio **alfa**');
  });
});
