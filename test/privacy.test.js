import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, minimizePayload } from '../server/privacy.js';
import { Store, normalize } from '../server/store.js';
import { buildRows } from '../public/derive.js';

test('redact tapa los secretos habituales y deja el resto', () => {
  const cases = [
    'git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x',
    'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx',
    'aws AKIAABCDEFGHIJKLMNOP',
    'curl -H "Authorization: Bearer abc.def-ghi_jkl123456"',
    'psql postgres://admin:hunter22@db:5432/app',
    'DB_PASSWORD=supersecreto npm start',
    '"client_secret": "zzzzzzzzzz"',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
  ];
  for (const c of cases) {
    const r = redact(c);
    assert.match(r, /\[oculto\]/, c);
    assert.doesNotMatch(r, /ghp_abc|sk-ant-api03|AKIAABCD|abc\.def-ghi|hunter22|supersecreto|zzzzzzzzzz|AAAA/, c);
  }
  assert.equal(redact('git status && npm test'), 'git status && npm test');
});

test('minimizePayload guarda solo lo que enseña la vista', () => {
  const pre = minimizePayload('PreToolUse', {
    session_id: 's', transcript_path: '/u/.claude/projects/p/s.jsonl', cwd: '/p', scratchpad_dir: '/tmp/x', permission_mode: 'auto',
    tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: '/p/a.js', content: 'const token = "abc";\n'.repeat(100) },
  });
  assert.deepEqual(pre, { tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: '/p/a.js', content_chars: 2100 } });

  const post = minimizePayload('PostToolUse', {
    tool_name: 'Bash', tool_use_id: 't2', duration_ms: 12,
    tool_input: { command: 'cat .env', description: 'Ver entorno' },
    tool_response: { stdout: Array.from({ length: 50 }, (_, i) => `L${i} API_KEY=abc${i}xyz`).join('\n'), stderr: '', interrupted: false },
  });
  assert.equal(post.tool_response.stdout.split('\n').length, 13); // 12 líneas + aviso
  assert.doesNotMatch(post.tool_response.stdout, /abc\d+xyz/);
  assert.equal(post.tool_response.interrupted, false);

  const stop = minimizePayload('SubagentStop', { agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'todo el informe', agent_transcript_path: '/x' });
  assert.deepEqual(stop, { agent_id: 'a1', agent_type: 'Explore' });

  const prompt = minimizePayload('UserPromptSubmit', { prompt: 'Arregla el login\n' + 'detalle '.repeat(200) });
  assert.ok(prompt.prompt.length < 260);
});

test('con el payload mínimo la tabla se pinta igual', () => {
  const ev = (id, hookName, payload) => ({ id, ts: id, sessionId: 's', agentId: 's', hookName, payload: minimizePayload(hookName, payload) });
  const rows = buildRows([
    ev(1, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'npm test', description: 'Pasar los tests' } }),
    ev(2, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'b', duration_ms: 900, tool_response: { stdout: 'ok', exit_code: 0 } }),
    ev(3, 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'e', tool_input: { file_path: '/p/src/a.js', old_string: 'x', new_string: 'y' } }),
    ev(4, 'PostToolUseFailure', { tool_name: 'Edit', tool_use_id: 'e', error: 'String not found' }),
  ], { now: 10 });
  assert.deepEqual(rows.map((r) => [r.tool, r.tag, r.label, r.durationMs, r.exit, r.error]), [
    ['Bash', 'npm', 'Pasar los tests', 900, 'exit 0', false],
    ['Edit', '', '…/src/a.js', 1, 'error', true],
  ]);
  assert.equal(rows[0].output, 'ok');
});

test('normalize guarda el payload mínimo por defecto y completo si se pide', () => {
  const body = { session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'respuesta', transcript_path: '/t' };
  assert.deepEqual(normalize(body, 1).payload, {});
  assert.equal(normalize(body, 1, { detail: 'completo' }).payload.last_assistant_message, 'respuesta');
});

test('Store reduce los eventos antiguos al cargar y aplica la caducidad', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-ret-'));
  try {
    const now = Date.now();
    const old = { ts: now - 20 * 86400e3, sessionId: 'vieja', agentId: 'vieja', hookName: 'Stop', payload: {} };
    const full = { ts: now, sessionId: 'nueva', agentId: 'nueva', hookName: 'SubagentStop', payload: { agent_type: 'Plan', last_assistant_message: 'informe largo' } };
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [old, full].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const store = new Store({ dataDir: dir, retentionDays: 14 });
    assert.deepEqual(store.sessionIds(), ['nueva']);
    assert.deepEqual(store.events[0].payload, { agent_type: 'Plan' });
    // El fichero se reescribe ya reducido y sin lo caducado.
    const onDisk = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    assert.doesNotMatch(onDisk, /informe largo|vieja/);
    // prune quita lo que caduca mientras corre.
    assert.equal(store.prune(now + 15 * 86400e3), 1);
    assert.equal(store.events.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('minimizePayload ignora claves peligrosas que lleguen en tool_input', () => {
  const input = JSON.parse('{"__proto__": {"admin": true}, "constructor": "x", "file_path": "/p/a.js", "a-b": "raro"}');
  const out = minimizePayload('PreToolUse', { tool_name: 'Read', tool_input: input }).tool_input;
  assert.deepEqual(Object.keys(out), ['file_path']);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(({}).admin, undefined);
});
