import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, buildLanes, packDots, subcommand, classifyTool, summarizeSession, layoutTree, formatDuration } from '../public/derive.js';

let id = 0;
const ev = (ts, hookName, payload = {}) => ({ id: ++id, ts, sessionId: 's1', agentId: 's1', hookName, cwd: '/p/demo', payload });

test('subcommand extrae el primer comando real', () => {
  assert.equal(subcommand('cd /x && git status'), 'git');
  assert.equal(subcommand('FOO=1 sudo docker compose up'), 'docker');
  assert.equal(subcommand('/usr/bin/grep -rn x .'), 'grep');
  assert.equal(subcommand('node.exe script.js'), 'node');
  assert.equal(subcommand(undefined), '');
});

test('classifyTool respeta los tipos e iconos del diseño', () => {
  assert.deepEqual(classifyTool('Bash'), { kind: 'bash', icon: 'zap' });
  assert.deepEqual(classifyTool('Edit'), { kind: 'edit', icon: 'pen' });
  assert.deepEqual(classifyTool('Write'), { kind: 'edit', icon: 'pen' });
  assert.deepEqual(classifyTool('Read'), { kind: 'read', icon: 'book' });
  assert.deepEqual(classifyTool('ToolSearch'), { kind: 'tool', icon: 'wrench' });
  assert.deepEqual(classifyTool('TaskStop'), { kind: 'tool', icon: 'wrench' });
});

test('empareja Pre/Post por tool_use_id y usa la duración real', () => {
  const rows = buildRows([
    ev(1000, 'SessionStart', { source: 'startup' }),
    ev(2000, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'git status', description: 'Ver estado' } }),
    ev(5000, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'a', tool_response: { stdout: 'limpio', stderr: '' } }),
  ], { now: 6000 });
  assert.equal(rows.length, 2);
  const [session, bash] = rows;
  assert.equal(session.tool, 'Session');
  assert.equal(bash.tag, 'git');
  assert.equal(bash.label, 'Ver estado');
  assert.equal(bash.durationMs, 3000);
  assert.equal(bash.estimated, false);
  assert.equal(bash.running, false);
  assert.equal(bash.output, 'limpio');
});

test('un Pre sin Post al final de la sesión está en curso', () => {
  const rows = buildRows([
    ev(1000, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'docker build .' } }),
  ], { now: 4000 });
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].durationMs, 3000);
});

test('sin Post y con el turno cerrado, la duración se estima con el siguiente evento', () => {
  const rows = buildRows([
    ev(1000, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a/b/c.js' } }),
    ev(4000, 'Stop', {}),
  ], { now: 10000 });
  assert.equal(rows[0].running, false);
  assert.equal(rows[0].durationMs, 3000);
  assert.equal(rows[0].estimated, true);
  assert.equal(rows[0].label, '…/b/c.js');
});

test('PostToolUseFailure marca error', () => {
  const rows = buildRows([
    ev(1000, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'c', tool_input: { command: 'false' } }),
    ev(1500, 'PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'c', error: 'exit 1' }),
  ], { now: 2000 });
  assert.equal(rows[0].error, true);
  assert.equal(rows[0].output, 'exit 1');
});

test('InstructionsLoaded aparece como Config', () => {
  const rows = buildRows([ev(1000, 'InstructionsLoaded', { file_path: 'C:\\p\\demo\\CLAUDE.md' })]);
  assert.equal(rows[0].tool, 'Config');
  assert.equal(rows[0].icon, 'file');
});

test('summarizeSession toma el primer prompt como título', () => {
  const s = summarizeSession('abcdef1234', [
    ev(1000, 'SessionStart'),
    ev(2000, 'UserPromptSubmit', { prompt: 'Revisa los   permisos\nde la API' }),
    ev(3000, 'UserPromptSubmit', { prompt: 'otro' }),
  ]);
  assert.equal(s.title, 'Revisa los permisos de la API');
  assert.equal(s.hash, 'abcdef12');
  assert.equal(s.project, 'demo');
  assert.equal(s.count, 3);
});

test('formatDuration', () => {
  assert.equal(formatDuration(450), '450ms');
  assert.equal(formatDuration(8000), '8s');
  assert.equal(formatDuration(92000), '1m 32s');
  assert.equal(formatDuration(null), '—');
});

test('usa duration_ms del PostToolUse como duración real', () => {
  const rows = buildRows([
    ev(1000, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'd', tool_input: { command: 'ls' } }),
    ev(1900, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'd', tool_response: {}, duration_ms: 742 }),
  ]);
  assert.equal(rows[0].durationMs, 742);
});

test('packDots reparte en sub-filas los iconos que se pisan', () => {
  // 0 y 10 se pisan (gap 24); 50 cabe en la primera fila; 55 vuelve a pisar
  const { rows, slot } = packDots([0, 10, 50, 55], 24);
  assert.equal(rows, 2);
  assert.deepEqual(slot, [0, 1, 0, 1]);
  assert.deepEqual(packDots([0, 30, 60], 24), { rows: 1, slot: [0, 0, 0] });
  assert.equal(packDots([], 24).rows, 1);
});

test('buildLanes: principal primero y subagentes con su tipo', () => {
  const lanes = buildLanes('s1', [
    { ...ev(1000, 'PreToolUse'), agentId: 's1' },
    { ...ev(2000, 'SubagentStart', { agent_id: 'sub-b', agent_type: 'Explore' }), agentId: 'sub-b' },
    { ...ev(3000, 'PreToolUse', { agent_id: 'sub-c' }), agentId: 'sub-cccccccccc' },
  ]);
  assert.deepEqual(lanes.map((l) => l.name), ['principal', 'Explore', 'sub-cccc']);
  assert.equal(lanes[0].main, true);
});

test('una sesión reanudada tras SessionEnd vuelve a tener herramientas en curso', () => {
  const evs = [
    ev(1000, 'SessionStart'), ev(2000, 'SessionEnd'), ev(3000, 'SessionStart'),
    ev(4000, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'r1', tool_input: { command: 'ls' } }),
  ];
  assert.equal(buildRows(evs, { now: 5000 }).find((r) => r.isTool).running, true);
  assert.equal(summarizeSession('s1', evs).ended, false);
});

test('el Stop del agente principal no termina las herramientas de un subagente', () => {
  const rows = buildRows([
    { ...ev(1000, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'sb', tool_input: { command: 'sleep 60' } }), agentId: 'sub-1' },
    ev(2000, 'Stop'),
  ], { now: 3000 });
  assert.equal(rows[0].running, true);
});

test('el título ignora los avisos automáticos que llegan como prompt', () => {
  const s = summarizeSession('s9', [
    ev(1000, 'UserPromptSubmit', { prompt: '<task-notification><task-id>x</task-id></task-notification>' }),
    ev(2000, 'UserPromptSubmit', { prompt: 'Arregla el login' }),
  ]);
  assert.equal(s.title, 'Arregla el login');
});

test('el resumen lista los subagentes de la sesión', () => {
  const s = summarizeSession('s1', [
    ev(1000, 'SessionStart'),
    { ...ev(2000, 'SubagentStart', { agent_type: 'Explore' }), agentId: 'a1' },
    { ...ev(3000, 'SubagentStop', {}), agentId: 'a2' },
  ]);
  assert.deepEqual(s.agents, [{ id: 'a1', name: 'Explore' }, { id: 'a2', name: 'a2' }]);
});

test('layoutTree: proyectos sin solaparse, vivas en el centro y subagentes como radios', () => {
  const ses = (id, project, live, agents = 0) =>
    ({ id, project, live, agents: Array.from({ length: agents }, (_, i) => ({ id: id + i, name: '' })) });
  const list = [
    ses('a', 'uno', true, 3), ses('b', 'uno', false), ses('c', 'uno', false, 12),
    ses('d', 'dos', false), ...Array.from({ length: 20 }, (_, i) => ses('e' + i, 'tres', false)),
  ];
  const t = layoutTree(list, (s) => s.live);
  assert.equal(t.projects.length, 3);
  for (const p of t.projects) {
    for (const q of t.projects) if (p !== q) assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= p.r + q.r, `${p.name} pisa ${q.name}`);
    assert.ok(p.x - p.r > 0 && p.y - p.r > 0 && p.x + p.r < t.width && p.y + p.r < t.height, `${p.name} se sale`);
  }
  const uno = t.projects.find((p) => p.name === 'uno');
  const a = uno.sessions.find((s) => s.id === 'a');
  assert.deepEqual([a.live, a.x, a.y, a.agents.length], [true, uno.x, uno.y, 3]);
  const b = uno.sessions.find((s) => s.id === 'b');
  assert.ok(Math.abs(Math.hypot(b.x - uno.x, b.y - uno.y) - uno.r) < 1e-6, 'las no vivas van en el borde');
  const c = uno.sessions.find((s) => s.id === 'c');
  assert.deepEqual([c.agents.length, c.more], [10, 2]);
  // Con muchas sesiones el círculo crece para que no se pisen.
  assert.ok(t.projects.find((p) => p.name === 'tres').r > t.projects.find((p) => p.name === 'dos').r);
  assert.deepEqual(layoutTree([], () => false), { width: 0, height: 0, projects: [] });
});
