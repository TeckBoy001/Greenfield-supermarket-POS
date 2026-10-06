// UI toolkit: escaping templates, formatting, modals, tables, forms, supervisor override.
import { ApiError } from './api.js';

export const S = { me: null, lookups: null };

// ── safe HTML ──
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const interp = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(interp).join('') : v === false || v === null || v === undefined ? '' : esc(v));
/** Tagged template: every interpolation is escaped unless it is already Safe. */
export function html(strings, ...vals) { let out = strings[0]; vals.forEach((v, i) => { out += interp(v) + strings[i + 1]; }); return new Safe(out); }
export const raw = (s) => new Safe(String(s));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function mount(el, content) { el.innerHTML = content instanceof Safe ? content.s : esc(content); return el; }
export function on(root, event, selector, fn) {
  root.addEventListener(event, (e) => { const t = e.target.closest(selector); if (t && root.contains(t)) fn(e, t); });
}
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── formatting ──
function biz() { return (S.me && S.me.business) || { currency: 'NGN', currency_minor: 2, locale: 'en-NG', timezone: 'Africa/Lagos' }; }
let moneyFmt = null; let fmtKey = '';
export function money(minor, { sign = false } = {}) {
  if (minor === null || minor === undefined || minor === '') return '—';
  const b = biz(); const key = `${b.locale}|${b.currency}|${b.currency_minor}`;
  if (key !== fmtKey) { fmtKey = key; try { moneyFmt = new Intl.NumberFormat(b.locale, { style: 'currency', currency: b.currency, minimumFractionDigits: b.currency_minor, maximumFractionDigits: b.currency_minor }); } catch (_) { moneyFmt = null; } }
  const v = Number(minor) / Math.pow(10, b.currency_minor);
  const s = moneyFmt ? moneyFmt.format(Math.abs(v)) : `${b.currency} ${Math.abs(v).toFixed(b.currency_minor)}`;
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + s;
}
export const toMinor = (major) => { const b = biz(); const n = Number(String(major).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.round(n * Math.pow(10, b.currency_minor)) : NaN; };
export const toMajor = (minor) => (Number(minor) / Math.pow(10, biz().currency_minor)).toFixed(biz().currency_minor);
export const currencySymbol = () => { try { return (0).toLocaleString(biz().locale, { style: 'currency', currency: biz().currency, maximumFractionDigits: 0 }).replace(/[\d\s.,]/g, ''); } catch (_) { return biz().currency; } };
export function qty(q, unit) { if (q === null || q === undefined) return '—'; return unit && unit !== 'each' ? `${Number(q).toFixed(3).replace(/\.?0+$/, '')} ${unit}` : `${Number(q)}`; }
export function dt(iso, { time = true, seconds = false } = {}) {
  if (!iso) return '—';
  const opts = { timeZone: biz().timezone, day: '2-digit', month: 'short', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' } : {}) };
  return new Intl.DateTimeFormat('en-GB', opts).format(new Date(iso));
}
export const tm = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: biz().timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '—');
export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return dt(iso, { time: false });
}
export const pct = (x) => `${Number(x).toFixed(1).replace(/\.0$/, '')}%`;
export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const STATUS = {
  ok: ['completed', 'succeeded', 'matched', 'paid', 'approved', 'active', 'sent', 'resolved', 'closed', 'done', 'integrated'],
  info: ['processing', 'pending', 'open', 'reported', 'held', 'in_progress', 'test_only', 'experimental'],
  warn: ['partially_matched', 'pending_approval', 'required', 'failed_retry', 'not_configured', 'review', 'conflict'],
  bad: ['failed', 'cancelled', 'voided', 'discrepancy', 'rejected', 'declined', 'inactive', 'locked', 'not_integrated'],
};
export function badge(status, label) {
  const s = String(status || '');
  const cls = Object.keys(STATUS).find((k) => STATUS[k].includes(s)) || '';
  const pulse = ['processing', 'pending'].includes(s) ? ' pulse' : '';
  return html`<span class="badge ${cls}${pulse}">${label || titleCase(s)}</span>`;
}

// ── toasts ──
export function toast(msg, type = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.setAttribute('role', type === 'bad' ? 'alert' : 'status');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, type === 'bad' ? 6000 : 3200);
}
export function errMsg(e) {
  if (e instanceof ApiError) return e.message || 'Request failed';
  return (e && e.message) || String(e);
}
export function showError(e) { toast(errMsg(e), 'bad'); }

// ── modals ──
const stack = [];
export function modal({ title, sub, body, foot, size = '', onMount, dismissable = true, className = '' }) {
  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal ${size} ${className}" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="modal-head"><div><h2>${title}</h2>${sub ? html`<div class="sub">${sub}</div>` : ''}</div>${dismissable ? html`<button class="x-btn" data-close aria-label="Close">×</button>` : ''}</div>
    <div class="modal-body">${body || ''}</div>${foot ? html`<div class="modal-foot">${foot}</div>` : ''}</div>`.s;
  document.body.appendChild(ov);
  const prevFocus = document.activeElement;
  const m = { el: ov.firstElementChild, overlay: ov, promise, closed: false };
  m.close = (val) => {
    if (m.closed) return; m.closed = true; ov.remove(); stack.splice(stack.indexOf(m), 1); resolveFn(val);
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
  };
  m.body = m.el.querySelector('.modal-body');
  m.foot = m.el.querySelector('.modal-foot');
  if (dismissable) {
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) m.close(null); });
    m.el.querySelector('[data-close]').addEventListener('click', () => m.close(null));
  }
  on(m.el, 'click', '[data-dismiss]', () => m.close(null));
  m.onKey = (e) => {
    if (e.key === 'Escape' && dismissable) { e.preventDefault(); m.close(null); }
    if (e.key === 'Tab') { // focus trap
      const f = $$('button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]', m.el).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  stack.push(m);
  if (onMount) onMount(m);
  const focusFirst = () => { if (m.el.contains(document.activeElement)) return; const first = m.el.querySelector('[autofocus]') || m.el.querySelector('input:not([type=hidden]):not([disabled]), select, textarea, .modal-foot .btn.primary'); if (first) first.focus(); };
  focusFirst(); setTimeout(focusFirst, 20);
  return m;
}
let lastPrintable = 0;
document.addEventListener('keydown', (e) => {
  const top = stack[stack.length - 1];
  if (e.key.length === 1) lastPrintable = performance.now();
  if (!top) return;
  top.onKey(e);
  // Enter pressed before focus reached the dialog → treat as the dialog's primary action,
  // unless it ends a fast keystroke burst (a barcode scanner), which must never confirm anything.
  if (e.key === 'Enter' && top.onEnter && !top.el.contains(e.target) && performance.now() - lastPrintable > 80) { e.preventDefault(); e.stopPropagation(); top.onEnter(); }
}, true);
export const modalOpen = () => stack.length > 0;

export function confirmDlg(title, message, { confirmText = 'Confirm', danger = false, cancelText = 'Cancel' } = {}) {
  const m = modal({
    title, size: 'narrow', body: html`<p style="margin:0">${message}</p>`,
    foot: html`<button class="btn" data-dismiss>${cancelText}</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-ok>${confirmText}</button>`,
  });
  m.el.querySelector('[data-ok]').addEventListener('click', () => m.close(true));
  return m.promise.then((v) => !!v);
}

/** Form builder. field: {name,label,type,required,options,hint,placeholder,full,min,max,step,value,money,rows,disabled} */
export function fieldHtml(f, values = {}) {
  const val = values[f.name] ?? f.value ?? '';
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
  const req = f.required ? raw(' required') : '';
  let control;
  if (f.type === 'select') {
    control = html`<select class="input" id="${id}" name="${f.name}"${req}${f.disabled ? raw(' disabled') : ''}>${f.placeholder !== undefined ? html`<option value="">${f.placeholder}</option>` : ''}${(f.options || []).map((o) => html`<option value="${o.value}" ${String(o.value) === String(val) ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
  } else if (f.type === 'textarea') {
    control = html`<textarea class="input" id="${id}" name="${f.name}" rows="${f.rows || 3}" placeholder="${f.placeholder || ''}"${req}>${val}</textarea>`;
  } else if (f.type === 'checkbox') {
    return html`<div class="field ${f.full ? 'full' : ''}"><label class="check"><input type="checkbox" name="${f.name}" ${val === true || val === 1 || val === '1' ? raw('checked') : ''}${f.disabled ? raw(' disabled') : ''}> ${f.label}</label>${f.hint ? html`<span class="hint">${f.hint}</span>` : ''}</div>`;
  } else {
    const shown = f.money && val !== '' && val !== null ? toMajor(val) : val;
    const type = f.money ? 'text' : (f.type || 'text');
    control = html`<input class="input" id="${id}" name="${f.name}" type="${type}" value="${shown}" placeholder="${f.placeholder || ''}"${f.money ? raw(' inputmode="decimal" data-money="1"') : ''}${f.min !== undefined ? raw(` min="${esc(f.min)}"`) : ''}${f.max !== undefined ? raw(` max="${esc(f.max)}"`) : ''}${f.step !== undefined ? raw(` step="${esc(f.step)}"`) : ''}${f.maxlength ? raw(` maxlength="${esc(f.maxlength)}"`) : ''}${req}${f.disabled ? raw(' disabled') : ''}${f.autocomplete ? raw(` autocomplete="${esc(f.autocomplete)}"`) : ''}${f.autofocus ? raw(' autofocus') : ''}>`;
  }
  return html`<div class="field ${f.full ? 'full' : ''}"><label for="${id}">${f.label}${f.required ? html` <span style="color:var(--bad)">*</span>` : ''}</label>${control}${f.hint ? html`<span class="hint">${f.hint}</span>` : ''}</div>`;
}
export const formHtml = (fields, values, cls = 'form-grid') => html`<div class="${cls}">${fields.map((f) => fieldHtml(f, values))}</div>`;

export function readForm(root, fields) {
  const out = {}; let bad = null;
  for (const f of fields) {
    const el = root.querySelector(`[name="${f.name}"]`);
    if (!el) continue;
    el.removeAttribute('aria-invalid');
    let v;
    if (f.type === 'checkbox') v = el.checked;
    else if (f.money) { v = el.value.trim() === '' ? null : toMinor(el.value); if (Number.isNaN(v)) { bad = bad || el; el.setAttribute('aria-invalid', 'true'); } }
    else if (f.type === 'number') v = el.value === '' ? null : Number(el.value);
    else v = el.value.trim() === '' ? null : el.value.trim();
    if (f.required && (v === null || v === '')) { bad = bad || el; el.setAttribute('aria-invalid', 'true'); }
    out[f.name] = v;
  }
  if (bad) { bad.focus(); throw new Error('Please complete the highlighted fields'); }
  return out;
}

/** Modal form. submit(values) may throw; errors are shown inline and the dialog stays open. */
export function formDlg({ title, sub, fields, values = {}, submitText = 'Save', size = '', submit, extra, danger = false, cls, onMount }) {
  const m = modal({
    title, sub, size, onMount,
    body: html`<form novalidate>${extra || ''}${formHtml(fields, values, cls)}<div class="callout bad hidden" data-err style="margin-top:12px"></div><button type="submit" hidden></button></form>`,
    foot: html`<button class="btn" data-dismiss>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-ok>${submitText}</button>`,
  });
  const form = m.el.querySelector('form'); const errBox = m.el.querySelector('[data-err]'); const ok = m.el.querySelector('[data-ok]');
  const go = async (e) => {
    if (e) e.preventDefault();
    errBox.classList.add('hidden');
    let vals;
    try { vals = readForm(form, fields); } catch (err) { errBox.textContent = err.message; errBox.classList.remove('hidden'); return; }
    ok.disabled = true;
    try { const r = submit ? await submit(vals, m) : vals; if (r !== false) m.close(r === undefined ? vals : r); } catch (err) {
      if (err && err.code === 'cancelled') return;
      errBox.textContent = errMsg(err); errBox.classList.remove('hidden');
    } finally { ok.disabled = false; }
  };
  form.addEventListener('submit', go); ok.addEventListener('click', go);
  return m.promise;
}

/** Supervisor approval (username + PIN). Resolves {username, pin} or null. */
export function overrideDlg(message) {
  return formDlg({
    title: 'Supervisor approval', sub: message || 'This action needs a supervisor.', size: 'narrow', submitText: 'Approve', cls: 'stack',
    extra: html`<div class="callout info" style="margin-bottom:12px">A supervisor enters their own credentials. The approval is recorded in the audit log.</div>`,
    fields: [{ name: 'username', label: 'Supervisor username', required: true, autocomplete: 'off', autofocus: true }, { name: 'pin', label: 'PIN', type: 'password', required: true, autocomplete: 'off', maxlength: 8 }],
  });
}
/** Run fn(override); if the server asks for an override, collect one and retry. */
export async function withOverride(fn) {
  let override = null;
  for (let i = 0; i < 4; i++) {
    try { return await fn(override); } catch (e) {
      if (e instanceof ApiError && e.code === 'override_required') {
        override = await overrideDlg(e.message);
        if (!override) { const c = new Error('Cancelled'); c.code = 'cancelled'; throw c; }
        continue;
      }
      throw e;
    }
  }
  throw new Error('Approval failed');
}

// ── tables ──
export function cell(c, row) {
  const v = typeof c.value === 'function' ? c.value(row) : row[c.key];
  if (c.render) return c.render(row);
  switch (c.type) {
    case 'money': return money(v);
    case 'qty': return qty(v, row.unit);
    case 'int': return v ?? 0;
    case 'pct': return v === null || v === undefined ? '—' : pct(v);
    case 'date': return v ? (String(v).length === 10 ? v : dt(v, { time: false })) : '—';
    case 'datetime': return dt(v);
    case 'status': return v ? badge(v) : '—';
    default: return v ?? '—';
  }
}
export function table({ columns, rows, onRowAttr, empty = 'Nothing to show', emptyHint = '', foot, cls = '' }) {
  if (!rows || !rows.length) return html`<div class="empty"><div class="ico">${icon('inbox')}</div><strong>${empty}</strong>${emptyHint}</div>`;
  const numeric = (c) => ['money', 'int', 'qty', 'pct'].includes(c.type) || c.num;
  return html`<div class="table-wrap ${cls}"><table class="t"><thead><tr>${columns.map((c) => html`<th class="${numeric(c) ? 'num' : ''}" style="${c.width ? `width:${c.width}` : ''}">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr ${onRowAttr ? raw(onRowAttr(r)) : ''}>${columns.map((c) => html`<td class="${numeric(c) ? 'num' : ''} ${['date', 'datetime', 'status'].includes(c.type) ? 'nowrap' : ''} ${c.cls || ''}">${cell(c, r)}</td>`)}</tr>`)}</tbody>
    ${foot ? html`<tfoot><tr>${columns.map((c) => html`<td class="${numeric(c) ? 'num' : ''}">${foot[c.key] !== undefined ? cell(c, foot) : ''}</td>`)}</tr></tfoot>` : ''}</table></div>`;
}

// ── period filter ──
export const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['this_month', 'This month'], ['custom', 'Custom']];
export function periodHtml(p) {
  return html`<span class="row wrap" data-periodwrap><span class="seg" data-period>${PERIODS.map(([k, l]) => html`<button type="button" data-p="${k}" class="${p.period === k ? 'on' : ''}">${l}</button>`)}</span>
    <span class="${p.period === 'custom' ? '' : 'hidden'} row" data-custom><input class="input" type="date" data-from value="${p.from || ''}" style="width:150px"> – <input class="input" type="date" data-to value="${p.to || ''}" style="width:150px"></span></span>`;
}
/** Wire a period picker rendered with periodHtml. It re-renders itself; onChange reloads data. */
export function bindPeriod(root, p, onChange) {
  const redraw = () => { const w = root.querySelector('[data-periodwrap]'); if (w) w.outerHTML = periodHtml(p).s; };
  on(root, 'click', '[data-period] [data-p]', (e, b) => {
    p.period = b.dataset.p;
    if (p.period !== 'custom') { p.from = ''; p.to = ''; redraw(); onChange(); } else redraw();
  });
  on(root, 'change', '[data-from], [data-to]', () => { p.from = $('[data-from]', root).value; p.to = $('[data-to]', root).value; if (p.from && p.to) onChange(); });
}

// ── icons (inline, stroke) ──
const ICONS = {
  dashboard: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z', pos: 'M4 4h16v10H4zM8 18h8M12 14v4M7 8h4', sales: 'M4 19V5M4 19h16M8 15l3-4 3 2 5-6',
  products: 'M20 7l-8-4-8 4 8 4 8-4zM4 7v10l8 4 8-4V7M12 11v10', inventory: 'M3 7h18M5 7v13h14V7M9 11h6M8 3h8l1 4H7z', customers: 'M16 11a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0M12 7v0',
  sessions: 'M3 8h18v10H3zM3 12h18M7 16h2', payments: 'M3 6h18v12H3zM3 10h18M7 15h4', refunds: 'M9 14l-4-4 4-4M5 10h9a5 5 0 0 1 0 10h-3', finance: 'M3 21h18M5 21V10M9 21V10M15 21V10M19 21V10M12 3l9 5H3z',
  reports: 'M6 3h9l5 5v13H6zM14 3v6h6M9 13h6M9 17h6', audit: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4', admin: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z', check: 'M5 12l5 5 9-10', logout: 'M15 4h4v16h-4M10 16l4-4-4-4M14 12H3', lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h0', user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21a8 8 0 0 1 16 0', print: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h0', display: 'M3 4h18v12H3zM8 20h8M12 16v4',
};
export const icon = (n, size = 18) => raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[n] || ICONS.inbox}"/></svg>`);

export const can = (p) => !!(S.me && S.me.permissions.includes(p));
