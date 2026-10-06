// API client. Money never computed here — the server is the source of truth.
const state = { token: null, onUnauthorized: null };
try { state.token = sessionStorage.getItem('pos.token'); } catch (_) { /* storage unavailable */ }

export function setToken(t) {
  state.token = t;
  try { if (t) sessionStorage.setItem('pos.token', t); else sessionStorage.removeItem('pos.token'); } catch (_) { /* ignore */ }
}
export const getToken = () => state.token;
export function onUnauthorized(fn) { state.onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

export function newKey(prefix = 'k') {
  const a = new Uint8Array(12); crypto.getRandomValues(a);
  return `${prefix}-${Date.now().toString(36)}-${[...a].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function api(method, path, body, { idempotencyKey, raw = false, timeoutMs = 30000 } = {}) {
  const headers = { accept: 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal });
  } catch (e) {
    throw new ApiError(0, 'network', e.name === 'AbortError' ? 'The request timed out. Check the status before retrying.' : 'Cannot reach the POS service. Check that the application is running.');
  } finally { clearTimeout(t); }
  if (raw && res.ok) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { error: { message: text } }; }
  if (!res.ok) {
    const err = data && data.error ? data.error : { code: 'http_' + res.status, message: res.statusText };
    if (res.status === 401 && state.onUnauthorized && !path.startsWith('/api/auth/login')) state.onUnauthorized(err.message);
    throw new ApiError(res.status, err.code, err.message, err.details);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}, o) => api('POST', p, b, o);
export const put = (p, b = {}, o) => api('PUT', p, b, o);
export const patch = (p, b = {}, o) => api('PATCH', p, b, o);
export const del = (p) => api('DELETE', p);

export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Download a binary/text export with auth, then hand it to the browser/desktop save flow. */
export async function download(path, fallbackName) {
  const res = await api('GET', path, undefined, { raw: true });
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? m[1] : fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export async function fetchText(path) { const res = await api('GET', path, undefined, { raw: true }); return res.text(); }
