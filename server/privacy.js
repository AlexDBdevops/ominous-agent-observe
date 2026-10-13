// Qué se guarda de cada evento. Los hooks mandan el payload entero (salidas
// completas, contenido de ficheros, la última respuesta del modelo…); por
// defecto solo se conserva lo que la vista enseña, recortado y con los
// secretos tapados. OBSERVE_DETAIL=completo guarda el payload tal cual.

const HIDDEN = '[oculto]';

// Patrones de secretos habituales. Mejor tapar de más que guardar una clave.
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, HIDDEN],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, HIDDEN],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, HIDDEN],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, HIDDEN],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN], // JWT
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, `$1${HIDDEN}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${HIDDEN}@`], // usuario:clave@ en URLs
  [/(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*[=:]\s*["']?)[^\s"'&,;]{4,}/gi, `$1${HIDDEN}`],
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [re, rep] of SECRETS) out = out.replace(re, rep);
  return out;
}

// Primeras `maxLines` líneas y como mucho `maxChars` caracteres.
export function clip(text, maxChars, maxLines = 12) {
  if (typeof text !== 'string') return text;
  const lines = text.split('\n');
  let out = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} líneas más)` : text;
  if (out.length > maxChars) out = out.slice(0, maxChars) + `… [+${out.length - maxChars} car.]`;
  return out;
}

const keep = (text, maxChars, maxLines) => (typeof text === 'string' ? clip(redact(text), maxChars, maxLines) : undefined);

// Campos del payload que usa la vista (además de tool_input y tool_response).
const PLAIN = ['tool_name', 'tool_use_id', 'duration_ms', 'agent_id', 'agent_type', 'source', 'reason', 'model', 'file_path', 'path', 'memory_type', 'load_reason'];
// Entradas de herramientas que son contenido de ficheros: nunca se guardan.
const CONTENT_KEYS = new Set(['content', 'old_string', 'new_string', 'new_source', 'file_text', 'edits', 'old_str', 'new_str']);

// Las claves de tool_input llegan de fuera: solo nombres de campo normales
// (nada de __proto__ ni constructor) y como mucho 40.
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(['constructor', 'prototype']);

function minimizeInput(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = new Map();
  for (const [k, v] of Object.entries(input).slice(0, 40)) {
    if (!KEY_RE.test(k) || RESERVED.has(k)) continue;
    if (CONTENT_KEYS.has(k)) {
      if (typeof v === 'string') out.set(k + '_chars', v.length); // solo el tamaño
      continue;
    }
    if (typeof v === 'string') out.set(k, keep(v, k === 'command' ? 2000 : 300, k === 'command' ? 40 : 4));
    else if (typeof v === 'number' || typeof v === 'boolean') out.set(k, v);
  }
  return Object.fromEntries(out);
}

// La salida se reduce a lo que muestra la tabla (12 líneas) y al resultado.
function minimizeResponse(resp) {
  if (resp == null) return undefined;
  if (typeof resp === 'string') return keep(resp, 2000);
  if (typeof resp !== 'object') return undefined;
  let text;
  if (typeof resp.stdout === 'string' || typeof resp.stderr === 'string') text = [resp.stdout, resp.stderr].filter(Boolean).join('\n');
  else if (typeof resp.content === 'string') text = resp.content;
  else if (typeof resp.file?.content === 'string') text = resp.file.content;
  const out = { stdout: keep(text ?? '', 2000) };
  for (const k of ['exit_code', 'exitCode', 'returnCode', 'is_error', 'interrupted']) {
    if (typeof resp[k] === 'number' || typeof resp[k] === 'boolean') out[k] = resp[k];
  }
  return out;
}

/** Payload mínimo de un evento: lo que pinta la vista y nada más. */
export function minimizePayload(hookName, payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const k of PLAIN) {
    const v = payload[k];
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = keep(v, 300, 2);
  }
  // Solo el principio del primer prompt hace falta (es el título de la sesión).
  if (hookName === 'UserPromptSubmit') out.prompt = keep(payload.prompt, 200, 3);
  if (payload.error != null) out.error = keep(String(payload.error), 2000);
  const input = minimizeInput(payload.tool_input);
  if (input) out.tool_input = input;
  const resp = minimizeResponse(payload.tool_response);
  if (resp !== undefined) out.tool_response = resp;
  return out;
}
