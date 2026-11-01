const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed } = require('../helpers');

const count = (page, table) => page.evaluate(t => db[t].count(), table);

test.describe('Ideas Inbox', () => {
  test('captura rápida guarda la idea, limpia el formulario y sube el badge', async ({ page }) => {
    const { errors } = await openApp(page);
    await gotoView(page, 'ideas');
    await page.fill('#ideaTitleInput', 'Probar modelo mixto');
    await page.fill('#ideaContentInput', 'Usar **lme4** con `(1|sujeto)`');
    await page.locator('#saveIdeaBtn').click();
    await expect(page.locator('.toast.success')).toContainText('Idea guardada');
    await expect(page.locator('.idea-item')).toHaveCount(1);
    await expect(page.locator('.idea-item strong')).toHaveText('lme4'); // markdown renderizado
    await expect(page.locator('#ideasBadge')).toHaveText('1');
    expect(errors).toEqual([]);
  });

  test('Enter en el título guarda la idea', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.fill('#ideaTitleInput', 'Con Enter');
    await page.press('#ideaTitleInput', 'Enter');
    await expect(page.locator('.idea-item')).toHaveCount(1);
  });

  test('título vacío muestra error', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.locator('#saveIdeaBtn').click();
    await expect(page.locator('.toast.error')).toContainText('Escribe un título');
    expect(await count(page, 'ideas')).toBe(0);
  });

  test('marcar revisada, favorito y eliminar funcionan', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    await expect(page.locator('#ideasBadge')).toHaveText('1');
    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-status-btn').click();
    await expect.poll(() => page.evaluate(() => db.ideas.where('title').equals('Idea uno').first().then(i => i.status))).toBe('reviewed');
    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-star-btn').click();
    await expect.poll(() => page.evaluate(() => db.ideas.where('title').equals('Idea uno').first().then(i => !!i.starred))).toBe(true);
    await page.locator('.idea-item', { hasText: 'Idea dos' }).locator('.idea-delete-btn').click();
    await expect(page.locator('.idea-item')).toHaveCount(1);
  });

  test('inspector de idea y edición por modal', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-title').click();
    await expect(page.locator('#inspectorBody')).toContainText('Idea uno');
    await page.keyboard.press('e');
    await page.fill('#ei-title', 'Idea uno editada');
    await page.locator('#eiSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Idea actualizada');
    await expect(page.locator('.idea-item', { hasText: 'Idea uno editada' })).toBeVisible();
  });

  test('el borrador de captura sobrevive a una navegación', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.fill('#ideaTitleInput', 'Borrador sin guardar');
    await gotoView(page, 'kanban');
    await gotoView(page, 'ideas');
    await expect(page.locator('#ideaTitleInput')).toHaveValue('Borrador sin guardar');
  });

  test('editor LaTeX renderiza la previsualización con KaTeX', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.locator('#latexToggleBtn').click();
    await page.locator('[data-latex-preset="\\\\frac{a}{b}"]').click();
    await expect(page.locator('#latexPreview .katex')).toBeVisible();
  });

  test('triage: revisión rápida de ideas sin leer', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      for (const t of ['Idea tres', 'Idea cuatro']) await db.ideas.add({ title: t, content: '', status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    });
    await gotoView(page, 'ideas');
    await page.locator('#startTriageBtn').click();
    await expect(page.locator('#mainContent')).toContainText('Idea uno');
    expect(errors).toEqual([]);
  });
});

test.describe('Snippets', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('crear snippet con resaltado de sintaxis', async ({ page }) => {
    const { errors } = await openApp(page);
    await gotoView(page, 'snippets');
    await page.locator('#addSnippetBtn').click();
    await page.fill('#ms-title', 'Regresión lineal');
    await page.selectOption('#ms-lang', 'R');
    await page.fill('#ms-code', 'fit <- lm(y ~ x, data = df)\nsummary(fit)');
    await page.fill('#ms-tags', 'R, lm');
    await page.locator('#msSave').click();
    await expect(page.locator('.toast.success')).toContainText('Snippet guardado');
    const card = page.locator('.snippet-card', { hasText: 'Regresión lineal' });
    await expect(card).toBeVisible();
    await expect(card.locator('code.hljs')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('validación: sin código no guarda', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'snippets');
    await page.locator('#addSnippetBtn').click();
    await page.fill('#ms-title', 'Solo título');
    await page.locator('#msSave').click();
    await expect(page.locator('.toast.error')).toContainText('requeridos');
    expect(await count(page, 'snippets')).toBe(0);
  });

  test('copiar al portapapeles entrega el código exacto', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'snippets');
    await page.locator('.copy-btn-float').first().click();
    await expect(page.locator('.copy-btn-float').first()).toHaveText('✓ Copiado');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ggplot(df, aes(x, y)) + geom_point()');
  });

  test('código con caracteres especiales se copia y muestra sin romperse', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'snippets');
    const code = 'if (a < b && c > "d") { x <- \'%in%\' } # </code></pre><b>x</b>';
    await page.evaluate(async c => db.snippets.add({ title: 'Raro', language: 'Bash', code: c, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), code);
    await gotoView(page, 'dashboard');
    await gotoView(page, 'snippets');
    await page.locator('.copy-btn-float').first().click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await expect(page.locator('.snippet-code b')).toHaveCount(0); // no inyecta HTML
  });

  test('filtros por lenguaje y colección', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'snippets');
    await page.locator('.lang-tab[data-lang="Python"]').click();
    await expect(page.locator('.snippet-card')).toHaveCount(0);
    await page.locator('.lang-tab[data-lang="R"]').click();
    await expect(page.locator('.snippet-card')).toHaveCount(1);
    await page.locator('#addCollectionBtn').click();
    await page.fill('#nc-name', 'Gráficos');
    await page.locator('#ncSave').click();
    await expect(page.locator('.snip-col-item', { hasText: 'Gráficos' })).toBeVisible();
  });

  test('favorito, editar y eliminar', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'snippets');
    await page.locator('.snippet-star-btn').first().click();
    await expect.poll(() => page.evaluate(() => db.snippets.toArray().then(a => a[0].starred))).toBe(true);
    await page.locator('.snippet-delete-btn').first().click();
    await expect.poll(() => count(page, 'snippets')).toBe(0);
  });
});

test.describe('Referencias', () => {
  test('crear referencia manual', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'references');
    await page.locator('#addRefBtn').click();
    // La app mueve el foco al campo DOI a los 60 ms; sin esperarlo, fill() sobre <input type=number> escribe en el campo equivocado.
    await expect(page.locator('#ar-doi-search')).toBeFocused();
    await page.fill('#ar-title', 'Deep learning');
    await page.fill('#ar-authors', 'LeCun, Y., Bengio, Y.');
    await page.fill('#ar-year', '2015');
    await page.fill('#ar-journal', 'Nature');
    await page.locator('#arSave').click();
    await expect(page.locator('.ref-card', { hasText: 'Deep learning' })).toBeVisible();
  });

  test('búsqueda por DOI rellena el formulario (red real: CrossRef)', async ({ page }) => {
    test.slow();
    await openApp(page);
    await gotoView(page, 'references');
    await page.locator('#addRefBtn').click();
    await page.fill('#ar-doi-search', '10.1038/nature14539');
    await page.locator('#ar-doi-lookup-btn').click();
    await expect(page.locator('#ar-title')).not.toHaveValue('', { timeout: 15000 });
    await expect(page.locator('#ar-year')).toHaveValue('2015');
  });

  test('DOI inexistente informa el error sin romper', async ({ page }) => {
    const { errors } = await openApp(page);
    await gotoView(page, 'references');
    await page.locator('#addRefBtn').click();
    await page.fill('#ar-doi-search', '10.0000/no-existe-xyz');
    await page.locator('#ar-doi-lookup-btn').click();
    await expect(page.locator('#ar-doi-status')).toContainText('no encontrado', { timeout: 15000 });
    expect(errors.filter(e => !/404|Failed to load resource/.test(e))).toEqual([]);
  });

  test('exportar .bib descarga un archivo con entradas válidas', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'references');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#exportBibtexBtn').click()]);
    expect(dl.suggestedFilename()).toMatch(/^references-\d{4}-\d{2}-\d{2}\.bib$/);
    const text = await require('fs').promises.readFile(await dl.path(), 'utf8');
    expect(text).toContain('@article{');
    expect(text).toContain('title   = {A unifying framework}');
  });
});

test.describe('Reuniones y colaboradores', () => {
  test('crear reunión con próximos pasos genera action items', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'meetings');
    await page.locator('#addMeetingBtn').click();
    await page.fill('#am-title', 'Defensa capítulo 3');
    await page.fill('#am-date', '2026-11-05'); // el valor por defecto está roto desde esta vista (ver known-bugs)
    await page.fill('#am-actions', 'Revisar sección 2\nEnviar datos\n\nPreparar slides');
    await page.locator('#amSave').click();
    await expect(page.locator('.meeting-card', { hasText: 'Defensa capítulo 3' })).toBeVisible();
    const m = await page.evaluate(() => db.meetings.where('title').equals('Defensa capítulo 3').first());
    expect(m.actionItems.map(a => a.text)).toEqual(['Revisar sección 2', 'Enviar datos', 'Preparar slides']);
  });

  test('marcar action item como hecho desde el inspector', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'meetings');
    await page.locator('.meeting-card').first().click();
    await page.locator('[data-toggle-ai]').first().click();
    await expect.poll(() => page.evaluate(() => db.meetings.toArray().then(a => a[0].actionItems[0].done))).toBe(true);
  });

  test('crear colaborador y verlo enlazado a proyectos por nombre', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'collaborators');
    await expect(page.locator('.collab-card', { hasText: 'Dra. Vega' })).toContainText('Paper Alfa');
    await page.locator('#addCollabBtn').click();
    await page.fill('#ac-name', 'Dr. Nuevo');
    await page.fill('#ac-email', 'nuevo@uni.cl');
    await page.locator('#acSave').click();
    await expect(page.locator('.collab-card', { hasText: 'Dr. Nuevo' })).toBeVisible();
  });

  test('autocompletado de responsable en el formulario de proyecto', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'kanban');
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="blank"]').click();
    await page.fill('#mp-title', 'Con responsable');
    await page.locator('#mp-responsible').click();
    await page.keyboard.type('Veg');
    const sugg = page.locator('text=Dra. Vega').last();
    await expect(sugg).toBeVisible();
  });
});

test.describe('Atajos y UI persistente', () => {
  test('N abre "nuevo" contextual según la vista; Esc cierra', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'ideas');
    await page.locator('body').press('n');
    await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);
  });

  test('tema, acento y sidebar colapsado persisten tras recargar', async ({ page }) => {
    await openApp(page);
    await page.locator('#themeToggle').click();
    await page.locator('.accent-swatch[data-accent="purple"]').click();
    await page.locator('#sidebarCollapseBtn').click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
    expect(await page.evaluate(() => localStorage.getItem('ros-accent'))).toBe('purple');
  });

  test('botones atrás/adelante del historial de navegación', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'kanban');
    await gotoView(page, 'ideas');
    await page.locator('#navBack').click();
    await expect(page.locator('.nav-item[data-view="kanban"]')).toHaveClass(/active/);
    await page.locator('#navForward').click();
    await expect(page.locator('.nav-item[data-view="ideas"]')).toHaveClass(/active/);
  });

  test('modal de bienvenida aparece solo en el primer uso', async ({ page }) => {
    await openApp(page, { welcomed: false });
    await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
  });
});
