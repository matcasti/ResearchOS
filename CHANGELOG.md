# Registro de cambios

Formato: una sección por versión, con cada cambio identificado por un código (N = nuevo, B = corregido, M = mejorado, E = eliminado, T = pruebas, D = docs).
Etiquetas: **✨ Nuevo** · **🐛 Corregido** · **♻️ Mejorado** · **🗑️ Eliminado** · **🧪 Pruebas** · **📚 Docs**.

---

## 1.1.0 — 2026-11-01 · pendiente de commit

> Versión propuesta. `package.json` y la etiqueta «v1.0» del menú lateral siguen en 1.0.x: no los toqué.
> Todo lo de abajo está **sin commitear** sobre `60af659 major update and bug fixes`.

**Estado de verificación**

| Comprobación | Resultado |
|---|---|
| Suite completa en Chromium | **470 / 470** |
| Firefox + WebKit (immediate, overflow, workflow, planner, ux) | **211 pasan**, 11 omitidas (funciones solo de Chromium), 0 fallos. Después de esa tanda se añadió la prueba de B-06; `immediate.spec.js` completo se repitió en los tres navegadores: 57 / 57 |
| Auditoría de desbordes (21 vistas × 7 anchos, 30 modales/paneles × 6 tamaños, datos de ejemplo y textos extremos) | Limpia, salvo 3 px intencionados en `.inplace-field` |
| Caos aleatorio (2 sesiones de escritorio × 250 pasos) | 0 problemas |
| Caos móvil (220 pasos) | 1 timeout del propio script de prueba, ningún error de JavaScript de la app |
| ESLint (errores) en `app.js`, `today.js`, `shell.js`, `planner.js` | 0 (4 avisos de «usar antes de definir», sin efecto en ejecución) |

---

### ✨ Nuevo

- **N-01 · Recorrido guiado interactivo para quien llega por primera vez.** 16 pasos, tarjeta que ilumina el elemento real, pasos «Tu turno» que piden hacer algo (completar una tarea, abrir un proyecto, abrir la paleta), pausa con `Esc`, retoma donde quedó, salta los pasos que necesitan datos que no hay. Durante el recorrido los atajos no abren cosas tapadas por la capa.
  Entradas: Tutorial, paleta («Recorrido guiado»), bienvenida, panel de Hoy vacío y Ajustes.
  Archivos: `tour.js` (nuevo), `app.js`, `today.js`, `shell.js`, `integrations.js`, `index.html`, `style.css`.
  Pruebas: `tests/e2e/tour.spec.js` (22).
- **N-02 · «Primeros pasos» en Hoy.** Lista de 7 hitos con barra de progreso, plegable (`Onboard`), que se marca sola al usar la app (p. ej. mover un proyecto en el tablero marca «moved»; abrir la búsqueda marca «search»).
  Archivos: `tour.js`, `today.js` (`#onboardHost`), `db.js` (`Onboard.mark('moved')`), `app.js` (`Onboard.mark('search')`), `style.css`.
- **N-03 · Datos de ejemplo dinámicos.** El laboratorio de ejemplo se genera al cargarlo y **todas las fechas se calculan desde «hoy»** (siempre hay tareas atrasadas, de hoy, de esta semana y futuras; un paper esperando decisión; personas a las que toca escribirles; clases de la semana). Usa todas las piezas de la app: 14 proyectos, 41 tareas, 10 ideas, 8 snippets, 8 referencias, 11 reuniones (5 clases), 4 personas, 3 envíos, 4 áreas. Se puede cargar, **reiniciar con fechas nuevas** y **quitar** sin tocar lo que creó la persona (uids con prefijo `smp:`). Funciona también por `file://` (ya no hace `fetch`).
  Archivos: `sample.js` (nuevo), `tour.js` (banner y ajustes del ejemplo), `app.js`, `index.html`, `sw.js`, `integrations.js`.
  Pruebas: `tests/e2e/sample.spec.js` (13), `demo-data.spec.js`, `security.spec.js`.
- **N-04 · Diagnóstico de errores en Ajustes.** Los errores inesperados (promesas rechazadas, fallos al pintar) se guardan solo en este navegador (últimos 20) y se muestran en Ajustes → Diagnóstico, con un aviso discreto como máximo cada 30 s. Sin envíos a ningún servidor.
  Archivos: `app.js` (`ErrorLog`), `integrations.js` (`diagnosticsSettingsHTML`, `wireDiagnostics`), `style.css`.
- **N-05 · Pantalla de recuperación cuando una vista falla.** En vez de dejar la pantalla a medias, muestra «No se pudo mostrar esta pantalla» con Reintentar, Ir a Hoy y Descargar copia.
  Archivos: `app.js` (`_renderViewNow`), `style.css`.
- **N-06 · Aviso cuando otra pestaña actualiza la base de datos** (barra «Recarga esta para seguir…», y toast si la actualización queda bloqueada).
  Archivos: `app.js` (`_wireDbEvents`), `style.css` (`.reload-bar`).
- **N-07 · Informe de avance: preset «Últimos 30 días».**
  Archivos: `planner.js`. Pruebas: `tests/e2e/planner.spec.js`.

### 🐛 Corregido

**Clics y duplicados**

- **B-01 · Clic perdido por un repintado automático (causa del fallo suelto de Firefox en «promover a tarea»).** Si llegaba un cambio de datos entre «pulsar» y «soltar», el botón se reemplazaba y el clic no se disparaba. Ahora el refresco central espera a que se suelte el puntero (con tope de 3 s por si el «soltar» se pierde).
  Archivos: `app.js` (`Live.pressing`, listeners `pointerdown/up/cancel`).
  Prueba: `immediate.spec.js` → «un cambio de datos mientras se pulsa un botón no deshace el clic».
- **B-02 · «→ Tarea» / «→ Proyecto» con doble clic creaba dos elementos.** Archivos: `today.js` (`promoteIdea`). Prueba: `immediate.spec.js`.
- **B-03 · Doble Enter en la captura rápida de Hoy creaba el elemento dos veces;** si falla, el texto vuelve al campo. Archivos: `today.js`. Prueba: `immediate.spec.js`.
- **B-04 · Idea rápida con Enter mantenido o doble clic creaba varias ideas.** Archivos: `app.js` (`saveQuickIdea`). Prueba: `immediate.spec.js`.
- **B-05 · Captura rápida del menú ＋ (modal) se guardaba dos veces con doble Enter/clic.** Archivos: `shell.js`. *Sin prueba propia.*
- **B-06 · Un repintado directo lento pisaba la vista a la que se acababa de navegar** (p. ej. guardar una idea y cambiar enseguida a Envíos mostraba la pantalla de error). Ahora se descarta el pintado obsoleto sin pantalla de error y se repinta la vista actual.
  Archivos: `app.js` (wrapper de `renderX` en `init`, catch de `_renderViewNow`).
  Prueba: `immediate.spec.js` → «un repintado directo lento no pisa la vista…» (verificada: falla sin el arreglo).
- **B-07 · Paleta de comandos: una respuesta lenta de una búsqueda anterior pisaba a la última, y `Enter` ejecutaba la acción de lo escrito antes.** Archivos: `app.js` (`_paletteSeq`, `_paletteLast`). Pruebas: `ux.spec.js` (2).
- **B-08 · Foco diferido robaba el texto tecleado** en 12 formularios (nuevo proyecto, idea, snippet, reunión, referencia, persona, etc.). Archivos: `app.js` (`focusField`). Prueba: `ux.spec.js`.

**Fechas y zonas horarias**

- **B-09 · Días restantes mal contados con el horario de verano** (`Math.ceil` → `Math.round` en todos los cálculos de «en N días»). Archivos: `app.js`.
- **B-10 · De noche (UTC ya es «mañana») se guardaba o calculaba el día equivocado:** fecha de envío (`submittedAt`), antigüedad del seguimiento a personas, ayudante de pruebas. Ahora se usa siempre la fecha local. Archivos: `app.js`, `academic.js`, `tests/e2e/helpers.js`. Pruebas: `timezone.spec.js` (4).
- **B-11 · `formatDate` falla con sellos de tiempo ISO o fechas inválidas.** Ahora acepta ambos y devuelve «—» si no puede. Archivos: `app.js`.
- **B-12 · Informe de avance casi vacío el día 1 de cada mes** (abría en «Este mes» = un solo día). La primera semana del mes abre en «Últimos 30 días». Archivos: `planner.js` (`reportDefaultKey`). Pruebas: `planner.spec.js`; también destapó una fragilidad de fecha en `sample.spec.js`, ya cubierta.

**Datos**

- **B-13 · Completar una tarea recurrente atrasada dejaba una cola de fechas pasadas** (había que completarlas una a una). Ahora la siguiente es la primera que no ha vencido, conservando el día de la semana/mes. Archivos: `db.js` (`Tasks.setDone`).
- **B-14 · Copias de seguridad:** se conserva el `uid` de las tareas, se valida el valor de `decision` de las rondas de revisión y la fusión remapea el `assigneeId` de los acuerdos de reunión. Archivos: `db.js`. Pruebas: `integrity.spec.js` (12).
- **B-15 · Importar o cargar datos ahora programa la copia automática y la subida a la carpeta compartida;** lo que llega *desde* la carpeta no se vuelve a subir. Archivos: `app.js` (`_afterDataReplaced({ local })`), `sync.js`.
- **B-16 · Almacenamiento lleno:** aviso claro en vez de un error mudo (`QuotaExceededError`). Archivos: `app.js` (`dbWrite`).
- **B-17 · Copiar al portapapeles ya no deja errores en consola** si el navegador lo niega: prueba el método antiguo y, si no, avisa. Archivos: `app.js` (`copyText`), `academic.js`, `planner.js`.
- **B-18 · XSS:** el campo `decision` de las rondas de revisión se mostraba sin escapar en el inspector del proyecto. Archivos: `app.js`. Prueba: `security.spec.js` (lista de campos ampliada).

**Desbordes y diseño responsivo** *(todo en `style.css` salvo lo indicado)*

- **B-19 · Textos largos sin espacios (URLs, DOIs, nombres, etiquetas) desbordaban tarjetas y paneles** en Hoy, Tablero, Proyectos, Jerarquía, Ideas, Snippets, Referencias, Reuniones y el inspector. Se parten dentro de su caja (`overflow-wrap: anywhere`; en tablas, `break-word`).
- **B-20 · Referencias en móvil:** el texto se aplastaba a 18 px junto al estado; ahora el estado pasa debajo.
- **B-21 · Snippets en móvil:** las colecciones pasan arriba como fichas y las tarjetas usan todo el ancho (antes 106 px). Archivos: `app.js` (clase `snippets-layout`), `style.css`.
- **B-22 · Casilla de tarea en móvil** se estiraba a óvalo por el tamaño táctil mínimo.
- **B-23 · Revisión semanal en 320–360 px:** los botones tapaban el título del proyecto y la página tenía scroll horizontal; el contador del paso se queda junto al título.
- **B-24 · Envíos:** el embudo de etapas pasa a varias filas en móvil en vez de cortarse a la derecha.
- **B-25 · Nombres larguísimos en chips de persona** se recortan con «…» dentro de su píldora (antes ensanchaban la tarjeta del tablero hasta 1400 px). Archivos: `app.js` (`_personChipHTML`), `style.css`.
- **B-26 · Inspector:** los valores largos se encogen dentro de su fila; «(reunión «…»)» del último contacto se parte en varias líneas; el campo de añadir subtarea ya no desborda.
- **B-27 · Gestores de columnas, presets y etapas:** en pantallas estrechas los campos de texto quedaban en 24–47 px; ahora los controles pasan a otra línea. Archivos: `app.js` (clase `preset-row`), `style.css`.
- **B-28 · Pantallas bajas (móvil apaisado):** la paleta y la tarjeta del recorrido ya no pasan del alto visible.
- **B-29 · «Primeros pasos»:** la cabecera cabe en una línea y la lista no excede 320 px.
- **B-30 · Línea de tiempo:** la etiqueta «hoy» se muestra una sola vez (repetida en cada fila chocaba con las fechas).
- **B-31 · Proyectos / Favoritos / Archivados en 320 px:** la rejilla ya no fuerza columnas de 300 px.
- **B-32 · Calendario semanal:** columnas que no crecen con su contenido; una sola columna en móvil.
  Pruebas de todo el bloque: `tests/e2e/overflow.spec.js` (10; verificadas: 6 fallan sin el arreglo). Las correcciones de modales, paleta y recorrido se verificaron con auditorías manuales, **sin prueba automática**.

**Accesibilidad**

- **B-33 · Lectoras de pantalla:** se anuncia el nombre de la vista solo al navegar (`#srStatus`); `<main>` ya no es `aria-live` (releía todo en cada repintado). Archivos: `index.html`, `app.js`.
- **B-34 · El atributo `hidden` ganaba a los `display` de botones y bloques.** Regla global `[hidden] { display: none !important }`. Archivos: `style.css`.

### ♻️ Mejorado

- **M-01 · Modal de bienvenida rediseñado:** tres caminos (Recorrido guiado · Datos de ejemplo · App vacía); módulos y atajos quedan en un desplegable. Archivos: `app.js`, `style.css`.
- **M-02 · Panel de «primera vez» (Hoy vacío):** botones de recorrido y de ejemplo arriba; una opción menos en la lista. Archivos: `shell.js`, `style.css`.
- **M-03 · Tutorial:** tarjeta destacada con «Empezar / Retomar el recorrido» y «Cargar datos de ejemplo». Archivos: `app.js`, `style.css`.
- **M-04 · Paleta:** nuevas acciones «Recorrido guiado», «Cargar datos de ejemplo» y «Quitar datos de ejemplo». Archivos: `app.js`.
- **M-05 · Caché del service worker `v7 → v9`** e incluye `sample.js` y `tour.js` en el shell. Archivos: `sw.js`.

### 🗑️ Eliminado

- **E-01 · `researchos-tutorial.json`** (667 líneas): reemplazado por `sample.js`, que genera los datos con fechas de hoy. Ya no hay referencias en el código, los tests ni el service worker.

### 🧪 Pruebas

- **T-01 · Specs nuevos:** `tour.spec.js` (22), `sample.spec.js` (13), `integrity.spec.js` (12), `timezone.spec.js` (4), `overflow.spec.js` (10 con las 3 configuraciones de pantalla).
- **T-02 · Specs ampliados:** `immediate.spec.js` (+5: clic durante repintado, doble clic en «→ Tarea», doble Enter en captura, idea rápida doble, repintado obsoleto), `ux.spec.js` (+3: foco, paleta ×2), `planner.spec.js` (+1 prueba del periodo por defecto y 1 aserción del preset).
- **T-03 · Specs ajustados** al nuevo ejemplo y a los diálogos propios: `demo-data`, `security`, `shell`, `today`, `workflow`, `resilience`, `helpers` (exporta `routeExternal`; fechas locales). En Firefox/WebKit se omiten solo lo que depende de APIs exclusivas de Chromium (permisos de portapapeles, File System Access).

### 📚 Docs

- **D-01 · `README.md`:** refresco inmediato (no repinta con un botón pulsado), capturas sin duplicados, textos largos, recorrido guiado, datos de ejemplo dinámicos, recuperación ante fallos y la suite de pruebas (incluida la de desbordes).
- **D-02 · `CHANGELOG.md`** (este archivo).

---

## Archivos para el commit

| Estado | Archivos |
|---|---|
| **Nuevos (sin seguimiento)** | `sample.js` · `tour.js` · `CHANGELOG.md` · `tests/e2e/{integrity,overflow,sample,timezone,tour}.spec.js` |
| **Eliminado** | `researchos-tutorial.json` |
| **Modificados** | `README.md` · `academic.js` · `app.js` · `db.js` · `index.html` · `integrations.js` · `planner.js` · `shell.js` · `style.css` · `sw.js` · `sync.js` · `today.js` · `tests/e2e/{demo-data,helpers,immediate,planner,resilience,security,shell,today,ux,workflow}.spec.js` |

No se versionan `test-results/` ni `playwright-report/` (ya ignorados).

```bash
git add -A
git status --short   # revisa que solo estén los archivos de la tabla
```

**Un solo commit (recomendado):** `app.js`, `style.css`, `today.js` y `shell.js` mezclan cambios de varias secciones, así que separarlos por tema obligaría a usar `git add -p`.

Mensaje sugerido:

```
Add guided tour and dynamic sample data; fix lost clicks, duplicates and overflows

- Guided tour, first-steps checklist and sample lab with dates relative to today (sample.js, tour.js)
- Live refresh waits while a pointer is pressed (fixes the flaky "promote to task" click)
- Guards against double submit (promote idea, capture bar, quick idea, quick capture)
- Stale direct renders no longer overwrite the view you navigated to
- Local-date and DST fixes; backups keep task uids; late recurring tasks skip past dates
- Long unbroken text and narrow screens no longer overflow (references, snippets, review, inspector, modals)
- Report opens on "Last 30 days" during the first week of the month
- Diagnostics log, recovery screen and copy fallback
- New specs: tour, sample, integrity, timezone, overflow
```

---

## Qué NO está incluido ni cambió

- `package.json` (versión 1.0.0) y la etiqueta «v1.0» del menú: pendientes de decidir el número de versión.
- Las auditorías de desbordes y las sesiones de caos usan scripts que viven **fuera** del repositorio; el repositorio solo conserva las pruebas de `tests/e2e`.
- Sesión de caos móvil: un timeout del propio script al esperar un elemento tras un diálogo; no es un error de la app, pero no se repitió con otra semilla.
