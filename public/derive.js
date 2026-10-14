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
  // Solo rutas en texto (eventos antiguos o externos pueden traer otra cosa).
  const textCwd = (e) => [e.cwd, e.payload?.cwd].find((c) => typeof c === 'string' && c) ?? '';
  const cwd = sorted.map(textCwd).find(Boolean) ?? '';
  // La raíz ('/', 'C:\') no tiene carpeta final: se usa la ruta tal cual.
  const project = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : 'sin proyecto';
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
    // Subagentes que lanzó (para el árbol de la portada).
    agents: buildLanes(sessionId, sorted).filter((l) => !l.main).map(({ id, name }) => ({ id, name })),
  };
}

// Árbol de la portada: medidas en unidades del viewBox del SVG.
const TREE = { spoke: 22, maxSpokes: 10, gap: 170, minR: 120, perSession: 64, label: 14 };

/**
 * Coloca proyectos, sesiones y subagentes para el árbol de la portada.
 * Cada proyecto es un círculo; sus sesiones van en el borde y las vivas en el
 * centro. Los círculos se empaquetan sin solaparse, el mayor en el medio.
 * Las etiquetas del borde van hacia fuera del círculo (lx, ly, anchor).
 * Devuelve { width, height, projects: [{ name, x, y, r, sessions: [{ id, x, y, live, agents: [{ x, y }], more, lx, ly, anchor }] }] }.
 */
export function layoutTree(sessions, isLive) {
  if (!sessions.length) return { width: 0, height: 0, projects: [] };
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.project)) groups.set(s.project, []);
    groups.get(s.project).push(s);
  }
  const circles = [...groups].map(([name, list]) => {
    const edge = list.filter((s) => !isLive(s));
    // Perímetro suficiente para que las sesiones del borde no se pisen.
    const r = Math.max(TREE.minR, (edge.length * TREE.perSession) / (2 * Math.PI) + TREE.spoke);
    return { name, r, list, edge, live: list.filter(isLive), x: 0, y: 0 };
  }).sort((a, b) => b.r - a.r || a.name.localeCompare(b.name));

  // Cada círculo, tangente a uno ya colocado, en el hueco libre más cercano al
  // centro. La distancia horizontal cuenta menos: las pantallas son apaisadas.
  const cost = (x, y) => Math.hypot(x * 0.55, y);
  const placed = [];
  for (const c of circles) {
    let best = placed.length ? null : { x: 0, y: 0 };
    for (const p of placed) {
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * 2 * Math.PI;
        const d = p.r + c.r + TREE.gap;
        const x = p.x + d * Math.cos(a), y = p.y + d * Math.sin(a);
        if (placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.r + c.r + TREE.gap - 0.5)) continue;
        if (!best || cost(x, y) < cost(best.x, best.y)) best = { x, y };
      }
    }
    Object.assign(c, best);
    placed.push(c);
  }

  // Margen para radios, etiquetas y el nombre del proyecto encima.
  const m = TREE.spoke + 70;
  const minX = Math.min(...placed.map((c) => c.x - c.r)) - m, maxX = Math.max(...placed.map((c) => c.x + c.r)) + m;
  const minY = Math.min(...placed.map((c) => c.y - c.r)) - m, maxY = Math.max(...placed.map((c) => c.y + c.r)) + m;

  const spokes = (s, x, y) => {
    const n = Math.min(s.agents?.length ?? 0, TREE.maxSpokes);
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * 2 * Math.PI - Math.PI / 2;
      return { x: x + TREE.spoke * Math.cos(a), y: y + TREE.spoke * Math.sin(a) };
    });
  };
  // a: ángulo hacia fuera del círculo (null = sesión viva: etiqueta debajo).
  const node = (s, x, y, live, a = null) => {
    const reach = (s.agents?.length ? TREE.spoke : 9) + TREE.label;
    const out = a ?? Math.PI / 2;
    const cos = Math.cos(out);
    return {
      id: s.id, x, y, live, agents: spokes(s, x, y),
      more: Math.max(0, (s.agents?.length ?? 0) - TREE.maxSpokes),
      lx: x + reach * cos, ly: y + reach * Math.sin(out) + 4,
      anchor: Math.abs(cos) < 0.35 ? 'middle' : cos > 0 ? 'start' : 'end',
    };
  };

  const projects = placed.map((c) => {
    const x = c.x - minX, y = c.y - minY;
    const sessions = [
      // Vivas en el centro (varias: en un anillo pequeño).
      ...c.live.map((s, i) => {
        if (c.live.length === 1) return node(s, x, y, true);
        const a = (i / c.live.length) * 2 * Math.PI - Math.PI / 2, rr = Math.min(c.r * 0.45, 18 * c.live.length);
        return node(s, x + rr * Math.cos(a), y + rr * Math.sin(a), true);
      }),
      // El resto en el borde, en el orden recibido (más recientes primero). Se
      // empieza medio paso después de arriba para no tapar el nombre del proyecto.
      ...c.edge.map((s, i) => {
        const a = ((i + 0.5) / c.edge.length) * 2 * Math.PI - Math.PI / 2;
        return node(s, x + c.r * Math.cos(a), y + c.r * Math.sin(a), false, a);
      }),
    ];
    return { name: c.name, x, y, r: c.r, sessions };
  });
  return { width: maxX - minX, height: maxY - minY, projects };
}
