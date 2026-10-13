import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, normalize } from '../server/store.js';
import { createApp } from '../server/app.js';
import { TokenStore } from '../server/tokens.js';

let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-test-'));
  server = createApp(new Store({ dataDir }), { tokens: new TokenStore({ dataDir }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (p, body) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('normalize acepta payload crudo y sobre de agent-observe', () => {
  const raw = normalize({ session_id: 's', hook_event_name: 'PreToolUse', cwd: '/x', tool_name: 'Bash' }, 5);
  assert.equal(raw.sessionId, 's');
  assert.equal(raw.hookName, 'PreToolUse');
  assert.equal(raw.ts, 5);
  const env = normalize({ agentClass: 'claude-code', sessionId: 's2', agentId: 'a', hookName: 'Stop', cwd: '/y', payload: { session_id: 's2' }, timestamp: 9 });
  assert.equal(env.sessionId, 's2');
  assert.equal(env.agentId, 'a');
  assert.equal(env.ts, 9);
  assert.equal(normalize({ foo: 1 }), null);
});

test('recibe hooks, lista sesiones y persiste en JSONL', async () => {
  let r = await post('/api/hooks', { session_id: 'abc12345xyz', hook_event_name: 'UserPromptSubmit', cwd: '/p/demo', prompt: 'Hola' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {}, 'a Claude Code se le responde {}');
  r = await post('/api/events', { agentClass: 'claude-code', sessionId: 'abc12345xyz', agentId: 'abc12345xyz', hookName: 'PreToolUse', cwd: '/p/demo', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } });
  assert.equal(r.status, 200);

  const list = await (await fetch(base + '/api/sessions')).json();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].title, 'Hola');

  const detail = await (await fetch(base + '/api/sessions/abc12345xyz/events')).json();
  assert.equal(detail.events.length, 2);

  const lines = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const reloaded = new Store({ dataDir });
  assert.equal(reloaded.sessionEvents('abc12345xyz').length, 2);
});

test('rechaza JSON inválido y eventos incompletos', async () => {
  const bad = await fetch(base + '/api/hooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  const incomplete = await post('/api/hooks', { hook_event_name: 'Stop' });
  assert.equal(incomplete.status, 422);
});

test('una web ajena no puede escribir eventos (CSRF)', async () => {
  const body = JSON.stringify({ session_id: 'csrf', hook_event_name: 'Stop' });
  // text/plain es una petición "simple" que el navegador manda sin preflight.
  const plain = await fetch(base + '/api/hooks', { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
  assert.equal(plain.status, 415);
  const foreign = await fetch(base + '/api/hooks', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body,
  });
  assert.equal(foreign.status, 403);
  // Otra app en localhost pero en otro puerto tampoco es este origen.
  const otherPort = await fetch(base + '/api/hooks', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body,
  });
  assert.equal(otherPort.status, 403);
  const list = await (await fetch(base + '/api/sessions')).json();
  assert.ok(!list.sessions.some((s) => s.id === 'csrf'));
});

test('rechaza Hosts ajenos (DNS rebinding)', async () => {
  const http = await import('node:http');
  const status = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: new URL(base).port, path: '/api/sessions', headers: { host } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    }).on('error', reject);
  });
  assert.equal(await status('attacker.example:4982'), 403);
  assert.equal(await status('localhost:4982'), 200);
  assert.equal(await status('127.0.0.1:4982'), 200);
});

test('sirve la vista y bloquea path traversal', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /observe/);
  const evil = await fetch(base + '/..%2fpackage.json');
  assert.notEqual(evil.status, 200);
});

test('recorta strings enormes', async () => {
  await post('/api/hooks', { session_id: 'big', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'x'.repeat(100000) });
  const d = await (await fetch(base + '/api/sessions/big/events')).json();
  assert.ok(d.events[0].payload.tool_response.length < 20000);
});

test('Store descarta los eventos más antiguos por lotes y mantiene las sesiones coherentes', () => {
  const store = new Store({ maxEvents: 10 });
  for (let i = 0; i < 25; i++) store.insert({ ts: i, sessionId: i % 2 ? 'a' : 'b', hookName: 'Stop', payload: {} });
  assert.ok(store.events.length <= 10);
  const perSession = store.sessionEvents('a').length + store.sessionEvents('b').length;
  assert.equal(perSession, store.events.length);
  assert.equal(store.events.at(-1).ts, 24);
  assert.ok(store.sessionEvents('a').every((e) => store.events.includes(e)));
});

test('POST /api/tokens guarda los números, avisa por el stream y rechaza lo que no lo es', async () => {
  const ctrl = new AbortController();
  const stream = await fetch(base + '/api/stream', { signal: ctrl.signal });
  const reader = stream.body.getReader();
  const body = { session_id: 'tok1', byTool: { toolu_x: { input: 1, output: 5, cacheRead: 10, cacheWrite: 0, shared: 1 } },
    totals: { input: 1, output: 5, cacheRead: 10, cacheWrite: 0, messages: 1 } };
  assert.equal((await post('/api/tokens', body)).status, 200);
  let seen = '';
  while (!seen.includes('event: tokens')) seen += new TextDecoder().decode((await reader.read()).value);
  assert.match(seen, /"sessionId":"tok1"/);
  ctrl.abort();
  const t = await (await fetch(base + '/api/sessions/tok1/tokens')).json();
  assert.equal(t.available, true);
  assert.equal(t.byTool.toolu_x.output, 5);
  assert.equal((await post('/api/tokens', { ...body, totals: { ...body.totals, input: 'mucho' } })).status, 422);
  // Desde otra web no se puede escribir.
  const r = await fetch(base + '/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify(body) });
  assert.equal(r.status, 403);
});
