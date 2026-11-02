// Asistente de IA: la app publica su estado en una carpeta y aplica (con revisión) los cambios que un LLM deja en `cambios/`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { test, expect, openApp, gotoView, seed, openSettingsTab } = require('../helpers');

const TOOL = path.resolve(__dirname, '../../../tools/researchos.js');
const R = require(TOOL);

test.skip(({ browserName }) => browserName !== 'chromium', 'La carpeta del asistente usa la File System Access API, que solo existe en Chromium (Chrome/Edge)');

const TIPO = 'researchos-changes/1';

/** La «carpeta elegida» es el sistema de archivos privado del origen (OPFS). */
async function activar(page) {
  await page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
  await gotoView(page, 'settings');
  await openSettingsTab(page, 'sync');
  await page.locator('#assistantOn').click();
  await expect(page.locator('.toast.success').last()).toContainText('Asistente activado');
}
const leer = (page, ruta) => page.evaluate(async r => {
  let d = await navigator.storage.getDirectory(); const partes = r.split('/');
  for (const p of partes.slice(0, -1)) d = await d.getDirectoryHandle(p);
  return (await (await d.getFileHandle(partes.at(-1))).getFile()).text();
}, ruta);
const dejar = async (page, nombre, cambio) => {
  await page.evaluate(async ([n, t]) => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('cambios', { create: true });
    const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(t); await w.close();
  }, [nombre, JSON.stringify(cambio)]);
  await page.waitForTimeout(1700);                                     // la app espera a que el archivo deje de escribirse
  await page.evaluate(() => Assistant.syncNow());
};
const tarea = (page, titulo) => page.evaluate(t => db.tasks.filter(x => x.title === t).first(), titulo);

test.describe('Asistente de IA', () => {
  test('publica instrucciones, estado y agenda legibles para cualquier LLM', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => Tasks.add({ title: 'Revisar figuras', due: addDaysISO(-2), projectId: 1, priority: 'Alta' }));
    await activar(page);
    const agents = await leer(page, 'AGENTS.md');
    expect(agents).toContain('researchos-changes/1');
    expect(agents).toContain('cambios/');
    expect(agents).toContain('`repeat`');                                  // los campos salen de los que valida la app
    expect(await leer(page, 'CLAUDE.md')).toContain('@AGENTS.md');
    expect(await leer(page, 'researchos.js')).toContain('serveMcp');            // la herramienta viaja con la carpeta
    expect(agents).toContain('node researchos.js');
    const estado = JSON.parse(await leer(page, 'estado.json'));
    expect(estado).toMatchObject({ format: 'researchos-state/1', summary: { openTasks: 1, overdueTasks: 1 } });
    expect(estado.projects.map(p => p.title)).toContain('Paper Alfa');
    expect(estado.tasks[0]).toMatchObject({ title: 'Revisar figuras', project: 'Paper Alfa', late: true, priority: 'Alta' });
    expect(estado.tasks[0].uid).toMatch(/[0-9a-f-]{16,}/);
    expect(estado.people.map(p => p.name)).toContain('Dra. Vega');
    const md = await leer(page, 'pendientes.md');
    expect(md).toContain('## Atrasadas (1)');
    expect(md).toContain(`\`${estado.tasks[0].uid.slice(0, 8)}\``);
    await expect(page.locator('#assistantDesc')).toContainText('Última publicación');

    // el estado dice qué admite la app hoy (la IA no tiene que probar campos) y una pestaña vieja se delata sola
    expect(estado.apiVersion).toBeGreaterThanOrEqual(3);
    expect(estado.fields.task.set).toEqual(expect.arrayContaining(['owner', 'rank', 'after', 'event', 'spent']));
    expect(estado.fields.project.ops).toEqual(['add', 'update']);
    expect(estado.fields.area).toBeUndefined();                                              // los ajustes de la app solo constan con el permiso
    expect(agents).toContain('`apiVersion`');
    expect(await page.evaluate(() => StaleTab.stamp())).toMatch(/\|/);
    await page.evaluate(() => { StaleTab.base = 'huella-vieja'; return StaleTab.check(); });
    await expect(page.locator('#staleBar')).toContainText('versión nueva');
  });

  test('los cambios de la IA se revisan antes de aplicarse; cada operación informa de su resultado', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const hecha = await page.evaluate(() => Tasks.add({ title: 'Mandar datos', due: addDaysISO(1), projectId: 1 }));
    const otra = await page.evaluate(() => Tasks.add({ title: 'Cosa vieja' }));
    await activar(page);
    const uid = id => page.evaluate(i => db.tasks.get(i).then(t => t.uid), id);
    await dejar(page, 'lote-1.json', { format: TIPO, author: 'claude-test', note: 'Orden de la semana', ops: [
      { op: 'add', type: 'task', set: { title: 'Enviar borrador', due: '2026-12-01', project: 'paper alfa', priority: 'alta', assignee: 'vega', repeat: 'weekly', minutes: 45 } },
      { op: 'update', type: 'task', uid: (await uid(hecha)).slice(0, 8), set: { due: '2027-01-05', priority: 'Baja' } },
      { op: 'complete', type: 'task', match: 'Mandar datos' },
      { op: 'add', type: 'project', set: { title: 'Tesis cap. 2', type: 'Paper', column: 'Escritura', deadline: '2027-03-01' } },
      { op: 'add', type: 'task', set: { title: 'Escribir intro', project: 'Tesis cap. 2' } },
      { op: 'add', type: 'idea', set: { title: 'Modelo mixto', content: 'con lme4', tags: ['estadística'] } },
      { op: 'add', type: 'meeting', set: { title: 'Comité', date: '2026-12-03', participants: 'Dra. Vega', addActionItems: [{ text: 'Llevar acta', due: '2026-12-03', assignee: 'Vega' }] } },
      { op: 'update', type: 'task', uid: (await uid(hecha)).slice(0, 8), set: { campo_inventado: 1 } },
      { op: 'delete', type: 'task', uid: (await uid(otra)).slice(0, 8) },
    ] });
    await expect(page.locator('#assistantBar')).toContainText('propone');
    await page.setViewportSize({ width: 360, height: 740 });                                  // en un móvil, el aviso, la lista y los Ajustes caben
    const cabe = sel => page.evaluate(s => { const b = document.querySelector(s).getBoundingClientRect(); return b.left >= -1 && b.right <= innerWidth + 1; }, sel);
    expect(await cabe('#assistantBar')).toBe(true);
    await page.locator('#assistantReview').click();
    expect(await cabe('#modal')).toBe(true);
    expect(await page.evaluate(() => document.getElementById('modalContent').scrollWidth <= document.getElementById('modalContent').clientWidth + 1)).toBe(true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => navigate('settings'));
    await expect(page.locator('#assistantDesc')).toBeVisible();
    await expect.poll(() => page.evaluate(() => { const s = document.getElementById('assistantSection'); return !!s && document.documentElement.scrollWidth <= innerWidth + 1 && s.scrollWidth <= s.clientWidth + 1; })).toBe(true);     // Ajustes monta sus secciones de forma asíncrona
    await page.setViewportSize({ width: 1280, height: 720 });
    expect(await tarea(page, 'Enviar borrador')).toBeUndefined();                          // nada se aplica sin que la persona lo acepte
    expect(JSON.parse(await leer(page, 'resultados/lote-1.json')).status).toBe('pending');

    await page.locator('#assistantReview').click();
    await expect(page.locator('#modalContent')).toContainText('Enviar borrador');
    await expect(page.locator('#modalContent')).toContainText('⚠ borrado');
    await expect(page.locator('#modalContent')).toContainText('1 operación(es) no válidas');
    await page.locator('[data-asst]').last().uncheck();                                      // el borrado se desmarca
    await page.locator('#asstApply').click();
    await expect(page.locator('.toast.success').last()).toContainText('claude-test');

    const t = await tarea(page, 'Enviar borrador');
    expect(t).toMatchObject({ due: '2026-12-01', priority: 'Alta', effort: 45, recurrence: { freq: 'weekly', interval: 1 } });
    expect(t.projectId).toBeGreaterThan(0); expect(t.assigneeId).toBeGreaterThan(0);
    expect(await page.evaluate(i => db.tasks.get(i), hecha)).toMatchObject({ due: '2027-01-05', priority: 'Baja', done: true });
    const tesis = await page.evaluate(() => db.projects.where('title').equals('Tesis cap. 2').first());
    expect(tesis).toMatchObject({ type: 'Paper', deadline: '2027-03-01' });
    expect((await tarea(page, 'Escribir intro')).projectId).toBe(tesis.id);                 // un lote puede crear un proyecto y usarlo
    expect(await page.evaluate(() => db.ideas.where('title').equals('Modelo mixto').first().then(i => [i.status, i.tags]))).toEqual(['unread', ['estadística']]);
    expect(await page.evaluate(() => db.meetings.where('title').equals('Comité').first().then(m => m.actionItems.map(a => [a.text, a.due, a.assigneeId > 0])))).toEqual([['Llevar acta', '2026-12-03', true]]);
    expect(await page.evaluate(i => db.tasks.get(i).then(Boolean), otra)).toBe(true);        // lo desmarcado no se aplicó

    const res = JSON.parse(await leer(page, 'resultados/lote-1.json'));
    expect(res.status).toBe('done');
    expect(res.ops.map(o => o.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'error', 'rejected']);
    expect(res.ops[0].uid).toBeTruthy();
    expect(res.ops[7].error).toContain('campo_inventado');
    await expect(page.locator('#assistantBar')).toHaveCount(0);

    await page.evaluate(() => Assistant.syncNow());                                          // y la IA ve el resultado en el estado
    expect(JSON.parse(await leer(page, 'estado.json')).tasks.map(x => x.title)).toContain('Enviar borrador');
  });

  test('en modo automático lo que no es un borrado se aplica y se puede deshacer; los borrados siguen en revisión; lo mal formado se informa', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const viejo = await page.evaluate(() => Tasks.add({ title: 'Tarea vieja' }));
    await activar(page);
    await page.evaluate(() => Assistant.setMode('auto'));
    const uid = await page.evaluate(i => db.tasks.get(i).then(t => t.uid), viejo);
    await dejar(page, 'lote-2.json', { format: TIPO, author: 'auto-bot', ops: [
      { op: 'add', type: 'task', title: 'Plan semanal', due: '2026-12-07' },                  // los campos pueden ir sueltos, sin «set»
      { op: 'delete', type: 'task', uid },
    ] });
    expect(await tarea(page, 'Plan semanal')).toMatchObject({ due: '2026-12-07' });
    await expect(page.locator('#assistantBar')).toContainText('1 cambio');
    expect(JSON.parse(await leer(page, 'resultados/lote-2.json')).status).toBe('pending');
    await page.locator('.toast-undo-btn').last().click();                                   // deshacer lo aplicado
    await expect.poll(() => tarea(page, 'Plan semanal')).toBeUndefined();

    await page.locator('#assistantDiscardAll').click();                                     // descartar el borrado
    await expect(page.locator('#assistantBar')).toHaveCount(0);
    expect(await page.evaluate(i => db.tasks.get(i).then(Boolean), viejo)).toBe(true);
    expect(JSON.parse(await leer(page, 'resultados/lote-2.json')).ops.map(o => o.status)).toEqual(['applied', 'rejected']);

    await dejar(page, 'lote-3.json', { format: 'otra-cosa/9', ops: [] });                  // formato desconocido
    await dejar(page, 'lote-4.json', { format: TIPO, ops: [{ op: 'add', type: 'robot', set: {} }, { op: 'complete', type: 'idea', uid: 'xxxxxxxx' }, { op: 'update', type: 'task', uid: 'no-existe-0', set: { title: 'x' } }] });
    expect(JSON.parse(await leer(page, 'resultados/lote-3.json')).error).toContain('no reconocido');
    const r4 = JSON.parse(await leer(page, 'resultados/lote-4.json'));
    expect(r4.ops.map(o => o.status)).toEqual(['error', 'error', 'error']);
    expect(r4.ops[0].error).toContain('robot');
    expect(r4.ops[1].error).toContain('no está permitido');
    expect(r4.ops[2].error).toContain('no existe');
  });

  test('la herramienta para agentes (biblioteca, CLI y MCP) lee el estado y escribe lotes que la app entiende', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => Tasks.add({ title: 'Revisar figuras', due: addDaysISO(-1), projectId: 1 }));
    await activar(page);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-ia-'));                        // la carpeta «real» que vería la IA
    fs.writeFileSync(path.join(dir, 'estado.json'), await leer(page, 'estado.json'));

    const ov = await R.callTool('researchos_overview', {}, { dir });                       // lectura
    expect(ov).toMatchObject({ summary: { openTasks: 1, overdueTasks: 1 }, overdue: [{ title: 'Revisar figuras' }] });
    expect((await R.callTool('researchos_list', { type: 'projects', query: 'alfa' }, { dir })).map(p => p.title)).toEqual(['Paper Alfa']);
    expect((await R.callTool('researchos_list', { type: 'tasks', due: 'overdue' }, { dir })).map(t => t.title)).toEqual(['Revisar figuras']);
    expect(JSON.parse(execFileSync(process.execPath, [TOOL, '--dir', dir, 'tareas', '--hasta', 'atrasadas', '--json'])).map(t => t.title)).toEqual(['Revisar figuras']);
    await expect(R.callTool('researchos_complete_task', { task: 'no existe' }, { dir })).rejects.toThrow('no hay tarea abierta');
    expect(ov.apiVersion).toBeGreaterThanOrEqual(3); expect(ov.hint).toBeUndefined();
    const viejo = JSON.parse(fs.readFileSync(path.join(dir, 'estado.json'), 'utf8'));                          // una app sin actualizar: lo dice la herramienta, y no deja enviar lo que no admite
    delete viejo.apiVersion; viejo.fields = { task: { ops: ['add'], set: ['title', 'due'] } };
    fs.writeFileSync(path.join(dir, 'estado.json'), JSON.stringify(viejo));
    expect((await R.callTool('researchos_overview', {}, { dir })).hint).toContain('recarga su pestaña');
    await expect(R.callTool('researchos_add', { type: 'task', set: { title: 'x', owner: 'Vega' } }, { dir })).rejects.toThrow('no admite todavía «owner»');
    fs.writeFileSync(path.join(dir, 'estado.json'), await leer(page, 'estado.json'));

    const env = await R.callTool('researchos_add_task', { title: 'Tarea desde MCP', due: '2026-12-09', project: 'Paper Alfa', priority: 'Alta' }, { dir });   // escritura
    expect(env.status).toBe('enviado');
    expect(fs.readdirSync(path.join(dir, 'cambios')).filter(n => n.endsWith('.tmp'))).toEqual([]);   // se escribe de forma atómica
    await R.callTool('researchos_complete_task', { task: 'revisar figuras' }, { dir });
    const lotes = fs.readdirSync(path.join(dir, 'cambios')).sort();
    expect(lotes).toHaveLength(2);
    for (const n of lotes) await dejar(page, n, JSON.parse(fs.readFileSync(path.join(dir, 'cambios', n), 'utf8')));
    await page.locator('#assistantReview').click();
    await page.locator('#asstApply').click();
    await expect(page.locator('.toast.success').last()).toContainText('mcp');
    expect(await tarea(page, 'Tarea desde MCP')).toMatchObject({ due: '2026-12-09', priority: 'Alta' });
    expect((await tarea(page, 'Revisar figuras')).done).toBe(true);

    fs.mkdirSync(path.join(dir, 'resultados'), { recursive: true });                          // el resultado vuelve a la IA
    const nombre = lotes[0];
    fs.writeFileSync(path.join(dir, 'resultados', nombre), await leer(page, 'resultados/' + nombre));
    expect(R.readResult(dir, nombre)).toMatchObject({ status: 'done', ops: [{ status: 'applied' }] });
    expect(await R.callTool('researchos_get_result', { file: nombre }, { dir })).toMatchObject({ status: 'done' });

    const hijo = spawn(process.execPath, [TOOL, 'mcp', '--dir', dir]);                       // servidor MCP por stdio
    const pend = new Map(); let buf = '';
    hijo.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pend.get(m.id)?.(m); } });
    const rpc = (id, method, params) => new Promise(res => { pend.set(id, res); hijo.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    try {
      const init = await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'prueba', version: '0' } });
      expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'researchos' }, capabilities: { tools: {} } });
      hijo.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const lista = await rpc(2, 'tools/list');
      expect(lista.result.tools.map(t => t.name)).toEqual(expect.arrayContaining(['researchos_overview', 'researchos_add_task', 'researchos_propose_changes']));
      for (const t of lista.result.tools) expect(t.inputSchema.type, t.name).toBe('object');
      const llamada = await rpc(3, 'tools/call', { name: 'researchos_search', arguments: { text: 'figuras' } });
      expect(JSON.parse(llamada.result.content[0].text).tasks[0].title).toBe('Revisar figuras');
      const mala = await rpc(4, 'tools/call', { name: 'researchos_update_task', arguments: { task: 'nada que ver' } });
      expect(mala.result).toMatchObject({ isError: true });
      expect((await rpc(5, 'metodo/raro')).error.code).toBe(-32601);
    } finally { hijo.kill(); }
    for (const f of ['openai', 'anthropic']) expect(JSON.parse(execFileSync(process.execPath, [TOOL, 'schema', '--formato', f])).length).toBe(R.TOOLS.length);
  });

  test('la sincronización, la copia automática y el asistente comparten carpeta: «Usar la carpeta…» en un clic, sin repetir el selector, y cada sección lo dice', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(() => { window.__selectores = 0; window.showDirectoryPicker = async () => { window.__selectores++; return navigator.storage.getDirectory(); }; });
    await gotoView(page, 'settings');
    await openSettingsTab(page, 'sync');
    await expect(page.locator('#assistantOn')).toHaveText('Elegir carpeta…');                 // aún no hay ninguna: solo se puede elegir
    await page.locator('#syncOn').click();                                                   // la primera se elige una vez
    await expect(page.locator('#syncOff')).toBeVisible();
    await expect(page.locator('#assistantSame0')).toContainText('Sincronización');            // ahora la IA ofrece usar esa misma
    await expect(page.locator('#assistantOn')).toHaveText('Elegir otra carpeta…');
    await page.locator('#assistantSame0').click();
    await expect(page.locator('#assistantOff')).toBeVisible();
    expect(await page.evaluate(() => window.__selectores)).toBe(1);                           // el selector del sistema se abrió una sola vez
    await expect(page.locator('#assistantSection .folder-shared')).toContainText('Sincronización');      // y cada sección dice con quién la comparte
    await expect(page.locator('#syncSection .folder-shared')).toContainText('Asistente de IA');

    const nombres = await page.evaluate(async () => { const d = await navigator.storage.getDirectory(); const n = []; for await (const [k] of d.entries()) n.push(k); return n.sort(); });
    expect(nombres.some(n => /^researchos-sync-.+\.json$/.test(n))).toBe(true);              // los archivos conviven sin pisarse
    expect(nombres).toEqual(expect.arrayContaining(['AGENTS.md', 'estado.json', 'cambios', 'resultados']));
    expect(await leer(page, 'AGENTS.md')).toContain('researchos-sync-*.json');                // la IA sabe que esos otros archivos no son suyos

    await openSettingsTab(page, 'data');
    await page.locator('#autoBackupSame0').click();                                          // la copia automática, igual
    await expect(page.locator('#autoBackupOff')).toBeVisible();
    await expect(page.locator('#autoBackupSection .folder-shared')).toContainText('Sincronización');
    await expect(page.locator('#autoBackupSection .folder-shared')).toContainText('Asistente de IA');
    expect(await leer(page, 'researchos-backup-latest.json')).toContain('"projects"');
    expect(await page.evaluate(() => window.__selectores)).toBe(1);

    await openSettingsTab(page, 'sync');                                                     // desactivar una no apaga las demás
    await page.locator('#assistantOff').click();
    await expect(page.locator('#assistantOn')).toBeVisible();
    expect(await page.evaluate(() => [SyncFolder.enabled(), AutoBackup.enabled(), Assistant.enabled()])).toEqual([true, true, false]);
    await expect(page.locator('#syncSection .folder-shared')).toContainText('Copia automática');
    await expect(page.locator('#syncSection .folder-shared')).not.toContainText('Asistente');
    const r = await page.evaluate(() => SyncFolder.syncNow({ quiet: true }));                 // la sincronización sigue sin tocar los archivos de la IA
    expect(r).toMatchObject({ added: 0, updated: 0, deleted: 0 });

    await page.locator('#assistantOn').click();                                              // elegir «otra» abre el selector y, si resulta ser la misma, también se detecta
    await expect(page.locator('#assistantOff')).toBeVisible();
    expect(await page.evaluate(() => window.__selectores)).toBe(2);
    await expect(page.locator('#assistantSection .folder-shared')).toContainText('Sincronización');
  });

  test('lo que viene de fuera no se duplica: «source», enlaces, notas y reuniones con hora; lo descartado o borrado no vuelve', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await activar(page);
    const [d2, d3] = await page.evaluate(() => [addDaysISO(2), addDaysISO(3)]);
    const res = async n => JSON.parse(await leer(page, 'resultados/' + n));
    await page.evaluate(() => Assistant.setMode('auto'));
    await dejar(page, 'o-1.json', { format: TIPO, author: 'skill', ops: [
      { op: 'add', type: 'task', set: { title: 'Responder a la editora', due: d2, project: 'Paper Alfa', notes: 'Pide la versión final', link: 'https://mail.google.com/mail/u/0/#inbox/18c3', source: 'gmail:18c3' } },
      { op: 'add', type: 'meeting', set: { title: 'Seminario del lab', date: d3, time: '10:00', duration: 90, participants: 'Dra. Vega', source: 'gcal:evt1' } },
      { op: 'add', type: 'task', set: { title: 'Enlace malo', link: 'javascript:alert(1)' } },
      { op: 'add', type: 'meeting', set: { title: 'Hora mala', date: d3, time: '25:99' } },
    ] });
    const tarea1 = await tarea(page, 'Responder a la editora');
    expect(tarea1).toMatchObject({ notes: 'Pide la versión final', link: 'https://mail.google.com/mail/u/0/#inbox/18c3', source: 'gmail:18c3' });
    expect(await page.evaluate(() => db.meetings.where('title').equals('Seminario del lab').first().then(m => [m.time, m.duration, m.source]))).toEqual(['10:00', 90, 'gcal:evt1']);
    const o1 = await res('o-1.json');
    expect(o1.ops.map(o => o.status)).toEqual(['applied', 'applied', 'error', 'error']);
    expect(o1.ops[2].error).toContain('link');                                              // un enlace que no es http(s) se rechaza
    expect(o1.ops[3].error).toContain('hora no válida');
    expect(await tarea(page, 'Enlace malo')).toBeUndefined();

    await dejar(page, 'o-2.json', { format: TIPO, author: 'skill', ops: [                  // repasar el correo y el calendario otra vez no duplica nada
      { op: 'add', type: 'task', set: { title: 'Responder a la editora (otra vez)', source: 'gmail:18c3' } },
      { op: 'add', type: 'meeting', set: { title: 'Seminario del lab', date: d3, source: 'gcal:evt1' } },
    ] });
    const o2 = await res('o-2.json');
    expect(o2.ops.map(o => o.status)).toEqual(['skipped', 'skipped']);
    expect(o2.ops[0].reason).toContain('mismo origen');
    expect(o2.ops[0].uid).toBe(tarea1.uid);                                                 // y le dice cuál ya existía
    expect(await page.evaluate(() => Promise.all([db.tasks.filter(t => t.source === 'gmail:18c3').count(), db.meetings.filter(m => m.source === 'gcal:evt1').count()]))).toEqual([1, 1]);

    await dejar(page, 'o-3.json', { format: TIPO, author: 'skill', ops: [{ op: 'complete', type: 'task', source: 'gmail:18c3' }] });     // se localiza por origen, sin uid
    expect((await tarea(page, 'Responder a la editora')).done).toBe(true);
    await dejar(page, 'o-3b.json', { format: TIPO, author: 'skill', ops: [{ op: 'complete', type: 'task', source: 'gmail:no-existe' }] });
    expect((await res('o-3b.json')).ops[0].error).toContain('no hay tarea con el origen');

    await page.evaluate(() => Assistant.setMode('review'));                                  // lo que descartas no vuelve a preguntarse
    await dejar(page, 'o-4.json', { format: TIPO, author: 'skill', ops: [{ op: 'add', type: 'task', set: { title: 'Cosa descartable', source: 'gmail:zz' } }] });
    await expect(page.locator('#assistantBar')).toContainText('propone');
    await page.locator('#assistantDiscardAll').click();
    await expect(page.locator('#assistantBar')).toHaveCount(0);
    await dejar(page, 'o-5.json', { format: TIPO, author: 'skill', ops: [{ op: 'add', type: 'task', set: { title: 'Cosa descartable', source: 'gmail:zz' } }] });
    const o5 = await res('o-5.json');
    expect(o5.ops[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('descartaste') });
    await expect(page.locator('#assistantBar')).toHaveCount(0);

    await page.evaluate(() => Assistant.setMode('auto'));                                    // y lo que borras a mano, tampoco
    await dejar(page, 'o-6.json', { format: TIPO, author: 'skill', ops: [{ op: 'add', type: 'task', set: { title: 'Borrable', source: 'gmail:del' } }] });
    await page.evaluate(async () => { const t = await db.tasks.filter(x => x.source === 'gmail:del').first(); await Tasks.remove(t.id); });
    await dejar(page, 'o-7.json', { format: TIPO, author: 'skill', ops: [{ op: 'add', type: 'task', set: { title: 'Borrable', source: 'gmail:del' } }] });
    expect((await res('o-7.json')).ops[0].status).toBe('skipped');
    expect(await tarea(page, 'Borrable')).toBeUndefined();

    const estado = JSON.parse(await leer(page, 'estado.json'));                              // la IA ve el origen, el enlace y la hora en el estado
    expect(estado.tasks.find(t => t.title === 'Responder a la editora')).toMatchObject({ source: 'gmail:18c3', link: 'https://mail.google.com/mail/u/0/#inbox/18c3', notes: 'Pide la versión final' });
    expect(estado.meetings.find(m => m.title === 'Seminario del lab')).toMatchObject({ time: '10:00', duration: 90, source: 'gcal:evt1' });
    expect(await leer(page, 'AGENTS.md')).toContain('gmail:<id del hilo>');                  // y las instrucciones se lo explican

    await page.evaluate(d => Tasks.add({ title: 'Con origen', due: d, source: 'gmail:abc', link: 'https://example.org/x' }), d2);       // la herramienta lo conoce
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-ia-'));
    await page.evaluate(() => Assistant.syncNow());
    fs.writeFileSync(path.join(dir, 'estado.json'), await leer(page, 'estado.json'));
    const env = await R.callTool('researchos_add_meeting', { title: 'Comité', date: d3, time: '15:00', duration: 60, source: 'gcal:evt2', action_items: ['Llevar acta'] }, { dir });
    const lote = JSON.parse(fs.readFileSync(path.join(dir, env.file), 'utf8'));
    expect(lote.ops[0]).toEqual({ op: 'add', type: 'meeting', set: { title: 'Comité', date: d3, time: '15:00', duration: 60, source: 'gcal:evt2', addActionItems: ['Llevar acta'] } });
    await R.callTool('researchos_complete_task', { source: 'gmail:abc' }, { dir });
    const lotes = fs.readdirSync(path.join(dir, 'cambios')).map(n => [n, JSON.parse(fs.readFileSync(path.join(dir, 'cambios', n), 'utf8'))]);       // el orden de los archivos no importa
    expect(lotes.map(([, l]) => l.ops[0].op).sort()).toEqual(['add', 'complete']);
    expect(lotes.find(([, l]) => l.ops[0].op === 'complete')[1].ops[0]).toEqual({ op: 'complete', type: 'task', source: 'gmail:abc' });
    for (const [n, l] of lotes) await dejar(page, n, l);
    expect(await page.evaluate(() => db.meetings.where('title').equals('Comité').first().then(m => [m.time, m.duration, m.source, m.actionItems.length]))).toEqual(['15:00', 60, 'gcal:evt2', 1]);
    expect((await tarea(page, 'Con origen')).done).toBe(true);
  });

  test('la IA edita personas, mueve papers por Submissions y gestiona referencias y snippets', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await activar(page);
    const res = async n => JSON.parse(await leer(page, 'resultados/' + n));
    const proyecto = t => page.evaluate(t => db.projects.where('title').equals(t).first(), t);
    await page.evaluate(() => Assistant.setMode('auto'));

    await dejar(page, 'q-1.json', { format: TIPO, author: 'ia', ops: [                      // personas: antes solo se podían añadir
      { op: 'update', type: 'person', match: 'Dra. Vega', set: { role: 'Postdoc', affiliation: 'UChile', followUpDays: 14, lastContact: '2026-10-20', notes: 'Prefiere correo' } },
      { op: 'add', type: 'person', set: { name: 'Dr. Soto', followUpDays: 30 } },
      { op: 'update', type: 'person', match: 'Dra. Vega', set: { followUpDays: 10 } },
    ] });
    const vega = await page.evaluate(() => db.collaborators.where('name').equals('Dra. Vega').first());
    expect(vega).toMatchObject({ role: 'Postdoc', affiliation: 'UChile', followUpDays: 14, lastContact: '2026-10-20', notes: 'Prefiere correo', email: 'vega@uni.cl' });
    const q1 = await res('q-1.json');
    expect(q1.ops.map(o => o.status)).toEqual(['applied', 'applied', 'error']);
    expect(q1.ops[2].error).toContain('followUpDays');
    expect(await page.evaluate(() => db.collaborators.where('name').equals('Dr. Soto').first().then(c => c.followUpDays))).toBe(30);

    await page.evaluate(async () => {                                                      // el tablero sigue al pipeline (opción de la app)
      const cols = await db.kanbanColumns.orderBy('order').toArray();
      await db.settings.put({ key: 'ros-auto-sync-paper-col', value: 'true' });
      await db.settings.put({ key: 'ros-sub-col-map', value: JSON.stringify({ aceptado: cols.at(-1).id }) });
    });
    const colAntes = (await proyecto('Paper Alfa')).columnId;
    await dejar(page, 'q-2.json', { format: TIPO, author: 'ia', ops: [                      // papers en Submissions
      { op: 'update', type: 'project', match: 'Paper Alfa', set: { submissionStatus: 'En revisión', targetVenue: 'Nature', submissionNotes: 'Revisor 2 es duro', coauthors: 'dra. vega, Externo X',
        addSubmissionRounds: [{ submittedAt: '2026-10-01', decision: 'major', decisionDate: '2026-10-20', venue: 'Nature', notes: 'R&R' }] } },
      { op: 'update', type: 'project', match: 'Dataset Beta', set: { submissionStatus: 'enviado' } },
      { op: 'add', type: 'project', set: { title: 'Artículo nuevo', type: 'paper', submissionStatus: 'enviado', targetVenue: 'PLOS ONE' } },
      { op: 'update', type: 'project', match: 'Grant Gamma', set: { type: 'Tesis' } },
      { op: 'update', type: 'project', match: 'Paper Alfa', set: { submissionStatus: 'inventado' } },
      { op: 'update', type: 'project', match: 'Paper Alfa', set: { submissionRounds: [{ decision: 'quizás' }] } },
    ] });
    const q2 = await res('q-2.json');
    expect(q2.ops.map(o => o.status)).toEqual(['applied', 'error', 'applied', 'error', 'error', 'error']);
    expect(q2.ops[1].error).toContain('solo aplica a proyectos de tipo Paper');             // un proyecto que no es Paper no aparecería en Submissions
    expect(q2.ops[3].error).toContain('Proyecto, Grant, Paper');
    expect(q2.ops[4].error).toContain('preparacion, enviado, en_revision');
    expect(q2.ops[5].error).toContain('decision');
    const alfa = await proyecto('Paper Alfa');
    expect(alfa).toMatchObject({ submissionStatus: 'en_revision', targetVenue: 'Nature', submissionNotes: 'Revisor 2 es duro', coauthors: ['Dra. Vega', 'Externo X'], coauthorIds: [vega.id] });
    expect(alfa.submissionRounds).toMatchObject([{ submittedAt: '2026-10-01', decision: 'major', decisionDate: '2026-10-20', venue: 'Nature', notes: 'R&R' }]);
    expect(alfa.submissionStatusHistory).toMatchObject([{ from: null, to: 'en_revision' }]);
    expect(await proyecto('Dataset Beta')).not.toHaveProperty('submissionStatus');
    const nuevo = await proyecto('Artículo nuevo');
    expect(nuevo).toMatchObject({ type: 'Paper', submissionStatus: 'enviado', targetVenue: 'PLOS ONE' });
    expect(nuevo.submittedAt).toBe(await page.evaluate(() => localDateISO()));              // al pasar a «enviado» se anota la fecha, como en el pipeline
    await gotoView(page, 'submissions');
    await expect(page.locator('#mainContent')).toContainText('Artículo nuevo');
    await expect(page.locator('#mainContent')).toContainText('Paper Alfa');

    await dejar(page, 'q-3.json', { format: TIPO, author: 'ia', ops: [{ op: 'update', type: 'project', match: 'Paper Alfa', set: { submissionStatus: 'aceptado' } }] });
    const aceptado = await proyecto('Paper Alfa');
    expect(aceptado.submissionStatus).toBe('aceptado');
    expect(aceptado.columnId).not.toBe(colAntes);                                          // y la columna del tablero se movió con él
    await page.locator('.toast-undo-btn').last().click();                                   // deshacer devuelve las dos cosas
    await expect.poll(async () => (await proyecto('Paper Alfa')).submissionStatus).toBe('en_revision');
    expect((await proyecto('Paper Alfa')).columnId).toBe(colAntes);

    await dejar(page, 'q-4.json', { format: TIPO, author: 'ia', ops: [                      // bibliografía y código
      { op: 'add', type: 'reference', set: { title: 'Mixed models in R', authors: 'Bates, D.', year: 2015, journal: 'JSS', doi: '10.18637/jss.v067.i01', url: 'https://www.jstatsoft.org/article/view/v067i01',
        project: 'Paper Alfa', tags: ['lme4', 'estadística'], readStatus: 'leyendo', source: 'zotero:abc' } },
      { op: 'add', type: 'reference', set: { title: 'Mala', url: 'javascript:alert(1)' } },
      { op: 'add', type: 'snippet', set: { title: 'Modelo mixto', language: 'r', code: 'lmer(y ~ x + (1|g), data = d)', project: 'Paper Alfa', tags: 'R, modelos' } },
      { op: 'add', type: 'snippet', set: { title: 'Sin código' } },
      { op: 'add', type: 'reference', set: { title: 'Mixed models in R (repetida)', source: 'zotero:abc' } },
    ] });
    const q4 = await res('q-4.json');
    expect(q4.ops.map(o => o.status)).toEqual(['applied', 'error', 'applied', 'error', 'skipped']);
    expect(q4.ops[1].error).toContain('http');
    expect(q4.ops[3].error).toContain('code');
    await dejar(page, 'q-4b.json', { format: TIPO, author: 'ia', ops: [{ op: 'update', type: 'reference', source: 'zotero:abc', set: { readStatus: 'read', notes: 'Capítulo 3 útil' } }] });      // se localiza por su origen
    expect((await res('q-4b.json')).ops[0].status).toBe('applied');
    const ref = await page.evaluate(() => db.references.where('title').equals('Mixed models in R').first());
    expect(ref).toMatchObject({ year: 2015, journal: 'JSS', tags: ['lme4', 'estadística'], readStatus: 'read', notes: 'Capítulo 3 útil', source: 'zotero:abc', projectId: alfa.id });
    expect(ref.readAt).toBeTruthy();
    const snip = await page.evaluate(() => db.snippets.where('title').equals('Modelo mixto').first());
    expect(snip).toMatchObject({ language: 'R', projectId: alfa.id, projectIds: [alfa.id], tags: ['R', 'modelos'] });

    const estado = JSON.parse(await leer(page, 'estado.json'));                              // la IA ve todo esto en el estado y las instrucciones se lo cuentan
    expect(estado.projectTypes).toContain('Paper');
    expect(estado.submissionStages.map(e => e.key)).toContain('en_revision');
    expect(estado.projects.find(p => p.title === 'Paper Alfa')).toMatchObject({ submissionStatus: 'en_revision', targetVenue: 'Nature', submissionRounds: [{ decision: 'major' }] });
    expect(estado.people.find(p => p.name === 'Dra. Vega')).toMatchObject({ role: 'Postdoc', followUpDays: 14, notes: 'Prefiere correo' });
    expect(estado.references.find(r => r.title === 'Mixed models in R')).toMatchObject({ project: 'Paper Alfa', readStatus: 'read', source: 'zotero:abc' });
    expect(estado.snippets.find(r => r.title === 'Modelo mixto')).toMatchObject({ language: 'R', project: 'Paper Alfa', code: 'lmer(y ~ x + (1|g), data = d)' });
    const agents = await leer(page, 'AGENTS.md');
    for (const t of ['submissionStatus', 'addSubmissionRounds', 'followUpDays', '`reference`', '`snippet`']) expect(agents).toContain(t);

    await page.evaluate(() => Assistant.setMode('review'));                                  // borrar referencias y snippets siempre se revisa
    await dejar(page, 'q-5.json', { format: TIPO, author: 'ia', ops: [{ op: 'delete', type: 'reference', match: 'Mixed models in R' }, { op: 'delete', type: 'snippet', match: 'Modelo mixto' }] });
    expect(await page.evaluate(() => db.references.count())).toBe(2);
    await page.locator('#assistantReview').click();
    await expect(page.locator('#modalContent')).toContainText('⚠ borrado');
    await page.locator('#asstApply').click();
    await expect.poll(() => page.evaluate(() => Promise.all([db.references.count(), db.snippets.count()]))).toEqual([1, 1]);       // quedan los del ejemplo
  });

  test('la herramienta para agentes también llega a proyectos, personas, referencias y snippets (biblioteca y CLI)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await activar(page);
    await page.evaluate(() => Assistant.setMode('auto'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-ia-'));
    fs.writeFileSync(path.join(dir, 'estado.json'), await leer(page, 'estado.json'));
    const lote = nombre => JSON.parse(fs.readFileSync(path.join(dir, nombre), 'utf8'));
    const nuevos = () => fs.readdirSync(path.join(dir, 'cambios')).filter(n => n.endsWith('.json')).map(n => 'cambios/' + n);

    await R.callTool('researchos_update', { type: 'project', ref: 'Paper Alfa', set: { submissionStatus: 'en_revision', targetVenue: 'Nature' } }, { dir });
    await R.callTool('researchos_update', { type: 'person', ref: 'vega', set: { role: 'Postdoc', followUpDays: 14 } }, { dir });
    await R.callTool('researchos_add', { type: 'reference', set: { title: 'Un artículo', year: 2020 } }, { dir });
    await R.callTool('researchos_add', { type: 'snippet', set: { title: 'Gráfico', code: 'plot(x)' } }, { dir });
    execFileSync(process.execPath, [TOOL, '--dir', dir, 'cambiar', 'proyecto', 'Dataset Beta', 'type=Paper', 'submissionStatus=enviado', 'targetVenue=Zenodo']);
    execFileSync(process.execPath, [TOOL, '--dir', dir, 'añadir', 'persona', 'Dr. Soto', 'followUpDays=30', 'role=Estadístico']);
    expect(JSON.parse(execFileSync(process.execPath, [TOOL, '--dir', dir, 'referencias', '--json'])).map(r => r.title)).toEqual(['A unifying framework']);   // lo que aún no se aplicó no está en el estado
    await expect(R.callTool('researchos_update', { type: 'planeta', ref: 'x', set: {} }, { dir })).rejects.toThrow('tipo «planeta» desconocido');
    await expect(R.callTool('researchos_update', { type: 'person', ref: 'nadie', set: {} }, { dir })).rejects.toThrow('no hay persona');

    const todos = nuevos().map(lote);
    expect(todos.flatMap(l => l.ops).map(o => `${o.op}:${o.type}`).sort()).toEqual(['add:person', 'add:reference', 'add:snippet', 'update:person', 'update:project', 'update:project']);
    expect(todos.flatMap(l => l.ops).find(o => o.type === 'project' && o.set.targetVenue === 'Nature')).toMatchObject({ op: 'update', uid: expect.stringMatching(/[0-9a-f-]{16,}/) });
    expect(todos.flatMap(l => l.ops).find(o => o.type === 'project' && o.set.targetVenue === 'Zenodo').set).toEqual({ type: 'Paper', submissionStatus: 'enviado', targetVenue: 'Zenodo' });
    expect(todos.flatMap(l => l.ops).find(o => o.type === 'person' && o.op === 'add').set).toEqual({ name: 'Dr. Soto', followUpDays: 30, role: 'Estadístico' });   // los números llegan como números

    for (const n of fs.readdirSync(path.join(dir, 'cambios'))) await dejar(page, n, lote('cambios/' + n));                               // y la app los entiende
    expect(await page.evaluate(() => db.projects.where('title').equals('Paper Alfa').first().then(p => [p.submissionStatus, p.targetVenue]))).toEqual(['en_revision', 'Nature']);
    expect(await page.evaluate(() => db.projects.where('title').equals('Dataset Beta').first().then(p => [p.type, p.submissionStatus]))).toEqual(['Paper', 'enviado']);
    expect(await page.evaluate(() => db.collaborators.where('name').equals('Dra. Vega').first().then(c => [c.role, c.followUpDays]))).toEqual(['Postdoc', 14]);
    expect(await page.evaluate(() => Promise.all([db.references.where('title').equals('Un artículo').count(), db.snippets.where('title').equals('Gráfico').count(), db.collaborators.where('name').equals('Dr. Soto').count()]))).toEqual([1, 1, 1]);
  });

  test('por defecto la IA no borra proyectos ni toca los ajustes; con «Control total de los datos» sí (sin revisión en automático) y se puede deshacer', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const ids = await page.evaluate(async () => {
      const alfa = await db.projects.where('title').equals('Paper Alfa').first(), vega = await db.collaborators.where('name').equals('Dra. Vega').first();
      await Tasks.add({ title: 'Con responsable', projectId: alfa.id, assigneeId: vega.id });
      const col = await createCollection('Gráficos');
      await db.snippets.where('title').equals('Snippet ggplot').modify({ collectionId: col });
      await db.projects.where('title').equals('Dataset Beta').modify({ archived: true });
      const old = await Tasks.add({ title: 'Tarea vieja', projectId: null });
      await db.tasks.update(old, { done: true, doneAt: '2020-01-01T00:00:00.000Z' });
      await db.meetings.add({ title: 'Reunión vieja', date: '2020-01-01', participants: '', agreements: '', projectId: null, actionItems: [], createdAt: '2020-01-01', updatedAt: '2020-01-01' });
      return { alfa: alfa.id, vega: vega.id, col };
    });
    await activar(page);
    const res = async n => JSON.parse(await leer(page, 'resultados/' + n));
    await page.evaluate(() => Assistant.setMode('auto'));

    const agents0 = await leer(page, 'AGENTS.md');                                          // sin permisos: la IA lo sabe y no puede
    expect(agents0).toContain('Control total de los datos: desactivado');
    expect(agents0).toContain('Ajustes de la app: desactivados');
    const e0 = JSON.parse(await leer(page, 'estado.json'));
    expect(e0.permissions).toEqual({ fullControl: false, appSettings: false });
    expect(e0.archivedProjects.map(p => p.title)).toEqual(['Dataset Beta']);                // los archivados se ven aunque no se puedan borrar
    expect(e0.tasks.map(t => t.title)).not.toContain('Tarea vieja');                        // y lo antiguo se recorta
    expect(e0.meetings.map(m => m.title)).not.toContain('Reunión vieja');
    await dejar(page, 'f-1.json', { format: TIPO, author: 'ia', ops: [
      { op: 'delete', type: 'project', match: 'Paper Alfa' },
      { op: 'delete', type: 'person', match: 'Dra. Vega' },
      { op: 'delete', type: 'meeting', match: 'Reunión de avance' },
      { op: 'add', type: 'area', set: { name: 'Docencia' } },
      { op: 'update', type: 'setting', set: { dailyMinutes: 300 } },
    ] });
    const f1 = await res('f-1.json');
    expect(f1.ops.map(o => o.status)).toEqual(['error', 'error', 'error', 'error', 'error']);
    expect(f1.ops[0].error).toContain('Control total de los datos');
    expect(f1.ops[3].error).toContain('Ajustes de la app');
    expect(await page.evaluate(() => Promise.all([db.projects.count(), db.collaborators.count(), db.meetings.count()]))).toEqual([3, 1, 2]);

    await gotoView(page, 'settings'); await openSettingsTab(page, 'sync');                  // se activa desde Ajustes, con aviso
    await page.locator('label.toggle-switch:has(#assistantFull)').click();
    await expect(page.locator('#confirmYes')).toBeVisible();
    await page.locator('#confirmNo').click();
    await expect(page.locator('#assistantFull')).not.toBeChecked();                           // cancelar no activa nada
    expect(await page.evaluate(() => Assistant.fullControl())).toBe(false);
    await page.locator('label.toggle-switch:has(#assistantFull)').click();
    await page.locator('#confirmYes').click();
    await expect.poll(() => page.evaluate(() => Assistant.fullControl())).toBe(true);
    await expect.poll(async () => leer(page, 'AGENTS.md')).toContain('Control total de los datos: ACTIVADO');
    const e1 = JSON.parse(await leer(page, 'estado.json'));
    expect(e1.permissions.fullControl).toBe(true);
    expect(e1.tasks.map(t => t.title)).toContain('Tarea vieja');                             // con el control total la IA ve todo, sin recortes
    expect(e1.meetings.map(m => m.title)).toContain('Reunión vieja');

    await dejar(page, 'f-2.json', { format: TIPO, author: 'ia', ops: [
      { op: 'delete', type: 'project', match: 'Paper Alfa' },
      { op: 'delete', type: 'person', match: 'Dra. Vega' },
      { op: 'delete', type: 'meeting', match: 'Reunión de avance' },
      { op: 'delete', type: 'collection', match: 'Gráficos' },
    ] });
    expect((await res('f-2.json')).ops.map(o => o.status)).toEqual(['applied', 'applied', 'applied', 'applied']);      // en automático no esperan revisión
    await expect(page.locator('#assistantBar')).toHaveCount(0);
    expect(await page.evaluate(() => Promise.all([db.projects.where('title').equals('Paper Alfa').count(), db.collaborators.count(), db.meetings.where('title').equals('Reunión de avance').count(), db.snippetCollections.count()]))).toEqual([0, 0, 0, 0]);
    expect(await page.evaluate(() => db.tasks.filter(t => t.title === 'Con responsable').first().then(t => t ? [t.projectId, t.assigneeId] : 'no existe'))).toEqual([null, null]);     // nada queda apuntando a lo borrado
    expect(await page.evaluate(() => db.snippets.where('title').equals('Snippet ggplot').first().then(x => x.collectionId))).toBeNull();

    await page.locator('.toast-undo-btn').last().click();                                    // y se deshace todo de una vez
    await expect.poll(() => page.evaluate(() => db.projects.where('title').equals('Paper Alfa').count())).toBe(1);
    expect(await page.evaluate(() => Promise.all([db.collaborators.count(), db.meetings.where('title').equals('Reunión de avance').count(), db.snippetCollections.count()]))).toEqual([1, 1, 1]);
    expect(await tarea(page, 'Con responsable')).toMatchObject({ projectId: ids.alfa, assigneeId: ids.vega });
    expect(await page.evaluate(() => db.snippets.where('title').equals('Snippet ggplot').first().then(x => x.collectionId))).toBe(ids.col);

    await page.evaluate(() => Assistant.setMode('review'));                                  // en modo «revisar» el control total no se salta la revisión
    await dejar(page, 'f-3.json', { format: TIPO, author: 'ia', ops: [{ op: 'delete', type: 'person', match: 'Dra. Vega' }] });
    await expect(page.locator('#assistantBar')).toContainText('propone');
    expect(await page.evaluate(() => db.collaborators.count())).toBe(1);
    await page.locator('#assistantReview').click();
    await expect(page.locator('#modalContent')).toContainText('⚠ borrado');
    await page.locator('#asstApply').click();
    await expect.poll(() => page.evaluate(() => db.collaborators.count())).toBe(0);

    await gotoView(page, 'settings'); await openSettingsTab(page, 'sync');                  // y se puede volver a quitar
    await page.locator('label.toggle-switch:has(#assistantFull)').click();
    await expect.poll(() => page.evaluate(() => Assistant.fullControl())).toBe(false);
    await expect.poll(async () => leer(page, 'AGENTS.md')).toContain('Control total de los datos: desactivado');
  });

  test('con «Ajustes de la app» la IA llega a áreas, columnas, etapas de Submissions, campos por tipo y horas útiles; todo se deshace', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await activar(page);
    const res = async n => JSON.parse(await leer(page, 'resultados/' + n));
    await page.evaluate(() => { Assistant.setMode('auto'); Assistant.setPermission('config', true); });
    await page.evaluate(() => Assistant.syncNow());
    expect(await leer(page, 'AGENTS.md')).toContain('**setting**');
    const proyecto = t => page.evaluate(t => db.projects.where('title').equals(t).first(), t);

    await dejar(page, 'g-1.json', { format: TIPO, author: 'ia', ops: [
      { op: 'add', type: 'area', set: { name: 'Docencia', description: 'Clases y tesis', color: '#10b981' } },
      { op: 'add', type: 'column', set: { title: 'Revisión interna', wip: 2, position: 2 } },
      { op: 'update', type: 'setting', set: { dailyMinutes: 300, profile: 'Investigación', theme: 'claro', accent: 'verde', syncPaperColumn: true } },
      { op: 'update', type: 'setting', set: { submissionColumnMap: { enviado: 'Revisión interna' } } },
      { op: 'update', type: 'setting', set: { projectFields: { Paper: [{ key: 'targetJournal', label: 'Journal objetivo' }, { key: 'wordCount', label: 'Palabras', type: 'number' }] } } },
      { op: 'update', type: 'setting', set: { submissionStages: [{ key: 'preparacion', label: 'En preparación' }, { key: 'interna', label: 'Revisión interna', color: '#f59e0b' }, { key: 'enviado', label: 'Enviado' }, { key: 'aceptado', label: 'Aceptado' }] } },
      { op: 'update', type: 'setting', set: { dailyMinutes: 5 } },
      { op: 'update', type: 'setting', set: { accent: 'rojo' } },
    ] });
    const g1 = await res('g-1.json');
    expect(g1.ops.map(o => o.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'error', 'error']);
    expect(g1.ops[6].error).toContain('30–960');
    expect(g1.ops[7].error).toContain('blue, green o purple');
    const cols = await page.evaluate(() => db.kanbanColumns.orderBy('order').toArray().then(c => c.map(x => [x.title, x.wip])));
    expect(cols[1]).toEqual(['Revisión interna', 2]);                                         // «position: 2» la dejó en el segundo lugar
    const estado = async () => JSON.parse(await leer(page, 'estado.json'));
    expect((await estado()).areas).toMatchObject([{ name: 'Docencia', description: 'Clases y tesis', color: '#10b981' }]);
    const ajustes = await page.evaluate(async () => ({ min: Capacity.get(), perfil: NavProfile.get(), tema: document.documentElement.getAttribute('data-theme'), acento: document.documentElement.getAttribute('data-accent'),
      sync: (await db.settings.get('ros-auto-sync-paper-col')).value, etapas: SUB_STATUSES.map(x => x.key), mapa: await _getSubColMapping(), campos: (await _getTypeSchemas()).Paper.map(f => [f.key, f.type]) }));
    expect(ajustes).toMatchObject({ min: 300, perfil: 'research', tema: 'light', acento: 'green', sync: 'true', etapas: ['preparacion', 'interna', 'enviado', 'aceptado'], campos: [['targetJournal', 'text'], ['wordCount', 'number']] });
    expect(Object.keys(ajustes.mapa)).toEqual(['enviado']);
    const e = await estado();                                                                  // y la IA ve cómo quedó
    expect(e.settings).toMatchObject({ dailyMinutes: 300, profile: 'research', syncPaperColumn: true, submissionColumnMap: { enviado: 'Revisión interna' } });
    expect(e.settings.submissionStages.map(x => x.key)).toEqual(['preparacion', 'interna', 'enviado', 'aceptado']);
    expect(e.columnsInfo.map(c => c.title)[1]).toBe('Revisión interna');

    await dejar(page, 'g-2.json', { format: TIPO, author: 'ia', ops: [                        // campos por tipo y etapas
      { op: 'update', type: 'project', match: 'Paper Alfa', set: { submissionStatus: 'interna', customFields: { wordCount: '8500', targetJournal: 'Nature' }, area: 'Docencia' } },
      { op: 'update', type: 'project', match: 'Paper Alfa', set: { customFields: { inventado: 1 } } },
      { op: 'update', type: 'project', match: 'Paper Alfa', set: { customFields: { wordCount: 'muchas' } } },
      { op: 'update', type: 'setting', set: { submissionStages: [{ key: 'preparacion' }, { key: 'enviado' }] } },
      { op: 'update', type: 'project', match: 'Dataset Beta', set: { column: 'Revisión interna' } },
    ] });
    const g2 = await res('g-2.json');
    expect(g2.ops.map(o => o.status)).toEqual(['applied', 'error', 'error', 'error', 'applied']);
    expect(g2.ops[1].error).toContain('Campos: targetJournal, wordCount');
    expect(g2.ops[3].error).toContain('no se pueden quitar etapas en uso');                   // «Paper Alfa» sigue en «interna»
    const alfa = await proyecto('Paper Alfa');
    expect(alfa).toMatchObject({ submissionStatus: 'interna', customFields: { wordCount: 8500, targetJournal: 'Nature' } });
    expect(alfa.areaId).toBeGreaterThan(0);
    expect((await estado()).projects.find(p => p.title === 'Paper Alfa').customFields).toEqual({ wordCount: 8500, targetJournal: 'Nature' });

    await dejar(page, 'g-3.json', { format: TIPO, author: 'ia', ops: [                        // borrar áreas y columnas deja todo coherente
      { op: 'update', type: 'area', match: 'Docencia', set: { color: '#ef4444' } },
      { op: 'delete', type: 'area', match: 'Docencia' },
      { op: 'delete', type: 'column', match: 'Revisión interna' },
    ] });
    expect((await res('g-3.json')).ops.map(o => o.status)).toEqual(['applied', 'pending', 'pending']);       // los ajustes se aplican solos, pero borrar sigue necesitando revisión sin el control total
    await page.locator('#assistantDiscardAll').click();
    expect(await page.evaluate(() => _getAreas().then(a => a.map(x => x.color)))).toEqual(['#ef4444']);
    await page.evaluate(() => Assistant.setPermission('full', true));
    await dejar(page, 'g-3b.json', { format: TIPO, author: 'ia', ops: [{ op: 'delete', type: 'area', match: 'Docencia' }, { op: 'delete', type: 'column', match: 'Revisión interna' }] });
    expect((await res('g-3b.json')).ops.map(o => o.status)).toEqual(['applied', 'applied']);
    expect((await proyecto('Paper Alfa')).areaId).toBeNull();
    expect(await page.evaluate(() => _getAreas().then(a => a.length))).toBe(0);
    const columnas = await page.evaluate(() => db.kanbanColumns.toArray().then(c => c.map(x => x.title)));
    expect(columnas).not.toContain('Revisión interna');
    const beta = await proyecto('Dataset Beta');
    expect(columnas).toContain(await page.evaluate(id => db.kanbanColumns.get(id).then(c => c.title), beta.columnId));       // su proyecto no quedó en una columna que ya no existe

    await page.locator('.toast-undo-btn').last().click();                                    // deshacer devuelve área, columna y proyectos
    await expect.poll(() => page.evaluate(() => db.kanbanColumns.where('title').equals('Revisión interna').count())).toBe(1);
    expect(await page.evaluate(() => _getAreas().then(a => a.map(x => x.name)))).toEqual(['Docencia']);
    expect((await proyecto('Paper Alfa')).areaId).toBeGreaterThan(0);
    const colInterna = await page.evaluate(() => db.kanbanColumns.where('title').equals('Revisión interna').first().then(c => c.id));
    expect((await proyecto('Dataset Beta')).columnId).toBe(colInterna);

    await page.evaluate(() => { Assistant.setPermission('config', false); });                // y si se quita el permiso, los ajustes vuelven a ser inalcanzables
    await dejar(page, 'g-5.json', { format: TIPO, author: 'ia', ops: [{ op: 'update', type: 'setting', set: { dailyMinutes: 120 } }] });
    expect((await res('g-5.json')).ops[0].error).toContain('Ajustes de la app');
    expect(await page.evaluate(() => Capacity.get())).toBe(300);
  });

  test('la herramienta para agentes conoce los permisos: borrar, áreas, columnas y ajustes (biblioteca y CLI)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await activar(page);
    await page.evaluate(() => { Assistant.setPermission('full', true); Assistant.setPermission('config', true); });
    await page.evaluate(() => Assistant.syncNow());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-ia-'));
    fs.writeFileSync(path.join(dir, 'estado.json'), await leer(page, 'estado.json'));
    const ops = () => fs.readdirSync(path.join(dir, 'cambios')).filter(n => n.endsWith('.json')).flatMap(n => JSON.parse(fs.readFileSync(path.join(dir, 'cambios', n), 'utf8')).ops);

    expect((await R.callTool('researchos_overview', {}, { dir })).permissions).toEqual({ fullControl: true, appSettings: true });
    await R.callTool('researchos_delete', { type: 'project', ref: 'Paper Alfa' }, { dir });
    await R.callTool('researchos_update', { type: 'setting', set: { dailyMinutes: 300 } }, { dir });
    await R.callTool('researchos_add', { type: 'area', set: { name: 'Docencia' } }, { dir });
    execFileSync(process.execPath, [TOOL, '--dir', dir, 'cambiar', 'ajuste', 'dailyMinutes=240', 'profile=research']);
    execFileSync(process.execPath, [TOOL, '--dir', dir, 'eliminar', 'persona', 'Vega']);
    expect(JSON.parse(execFileSync(process.execPath, [TOOL, '--dir', dir, 'columnas', '--json'])).length).toBeGreaterThan(1);
    const todas = ops();
    expect(todas.find(o => o.op === 'delete' && o.type === 'project')).toMatchObject({ uid: expect.stringMatching(/[0-9a-f-]{16,}/) });
    expect(todas.filter(o => o.type === 'setting').map(o => o.set).sort((a, b) => a.dailyMinutes - b.dailyMinutes)).toEqual([{ dailyMinutes: 240, profile: 'research' }, { dailyMinutes: 300 }]);      // sin uid ni match: es un único registro
    expect(todas.filter(o => o.type === 'setting').every(o => !('uid' in o))).toBe(true);
    expect(todas.find(o => o.op === 'delete' && o.type === 'person')).toBeTruthy();
    await page.evaluate(() => Assistant.setMode('auto'));
    for (const n of fs.readdirSync(path.join(dir, 'cambios'))) await dejar(page, n, JSON.parse(fs.readFileSync(path.join(dir, 'cambios', n), 'utf8')));       // y la app los aplica
    expect(await page.evaluate(() => Promise.all([db.projects.where('title').equals('Paper Alfa').count(), db.collaborators.count(), Capacity.get(), NavProfile.get()]))).toEqual([0, 0, 300, 'research']);
  });

  test('un lote puede crear y relacionar (id temporales «#p1»), avisa de lo que no cambió, liga tareas al calendario, anida áreas y muestra qué cambió la persona; lo privado no existe para la IA', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await activar(page);
    const res = async n => JSON.parse(await leer(page, 'resultados/' + n));
    await page.evaluate(async () => {
      Assistant.setMode('auto'); Assistant.setPermission('config', true);
      const cols = await db.kanbanColumns.orderBy('order').toArray();
      await db.kanbanColumns.update(cols[1].id, { types: ['Curso'] });                      // una columna solo para cursos
    });
    const [d1, d2, d3] = await page.evaluate(() => [addDaysISO(2), addDaysISO(3), addDaysISO(4)]);

    const lote = { format: TIPO, author: 'ia', ops: [
      { op: 'add', id: 'p1', type: 'project', set: { title: 'Curso de estadística', type: 'Curso' } },
      { op: 'add', id: 't1', type: 'task', set: { title: 'Pedir datos', project: '#p1', owner: 'Dra. Vega', spent: 20 } },
      { op: 'add', id: 't2', type: 'task', set: { title: 'Analizar', project: '#p1', after: ['#t1'], rank: 3 } },
      { op: 'update', type: 'project', uid: '#p1', set: { paused: true, pauseReason: 'Paro', pausedUntil: d3 } },
      { op: 'update', type: 'task', uid: '#t2', set: { rank: 3 } },
      { op: 'update', type: 'task', uid: '#nadie', set: { rank: 1 } },
      { op: 'update', type: 'project', uid: '#t1', set: { rank: 1 } },
      { op: 'add', id: 'm1', type: 'meeting', set: { title: 'Eureka', date: d1, time: '10:00', duration: 60, source: 'gcal:e1', repeat: 'weekly' } },
      { op: 'add', type: 'task', set: { title: 'Preparar Eureka', event: 'gcal:e1' } },
      { op: 'update', type: 'meeting', uid: '#m1', set: { date: d2, duration: 90 } },
      { op: 'add', id: 'a1', type: 'area', set: { name: 'Docencia' } },
      { op: 'add', type: 'area', set: { name: 'Posgrado', parent: '#a1' } },
      { op: 'update', type: 'person', match: 'Dra. Vega', source: 'x', set: { role: 'Postdoc' } },
    ] };
    await page.evaluate(async ([n, t]) => {                                                  // sin esperar: la IA ve enseguida que el archivo llegó
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('cambios', { create: true });
      const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(t); await w.close();
      await Assistant.syncNow();
    }, ['h-1.json', JSON.stringify(lote)]);
    expect((await res('h-1.json')).status).toBe('received');
    await page.waitForTimeout(1700); await page.evaluate(() => Assistant.syncNow());
    const h1 = await res('h-1.json');
    expect(h1.status).toBe('done');
    expect(h1.ops.map(o => o.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied', 'error', 'error', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied']);
    expect(h1.ops[4].warnings).toEqual(['sin cambios: ya tenía esos valores']);
    expect(h1.ops[5].error).toContain('«#nadie» no está definido antes');
    expect(h1.ops[6].error).toContain('es tarea, no proyecto');
    expect(h1.ops[12].warnings[0]).toContain('«source» solo sirve para localizar');

    const db_ = (q, a) => page.evaluate(`(${q})(${JSON.stringify(a ?? null)})`);
    const curso = await db_(async () => db.projects.where('title').equals('Curso de estadística').first());
    const cols = await db_(async () => db.kanbanColumns.orderBy('order').toArray());
    expect(curso).toMatchObject({ type: 'Curso', paused: true, pauseReason: 'Paro', pausedUntil: d3, columnId: cols[1].id });   // los cursos parten en su columna
    const t1 = await tarea(page, 'Pedir datos'), t2 = await tarea(page, 'Analizar');
    expect(t1).toMatchObject({ projectId: curso.id, spent: 20 }); expect(t1.ownerId).toBeGreaterThan(0); expect(t1.assigneeId).toBeNull();
    expect(t2).toMatchObject({ afterIds: [t1.id], rank: 3 });
    const prep = await tarea(page, 'Preparar Eureka');
    expect(prep).toMatchObject({ planDate: d2, effort: 90, event: 'gcal:e1' });             // la tarea tomó el día y los minutos de la reunión, y los siguió cuando ella cambió
    expect(await db_(async () => db.meetings.filter(m => m.seriesId).count())).toBeGreaterThan(8);                          // y la reunión semanal tiene sus ocurrencias
    const areas = await db_(async () => _getAreas());
    expect(areas.find(a => a.name === 'Posgrado').parentId).toBe(areas.find(a => a.name === 'Docencia').id);

    await dejar(page, 'h-2.json', { format: TIPO, author: 'ia', ops: [
      { op: 'update', type: 'task', match: 'Preparar Eureka', set: { planDate: d3, minutes: 45 } },                          // al revés: mover la tarea mueve el bloque
      { op: 'update', type: 'task', match: 'Pedir datos', set: { after: ['Analizar'] } },                                    // un ciclo se rechaza
      { op: 'update', type: 'area', match: 'Docencia', set: { parent: 'Posgrado' } },
    ] });
    const h2 = await res('h-2.json');
    expect(h2.ops.map(o => o.status)).toEqual(['applied', 'error', 'error']);
    expect(h2.ops[1].error).toContain('ciclo'); expect(h2.ops[2].error).toContain('subáreas');
    expect(await db_(async () => db.meetings.where('title').equals('Eureka').filter(m => !m.seriesId).first().then(m => [m.date, m.duration]))).toEqual([d3, 45]);
    await page.locator('.toast-undo-btn').last().click();                                    // deshacer devuelve también la reunión ligada
    await expect.poll(() => db_(async () => db.meetings.where('title').equals('Eureka').filter(m => !m.seriesId).first().then(m => [m.date, m.duration]))).toEqual([d2, 90]);

    await page.evaluate(async () => { const t = await db.tasks.filter(x => x.title === 'Pedir datos').first(); await db.tasks.update(t.id, { done: true, doneAt: new Date(Date.now() + 60000).toISOString(), updatedAt: new Date(Date.now() + 60000).toISOString() }); });
    await page.evaluate(() => Assistant.syncNow());
    const e = JSON.parse(await leer(page, 'estado.json'));                                   // lo nuevo en el estado
    const ch = e.recentChanges;
    expect(ch.find(c => c.title === 'Analizar')).toMatchObject({ type: 'task', change: 'created', by: 'assistant' });
    expect(ch.find(c => c.title === 'Pedir datos')).toMatchObject({ change: 'completed', by: 'user' });                     // lo que hizo la persona se distingue de lo de la IA
    expect(e.tasks.find(t => t.title === 'Analizar')).toMatchObject({ after: ['Pedir datos'], rank: 3 });
    expect(e.tasks.find(t => t.title === 'Analizar').blockedBy ?? []).toEqual([]);          // ya hecha la anterior, no está bloqueada
    expect(e.tasks.find(t => t.title === 'Pedir datos')).toMatchObject({ owner: 'Dra. Vega', spent: 20 });
    expect(e.projects.find(p => p.title === 'Curso de estadística')).toMatchObject({ paused: true, pauseReason: 'Paro' });
    expect(e.areas.find(a => a.name === 'Posgrado').parent).toBe('Docencia');
    expect(e.columnsInfo[1].types).toEqual(['Curso']);
    expect(await leer(page, 'AGENTS.md')).toContain('"#p1"');                                // y las instrucciones lo explican

    // «yo» + privacidad: lo asignado a mí no es esperar; lo privado no existe para la IA
    await page.evaluate(async () => {
      const vega = await db.collaborators.where('name').equals('Dra. Vega').first(); Me.set(vega.id);
      const gamma = await db.projects.where('title').equals('Grant Gamma').first(); await db.projects.update(gamma.id, { private: true });
      await Tasks.add({ title: 'Resultados del paciente', projectId: gamma.id });
      const soto = await db.collaborators.add({ name: 'Dr. Soto', createdAt: new Date().toISOString(), private: true });
      await db.meetings.add({ title: 'Visita a domicilio', date: addDaysISO(1), participants: 'Dr. Soto', agreements: '', projectId: null, actionItems: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await Tasks.add({ title: 'Cosa mía de Vega', assigneeId: vega.id });
    });
    await dejar(page, 'h-3.json', { format: TIPO, author: 'ia', ops: [
      { op: 'add', type: 'task', set: { title: 'Intento', project: 'Grant Gamma' } },
      { op: 'update', type: 'task', match: 'Resultados del paciente', set: { priority: 'Alta' } },
      { op: 'update', type: 'person', match: 'Dr. Soto', set: { role: 'x' } },
    ] });
    expect((await res('h-3.json')).ops.map(o => o.status)).toEqual(['error', 'error', 'error']);
    expect((await res('h-3.json')).ops[0].error).toContain('no existe proyecto');
    const e3 = JSON.parse(await leer(page, 'estado.json'));
    const texto = JSON.stringify(e3) + await leer(page, 'pendientes.md');
    for (const secreto of ['Grant Gamma', 'Resultados del paciente', 'Dr. Soto', 'Visita a domicilio']) expect(texto).not.toContain(secreto);
    expect(e3.privacy).toContain('privados');
    expect(e3.me).toBe('Dra. Vega');
    expect(e3.tasks.find(t => t.title === 'Cosa mía de Vega').assignee).toBeUndefined();     // asignada a «yo»: no es esperar a nadie
    expect(e3.summary.waitingOnOthers).toBe(0);
    expect((await page.evaluate(() => Promise.all([db.projects.where('title').equals('Grant Gamma').count(), db.collaborators.where('name').equals('Dr. Soto').count()])))).toEqual([1, 1]);       // siguen en la app
  });
});
