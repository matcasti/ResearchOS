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
});
