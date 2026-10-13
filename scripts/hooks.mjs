// Instala o quita los hooks de Claude Code que alimentan observe.
//
//   npm run hooks:install                      añade los hooks a ~/.claude/settings.json
//   npm run hooks:uninstall                    los quita
//   node scripts/hooks.mjs install --dry-run   enseña qué cambiaría, sin escribir nada
//   node scripts/hooks.mjs install --url http://127.0.0.1:5000   otro puerto
//
// - Eventos: hooks `http` que mandan el payload a POST /api/hooks.
// - Tokens: hook `command` en Stop y SubagentStop que ejecuta
//   hooks/observe-tokens.mjs (copiado a ~/.claude/hooks/) y manda solo números.
// No toca otros hooks, no duplica los que ya existen y guarda una copia de
// seguridad de settings.json antes de escribir. CLAUDE_CONFIG_DIR cambia la carpeta.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EVENT_HOOKS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'InstructionsLoaded', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'Stop', 'SubagentStart', 'SubagentStop'];
export const TOKEN_HOOKS = ['Stop', 'SubagentStop'];
const TOOL_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
export const SCRIPT_NAME = 'ominous-observe-tokens.mjs';

const isOurHttp = (h, url) => h?.type === 'http' && h.url === url + '/api/hooks';
const isOurCommand = (h) => h?.type === 'command' && typeof h.command === 'string' && h.command.includes(SCRIPT_NAME);
const isOurs = (h, url) => isOurHttp(h, url) || isOurCommand(h);

/** Comando del hook de tokens (barras normales: vale en bash y en Windows). */
export const tokenCommand = (scriptPath, url) => `node "${scriptPath.replace(/\\/g, '/')}" ${url}`;

/**
 * Devuelve { settings, added } con los hooks de observe añadidos a `settings`
 * (no lo modifica). Si un hook igual ya existe en ese evento, no lo repite.
 */
export function installHooks(settings, { url, scriptPath }) {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  const added = [];
  const ensure = (event, hook, label) => {
    const groups = (out.hooks[event] ??= []);
    const exists = groups.some((g) => (g.hooks ?? []).some((h) => (hook.type === 'http' ? isOurHttp(h, url) : isOurCommand(h))));
    if (exists) return;
    groups.push(TOOL_HOOKS.has(event) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] });
    added.push(`${event}: ${label}`);
  };
  for (const ev of EVENT_HOOKS) ensure(ev, { type: 'http', url: url + '/api/hooks', timeout: 2 }, 'eventos (http)');
  for (const ev of TOKEN_HOOKS) ensure(ev, { type: 'command', command: tokenCommand(scriptPath, url), timeout: 10 }, 'tokens (command)');
  return { settings: out, added };
}

/** Devuelve { settings, removed } sin los hooks de observe (y sin grupos o eventos que queden vacíos). */
export function uninstallHooks(settings, { url }) {
  const out = structuredClone(settings ?? {});
  const removed = [];
  for (const [event, groups] of Object.entries(out.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      const hooks = (g.hooks ?? []).filter((h) => {
        if (!isOurs(h, url)) return true;
        removed.push(`${event}: ${h.type === 'http' ? 'eventos (http)' : 'tokens (command)'}`);
        return false;
      });
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  if (out.hooks && !Object.keys(out.hooks).length) delete out.hooks;
  return { settings: out, removed };
}

function main() {
  const [action] = process.argv.slice(2);
  const flag = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null; };
  const dryRun = process.argv.includes('--dry-run');
  const url = (flag('url') || process.env.OBSERVE_URL || 'http://127.0.0.1:4982').replace(/\/$/, '');
  if (!['install', 'uninstall'].includes(action) || !/^https?:\/\/[^\s"]+$/.test(url)) {
    console.error('Uso: node scripts/hooks.mjs install|uninstall [--dry-run] [--url http://127.0.0.1:4982]');
    process.exit(2);
  }

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settingsFile = path.join(configDir, 'settings.json');
  const scriptPath = path.join(configDir, 'hooks', SCRIPT_NAME);

  // Se lee una sola vez y con ese mismo texto se hace la copia de seguridad,
  // sin comprobar antes si existe (evita carreras con otro proceso).
  let raw = null;
  let settings = {};
  try {
    raw = fs.readFileSync(settingsFile, 'utf8');
    settings = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`No se puede leer ${settingsFile} (${err.message}). No se ha cambiado nada.`);
      process.exit(1);
    }
  }

  const result = action === 'install' ? installHooks(settings, { url, scriptPath }) : uninstallHooks(settings, { url });
  const changes = action === 'install' ? result.added : result.removed;
  console.log(`${settingsFile}`);
  console.log(changes.length ? changes.map((c) => `  ${action === 'install' ? '+' : '-'} ${c}`).join('\n') : '  (sin cambios: ya estaba así)');
  if (dryRun) { console.log('\n--dry-run: no se ha escrito nada.'); return; }

  if (action === 'install') {
    // El script se copia: el hook sigue funcionando aunque muevas o borres el repo.
    const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'observe-tokens.mjs');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.copyFileSync(source, scriptPath);
    console.log(`  script de tokens → ${scriptPath}`);
  } else {
    try {
      fs.unlinkSync(scriptPath);
      console.log(`  script de tokens borrado de ${scriptPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  if (changes.length) {
    fs.mkdirSync(configDir, { recursive: true });
    if (raw !== null) {
      // Nunca se pisa una copia anterior: si el nombre ya existe, se numera.
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
      for (let n = 0; ; n++) {
        const backup = `${settingsFile}.bak-${stamp}${n ? '-' + n : ''}`;
        try {
          fs.writeFileSync(backup, raw, { flag: 'wx' });
          console.log(`  copia de seguridad → ${backup}`);
          break;
        } catch (err) {
          if (err.code !== 'EEXIST' || n > 100) throw err;
        }
      }
    }
    // Escritura atómica: un temporal que sustituye al original.
    const tmp = `${settingsFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(result.settings, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(tmp, settingsFile);
  }
  console.log(action === 'install'
    ? '\nListo. Las sesiones nuevas de Claude Code ya envían eventos; los tokens llegan al terminar cada turno (necesita Node en el equipo).'
    : '\nListo. Las sesiones nuevas de Claude Code ya no envían nada a observe.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
