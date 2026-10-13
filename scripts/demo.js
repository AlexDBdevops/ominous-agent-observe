// Envía una sesión de ejemplo al servidor para ver la vista con datos.
// Uso: OBSERVE_URL=http://127.0.0.1:4982 npm run demo
const base = (process.env.OBSERVE_URL || 'http://127.0.0.1:4982').replace(/\/$/, '');
const session_id = 'demo-' + Math.random().toString(16).slice(2, 10);
const cwd = 'C:\\Users\\demo\\proyectos\\ominous-security';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [
  ['SessionStart', { source: 'startup' }],
  ['InstructionsLoaded', { file_path: cwd + '\\CLAUDE.md' }],
  ['UserPromptSubmit', { prompt: 'Permisos IA + extracción CodeQL' }],
  ['PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'grep -rn auto_approve lib/', description: 'Check existing AI auto-approve detection' } }, 1200],
  ['PostToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_response: { stdout: 'lib/surfaces.js:42:  auto_approve: true', stderr: '' } }],
  ['PreToolUse', { tool_name: 'ToolSearch', tool_use_id: 't2', tool_input: { query: 'select:TaskStop' } }, 300],
  ['PostToolUse', { tool_name: 'ToolSearch', tool_use_id: 't2', tool_response: {} }],
  // Ráfaga de lecturas en paralelo: en la actividad plegada se pisan.
  ['PreToolUse', { tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'auto_approve', path: cwd + '\\lib' } }, 40],
  ['PreToolUse', { tool_name: 'Glob', tool_use_id: 'g2', tool_input: { pattern: '**/*.ql' } }, 40],
  ['PreToolUse', { tool_name: 'Read', tool_use_id: 'g3', tool_input: { file_path: cwd + '\\lib\\rules.js' } }, 60],
  ['PostToolUse', { tool_name: 'Grep', tool_use_id: 'g1', tool_response: {}, duration_ms: 31 }, 20],
  ['PostToolUse', { tool_name: 'Glob', tool_use_id: 'g2', tool_response: {}, duration_ms: 54 }, 20],
  ['PostToolUse', { tool_name: 'Read', tool_use_id: 'g3', tool_response: {}, duration_ms: 70 }, 200],
  // Un subagente con su propio carril.
  ['SubagentStart', { agent_id: 'sub-explore-1', agent_type: 'Explore' }, 150],
  ['PreToolUse', { agent_id: 'sub-explore-1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 's1', tool_input: { pattern: 'codeql' } }, 60],
  ['PostToolUse', { agent_id: 'sub-explore-1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 's1', tool_response: {}, duration_ms: 48 }, 60],
  ['PreToolUse', { agent_id: 'sub-explore-1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 's2', tool_input: { file_path: cwd + '\\codeql\\config.yml' } }, 300],
  ['PostToolUse', { agent_id: 'sub-explore-1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 's2', tool_response: {}, duration_ms: 280 }, 100],
  ['SubagentStop', { agent_id: 'sub-explore-1', agent_type: 'Explore' }, 300],
  ['PreToolUse', { tool_name: 'Read', tool_use_id: 't3', tool_input: { file_path: cwd + '\\lib\\surfaces.js' } }, 700],
  ['PostToolUse', { tool_name: 'Read', tool_use_id: 't3', tool_response: { file: { content: 'export const surfaces = [...]' } } }],
  ['PreToolUse', { tool_name: 'Edit', tool_use_id: 't4', tool_input: { file_path: cwd + '\\lib\\surfaces.js' } }, 400],
  ['PostToolUse', { tool_name: 'Edit', tool_use_id: 't4', tool_response: {} }],
  ['PreToolUse', { tool_name: 'Bash', tool_use_id: 't5', tool_input: { command: 'node test/permisos.js', description: 'Test the new AI permission checks' } }, 900],
  ['PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 't5', error: 'Exit code 1\nAssertionError: expected "deny", got "allow"' }],
  ['PreToolUse', { tool_name: 'Bash', tool_use_id: 't6', tool_input: { command: 'docker run --rm codeql database create db --source-root .', description: 'Try explicit hidden folder inclusion for CodeQL' } }],
];

for (const [hook_event_name, extra, waitAfter = 250] of steps) {
  const res = await fetch(base + '/api/hooks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id, hook_event_name, cwd, ...extra }),
  });
  if (!res.ok) throw new Error(`${hook_event_name}: ${res.status} ${await res.text()}`);
  await sleep(waitAfter);
}
console.log(`Sesión de demo enviada: ${base}/#${session_id}`);
