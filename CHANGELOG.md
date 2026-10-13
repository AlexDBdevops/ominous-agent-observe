# Cambios

## v0.2.0 (2026-10-13)

- El container ya no monta `~/.claude/projects`: los tokens los manda un hook que corre en tu equipo (`hooks/observe-tokens.mjs`) y solo envía números a `POST /api/tokens`. Corre en segundo plano tras cada herramienta (`"async": true`) y lee solo lo nuevo del transcript, así que los tokens siguen llegando casi en vivo sin frenar a Claude.
- `npm run hooks:install` / `hooks:uninstall` añaden o quitan los hooks en `~/.claude/settings.json`, sin tocar los demás y con copia de seguridad.
- Por defecto solo se guarda lo que enseña la vista (`OBSERVE_DETAIL=minimo`): salidas recortadas a 12 líneas, sin el contenido que escriben `Write` y `Edit` y con los secretos habituales tapados. Los eventos ya guardados se reducen al arrancar (un 80 % menos en una instalación real). `OBSERVE_DETAIL=completo` mantiene el comportamiento anterior.
- Los eventos y sus tokens caducan a los 14 días (`OBSERVE_RETENTION_DAYS`).
- Container con sistema de archivos de solo lectura, sin capacidades de Linux y con `no-new-privileges`.
- Desaparecen `OBSERVE_TOKENS`, `OBSERVE_TRANSCRIPTS_DIR` y `CLAUDE_PROJECTS_DIR`.

## v0.1.0 (2026-10-13)

- Servidor de hooks de Claude Code (`POST /api/hooks`), compatible con el formato de agent-observe (`POST /api/events`).
- Portada con el árbol de proyectos, sesiones y subagentes.
- Vista de sesión: resumen, actividad por agente con modo automático, filtros, búsqueda y tabla con filas expandibles.
- Duración real de cada herramienta (Pre/Post por `tool_use_id`) y tokens por ejecución leídos del transcript.
- Persistencia en JSONL con límite de eventos, y stream en vivo por SSE.
- Seguridad: solo localhost, protección contra DNS rebinding y contra escritura desde otras webs, transcripts en solo lectura.
- Imagen Docker mínima (sin npm), CI con tests, zizmor, prueba de humo, Trivy y CodeQL, y Dependabot (Node se queda en la 24 LTS).
