import { Store } from './store.js';
import { createApp } from './app.js';
import { TokenReader } from './tokens.js';

const HOST = process.env.OBSERVE_HOST || '127.0.0.1';
const PORT = Number(process.env.OBSERVE_PORT || 4982);
const DATA_DIR = process.env.OBSERVE_DATA_DIR || null;
const MAX_EVENTS = Number(process.env.OBSERVE_MAX_EVENTS || 50000);

const store = new Store({ dataDir: DATA_DIR, maxEvents: MAX_EVENTS });
// Carpeta donde están montados los transcripts (~/.claude/projects) dentro del
// container. Fuera de Docker se leen en su ruta original.
const TRANSCRIPTS_DIR = process.env.OBSERVE_TRANSCRIPTS_DIR || null;
const tokens = process.env.OBSERVE_TOKENS === '0' ? null : new TokenReader({ mountDir: TRANSCRIPTS_DIR });
// Nombres de host extra admitidos (p. ej. si se expone en la red con OBSERVE_BIND).
const EXTRA_HOSTS = (process.env.OBSERVE_ALLOWED_HOSTS || '').split(',');
const server = createApp(store, { tokens, extraHosts: EXTRA_HOSTS });

server.listen(PORT, HOST, () => {
  console.log(`observe escuchando en http://${HOST}:${PORT} (${store.events.length} eventos cargados)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections(); // corta los streams SSE abiertos
  });
}
