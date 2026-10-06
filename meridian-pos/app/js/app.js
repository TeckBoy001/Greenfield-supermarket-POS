// App shell: sign-in, navigation, routing, idle lock, connectivity indicator.
import { get, post, setToken, getToken, onUnauthorized } from './api.js';
import { S, html, mount, $, on, icon, toast, showError, can, formDlg, esc, modalOpen } from './ui.js';

const PAGES = {
  pos: () => import('./pages/pos.js'),
  dashboard: () => import('./pages/dashboard.js'),
  sales: () => import('./pages/sales.js'),
  refunds: () => import('./pages/sales.js'),
  sessions: () => import('./pages/sessions.js'),
  products: () => import('./pages/products.js'),
  inventory: () => import('./pages/inventory.js'),
  customers: () => import('./pages/customers.js'),
  payments: () => import('./pages/payments.js'),
  settlements: () => import('./pages/finance.js'),
  payouts: () => import('./pages/finance.js'),
  reconciliation: () => import('./pages/finance.js'),
  reports: () => import('./pages/reports.js'),
  audit: () => import('./pages/audit.js'),
  staff: () => import('./pages/admin.js'),
  settings: () => import('./pages/admin.js'),
};

const NAV = [
  ['Operations', [
    ['pos', 'Checkout', 'pos', () => can('pos.sell')],
    ['dashboard', 'Dashboard', 'dashboard', () => can('report.view') || can('report.financial')],
    ['sales', 'Sales', 'sales', () => can('pos.sell') || can('sale.view_all')],
    ['refunds', 'Refunds & voids', 'refunds', () => can('refund.create') || can('refund.approve') || can('sale.view_all')],
    ['sessions', 'Cash sessions', 'sessions', () => can('session.open_close') || can('session.manage_all')],
  ]],
  ['Catalogue', [
    ['products', 'Products', 'products', () => can('product.view')],
    ['inventory', 'Inventory', 'inventory', () => can('inventory.view')],
    ['customers', 'Customers', 'customers', () => can('customer.view')],
  ]],
  ['Finance', [
    ['payments', 'Payments', 'payments', () => can('payment.view')],
    ['settlements', 'Settlements', 'finance', () => can('settlement.manage')],
    ['payouts', 'Payouts', 'finance', () => can('payout.request') || can('payout.approve')],
    ['reconciliation', 'Reconciliation', 'check', () => can('reconciliation.manage')],
  ]],
  ['Insights', [
    ['reports', 'Reports', 'reports', () => can('report.view') || can('inventory.view')],
    ['audit', 'Audit log', 'audit', () => can('audit.view')],
  ]],
  ['Administration', [
    ['staff', 'Staff & roles', 'user', () => can('user.manage')],
    ['settings', 'Settings', 'admin', () => can('settings.manage') || can('sync.manage')],
  ]],
];

const root = document.getElementById('root');
let boot = null;
let cleanup = null;
let netTimer = null;
let lastActivity = Date.now();
let locked = false;

export function terminalRegister() {
  try { return (window.meridian && window.meridian.terminal && window.meridian.terminal.registerId) || localStorage.getItem('pos.register') || ''; } catch (_) { return ''; }
}
function setTerminalRegister(id) { try { localStorage.setItem('pos.register', id || ''); } catch (_) { /* ignore */ } if (window.meridian && window.meridian.setRegister) window.meridian.setRegister(id || ''); }

onUnauthorized((msg) => { if (S.me) { S.me = null; setToken(null); toast(msg || 'Signed out', 'warn'); showLogin(); } });

async function start() {
  try { boot = await get('/api/bootstrap'); } catch (e) { mount(root, html`<div class="empty" style="padding-top:120px"><strong>Cannot reach the POS service</strong>${e.message}</div>`); return; }
  if (getToken()) {
    try { await loadMe(); return route(); } catch (_) { setToken(null); }
  }
  showLogin();
}

async function loadMe() {
  S.me = await get('/api/me');
  S.lookups = await get('/api/lookups');
  document.title = `${S.me.business.name} — Meridian POS`;
}

function showLogin(message) {
  if (cleanup) { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }
  clearInterval(netTimer);
  const regs = boot.registers || [];
  const current = terminalRegister();
  let mode = 'password';
  mount(root, html`<div class="auth-wrap">
    <section class="auth-art">
      <div class="row"><div class="brand-mark">${boot.business && boot.business.logo ? html`<img alt="" src="${boot.business.logo}">` : 'M'}</div><div><div class="brand-name">${boot.business ? boot.business.name : 'Meridian POS'}</div><div class="brand-sub">Meridian POS</div></div></div>
      <div><h1>Checkout, stock, cash and settlements — one ledger.</h1>
      <ul style="margin-top:22px"><li>Scan-first checkout with held sales, overrides and split tender</li><li>Every stock change and every naira traceable to a record</li><li>Provider-confirmed electronic payments, never assumed</li><li>Daily reconciliation from till to bank</li></ul></div>
      <div class="xs" style="color:#6d7e91">Terminal: ${regs.find((r) => r.id === current) ? `${regs.find((r) => r.id === current).location_name} · ${regs.find((r) => r.id === current).name}` : 'Back office (no register)'}</div>
    </section>
    <section class="auth-form"><form class="auth-card stack" autocomplete="off" novalidate>
      <div><h2>Sign in</h2><div class="muted">Use your staff account. Cashiers can sign in with a PIN.</div></div>
      ${message ? html`<div class="callout warn">${message}</div>` : ''}
      <div class="field"><label for="reg">This terminal</label><select class="input" id="reg">
        <option value="">Back office (no register)</option>
        ${regs.map((r) => html`<option value="${r.id}" ${r.id === current ? 'selected' : ''}>${r.location_name} — ${r.name} (${r.location_code}-${r.code})</option>`)}
      </select></div>
      <div class="field"><label for="u">Username</label><input class="input lg" id="u" autocomplete="username" autofocus></div>
      <div class="seg" style="align-self:flex-start"><button type="button" class="on" data-m="password">Password</button><button type="button" data-m="pin">PIN</button></div>
      <div class="field" data-f="password"><label for="p">Password</label><input class="input lg" id="p" type="password" autocomplete="current-password"></div>
      <div class="field hidden" data-f="pin"><label for="pin">PIN</label><input class="input lg" id="pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>
      <div class="callout bad hidden" data-err></div>
      <button class="btn primary lg block" type="submit">Sign in</button>
      ${boot.demo ? html`<div class="demo-creds"><strong>Demo data.</strong> All demo accounts use password <span class="mono">demo1234</span>. Quick fill:<br>
        ${['cashier1', 'supervisor', 'manager', 'stock', 'finance', 'owner'].map((u) => html`<button type="button" data-demo="${u}">${u}</button>`)}</div>` : ''}
    </form></section></div>`);
  const form = $('form', root); const err = $('[data-err]', root);
  on(form, 'click', '[data-m]', (e, b) => {
    mode = b.dataset.m;
    form.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
    $('[data-f=password]', form).classList.toggle('hidden', mode !== 'password'); $('[data-f=pin]', form).classList.toggle('hidden', mode !== 'pin');
  });
  on(form, 'click', '[data-demo]', (e, b) => {
    $('#u', form).value = b.dataset.demo; $('#p', form).value = 'demo1234';
    if (['cashier1', 'supervisor'].includes(b.dataset.demo) && !$('#reg', form).value && regs[0]) $('#reg', form).value = regs[0].id;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.classList.add('hidden');
    const btn = $('button[type=submit]', form); btn.disabled = true;
    const registerId = $('#reg', form).value;
    try {
      const r = await post('/api/auth/login', { username: $('#u', form).value.trim(), password: mode === 'password' ? $('#p', form).value : undefined, pin: mode === 'pin' ? $('#pin', form).value : undefined, register_id: registerId || undefined });
      setTerminalRegister(registerId);
      setToken(r.token);
      await loadMe();
      if (S.me.user.must_change_password) await forcePasswordChange();
      location.hash = '';
      route();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
  });
}

async function forcePasswordChange() {
  await formDlg({
    title: 'Set a new password', sub: 'Your password was set by an administrator and must be changed now.', size: 'narrow', cls: 'stack', submitText: 'Change password',
    fields: [{ name: 'current_password', label: 'Current password', type: 'password', required: true }, { name: 'new_password', label: 'New password', type: 'password', required: true, hint: 'At least 8 characters with letters and numbers' }],
    submit: (v) => post('/api/me/password', v),
  });
}

export async function logout() {
  try { await post('/api/auth/logout'); } catch (_) { /* ignore */ }
  setToken(null); S.me = null; showLogin();
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  return { page: parts[0] || '', params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(query || '')) };
}
export function go(path) { location.hash = `#/${path}`; }

function defaultPage() {
  if (S.me.register && can('pos.sell')) return 'pos';
  for (const [, items] of NAV) for (const [k, , , ok] of items) if (ok() && k !== 'pos') return k;
  return 'pos';
}

async function route() {
  if (!S.me) return showLogin();
  if (cleanup) { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }
  let { page, params, query } = parseHash();
  if (!page || !PAGES[page]) { page = defaultPage(); history.replaceState(null, '', `#/${page}`); }
  const allowed = NAV.flatMap(([, items]) => items).find(([k]) => k === page);
  if (allowed && !allowed[3]()) { mount(root, html`<div class="empty" style="padding-top:120px"><strong>Not available for your role</strong><a href="#/">Go back</a></div>`); return; }
  const mod = await PAGES[page]();
  if (page === 'pos') {
    root.innerHTML = '';
    const el = document.createElement('div'); root.appendChild(el);
    cleanup = await mod.render(el, { page, params, query, logout, go, lock: lockScreen });
  } else {
    const content = shell(page);
    cleanup = await mod.render(content, { page, params, query, logout, go, setTitle });
  }
  startNetPoll();
}

function setTitle(t) { const el = $('.topbar .title'); if (el) el.textContent = t; }

function shell(active) {
  const me = S.me;
  mount(root, html`<div class="shell"><aside class="sidebar">
    <div class="brand"><div class="brand-mark">${me.business.logo_data ? html`<img alt="" src="${me.business.logo_data}">` : 'M'}</div><div><div class="brand-name">${me.business.name}</div><div class="brand-sub">${me.register ? `${me.register.location_name} · ${me.register.name}` : 'Back office'}</div></div></div>
    <nav class="nav" aria-label="Main">${NAV.map(([sec, items]) => {
      const vis = items.filter((i) => i[3]());
      if (!vis.length) return '';
      return html`<div class="nav-sec">${sec}</div>${vis.map(([k, label, ic]) => html`<a href="#/${k}" class="${k === active ? 'active' : ''}" title="${label}">${icon(ic)}<span>${label}</span></a>`)}`;
    })}</nav>
    <div class="sidebar-foot"><div class="row"><div class="avatar" style="background:#1f2d40;color:#cfe;">${initials(me.user.full_name)}</div><div class="who grow"><div style="color:#fff;font-weight:600">${me.user.full_name}</div><div class="xs" style="color:#7b8899">${me.user.role.name}</div></div>
      <button class="btn ghost icon-btn" style="color:#b7c2cf" title="Sign out" data-logout>${icon('logout')}</button></div></div>
  </aside><div class="main"><header class="topbar"><div class="title"></div><div class="grow"></div><span data-net></span>
    <button class="btn sm ghost" data-account title="My account">${icon('user', 16)} ${me.user.username}</button></header><main class="content" id="content"></main></div></div>`);
  on(root, 'click', '[data-logout]', logout);
  on(root, 'click', '[data-account]', accountDialog);
  return $('#content', root);
}

export const initials = (n) => String(n || '?').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();

async function accountDialog() {
  const which = await formDlg({
    title: 'My account', sub: `${S.me.user.full_name} · ${S.me.user.role.name}`, size: 'narrow', submitText: 'Continue', cls: 'stack',
    fields: [{ name: 'what', label: 'What do you want to change?', type: 'select', required: true, options: [{ value: 'password', label: 'Password' }, { value: 'pin', label: 'Quick sign-in PIN' }] }],
  });
  if (!which) return;
  if (which.what === 'password') await forcePasswordChange().then(() => toast('Password changed', 'ok'), showError);
  else await formDlg({ title: 'Set PIN', size: 'narrow', cls: 'stack', submitText: 'Save PIN', fields: [{ name: 'password', label: 'Current password', type: 'password', required: true }, { name: 'pin', label: 'New PIN (4–8 digits)', type: 'password', required: true, maxlength: 8 }], submit: (v) => post('/api/me/pin', v) }).then((r) => r && toast('PIN updated', 'ok'));
}

function renderNet(n) {
  const el = document.querySelector('[data-net]');
  if (!el) return;
  mount(el, n.online ? html`<span class="net-pill" title="Payment providers reachable${n.outbox_pending ? ` · ${n.outbox_pending} records waiting to sync` : ''}"><span class="dot"></span>Online${n.outbox_pending ? html` · ${n.outbox_pending} to sync` : ''}</span>`
    : html`<span class="net-pill off" title="Electronic payments are unavailable. Cash and offline methods still work; records sync when back online."><span class="dot"></span>Offline${n.simulated_offline ? ' (simulated)' : ''} · cash only</span>`);
  document.dispatchEvent(new CustomEvent('pos:network', { detail: n }));
}
function startNetPoll() {
  clearInterval(netTimer);
  const tick = () => get('/api/network').then(renderNet).catch(() => renderNet({ online: false }));
  tick(); netTimer = setInterval(tick, 8000);
}
export const refreshNetwork = () => get('/api/network').then(renderNet).catch(() => {});

// ── idle lock (POS terminals) ──
['mousemove', 'keydown', 'mousedown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));
setInterval(() => {
  if (!S.me || locked || !S.me.register) return;
  const mins = (S.me.settings && S.me.settings['pos.idle_lock_minutes']) || 10;
  if (Date.now() - lastActivity > mins * 60000 && !modalOpen()) lockScreen();
}, 15000);

export function lockScreen() {
  if (locked || !S.me) return;
  locked = true;
  const me = S.me;
  const el = document.createElement('div');
  el.className = 'lock';
  el.innerHTML = html`<form class="stack" style="width:340px;text-align:center" autocomplete="off">
    <div class="avatar" style="width:64px;height:64px;font-size:22px;margin:0 auto;background:#12342c;color:#8fe3c9">${initials(me.user.full_name)}</div>
    <div><h2 style="color:#fff">Terminal locked</h2><div style="color:#9fb0c2">${me.user.full_name} · ${me.register ? me.register.name : ''}</div></div>
    <input class="input lg" type="password" inputmode="numeric" placeholder="${me.user.has_pin ? 'Enter your PIN' : 'Enter your password'}" autofocus style="text-align:center">
    <div class="callout bad hidden" data-err></div>
    <button class="btn primary lg" type="submit">Unlock</button>
    <button class="btn ghost" type="button" data-switch style="color:#c9d2de">Sign in as someone else</button></form>`.s;
  document.body.appendChild(el);
  const input = el.querySelector('input'); setTimeout(() => input.focus(), 30);
  el.querySelector('[data-switch]').addEventListener('click', async () => { el.remove(); locked = false; await logout(); });
  el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldToken = getToken();
    try {
      const r = await post('/api/auth/login', { username: me.user.username, [me.user.has_pin ? 'pin' : 'password']: input.value, register_id: me.register ? me.register.id : undefined });
      setToken(r.token);
      try { await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${oldToken}` } }); } catch (_) { /* ignore */ }
      el.remove(); locked = false; lastActivity = Date.now();
      document.dispatchEvent(new CustomEvent('pos:unlocked'));
    } catch (ex) { const b = el.querySelector('[data-err]'); b.textContent = ex.message; b.classList.remove('hidden'); input.value = ''; input.focus(); }
  });
}

window.addEventListener('hashchange', () => { if (S.me) route(); });
window.addEventListener('error', (e) => { console.error(e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { if (e.reason && e.reason.code === 'cancelled') { e.preventDefault(); return; } console.error(e.reason); if (e.reason && e.reason.message) showError(e.reason); });
void esc;
start();
