# 🤖 Asistente de IA

Deja que un asistente (Claude Code, Claude Desktop, ChatGPT con herramientas, Cursor, un script propio…) **lea tus pendientes y te ayude a mantenerlos al día**, sin servidores ni cuentas: ResearchOS y la IA se hablan a través de **una carpeta**.

```
tu navegador (ResearchOS)  ⇄  carpeta  ⇄  un LLM / agente
        publica estado.json, pendientes.md       lee y propone cambios en cambios/*.json
        lee y aplica cambios/ (con tu revisión)  lee resultados/ para saber qué pasó
```

## Activarlo (1 minuto)

1. En Chrome o Edge: **Ajustes → Sincronización e IA → Asistente de IA → Elegir carpeta…** (mejor una carpeta vacía, p. ej. `ResearchOS-IA`). Si ya elegiste una carpeta para la **sincronización** o la **copia automática**, aparece «Usar la carpeta «…»» para activar el asistente en la misma con un clic: cada función guarda sus archivos con nombres propios (`researchos-sync-*.json`, `researchos-backup-*.json`, `AGENTS.md`, `estado.json`, `cambios/`…) y se activa o desactiva por separado. Cada sección indica con quién comparte carpeta.
2. Deja ResearchOS abierto en una pestaña (la app es la que lee y aplica los cambios).
3. Abre tu asistente **en esa carpeta**. Con Claude Code: `cd ResearchOS-IA && claude`, y pídele, por ejemplo: *«Revisa mis pendientes y propón un plan para esta semana»*.

La app deja en la carpeta:

| Archivo | Para qué |
|---|---|
| `AGENTS.md` y `CLAUDE.md` | Instrucciones para la IA (formato, campos, buenas prácticas). Claude Code las carga solo; otras herramientas leen `AGENTS.md`. Si ya tienes un `AGENTS.md` propio, no se toca. |
| `estado.json` | Tus proyectos, tareas, ideas, reuniones y personas con nombres legibles y `uid` estables. |
| `pendientes.md` | La misma agenda en Markdown: atrasado, hoy, próximos 7 días, esperando a otras personas… |
| `cambios/` | Aquí la IA deja sus propuestas (`.json`). |
| `resultados/` | La app responde aquí, con el mismo nombre, qué se aplicó y qué falló. |
| `researchos.js` | Herramienta opcional para la IA (ver abajo). Se mantiene al día sola. |

## Cómo se mantiene el control

- **Por defecto revisas tú.** Cuando la IA propone algo aparece «🤖 Tu asistente propone N cambios»; ves la lista, desmarcas lo que no quieras y pulsas *Aplicar*.
- **Modo automático (opcional):** lo que no sea un borrado se aplica enseguida y puedes pulsar «Deshacer». **Los borrados siempre se revisan.**
- **La IA no ejecuta código en tu app.** Solo existe un conjunto cerrado de operaciones (añadir, modificar, completar, borrar sobre tareas, ideas, proyectos, reuniones y personas), y cada campo se valida. Un lote con errores no rompe nada: cada operación informa su resultado.
- Los proyectos no se pueden borrar desde aquí; las personas solo se pueden añadir.
- La carpeta contiene tus datos en claro. Si la pones en Dropbox/Drive, viajan por ese servicio; si la IA es un servicio en la nube, lo que lea saldrá de tu equipo. Elige a conciencia qué asistente la abre.

## Conectar distintos asistentes

Todo parte de `researchos.js` (Node 18+, **sin dependencias**), que la app copia en la carpeta. Lee `estado.json`, escribe en `cambios/` de forma atómica y puede esperar el resultado.

### Claude Code, Codex y otros agentes con terminal
Basta abrirlos en la carpeta: leen `AGENTS.md`/`CLAUDE.md` y pueden usar la línea de comandos o escribir los `.json` directamente.

```bash
node researchos.js resumen
node researchos.js tareas --hasta semana
node researchos.js añadir-tarea "Enviar borrador" --fecha 2026-11-06 --proyecto "Paper Alfa" --prioridad Alta --esperar
node researchos.js completar "Enviar borrador"
node researchos.js ayuda
```

### Claude Desktop, Cursor y cualquier cliente MCP
`researchos.js mcp` es un servidor MCP por stdio. En la configuración del cliente (en Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "researchos": {
      "command": "node",
      "args": ["/ruta/a/ResearchOS-IA/researchos.js", "mcp", "--dir", "/ruta/a/ResearchOS-IA"]
    }
  }
}
```

Herramientas: `researchos_overview`, `researchos_list`, `researchos_search`, `researchos_add_task`, `researchos_update_task`, `researchos_complete_task` (por `uid`, título u origen), `researchos_add_idea`, `researchos_add_meeting`, `researchos_propose_changes` (lote completo) y `researchos_get_result`.

### OpenAI, Anthropic API y otros con *function calling*
Las mismas herramientas como definiciones de funciones:

```bash
node researchos.js schema --formato openai      # o anthropic, o mcp
```
Ejecuta la llamada con `require('./researchos.js').callTool(nombre, argumentos, { dir })` desde tu propio código, o con la CLI.

### Cualquier otro modelo
Si solo puede leer y escribir archivos, le sirve `AGENTS.md`: describe el formato completo. Un lote mínimo, guardado como `cambios/lo-que-sea.json`:

```json
{ "format": "researchos-changes/1", "author": "mi-asistente", "note": "Plan de la semana",
  "ops": [
    { "op": "add", "type": "task", "set": { "title": "Enviar borrador", "due": "2026-11-06", "project": "Paper Alfa", "priority": "Alta" } },
    { "op": "complete", "type": "task", "uid": "3f2a9c1e" }
  ] }
```

## Mantener tus pendientes al día desde el correo y el calendario

Si tu asistente tiene acceso a tu correo y a tu calendario (por ejemplo, los conectores de Gmail y Google Calendar de Claude), puede **revisarlos y dejar en ResearchOS lo que requiera tu atención**. La app solo recibe propuestas por la carpeta: ni se conecta a tu correo ni guarda credenciales; quien lee el correo es el asistente.

Tres campos hacen que esto sea cómodo y seguro de repetir a diario:

- **`source`** (tareas, ideas y reuniones): identificador de dónde salió, p. ej. `gmail:<id del hilo>` o `gcal:<id del evento>`. Si ya existe algo con ese origen, la app **omite** la operación (`skipped`, «ya existe (mismo origen)») y devuelve el `uid` del existente; así revisar el mismo correo cada día no duplica nada. Lo que **descartas** en la revisión o **borras** tú tampoco se vuelve a proponer. En `update`, `complete` o `delete` también sirve para localizar el registro (`{"op":"complete","type":"task","source":"gmail:18c3"}`).
- **`link`** (tareas): la dirección de la página original (solo `http://` o `https://`); en Hoy aparece un 🔗 que la abre. **`notes`**: contexto breve (hasta 5000 caracteres).
- **`time` y `duration`** (reuniones): hora de inicio `HH:MM` y duración en minutos (5–1440). Un evento de todo el día va sin hora.

### Ejemplo de skill para Claude Code

Guárdala como `.claude/skills/pendientes-correo/SKILL.md` (en la carpeta del asistente, o en `~/.claude/skills/` para tenerla siempre). Es un punto de partida: ajústala a tus etiquetas y a los conectores que uses.

```markdown
---
name: pendientes-correo
description: Revisa mi correo y mi calendario y propone en ResearchOS las tareas y reuniones que falten. Úsala cuando pida ponerme al día.
---

1. Lee `estado.json` y `AGENTS.md` de esta carpeta. Fíjate en los `source` que ya existen.
2. Correo: busca hilos recientes que me pidan algo (respuesta, revisión, entrega) y que NO tengan la etiqueta `researchos`. Ignora boletines y automáticos.
   Por cada uno propón una tarea con:
   - `title` en imperativo y breve («Responder a la editora»), `due` si el correo da un plazo,
   - `link` a la conversación, `notes` con una línea de contexto,
   - `source`: `gmail:<id del hilo>`, y `project`/`assignee` solo si coinciden exactamente con `estado.json`.
   Si un hilo ya resuelto corresponde a una tarea abierta (mismo `source`), propón `complete` con ese `source`.
3. Calendario: lista los eventos de los próximos 14 días. Por cada uno que no sea personal propón una reunión con `title`, `date`, `time`, `duration`, `participants` y `source`: `gcal:<id del evento>`.
4. Escribe UN solo archivo en `cambios/` (formato `researchos-changes/1`, `author: "pendientes-correo"`) y espera su resultado en `resultados/`.
5. Solo cuando la app confirme (`applied` o `skipped`), etiqueta los hilos procesados con `researchos` para no volver a leerlos. Lo `rejected` o con `error` se deja sin etiquetar y se me cuenta.
6. Termina con un resumen corto: qué propusiste, qué se omitió por repetido y qué falló.
```

Para que sea más automático, ponla en un trabajo programado (p. ej. una tarea diaria de Claude Code) con la carpeta abierta; con el modo **automático** las altas se aplican solas y los borrados siguen pidiendo tu revisión. Mientras no estés seguro de lo que propone, deja el modo de **revisión**.

> Lo que lea el asistente sale de tu equipo hacia el servicio de IA que uses. Si hay correo sensible, restringe la búsqueda (por etiqueta, remitente o carpeta) en las instrucciones de la skill.

## Referencia rápida del formato

- **Operaciones:** `add`, `update`, `complete` (solo tareas), `delete` (solo tareas e ideas). Tipos: `task`, `idea`, `project`, `meeting`, `person`.
- **Referencias:** por `uid` (o sus 8 primeros caracteres) o por nombre exacto (sin importar mayúsculas ni tildes). `"match": "título"` sirve en lugar de `uid`.
- **`set`:** los campos admitidos por tipo están en `AGENTS.md` (se generan de lo que valida la app, así nunca se desactualizan). Un campo desconocido se rechaza con un mensaje claro.
- **Fechas:** `AAAA-MM-DD`, hora local. **Prioridad:** `Alta`, `Media`, `Baja`.
- **Resultados:** `resultados/<archivo>.json` → `status` (`pending` esperando tu revisión o `done`) y, por operación, `applied`, `rejected`, `skipped` (p. ej. ya existía ese `source`; trae el motivo) o `error` (con el motivo).

## Si algo no va

- *«No pasa nada con lo que dejó la IA»*: la pestaña de ResearchOS debe estar abierta y visible (revisa cada ~15 s); si el navegador pide permiso para la carpeta, pulsa **Reactivar** en Ajustes.
- *`estado.json` está viejo*: la app solo lo reescribe mientras está abierta. `researchos.js resumen` avisa si tiene más de 30 minutos.
- *Un lote aparece con errores*: lee `resultados/<archivo>.json`; cada operación dice qué falló. El resto sí se aplicó.
- Los archivos de `cambios/` y `resultados/` se limpian solos pasados 60 días.
