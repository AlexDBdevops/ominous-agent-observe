import { COLORS, NO_TOKENS, rowColor, buildRows, buildLanes, packDots, summarizeSession, layoutTree, formatDuration, formatTokens, inputTotal, newInput } from './derive.js';

// Iconos lucide de la maqueta (rocket, file-text, zap, wrench, book-open, file-pen).
const ICONS = {
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8M16 17H8M10 9H8"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  pen: '<path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M13.4 15.6a1 1 0 1 0-3-3l-5 5a2 2 0 0 0-.5.85l-.84 2.87a.5.5 0 0 0 .62.62l2.87-.84a2 2 0 0 0 .85-.5z"/>',
};
const icon = (name, size, sw) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.wrench}</svg>`;

const RANGES = [['1m', 60e3], ['5m', 300e3], ['10m', 600e3], ['60m', 3600e3], ['3h', 10800e3], ['24h', 86400e3]];
const FILTERS = [
  ['all', 'Todo', ''],
  ['bash', 'Bash', COLORS.bash],
  ['edit', 'Edit', COLORS.edit],
  ['read', 'Read', COLORS.read],
  ['config', 'Config', COLORS.config],
  ['session', 'Sesión', COLORS.session],
  ['tool', 'Otras', COLORS.tool],
];
const LIVE_MS = 5 * 60 * 1000;

const state = {
  sessions: [],
  selected: null,
  events: [],
  tokens: NO_TOKENS, // los envía el hook de tokens tras cada herramienta
  serverOffset: 0, // reloj del servidor - reloj local
  range: load('range', '24h'),
  filter: 'all',
  search: '',
  open: new Map(), // id de fila → pestaña abierta ('cmd' | 'out')
  collapsed: new Set(JSON.parse(load('collapsed', '[]'))),
  agent: null, // filtro por agente (clic en un carril de actividad)
  act: null, // datos de la última actividad pintada (para repintarla al redimensionar)
  hasRunning: false, // hay alguna herramienta en curso (activa el refresco por segundo)
  summary: null, // resumen de la sesión abierta (cabecera y duración)
  actMode: initialActMode(), // 'auto' | 'open' | 'closed'
  actIsOpen: false,
  actHeight: Number(load('actHeight', '240')) || 240,
  onlyActive: load('onlyActive', '0') === '1', // portada: solo subagentes en marcha
};

// ?actividad=desplegada|plegada|auto en la URL manda sobre lo guardado.
function initialActMode() {
  const fromUrl = { desplegada: 'open', plegada: 'closed', auto: 'auto' }[new URLSearchParams(location.search).get('actividad')];
  if (fromUrl) return fromUrl;
  const saved = load('actMode', 'auto');
  return ['auto', 'open', 'closed'].includes(saved) ? saved : 'auto';
}

const isLive = (s) => !s.ended && now() - s.lastTs < LIVE_MS;

function load(k, d) { try { return localStorage.getItem('observe.' + k) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem('observe.' + k, v); } catch {} }
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + state.serverOffset;
const hhmmss = (ts) => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function refreshSessions() {
  const data = await getJson('/api/sessions');
  state.serverOffset = data.now - Date.now();
  state.sessions = data.sessions;
  // Sin sesión en la URL se ve la portada (el árbol de todos los proyectos).
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash && fromHash !== state.selected && state.sessions.some((s) => s.id === fromHash)) {
    await select(fromHash, false);
    return;
  }
  if (state.selected) renderSidebar(); else render();
}

async function select(id, manual = true) {
  if (manual) history.pushState(null, '', '#' + encodeURIComponent(id));
  state.selected = id;
  state.agent = null;
  state.open.clear();
  // Vacío al momento: lo que llegue por el stream mientras se pide la
  // instantánea se guarda aquí y se fusiona después, sin perderse.
  state.events = [];
  await loadEvents(id);
}

// Pide los eventos de la sesión y los fusiona con los ya recibidos en vivo.
async function loadEvents(id) {
  const data = await getJson(`/api/sessions/${encodeURIComponent(id)}/events`);
  if (state.selected !== id) return;
  const ids = new Set(data.events.map((e) => e.id));
  state.events = data.events.concat(state.events.filter((e) => !ids.has(e.id)));
  state.tokens = data.tokens ?? NO_TOKENS;
  render();
}

function goHome(push = true) {
  if (push) history.pushState(null, '', location.pathname + location.search);
  state.selected = null;
  state.events = [];
  state.tokens = NO_TOKENS;
  state.summary = null;
  state.hasRunning = false;
  render();
}

// ---------- Sidebar ----------
function dayLabel(ts) {
  const d = new Date(ts); const today = new Date(now());
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400e3);
  if (diff === 0) return 'HOY';
  if (diff === 1) return 'AYER';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }).toUpperCase();
}

function renderSidebar() {
  const byProject = new Map();
  for (const s of state.sessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  if (byProject.size === 0) { $('tree').innerHTML = '<div class="day">SIN SESIONES</div>'; return; }
  let html = '';
  for (const [project, list] of byProject) {
    const open = !state.collapsed.has(project);
    html += `<button class="project ${open ? 'open' : ''}" data-project="${esc(project)}"><span class="caret">${open ? '▾' : '▸'}</span><span class="name">${esc(project)}</span><span class="n">${list.length}</span></button>`;
    if (!open) continue;
    let lastDay = '';
    for (const s of list) {
      const day = dayLabel(s.lastTs);
      if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; }
      const live = isLive(s);
      html += `<a class="session ${s.id === state.selected ? 'on' : ''} ${live ? '' : 'old'}" href="#${esc(encodeURIComponent(s.id))}" data-session="${esc(s.id)}">
        <span class="top"><span class="dot ${live ? 'live' : ''}"></span><span class="t" title="${esc(s.title)}">${esc(s.title)}</span><span class="n">${s.count}</span></span>
        <span class="h">${esc(s.hash)}</span></a>`;
    }
  }
  $('tree').innerHTML = html;
}

$('tree').addEventListener('click', (e) => {
  const proj = e.target.closest('[data-project]');
  if (proj) {
    const p = proj.dataset.project;
    state.collapsed.has(p) ? state.collapsed.delete(p) : state.collapsed.add(p);
    save('collapsed', JSON.stringify([...state.collapsed]));
    renderSidebar();
    return;
  }
  const s = e.target.closest('[data-session]');
  if (s) { e.preventDefault(); select(s.dataset.session); }
});

// ---------- Main ----------
function visibleRows(all, end) {
  const span = RANGES.find(([l]) => l === state.range)?.[1] ?? 86400e3;
  const q = state.search.trim().toLowerCase();
  const inRange = all.filter((r) => r.ts >= end - span);
  const shown = inRange.filter((r) =>
    (!state.agent || r.agentId === state.agent) &&
    (state.filter === 'all' || r.kind === state.filter) &&
    (!q || [r.tool, r.tag, r.label, r.command].some((v) => String(v).toLowerCase().includes(q))));
  return { inRange, shown, end, span };
}

function render() {
  renderSidebar();
  const home = !state.selected;
  $('main').classList.toggle('is-home', home);
  $('home').hidden = !home;
  if (home) return renderHome();
  const summary = state.selected ? summarizeSession(state.selected, state.events) : null;
  const all = buildRows(state.events, { now: now(), tokens: state.tokens.byTool });
  const running = all.filter((r) => r.running);
  state.hasRunning = running.length > 0;
  // Con algo en curso la ventana acaba "ahora"; si no, en el último evento.
  const end = state.hasRunning || !summary?.count ? now() : summary.lastTs;
  const { inRange, shown, span } = visibleRows(all, end);

  // Cabecera
  $('path').textContent = summary ? `${summary.project} / ${summary.cwd}` : '';
  $('title').textContent = summary ? summary.title : 'Esperando eventos…';
  $('hash').hidden = !summary;
  $('hash').textContent = summary?.hash ?? '';
  renderWatching();
  $('ranges').innerHTML = RANGES.map(([l]) => `<button class="${l === state.range ? 'on' : ''}" data-range="${l}">${l}</button>`).join('');

  // Resumen
  const errors = all.filter((r) => r.error).length;
  $('st-events').innerHTML = `${shown.length} <small>/ ${state.events.length} brutos</small>`;
  state.summary = summary;
  renderDuration();
  $('st-err').textContent = errors;
  $('st-err').classList.toggle('bad', errors > 0);
  const cur = running[running.length - 1];
  $('st-run').textContent = cur ? `${cur.tool}${cur.tag ? ' · ' + cur.tag : ''}` : '—';
  $('st-run').classList.toggle('running', !!cur);
  const tt = state.tokens.totals;
  $('st-tok').innerHTML = state.tokens.available && tt
    ? `${formatTokens(newInput(tt))} <small>· ${formatTokens(tt.output)} sal</small>`
    : '— <small>sin datos</small>';
  $('st-tok').title = state.tokens.available && tt
    ? `Nuevos: entrada ${formatTokens(newInput(tt))} (sin caché + caché escrita) · salida ${formatTokens(tt.output)}\nProcesados: ${tokenBreakdown(tt)}\n${tt.messages} mensajes del modelo; cada uno relee el contexto desde la caché`
    : 'Sin datos de tokens: llegan unos segundos después de cada herramienta si está instalado el hook (npm run hooks:install, ver README)';

  // Actividad (rango completo, todos los agentes, sin filtros de tipo)
  const t0 = end - span;
  const tlStart = inRange.length ? Math.max(t0, inRange[0].ts) : t0;
  state.act = { inRange, tlStart, tlSpan: Math.max(1, end - tlStart), end, live: state.hasRunning };
  renderActivity();

  // Filtros con conteo (respetan el agente elegido en la actividad)
  const agentRows = inRange.filter((r) => !state.agent || r.agentId === state.agent);
  const counts = { all: agentRows.length };
  for (const r of agentRows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  $('filters').innerHTML = FILTERS.filter(([k]) => k === 'all' || counts[k] || state.filter === k).map(([k, label, c]) =>
    `<button class="pill ${state.filter === k ? 'on' : ''}" data-filter="${k}">${c ? `<span class="dot" style="background:${c}"></span>` : ''}${label}<span class="c">${counts[k] ?? 0}</span></button>`).join('');

  // Tabla
  const maxDur = shown.reduce((m, r) => (!r.running && r.durationMs > m ? r.durationMs : m), 1);
  $('rows').innerHTML = shown.map((r) => rowHtml(r, maxDur)).join('');
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    empty.innerHTML = state.events.length
      ? 'Ningún evento coincide con el rango, el filtro o la búsqueda.'
      : 'Aún no ha llegado ningún evento. Apunta los hooks de Claude Code a <code>' + esc(location.origin) + '/api/hooks</code> (ver README).';
  }
}

// ---------- Portada ----------
// Como la portada de agent-observe: un círculo por proyecto con sus sesiones
// en el borde, las vivas en el centro y los subagentes como radios.
function renderHome() {
  const n = state.sessions.length;
  $('path').textContent = n ? `Todos los proyectos · ${n} ${n === 1 ? 'sesión' : 'sesiones'}` : '';
  $('title').textContent = 'Sesiones recientes';
  $('hash').hidden = true;
  renderWatching();
  if (!n) {
    $('home-tree').innerHTML = '<div class="empty">Aún no ha llegado ningún evento. Apunta los hooks de Claude Code a <code>' + esc(location.origin) + '/api/hooks</code> (ver README).</div>';
    return;
  }
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  $('only-active').classList.toggle('on', state.onlyActive);
  $('only-active').setAttribute('aria-pressed', String(state.onlyActive));
  // Solo activos: sesiones vivas con sus subagentes en marcha; los proyectos sin
  // nada vivo desaparecen. Un subagente de una sesión no viva cuenta como terminado.
  const sessions = !state.onlyActive ? state.sessions
    : state.sessions.filter(isLive).map((s) => ({ ...s, agents: s.agents.filter((a) => !a.done) }));
  if (!sessions.length) {
    $('home-tree').innerHTML = '<div class="empty">No hay nada en marcha ahora mismo.</div>';
    return;
  }
  const tree = layoutTree(sessions, isLive);
  const f = (v) => v.toFixed(1);
  const svg = tree.projects.map((p) => {
    const live = p.sessions.some((s) => s.live);
    const nodes = p.sessions.map((t) => {
      const s = byId.get(t.id);
      const spokes = t.agents.map((a) => `<line class="spoke" x1="${f(t.x)}" y1="${f(t.y)}" x2="${f(a.x)}" y2="${f(a.y)}"/><circle class="sub" cx="${f(a.x)}" cy="${f(a.y)}" r="3"/>`).join('');
      const label = t.live ? (s.title.length > 30 ? s.title.slice(0, 29) + '…' : s.title) : s.hash;
      const subs = s.agents.length;
      const active = t.live ? s.agents.filter((a) => !a.done).length : 0;
      const tip = `${s.title} · ${s.hash} · ${s.count} eventos${subs ? ` · ${subs} ${subs === 1 ? 'subagente' : 'subagentes'}${active ? ` (${active} en marcha)` : ''}` : ''}${t.live ? ' · viva' : ''}`;
      return `<g class="t-node ${t.live ? 'live' : ''}" data-session="${esc(t.id)}" tabindex="0" role="link" aria-label="${esc(tip)}">
        <title>${esc(tip)}</title>${spokes}
        ${t.live ? `<circle class="ring" cx="${f(t.x)}" cy="${f(t.y)}" r="13"/>` : ''}
        <circle class="dot" cx="${f(t.x)}" cy="${f(t.y)}" r="${t.live ? 13 : 9}"/>
        ${t.more ? `<text class="more" x="${f(t.x)}" y="${f(t.y + 3)}">+${t.more}</text>` : ''}
        <text class="lbl" x="${f(t.lx)}" y="${f(t.ly)}" text-anchor="${t.anchor}">${esc(label)}</text></g>`;
    }).join('');
    return `<g><circle class="t-project ${live ? 'has-live' : ''}" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(p.r)}"/>
      <text class="t-pname ${live ? 'has-live' : ''}" x="${f(p.x)}" y="${f(p.y - p.r - 30)}">${esc(p.name)}</text>
      <text class="t-pcount" x="${f(p.x)}" y="${f(p.y - p.r - 15)}">${p.sessions.length} ${p.sessions.length === 1 ? 'sesión' : 'sesiones'}</text>${nodes}</g>`;
  }).join('');
  $('home-tree').innerHTML = `<svg viewBox="0 0 ${f(tree.width)} ${f(tree.height)}" width="${f(tree.width)}" role="img" aria-label="Árbol de proyectos y sesiones">${svg}</svg>`;
}

document.querySelector('.brand').addEventListener('click', (e) => {
  e.preventDefault();
  if (state.selected) goHome();
});
$('only-active').addEventListener('click', () => {
  state.onlyActive = !state.onlyActive;
  save('onlyActive', state.onlyActive ? '1' : '0');
  renderHome();
});
$('home-tree').addEventListener('click', (e) => {
  const n = e.target.closest('[data-session]');
  if (n) select(n.dataset.session);
});
$('home-tree').addEventListener('keydown', (e) => {
  const n = e.target.closest('[data-session]');
  if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(n.dataset.session); }
});

// ---------- Actividad ----------
// Como en agent-observe: un carril por agente con sus iconos en el tiempo.
// Plegado: una fila por carril (los iconos pueden pisarse; se avisa).
// Desplegado: los iconos que coinciden se reparten en sub-filas.
const DOT = 22, PITCH = 26, PAD = 14, LANE_H = 34;

// Modo 'auto' (por defecto): se despliega sola en cuanto hay iconos que se
// pisan y se pliega cuando dejan de pisarse. 'open'/'closed': lo fija el usuario.
function renderActivity() {
  const a = state.act;
  const box = $('activity');
  $('act-body').style.maxHeight = state.actHeight + 'px';
  $('act-resize').hidden = false;
  if (!a || !state.selected) {
    $('lanes').innerHTML = ''; $('axis').innerHTML = ''; $('act-info').textContent = '';
    setActControls(state.actMode === 'open');
    return;
  }

  const labelW = parseFloat(getComputedStyle(box).getPropertyValue('--label-w')) || 150;
  const trackW = Math.max(80, $('act-body').clientWidth - labelW - 1);
  const xOf = (ts) => PAD + ((ts - a.tlStart) / a.tlSpan) * (trackW - 2 * PAD);
  const grid = [0, 1 / 3, 2 / 3, 1].map((f) => `<span class="grid-line" style="left:${(PAD + f * (trackW - 2 * PAD)).toFixed(1)}px"></span>`).join('');

  const lanes = buildLanes(state.selected, state.events).map((lane) => {
    const rows = a.inRange.filter((r) => r.agentId === lane.id);
    const xs = rows.map((r) => xOf(r.ts));
    return { lane, rows, xs, pack: packDots(xs, DOT + 2) };
  });
  // Iconos que en una sola fila quedarían tapados por otro.
  const hidden = lanes.reduce((n, l) => n + l.pack.slot.filter((s) => s > 0).length, 0);
  const open = state.actMode === 'auto' ? hidden > 0 : state.actMode === 'open';
  setActControls(open);

  const html = lanes.map(({ lane, rows, xs, pack }) => {
    const h = open ? pack.rows * PITCH + 8 : LANE_H;
    const dots = rows.map((r, i) => {
      const top = open ? 4 + pack.slot[i] * PITCH + (PITCH - DOT) / 2 : (LANE_H - DOT) / 2;
      const color = rowColor(r);
      return `<button class="tick ${r.running ? 'running' : ''}" style="left:${xs[i].toFixed(1)}px;top:${top}px;background:${color}" data-row="${r.id}" title="${esc(hhmmss(r.ts) + ' · ' + r.tool + ' · ' + r.label)}">${icon(r.icon, 12, 2.4)}</button>`;
    }).join('');
    const on = state.agent === lane.id;
    return `<div class="lane" style="height:${h}px">
      <button class="lane-label ${lane.main ? 'is-main' : ''} ${on ? 'on' : ''}" data-agent="${esc(lane.id)}" title="${on ? 'Quitar filtro de agente' : 'Ver solo este agente en la tabla'}">
        ${lane.main ? '' : '<span>↳</span>'}<span class="nm">${esc(lane.name)}</span><span class="n">${rows.length}</span></button>
      <div class="track">${grid}${dots}</div></div>`;
  }).join('');
  $('lanes').innerHTML = html;

  const n = a.inRange.length;
  $('act-info').innerHTML = `${lanes.length} ${lanes.length === 1 ? 'agente' : 'agentes'} · ${n} eventos` +
    (!open && hidden > 0 ? ` · <span class="warn">${hidden} solapados</span>` : '');
  const marks = [0, 1 / 3, 2 / 3].map((f) => hhmmss(a.tlStart + f * a.tlSpan));
  marks.push(a.live ? 'ahora' : hhmmss(a.end));
  $('axis').innerHTML = marks.map((m) => `<span>${m}</span>`).join('');
}

function setActControls(open) {
  state.actIsOpen = open;
  $('activity').classList.toggle('open', open);
  $('act-toggle').setAttribute('aria-expanded', String(open));
  $('act-toggle').querySelector('span').textContent = open ? 'Plegar' : 'Desplegar';
  const auto = $('act-auto');
  auto.classList.toggle('on', state.actMode === 'auto');
  auto.title = state.actMode === 'auto'
    ? 'Automático: se despliega sola cuando los iconos se pisan'
    : 'Volver al modo automático';
}

function setActMode(mode) {
  state.actMode = mode;
  save('actMode', mode);
  renderActivity();
}

$('act-toggle').addEventListener('click', () => setActMode(state.actIsOpen ? 'closed' : 'open'));
$('act-auto').addEventListener('click', () => setActMode('auto'));

$('lanes').addEventListener('click', (e) => {
  const lane = e.target.closest('[data-agent]');
  if (lane) { state.agent = state.agent === lane.dataset.agent ? null : lane.dataset.agent; render(); return; }
  const b = e.target.closest('[data-row]');
  if (!b) return;
  const id = Number(b.dataset.row);
  state.filter = 'all'; state.open.set(id, 'cmd'); render();
  $('row-' + id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

// Arrastrar el borde inferior cambia el alto máximo del panel (como el original).
$('act-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const handle = e.currentTarget;
  const startY = e.clientY, startH = state.actHeight;
  handle.classList.add('drag');
  const move = (ev) => {
    state.actHeight = Math.max(40, Math.min(window.innerHeight * 0.8, startH + ev.clientY - startY));
    $('act-body').style.maxHeight = state.actHeight + 'px';
  };
  const up = () => {
    handle.classList.remove('drag');
    save('actHeight', String(Math.round(state.actHeight)));
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

new ResizeObserver(() => renderActivity()).observe($('act-body'));

function renderDuration() {
  const s = state.summary;
  $('st-dur').textContent = !s?.count ? '—' : formatDuration((state.hasRunning ? now() : s.lastTs) - s.firstTs);
}

function renderWatching() {
  const liveAgents = state.sessions.filter(isLive).length;
  $('watching').classList.toggle('idle', liveAgents === 0);
  $('watching-text').textContent = `Vigilando · ${liveAgents} ${liveAgents === 1 ? 'agente' : 'agentes'}`;
}

// Tokens del mensaje del modelo que lanzó la herramienta. Si ese mensaje
// lanzó varias en paralelo, los comparten (se marca con ≈).
function tokenCell(r) {
  const t = r.tokens;
  if (!t) return `<span class="tok none" title="${r.isTool ? 'Aún sin tokens (llegan unos segundos después de la herramienta)' : 'Solo las herramientas tienen tokens'}">—</span>`;
  const title = tokenBreakdown(t) + (t.shared > 1 ? ` · mensaje compartido por ${t.shared} herramientas` : '');
  return `<span class="tok" title="${esc(title)}">${t.shared > 1 ? '<span class="shared">≈</span>' : ''}<span class="tin">${formatTokens(inputTotal(t))}</span><span class="sep">·</span><span class="tout">${formatTokens(t.output)}</span></span>`;
}

// Desglose único de tokens (tooltips y fila expandida).
function tokenBreakdown(t) {
  return `Entrada ${formatTokens(inputTotal(t))} (sin caché ${formatTokens(t.input)} · caché leída ${formatTokens(t.cacheRead)} · caché escrita ${formatTokens(t.cacheWrite)}) · salida ${formatTokens(t.output)}`;
}

// Los tokens los envía el hook del equipo tras cada herramienta; el servidor
// avisa por el stream y aquí se piden los de la sesión abierta.
async function refreshTokens(id) {
  try {
    const t = await getJson(`/api/sessions/${encodeURIComponent(id)}/tokens`);
    if (state.selected === id) { state.tokens = t; scheduleRender(); }
  } catch (err) { console.error(err); }
}

function rowHtml(r, maxDur) {
  const color = COLORS[r.kind];
  const tab = state.open.get(r.id);
  const pct = r.running ? 100 : r.durationMs ? Math.min(100, (r.durationMs / maxDur) * 100) : 0;
  const barColor = rowColor(r);
  const dur = r.running ? 'en curso' : r.durationMs == null ? '—' : (r.estimated ? '~' : '') + formatDuration(r.durationMs);
  const cls = ['row', r.running && 'running', r.error && 'error', tab && 'open'].filter(Boolean).join(' ');
  let expand = '';
  if (tab) {
    const hasCmd = !!r.command;
    const view = hasCmd && tab === 'cmd' ? r.command : r.output || '(sin salida registrada)';
    expand = `<div class="expand">
      <div class="bar-top">
        ${hasCmd ? `<button class="${tab === 'cmd' ? 'on' : ''}" data-tab="cmd" data-row="${r.id}">comando</button>` : ''}
        <button class="${tab === 'out' || !hasCmd ? 'on' : ''}" data-tab="out" data-row="${r.id}">${r.isTool ? 'salida' : 'payload'}</button>
        ${r.tokens ? `<span class="tokd">${esc(tokenBreakdown(r.tokens))}${r.tokens.shared > 1 ? ` · compartidos con ${r.tokens.shared - 1} más` : ''}</span>` : ''}
        <span class="exit">${esc(r.running ? 'en curso' : r.exit)}</span>
      </div>
      <pre>${esc(view)}</pre></div>`;
  }
  return `<div class="${cls}" id="row-${r.id}">
    <div class="line grid" data-toggle="${r.id}">
      <span class="time">${hhmmss(r.ts)}</span>
      <span class="tool"><span class="ico" style="color:${r.running ? COLORS.running : color}">${icon(r.icon, 16, 2)}</span><span class="tname" style="color:${color}">${esc(r.tool)}</span></span>
      <span class="detail">${r.tag ? `<span class="chip">${esc(r.tag)}</span>` : ''}<span class="label" title="${esc(r.label)}">${esc(r.label)}</span></span>
      ${tokenCell(r)}
      <span class="dur"><span class="bar"><span style="width:${pct}%;background:${barColor};opacity:${r.running ? 1 : 0.7}"></span></span><span class="dtext">${esc(dur)}</span></span>
    </div>${expand}</div>`;
}

// ---------- Interacción ----------
$('ranges').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  state.range = b.dataset.range; save('range', state.range); render();
});
$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.filter = b.dataset.filter; render();
});
$('search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
$('rows').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) { state.open.set(Number(t.dataset.row), t.dataset.tab); render(); return; }
  const line = e.target.closest('[data-toggle]');
  if (!line) return;
  const id = Number(line.dataset.toggle);
  state.open.has(id) ? state.open.delete(id) : state.open.set(id, 'cmd');
  render();
});
$('export').addEventListener('click', () => {
  if (state.selected) location.href = `/api/sessions/${encodeURIComponent(state.selected)}/events?download=1`;
});
// Enlaces (#id), el logo (#) y los botones atrás/adelante del navegador.
function fromLocation() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) { if (state.selected) goHome(false); }
  else if (id !== state.selected) select(id, false);
}
window.addEventListener('hashchange', fromLocation);
window.addEventListener('popstate', fromLocation);

// ---------- Vivo ----------
let sessionsTimer = null;
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('hook', (msg) => {
    const ev = JSON.parse(msg.data);
    // Puede llegar también en la instantánea de loadEvents: no se duplica.
    if (ev.sessionId === state.selected && !state.events.some((e) => e.id === ev.id)) {
      state.events.push(ev);
      scheduleRender();
    }
    clearTimeout(sessionsTimer);
    sessionsTimer = setTimeout(() => refreshSessions().catch(console.error), 300);
  });
  es.addEventListener('tokens', (msg) => {
    const { sessionId } = JSON.parse(msg.data);
    if (sessionId === state.selected) refreshTokens(sessionId);
  });
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  // Al (re)conectar se recarga todo: lo que pasó con el stream caído no llegó.
  es.onopen = () => {
    refreshSessions().catch(console.error);
    if (state.selected) loadEvents(state.selected).catch(console.error);
  };
}

// Ráfagas de eventos: un solo repintado por fotograma.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// Cada segundo, con algo en curso, solo cambia la duración total; la vista
// completa se repinta cada 15 s (no se pierde la selección en filas abiertas).
let ticks = 0;
setInterval(() => {
  ticks++;
  if (ticks % 15 === 0) render();
  else if (state.hasRunning) renderDuration();
}, 1000);

refreshSessions().catch(console.error);
connect();
