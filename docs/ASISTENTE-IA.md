# 🤖 Asistente de IA

Deja que un asistente (Claude Code, Claude Desktop, ChatGPT con herramientas, Cursor, un script propio…) **lea tus pendientes y te ayude a mantenerlos al día**, sin servidores ni cuentas: ResearchOS y la IA se hablan a través de **una carpeta**.

```
tu navegador (ResearchOS)  ⇄  carpeta  ⇄  un LLM / agente
        publica estado.json, pendientes.md       lee y propone cambios en cambios/*.json
        lee y aplica cambios/ (con tu revisión)  lee resultados/ para saber qué pasó
```

## Activarlo (1 minuto)

1. En Chrome o Edge: **Ajustes → 🤖 Asistente de IA → Elegir carpeta…** (mejor una carpeta vacía, p. ej. `ResearchOS-IA`).
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

Herramientas: `researchos_overview`, `researchos_list`, `researchos_search`, `researchos_add_task`, `researchos_update_task`, `researchos_complete_task`, `researchos_add_idea`, `researchos_propose_changes` (lote completo) y `researchos_get_result`.

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

## Referencia rápida del formato

- **Operaciones:** `add`, `update`, `complete` (solo tareas), `delete` (solo tareas e ideas). Tipos: `task`, `idea`, `project`, `meeting`, `person`.
- **Referencias:** por `uid` (o sus 8 primeros caracteres) o por nombre exacto (sin importar mayúsculas ni tildes). `"match": "título"` sirve en lugar de `uid`.
- **`set`:** los campos admitidos por tipo están en `AGENTS.md` (se generan de lo que valida la app, así nunca se desactualizan). Un campo desconocido se rechaza con un mensaje claro.
- **Fechas:** `AAAA-MM-DD`, hora local. **Prioridad:** `Alta`, `Media`, `Baja`.
- **Resultados:** `resultados/<archivo>.json` → `status` (`pending` esperando tu revisión o `done`) y, por operación, `applied`, `rejected` o `error` (con el motivo).

## Si algo no va

- *«No pasa nada con lo que dejó la IA»*: la pestaña de ResearchOS debe estar abierta y visible (revisa cada ~15 s); si el navegador pide permiso para la carpeta, pulsa **Reactivar** en Ajustes.
- *`estado.json` está viejo*: la app solo lo reescribe mientras está abierta. `researchos.js resumen` avisa si tiene más de 30 minutos.
- *Un lote aparece con errores*: lee `resultados/<archivo>.json`; cada operación dice qué falló. El resto sí se aplicó.
- Los archivos de `cambios/` y `resultados/` se limpian solos pasados 60 días.
