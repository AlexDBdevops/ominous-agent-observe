#!/usr/bin/env node
// Hook de Claude Code (PostToolUse, Stop y SubagentStop, en segundo plano con
// "async": true) que envía a observe los tokens de cada herramienta. Corre en
// el equipo, no en el container: lee el transcript de la sesión y manda SOLO
// números, así el container nunca ve la conversación.
//
// Uso (lo configura `npm run hooks:install`):
//   node observe-tokens.mjs [http://127.0.0.1:4982]   ← payload del hook por stdin
//
// Se ejecuta tras cada herramienta, así que lee de forma incremental: guarda
// en la carpeta temporal hasta qué byte leyó cada transcript (OBSERVE_TOKENS_STATE
// cambia la carpeta). Si ese estado se pierde, se relee entero; no pasa nada.
//
// Sin dependencias (Node 22+). Nunca bloquea la sesión: ante cualquier fallo
// termina en silencio con código 0 y sin escribir nada en stdout.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Tokens de un transcript (.jsonl de Claude Code):
 * - byTool: tool_use_id → { input, output, cacheRead, cacheWrite, shared }
 *   (tokens del mensaje del modelo que lanzó la herramienta; `shared` es
 *   cuántas herramientas lanzó ese mismo mensaje).
 * - totals: suma de todos los mensajes del modelo.
 * Un mensaje puede ocupar varias líneas (un bloque por línea): se agrupan por
 * message.id y se usa el último `usage`.
 */
export function parseTranscript(text) {
  return summarize(addLines(new Map(), text.split('\n')));
}

function addLines(messages, lines) {
  for (const line of lines) {
    if (!line.includes('"assistant"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; } // línea a medio escribir
    if (j.type !== 'assistant' || !j.message) continue;
    const id = j.message.id ?? j.uuid;
    let m = messages.get(id);
    if (!m) messages.set(id, (m = { usage: null, tools: new Set() }));
    if (j.message.usage) m.usage = j.message.usage;
    for (const c of j.message.content ?? []) if (c?.type === 'tool_use' && c.id) m.tools.add(c.id);
  }
  return messages;
}

export const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });

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
    for (const k of Object.keys(u)) totals[k] += u[k];
    totals.messages++;
    for (const t of m.tools) byTool[t] = { ...u, shared: m.tools.size };
  }
  return { byTool, totals };
}

/** Transcript principal y los de sus subagentes (<sesión>/subagents/*.jsonl). */
export function sessionFiles(mainFile) {
  const dir = path.join(mainFile.replace(/\.jsonl$/i, ''), 'subagents');
  let subs = [];
  try { subs = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch {}
  return [mainFile, ...subs];
}

const stateDir = () => process.env.OBSERVE_TOKENS_STATE || path.join(os.tmpdir(), 'ominous-observe-tokens');
const stateFile = (file) => path.join(stateDir(), crypto.createHash('sha1').update(path.resolve(file)).digest('hex') + '.json');

/**
 * Mensajes del modelo de un transcript, leyendo solo lo nuevo desde la última
 * vez. El estado guarda el byte leído y, por mensaje, su usage y sus tool_use.
 */
export function readIncremental(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let state = { offset: 0, messages: [] };
  try { state = JSON.parse(fs.readFileSync(stateFile(file), 'utf8')); } catch { /* sin estado: desde el principio */ }
  // Transcript reescrito o más corto que lo leído: se empieza de cero.
  if (!(state.offset <= st.size)) state = { offset: 0, messages: [] };
  const messages = new Map(state.messages.map(([id, m]) => [id, { usage: m.usage, tools: new Set(m.tools) }]));
  if (st.size > state.offset) {
    const buf = Buffer.alloc(st.size - state.offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, state.offset); } finally { fs.closeSync(fd); }
    // Solo hasta el último salto de línea: una línea a medio escribir se relee
    // entera la próxima vez (y no se corta ningún carácter UTF-8).
    const end = buf.lastIndexOf(0x0a);
    if (end !== -1) {
      addLines(messages, buf.subarray(0, end).toString('utf8').split('\n'));
      state.offset += end + 1;
      const saved = { offset: state.offset, messages: [...messages].map(([id, m]) => [id, { usage: m.usage, tools: [...m.tools] }]) };
      try {
        fs.mkdirSync(stateDir(), { recursive: true });
        // Varios hooks pueden correr a la vez (herramientas en paralelo): cada
        // uno escribe en su temporal y lo renombra, así nadie lee un estado a medias.
        const tmp = `${stateFile(file)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(saved));
        fs.renameSync(tmp, stateFile(file));
      } catch { /* sin estado se relee la próxima vez */ }
    }
  }
  return messages;
}

/** Tokens de toda la sesión: principal + subagentes. */
export function sessionTokens(mainFile) {
  const byTool = {};
  const totals = emptyTotals();
  for (const f of sessionFiles(mainFile)) {
    const messages = readIncremental(f);
    if (!messages) continue;
    const d = summarize(messages);
    Object.assign(byTool, d.byTool);
    for (const k of Object.keys(totals)) totals[k] += d.totals[k];
  }
  return { byTool, totals };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const base = (process.argv[2] || process.env.OBSERVE_URL || 'http://127.0.0.1:4982').replace(/\/$/, '');
  const hook = JSON.parse(await readStdin());
  const file = hook.transcript_path;
  // Solo transcripts de Claude Code: nunca se lee otra ruta aunque llegue en el payload.
  if (!hook.session_id || typeof file !== 'string' || !/\.jsonl$/i.test(file) || !/[\\/]\.claude[\\/]projects[\\/]/i.test(file)) return;
  const { byTool, totals } = sessionTokens(file);
  if (!totals.messages) return;
  await fetch(base + '/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: hook.session_id, byTool, totals }),
    signal: AbortSignal.timeout(3000),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => {}).finally(() => process.exit(0));
}
