// Almacén de eventos: en memoria + volcado append-only a JSONL.
import fs from 'node:fs';
import path from 'node:path';
import { minimizePayload } from './privacy.js';

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

// El payload llega de fuera: un cwd que no sea texto (número, lista…) rompería
// el resumen de la sesión, así que se descarta.
const textOrNull = (v) => (typeof v === 'string' && v ? v.slice(0, 1000) : null);

/**
 * Normaliza a un registro interno. Acepta:
 * - el sobre de agent-observe: { agentClass, sessionId, agentId, hookName, cwd, payload, timestamp? }
 * - el payload crudo de un hook de Claude Code: { session_id, hook_event_name, cwd, ... }
 * Con detail 'minimo' (por defecto) solo se guarda lo que enseña la vista; con
 * 'completo', el payload entero (recortando strings enormes).
 */
export function normalize(body, now = Date.now(), { detail = 'minimo' } = {}) {
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
    cwd: textOrNull((isEnvelope ? body.cwd : null) ?? payload.cwd),
    payload: detail === 'completo' ? truncateDeep(payload) : minimizePayload(String(hookName), payload),
  };
}

const DAY = 86400e3;

export class Store {
  constructor({ dataDir = null, maxEvents = 50000, retentionDays = 14, detail = 'minimo' } = {}) {
    this.events = [];
    this.retentionMs = retentionDays > 0 ? retentionDays * DAY : 0;
    this.detail = detail;
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
    const since = this.retentionMs ? Date.now() - this.retentionMs : 0;
    let dropped = lines.length > this.maxEvents;
    // Solo caben maxEvents en memoria: los anteriores ni se procesan.
    for (const line of lines.slice(-this.maxEvents)) {
      let rec;
      try { rec = JSON.parse(line); } catch { dropped = true; continue; } // línea cortada a mitad de escritura
      if (rec.ts < since) { dropped = true; continue; }
      // Eventos guardados por una versión anterior o con detail=completo: se
      // reducen igual que los nuevos.
      if (this.detail !== 'completo') rec.payload = minimizePayload(rec.hookName, rec.payload);
      this.insert(rec, false);
    }
    // Se reescribe el fichero con lo que queda: sin caducados, sin lo que no
    // cabe en memoria y, por defecto, con los payloads reducidos.
    if (dropped || this.detail !== 'completo') this.compact();
  }

  /** Quita los eventos más antiguos que la retención y reescribe el fichero. */
  prune(now = Date.now()) {
    if (!this.retentionMs || !this.events.length || this.events[0].ts >= now - this.retentionMs) return 0;
    const since = now - this.retentionMs;
    const before = this.events.length;
    this.events = this.events.filter((ev) => ev.ts >= since);
    this.bySession = new Map();
    for (const ev of this.events) {
      let list = this.bySession.get(ev.sessionId);
      if (!list) this.bySession.set(ev.sessionId, (list = []));
      list.push(ev);
    }
    if (this.file) this.compact();
    return before - this.events.length;
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
