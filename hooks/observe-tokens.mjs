#!/usr/bin/env node
// Hook de Claude Code (Stop y SubagentStop) que envía a observe los tokens de
// cada herramienta. Corre en el equipo, no en el container: lee el transcript
// de la sesión y manda SOLO números, así el container nunca ve la conversación.
//
// Uso (lo configura `npm run hooks:install`):
//   node observe-tokens.mjs [http://127.0.0.1:4982]   ← payload del hook por stdin
//
// Sin dependencias (Node 22+). Nunca bloquea la sesión: ante cualquier fallo
// termina en silencio con código 0 y sin escribir nada en stdout.
import fs from 'node:fs';
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

/** Tokens de toda la sesión: principal + subagentes. */
export function sessionTokens(mainFile) {
  const byTool = {};
  const totals = emptyTotals();
  for (const f of sessionFiles(mainFile)) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const d = parseTranscript(text);
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
