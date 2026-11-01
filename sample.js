// ============================================================
//  ResearchOS — Datos de ejemplo dinámicos
//
//  El laboratorio de ejemplo se construye al momento de cargarlo, con todas las fechas calculadas a partir de «hoy»:
//  siempre hay tareas atrasadas, para hoy, de esta semana y de más adelante; un paper en revisión que espera respuesta;
//  personas a las que toca escribirles; clases de esta semana; etc. Así Hoy, el Calendario, la Línea de tiempo, el Informe
//  de avance y la Red se ven como una semana real de trabajo, y no como datos que envejecen.
//
//  Todo lo que crea lleva un uid con prefijo «smp:», de modo que se puede quitar (o reiniciar con fechas nuevas) sin tocar
//  nada de lo que la persona haya creado por su cuenta.
//  Usa todas las piezas de la app: áreas, proyectos de cada tipo (con jerarquía, archivado, favorito, historial), tablero,
//  tareas (con fecha, repetición, tiempo estimado, plan del día y «esperando a»), ideas con sus tareas, reuniones con
//  acuerdos y clases, envíos con rondas de revisión, referencias con estado de lectura, snippets por colección, personas con
//  seguimiento, enlaces [[Título]] y elementos sin proyecto.
// ============================================================

'use strict';

const SAMPLE_PREFIX = 'smp:';

/**
 * Construye el backup de ejemplo (el mismo formato que exporta la app) con fechas relativas a `base`.
 * No toca la base de datos: `loadSampleData()` lo importa.
 */
function buildSampleData(base = new Date()) {
  const Y = base.getFullYear();
  const d0 = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const shift = n => new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + n);
  const day = n => localDateISO(shift(n));                                       // «YYYY-MM-DD» a n días de hoy
  const at = (n, h = 10, m = 0) => new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + n, h, m).toISOString();
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const monthIn = n => MONTHS[shift(n).getMonth()];

  const seq = {};
  const uid = t => `${SAMPLE_PREFIX}${t}:${(seq[t] = (seq[t] || 0) + 1)}`;
  const wrap = (table, rows) => rows.map(r => ({ ...r, uid: uid(table) }));

  // ── Títulos (los enlaces [[Título]] deben coincidir exactamente) ──────────────────────────
  const T = {
    grant:  'FONDECYT: Impacto del Cambio Climático en Biodiversidad Andina',
    obj1:   'Objetivo 1 · Cambios de distribución',
    obj2:   'Objetivo 2 · Escenarios futuros (SSP)',
    paper:  'Paper: Diversidad funcional en bosques siempreverdes',
    paper2: 'Paper: Modelos de nicho de Araucaria bajo cambio climático',
    paper3: 'Paper: Desplazamientos altitudinales de plantas vasculares',
    ndvi:   `Análisis NDVI — Series de tiempo Landsat 8/9 (2013–${Y})`,
    flora:  `Dataset: Flora Vascular Patagónica (1900–${Y})`,
    isme:   'Ponencia ISME — Microbioma del suelo andino',
    lab:    'Coordinación del laboratorio',
    tesis:  'Tesis Magíster: Conectividad de bosques en Nahuelbuta',
    done:   'Paper publicado: Fenología reproductiva de Araucaria',
    curso:  'Curso: Ecología de Comunidades',
    pilot:  'Piloto: muestreo de micorrizas',
  };
  const R = {                                       // referencias (también enlazables)
    parmesan: 'Fingerprints of global warming on wild animals and plants',
    siefert:  'A global meta-analysis of the relative extent of intraspecific trait variation in plant communities',
    violle:   'Let the concept of trait be functional!',
    ipcc:     'Terrestrial and Inland Water Systems — IPCC AR5 Working Group II, Chapter 4',
  };

  // ── Columnas del tablero (las mismas que trae la app: se reconocen por nombre) ────────────
  const COL = { ideacion: 1, limpieza: 2, analisis: 3, escritura: 4, review: 5, completado: 6 };
  const kanbanColumns = [
    { id: 1, title: 'Ideación', order: 0, color: '#3b82f6', isDefault: true },
    { id: 2, title: 'Limpieza de Datos', order: 1, color: '#f59e0b', isDefault: true },
    { id: 3, title: 'Análisis', order: 2, color: '#8b5cf6', isDefault: true },
    { id: 4, title: 'Escritura', order: 3, color: '#10b981', isDefault: true },
    { id: 5, title: 'Peer Review', order: 4, color: '#f97316', isDefault: true },
    { id: 6, title: 'Completado', order: 5, color: '#14b8a6', isDefault: true },
  ];

  // ── Áreas (viven en settings) ─────────────────────────────────────────────────────────────
  const A = { inv: 1, doc: 2, ges: 3, per: 4 };
  const areas = [
    { id: 1, name: 'Investigación', color: '#3b82f6', description: 'Grants, papers, análisis y datos' },
    { id: 2, name: 'Docencia', color: '#10b981', description: 'Cursos, clases y evaluaciones' },
    { id: 3, name: 'Gestión', color: '#f59e0b', description: 'Laboratorio, presupuesto y convenios' },
    { id: 4, name: 'Personal', color: '#a78bfa', description: 'Trámites y cosas propias' },
  ];

  // ── Personas (con cadencia de seguimiento: Hoy avisa cuando toca escribirles) ─────────────
  const P = { pablo: 1, andrea: 2, james: 3, sebas: 4 };
  const collaborators = wrap('collaborators', [
    { id: 1, name: 'Dr. Pablo Fuentes', role: 'Coinvestigador', affiliation: 'Universidad de Concepción — Dpto. de Botánica', email: 'p.fuentes@udec.cl',
      notes: 'Especialista en taxonomía de Nothofagaceae y ecología funcional. Co-PI del grant. Disponible para reuniones virtuales martes y jueves. Tiene acceso al herbario CONC.',
      followUpDays: 14, lastContact: day(-20), createdAt: at(-140), updatedAt: at(-9) },
    { id: 2, name: 'Lic. Andrea Vega', role: 'Asistente de investigación', affiliation: 'Laboratorio de Ecología del Paisaje — UCT', email: 'a.vega@uct.cl',
      notes: 'Lleva el pipeline de teledetección (GEE + R). Prefiere mensajes cortos por la mañana.',
      followUpDays: 7, lastContact: day(-3), createdAt: at(-140), updatedAt: at(-3) },
    { id: 3, name: 'Prof. James McKenzie', role: 'Colaborador internacional', affiliation: 'University of Edinburgh — School of GeoSciences', email: 'j.mckenzie@ed.ac.uk',
      notes: 'Experto en escenarios climáticos. Escribirle en inglés. Hay que pedirle la carta de apoyo del grant.',
      followUpDays: 30, lastContact: day(-41), createdAt: at(-140), updatedAt: at(-41) },
    { id: 4, name: 'Sebastián Mora', role: 'Tesista de magíster', affiliation: 'Universidad de Concepción', email: 's.mora@udec.cl',
      notes: 'Tesis de conectividad en Nahuelbuta. Reunión de seguimiento cada dos semanas.',
      followUpDays: 14, lastContact: day(-17), createdAt: at(-120), updatedAt: at(-17) },
  ]);

  // ── Proyectos ─────────────────────────────────────────────────────────────────────────────
  const hist = steps => steps.map(([colId, from, to]) => ({ colId, enteredAt: at(from), exitedAt: to == null ? null : at(to) }));
  const snap = (n, p) => ({ ts: at(n), title: p.title, type: p.type, priority: p.priority, responsible: p.responsible, deadline: p.deadline, description: p.description });
  const PI = 'Dra. María Castillo';
  const base_p = { status: 'active', archived: false, starred: false, tags: [], coauthors: [], coauthorIds: [], customFields: {}, responsible: PI, responsibleId: null, parentId: null };

  const grantDesc = `## Objetivo General
Evaluar los efectos del cambio climático sobre la biodiversidad de ecosistemas andinos entre los 1.500–3.500 m.s.n.m. en la zona centro-sur de Chile.

## Objetivos Específicos
1. Caracterizar cambios en distribución de 45 especies clave → [[${T.obj1}]]
2. Modelar escenarios futuros bajo IPCC SSP2-4.5 y SSP5-8.5 (horizonte 2070) → [[${T.obj2}]]
3. Proponer estrategias de conservación adaptativa con indicadores de monitoreo

## Financiamiento solicitado
$42.000.000 CLP · 36 meses · Convocatoria FONDECYT Regular ${Y + 1}

## Estado actual
Borrador de propuesta al 65%. Falta ampliar la metodología y reunir las cartas de apoyo de McKenzie y CONAF. Los resultados preliminares salen de [[${T.ndvi}]] y del paper [[${T.paper}]].`;

  const paperDesc = `## Resumen
Análisis de rasgos funcionales foliares (SLA, LDMC, CNC) en 12 especies dominantes de *Nothofagus* a lo largo de un gradiente altitudinal (800–1.800 m) en la Cordillera de Nahuelbuta.

## Estado actual
Manuscrito en **revisión mayor** en *Functional Ecology*. Hay que reenviar con la carta de respuesta antes del plazo.

## Cambios solicitados por revisores
- Revisor 1 ✓ (comentarios menores resueltos)
- Revisor 2 ✗ Ampliar la discusión comparando con meta-análisis europeos (ver [[${R.siefert}]])
- Revisor 2 ✗ Agregar Table S1 con rasgos completos por especie y sitio

## Target Journal
*Functional Ecology* — IF 5.2 · Q1 Ecology`;

  const projects = wrap('projects', [
    { ...base_p, id: 1, title: T.grant, type: 'Grant', columnId: COL.escritura, priority: 'Alta', areaId: A.inv, starred: true,
      coauthors: ['Dr. Pablo Fuentes', 'Lic. Andrea Vega'], coauthorIds: [P.pablo, P.andrea], deadline: day(38),
      tags: ['cambio climático', 'biodiversidad', 'Andes', 'FONDECYT', 'SDM'], description: grantDesc,
      customFields: { agency: 'ANID', callId: `FONDECYT-Regular-${Y + 1}`, amount: 42000000, duration: 36 },
      columnHistory: hist([[COL.ideacion, -140, -100], [COL.analisis, -100, -45], [COL.escritura, -45, null]]),
      createdAt: at(-140), updatedAt: at(-1) },
    { ...base_p, id: 2, title: T.obj1, type: 'Análisis', columnId: COL.analisis, priority: 'Alta', areaId: A.inv, parentId: 1,
      responsible: 'Lic. Andrea Vega', responsibleId: P.andrea, deadline: day(20), tags: ['SDM', 'MaxEnt', 'distribución'],
      description: `## Qué hacemos\nModelos de distribución (MaxEnt) para 45 especies con variables climáticas y de microhábitat.\n\n## Estado\nModelos corridos para 31 de 45 especies. Falta validar con validación cruzada espacial. Ver la idea de microhábitat y [[${R.siefert}]].`,
      columnHistory: hist([[COL.ideacion, -90, -70], [COL.analisis, -70, null]]), createdAt: at(-90), updatedAt: at(-2) },
    { ...base_p, id: 3, title: T.obj2, type: 'Análisis', columnId: COL.ideacion, priority: 'Media', areaId: A.inv, parentId: 1,
      deadline: day(60), tags: ['SSP', 'escenarios', '2070'],
      description: 'Proyecciones bajo SSP2-4.5 y SSP5-8.5 con los mejores modelos del Objetivo 1. Aún sin tareas: ¿cuál es el primer paso?',
      columnHistory: hist([[COL.ideacion, -50, null]]), createdAt: at(-50), updatedAt: at(-6) },
    { ...base_p, id: 4, title: T.paper, type: 'Paper', columnId: COL.review, priority: 'Alta', areaId: A.inv, deadline: day(9),
      coauthors: ['Dr. Pablo Fuentes'], coauthorIds: [P.pablo], tags: ['Nothofagus', 'rasgos funcionales', 'gradiente altitudinal', 'SLA'],
      description: paperDesc, targetVenue: 'Functional Ecology',
      customFields: { targetJournal: 'Functional Ecology', impactFactor: 5.2, wordCount: 8500, manuscriptUrl: 'https://www.overleaf.com/project/ejemplo' },
      submissionStatus: 'revision_solicitada', submittedAt: day(-75),
      submissionStatusHistory: [{ status: 'preparacion', date: at(-110) }, { status: 'enviado', date: at(-75) }, { status: 'en_revision', date: at(-74) }, { status: 'revision_solicitada', date: at(-14) }],
      submissionRounds: [{ submittedAt: day(-75), decisionDate: day(-14), decision: 'major', notes: 'Revisor 1: cambios menores. Revisor 2: ampliar discusión y agregar Tabla S1.' }],
      columnHistory: hist([[COL.ideacion, -150, -130], [COL.analisis, -130, -110], [COL.escritura, -110, -78], [COL.review, -78, null]]),
      createdAt: at(-150), updatedAt: at(-1),
      _history: [snap(-30, { title: T.paper, type: 'Paper', priority: 'Media', responsible: PI, deadline: day(-20), description: 'Manuscrito en revisión.' }),
                 snap(-14, { title: T.paper, type: 'Paper', priority: 'Alta', responsible: PI, deadline: day(9), description: paperDesc })] },
    { ...base_p, id: 5, title: T.paper2, type: 'Paper', columnId: COL.review, priority: 'Media', areaId: A.inv, coauthors: ['Lic. Andrea Vega'], coauthorIds: [P.andrea],
      tags: ['Araucaria', 'SDM', 'SSP5-8.5'], description: 'Proyecciones de nicho de *Araucaria araucana* hasta 2070. Enviado: ahora toca esperar la decisión del editor.',
      targetVenue: 'Diversity and Distributions', submissionStatus: 'en_revision', submittedAt: day(-30),
      submissionStatusHistory: [{ status: 'preparacion', date: at(-70) }, { status: 'enviado', date: at(-30) }, { status: 'en_revision', date: at(-28) }],
      columnHistory: hist([[COL.escritura, -70, -30], [COL.review, -30, null]]), createdAt: at(-70), updatedAt: at(-30) },
    { ...base_p, id: 6, title: T.paper3, type: 'Paper', columnId: COL.escritura, priority: 'Media', areaId: A.inv, deadline: day(55),
      coauthors: ['Dr. Pablo Fuentes'], coauthorIds: [P.pablo], tags: ['flora', 'Patagonia', 'altitud'], submissionStatus: 'preparacion', targetVenue: 'Journal of Biogeography',
      description: `Sintetiza los cambios de rango altitudinal con los registros de [[${T.flora}]].\n\n## Esquema\n1. Introducción\n2. Datos y métodos\n3. Resultados\n4. Discusión`,
      columnHistory: hist([[COL.analisis, -40, -12], [COL.escritura, -12, null]]), createdAt: at(-40), updatedAt: at(-4) },
    { ...base_p, id: 7, title: T.ndvi, type: 'Análisis', columnId: COL.analisis, priority: 'Media', areaId: A.inv, deadline: day(28),
      responsible: 'Lic. Andrea Vega', responsibleId: P.andrea, tags: ['teledetección', 'NDVI', 'Landsat', 'R', 'GEE'],
      description: `## Descripción
Procesamiento de imágenes Landsat 8 y 9 (2013–${Y}) para calcular NDVI estacional en las 48 parcelas de monitoreo del grant [[${T.grant}]].

## Pipeline
1. Descarga GEE → corrección atmosférica (LaSRC)
2. Enmascaramiento de nubes (CFmask)
3. Cálculo NDVI y EVI por escena
4. Extracción de valores por parcela (buffer 30 m)
5. Análisis de tendencia temporal (Mann-Kendall)
6. Visualización y exportación

## Estado
Pasos 1–3 completados. Paso 4 en progreso (60% de parcelas procesadas).

## Software
R 4.3 · \`terra\` · \`rgee\` · \`Kendall\``,
      columnHistory: hist([[COL.ideacion, -100, -80], [COL.limpieza, -80, -60], [COL.analisis, -60, null]]), createdAt: at(-100), updatedAt: at(-1) },
    { ...base_p, id: 8, title: T.flora, type: 'Dataset', columnId: COL.limpieza, priority: 'Baja', areaId: A.inv, responsible: 'Dr. Pablo Fuentes', responsibleId: P.pablo,
      tags: ['flora', 'Patagonia', 'herbario', 'ocurrencias', 'datos abiertos'],
      description: `## Descripción
Compilación de registros históricos de flora vascular patagónica desde herbarios digitalizados y literatura gris.

## Fuentes
- Herbario CONC (n ≈ 5.400 registros)
- Herbario SGO (n ≈ 3.100)
- GBIF (n ≈ 4.800)
- Literatura gris pre-1960 (n ≈ 900)

## Estado
Estandarización taxonómica con *Plants of the World Online* al 78%. Georreferenciación manual de registros antiguos en curso.

> Este proyecto lleva semanas sin movimiento: Hoy y la Revisión semanal lo marcan como «quieto».`,
      columnHistory: hist([[COL.ideacion, -120, -100], [COL.limpieza, -100, null]]), createdAt: at(-120), updatedAt: at(-48) },
    { ...base_p, id: 9, title: T.isme, type: 'Presentación', columnId: COL.ideacion, priority: 'Baja', areaId: A.inv, deadline: day(75),
      tags: ['microbioma', 'congreso', 'suelo', '16S'],
      description: `## Evento\n**ISME** — International Symposium on Microbial Ecology · ${monthIn(75)}\n\n## Formato\nTalk oral · 15 min + 5 min de preguntas\n\n## Abstract\nResultados preliminares de diversidad del microbioma rizosférico en parcelas de alto y bajo impacto antrópico a lo largo de un gradiente altitudinal andino (16S rRNA, V4, n = 32 muestras).\n\n## Pendiente\n- Confirmar financiamiento del viaje\n- Preparar diapositivas`,
      columnHistory: hist([[COL.ideacion, -25, null]]), createdAt: at(-25), updatedAt: at(-10) },
    { ...base_p, id: 10, title: T.lab, type: 'Proyecto', columnId: COL.analisis, priority: 'Media', areaId: A.ges, deadline: day(70),
      tags: ['gestión', 'laboratorio', 'administración'],
      description: `## Descripción\nGestión operacional del laboratorio durante el semestre.\n\n## Actividades\n- Supervisión de tesistas (ver [[${T.tesis}]])\n- Presupuesto operacional\n- Seminarios internos\n- Mantención de equipos de campo (GPS, dataloggers)\n- Renovación de convenios con CONAF\n\n> Las tareas **recurrentes** (agenda semanal, revisión del presupuesto) nacen de nuevo cada vez que las completas.`,
      columnHistory: hist([[COL.analisis, -60, null]]), createdAt: at(-60), updatedAt: at(-2) },
    { ...base_p, id: 11, title: T.tesis, type: 'Proyecto', columnId: COL.escritura, priority: 'Media', areaId: A.inv, deadline: day(34),
      responsible: 'Sebastián Mora', responsibleId: P.sebas, coauthors: [PI], tags: ['tesis', 'conectividad', 'Nahuelbuta', 'paisaje'],
      description: `## Alumno\nSebastián Mora — Magíster en Ciencias Biológicas, mención Ecología.\n\n## Tema\nConectividad estructural y funcional de parches de *Nothofagus dombeyi* con métricas de paisaje (ver [[${R.ipcc}]] para el contexto climático).\n\n## Estado\nCapítulos 1 y 2 revisados. Capítulo 3 (análisis de conectividad) en desarrollo.\n\n## Próximo hito\nPresentación de avance a la comisión.`,
      columnHistory: hist([[COL.ideacion, -120, -100], [COL.analisis, -100, -40], [COL.escritura, -40, null]]), createdAt: at(-120), updatedAt: at(-3) },
    { ...base_p, id: 12, title: T.done, type: 'Paper', columnId: COL.completado, priority: 'Baja', areaId: A.inv, starred: true,
      coauthors: ['Dr. Pablo Fuentes', 'Lic. Andrea Vega'], coauthorIds: [P.pablo, P.andrea], tags: ['Araucaria', 'fenología', 'publicado'],
      description: `## Estado\n✓ **Publicado** en *Plant Ecology*.\n\n## Resumen\nPatrones fenológicos reproductivos de *Araucaria araucana* en 18 poblaciones a lo largo de un gradiente latitudinal (37°–40° S): la fructificación se adelanta 8,3 días por década.\n\n> Un proyecto terminado queda en la columna **Completado**; no genera alertas de «quieto».`,
      targetVenue: 'Plant Ecology', submissionStatus: 'aceptado', submittedAt: day(-240),
      columnHistory: hist([[COL.escritura, -300, -250], [COL.review, -250, -60], [COL.completado, -60, null]]), createdAt: at(-300), updatedAt: at(-60) },
    { ...base_p, id: 13, title: T.curso, type: 'Curso', columnId: COL.analisis, priority: 'Media', areaId: A.doc, deadline: day(70),
      tags: ['docencia', 'ecología de comunidades'],
      description: `## Programa\nCurso de pregrado — Ecología de Comunidades.\n\n## Calendario\nClases semanales (ya generadas en el calendario) y evaluaciones con su tiempo de corrección.\n\n## Para recordar\n- Subir las notas de cada evaluación\n- Mostrar en clase la figura del [[${T.paper}]]`,
      columnHistory: hist([[COL.analisis, -35, null]]), createdAt: at(-35), updatedAt: at(-2) },
    { ...base_p, id: 14, title: T.pilot, type: 'Proyecto', columnId: COL.completado, priority: 'Baja', areaId: A.inv, archived: true, tags: ['micorrizas', 'piloto'],
      description: 'Estudio piloto cerrado. Está **archivado**: no aparece en el tablero ni en Hoy, pero se conserva (vista Archivados) y se puede restaurar.',
      columnHistory: hist([[COL.analisis, -400, -330], [COL.completado, -330, null]]), createdAt: at(-400), updatedAt: at(-330) },
  ]);

  // ── Tareas ────────────────────────────────────────────────────────────────────────────────
  let tid = 0;
  const task = (title, o = {}) => ({ id: ++tid, title, done: false, doneAt: null, due: null, projectId: null, ideaId: null, areaId: null, assigneeId: null,
    recurrence: null, effort: null, planDate: null, priority: null, createdAt: at(-8), updatedAt: at(-1), ...o });
  const done = (title, ago, o = {}) => task(title, { done: true, doneAt: at(-ago, 16), createdAt: at(-ago - 7), updatedAt: at(-ago, 16), ...o });
  const tasks = wrap('tasks', [
    // Grant
    task('Expandir la sección de metodología (≈2 páginas)', { projectId: 1, due: day(4), effort: 150, priority: 'Alta', planDate: day(0) }),
    task('Cuadrar el presupuesto con la Dirección de Investigación', { projectId: 1, due: day(-1), effort: 45, priority: 'Media' }),
    task('Carta de apoyo del Prof. McKenzie', { projectId: 1, due: day(12), assigneeId: P.james, priority: 'Alta' }),
    task('Pedir la carta de apoyo a CONAF', { projectId: 1, due: day(6), effort: 20 }),
    done('Redactar los objetivos específicos', 5, { projectId: 1 }),
    done('Enviar el informe técnico a Pablo', 1, { projectId: 1, effort: 60 }),
    // Objetivos
    task('Terminar los modelos MaxEnt de las 14 especies que faltan', { projectId: 2, due: day(0), effort: 90, priority: 'Alta', planDate: day(0) }),
    task('Validar el AUC con validación cruzada espacial', { projectId: 2, due: day(8), effort: 90 }),
    // Paper en revisión mayor
    task('Responder al Revisor 2: ampliar la discusión con meta-análisis', { projectId: 4, due: day(3), effort: 240, priority: 'Alta' }),
    task('Tabla S1 con rasgos por especie y sitio', { projectId: 4, due: day(5), assigneeId: P.pablo, effort: 120 }),
    task('Preparar la carta de respuesta a revisores', { projectId: 4, due: day(8), effort: 90, priority: 'Alta' }),
    done('Resolver los comentarios menores del Revisor 1', 6, { projectId: 4, effort: 60 }),
    // Otros papers
    task('Escribir el borrador de la introducción', { projectId: 6, due: day(14), effort: 180 }),
    task('Ver el estado del envío en el sistema de la revista', { projectId: 5, due: day(10), effort: 10 }),
    // NDVI
    task('Procesar el 40% de parcelas que falta', { projectId: 7, due: day(2), effort: 180 }),
    task('Exportar las series NDVI para la tesis de Sebastián', { projectId: 7, due: day(9), assigneeId: P.andrea }),
    // ISME
    task('Confirmar el financiamiento del viaje', { projectId: 9, due: day(30), priority: 'Media' }),
    task('Preparar las diapositivas (15 min)', { projectId: 9, due: day(60), effort: 240 }),
    // Laboratorio (recurrentes)
    task('Preparar la agenda de la reunión semanal', { projectId: 10, due: day(1), effort: 30, recurrence: { freq: 'weekly', interval: 1 } }),
    task('Revisar el presupuesto operacional', { projectId: 10, due: day(12), effort: 60, recurrence: { freq: 'monthly', interval: 1 } }),
    task('Renovar el convenio con CONAF', { projectId: 10, due: day(20), priority: 'Media' }),
    // Tesis
    task('Enviar el borrador del capítulo 3', { projectId: 11, due: day(-2), assigneeId: P.sebas, priority: 'Alta' }),
    task('Revisar el capítulo 2 con comentarios', { projectId: 11, due: day(2), effort: 120 }),
    task('Agendar la presentación de avance a la comisión', { projectId: 11, due: day(7), effort: 10 }),
    // Curso
    task('Evaluación: Prueba 1', { projectId: 13, due: day(6), priority: 'Alta' }),
    task('Corregir Prueba 1', { projectId: 13, due: day(8), effort: 240, priority: 'Alta' }),
    done('Subir las notas de la Tarea 1', 2, { projectId: 13, effort: 20 }),
    // Sueltas, por área
    task('Preparar la clase: gradientes ambientales', { areaId: A.doc, due: day(0), effort: 60, planDate: day(0) }),
    task('Responder las consultas del foro del curso', { areaId: A.doc, due: day(2), effort: 20, recurrence: { freq: 'weekly', interval: 1 } }),
    task('Enviar la rendición de gastos del trimestre', { areaId: A.ges, due: day(-3), effort: 45, priority: 'Alta' }),
    task('Renovar el pasaporte (viaje al congreso)', { areaId: A.per, due: day(25) }),
    task('Agendar el control médico', { areaId: A.per }),
    task('Leer el preprint nuevo sobre rasgos funcionales', { areaId: A.inv, effort: 45 }),
    done('Ordenar las carpetas del herbario', 3, { areaId: A.inv }),
    done('Pedir las salas para el seminario', 11, { areaId: A.ges }),
    done('Entregar el informe anual a la Dirección', 18, { areaId: A.ges, effort: 120 }),
    // Subtareas de ideas (llevan ideaId y el proyecto de la idea)
    done('Probar rgee con un mes de prueba', 4, { ideaId: 4, projectId: 7 }),
    task('Escribir el loop por año-mes', { ideaId: 4, projectId: 7, due: day(5), effort: 120 }),
    task('Comparar los tiempos contra el flujo manual', { ideaId: 4, projectId: 7 }),
    task('Probar la exportación BibTeX desde Zotero', { ideaId: 9, projectId: 10, due: day(13) }),
    task('Pedir al equipo que migre su biblioteca', { ideaId: 9, projectId: 10 }),
  ]);

  // ── Ideas ─────────────────────────────────────────────────────────────────────────────────
  const idea = (id, title, content, o = {}) => ({ id, title, content, status: 'unread', projectId: null, projectIds: [], tags: [], subtasks: [], starred: false,
    createdAt: at(-5), updatedAt: at(-5), ...o });
  const ideas = wrap('ideas', [
    idea(1, 'Incluir variables de microhábitat en el modelo de distribución', 'Los modelos actuales usan solo clima (bio1–bio19 de WorldClim, ver [[Very high resolution interpolated climate surfaces for global land areas]]). Agregar microhábitat (cobertura de canopia vía LiDAR, pendiente, exposición) podría mejorar el AUC en ~8%. Valdría testear MaxEnt vs. BRT con y sin estas variables.',
      { status: 'reviewed', projectId: 2, projectIds: [2], tags: ['SDM', 'microhábitat', 'MaxEnt'], createdAt: at(-30), updatedAt: at(-20) }),
    idea(2, 'Sección discusión: comparar con meta-análisis de Parmesan', `El meta-análisis de Parmesan & Yohe documenta un desplazamiento de 6,1 km/década hacia los polos (ver [[${R.parmesan}]]). Nuestros resultados sugieren 9,3 km/década en el gradiente norte-sur. Vale la pena discutirlo explícitamente: ¿diferencia biogeográfica real o artefacto del método?`,
      { projectId: 4, projectIds: [4], tags: ['discusión', 'meta-análisis'], starred: true, createdAt: at(-2), updatedAt: at(-2) }),
    idea(3, 'Sesgo de detección en registros de herbario antiguos', 'Los registros del herbario CONC anteriores a 1950 están georreferenciados a cuadrícula de 0,1°, con un error posicional de hasta 11 km. Podría sesgar el modelo histórico. Opciones: (a) filtrar por precisión, (b) incorporar la incertidumbre como peso.',
      { projectId: 8, projectIds: [8], tags: ['calidad de datos', 'sesgo espacial', 'herbario'], deadline: day(16), createdAt: at(-9), updatedAt: at(-9) }),
    idea(4, 'Automatizar la descarga Landsat con rgee en un loop mensual', 'Hoy el pipeline de descarga desde GEE es semimanual. Con `rgee` + `purrr` se puede iterar por año-mes y aplicar la corrección LaSRC en el mismo paso. Ahorraría un par de días por actualización.',
      { status: 'reviewed', projectId: 7, projectIds: [7], tags: ['automatización', 'R', 'GEE', 'rgee'], createdAt: at(-21), updatedAt: at(-4) }),
    idea(5, 'Proponer sesiones de lectura sobre ecología funcional', `El equipo necesita nivelar conocimientos antes de la próxima reunión con revisores. Tres sesiones de 1 h: (1) rasgos funcionales y su medición (partir por [[${R.violle}]]), (2) CWM, FRic y métricas de FD, (3) framework respuesta-efecto. Sin proyecto asignado a propósito: aparece en **Huérfanos**.`,
      { tags: ['laboratorio', 'formación', 'lectura'], deadline: day(10), createdAt: at(-4), updatedAt: at(-4) }),
    idea(6, 'Conectividad estructural con landscapemetrics', 'Con la clasificación de cobertura desde Landsat se puede correr `landscapemetrics` (COHESION, PLADJ, MESH) para cada imagen anual. Serviría para el análisis NDVI y para la tesis: una idea, dos proyectos.',
      { projectId: 7, projectIds: [7, 11], tags: ['conectividad', 'paisaje', 'R'], createdAt: at(-6), updatedAt: at(-6) }),
    idea(7, 'Ridge plot de distribución altitudinal para el paper', 'Un panel tipo ridgeplot (ggridges) con la distribución altitudinal de cada especie en dos períodos sería muy potente como figura principal. La revista acepta figuras de hasta 180 mm de ancho. Hay un snippet listo.',
      { projectId: 4, projectIds: [4], tags: ['visualización', 'ggplot2', 'figuras'], createdAt: at(-3), updatedAt: at(-3) }),
    idea(8, '¡Bienvenido/a! Esta idea no tiene proyecto', 'Es una **idea huérfana**: no está vinculada a ningún proyecto. Aparece en la bandeja de **Ideas** y en **Huérfanos** (Más → Elementos huérfanos).\n\nPuedes asignarla a un proyecto desde el inspector (✎ Editar), convertirla en tarea o proyecto con un clic, o borrarla: todo se puede deshacer.',
      { tags: ['tutorial', 'bienvenida'], createdAt: at(0, 9), updatedAt: at(0, 9) }),
    idea(9, 'Estandarizar la gestión de referencias en Zotero + BibTeX', 'Cada integrante gestiona sus referencias por separado. Estandarizar en Zotero con exportación BibTeX permitiría una biblioteca compartida y aprovechar el módulo de Referencias de ResearchOS (importa `.bib`/`.ris`).',
      { status: 'reviewed', projectId: 10, projectIds: [10], tags: ['referencias', 'Zotero', 'gestión'], createdAt: at(-25), updatedAt: at(-14) }),
    idea(10, 'Métricas de paisaje para la tesis de Sebastián: MESH y PLADJ', 'Calcular MESH y PLADJ con `landscapemetrics` a tres escalas (parche, clase, paisaje) para tres años y comparar entre cuencas. Conversarlo en el seguimiento.',
      { projectId: 11, projectIds: [11], tags: ['tesis', 'landscapemetrics'], createdAt: at(-1), updatedAt: at(-1) }),
  ]);

  // ── Snippets ──────────────────────────────────────────────────────────────────────────────
  const snippetCollections = wrap('snippetCollections', [
    { id: 1, name: 'Análisis Estadístico', color: '#38bdf8', createdAt: at(-140) },
    { id: 2, name: 'Datos y Descargas', color: '#f59e0b', createdAt: at(-140) },
    { id: 3, name: 'Visualización', color: '#a78bfa', createdAt: at(-140) },
  ]);
  const snip = (id, title, language, code, o = {}) => ({ id, title, language, code, description: '', tags: [], projectId: null, projectIds: [], collectionId: null,
    starred: false, createdAt: at(-30), updatedAt: at(-30), ...o });
  const snippets = wrap('snippets', [
    snip(1, 'Cálculo de NDVI con terra (R)', 'R', "library(terra)\n\n# Cargar bandas Landsat (B4 = rojo, B5 = NIR para L8/L9)\nred <- rast(\"L8_B4.tif\")\nnir <- rast(\"L8_B5.tif\")\n\n# Calcular NDVI\nndvi <- (nir - red) / (nir + red)\nnames(ndvi) <- \"NDVI\"\n\n# Visualizar\nplot(ndvi, main = \"NDVI\", col = colorRampPalette(c(\"#d73027\",\"#fee08b\",\"#1a9850\"))(100))\n\n# Guardar resultado\nwriteRaster(ndvi, \"outputs/ndvi_output.tif\", overwrite = TRUE)\n\n# Estadísticas por parcela (shapefile/geopackage)\nparcelas <- vect(\"data/parcelas.gpkg\")\nndvi_vals <- extract(ndvi, parcelas, fun = mean, na.rm = TRUE)\nhead(ndvi_vals)\n\n# Unir con atributos de parcelas\nresult <- cbind(as.data.frame(parcelas), ndvi_vals[, -1])\nwrite.csv(result, \"outputs/ndvi_por_parcela.csv\", row.names = FALSE)", { description: 'NDVI a partir de bandas Landsat 8/9 con terra.', tags: ['NDVI', 'terra', 'teledetección'], projectId: 7, projectIds: [7], collectionId: 1, createdAt: at(-60) }),
    snip(2, 'Modelo lineal mixto — diversidad funcional (lme4)', 'R', "library(lme4)\nlibrary(lmerTest)   # p-valores Satterthwaite\nlibrary(MuMIn)      # R² Nakagawa & Schielzeth\n\n# Modelo: FRic ~ gradiente altitudinal + precipitación\n# Efectos aleatorios: sitio y año de muestreo\nmod_full <- lmer(\n  FRic ~ altitud_std + precip_std + altitud_std:precip_std +\n    (1 | sitio) + (1 | anio),\n  data    = df_funcional,\n  REML    = TRUE,\n  control = lmerControl(optimizer = \"bobyqa\")\n)\n\n# Resumen con pruebas de hipótesis\nsummary(mod_full)\nanova(mod_full)   # Wald chi-square\n\n# Diagnósticos visuales\npar(mfrow = c(1, 2))\nplot(mod_full)           # residuos vs. valores ajustados\nqqnorm(resid(mod_full)); qqline(resid(mod_full))\n\n# Varianza explicada\nr.squaredGLMM(mod_full)  # R² marginal y condicional\n\n# Modelo nulo para LRT\nmod_null <- lmer(FRic ~ 1 + (1 | sitio) + (1 | anio),\n                 data = df_funcional, REML = FALSE)\nmod_comp <- update(mod_full, REML = FALSE)\nanova(mod_null, mod_comp)", { description: 'Modelo mixto con sitio como efecto aleatorio.', tags: ['lme4', 'estadística'], projectId: 4, projectIds: [4], collectionId: 1, createdAt: at(-50) }),
    snip(3, 'Descarga de ocurrencias GBIF con rgbif (R)', 'R', "library(rgbif)\nlibrary(dplyr)\nlibrary(CoordinateCleaner)  # detección de outliers\n\n# --- 1. Obtener clave taxonómica ---\ntaxon_key <- name_backbone(name = \"Nothofagus pumilio\",\n                           rank = \"species\")$usageKey\n\n# --- 2. Descarga asíncrona con DOI citable ---\ndl <- occ_download(\n  pred(\"taxonKey\", taxon_key),\n  pred_in(\"country\", c(\"CL\", \"AR\")),\n  pred(\"hasCoordinate\", TRUE),\n  pred(\"hasGeospatialIssue\", FALSE),\n  pred_gte(\"year\", 1950),\n  format = \"SIMPLE_CSV\"\n)\nocc_download_wait(dl)  # espera hasta que termine\n\n# --- 3. Importar y limpiar ---\ndf_raw <- occ_download_get(dl) |> occ_download_import()\n\ndf_clean <- df_raw |>\n  filter(\n    !is.na(decimalLatitude),\n    coordinateUncertaintyInMeters < 5000 | is.na(coordinateUncertaintyInMeters)\n  ) |>\n  cc_zero()   |>  # coords (0,0)\n  cc_cap()    |>  # capitales\n  cc_inst()       # instituciones\n\ncat(\"Registros originales:\", nrow(df_raw), \"\\n\")\ncat(\"Registros limpios:   \", nrow(df_clean), \"\\n\")", { description: 'Descarga y limpieza básica de registros GBIF.', tags: ['GBIF', 'rgbif', 'datos'], projectId: 8, projectIds: [8], collectionId: 2, createdAt: at(-45) }),
    snip(4, 'Ridge plot de distribución altitudinal (ggridges)', 'R', "library(ggplot2)\nlibrary(ggridges)\nlibrary(dplyr)\n\n# df_species debe tener columnas: especie, altitud, periodo\n# periodo: factor con niveles c(\"pre-2000\", \"post-2010\")\ndf_plot <- df_species |>\n  mutate(\n    periodo  = factor(periodo, levels = c(\"pre-2000\", \"post-2010\")),\n    especie  = reorder(especie, altitud, median)  # orden por mediana\n  )\n\np <- ggplot(df_plot, aes(x = altitud, y = especie, fill = periodo)) +\n  geom_density_ridges(\n    alpha          = 0.65,\n    scale          = 1.3,\n    rel_min_height = 0.01,\n    quantile_lines = TRUE,\n    quantiles      = 2        # línea de mediana\n  ) +\n  scale_fill_manual(\n    values = c(\"pre-2000\"  = \"#38bdf8\",\n               \"post-2010\" = \"#f59e0b\")\n  ) +\n  scale_x_continuous(labels = scales::comma) +\n  labs(\n    x        = \"Altitud (m.s.n.m.)\",\n    y        = NULL,\n    title    = \"Desplazamiento altitudinal por especie\",\n    subtitle = \"Comparación pre-2000 vs. post-2010 | Nothofagus spp.\",\n    fill     = \"Período\",\n    caption  = \"Línea vertical = mediana\"\n  ) +\n  theme_ridges(grid = FALSE, center_axis_labels = TRUE) +\n  theme(legend.position = \"top\")\n\nggsave(\"figures/ridgeplot_altitud.pdf\", p,\n       width = 18, height = 14, units = \"cm\", device = cairo_pdf)", { description: 'Ridgeplot comparando dos períodos. Listo para publicación.', tags: ['ggplot2', 'visualización', 'figuras'], projectId: 4, projectIds: [4], collectionId: 3, starred: true, createdAt: at(-20) }),
    snip(5, 'Análisis de tendencia Mann-Kendall (R)', 'R', "library(trend)      # mk.test, sens.slope\nlibrary(dplyr)\nlibrary(purrr)\n\n# df_ndvi: columnas 'parcela', 'anio', 'ndvi_mean'\n# Aplicar MK test a cada parcela por separado\nresultados_mk <- df_ndvi |>\n  group_by(parcela) |>\n  group_modify(~ {\n    ts_vals <- .x |> arrange(anio) |> pull(ndvi_mean)\n    mk  <- mk.test(ts_vals)\n    sen <- sens.slope(ts_vals)\n    tibble(\n      n          = length(ts_vals),\n      tau        = mk$estimates[\"tau\"],\n      p_valor    = mk$p.value,\n      tendencia  = ifelse(mk$p.value < 0.05,\n                          ifelse(sen$estimates > 0, \"Positiva\", \"Negativa\"),\n                          \"Sin tendencia\"),\n      pendiente  = as.numeric(sen$estimates)  # cambio/año (Sen's slope)\n    )\n  }) |>\n  ungroup()\n\n# Resumen\ntable(resultados_mk$tendencia)\nsummary(resultados_mk$pendiente)", { description: 'Prueba de tendencia no paramétrica por parcela.', tags: ['Mann-Kendall', 'series de tiempo'], projectId: 7, projectIds: [7], collectionId: 1, createdAt: at(-40) }),
    snip(6, 'Limpieza de coordenadas con pandas', 'Python',
      "import pandas as pd\n\ndf = pd.read_csv('ocurrencias.csv')\n\n# Coordenadas válidas y dentro del área de estudio\ndf = df.dropna(subset=['lat', 'lon'])\ndf = df[df['lat'].between(-56, -37) & df['lon'].between(-76, -66)]\n\n# Duplicados por especie y coordenadas redondeadas\ndf['key'] = df['especie'] + df['lat'].round(3).astype(str) + df['lon'].round(3).astype(str)\ndf = df.drop_duplicates('key').drop(columns='key')\ndf.to_csv('ocurrencias_limpias.csv', index=False)\n",
      { description: 'Filtro de coordenadas y duplicados antes de modelar.', tags: ['pandas', 'limpieza'], projectId: 8, projectIds: [8], collectionId: 2, createdAt: at(-15) }),
    snip(7, 'Reproyectar rasters con gdalwarp', 'Bash',
      "#!/usr/bin/env bash\n# Reproyecta todos los GeoTIFF a UTM 18S\nfor f in rasters/*.tif; do\n  gdalwarp -t_srs EPSG:32718 -r bilinear -co COMPRESS=DEFLATE \"$f\" \"utm/$(basename \"$f\")\"\ndone\n",
      { description: 'Para dejar todas las capas en el mismo sistema de coordenadas.', tags: ['GDAL', 'raster'], projectId: 7, projectIds: [7], collectionId: 2, createdAt: at(-12) }),
    snip(8, 'Registros por herbario y década (DuckDB)', 'SQL',
      "SELECT herbario,\n       (anio / 10) * 10 AS decada,\n       COUNT(*)         AS registros\nFROM ocurrencias\nWHERE anio IS NOT NULL\nGROUP BY herbario, decada\nORDER BY decada, registros DESC;\n",
      { description: 'Sin colección a propósito: aparece en «Sin colección».', tags: ['SQL', 'DuckDB'], projectId: 8, projectIds: [8], createdAt: at(-7) }),
  ]);

  // ── Referencias (con estado de lectura) ───────────────────────────────────────────────────
  const ref = (id, o) => ({ id, journal: '', volume: '', pages: '', doi: '', notes: '', tags: [], projectId: null, readStatus: null, citeKey: '', createdAt: at(-30), updatedAt: at(-30), ...o });
  const references = wrap('references', [
    ref(1, { title: R.parmesan, authors: 'Parmesan, C., Yohe, G.', year: 2003, journal: 'Nature', volume: '421', pages: '37–42', doi: '10.1038/nature01286',
      notes: 'Meta-análisis clásico de ~1.700 especies. Referencia ineludible para la introducción y la discusión del grant y del paper. Ver la idea sobre Parmesan.',
      tags: ['meta-análisis', 'cambio climático'], projectId: 1, readStatus: 'read', readAt: at(-12, 18), citeKey: 'parmesan2003', createdAt: at(-60) }),
    ref(2, { title: R.siefert, authors: 'Siefert, A., Violle, C., Chalmandrier, L., Albert, C.H., Taudiere, A., Fajardo, A.', year: 2015, journal: 'Ecology Letters', volume: '18', pages: '1406–1419', doi: '10.1111/ele.12508',
      notes: `Cuánta variación de rasgos hay dentro de las especies. Clave para responder al Revisor 2 de [[${T.paper}]].`, tags: ['rasgos funcionales', 'meta-análisis'], projectId: 4, readStatus: 'reading', citeKey: 'siefert2015', createdAt: at(-20) }),
    ref(3, { title: 'Open-source machine learning for remote sensing time series analysis', authors: 'Pelletier, C., Webb, G.I., Petitjean, F.', year: 2019, journal: 'IEEE Transactions on Geoscience and Remote Sensing', volume: '57', pages: '6256–6270', doi: '10.1109/TGRS.2019.2905582',
      tags: ['teledetección', 'series de tiempo'], projectId: 7, readStatus: 'toread', citeKey: 'pelletier2019', createdAt: at(-9) }),
    ref(4, { title: R.ipcc, authors: 'Settele, J., Scholes, R., Betts, R., Bunn, S., Leadley, P., Nepstad, D.', year: 2014, journal: 'Climate Change 2014: Impacts, Adaptation, and Vulnerability — Cambridge University Press', pages: '271–359',
      tags: ['IPCC', 'cambio climático'], projectId: 1, readStatus: 'read', readAt: at(-5, 18), citeKey: 'settele2014', createdAt: at(-80) }),
    ref(5, { title: 'landscapemetrics: An open-source R toolkit for calculating landscape metrics', authors: 'Hesselbarth, M.H.K., Sciaini, M., With, K.A., Wiegand, K., Nowosad, J.', year: 2019, journal: 'Ecography', volume: '42', pages: '1648–1657', doi: '10.1111/ecog.04617',
      tags: ['landscapemetrics', 'paisaje'], projectId: 11, readStatus: 'toread', citeKey: 'hesselbarth2019', createdAt: at(-14) }),
    ref(6, { title: R.violle, authors: 'Violle, C., Navas, M.-L., Vile, D., Kazakou, E., Fortunel, C., Hummel, I., Garnier, E.', year: 2007, journal: 'Oikos', volume: '116', pages: '882–892', doi: '10.1111/j.0030-1299.2007.15559.x',
      notes: 'Definición de rasgo funcional. Para la sesión de lectura.', tags: ['rasgos funcionales', 'teoría'], projectId: 4, readStatus: 'read', readAt: at(-2, 18), citeKey: 'violle2007', createdAt: at(-16) }),
    ref(7, { title: 'Very high resolution interpolated climate surfaces for global land areas', authors: 'Hijmans, R.J., Cameron, S.E., Parra, J.L., Jones, P.G., Jarvis, A.', year: 2005, journal: 'International Journal of Climatology', volume: '25', pages: '1965–1978', doi: '10.1002/joc.1276',
      tags: ['WorldClim', 'clima'], projectId: 2, readStatus: 'toread', citeKey: 'hijmans2005', createdAt: at(-11) }),
    ref(8, { title: 'Plant functional markers capture ecosystem properties during secondary succession', authors: 'Garnier, E., Cortez, J., Billès, G., Navas, M.-L., Roumet, C., Debussche, M., Laurent, G., et al.', year: 2004, journal: 'Ecology', volume: '85', pages: '2630–2637', doi: '10.1890/03-0799',
      notes: 'Sin proyecto a propósito: aparece en Huérfanos hasta que la vincules.', tags: ['rasgos funcionales'], citeKey: 'garnier2004', createdAt: at(-3) }),
  ]);

  // ── Reuniones (con acuerdos y pasos, algunos asignados) y clases del curso ─────────────────
  const ai = (id, text, o = {}) => ({ id, text, done: false, doneAt: null, due: null, assigneeId: null, ...o });
  const meeting = (id, title, date, o = {}) => ({ id, title, date, participants: '', agreements: '', actionItems: [], tags: [], projectId: null, createdAt: at(-1), updatedAt: at(-1), ...o });
  const meetings = wrap('meetings', [
    meeting(1, 'Reunión de avance del grant', day(-9), { projectId: 1, tags: ['grant'], participants: `${PI}, Dr. Pablo Fuentes, Lic. Andrea Vega`,
      agreements: 'El análisis de distribución va al 70%. Se prioriza el pipeline satelital de Andrea antes de la próxima reunión. María enviará el borrador del informe técnico a Pablo y se pedirán las cartas de apoyo.',
      actionItems: [ai(1, 'Enviar el borrador del informe técnico a Pablo', { done: true, doneAt: at(-1, 16), due: day(-3) }),
                    ai(2, 'Terminar el paso 4 del pipeline NDVI', { due: day(5), assigneeId: P.andrea }),
                    ai(3, 'Pedir la carta de apoyo a McKenzie', { due: day(4) }),
                    ai(4, 'Compartir el acceso al herbario CONC', { due: day(-1), assigneeId: P.pablo })], createdAt: at(-9), updatedAt: at(-1) }),
    meeting(2, 'Revisión de comentarios — Functional Ecology', day(-12), { projectId: 4, tags: ['revisión'], participants: `${PI}, Dr. Pablo Fuentes`,
      agreements: 'Aceptamos casi todos los comentarios. Para el Revisor 2: ampliar la discusión con meta-análisis y agregar la Tabla S1. Pablo prepara la tabla; María reescribe la discusión.',
      actionItems: [ai(1, 'Reescribir la discusión', { due: day(3) }), ai(2, 'Preparar la Tabla S1', { due: day(5), assigneeId: P.pablo }), ai(3, 'Revisar la carta de respuesta', { due: day(8) })],
      createdAt: at(-12), updatedAt: at(-12) }),
    meeting(3, 'Seguimiento de tesis — Sebastián', day(-17), { projectId: 11, tags: ['tesis'], participants: `${PI}, Sebastián Mora`,
      agreements: 'Capítulo 2 revisado. Sebastián enviará el borrador del capítulo 3 y ajustará las métricas de conectividad. Próxima reunión en dos semanas.',
      actionItems: [ai(1, 'Ajustar las métricas de conectividad', { due: day(6), assigneeId: P.sebas }), ai(2, 'Enviar el capítulo 3', { done: true, doneAt: at(-10, 12), due: day(-8), assigneeId: P.sebas })],
      createdAt: at(-17), updatedAt: at(-17) }),
    meeting(4, 'Seminario interno: teledetección con R', day(-26), { projectId: 7, tags: ['seminario'], participants: `${PI}, Lic. Andrea Vega, Sebastián Mora`,
      agreements: 'Sesión práctica con terra y rgee. Quedó un repositorio compartido con los scripts.',
      actionItems: [ai(1, 'Subir los scripts al repositorio', { done: true, doneAt: at(-24, 12), assigneeId: P.andrea })], createdAt: at(-26), updatedAt: at(-24) }),
    meeting(5, 'Reunión semanal de laboratorio', day(1), { projectId: 10, tags: ['laboratorio'], participants: `${PI}, Dr. Pablo Fuentes, Lic. Andrea Vega, Sebastián Mora`,
      agreements: 'Agenda: avances de la semana · plazo de reenvío del paper · terreno de primavera.', createdAt: at(-3), updatedAt: at(-3) }),
    meeting(6, 'Planificación del terreno de primavera', day(3), { projectId: 1, tags: ['terreno'], participants: `${PI}, Lic. Andrea Vega`,
      agreements: 'Definir parcelas, logística y equipos (GPS, dataloggers).', createdAt: at(-3), updatedAt: at(-3) }),
    ...[-21, -14, -7, 0, 7].map((n, i) => meeting(7 + i, `Clase ${i + 1}: ${['Introducción a las comunidades', 'Diversidad y abundancia', 'Interacciones y redes', 'Gradientes ambientales', 'Sucesión y perturbaciones'][i]}`,
      day(n), { kind: 'class', projectId: 13, tags: ['clase'], participants: '', agreements: n < 0 ? 'Clase dictada.' : '', createdAt: at(-30), updatedAt: at(-30) })),
  ]);

  // ── Envíos (la ficha por envío que acompaña a cada paper o grant) ──────────────────────────
  const submissions = wrap('submissions', [
    { id: 1, title: 'Functional trait diversity along elevation gradients in Nothofagus forests', type: 'Paper', targetVenue: 'Functional Ecology', status: 'revision_solicitada', projectId: 4,
      submittedAt: day(-75), deadlineAt: day(9), notes: 'Revisión mayor. Reenviar con carta de respuesta punto por punto.', createdAt: at(-75), updatedAt: at(-14) },
    { id: 2, title: 'Niche modelling of Araucaria araucana under climate change', type: 'Paper', targetVenue: 'Diversity and Distributions', status: 'en_revision', projectId: 5,
      submittedAt: day(-30), deadlineAt: null, notes: 'En manos del editor. Revisar el estado cada dos semanas.', createdAt: at(-30), updatedAt: at(-30) },
    { id: 3, title: `FONDECYT Regular ${Y + 1}`, type: 'Grant', targetVenue: 'ANID', status: 'preparacion', projectId: 1,
      submittedAt: null, deadlineAt: day(38), notes: 'Falta la metodología ampliada y las cartas de apoyo.', createdAt: at(-45), updatedAt: at(-1) },
  ]);

  return {
    _app: 'ResearchOS', _version: 3, _sample: true, exportedAt: new Date().toISOString(),
    kanbanColumns, snippetCollections, collaborators, projects, ideas, snippets, references, meetings, submissions, tasks, resources: [],
    settings: [{ key: 'ros-areas', value: JSON.stringify(areas) }],
  };
}

// ==============================================================
//  Cargar, reiniciar y quitar el ejemplo
// ==============================================================
const _SAMPLE_TABLES = ['projects', 'ideas', 'snippets', 'snippetCollections', 'collaborators', 'submissions', 'meetings', 'references', 'tasks', 'resources'];

/** Cuántos registros de ejemplo hay (0 = no hay). */
async function sampleCount() {
  let n = 0;
  for (const t of _SAMPLE_TABLES) n += await db[t].where('uid').startsWith(SAMPLE_PREFIX).count();
  return n;
}
const hasSampleData = async () => (await sampleCount()) > 0;

/** Importa el laboratorio de ejemplo con fechas calculadas desde hoy. `replace` lo reinicia antes (fechas nuevas). */
async function loadSampleData({ replace = false } = {}) {
  if (replace) await removeSampleData({ silent: true });
  const summary = await mergeAllData(JSON.stringify(buildSampleData(new Date())));
  try { localStorage.setItem('ros-sample-date', localDateISO()); } catch {}
  await _afterDataReplaced();
  return summary;
}

/** Quita solo lo que creó el ejemplo; lo que la persona agregó (aunque cuelgue de un proyecto de ejemplo) se conserva. */
async function removeSampleData({ silent = false } = {}) {
  const projectIds = await db.projects.where('uid').startsWith(SAMPLE_PREFIX).primaryKeys();
  const ideaIds = await db.ideas.where('uid').startsWith(SAMPLE_PREFIX).primaryKeys();
  await dbWrite(async () => {
    for (const id of projectIds.reverse()) await deleteProjectCascade(id);                // desvincula lo que sea de la persona
    for (const id of ideaIds) await deleteIdeaCascade(id);
    for (const t of _SAMPLE_TABLES) {
      const ids = await db[t].where('uid').startsWith(SAMPLE_PREFIX).primaryKeys();
      if (ids.length) await db[t].bulkDelete(ids);
    }
  });
  try { localStorage.removeItem('ros-sample-date'); } catch {}
  await _afterDataReplaced();
  if (!silent) showToast('Datos de ejemplo quitados', 'success');
}
