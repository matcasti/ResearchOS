# 🔬 ResearchOS — Scientific Workflow Suite

ResearchOS no es simplemente una herramienta de organización; es una infraestructura digital de vanguardia diseñada para la gestión integral de flujos de trabajo científicos. Concebida bajo el estricto paradigma local-first, esta Single-Page Application (SPA) de alto rendimiento permite a investigadores, académicos y desarrolladores de datos centralizar su producción intelectual en un ecosistema donde la soberanía del dato, la velocidad de respuesta y la resiliencia operativa no son opcionales, sino pilares fundacionales de la práctica científica moderna.

En un panorama tecnológico dominado por el "Software como Servicio" (SaaS) que fragmenta la información en silos de terceros y compromete la privacidad, ResearchOS devuelve el control absoluto al investigador. La aplicación opera sin un backend centralizado tradicional, utilizando el motor IndexedDB del navegador para almacenar de manera persistente (sin cifrado propio: la protección en reposo depende del cifrado de disco de tu sistema) notas de laboratorio, fragmentos de código, bibliografías y planificaciones de proyectos complejos, garantizando que su trabajo sea accesible incluso en las condiciones más extremas de conectividad.

## 🤚 Filosofía Local-First: Privacidad, Soberanía y Reproducibilidad

La decisión de implementar una arquitectura local-first no es solo una elección técnica, sino una postura ética y práctica frente a la gestión del conocimiento científico:

-   Privacidad Absoluta y Seguridad de Grado de Laboratorio: Los datos de investigación, que a menudo incluyen hipótesis no publicadas, datos sensibles de pacientes o borradores sujetos a embargos de patentes, nunca abandonan el dispositivo del usuario. Al eliminar la transmisión a servidores externos, se mitigan los riesgos de filtraciones de datos (data breaches) y se garantiza el cumplimiento de normativas de privacidad (como GDPR o HIPAA) sin necesidad de configuraciones de servidor complejas.

<!-- -->

-   Latencia Cero e Interactividad Fluida: La interfaz no espera a la red. Al no haber latencia de servidor (round-trip), cada acción —desde mover una tarjeta en el Kanban hasta renderizar una ecuación diferencial compleja— ocurre en microsegundos. Este rendimiento es crítico para mantener el "estado de flujo" (flow state) durante sesiones intensas de escritura, evitando las micro-interrupciones que degradan la concentración.

<!-- -->

-   Resiliencia, Longevidad y "Future-Proofing": El software científico debe ser tan duradero como la investigación que soporta. ResearchOS es inmune a la obsolescencia de APIs externas, cambios en los términos de servicio de grandes corporaciones o la desaparición de proveedores de nube. Si conservas estos archivos estáticos y tienes acceso a un navegador, tu base de conocimientos permanece funcional y accesible décadas después (las librerías de terceros se cargan desde cdnjs con comprobación de integridad SRI y se guardan en caché para uso sin conexión; ver abajo), asegurando que su legado intelectual no dependa de una suscripción activa.

<!-- -->

-   Reproducción, Portabilidad y Formatos Abiertos: Al basarse en estándares universales como Markdown para texto, BibTeX para citas y JSON para la estructura de datos, el sistema evita el "vendor lock-in". Su conocimiento es fácilmente exportable, procesable por otras herramientas científicas y legible por humanos, lo que facilita la auditoría y la transparencia en la ciencia abierta.

## 👨‍💻 Arquitectura Técnica y Patrones de Diseño Avanzados

La aplicación ha sido desarrollada siguiendo los principios del "Modern Vanilla JS", demostrando que es posible construir herramientas robustas, seguras y escalables sin la fragilidad y el peso excesivo de los frameworks modernos de corta vida.

-   **Gestión del DOM mediante Delegación de Eventos Inteligente**: Para mantener una interfaz extremadamente dinámica sin sacrificar la tasa de cuadros por segundo (FPS), ResearchOS implementa un patrón de delegación de eventos centralizado. En lugar de saturar la memoria con miles de escuchadores individuales para cada subelemento (como cada celda del Kanban o cada ítem de una lista), un único manejador en el nivel superior intercepta y procesa las acciones basándose en atributos de datos (data-attributes). Esto permite manejar bases de datos con miles de entradas manteniendo una fluidez absoluta en el desplazamiento y las animaciones.

<!-- -->

-   **Refresco inmediato de lo que ves**: cualquier escritura en la base de datos (desde el inspector, un modal, una tarjeta o la consola) avisa a un único punto central (`Live` en [app.js](src/core/app.js)), que repinta la vista abierta y el inspector sin vaciarlos, conservando el scroll de la página y de las listas internas (columnas del tablero). Si el manejador que guardó ya repintó, no se repite; si estás escribiendo en un campo, espera a que lo sueltes para no pisarte el texto; si tienes un botón pulsado (entre «pulsar» y «soltar») tampoco repinta, para que el clic no se pierda, y un freno evita cadenas de repintados. Las capturas (barra de Hoy, idea rápida, «→ Tarea / → Proyecto») ignoran un segundo Enter o clic mientras guardan, así que un doble toque no crea duplicados. Los textos larguísimos sin espacios (URLs, DOIs, nombres) se parten dentro de su caja en lugar de desbordarla. Los cambios más frecuentes (completar una tarea, editar un campo del inspector) se muestran al instante y la base de datos se actualiza detrás.

<!-- -->

-   **Persistencia Robusta con Dexie.js**: Aunque IndexedDB es el motor subyacente, ResearchOS utiliza Dexie.js para estructurar una base de datos local relacional y transaccional. Esto permite ejecutar consultas indexadas rápidas, manejar migraciones de esquema automáticas y asegurar la integridad referencial entre proyectos, tareas y referencias bibliográficas. Todo opera de forma aislada dentro del sandbox de seguridad del navegador, garantizando que los datos de un proyecto no interfieran con otros.

<!-- -->

-   **Paradigma Zero-Backend y Despliegue Atómico**: La lógica de negocio reside íntegramente en el cliente. Esto no solo mejora la seguridad, sino que simplifica el despliegue a una simple entrega de activos estáticos (HTML, JS, CSS). No hay bases de datos SQL que configurar en un servidor, ni contenedores Docker que orquestar, ni configuraciones de Nginx o certificados SSL de servidor que gestionar. Es la definición más pura de "computación en el borde" (edge computing).

## 🧭 Cómo se usa en el día a día

La app está pensada para quien coordina varios frentes a la vez (investigación, docencia, gestión) y no quiere perderse entre capas:

-   **Hoy** es el punto de partida. Muestra lo atrasado y lo de hoy, la semana (agrupada por día), los pendientes sin fecha, lo que esperas de otras personas, los proyectos sin siguiente paso, las ideas por revisar y lo que está esperando respuesta (un paper en revisión no genera alarmas). Las métricas viven plegadas en *Panorama*.
-   **Captura rápida** (tecla `C`, o `Ctrl/⌘ + K` desde cualquier vista): `enviar borrador >vega viernes @alfa !alta` crea una tarea en ese proyecto, **esperando a** esa persona, con fecha y prioridad. `clase cada lunes hasta 15/12` crea una tarea recurrente. Prefijos `idea:`, `t:`, `p:` y `r:` fuerzan el tipo; sin nada de eso, lo escrito va a la bandeja de ideas.
-   **Tareas** con fecha, responsable y repetición, en proyectos, ideas o sueltas; se completan, posponen y reasignan desde Hoy sin abrir nada. Cada tarjeta del Tablero muestra su avance (`✓ 2/5`) y su **próxima acción** (`→ Enviar carta · ayer`). Las plantillas de paper, grant, curso y ponencia crean sus tareas con fechas relativas a la fecha límite.
-   **Personas**: la ficha de cada colaborador muestra lo que esperas de él o ella y copia una **agenda** lista para pegar; una reunión muestra los pendientes de sus asistentes.
-   **Proyectos en una sola pantalla**, con pestañas Tablero · Lista · Línea de tiempo · Jerarquía. Una idea se convierte en tarea o proyecto con un clic.
-   **Áreas como contexto**: elige un área en el menú lateral y Hoy, el Tablero y Proyectos muestran solo ese frente.
-   **Enlaces `[[Título]]`** entre proyectos, ideas, snippets, referencias, reuniones y personas, con autocompletado; cada elemento muestra desde dónde lo enlazan.
-   **Referencias**: importa el `.bib`/`.ris` de Zotero o Mendeley (sin duplicar), marca su estado de lectura y exporta BibTeX válido.
-   **Calendario**: exporta fechas límite, tareas (con su repetición) y reuniones a `.ics`, e importa un `.ics` (p. ej. el horario de clases).
-   **Revisión semanal** guiada de ocho pasos (ideas, atrasos, proyectos quietos, sin próxima acción, próximos 14 días, esperas, elementos sin proyecto y backup).
-   **Copia automática a una carpeta** (Chrome/Edge): tus datos se duplican en la carpeta que elijas (Dropbox, Drive, Syncthing…) tras cada cambio. La app es **instalable (PWA)** y acepta *Compartir → ResearchOS* desde el móvil para capturar ideas.
-   **Mi día**: `☀ Planificar mi día` (en Hoy) lista lo atrasado, lo de hoy y lo próximo; tú eliges qué harás según el **tiempo disponible** (por defecto 6 h) y el **tiempo estimado** de cada tarea (`~2h`, `~30m`, `~1h30` en la captura). Lo que no termines pasa solo al día siguiente, y el medidor avisa cuándo te pasas.
-   **Red**: un grafo estilo Obsidian de todo lo que has guardado —proyectos, ideas, snippets, referencias, reuniones, personas, áreas y (opcional) tareas—, con las conexiones estructurales y tus enlaces `[[Título]]` (línea punteada). Filtros por tipo, zoom/arrastre y *grafo local* (vecindad a N saltos) con doble clic o con «Aislar». **Pensada para muchos elementos:** las etiquetas se colocan por importancia (áreas, proyectos y lo más conectado primero) y solo si caben sin pisarse ni tapar otros nodos —al acercar aparecen más— con un control «Auto / Más / Ninguna»; un clic selecciona el nodo (queda resaltada su vecindad y aparece una ficha con «Abrir» y «Aislar»; en el móvil no se abre el inspector por encima del grafo); la búsqueda lista los resultados (↑ ↓ Enter) y la vista «vuela» hasta el elegido; los grafos grandes se separan solos más; y con el grafo enfocado `+` `−` `0`, las flechas y `Esc` lo manejan sin ratón.
-   **Informe de avance** (Más → Informe de avance): qué lograste esta semana, este mes o el año (tareas, proyectos terminados, envíos, reuniones, lecturas), para tu memoria anual, tu CV o tu jefatura; se copia o descarga como Markdown.
-   **Seguimiento de personas**: en la ficha de cada colaborador fija una cadencia («cada 2 semanas» con tu tesista). Hoy te avisa cuando toca escribirle, con un correo ya redactado con la agenda de pendientes; una reunión reciente cuenta como contacto.
-   **Docencia**: en un proyecto de tipo *Curso*, `📅 Generar clases` crea una reunión por sesión (días de la semana, rango y feriados) y `📝 + Evaluación` crea la evaluación y su corrección con el tiempo estimado.
-   **Manuscritos y grants**: en un *Paper*, `↩ Responder a revisores` convierte la revisión pegada en una tarea por comentario y copia la plantilla de carta; la plantilla *Ejecución de grant* programa rendiciones e informes de avance recurrentes.
-   **Traer lo que ya tienes**: con la app vacía, Hoy ofrece crear áreas e importar `.bib/.ris`, tareas desde **CSV (Todoist, Notion, Excel)** o un backup anterior. Lo mismo está en Ajustes.
-   **Búsqueda (Ctrl/⌘ + K)** encuentra proyectos, ideas, **tareas, personas**, referencias (también por notas, clave de cita y palabras clave), reuniones y **el código de los snippets**; con varias palabras, todas deben aparecer.
-   **Recorrido guiado para quien llega por primera vez** (`tour.js`): un paseo de ~3 minutos que ilumina el elemento real de cada pantalla, te lleva a la vista correcta y, en los pasos «Tu turno», espera a que lo hagas (capturar una tarea, completarla, abrir un proyecto, abrir la paleta…) y avanza solo. Se puede salir con `Esc` y retomar donde quedó; funciona en el móvil (el cartel se ancla arriba o abajo sin tapar nada). Se inicia desde la bienvenida, Hoy (si está vacío), el Tutorial, la paleta y Ajustes. En Hoy, una lista de **Primeros pasos** se marca sola según lo que haces (áreas, primera tarea, proyecto, idea, mover una tarjeta, buscador, copia de seguridad).
-   **Datos de ejemplo dinámicos** (`sample.js`): el laboratorio de ejemplo se genera al cargarlo y **todas las fechas se calculan desde hoy**, así que siempre hay atrasos, tareas de hoy y de la semana, un paper esperando respuesta, personas a las que toca escribirles, una clase hoy, etc. Usa todas las piezas de la app (áreas, siete tipos de proyecto con jerarquía, archivado y favoritos, tareas recurrentes y asignadas con tiempo estimado y plan del día, ideas con subtareas, reuniones con acuerdos, envíos con rondas de revisión, referencias con estado de lectura, snippets por colección, seguimiento de personas y enlaces `[[Título]]`). Todo lleva el prefijo `smp:`: «Quitar ejemplo» borra solo eso (lo que creaste tú, aunque cuelgue de un proyecto de ejemplo, se conserva) y «Reiniciar con fechas de hoy» lo vuelve a generar. Hoy avisa cuando el ejemplo tiene más de una semana.
-   **Teclado y ayudas**: `?` muestra todos los atajos; `/` lleva el cursor al filtro de la lista (Ideas, Snippets, Referencias, Reuniones, Colaboradores); `Ctrl/⌘ + Z` deshace lo último aunque el aviso ya haya desaparecido; `Alt + ←/→` recorre el historial; `Tab` + `Enter` abren filas y tarjetas. La paleta (`Ctrl/⌘ + K`) encuentra todas las vistas por sinónimos («grafo» → Red, «gantt» → Línea de tiempo) y ejecuta acciones (nuevo proyecto, planificar mi día, cambiar de tema).
-   **Borrar sin miedo**: eliminar una idea, snippet, reunión, referencia, colaborador o proyecto no pregunta; en su lugar ofrece **Deshacer**. Solo se confirma (con un diálogo propio, no el del navegador) lo masivo o irreversible; «Borrar todos los datos» exige escribir `BORRAR`. Cerrar una ventana con texto sin guardar pide confirmación; en las ventanas, `Enter` en un campo de una línea guarda.
-   **Cuando algo falla, no te deja a medias**: si una pantalla no puede pintarse, aparece una pantalla de recuperación (reintentar, ir a Hoy, descargar copia) en lugar de quedar en blanco; los errores inesperados se guardan solo en tu navegador y se ven en **Ajustes → Diagnóstico** (con «Copiar informe» para contarlos); copiar al portapapeles tiene alternativa cuando el navegador lo niega; si otra pestaña actualiza la base de datos, esta avisa y ofrece recargar; y si el navegador se queda sin espacio, lo dice claramente. Importar un backup o cargar el ejemplo programa la copia automática y la subida a la carpeta compartida, como cualquier otro cambio.
-   **Móvil**: en pantallas estrechas aparece una barra inferior (Hoy · Proyectos · ＋ · Ideas · Más) y el botón `＋` captura desde cualquier vista sin cambiar de pantalla. Un aviso diario opcional (Ajustes → Planificación) recuerda lo que toca hoy mientras la app esté abierta.
-   **Ajustes → Qué vistas usas** cuenta (solo en tu navegador) qué pantallas abres, para decidir qué te sobra.
-   El menú lateral muestra solo lo esencial (Hoy, Proyectos, Ideas, Calendario); el resto está en grupos plegables, y lo avanzado (campos personalizados, Google Drive) en Ajustes → Avanzado.

## 📊 Funcionalidades Detalladas y Flujo de Trabajo Científico

ResearchOS integra herramientas que habitualmente requerirían cinco aplicaciones distintas en un único espacio de trabajo optimizado para la mente científica:

-   **Gestión de Proyectos Kanban de Grado Científico**: Más allá de un simple tablero de tareas, permite organizar flujos experimentales mediante columnas dinámicas y swimlanes (carriles horizontales). Esto facilita la visualización de múltiples líneas de investigación simultáneas o la separación de tareas por responsables, permitiendo detectar cuellos de botella en la fase de revisión, experimentación o recolección de datos en tiempo real.

<!-- -->

-   **Escritura Científica con Rigor Matemático**: Las notas de investigación no son texto plano. ResearchOS utiliza marked.js para el parseo de Markdown y KaTeX para la tipografía matemática. Esto permite integrar ecuaciones de campo, derivadas complejas o notación química directamente en las notas con una calidad de renderizado idéntica a la de una publicación de revista (LaTeX), procesada en milisegundos mientras escribes.

<!-- -->

-   **Repositorio de Snippets de Código Multilingüe**: Centraliza scripts de análisis crítico en Python, R, Julia, SQL o Bash. Gracias a la integración de Highlight.js, el código se presenta con resaltado de sintaxis profesional. Los snippets pueden vincularse a proyectos específicos, creando una biblioteca de métodos de análisis reutilizables, documentados y listos para ser copiados a su entorno de ejecución principal.

<!-- -->

-   **Gestor de Referencias con Exportación BibTeX Nativa**: Documenta la literatura relevante a medida que la descubres durante la fase de revisión bibliográfica. El sistema permite almacenar metadatos esenciales (DOI, autores, revistas, año) y genera archivos BibTeX perfectamente formateados. Esto elimina la fricción manual al pasar de la fase de lectura a la redacción final de manuscritos en editores LaTeX externos.

<!-- -->

-   **Paleta de Comandos (Command Palette) de Alta Velocidad**: Inspirada en herramientas de productividad de élite, la paleta de comandos (accesible vía Ctrl+K o Cmd+K) permite una navegación "manos en el teclado". Puedes saltar entre proyectos, buscar una idea específica guardada hace meses o cambiar el tema visual sin interrumpir tu flujo de trabajo manual ni depender del ratón.

<!-- -->

-   **Modo Offline y Preparación para el Trabajo de Campo**: Diseñada para el trabajo en el laboratorio, en el campo o en tránsito. La aplicación no requiere conexión para ninguna de sus funciones principales. Las futuras implementaciones permitirán la sincronización opcional con nubes personales (como Google Drive mediante su API oficial) para respaldo, manteniendo siempre el cifrado y el control de las claves en el lado del cliente.

## 🖥️ Tech Stack y Estética "Scientific Terminal Noir"

El diseño visual y técnico de ResearchOS busca reducir la fatiga cognitiva durante las largas jornadas de análisis de datos:

-   **Diseño Editorial Suizo & CSS3 Moderno**: El sistema de diseño utiliza variables CSS para una gestión de temas flexible y coherente. La estética visual mezcla el minimalismo suizo con una paleta oscura táctica, utilizando tipografías como Syne para visualización de titulares de datos y DM Sans para una lectura cómoda de textos largos y densos.
-   **Tipografía Monoespaciada JetBrains Mono**: Seleccionada específicamente para los bloques de código y datos crudos, asegurando que cada carácter, coma y paréntesis sea distinguible, reduciendo errores en la revisión de código.

### ⚡️ Componentes de Alto Rendimiento:

-   **Dexie.js** (v3.2.4): Proporciona transacciones ACID locales para evitar la corrupción de datos.
-   **Highlight.js** (v11.9.0): Soporte automático para más de 180 lenguajes de programación.
-   **marked.js** (v9.1.6): Compilador de Markdown altamente optimizado para documentos extensos.
-   **KaTeX** (v0.16.9): El motor de renderizado matemático más rápido de la web, diseñado para no bloquear el hilo principal de ejecución.

## 🗂️ Estructura del repositorio

Sin paso de compilación: lo que ves aquí es lo que ejecuta el navegador. Ninguna carpeta pasa de 5 archivos; la raíz guarda los 7 que por convención deben estar ahí (los de arriba más `LICENSE.md`, `README.md`, `package.json`, `package-lock.json` y `ResearchOS.Rproj`).

```
index.html            Página única: carga estilos y scripts en este orden
sw.js                 Service worker (vive en la raíz para controlar toda la app)
assets/
  style.css           Estilos
  manifest.webmanifest  Instalación como app (PWA)
  icons/              Iconos de la app
src/
  core/               Base: db.js (datos), icons.js, app.js (núcleo y vistas), shell.js (barra móvil y captura)
  modules/            Funciones por área: today.js (Hoy), network.js (Red), planner.js (Mi día e informe),
                      academic.js (docencia y manuscritos), tour.js (recorrido guiado y primeros pasos)
  services/           Datos y sincronización: vault.js (copia cifrada), sync.js (entre dispositivos),
                      integrations.js (copia automática y .ics), sample.js (datos de ejemplo)
docs/                 CHANGELOG.md
tests/
  playwright.config.js
  e2e/                helpers.js y las pruebas por tema: app/ · views/ · data/ · features/ · onboarding/ · quality/ · robustness/
```

El orden de los scripts importa (cada uno usa los globales del anterior); está en `index.html`.

## 🔌 Guía de Inicio y Despliegue sin Fricciones

ResearchOS no tiene una fase de "build" ni requiere compiladores previos. El código que ves en el repositorio es exactamente el código que ejecuta tu navegador.

### ☁ ️Ejecución Local en 3 Pasos

Clona el repositorio:

```         
git clone [https://github.com/matcasti/ResearchOS.git](https://github.com/matcasti/ResearchOS.git)
cd ResearchOS
```

Sirve los archivos: Debido a las estrictas políticas de seguridad de los navegadores modernos para módulos JavaScript (ES6), los archivos deben servirse a través de un servidor web local simple para que las rutas relativas y los workers funcionen correctamente.

-   Opción Python: `python -m http.server 8000`
-   Opción Node.js: `npx http-server`
-   Opción PHP: `php -S localhost:8000`

Inicia tu Investigación: Abre tu navegador favorito y accede a <http://localhost:8000>. Experimenta inmediatamente el poder de una gestión científica local, privada y ultrarrápida.

### 🔄 Usarlo en varios dispositivos

*Ajustes → Sincronización entre dispositivos* (Chrome/Edge): eliges una carpeta compartida (Dropbox, Drive, Syncthing, OneDrive…) en cada equipo y ResearchOS deja allí un archivo por dispositivo, que los demás fusionan. No hay servidor ni cuenta. Cada registro lleva un identificador propio y una marca de tiempo; ante un conflicto **gana el cambio más reciente de cada registro**, y los borrados se propagan. Límites a tener en cuenta:

-   La fusión es **por registro, no por campo**: si editas el mismo proyecto en dos equipos antes de sincronizar, se queda la versión más reciente completa.
-   Depende de que los relojes de los equipos estén razonablemente en hora.
-   Los archivos de sincronización **no están cifrados** (la carpeta es tan privada como tu nube). Para un backup protegido usa *Exportar cifrado*.
-   La carpeta compartida requiere un navegador basado en Chromium; en otros navegadores sigue funcionando el export/import manual.

### 📴 Uso sin conexión

Tras la **primera visita con conexión** (servida por `http://localhost` o `https://`), un *service worker* ([sw.js](sw.js)) guarda la app y sus librerías: las siguientes veces arranca sin Internet. Los archivos propios usan «red primero» (siempre ves tu última versión), pero si la red tarda más de 3,5 s se sirve la copia guardada, así una conexión lenta no deja la app colgada. Las librerías pesadas y opcionales (resaltado de código, LaTeX y Google Identity para Drive) **se descargan solo cuando se necesitan**: un arranque típico pide ~115 KB de librerías en vez de ~540 KB y no contacta a Google; igualmente quedan guardadas para el uso sin conexión. Si abres `index.html` directamente (`file://`) la app funciona, pero necesita conexión la primera vez para descargar las librerías y no cachea nada. Si faltan librerías críticas, la app lo explica en pantalla en lugar de quedarse en blanco.

### 🧪 Pruebas end-to-end

```
npm install
npx playwright install chromium
npm run test:e2e
```

Las pruebas están en [tests/e2e](tests/e2e), agrupadas por tema (`app/`, `views/`, `data/`, `features/`, `onboarding/`, `quality/`, `robustness/`) y su configuración en `tests/playwright.config.js`: usa siempre `npm run test:e2e` (o `npx playwright test -c tests`).

La suite cubre las vistas, la captura, las tareas, la sincronización entre dos «dispositivos», el grafo, la planificación, el informe, el módulo académico, la copia cifrada, la barra móvil, el barrido de XSS por cada campo de texto y un humo de rendimiento con ~7 000 elementos, y una auditoría de calidad que recorre todas las vistas a 360, 768, 1024 y 1440 px (sin desbordes) y comprueba nombres accesibles, ids únicos y consola limpia, otra («overflow») que repite el barrido a 320, 360 y 1280 px con el laboratorio de ejemplo y con textos larguísimos sin espacios (URLs, DOIs, nombres) para asegurar que nada se sale de su caja, y otra que verifica que cada cambio pequeño se ve al instante (sin vaciar el inspector ni perder el scroll), otras para el ejemplo dinámico (`sample`), el recorrido (`tour`), la integridad de datos (`integrity`: copia → vaciar → restaurar con el escenario completo, fusiones, recuperación ante fallos, horario de verano y zonas horarias), y otra («ux») con la coherencia visual, el teclado, los diálogos, los filtros de lista y el móvil. Usa Playwright, levanta su propio servidor estático y no necesita compilar nada. Las librerías de CDN se cachean en `tests/e2e/.cdn-cache` para que las pruebas sean rápidas y deterministas.

## Advertencia Crítica sobre la Gestión de Datos

Al ser una aplicación Local-First, la responsabilidad de la seguridad física de la información recae enteramente en el usuario. Los datos residen exclusivamente en el almacenamiento persistente de su perfil de navegador.

-   **Cuidado con la Limpieza Automática**: Las herramientas de "limpieza profunda" de sistema o extensiones que borran cookies y caché pueden eliminar la base de datos de IndexedDB si no se configuran excepciones para el dominio donde corre ResearchOS.
-   **Backups Periódicos Obligatorios**: Utilice la función integrada de Exportar JSON en el panel de configuración para realizar copias de seguridad de toda su base de conocimientos. La app te avisa si llevas más de 14 días sin exportar, descarga una copia automática antes de «Reemplazar todo» o «Borrar todos los datos», y pide al navegador almacenamiento persistente para evitar que lo evacúe. Guarde estos archivos en almacenamiento físico externo o nubes privadas cifradas. Para datos sensibles (estudiantes, evaluaciones, borradores de grants) usa **Ajustes → Copia cifrada**: AES-256-GCM con una clave derivada de tu contraseña (PBKDF2); la contraseña no se guarda en ningún sitio, así que **si la pierdes el archivo no se puede recuperar**.
-   **Seguridad de Acceso Físico**: Si utiliza computadoras compartidas, recuerde que cualquier persona con acceso a su sesión de usuario en el navegador podrá visualizar su base de datos local. Recomendamos usar perfiles de navegador protegidos por contraseña.

## Una herramienta para la mente libre

ResearchOS nace de la convicción de que el conocimiento científico no debe ser rehén de infraestructuras corporativas ni de algoritmos de extracción de datos. En una era de sobrecarga informativa y dependencia de la nube, la verdadera libertad intelectual requiere herramientas que respeten el espacio sagrado de la reflexión y el rigor. Al ejecutar este software, no solo estás gestionando un flujo de trabajo; estás reclamando tu derecho a un entorno de pensamiento privado, duradero y sin interferencias. La ciencia es local, la mente es soberana y el código debe estar a su servicio.
