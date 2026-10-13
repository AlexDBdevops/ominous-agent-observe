import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHooks, uninstallHooks, EVENT_HOOKS, SCRIPT_NAME } from '../scripts/hooks.mjs';

const url = 'http://127.0.0.1:4982';
const scriptPath = '/home/u/.claude/hooks/' + SCRIPT_NAME;
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hooks.mjs');

// Configuración real de alguien: otros hooks, un plugin y uno nuestro ya puesto a mano.
const existing = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mi-linter.sh' }] }],
    Stop: [{ hooks: [{ type: 'http', url: url + '/api/hooks', timeout: 2 }] }],
  },
};

test('install añade eventos y tokens sin tocar lo demás ni duplicar', () => {
  const { settings, added } = installHooks(existing, { url, scriptPath });
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.hooks.PreToolUse[0], existing.hooks.PreToolUse[0], 'el hook ajeno sigue igual');
  for (const ev of EVENT_HOOKS) {
    const http = settings.hooks[ev].flatMap((g) => g.hooks).filter((h) => h.type === 'http' && h.url === url + '/api/hooks');
    assert.equal(http.length, 1, `un solo hook http en ${ev}`);
  }
  const tok = settings.hooks.Stop.flatMap((g) => g.hooks).filter((h) => h.type === 'command');
  assert.equal(tok.length, 1);
  assert.equal(tok[0].command, `node "${scriptPath}" ${url}`);
  assert.ok(!added.includes('Stop: eventos (http)'), 'el que ya estaba no se cuenta como añadido');
  assert.equal(settings.hooks.PreToolUse.at(-1).matcher, '*');
  assert.equal(existing.hooks.Stop.length, 1, 'no modifica el objeto original');
  // Instalar dos veces no cambia nada.
  assert.deepEqual(installHooks(settings, { url, scriptPath }).added, []);
});

test('uninstall quita solo lo de observe y deja lo ajeno', () => {
  const installed = installHooks(existing, { url, scriptPath }).settings;
  const { settings, removed } = uninstallHooks(installed, { url });
  assert.deepEqual(settings, { model: 'opus', hooks: { PreToolUse: existing.hooks.PreToolUse } });
  assert.equal(removed.length, EVENT_HOOKS.length + 2);
});

test('el comando instala con copia de seguridad y desinstala, sin tocar el ~/.claude real', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-hooks-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(existing));
    execFileSync(process.execPath, [SCRIPT, 'install', '--dry-run'], { env });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), existing, '--dry-run no escribe');

    execFileSync(process.execPath, [SCRIPT, 'install'], { env });
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.ok(after.hooks.SubagentStop);
    assert.ok(fs.existsSync(path.join(dir, 'hooks', SCRIPT_NAME)), 'copia el script de tokens');
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length, 1);

    execFileSync(process.execPath, [SCRIPT, 'uninstall'], { env });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { model: 'opus', hooks: { PreToolUse: existing.hooks.PreToolUse } });
    assert.ok(!fs.existsSync(path.join(dir, 'hooks', SCRIPT_NAME)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no escribe nada si settings.json no es JSON válido', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-hooks-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ roto');
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'install'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: 'pipe' }));
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{ roto');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
