# Registro de cambios

Todos los cambios relevantes de ResearchOS, de lo más reciente a lo más antiguo.

---

## Sin publicar

### ♻️ Mejorado

- **Repositorio más fácil de recorrer.** El código pasa de 13 archivos sueltos en la raíz a `src/` (`core/`, `modules/` y `services/`), los estilos, el manifiesto y los iconos a `assets/`, el registro de cambios a `docs/` y las pruebas a siete carpetas por tema dentro de `tests/e2e/`. Ninguna carpeta pasa de 5 archivos. La aplicación funciona igual: solo cambian las rutas internas y la caché offline se renueva.
- **Pruebas:** la configuración de Playwright ahora vive en `tests/`; se lanzan con `npm run test:e2e` (o `npx playwright test -c tests`).

---

## 1.1.1 - 2026-11-01

### ♻️ Mejorado

- **Red: ahora se entiende aunque tengas cientos de elementos.** Las etiquetas ya no se pisan: se colocan por orden de importancia (áreas, proyectos y lo más conectado primero), solo si caben sin tapar otra etiqueta ni el punto de otro nodo, y evitan los botones y la ficha que flotan sobre el grafo. Al acercar aparecen más, solas. Los proyectos y las áreas se ven en negrita como puntos de referencia.
- **Control de etiquetas «Auto / Más / Ninguna»** en el panel (se recuerda): «Más» etiqueta más nodos aunque alguna tape un punto; «Ninguna» deja solo la del nodo señalado.
- **Selección de nodos.** Un clic selecciona el nodo, deja resaltada su vecindad (lo demás se atenúa) y muestra una ficha con «Abrir» y «Aislar» (grafo local); un clic en el fondo o `Esc` quita la selección. En el móvil, tocar un nodo ya no abre el inspector por encima del grafo: se abre desde la ficha. Al pasar el ratón, la ficha emergente resume de qué está rodeado el nodo («3 ideas · 2 reuniones»).
- **Búsqueda con lista de resultados.** Al escribir aparecen los resultados (los que empiezan por lo escrito primero); `↑` `↓` los recorren, `Enter` o un clic llevan hasta el elegido y `Esc` limpia la búsqueda y luego la selección. El grafo se mueve con una animación suave que se cancela al tocarlo.
- **Teclado:** con el grafo enfocado, `+` y `−` acercan y alejan, `0` lo centra, las flechas lo desplazan, `Enter` abre lo seleccionado y `Esc` quita la selección.
- **Grafos grandes más legibles:** los nodos se separan solos más cuanto más grande es el grafo, las aristas se vuelven más tenues cuando hay muchas, «Centrar» ignora un par de nodos sueltos muy lejanos para no encoger todo, y los botones de acercar/alejar/centrar se animan.
- **Táctil:** la zona que responde al dedo en cada nodo es mayor.

### 🧪 Pruebas

- 11 pruebas nuevas de la vista Red: etiquetas que no se pisan con cientos de nodos, prioridad de proyectos, modos de etiquetas, separación automática, búsqueda con lista, selección, resumen del nodo, teclado, animación que termina y deja el bucle dormido, y móvil.

---

## 1.1.0 — 2026-11-01

Esta versión agrega un **recorrido guiado** y un **laboratorio de ejemplo con fechas siempre actuales** para quien usa la app por primera vez, y corrige una serie de errores de uso real: clics que se perdían, elementos duplicados, textos que se salían de su caja en el móvil y fechas mal calculadas de noche o con el cambio de horario.

### ✨ Nuevo

- **Recorrido guiado interactivo.** Un paseo de unos 3 minutos con la app abierta: ilumina el elemento real de cada pantalla, pide hacer un par de cosas («Tu turno»: completar una tarea, abrir un proyecto, abrir la paleta), se puede pausar con `Esc` y retoma donde quedó. Se llega desde la bienvenida, el Tutorial, la paleta de comandos, el panel de Hoy vacío y Ajustes.
- **«Primeros pasos» en Hoy.** Lista plegable de 7 hitos con barra de progreso que se marca sola a medida que usas la app.
- **Datos de ejemplo dinámicos.** El laboratorio de ejemplo se genera al cargarlo y todas sus fechas se calculan a partir de hoy, así que siempre hay tareas atrasadas, para hoy y para esta semana, un paper esperando decisión, personas a las que toca escribirles y clases de la semana. Incluye 14 proyectos, 41 tareas, 10 ideas, 8 snippets, 8 referencias, 11 reuniones (5 clases), 4 personas, 3 envíos y 4 áreas. Se puede cargar, reiniciar con fechas nuevas o quitar sin tocar lo que creaste tú. Funciona también al abrir la app desde un archivo local.
- **Diagnóstico en Ajustes.** Los errores inesperados quedan guardados solo en tu navegador (los últimos 20) y se muestran en Ajustes → Diagnóstico. No se envía nada a ningún servidor.
- **Pantalla de recuperación.** Si una pantalla no se puede mostrar, aparece un mensaje con «Reintentar», «Ir a Hoy» y «Descargar copia» en lugar de quedar a medias.
- **Aviso de actualización entre pestañas.** Si otra pestaña actualiza la base de datos, esta avisa para que la recargues.
- **Informe de avance:** nuevo periodo «Últimos 30 días».

### 🐛 Corregido

**Clics y duplicados**

- Un clic podía perderse si justo entonces llegaba un cambio de datos y la pantalla se repintaba entre «pulsar» y «soltar». Ahora el repintado espera a que sueltes el botón.
- «→ Tarea» y «→ Proyecto» con doble clic creaban dos elementos.
- Un doble Enter en la captura rápida de Hoy, en la idea rápida o en la captura del botón ＋ guardaba el elemento dos veces. Si la captura falla, el texto vuelve al campo.
- Guardar una idea y cambiar enseguida de pantalla podía mostrar la pantalla de error o la vista equivocada.
- Paleta de comandos: una búsqueda lenta anterior podía pisar a la última, y `Enter` ejecutaba la acción de lo escrito antes.
- En 12 formularios, el foco diferido podía robar las primeras letras que escribías.

**Fechas y zonas horarias**

- Los «días restantes» salían mal con el cambio de horario de verano.
- De noche (cuando en UTC ya es «mañana») se guardaba o calculaba el día equivocado: fecha de envío, antigüedad del seguimiento a personas.
- Fechas inválidas o con hora ya no rompen el formato de fecha.
- El Informe de avance abría casi vacío el día 1 de cada mes. Durante la primera semana del mes ahora abre en «Últimos 30 días».
- Completar una tarea recurrente atrasada dejaba una cola de fechas pasadas por completar una a una. Ahora la siguiente es la primera que aún no venció.

**Datos y copias de seguridad**

- Las copias de seguridad conservan el identificador de las tareas, validan la decisión de las rondas de revisión y, al fusionar, asignan bien a la persona de los acuerdos de reunión.
- Importar o cargar datos ahora programa la copia automática y la subida a la carpeta compartida; lo que llega desde la carpeta no se vuelve a subir.
- Si el navegador se queda sin espacio, la app lo avisa claramente en vez de fallar en silencio.
- Copiar al portapapeles ya no deja errores en la consola cuando el navegador lo niega: prueba otro método y, si tampoco, avisa.
- Seguridad: la decisión de una ronda de revisión se mostraba sin escapar en el inspector del proyecto.

**Pantallas estrechas y textos largos**

- Los textos largos sin espacios (URLs, DOIs, nombres, etiquetas) ya no desbordan tarjetas ni paneles: se parten dentro de su caja en Hoy, Tablero, Proyectos, Jerarquía, Ideas, Snippets, Referencias, Reuniones y el inspector.
- **Referencias:** en el móvil el texto se aplastaba junto al estado; ahora el estado pasa debajo.
- **Snippets:** en el móvil las colecciones pasan arriba como fichas y las tarjetas usan todo el ancho.
- **Casilla de tarea:** en el móvil se estiraba a óvalo; vuelve a ser un círculo.
- **Revisión semanal:** en pantallas de 320–360 px los botones tapaban el título y la página se desplazaba de lado.
- **Envíos:** el embudo de etapas pasa a varias filas en el móvil en vez de cortarse.
- **Chips de persona:** un nombre larguísimo se recorta con «…» dentro de su píldora en lugar de ensanchar la tarjeta.
- **Inspector:** los valores largos se encogen dentro de su fila; el campo de añadir subtarea ya no desborda.
- **Columnas, presets y etapas:** en pantallas estrechas los campos de texto quedaban minúsculos; ahora los controles pasan a otra línea.
- **Pantallas bajas (móvil apaisado):** la paleta y la tarjeta del recorrido ya no pasan del alto visible.
- **Línea de tiempo:** la etiqueta «hoy» aparece una sola vez en lugar de repetirse en cada fila.
- **Proyectos, Favoritos y Archivados:** la rejilla ya no fuerza columnas de 300 px en pantallas de 320 px.
- **Calendario semanal:** las columnas ya no crecen con su contenido y en el móvil es una sola.

**Accesibilidad**

- Las lectoras de pantalla anuncian el nombre de la vista solo al navegar; antes releían todo en cada repintado.
- Los elementos con el atributo `hidden` ya no reaparecen por estilos de los botones y bloques.

### ♻️ Mejorado

- **Bienvenida rediseñada:** tres caminos claros (recorrido guiado, datos de ejemplo o app vacía); los módulos y atajos quedan en un desplegable.
- **Panel de primera vez en Hoy:** los botones del recorrido y del ejemplo van arriba.
- **Tutorial:** tarjeta destacada para empezar o retomar el recorrido y cargar los datos de ejemplo.
- **Paleta de comandos:** nuevas acciones «Recorrido guiado», «Cargar datos de ejemplo» y «Quitar datos de ejemplo».
- **Modo sin conexión:** el service worker incluye los nuevos archivos y renueva su caché.

### 🗑️ Eliminado

- `researchos-tutorial.json`: lo reemplaza el generador de datos de ejemplo, que usa siempre fechas de hoy.

### 🧪 Pruebas

- Nuevas pruebas de punta a punta: recorrido guiado, datos de ejemplo, integridad de copias de seguridad, zonas horarias y desbordes (pantallas de 320, 360 y 1280 px, con datos normales y con textos larguísimos).
- Ampliadas las de refresco inmediato, búsqueda, formularios e informe.
- Suite completa: 470 pruebas en Chromium; las de refresco inmediato, desbordes, flujos, planificación y UX también en Firefox y WebKit.

### 📚 Documentación

- El README describe el refresco inmediato, las capturas sin duplicados, el manejo de textos largos, el recorrido guiado, los datos de ejemplo dinámicos, la recuperación ante fallos y la suite de pruebas.
