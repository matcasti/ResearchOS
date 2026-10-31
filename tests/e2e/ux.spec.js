const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('./helpers');

// Mejoras de uso: coherencia visual, teclado, diálogos propios, protección ante pérdidas y mensajes claros.

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

test.describe('Coherencia visual', () => {
  test('el menú usa iconos de línea (SVG), sin emojis mezclados con símbolos', async ({ page }) => {
    await openApp(page);
    const icons = await page.locator('.sidebar-nav .nav-icon').evaluateAll(els => els.map(e => ({ svg: !!e.querySelector('svg'), text: e.textContent.trim() })));
    expect(icons.length).toBeGreaterThan(15);
    for (const i of icons) { expect(i.svg).toBe(true); expect(i.text).toBe(''); }
    expect(await page.locator('#mobileBar .mb-icon svg').count()).toBe(5);
  });

  test('los títulos de las vistas llevan el mismo nombre que el menú y ningún emoji', async ({ page }) => {
    await openApp(page);
    await seed(page);
    const expected = { weekly: 'Calendario', submissions: 'Submissions', meetings: 'Reuniones', references: 'Referencias', collaborators: 'Colaboradores', starred: 'Favoritos', settings: 'Ajustes y backup', ideas: 'Ideas', timeline: 'Línea de tiempo' };
    for (const [view, title] of Object.entries(expected)) {
      await gotoView(page, view);
      const t = (await page.locator('#mainContent .view-title').first().innerText()).trim();
      expect(t, view).toBe(title);
      expect(EMOJI.test(t), view).toBe(false);
    }
  });

  test('botones, campos y desplegables usan la tipografía de la app', async ({ page }) => {
    await openApp(page);
    await seed(page);
    for (const view of ['dashboard', 'kanban', 'ideas', 'snippets', 'projects', 'settings']) {
      await gotoView(page, view);
      const bad = await page.evaluate(() => {
        const body = getComputedStyle(document.body).fontFamily;
        const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();       // las etiquetas técnicas usan la fuente monoespaciada de la app a propósito
        const own = f => f === body || (mono && f.replace(/["']/g, '').startsWith(mono.replace(/["']/g, '').split(',')[0].trim()));
        return [...document.querySelectorAll('#mainContent button, #mainContent input, #mainContent select, #mainContent textarea')]
          .filter(e => e.getBoundingClientRect().width > 0 && !own(getComputedStyle(e).fontFamily)).map(e => e.tagName + '.' + e.className + ' ' + getComputedStyle(e).fontFamily.slice(0, 30)).slice(0, 5);
      });
      expect(bad, view).toEqual([]);
    }
  });

  test('los desplegables muestran su flecha', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'references');
    const bg = await page.locator('#mainContent select.form-select').first().evaluate(e => getComputedStyle(e).backgroundImage);
    expect(bg).toContain('svg');
  });

  test('el texto secundario tiene contraste suficiente (≥ 4,5:1) en tema oscuro y claro', async ({ page }) => {
    await openApp(page);
    const ratios = await page.evaluate(() => {
      const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
      const out = {};
      for (const theme of ['dark', 'light']) {
        document.documentElement.setAttribute('data-theme', theme);
        const cs = getComputedStyle(document.documentElement);
        const fg = cs.getPropertyValue('--text-3').trim(), bg = cs.getPropertyValue('--bg-card').trim();
        const [a, b] = [lum(fg), lum(bg)];
        out[theme] = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      }
      return out;
    });
    expect(ratios.dark).toBeGreaterThanOrEqual(4.5);
    expect(ratios.light).toBeGreaterThanOrEqual(4.5);
  });

  test('la vista activa del menú nunca queda escondida bajo el pie (pantallas bajas)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await openApp(page);
    await gotoView(page, 'dashboard');
    for (const view of ['submissions', 'report', 'archived', 'settings']) {
      await page.evaluate(v => navigate(v), view);
      await page.waitForFunction(v => document.getElementById('mainContent').dataset.view === v, view);
      await page.waitForTimeout(450);
      const ok = await page.evaluate(() => {
        const a = document.querySelector('.sidebar-nav .nav-item.active').getBoundingClientRect();
        const nav = document.querySelector('.sidebar-nav').getBoundingClientRect();
        return a.top >= nav.top - 1 && a.bottom <= nav.bottom + 1;
      });
      expect(ok, view).toBe(true);
    }
  });
});

test.describe('Botones de solo símbolo', () => {
  test('tienen tooltip y nombre accesible a la vez (✕, ⋯, ⊞, ☆…)', async ({ page }) => {
    await openApp(page);
    await seed(page);
    for (const view of ['kanban', 'projects', 'ideas', 'snippets', 'network']) {
      await gotoView(page, view);
      const bad = await page.evaluate(() => [...document.querySelectorAll('#mainContent button')]
        .filter(b => b.getBoundingClientRect().width > 0 && !/\p{L}/u.test(b.textContent) && !b.querySelector('svg'))
        .filter(b => !(b.getAttribute('aria-label') && b.title)).map(b => b.className + ' ' + b.textContent.trim()));
      expect(bad, view).toEqual([]);
    }
  });

  test('el filtro de Ideas queda justo encima de la lista, no encima del formulario de captura', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      for (const t of ['a', 'b', 'c']) await db.ideas.add({ title: 'Extra ' + t, content: '', status: 'unread', projectId: null, projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    });
    await gotoView(page, 'ideas');
    const [bar, list, form] = await Promise.all([page.locator('.list-filter').boundingBox(), page.locator('#ideasList').boundingBox(), page.locator('#ideaTitleInput').boundingBox()]);
    expect(bar.y).toBeGreaterThan(form.y);
    expect(list.y - (bar.y + bar.height)).toBeLessThan(40);
  });
});

test.describe('Teclado', () => {
  test('filas y tarjetas se abren con Tab + Enter', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    const card = page.locator('.idea-item', { hasText: 'Idea uno' });
    await expect(card).toHaveAttribute('tabindex', '0');
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#inspectorBody')).toContainText('Idea uno');
    await gotoView(page, 'kanban');
    await page.locator('.kanban-card', { hasText: 'Grant Gamma' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#inspectorBody .inspector-project-title')).toContainText('Grant Gamma');
    await expect(page.locator('.breadcrumb-bar .bc-item.link, .proj-tab').first()).toBeVisible();
  });

  test('«?» muestra los atajos; no se activa escribiendo en un campo', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.locator('#mainContent').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('?');
    await expect(page.locator('#modal')).toContainText('Atajos de teclado');
    await expect(page.locator('#modal')).toContainText('Vista anterior');
    await page.keyboard.press('Escape');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    await page.locator('#shortcutsBtn').click();
    await expect(page.locator('#modal')).toContainText('Atajos de teclado');
    await page.keyboard.press('Escape');
    await page.locator('input.form-input, textarea').first().focus();
    await page.keyboard.type('¿qué?');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
  });

  test('Ctrl+C con la página enfocada copia: no dispara «Capturar» ni cambia de vista', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.locator('#mainContent').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+s');
    await page.keyboard.press('Meta+c');
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => App.view)).toBe('ideas');
    // ...y la tecla suelta sí funciona
    await page.keyboard.press('c');
    await expect.poll(() => page.evaluate(() => App.view)).toBe('dashboard');
    await expect(page.locator('#captureInput')).toBeFocused();
  });

  test('Alt+← y Alt+→ recorren el historial de vistas', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await gotoView(page, 'snippets');
    await page.locator('#mainContent').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(() => page.evaluate(() => App.view)).toBe('ideas');
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => page.evaluate(() => App.view)).toBe('snippets');
  });

  test('«Saltar al contenido» aparece con Tab y mueve el foco al contenido', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Safari no enfoca los enlaces con Tab salvo que el usuario lo active en sus preferencias');
    await openApp(page);
    await page.keyboard.press('Tab');
    const skip = page.locator('#skipLink');
    await expect(skip).toBeFocused();
    await expect.poll(async () => (await skip.boundingBox()).y).toBeGreaterThanOrEqual(0);      // termina de bajar al enfocarlo
    await page.keyboard.press('Enter');
    await expect(page.locator('#mainContent')).toBeFocused();
  });
});

test.describe('Paleta de comandos', () => {
  test('encuentra todas las vistas por sinónimos y ofrece acciones', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.keyboard.press('Control+k');
    await expect(page.locator('.palette-group-label').first()).toHaveText('Acciones');
    for (const [q, label] of [['ajustes', 'Ajustes y backup'], ['grafo', 'Red'], ['informe', 'Informe de avance'], ['archivo', 'Archivados'], ['estrella', 'Favoritos'], ['gantt', 'Proyectos · Línea de tiempo']]) {
      await page.locator('#paletteInput').fill(q);
      await expect(page.locator('.palette-item-label', { hasText: label }).first()).toBeVisible();
    }
    await page.locator('#paletteInput').fill('tema');
    await expect(page.locator('.palette-item-label', { hasText: 'Cambiar tema' })).toBeVisible();
    await page.locator('#paletteInput').fill('ajustes');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => App.view)).toBe('settings');
  });

  test('iconos de línea y tecla del sistema en el pie', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+k');
    await expect(page.locator('.palette-item-icon svg').first()).toBeVisible();
    expect(await page.locator('.palette-item-icon svg').count()).toBeGreaterThan(5);
    await expect(page.locator('#paletteModKey')).toHaveText(/^(⌘|Ctrl)K$/);
  });
});

test.describe('Avisos y diálogos', () => {
  test('los avisos se pueden cerrar, no se apilan más de 4 y los errores duran más', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => { for (let i = 0; i < 7; i++) showToast('Aviso ' + i, 'info'); });
    await expect(page.locator('.toast')).toHaveCount(4);
    await page.locator('.toast .toast-close').first().click();
    await expect(page.locator('.toast')).toHaveCount(3);
    await page.evaluate(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); showToast('Algo falló', 'error'); });
    await page.waitForTimeout(3800);
    await expect(page.locator('.toast.error')).toHaveCount(1);       // un aviso normal ya habría desaparecido (3,2 s)
  });

  test('borrar todos los datos exige escribir BORRAR y Esc cancela', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'settings');
    await page.locator('#clearAllBtn').click();
    await expect(page.locator('#confirmInput')).toBeFocused();             // pide escribir BORRAR: el foco va al campo
    await expect(page.locator('#confirmYes')).toBeDisabled();
    await page.locator('#confirmInput').fill('borr');
    await expect(page.locator('#confirmYes')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.locator('.confirm-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => db.projects.count())).toBe(3);
    await page.locator('#clearAllBtn').click();
    await page.locator('#confirmInput').fill('borrar');
    await expect(page.locator('#confirmYes')).toBeEnabled();
    await page.locator('#confirmNo').click();
    expect(await page.evaluate(() => db.projects.count())).toBe(3);
  });

  test('eliminar sin preguntar y deshacer: ideas, snippets, reuniones, referencias y colaboradores', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'collaborators');
    await page.locator('.collab-card', { hasText: 'Dra. Vega' }).click();
    await page.locator('#collabDeleteBtn').click();
    await expect(page.locator('.confirm-overlay')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => db.collaborators.count())).toBe(0);
    await page.locator('.toast-undo-btn').click();
    await expect.poll(() => page.evaluate(() => db.collaborators.count())).toBe(1);
  });

  test('eliminar varias ideas pide confirmar con el diálogo propio y se puede deshacer', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    await page.locator('#ideaBulkToggle').click();
    await page.locator('#ibSelectAll').click();
    await page.locator('#ibDelete').click();
    await expect(page.locator('#confirmTitle')).toContainText('2 idea');
    await expect(page.locator('#confirmNo')).toBeFocused();                // lo destructivo empieza con «Cancelar» enfocado
    await page.locator('#confirmYes').click();
    await expect.poll(() => page.evaluate(() => db.ideas.count())).toBe(0);
    await page.locator('.toast-undo-btn').click();
    await expect.poll(() => page.evaluate(() => db.ideas.count())).toBe(2);
  });
});

test.describe('Formularios', () => {
  test('cerrar una ventana con texto escrito pide confirmar; sin cambios cierra al instante', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.keyboard.press('n');
    await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
    await page.keyboard.press('Escape');                                         // sin escribir: cierra
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    await page.keyboard.press('n');
    await page.locator('#modal input.form-input').first().fill('Algo a medias');
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirmTitle')).toContainText('Descartar');
    await page.locator('#confirmNo').click();                                    // «Seguir editando»
    await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
    await expect(page.locator('#modal input.form-input').first()).toHaveValue('Algo a medias');
    await page.locator('#modalOverlay').click({ position: { x: 4, y: 4 } });     // clic fuera
    await expect(page.locator('#confirmYes')).toBeVisible();
    await page.locator('#confirmYes').click();
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
  });

  test('Enter en un campo de una línea guarda con el botón principal', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.keyboard.press('n');
    await page.locator('#modal input.form-input').first().fill('Idea por Enter');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => db.ideas.where('title').equals('Idea por Enter').count())).toBe(1);
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
  });

  test('un campo obligatorio vacío se marca y recibe el foco', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.keyboard.press('n');
    await page.locator('#modal .modal-footer .btn-primary').click();
    const title = page.locator('#modal input.form-input').first();
    await expect(title).toHaveClass(/is-invalid/);
    await expect(title).toBeFocused();
    await title.fill('x');
    await expect(title).not.toHaveClass(/is-invalid/);
  });
});

test.describe('Listas', () => {
  test('el filtro de la lista aparece con 4+ elementos, cuenta, se enfoca con «/» y sobrevive a los repintados', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      for (const t of ['Muestreo en turberas', 'Modelo de ocupación', 'Análisis de isótopos']) await db.ideas.add({ title: t, content: '', status: 'unread', projectId: null, projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    });
    await gotoView(page, 'ideas');
    const input = page.locator('#listFilterInput');
    await expect(input).toBeVisible();
    await page.locator('#mainContent').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    await page.keyboard.type('isotopos');                                        // sin acentos también encuentra «isótopos»
    await expect(page.locator('.idea-item:not(.lf-hide)')).toHaveCount(1);
    await expect(page.locator('#listFilterCount')).toHaveText('1 de 5');
    await page.keyboard.type(' zzz');
    await expect(page.locator('.list-filter-empty')).toContainText('Ninguna coincide');
    await page.evaluate(() => db.ideas.where('title').equals('Idea uno').modify({ starred: true }));   // repintado por cambio de datos...
    await page.locator('#mainContent').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(500);
    await expect(page.locator('#listFilterInput')).toHaveValue('isotopos zzz');                       // ...y el filtro sigue ahí
    await page.locator('#listFilterInput').press('Escape');
    await expect(page.locator('.idea-item.lf-hide')).toHaveCount(0);
    await expect(page.locator('#listFilterCount')).toHaveText('');
  });

  test('los estados vacíos ofrecen el botón para empezar', async ({ page }) => {
    await openApp(page);
    for (const [view, cta, modal] of [['meetings', 'meeting', /reuni/i], ['collaborators', 'collaborator', /colaborador/i], ['snippets', 'snippet', /snippet/i], ['references', 'reference', /referencia/i]]) {
      await gotoView(page, view);
      await page.locator(`#mainContent [data-empty-cta="${cta}"]`).click();
      await expect(page.locator('#modalTitle')).toContainText(modal);
      await page.keyboard.press('Escape');
      await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
    }
  });

  test('Ctrl+Z deshace el último borrado aunque el aviso ya haya desaparecido', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    await page.locator('.idea-item', { hasText: 'Idea dos' }).locator('.idea-delete-btn').click();
    await expect(page.locator('.idea-item', { hasText: 'Idea dos' })).toHaveCount(0);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
    await page.locator('#mainContent').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect(page.locator('.idea-item', { hasText: 'Idea dos' })).toHaveCount(1);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.toast', { hasText: 'nada que deshacer' })).toBeVisible();
  });
});

test.describe('Móvil', () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });

  test('Hoy: placeholder corto y guía de sintaxis solo al escribir; objetivos táctiles de 36 px', async ({ page }) => {
    await openApp(page);
    const input = page.locator('#captureInput');
    expect((await input.getAttribute('placeholder')).length).toBeLessThan(45);
    await expect(page.locator('.capture-hint')).toBeHidden();
    await input.focus();
    await expect(page.locator('.capture-hint')).toBeVisible();
    await input.evaluate(e => e.blur());
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const small = await page.locator('#mainContent .btn').evaluateAll(els => els.filter(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height < 35).length);
    expect(small).toBe(0);
  });
});
