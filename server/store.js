// Almacén de eventos: en memoria + volcado append-only a JSONL.
import fs from 'node:fs';
import path from 'node:path';

const MAX_STRING = 16 * 1024;

// Recorta strings enormes (salidas de Read, capturas base64…) antes de guardar.
export function truncateDeep(value, max = MAX_STRING) {
  if (typeof value === 'string') {
    return value.length > max ? value.slice(0, max) + `… [+${value.length - max} car.]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, max));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, max);
    return out;
  }
  return value;
}

/**
 * Normaliza a un registro interno. Acepta:
 * - el sobre de agent-observe: { agentClass, sessionId, agentId, hookName, cwd, payload, timestamp? }
 * - el payload crudo de un hook de Claude Code: { session_id, hook_event_name, cwd, ... }
 */
export function normalize(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return null;
  const isEnvelope = body.payload && typeof body.payload === 'object' && (body.hookName || body.sessionId);
  const payload = isEnvelope ? body.payload : body;
  const sessionId = (isEnvelope ? body.sessionId : null) ?? payload.session_id ?? payload.sessionId;
  const hookName = (isEnvelope ? body.hookName : null) ?? payload.hook_event_name ?? payload.hookName;
  if (!sessionId || !hookName) return null;
  const ts = typeof body.timestamp === 'number' ? body.timestamp : now;
  return {
    ts,
    sessionId: String(sessionId),
    agentId: String((isEnvelope ? body.agentId : null) ?? payload.agent_id ?? sessionId),
    agentClass: (isEnvelope ? body.agentClass : null) ?? 'claude-code',
    hookName: String(hookName),
    cwd: (isEnvelope ? body.cwd : null) ?? payload.cwd ?? null,
    payload: truncateDeep(payload),
  };
}

export class Store {
  constructor({ dataDir = null, maxEvents = 50000 } = {}) {
    this.events = [];
    this.bySession = new Map();
    this.nextId = 1;
    this.maxEvents = maxEvents;
    this.listeners = new Set();
    this.file = null;
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.file = path.join(dataDir, 'events.jsonl');
      this.load();
    }
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim());
    // Solo caben maxEvents en memoria: los anteriores ni se procesan.
    for (const line of lines.slice(-this.maxEvents)) {
      try {
        this.insert(JSON.parse(line), false);
      } catch {
        // línea corrupta (p. ej. corte a mitad de escritura): se ignora
      }
    }
    // En memoria solo caben maxEvents; si el fichero ya guarda bastantes más,
    // se reescribe con los que quedan para que no crezca sin límite.
    if (lines.length > this.maxEvents * 1.2) this.compact();
  }

  compact() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, this.events.map(({ id, ...rest }) => JSON.stringify(rest) + '\n').join(''));
    fs.renameSync(tmp, this.file);
  }

  insert(rec, persist = true) {
    const ev = { ...rec, id: this.nextId++ };
    this.events.push(ev);
    let list = this.bySession.get(ev.sessionId);
    if (!list) this.bySession.set(ev.sessionId, (list = []));
    list.push(ev);
    if (persist && this.file) {
      const { id, ...rest } = ev;
      fs.appendFileSync(this.file, JSON.stringify(rest) + '\n');
    }
    if (this.events.length > this.maxEvents) this.evictOldest();
    if (persist) for (const fn of this.listeners) fn(ev);
    return ev;
  }

  // Descarta el 10 % más antiguo de golpe (no uno a uno en cada evento).
  evictOldest() {
    const keep = Math.max(1, Math.floor(this.maxEvents * 0.9));
    const removed = this.events.splice(0, this.events.length - keep);
    const perSession = new Map();
    for (const ev of removed) perSession.set(ev.sessionId, (perSession.get(ev.sessionId) ?? 0) + 1);
    // Los eventos de cada sesión están en orden: los descartados son sus primeros.
    for (const [id, n] of perSession) {
      const list = this.bySession.get(id);
      if (!list) continue;
      list.splice(0, n);
      if (list.length === 0) this.bySession.delete(id);
    }
  }

  sessionEvents(sessionId) {
    return this.bySession.get(sessionId) ?? [];
  }

  sessionIds() {
    return [...this.bySession.keys()];
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
