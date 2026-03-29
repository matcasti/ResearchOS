# 🔬 ResearchOS — Scientific Workflow Suite

ResearchOS no es simplemente una herramienta de organización; es una infraestructura digital de vanguardia diseñada para la gestión integral de flujos de trabajo científicos. Concebida bajo el estricto paradigma local-first, esta Single-Page Application (SPA) de alto rendimiento permite a investigadores, académicos y desarrolladores de datos centralizar su producción intelectual en un ecosistema donde la soberanía del dato, la velocidad de respuesta y la resiliencia operativa no son opcionales, sino pilares fundacionales de la práctica científica moderna.

En un panorama tecnológico dominado por el "Software como Servicio" (SaaS) que fragmenta la información en silos de terceros y compromete la privacidad, ResearchOS devuelve el control absoluto al investigador. La aplicación opera sin un backend centralizado tradicional, utilizando el motor IndexedDB del navegador para cifrar y almacenar de manera persistente notas de laboratorio, fragmentos de código, bibliografías y planificaciones de proyectos complejos, garantizando que su trabajo sea accesible incluso en las condiciones más extremas de conectividad.

## 🤚 Filosofía Local-First: Privacidad, Soberanía y Reproducibilidad

La decisión de implementar una arquitectura local-first no es solo una elección técnica, sino una postura ética y práctica frente a la gestión del conocimiento científico:

-   Privacidad Absoluta y Seguridad de Grado de Laboratorio: Los datos de investigación, que a menudo incluyen hipótesis no publicadas, datos sensibles de pacientes o borradores sujetos a embargos de patentes, nunca abandonan el dispositivo del usuario. Al eliminar la transmisión a servidores externos, se mitigan los riesgos de filtraciones de datos (data breaches) y se garantiza el cumplimiento de normativas de privacidad (como GDPR o HIPAA) sin necesidad de configuraciones de servidor complejas.

<!-- -->

-   Latencia Cero e Interactividad Fluida: La interfaz no espera a la red. Al no haber latencia de servidor (round-trip), cada acción —desde mover una tarjeta en el Kanban hasta renderizar una ecuación diferencial compleja— ocurre en microsegundos. Este rendimiento es crítico para mantener el "estado de flujo" (flow state) durante sesiones intensas de escritura, evitando las micro-interrupciones que degradan la concentración.

<!-- -->

-   Resiliencia, Longevidad y "Future-Proofing": El software científico debe ser tan duradero como la investigación que soporta. ResearchOS es inmune a la obsolescencia de APIs externas, cambios en los términos de servicio de grandes corporaciones o la desaparición de proveedores de nube. Si conservas este archivo HTML y tienes acceso a un navegador, tu base de conocimientos permanece funcional y accesible décadas después, asegurando que su legado intelectual no dependa de una suscripción activa.

<!-- -->

-   Reproducción, Portabilidad y Formatos Abiertos: Al basarse en estándares universales como Markdown para texto, BibTeX para citas y JSON para la estructura de datos, el sistema evita el "vendor lock-in". Su conocimiento es fácilmente exportable, procesable por otras herramientas científicas y legible por humanos, lo que facilita la auditoría y la transparencia en la ciencia abierta.

## 👨‍💻 Arquitectura Técnica y Patrones de Diseño Avanzados

La aplicación ha sido desarrollada siguiendo los principios del "Modern Vanilla JS", demostrando que es posible construir herramientas robustas, seguras y escalables sin la fragilidad y el peso excesivo de los frameworks modernos de corta vida.

-   **Gestión del DOM mediante Delegación de Eventos Inteligente**: Para mantener una interfaz extremadamente dinámica sin sacrificar la tasa de cuadros por segundo (FPS), ResearchOS implementa un patrón de delegación de eventos centralizado. En lugar de saturar la memoria con miles de escuchadores individuales para cada subelemento (como cada celda del Kanban o cada ítem de una lista), un único manejador en el nivel superior intercepta y procesa las acciones basándose en atributos de datos (data-attributes). Esto permite manejar bases de datos con miles de entradas manteniendo una fluidez absoluta en el desplazamiento y las animaciones.

<!-- -->

-   **Persistencia Robusta con Dexie.js**: Aunque IndexedDB es el motor subyacente, ResearchOS utiliza Dexie.js para estructurar una base de datos local relacional y transaccional. Esto permite ejecutar consultas indexadas rápidas, manejar migraciones de esquema automáticas y asegurar la integridad referencial entre proyectos, tareas y referencias bibliográficas. Todo opera de forma aislada dentro del sandbox de seguridad del navegador, garantizando que los datos de un proyecto no interfieran con otros.

<!-- -->

-   **Paradigma Zero-Backend y Despliegue Atómico**: La lógica de negocio reside íntegramente en el cliente. Esto no solo mejora la seguridad, sino que simplifica el despliegue a una simple entrega de activos estáticos (HTML, JS, CSS). No hay bases de datos SQL que configurar en un servidor, ni contenedores Docker que orquestar, ni configuraciones de Nginx o certificados SSL de servidor que gestionar. Es la definición más pura de "computación en el borde" (edge computing).

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

## Advertencia Crítica sobre la Gestión de Datos

Al ser una aplicación Local-First, la responsabilidad de la seguridad física de la información recae enteramente en el usuario. Los datos residen exclusivamente en el almacenamiento persistente de su perfil de navegador.

-   **Cuidado con la Limpieza Automática**: Las herramientas de "limpieza profunda" de sistema o extensiones que borran cookies y caché pueden eliminar la base de datos de IndexedDB si no se configuran excepciones para el dominio donde corre ResearchOS.
-   **Backups Periódicos Obligatorios**: Utilice la función integrada de Exportar JSON en el panel de configuración para realizar copias de seguridad de toda su base de conocimientos. Guarde estos archivos en almacenamiento físico externo o nubes privadas cifradas.
-   **Seguridad de Acceso Físico**: Si utiliza computadoras compartidas, recuerde que cualquier persona con acceso a su sesión de usuario en el navegador podrá visualizar su base de datos local. Recomendamos usar perfiles de navegador protegidos por contraseña.

## Una herramienta para la mente libre

ResearchOS nace de la convicción de que el conocimiento científico no debe ser rehén de infraestructuras corporativas ni de algoritmos de extracción de datos. En una era de sobrecarga informativa y dependencia de la nube, la verdadera libertad intelectual requiere herramientas que respeten el espacio sagrado de la reflexión y el rigor. Al ejecutar este software, no solo estás gestionando un flujo de trabajo; estás reclamando tu derecho a un entorno de pensamiento privado, duradero y sin interferencias. La ciencia es local, la mente es soberana y el código debe estar a su servicio.
