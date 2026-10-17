import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTranscript, sessionTokens } from '../hooks/observe-tokens.mjs';

// El estado de la lectura incremental va a una carpeta de pruebas, no a la temporal real.
process.env.OBSERVE_TOKENS_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-state-'));
import { sanitizeTokens, TokenStore } from '../server/tokens.js';
import { buildRows, formatTokens, inputTotal, newInput } from '../public/derive.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'observe-tokens.mjs');
const usage = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
const line = (msgId, content, u) => JSON.stringify({ type: 'assistant', uuid: msgId + '-u', message: { id: msgId, content, usage: u } });

// Un mensaje con una herramienta, y otro que lanza dos en paralelo repartido
// en dos líneas (Claude Code escribe un bloque por línea).
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { content: 'hola, mi clave es secreta' } }),
  line('m1', [{ type: 'text', text: 'voy' }, { type: 'tool_use', id: 'toolu_a' }], usage(2, 237, 30129, 16124)),
  line('m2', [{ type: 'tool_use', id: 'toolu_b' }], usage(3, 100, 1000, 50)),
  line('m2', [{ type: 'tool_use', id: 'toolu_c' }], usage(3, 120, 1000, 50)),
  '{roto',
].join('\n') + '\n';

// Transcript de prueba con la misma estructura de carpetas que Claude Code.
function fakeProjects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-tok-'));
  const dir = path.join(root, '.claude', 'projects', 'C--p');
  fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), TRANSCRIPT);
  fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-1.jsonl'), line('m9', [{ type: 'tool_use', id: 'toolu_sub' }], usage(1, 10, 0, 0)) + '\n');
  return { root, file: path.join(dir, 's1.jsonl') };
}

test('parseTranscript asigna el usage del mensaje a cada tool_use', () => {
  const { byTool, totals } = parseTranscript(TRANSCRIPT);
  assert.deepEqual(byTool.toolu_a, { input: 2, output: 237, cacheRead: 30129, cacheWrite: 16124, shared: 1 });
  // m2 agrupado por message.id: último usage y las dos herramientas comparten
  assert.deepEqual(byTool.toolu_b, { input: 3, output: 120, cacheRead: 1000, cacheWrite: 50, shared: 2 });
  assert.equal(byTool.toolu_c.shared, 2);
  assert.deepEqual(totals, { input: 5, output: 357, cacheRead: 31129, cacheWrite: 16174, messages: 2 });
});

test('sessionTokens suma el principal y los subagentes', () => {
  const { root, file } = fakeProjects();
  try {
    const t = sessionTokens(file);
    assert.equal(t.byTool.toolu_sub.output, 10);
    assert.equal(t.totals.messages, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sessionTokens lee solo lo nuevo y no cuenta líneas a medio escribir', () => {
  const { root, file } = fakeProjects();
  try {
    assert.equal(sessionTokens(file).totals.messages, 3);
    const next = line('m3', [{ type: 'tool_use', id: 'toolu_d' }], usage(1, 7, 0, 0));
    fs.appendFileSync(file, next.slice(0, 20));
    assert.equal(sessionTokens(file).totals.messages, 3, 'línea a medias: todavía no cuenta');
    fs.appendFileSync(file, next.slice(20) + '\n');
    const t = sessionTokens(file);
    assert.equal(t.totals.messages, 4, 'ni se pierde ni se cuenta dos veces lo ya leído');
    assert.equal(t.byTool.toolu_d.output, 7);
    assert.equal(t.byTool.toolu_a.output, 237, 'lo leído antes sigue ahí');
    // Transcript reescrito más corto: se vuelve a leer desde el principio.
    fs.writeFileSync(file, line('z1', [{ type: 'tool_use', id: 'toolu_z' }], usage(1, 1, 0, 0)) + '\n');
    assert.deepEqual(Object.keys(sessionTokens(file).byTool).sort(), ['toolu_sub', 'toolu_z']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('el hook manda solo números al servidor y nunca el texto de la conversación', async () => {
  const { root, file } = fakeProjects();
  let received = null;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c)).on('end', () => { received = { url: req.url, type: req.headers['content-type'], body: b }; res.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const child = spawn(process.execPath, [HOOK, `http://127.0.0.1:${srv.address().port}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stdin.end(JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', transcript_path: file }));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    assert.equal(out, '', 'un hook Stop no debe escribir nada en stdout');
    assert.equal(received.url, '/api/tokens');
    assert.match(received.type, /^application\/json/);
    assert.doesNotMatch(received.body, /hola|clave|voy/);
    const body = JSON.parse(received.body);
    assert.equal(body.session_id, 's1');
    assert.equal(body.totals.messages, 3);
    assert.ok(sanitizeTokens(body), 'lo que manda el hook lo acepta el servidor');
  } finally {
    srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('el hook no lee rutas que no sean transcripts de Claude Code y nunca falla', async () => {
  for (const input of [JSON.stringify({ session_id: 's', transcript_path: '/etc/passwd' }), 'no es json']) {
    const child = spawn(process.execPath, [HOOK, 'http://127.0.0.1:9'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(input);
    assert.equal(await new Promise((r) => child.on('close', r)), 0);
  }
});

test('sanitizeTokens solo acepta números y ids válidos', () => {
  const ok = { session_id: 's', byTool: { toolu_1: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, shared: 2, extra: 'x' } },
    totals: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, messages: 1 } };
  assert.deepEqual(sanitizeTokens(ok).byTool.toolu_1, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, shared: 2 });
  assert.equal(sanitizeTokens({ ...ok, totals: { ...ok.totals, input: 'x' } }), null);
  assert.equal(sanitizeTokens({ ...ok, totals: { ...ok.totals, output: -1 } }), null);
  assert.equal(sanitizeTokens({ ...ok, byTool: { '<script>': ok.byTool.toolu_1 } }), null);
  assert.equal(sanitizeTokens({ ...ok, session_id: 5 }), null);
});

test('TokenStore persiste por sesión y olvida las que ya no existen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-ts-'));
  try {
    const clean = sanitizeTokens({ session_id: 's', byTool: {}, totals: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, messages: 1 } });
    new TokenStore({ dataDir: dir }).set(clean);
    const again = new TokenStore({ dataDir: dir });
    assert.equal(again.get('s').available, true);
    assert.equal(again.get('otra').available, false);
    again.retain(new Set());
    assert.equal(new TokenStore({ dataDir: dir }).get('s').available, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRows pone los tokens en la fila por tool_use_id', () => {
  const { byTool } = parseTranscript(TRANSCRIPT);
  const rows = buildRows([
    { id: 1, ts: 1, sessionId: 's', hookName: 'PreToolUse', payload: { tool_name: 'Bash', tool_use_id: 'toolu_a', tool_input: { command: 'ls' } } },
    { id: 2, ts: 2, sessionId: 's', hookName: 'PostToolUse', payload: { tool_name: 'Bash', tool_use_id: 'toolu_a', duration_ms: 5 } },
  ], { tokens: byTool });
  assert.equal(rows[0].tokens.output, 237);
  assert.equal(inputTotal(rows[0].tokens), 2 + 30129 + 16124);
});

test('newInput no cuenta la caché leída', () => {
  assert.equal(newInput({ input: 140, cacheRead: 15049942, cacheWrite: 277490, output: 51397 }), 140 + 277490);
  assert.equal(newInput(null), 0);
});

test('formatTokens', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1200), '1.2k');
  assert.equal(formatTokens(46255), '46k');
  assert.equal(formatTokens(1234567), '1.23M');
  assert.equal(formatTokens(null), '—');
});
