# Cambios

## v0.1 (sin publicar)

- Servidor de hooks de Claude Code (`POST /api/hooks`), compatible con el formato de agent-observe (`POST /api/events`).
- Portada con el árbol de proyectos, sesiones y subagentes.
- Vista de sesión: resumen, actividad por agente con modo automático, filtros, búsqueda y tabla con filas expandibles.
- Duración real de cada herramienta (Pre/Post por `tool_use_id`) y tokens por ejecución leídos del transcript.
- Persistencia en JSONL con límite de eventos, y stream en vivo por SSE.
- Seguridad: solo localhost, protección contra DNS rebinding y contra escritura desde otras webs, transcripts en solo lectura.
- Imagen Docker mínima (sin npm), CI con tests, zizmor, prueba de humo, Trivy y CodeQL, y Dependabot.
