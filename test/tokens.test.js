import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscript, resolveTranscript, TokenReader } from '../server/tokens.js';
import { buildRows, formatTokens, inputTotal } from '../public/derive.js';

const usage = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
const line = (msgId, content, u) => JSON.stringify({ type: 'assistant', uuid: msgId + '-u', message: { id: msgId, content, usage: u } });

// Un mensaje con una herramienta, y otro que lanza dos en paralelo repartido
// en dos líneas (Claude Code escribe un bloque por línea).
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { content: 'hola' } }),
  line('m1', [{ type: 'text', text: 'voy' }, { type: 'tool_use', id: 'toolu_a' }], usage(2, 237, 30129, 16124)),
  line('m2', [{ type: 'tool_use', id: 'toolu_b' }], usage(3, 100, 1000, 50)),
  line('m2', [{ type: 'tool_use', id: 'toolu_c' }], usage(3, 120, 1000, 50)),
  '{roto',
].join('\n') + '\n'; // los transcripts reales acaban en salto de línea

test('parseTranscript asigna el usage del mensaje a cada tool_use', () => {
  const { byTool, totals } = parseTranscript(TRANSCRIPT);
  assert.deepEqual(byTool.toolu_a, { input: 2, output: 237, cacheRead: 30129, cacheWrite: 16124, shared: 1 });
  // m2 agrupado por message.id: último usage y las dos herramientas comparten
  assert.deepEqual(byTool.toolu_b, { input: 3, output: 120, cacheRead: 1000, cacheWrite: 50, shared: 2 });
  assert.equal(byTool.toolu_c.shared, 2);
  assert.deepEqual(totals, { input: 5, output: 357, cacheRead: 31129, cacheWrite: 16174, messages: 2 });
});

test('resolveTranscript traduce la ruta del host y no sale del montaje', () => {
  const host = 'C:\\Users\\x\\.claude\\projects\\C--p\\abc.jsonl';
  assert.equal(resolveTranscript(host, '/claude-projects'), path.resolve('/claude-projects', 'C--p', 'abc.jsonl'));
  assert.equal(resolveTranscript('/home/x/.claude/projects/p/s.jsonl', null), '/home/x/.claude/projects/p/s.jsonl');
  assert.equal(resolveTranscript('/etc/passwd', '/claude-projects'), null);
  assert.equal(resolveTranscript('/x/.claude/projects/../../etc/a.jsonl', '/claude-projects'), null);
  assert.equal(resolveTranscript(undefined, '/claude-projects'), null);
  // Sin montaje (npm start) tampoco se admite subir de carpeta.
  assert.equal(resolveTranscript('C:\\Users\\x\\.claude\\projects\\..\\..\\Downloads\\evil.jsonl', null), null);
});

test('TokenReader lee principal y subagentes desde el montaje', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-tok-'));
  try {
    fs.mkdirSync(path.join(root, 'C--p', 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'C--p', 's1.jsonl'), TRANSCRIPT);
    fs.writeFileSync(path.join(root, 'C--p', 's1', 'subagents', 'agent-1.jsonl'),
      line('m9', [{ type: 'tool_use', id: 'toolu_sub' }], usage(1, 10, 0, 0)) + '\n');
    const reader = new TokenReader({ mountDir: root });
    const t = reader.forSession([{ payload: { transcript_path: 'C:\\Users\\x\\.claude\\projects\\C--p\\s1.jsonl' } }]);
    assert.equal(t.available, true);
    assert.equal(t.byTool.toolu_sub.output, 10);
    assert.equal(t.totals.messages, 3);
    assert.equal(reader.forSession([{ payload: {} }]).available, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

test('formatTokens', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1200), '1.2k');
  assert.equal(formatTokens(46255), '46k');
  assert.equal(formatTokens(1234567), '1.23M');
  assert.equal(formatTokens(null), '—');
});

test('TokenReader lee solo lo nuevo cuando el transcript crece', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-inc-'));
  try {
    fs.mkdirSync(path.join(root, 'C--p'), { recursive: true });
    const file = path.join(root, 'C--p', 's2.jsonl');
    fs.writeFileSync(file, line('a1', [{ type: 'tool_use', id: 'tu_1' }], usage(1, 5, 0, 0)) + '\n');
    const reader = new TokenReader({ mountDir: root });
    const ev = [{ payload: { transcript_path: '/x/.claude/projects/C--p/s2.jsonl' } }];
    assert.equal(reader.forSession(ev).totals.messages, 1);
    // Línea a medio escribir: todavía no cuenta.
    const next = line('a2', [{ type: 'tool_use', id: 'tu_2' }], usage(1, 7, 0, 0));
    fs.appendFileSync(file, next.slice(0, 20));
    assert.equal(reader.forSession(ev).totals.messages, 1);
    fs.appendFileSync(file, next.slice(20) + '\n');
    const t = reader.forSession(ev);
    assert.equal(t.totals.messages, 2);
    assert.equal(t.byTool.tu_2.output, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
