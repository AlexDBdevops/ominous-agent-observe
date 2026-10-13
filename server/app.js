// Servidor HTTP: recibe hooks, sirve la API, el stream SSE y la vista estática.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './store.js';
import { summarizeSession, NO_TOKENS } from '../public/derive.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'prohibido' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'no encontrado' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Nombre de host sin puerto, en minúsculas ('127.0.0.1:4982' → '127.0.0.1').
function hostname(hostHeader) {
  const h = String(hostHeader ?? '').trim().toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
}

export function isAllowedHost(hostHeader, allowed) {
  return allowed.includes(hostname(hostHeader));
}

// Mismo origen exacto (host y puerto): una página en localhost:3000 no es esta app.
export function isSameOrigin(origin, hostHeader) {
  try {
    return new URL(origin).host.toLowerCase() === String(hostHeader ?? '').toLowerCase();
  } catch {
    return false;
  }
}

export function createApp(store, { tokens = null, extraHosts = [] } = {}) {
  const allowedHosts = [...LOCAL_HOSTS, ...extraHosts.map(hostname).filter(Boolean)];
  const tokensOf = (events) => {
    if (!tokens) return NO_TOKENS;
    try {
      return tokens.forSession(events);
    } catch (err) {
      console.error('tokens:', err.message);
      return NO_TOKENS;
    }
  };

  // Resumen por sesión, recalculado solo si sus eventos cambiaron
  // (la vista pide /api/sessions tras cada evento).
  const summaries = new Map();
  const summaryOf = (id) => {
    const events = store.sessionEvents(id);
    const last = events[events.length - 1];
    const hit = summaries.get(id);
    if (hit && hit.len === events.length && hit.last === last) return hit.summary;
    const summary = summarizeSession(id, events);
    summaries.set(id, { len: events.length, last, summary });
    return summary;
  };

  const clients = new Set();

  store.subscribe((ev) => {
    const msg = `event: hook\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(msg);
  });

  const keepAlive = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  keepAlive.unref();

  async function ingest(req, res, rawHook) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, err.status ?? 400, { ok: false, error: err.status ? err.message : 'JSON inválido' });
    }
    const rec = normalize(body);
    if (!rec) return sendJson(res, 422, { ok: false, error: 'faltan session_id o hook_event_name' });
    const ev = store.insert(rec);
    // Claude Code interpreta el JSON de un hook HTTP como salida del hook:
    // a /api/hooks se responde {} para no alterar nada.
    return sendJson(res, 200, rawHook ? {} : { ok: true, id: ev.id });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // Protección contra DNS rebinding y peticiones de otras webs: solo se
    // atiende si el Host es uno permitido, y una web ajena (Origin distinto)
    // nunca puede escribir eventos.
    if (!isAllowedHost(req.headers.host, allowedHosts)) return sendJson(res, 403, { error: 'host no permitido' });
    if (req.method === 'POST') {
      if (req.headers.origin && !isSameOrigin(req.headers.origin, req.headers.host)) {
        return sendJson(res, 403, { error: 'origen no permitido' });
      }
      // Exigir JSON obliga a los navegadores a hacer preflight CORS, que nunca se aprueba.
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        return sendJson(res, 415, { ok: false, error: 'se espera content-type: application/json' });
      }
    }

    try {
      if (req.method === 'POST' && p === '/api/hooks') return await ingest(req, res, true);
      if (req.method === 'POST' && p === '/api/events') return await ingest(req, res, false);

      if (req.method === 'GET' && p === '/api/health') {
        return sendJson(res, 200, { ok: true, events: store.events.length, sessions: store.bySession.size });
      }

      if (req.method === 'GET' && p === '/api/sessions') {
        for (const id of summaries.keys()) if (!store.bySession.has(id)) summaries.delete(id);
        const list = store.sessionIds().map(summaryOf).sort((a, b) => b.lastTs - a.lastTs);
        return sendJson(res, 200, { now: Date.now(), sessions: list });
      }

      const m = p.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (req.method === 'GET' && m) {
        const id = decodeURIComponent(m[1]);
        const events = store.sessionEvents(id);
        if (url.searchParams.get('download') === '1') {
          const safe = id.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_');
          res.setHeader('content-disposition', `attachment; filename="observe-${safe}.json"`);
        }
        return sendJson(res, 200, { events, tokens: tokensOf(events) });
      }

      const t = p.match(/^\/api\/sessions\/([^/]+)\/tokens$/);
      if (req.method === 'GET' && t) {
        return sendJson(res, 200, tokensOf(store.sessionEvents(decodeURIComponent(t[1]))));
      }

      if (req.method === 'GET' && p === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(': conectado\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

      return sendJson(res, 404, { error: 'no encontrado' });
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'error interno' });
    }
  });
}
