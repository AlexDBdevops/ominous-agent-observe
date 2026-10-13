import { Store } from './store.js';
import { createApp } from './app.js';
import { TokenStore } from './tokens.js';

const HOST = process.env.OBSERVE_HOST || '127.0.0.1';
const PORT = Number(process.env.OBSERVE_PORT || 4982);
const DATA_DIR = process.env.OBSERVE_DATA_DIR || null;
const MAX_EVENTS = Number(process.env.OBSERVE_MAX_EVENTS || 50000);
// Días que se guardan los eventos (0 = sin caducidad).
const RETENTION_DAYS = Number(process.env.OBSERVE_RETENTION_DAYS ?? 14);
// 'minimo' (por defecto): solo lo que enseña la vista. 'completo': el payload entero.
const DETAIL = process.env.OBSERVE_DETAIL === 'completo' ? 'completo' : 'minimo';

const store = new Store({ dataDir: DATA_DIR, maxEvents: MAX_EVENTS, retentionDays: RETENTION_DAYS, detail: DETAIL });
// Tokens por herramienta: los envía el hook del equipo (POST /api/tokens).
const tokens = new TokenStore({ dataDir: DATA_DIR });
tokens.retain(new Set(store.sessionIds()));
// Nombres de host extra admitidos (p. ej. si se expone en la red con OBSERVE_BIND).
const EXTRA_HOSTS = (process.env.OBSERVE_ALLOWED_HOSTS || '').split(',');
const server = createApp(store, { tokens, extraHosts: EXTRA_HOSTS, detail: DETAIL });

server.listen(PORT, HOST, () => {
  console.log(`observe escuchando en http://${HOST}:${PORT} (${store.events.length} eventos cargados, detalle ${DETAIL}, retención ${RETENTION_DAYS ? RETENTION_DAYS + ' días' : 'sin límite'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections(); // corta los streams SSE abiertos
  });
}
