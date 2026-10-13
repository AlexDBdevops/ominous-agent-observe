// Tokens por herramienta, leídos del transcript de Claude Code.
// Los hooks no traen tokens; el transcript (.jsonl) sí: cada mensaje del
// modelo lleva su `usage` y los bloques `tool_use` con el mismo id que
// recibimos en PreToolUse/PostToolUse.
import fs from 'node:fs';
import path from 'node:path';

const PROJECTS_RE = /[\\/]\.claude[\\/]projects[\\/](.+\.jsonl)$/i;

/**
 * Convierte el transcript_path del host en una ruta legible aquí.
 * - Con `mountDir` (Docker): C:\Users\x\.claude\projects\p\s.jsonl → <mountDir>/p/s.jsonl
 * - Sin él (npm start en el host): la ruta tal cual.
 * Solo se aceptan .jsonl bajo .claude/projects; nunca se sale de mountDir.
 */
export function resolveTranscript(hostPath, mountDir) {
  if (typeof hostPath !== 'string') return null;
  const m = hostPath.match(PROJECTS_RE);
  if (!m) return null;
  // Nunca se admite subir de carpeta: el transcript_path llega en el evento.
  if (m[1].split(/[\\/]/).includes('..')) return null;
  if (!mountDir) return hostPath;
  const root = path.resolve(mountDir);
  const p = path.resolve(root, ...m[1].split(/[\\/]/));
  return p.startsWith(root + path.sep) ? p : null;
}

/** Transcripts de subagentes: <sesión>/subagents/*.jsonl junto al principal. */
export function subagentTranscripts(mainFile) {
  const dir = path.join(mainFile.replace(/\.jsonl$/i, ''), 'subagents');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Lee las líneas de un transcript y devuelve:
 * - byTool: tool_use_id → { input, output, cacheRead, cacheWrite, shared }
 *   (tokens del mensaje del modelo que lanzó la herramienta; `shared` es
 *   cuántas herramientas lanzó ese mismo mensaje).
 * - totals: suma de todos los mensajes del modelo del transcript.
 * Un mismo mensaje puede aparecer en varias líneas (un bloque por línea);
 * se agrupan por message.id y se usa el último `usage`.
 */
export function parseTranscript(text) {
  return summarize(addLines(new Map(), text.split('\n')));
}

// Acumula en `messages` las líneas de mensajes del modelo.
function addLines(messages, lines) {
  for (const line of lines) {
    if (!line.includes('"assistant"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'assistant' || !j.message) continue;
    const id = j.message.id ?? j.uuid;
    let m = messages.get(id);
    if (!m) messages.set(id, (m = { usage: null, tools: new Set() }));
    if (j.message.usage) m.usage = j.message.usage;
    for (const c of j.message.content ?? []) if (c?.type === 'tool_use' && c.id) m.tools.add(c.id);
  }
  return messages;
}

const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });

// Suma b a a (mismos campos que emptyTotals).
function addTotals(a, b) {
  for (const k of Object.keys(a)) a[k] += b[k];
  return a;
}

function summarize(messages) {
  const byTool = {};
  const totals = emptyTotals();
  for (const m of messages.values()) {
    if (!m.usage) continue;
    const u = {
      input: Number(m.usage.input_tokens) || 0,
      output: Number(m.usage.output_tokens) || 0,
      cacheRead: Number(m.usage.cache_read_input_tokens) || 0,
      cacheWrite: Number(m.usage.cache_creation_input_tokens) || 0,
    };
    addTotals(totals, { ...u, messages: 1 });
    for (const t of m.tools) byTool[t] = { ...u, shared: m.tools.size };
  }
  return { byTool, totals };
}

/**
 * Lee los transcripts de forma incremental: los .jsonl solo crecen, así que
 * por fichero se guarda hasta qué byte se leyó y solo se procesa lo nuevo.
 */
export class TokenReader {
  constructor({ mountDir = null } = {}) {
    this.mountDir = mountDir;
    this.cache = new Map(); // fichero → { offset, rest, messages, data }
  }

  readFile(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    let c = this.cache.get(file);
    if (!c || st.size < c.offset) {
      // Nuevo o truncado (p. ej. reescrito): se empieza de cero.
      c = { offset: 0, messages: new Map(), data: summarize(new Map()) };
      this.cache.set(file, c);
    }
    if (st.size === c.offset) return c.data;
    const buf = Buffer.alloc(st.size - c.offset);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, buf.length, c.offset);
    } catch {
      return c.data;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    // Solo hasta el último salto de línea: una línea a medio escribir se
    // relee entera la próxima vez (y no se corta ningún carácter UTF-8).
    const end = buf.lastIndexOf(0x0a);
    if (end === -1) return c.data;
    c.offset += end + 1;
    const lines = buf.subarray(0, end).toString('utf8').split('\n');
    addLines(c.messages, lines);
    c.data = summarize(c.messages);
    return c.data;
  }

  /** Tokens de una sesión a partir de los transcript_path que traen sus eventos. */
  forSession(events) {
    const files = new Set();
    for (const ev of events) {
      for (const p of [ev.payload?.transcript_path, ev.payload?.agent_transcript_path]) {
        const f = resolveTranscript(p, this.mountDir);
        // Normalizada para no contar dos veces el mismo fichero con otra grafía.
        if (f) files.add(path.resolve(f));
      }
    }
    for (const f of [...files]) for (const s of subagentTranscripts(f)) files.add(path.resolve(s));

    const byTool = {};
    const totals = emptyTotals();
    let found = 0;
    for (const f of files) {
      const d = this.readFile(f);
      if (!d) continue;
      found++;
      Object.assign(byTool, d.byTool);
      addTotals(totals, d.totals);
    }
    return { available: found > 0, byTool, totals };
  }
}
