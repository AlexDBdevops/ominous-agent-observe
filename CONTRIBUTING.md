# Contribuir

Gracias por el interés. El proyecto es pequeño a propósito: Node con la librería estándar, sin dependencias y sin paso de compilación.

## Flujo

1. Una rama por cambio (`feat/…`, `fix/…`, `docs/…`, `chore/…`) y PR contra `main`. `main` no admite push directo.
2. Antes de abrir la PR:
   ```bash
   npm test
   docker compose build
   ```
3. La CI repite los tests en Node 22 y 24, audita los workflows con zizmor, arranca la imagen con una prueba de humo y la escanea con Trivy. Los tres checks (`test`, `audit`, `docker`) tienen que salir en verde.

## Criterios

- **Sin dependencias.** Si algo pide una librería o un framework, abre antes un issue para hablarlo.
- **Lógica en `public/derive.js`.** Todo lo que se pueda calcular sin DOM va ahí, con su test en `test/`.
- **Formato de eventos estable.** `POST /api/hooks` recibe el payload de Claude Code tal cual. No lo cambies sin hablarlo antes.
- **Seguridad primero.** El servidor escucha en localhost y ve comandos y prompts. Ningún cambio debe abrirlo a la red sin que se configure de forma explícita.
- **Estilo.** Imita el código de alrededor: comentarios en español y breves, nombres claros y sin código muerto.

## Probar a mano

```bash
docker compose up -d --build
npm run demo      # envía una sesión de ejemplo
```

Abre <http://127.0.0.1:4982>.

## Vulnerabilidades

No abras un issue público. Usa el reporte privado de GitHub (pestaña *Security*).
