import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHooks, uninstallHooks, EVENT_HOOKS, TOKEN_HOOKS, SCRIPT_NAME } from '../scripts/hooks.mjs';

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
  for (const ev of TOKEN_HOOKS) {
    const tok = settings.hooks[ev].flatMap((g) => g.hooks).filter((h) => h.type === 'command' && h.command.includes(SCRIPT_NAME));
    assert.equal(tok.length, 1, `un solo hook de tokens en ${ev}`);
    assert.deepEqual(tok[0], { type: 'command', command: `node "${scriptPath}" ${url}`, async: true });
  }
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
  assert.equal(removed.length, EVENT_HOOKS.length + TOKEN_HOOKS.length);
});

test('install pone al día el hook de tokens de una versión anterior sin duplicarlo', () => {
  const old = { hooks: { Stop: [{ hooks: [
    { type: 'http', url: url + '/api/hooks', timeout: 2 },
    { type: 'command', command: `node "${scriptPath}" ${url}`, timeout: 10 },
  ] }] } };
  const { settings, added } = installHooks(old, { url, scriptPath });
  const stop = settings.hooks.Stop.flatMap((g) => g.hooks);
  assert.equal(stop.length, 2);
  assert.equal(stop[1].async, true);
  assert.equal(stop[1].timeout, undefined);
  assert.ok(added.includes('Stop: tokens (command, async), actualizado'));
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
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp-')), 'no quedan temporales');

    execFileSync(process.execPath, [SCRIPT, 'uninstall'], { env });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { model: 'opus', hooks: { PreToolUse: existing.hooks.PreToolUse } });
    assert.ok(!fs.existsSync(path.join(dir, 'hooks', SCRIPT_NAME)));
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length, 2, 'cada cambio deja su copia, sin pisar la anterior');
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
