// Lógica pura compartida entre servidor (tests) y navegador.
// Convierte eventos de hooks en filas de la tabla y resúmenes de sesión.

export const COLORS = {
  bash: '#3fe0ff',
  edit: '#ffb84d',
  read: '#8a9bab',
  tool: '#8a9bab',
  config: '#ff3fa4',
  session: '#ff3fa4',
  running: '#ffb84d',
};

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const CONFIG_HOOKS = new Set(['InstructionsLoaded', 'ConfigChange']);
const TOOL_START = 'PreToolUse';
const TOOL_END = new Set(['PostToolUse', 'PostToolUseFailure']);
// Fin de turno: cierran las herramientas sin Post del mismo agente. SessionEnd cierra todas.
const TURN_END = new Set(['Stop', 'UserPromptSubmit', 'SubagentStop']);
// Un Pre sin Post más viejo que esto deja de considerarse "en curso".
const RUNNING_MAX_MS = 15 * 60 * 1000;

export function classifyTool(name) {
  if (SHELL_TOOLS.has(name)) return { kind: 'bash', icon: 'zap' };
  if (EDIT_TOOLS.has(name)) return { kind: 'edit', icon: 'pen' };
  if (name === 'Read') return { kind: 'read', icon: 'book' };
  if (READ_TOOLS.has(name)) return { kind: 'read', icon: 'wrench' };
  return { kind: 'tool', icon: 'wrench' };
}

const SKIP_WORDS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', '&']);

// Primer comando "real" de una línea de shell: `cd x && git status` → git.
export function subcommand(cmd) {
  if (typeof cmd !== 'string') return '';
  const parts = cmd.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
  const pick = parts.find((p) => !/^cd(\s|$)/.test(p)) ?? parts[0] ?? '';
  for (const raw of pick.split(/\s+/)) {
    const w = raw.replace(/^["'(]+|["')]+$/g, '');
    if (!w || SKIP_WORDS.has(w) || /^[A-Z_][A-Z0-9_]*=/.test(w)) continue;
    const base = w.split(/[\\/]/).pop();
    return base.replace(/\.exe$/i, '').slice(0, 24);
  }
  return '';
}

function shortPath(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}

function toolLabel(kind, input = {}) {
  if (kind === 'bash') return input.description || input.command || '';
  if (input.file_path || input.notebook_path) return shortPath(input.file_path || input.notebook_path);
  if (input.pattern) return input.pattern + (input.path ? '  ' + shortPath(input.path) : '');
  if (input.query) return input.query;
  if (input.description) return input.description;
  if (input.prompt) return input.prompt;
  if (input.url) return input.url;
  const first = Object.values(input).find((v) => typeof v === 'string');
  return first ?? '';
}

function responseText(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp.stdout === 'string' || typeof resp.stderr === 'string') {
    return [resp.stdout, resp.stderr].filter(Boolean).join('\n');
  }
  if (typeof resp.content === 'string') return resp.content;
  if (resp.file && typeof resp.file.content === 'string') return resp.file.content;
  return JSON.stringify(resp, null, 2);
}

function summarizeOutput(text, maxLines = 12) {
  const lines = String(text).split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} líneas más)`;
}

function isFailure(end) {
  if (!end) return false;
  if (end.hookName === 'PostToolUseFailure') return true;
  const r = end.payload?.tool_response;
  return !!(r && typeof r === 'object' && (r.is_error || r.interrupted));
}

function exitInfo(end) {
  if (!end) return '';
  const r = end.payload?.tool_response;
  if (r && typeof r === 'object') {
    const code = r.exit_code ?? r.exitCode ?? r.returnCode;
    if (code !== undefined) return `exit ${code}`;
    if (r.interrupted) return 'interrumpido';
  }
  return isFailure(end) ? 'error' : 'ok';
}

/** 950 → "950", 12400 → "12.4k", 1234567 → "1.23M". */
export function formatTokens(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

/** Entrada total de un mensaje: sin caché + leída de caché + escrita en caché. */
export const inputTotal = (t) => (t ? t.input + t.cacheRead + t.cacheWrite : 0);

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Filas de la tabla a partir de los eventos crudos de una sesión.
 * Los PreToolUse/PostToolUse se emparejan por tool_use_id (o, si falta, por
 * orden y nombre de herramienta). Sin fin real, la duración se estima con el
 * siguiente evento.
 */
export function buildRows(events, { now = Date.now(), tokens = null } = {}) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const rows = [];
  let open = []; // herramientas con Pre y sin Post todavía

  // Sin Post y con el turno terminado: duración estimada hasta el evento siguiente.
  const closeEstimated = (r) => {
    if (r.nextTs != null) { r.durationMs = r.nextTs - r.ts; r.estimated = true; }
  };

  sorted.forEach((ev, i) => {
    const p = ev.payload ?? {};
    const hook = ev.hookName;
    const agent = ev.agentId ?? ev.sessionId;

    // Fin de turno: cierra las abiertas de ese agente (SessionEnd, todas).
    if (hook === 'SessionEnd' || TURN_END.has(hook)) {
      open = open.filter((r) => {
        if (hook !== 'SessionEnd' && r.agentId !== agent) return true;
        closeEstimated(r);
        return false;
      });
    }

    if (hook === TOOL_START) {
      const row = makeToolRow(ev);
      row.nextTs = sorted[i + 1]?.ts ?? null;
      rows.push(row);
      open.push(row);
      return;
    }

    if (TOOL_END.has(hook)) {
      const at = open.findIndex((r) => (p.tool_use_id ? r.toolUseId === p.tool_use_id : r.tool === p.tool_name));
      // Post sin Pre (p. ej. hook Pre no configurado): fila con lo que hay.
      const row = at === -1 ? makeToolRow(ev) : open.splice(at, 1)[0];
      if (at === -1) rows.push(row);
      attachEnd(row, ev);
      return;
    }

    if (hook === 'SessionStart' || hook === 'SessionEnd') {
      rows.push(simpleRow(ev, 'Session', 'session', 'rocket',
        hook === 'SessionStart' ? `Inicio de sesión${p.source ? ' · ' + p.source : ''}` : `Fin de sesión${p.reason ? ' · ' + p.reason : ''}`));
      return;
    }

    if (hook === 'SubagentStart' || hook === 'SubagentStop') {
      const who = p.agent_type || String(p.agent_id ?? '').slice(0, 8) || 'subagente';
      rows.push(simpleRow(ev, 'Subagente', 'session', 'rocket',
        `${hook === 'SubagentStart' ? 'Inicio' : 'Fin'} · ${who}`));
      return;
    }

    if (CONFIG_HOOKS.has(hook)) {
      const file = p.file_path || p.path || p.source || '';
      rows.push(simpleRow(ev, 'Config', 'config', 'file', shortPath(file) || hook));
    }
  });

  // Las que siguen abiertas están en curso, salvo que sean demasiado viejas.
  for (const r of open) {
    if (now - r.ts < RUNNING_MAX_MS) { r.running = true; r.durationMs = now - r.ts; } else closeEstimated(r);
  }

  // Tokens del mensaje del modelo que lanzó cada herramienta (del transcript).
  if (tokens) for (const r of rows) if (r.toolUseId && tokens[r.toolUseId]) r.tokens = tokens[r.toolUseId];

  return rows;
}

// Campos comunes a todas las filas; cada tipo sobrescribe lo que cambia.
function baseRow(ev) {
  return {
    id: ev.id, ts: ev.ts, agentId: ev.agentId ?? ev.sessionId, toolUseId: null, tokens: null,
    isTool: false, tool: '', kind: 'tool', icon: 'wrench', tag: '', label: '',
    command: '', output: '', exit: '', error: false, running: false, estimated: false,
    durationMs: null, end: null, nextTs: null,
  };
}

function makeToolRow(ev) {
  const p = ev.payload ?? {};
  const name = p.tool_name || 'Tool';
  const input = p.tool_input ?? {};
  const { kind, icon } = classifyTool(name);
  return {
    ...baseRow(ev),
    toolUseId: p.tool_use_id ?? null,
    isTool: true,
    tool: name,
    kind,
    icon,
    tag: kind === 'bash' ? subcommand(input.command) : '',
    label: String(toolLabel(kind, input)).split('\n')[0],
    command: input.command ? '$ ' + input.command : JSON.stringify(input, null, 2),
  };
}

function attachEnd(row, ev) {
  const p = ev.payload ?? {};
  row.end = ev.ts;
  // Claude Code manda duration_ms en el Post: es la duración real de la
  // herramienta. Sin él, la distancia al Pre (o nada si no hubo Pre).
  row.durationMs = typeof p.duration_ms === 'number' ? p.duration_ms : row.id === ev.id ? null : ev.ts - row.ts;
  row.error = isFailure(ev);
  row.exit = exitInfo(ev);
  row.output = summarizeOutput(p.error ?? responseText(p.tool_response));
}

function simpleRow(ev, tool, kind, icon, label) {
  return { ...baseRow(ev), tool, kind, icon, label, output: JSON.stringify(ev.payload ?? {}, null, 2) };
}

/** Color de una fila (icono de actividad y barra de duración). */
export function rowColor(r) {
  return r.running ? COLORS.running : r.error ? COLORS.config : COLORS[r.kind];
}

/** Resultado de tokens vacío (sin transcript disponible). */
export const NO_TOKENS = Object.freeze({ available: false, byTool: {}, totals: null });

/**
 * Carriles de la línea de actividad: uno por agente (principal primero,
 * luego subagentes por orden de aparición).
 */
export function buildLanes(sessionId, events) {
  const lanes = new Map();
  for (const ev of [...events].sort((a, b) => a.ts - b.ts)) {
    const id = ev.agentId ?? sessionId;
    if (!lanes.has(id)) lanes.set(id, { id, main: id === sessionId, name: '', firstTs: ev.ts });
    const lane = lanes.get(id);
    if (!lane.name && ev.payload?.agent_type) lane.name = ev.payload.agent_type;
  }
  if (!lanes.has(sessionId)) lanes.set(sessionId, { id: sessionId, main: true, name: '', firstTs: 0 });
  return [...lanes.values()]
    .map((l) => ({ ...l, name: l.main ? 'principal' : l.name || l.id.slice(0, 8) }))
    .sort((a, b) => (b.main - a.main) || a.firstTs - b.firstTs);
}

/**
 * Reparte iconos en sub-filas para que no se solapen: cada icono va a la
 * primera fila cuyo último icono queda al menos `minGap` px a la izquierda.
 * Recibe posiciones x en px ya ordenadas o no; devuelve { rows, slot[] }.
 */
export function packDots(xs, minGap) {
  const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const lastX = [];
  const slot = new Array(xs.length);
  for (const [x, i] of order) {
    let r = lastX.findIndex((lx) => x - lx >= minGap);
    if (r === -1) { r = lastX.length; lastX.push(x); } else lastX[r] = x;
    slot[i] = r;
  }
  return { rows: Math.max(1, lastX.length), slot };
}

function lastIndexOf(events, hookName) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].hookName === hookName) return i;
  return -1;
}

/** Resumen de una sesión para la barra lateral y la cabecera. */
export function summarizeSession(sessionId, events) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  // El título es el primer prompt escrito por la persona: los avisos automáticos
  // que llegan como prompt (<task-notification>…) empiezan por una etiqueta.
  const firstPrompt = sorted.find((e) => e.hookName === 'UserPromptSubmit' &&
    typeof e.payload?.prompt === 'string' && e.payload.prompt.trim() && !e.payload.prompt.trimStart().startsWith('<'));
  const withCwd = sorted.find((e) => e.cwd || e.payload?.cwd);
  const cwd = withCwd ? withCwd.cwd || withCwd.payload.cwd : '';
  const project = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : 'sin proyecto';
  const title = firstPrompt
    ? firstPrompt.payload.prompt.replace(/\s+/g, ' ').trim().slice(0, 80)
    : 'Sesión sin prompt';
  return {
    id: sessionId,
    hash: String(sessionId).slice(0, 8),
    title,
    cwd,
    project,
    count: sorted.length,
    firstTs: sorted[0]?.ts ?? 0,
    lastTs: sorted[sorted.length - 1]?.ts ?? 0,
    // Una sesión reanudada (SessionStart después del SessionEnd) vuelve a estar viva.
    ended: lastIndexOf(sorted, 'SessionEnd') > lastIndexOf(sorted, 'SessionStart'),
  };
}
