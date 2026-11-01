const fs = require('fs');
const { test, expect, openApp, gotoView, seed } = require('../helpers');

const count = (page, table) => page.evaluate(t => db[t].count(), table);
const ideaOf = (page, title) => page.evaluate(t => db.ideas.where('title').equals(t).first(), title);

test.describe('Ideas Inbox', () => {
  test('captura rápida: el título es obligatorio, guarda con el botón o con Enter, limpia el formulario, sube el badge, conserva el borrador al navegar y el editor LaTeX previsualiza', async ({ page }) => {
    const { errors } = await openApp(page);
    await gotoView(page, 'ideas');
    await page.locator('#saveIdeaBtn').click();
    await expect(page.locator('.toast.error')).toContainText('Escribe un título');
    expect(await count(page, 'ideas')).toBe(0);

    await page.fill('#ideaTitleInput', 'Probar modelo mixto');
    await page.fill('#ideaContentInput', 'Usar **lme4** con `(1|sujeto)`');
    await page.locator('#saveIdeaBtn').click();
    await expect(page.locator('.toast.success')).toContainText('Idea guardada');
    await expect(page.locator('.idea-item')).toHaveCount(1);
    await expect(page.locator('.idea-item strong')).toHaveText('lme4');                  // markdown renderizado
    await expect(page.locator('#ideasBadge')).toHaveText('1');

    await page.fill('#ideaTitleInput', 'Con Enter');
    await page.press('#ideaTitleInput', 'Enter');
    await expect(page.locator('.idea-item')).toHaveCount(2);

    await page.fill('#ideaTitleInput', 'Borrador sin guardar');                          // el borrador sobrevive a una navegación
    await gotoView(page, 'kanban');
    await gotoView(page, 'ideas');
    await expect(page.locator('#ideaTitleInput')).toHaveValue('Borrador sin guardar');

    await page.locator('#latexToggleBtn').click();                                       // editor LaTeX con KaTeX
    await page.locator('[data-latex-preset="\\\\frac{a}{b}"]').click();
    await expect(page.locator('#latexPreview .katex')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('marcar revisada, favorito y eliminar; inspector con edición por modal; revisión rápida (triage) de las que siguen sin leer', async ({ page }) => {
    const { errors } = await openApp(page);
    await seed(page);
    await gotoView(page, 'ideas');
    await expect(page.locator('#ideasBadge')).toHaveText('1');
    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-status-btn').click();
    await expect.poll(async () => (await ideaOf(page, 'Idea uno')).status).toBe('reviewed');
    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-star-btn').click();
    await expect.poll(async () => !!(await ideaOf(page, 'Idea uno')).starred).toBe(true);
    await page.locator('.idea-item', { hasText: 'Idea dos' }).locator('.idea-delete-btn').click();
    await expect(page.locator('.idea-item')).toHaveCount(1);

    await page.locator('.idea-item', { hasText: 'Idea uno' }).locator('.idea-title').click();   // inspector y edición por modal
    await expect(page.locator('#inspectorBody')).toContainText('Idea uno');
    await page.keyboard.press('e');
    await page.fill('#ei-title', 'Idea uno editada');
    await page.locator('#eiSave').click();
    await expect(page.locator('.toast.success').last()).toContainText('Idea actualizada');
    await expect(page.locator('.idea-item', { hasText: 'Idea uno editada' })).toBeVisible();

    await page.evaluate(async () => {
      const now = new Date().toISOString();
      for (const t of ['Idea tres', 'Idea cuatro', 'Idea cinco']) await db.ideas.add({ title: t, content: '', status: 'unread', projectIds: [], tags: [], subtasks: [], createdAt: now, updatedAt: now });
    });
    await gotoView(page, 'dashboard');
    await gotoView(page, 'ideas');
    await page.locator('#startTriageBtn').click();
    await expect(page.locator('#mainContent')).toContainText(/Idea (tres|cuatro|cinco)/);
    expect(errors).toEqual([]);
  });
});

test.describe('Snippets', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('crear con resaltado de sintaxis, sin código no guarda, y el código con caracteres especiales se copia y se muestra sin romperse', async ({ page }) => {
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

    await page.locator('#addSnippetBtn').click();                                         // validación: sin código no guarda
    await page.fill('#ms-title', 'Solo título');
    await page.locator('#msSave').click();
    await expect(page.locator('.toast.error')).toContainText('requeridos');
    expect(await count(page, 'snippets')).toBe(1);
    await page.evaluate(() => closeModal());

    const code = 'if (a < b && c > "d") { x <- \'%in%\' } # </code></pre><b>x</b>';
    await page.evaluate(async c => db.snippets.add({ title: 'Raro', language: 'Bash', code: c, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), code);
    await gotoView(page, 'dashboard');
    await gotoView(page, 'snippets');
    await page.locator('.snippet-card', { hasText: 'Raro' }).locator('.copy-btn-float').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await expect(page.locator('.snippet-code b')).toHaveCount(0);                         // no inyecta HTML
    expect(errors).toEqual([]);
  });

  test('copiar entrega el código exacto; filtros por lenguaje y colección; favorito y eliminar', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'snippets');
    await page.locator('.copy-btn-float').first().click();
    await expect(page.locator('.copy-btn-float').first()).toHaveText('✓ Copiado');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ggplot(df, aes(x, y)) + geom_point()');
    await page.locator('.lang-tab[data-lang="Python"]').click();
    await expect(page.locator('.snippet-card')).toHaveCount(0);
    await page.locator('.lang-tab[data-lang="R"]').click();
    await expect(page.locator('.snippet-card')).toHaveCount(1);
    await page.locator('#addCollectionBtn').click();
    await page.fill('#nc-name', 'Gráficos');
    await page.locator('#ncSave').click();
    await expect(page.locator('.snip-col-item', { hasText: 'Gráficos' })).toBeVisible();
    await page.locator('.snippet-star-btn').first().click();
    await expect.poll(() => page.evaluate(() => db.snippets.toArray().then(a => a[0].starred))).toBe(true);
    await page.locator('.snippet-delete-btn').first().click();
    await expect.poll(() => count(page, 'snippets')).toBe(0);
  });
});

test.describe('Referencias', () => {
  test('crear una a mano y exportar .bib con entradas válidas', async ({ page }) => {
    await openApp(page);
    await seed(page);
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
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#exportBibtexBtn').click()]);
    expect(dl.suggestedFilename()).toMatch(/^references-\d{4}-\d{2}-\d{2}\.bib$/);
    const text = await fs.promises.readFile(await dl.path(), 'utf8');
    expect(text).toContain('@article{');
    expect(text).toContain('title   = {A unifying framework}');
    expect(text).toContain('title   = {Deep learning}');
  });

  test('la búsqueda por DOI rellena el formulario y un DOI inexistente informa el error sin romper (red real: CrossRef)', { tag: '@slow' }, async ({ page }) => {
    test.slow();
    const { errors } = await openApp(page);
    await gotoView(page, 'references');
    await page.locator('#addRefBtn').click();
    await page.fill('#ar-doi-search', '10.0000/no-existe-xyz');
    await page.locator('#ar-doi-lookup-btn').click();
    await expect(page.locator('#ar-doi-status')).toContainText('no encontrado', { timeout: 15000 });
    await page.fill('#ar-doi-search', '10.1038/nature14539');
    await page.locator('#ar-doi-lookup-btn').click();
    await expect(page.locator('#ar-title')).not.toHaveValue('', { timeout: 15000 });
    await expect(page.locator('#ar-year')).toHaveValue('2015');
    expect(errors.filter(e => !/404|Failed to load resource/.test(e))).toEqual([]);
  });
});

test.describe('Reuniones y colaboradores', () => {
  test('crear una reunión con próximos pasos, marcar una acción como hecha, crear un colaborador enlazado a proyectos y autocompletar el responsable', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await gotoView(page, 'meetings');
    await page.locator('#addMeetingBtn').click();
    await page.fill('#am-title', 'Defensa capítulo 3');
    await page.fill('#am-date', '2026-11-05');
    await page.fill('#am-time', '10:00');
    await page.fill('#am-duration', '90');
    await page.fill('#am-actions', 'Revisar sección 2\nEnviar datos\n\nPreparar slides');
    await page.locator('#amSave').click();
    await expect(page.locator('.meeting-card', { hasText: 'Defensa capítulo 3' })).toContainText('10:00–11:30');          // la hora y la duración se ven en la lista
    const m = await page.evaluate(() => db.meetings.where('title').equals('Defensa capítulo 3').first());
    expect(m.actionItems.map(a => a.text)).toEqual(['Revisar sección 2', 'Enviar datos', 'Preparar slides']);
    expect([m.time, m.duration]).toEqual(['10:00', 90]);
    await page.locator('.meeting-card', { hasText: 'Defensa capítulo 3' }).click();
    await expect(page.locator('#inspectorBody')).toContainText('10:00–11:30');
    await page.locator('#meetEditBtn').click();                                                                          // y se editan: quitar la hora quita también la duración
    await page.fill('#em-time', '');
    await page.locator('#emSave').click();
    await expect.poll(() => page.evaluate(() => db.meetings.where('title').equals('Defensa capítulo 3').first().then(r => [r.time, r.duration]))).toEqual([null, null]);

    await page.locator('.meeting-card', { hasText: 'Reunión de avance' }).click();             // marcar una acción como hecha desde el inspector
    await page.locator('[data-toggle-ai]').first().click();
    await expect.poll(() => page.evaluate(() => db.meetings.where('title').equals('Reunión de avance').first().then(r => r.actionItems[0].done))).toBe(true);

    await gotoView(page, 'collaborators');
    await expect(page.locator('.collab-card', { hasText: 'Dra. Vega' })).toContainText('Paper Alfa');
    await page.locator('#addCollabBtn').click();
    await page.fill('#ac-name', 'Dr. Nuevo');
    await page.fill('#ac-email', 'nuevo@uni.cl');
    await page.locator('#acSave').click();
    await expect(page.locator('.collab-card', { hasText: 'Dr. Nuevo' })).toBeVisible();

    await gotoView(page, 'kanban');                                                             // autocompletado de responsable en el formulario de proyecto
    await page.locator('#kanbanAddProject').click();
    await page.locator('.template-card[data-tpl="blank"]').click();
    await page.fill('#mp-title', 'Con responsable');
    await page.locator('#mp-responsible').click();
    await page.keyboard.type('Veg');
    await expect(page.locator('text=Dra. Vega').last()).toBeVisible();
  });
});

test.describe('Atajos y UI persistente', () => {
  test('la bienvenida aparece solo en el primer uso; N abre «nuevo» según la vista; tema, acento y menú colapsado persisten; atrás/adelante recorren las vistas', async ({ page }) => {
    await openApp(page, { welcomed: false });
    await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
    await page.locator('#welcomeStart').click();
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);

    await gotoView(page, 'ideas');
    await page.locator('body').press('n');
    await expect(page.locator('#modalOverlay')).toHaveClass(/visible/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/visible/);

    await gotoView(page, 'kanban');
    await gotoView(page, 'ideas');
    await page.locator('#navBack').click();
    await expect(page.locator('.nav-item[data-view="kanban"]')).toHaveClass(/active/);
    await page.locator('#navForward').click();
    await expect(page.locator('.nav-item[data-view="ideas"]')).toHaveClass(/active/);

    await page.locator('#themeToggle').click();
    await page.locator('.accent-swatch[data-accent="purple"]').click();
    await page.locator('#sidebarCollapseBtn').click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
    expect(await page.evaluate(() => localStorage.getItem('ros-accent'))).toBe('purple');
  });
});
