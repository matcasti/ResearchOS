const { test, expect } = require('@playwright/test');
const { openApp, gotoView, seed, reload } = require('./helpers');

const openPalette = async page => {
  await page.keyboard.press('Control+k');
  await expect(page.locator('#paletteOverlay')).toHaveClass(/open/);
};

test.describe('Command palette', () => {
  test('Ctrl+K abre y cierra; lista vistas sin escribir', async ({ page }) => {
    await openApp(page);
    await openPalette(page);
    await expect(page.locator('.palette-item', { hasText: 'Kanban' }).first()).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.locator('#paletteOverlay')).not.toHaveClass(/open/);
  });

  test('Esc cierra la paleta', async ({ page }) => {
    await openApp(page);
    await openPalette(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#paletteOverlay')).not.toHaveClass(/open/);
  });

  test('escribir el nombre de una vista y Enter navega a ella', async ({ page }) => {
    await openApp(page);
    await openPalette(page);
    await page.fill('#paletteInput', 'kanban');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('.nav-item[data-view="kanban"]')).toHaveClass(/active/);
  });

  test('busca proyectos, ideas, snippets, referencias y reuniones', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await reload(page); // el índice se construye al iniciar
    await openPalette(page);
    for (const [q, expected] of [['alfa', 'Paper Alfa'], ['uno', 'Idea uno'], ['ggplot', 'Snippet ggplot'],
                                  ['unifying', 'A unifying framework'], ['avance', 'Reunión de avance']]) {
      await page.fill('#paletteInput', q);
      await expect(page.locator('.palette-item', { hasText: expected }).first(), `búsqueda "${q}"`).toBeVisible();
    }
  });

  test('sin coincidencias muestra "Sin resultados"', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await reload(page);
    await openPalette(page);
    await page.fill('#paletteInput', 'zzzzqq');
    await expect(page.locator('.palette-empty')).toContainText('Sin resultados');
  });

  test('flechas + Enter abren el proyecto en el inspector', async ({ page }) => {
    await openApp(page);
    await seed(page);
    await reload(page);
    await openPalette(page);
    await page.fill('#paletteInput', 'alfa');
    await expect(page.locator('.palette-item', { hasText: 'Paper Alfa' }).first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#inspectorBody')).toContainText('Paper Alfa');
  });
});
