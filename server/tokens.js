// Tokens por herramienta. Los envía el hook hooks/observe-tokens.mjs, que lee
// el transcript en el equipo y manda solo números: el servidor nunca ve la
// conversación. Aquí se validan, se guardan por sesión y se persisten.
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const MAX_TOOLS = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const count = (v) => (Number.isFinite(v) && v >= 0 && v < 1e12 ? Math.floor(v) : null);

/**
 * Valida lo que envía el hook y devuelve una copia limpia (solo los campos
 * conocidos, números enteros no negativos) o null si no es válido.
 */
export function sanitizeTokens(body) {
  if (!body || typeof body !== 'object') return null;
  const sessionId = body.session_id;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return null;
  const t = body.totals;
  if (!t || typeof t !== 'object') return null;
  const totals = {};
  for (const k of [...FIELDS, 'messages']) if ((totals[k] = count(t[k])) === null) return null;
  const byTool = {};
  const entries = Object.entries(body.byTool && typeof body.byTool === 'object' ? body.byTool : {});
  if (entries.length > MAX_TOOLS) return null;
  for (const [id, u] of entries) {
    if (!ID_RE.test(id) || !u || typeof u !== 'object') return null;
    const clean = {};
    for (const k of FIELDS) if ((clean[k] = count(u[k])) === null) return null;
    clean.shared = Math.min(1000, Math.max(1, count(u.shared) ?? 1));
    byTool[id] = clean;
  }
  return { sessionId, byTool, totals };
}

export class TokenStore {
  constructor({ dataDir = null } = {}) {
    this.bySession = new Map(); // sessionId → { byTool, totals }
    this.file = dataDir ? path.join(dataDir, 'tokens.json') : null;
    if (this.file && fs.existsSync(this.file)) {
      try {
        for (const [id, v] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) {
          const clean = sanitizeTokens({ session_id: id, ...v });
          if (clean) this.bySession.set(id, { byTool: clean.byTool, totals: clean.totals });
        }
      } catch { /* fichero dañado: se empieza de cero */ }
    }
  }

  /**
   * Sustituye los tokens de la sesión (el hook manda siempre la sesión entera).
   * Con herramientas en paralelo corren varios hooks a la vez y una foto
   * antigua puede llegar después de una nueva: si trae menos mensajes del
   * modelo que la guardada, se ignora. Devuelve si se guardó.
   */
  set({ sessionId, byTool, totals }) {
    const prev = this.bySession.get(sessionId);
    if (prev && totals.messages < prev.totals.messages) return false;
    this.bySession.set(sessionId, { byTool, totals });
    this.save();
    return true;
  }

  get(sessionId) {
    const t = this.bySession.get(sessionId);
    return t ? { available: true, ...t } : { available: false, byTool: {}, totals: null };
  }

  /** Olvida las sesiones que ya no tienen eventos (caducidad o límite). */
  retain(sessionIds) {
    let changed = false;
    for (const id of this.bySession.keys()) if (!sessionIds.has(id)) { this.bySession.delete(id); changed = true; }
    if (changed) this.save();
  }

  save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.bySession)));
    fs.renameSync(tmp, this.file);
  }
}
