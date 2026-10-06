// Administration: staff & roles, business configuration, payments, hardware, network & sync.
import { get, post, put, qs } from '../api.js';
import { S, html, mount, $, $$, on, money, dt, toast, showError, modal, formDlg, table, can, badge, titleCase, ago, toMajor, toMinor } from '../ui.js';

export async function render(el, nav) {
  return nav.page === 'staff' ? staff(el, nav) : settings(el, nav);
}

// ─────────────── staff & roles ───────────────
async function staff(el, nav) {
  nav.setTitle('Staff & roles');
  const st = { tab: 'users' };
  mount(el, html`<div class="page-head"><div><h1>Staff & roles</h1><div class="sub">Least privilege: each role only gets what the job needs. Sensitive actions at the till can be approved by a supervisor instead.</div></div><div data-actions></div></div>
    <div class="tabs"><button data-tab="users" class="on">Staff</button><button data-tab="roles">Roles & permissions</button></div><div data-body></div>`);
  let roles = []; let perms = [];
  const load = async () => {
    try {
      [roles, perms] = await Promise.all([get('/api/admin/roles'), get('/api/admin/permissions')]);
      if (st.tab === 'users') {
        const users = await get('/api/admin/users');
        mount($('[data-actions]', el), html`<button class="btn primary" data-newuser>New staff account</button>`);
        mount($('[data-body]', el), html`<div class="panel">${table({ rows: users, onRowAttr: (u) => `class="clickable" data-uid="${u.id}"`, columns: [{ key: 'full_name', label: 'Name', render: (u) => html`<div class="strong">${u.full_name}</div><div class="xs muted">${u.email || ''}</div>` }, { key: 'username', label: 'Username', cls: 'mono' },
          { key: 'role_name', label: 'Role' }, { key: 'location_name', label: 'Home store' }, { key: 'has_pin', label: 'PIN', render: (u) => (u.has_pin ? 'Set' : '—') }, { key: 'is_active', label: 'Status', render: (u) => (u.locked_until && u.locked_until > new Date().toISOString() ? badge('locked', 'Locked') : badge(u.is_active ? 'active' : 'inactive')) }, { key: 'last_login_at', label: 'Last sign-in', render: (u) => ago(u.last_login_at) }] })}</div>`);
      } else {
        mount($('[data-actions]', el), html`<button class="btn primary" data-newrole>New role</button>`);
        mount($('[data-body]', el), html`<div class="panel">${table({ rows: roles, onRowAttr: (r) => `class="clickable" data-rid="${r.id}"`, columns: [{ key: 'name', label: 'Role', render: (r) => html`<div class="strong">${r.name}</div><div class="xs muted">${r.description || ''}</div>` }, { key: 'users', label: 'Active staff', type: 'int' }, { key: 'max_discount_pct', label: 'Max discount', type: 'pct' }, { key: 'permissions', label: 'Permissions', render: (r) => `${r.permissions.length} of ${perms.length}` }] })}</div>`);
      }
    } catch (e) { showError(e); }
  };
  const userFields = (isNew) => [{ name: 'full_name', label: 'Full name', required: true }, { name: 'username', label: 'Username', required: isNew, disabled: !isNew, hint: 'Letters, numbers, dot, dash' },
    { name: 'role_id', label: 'Role', type: 'select', required: true, options: roles.map((r) => ({ value: r.id, label: r.name })) }, { name: 'home_location_id', label: 'Home store', type: 'select', placeholder: '—', options: S.lookups.locations.map((l) => ({ value: l.id, label: l.name })) },
    { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' },
    { name: 'password', label: isNew ? 'Temporary password' : 'Reset password (optional)', type: 'password', required: isNew, hint: 'User must change it at first sign-in. 8+ chars, letters & numbers.' }, { name: 'pin', label: isNew ? 'Till PIN (optional)' : 'Set new PIN (optional)', type: 'password', maxlength: 8, hint: '4–8 digits, used for quick sign-in and approvals' },
    { name: 'is_active', label: 'Account active', type: 'checkbox' }];
  on(el, 'click', '[data-tab]', (e, b) => { st.tab = b.dataset.tab; $$('[data-tab]', el).forEach((x) => x.classList.toggle('on', x === b)); load(); });
  on(el, 'click', '[data-newuser]', async () => { const r = await formDlg({ title: 'New staff account', size: 'wide', fields: userFields(true), values: { is_active: true }, submitText: 'Create account', submit: (v) => post('/api/admin/users', v) }); if (r) { toast('Account created', 'ok'); load(); } });
  on(el, 'click', '[data-uid]', async (e, tr) => {
    const users = await get('/api/admin/users'); const u = users.find((x) => x.id === tr.dataset.uid);
    const r = await formDlg({ title: u.full_name, sub: `@${u.username}`, size: 'wide', fields: userFields(false), values: { ...u, is_active: !!u.is_active }, submitText: 'Save', submit: (v) => { const b = { ...v, username: undefined }; if (!b.password) delete b.password; if (!b.pin) delete b.pin; return put(`/api/admin/users/${u.id}`, b); } });
    if (r) { toast('Saved', 'ok'); load(); }
  });
  const roleDialog = async (role) => {
    const cats = [...new Set(perms.map((p) => p.category))];
    const has = new Set(role ? role.permissions : []);
    const m = modal({
      title: role ? role.name : 'New role', sub: role && role.code === 'owner' ? 'The owner role always has full access.' : 'Tick what this role may do.', size: 'xwide',
      body: html`<form class="stack" data-rf><div class="grid g3">${role ? '' : html`<div class="field"><label>Code</label><input class="input" name="code" required pattern="[a-z_]+" placeholder="e.g. deli_clerk"></div>`}<div class="field"><label>Name</label><input class="input" name="name" required value="${role ? role.name : ''}"></div>
        <div class="field"><label>Max discount without approval (%)</label><input class="input" name="max_discount_pct" type="number" min="0" max="100" step="0.5" value="${role ? role.max_discount_pct : 0}"></div><div class="field ${role ? '' : 'full'}"><label>Description</label><input class="input" name="description" value="${role ? role.description || '' : ''}"></div></div>
        <div class="grid g3">${cats.map((c) => html`<div class="panel panel-body"><div class="label" style="margin-bottom:6px">${c}</div>${perms.filter((p) => p.category === c).map((p) => html`<label class="check" style="display:flex;margin:4px 0;align-items:flex-start"><input type="checkbox" name="perm" value="${p.code}" ${has.has(p.code) ? 'checked' : ''} ${role && role.code === 'owner' ? 'disabled' : ''}><span><span class="small">${p.description}</span><br><span class="xs muted mono">${p.code}</span></span></label>`)}</div>`)}</div>
        <div class="callout bad hidden" data-err></div></form>`,
      foot: html`<button class="btn" data-dismiss>Cancel</button>${role && role.code === 'owner' ? '' : html`<button class="btn primary" data-save>Save role</button>`}`,
    });
    on(m.el, 'click', '[data-save]', async () => {
      const f = $('[data-rf]', m.el); const err = $('[data-err]', m.el);
      const body = { name: f.name.value, description: f.description.value || null, max_discount_pct: Number(f.max_discount_pct.value), permissions: $$('input[name=perm]:checked', f).map((i) => i.value), ...(role ? {} : { code: f.code.value }) };
      try { if (role) await put(`/api/admin/roles/${role.id}`, body); else await post('/api/admin/roles', body); toast('Role saved', 'ok'); m.close(); load(); } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    });
  };
  on(el, 'click', '[data-newrole]', () => roleDialog(null));
  on(el, 'click', '[data-rid]', (e, tr) => roleDialog(roles.find((r) => r.id === tr.dataset.rid)));
  load();
}

// ─────────────── settings ───────────────
const TABS = [['business', 'Business', 'settings.manage'], ['pos', 'Checkout & receipts', 'settings.manage'], ['tax', 'Tax rates', 'settings.manage'], ['payments', 'Payment methods', 'settings.manage'], ['stores', 'Stores & registers', 'settings.manage'],
  ['accounts', 'Accounts & suppliers', 'settings.manage'], ['hardware', 'Hardware', 'settings.manage'], ['network', 'Network & sync', 'sync.manage']];

async function settings(el, nav) {
  nav.setTitle('Settings');
  const tabs = TABS.filter((t) => can(t[2]));
  let tab = nav.params[0] && tabs.find((t) => t[0] === nav.params[0]) ? nav.params[0] : tabs[0][0];
  mount(el, html`<div class="page-head"><div><h1>Settings</h1><div class="sub">Every change here is recorded in the audit log with old and new values.</div></div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`)}</div><div data-body></div>`);
  const body = $('[data-body]', el);
  const load = async () => {
    try {
      const T = { business: tabBusiness, pos: tabPos, tax: tabTax, payments: tabPayments, stores: tabStores, accounts: tabAccounts, hardware: tabHardware, network: tabNetwork }[tab];
      await T(body, load);
    } catch (e) { showError(e); }
  };
  on(el, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; $$('[data-tab]', el).forEach((x) => x.classList.toggle('on', x === b)); history.replaceState(null, '', `#/settings/${tab}`); load(); });
  load();
}

async function refreshMe() { S.me = await get('/api/me'); S.lookups = await get('/api/lookups'); }

async function tabBusiness(body) {
  const b = await get('/api/admin/business');
  const fields = [{ name: 'name', label: 'Trading name', required: true }, { name: 'legal_name', label: 'Registered name' }, { name: 'tax_id', label: 'Tax ID (TIN/VAT no.)' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'website', label: 'Website' },
    { name: 'address', label: 'Head office address', full: true }, { name: 'currency', label: 'Currency (ISO 4217)', required: true, maxlength: 3, hint: 'Locked once sales exist' }, { name: 'currency_minor', label: 'Decimal places', type: 'number', min: 0, max: 3 },
    { name: 'locale', label: 'Number format locale', hint: 'e.g. en-NG, en-GB, fr-FR' }, { name: 'timezone', label: 'Time zone', hint: 'IANA name, e.g. Africa/Lagos' }, { name: 'prices_include_tax', label: 'Shelf prices include tax (tax is extracted, not added)', type: 'checkbox', full: true }];
  const { formHtml, readForm } = await import('../ui.js');
  mount(body, html`<div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)"><form class="panel panel-body stack" data-f>${formHtml(fields, { ...b, prices_include_tax: !!b.prices_include_tax })}<div class="row"><button class="btn primary">Save business details</button></div></form>
    <div class="panel panel-body stack"><div class="label">Logo (receipts & sign-in)</div><div class="brand-mark" style="width:88px;height:88px;font-size:30px">${b.logo_data ? html`<img alt="" src="${b.logo_data}">` : 'M'}</div>
      <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" data-logo><div class="xs muted">PNG/JPEG/SVG/WebP, under 300 KB.</div>${b.logo_data ? html`<button class="btn sm" data-rmlogo>Remove logo</button>` : ''}</div></div>`);
  $('[data-f]', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const v = readForm(e.target, fields); await put('/api/admin/business', { ...v, currency: (v.currency || '').toUpperCase() }); await refreshMe(); toast('Business details saved', 'ok'); } catch (ex) { showError(ex); }
  });
  const saveLogo = async (data) => { try { await put('/api/admin/business', { ...b, currency: b.currency, prices_include_tax: !!b.prices_include_tax, logo_data: data }); await refreshMe(); toast('Logo updated', 'ok'); tabBusiness(body); } catch (ex) { showError(ex); } };
  on(body, 'change', '[data-logo]', (e, i) => { const f = i.files[0]; if (!f) return; if (f.size > 300000) return toast('Logo must be under 300 KB', 'bad'); const r = new FileReader(); r.onload = () => saveLogo(r.result); r.readAsDataURL(f); });
  on(body, 'click', '[data-rmlogo]', () => saveLogo(null));
}

async function tabPos(body) {
  const b = await get('/api/admin/business'); const s = b.settings;
  const fields = [
    { name: 'receipt.header', label: 'Receipt header line', full: true }, { name: 'receipt.footer', label: 'Receipt footer', full: true, type: 'textarea', rows: 2 },
    { name: 'receipt.show_tax_breakdown', label: 'Show tax breakdown on receipts', type: 'checkbox' }, { name: 'receipt.show_cashier', label: 'Show cashier name on receipts', type: 'checkbox' },
    { name: 'receipt.auto_print', label: 'Print receipt automatically after each sale', type: 'checkbox' }, { name: 'receipt.width_chars', label: 'Thermal receipt width (characters)', type: 'number', min: 32, max: 64 },
    { name: 'pos.allow_negative_stock', label: 'Allow selling when system stock is zero (warn only)', type: 'checkbox' }, { name: 'pos.blind_close', label: 'Blind close — cashiers count before seeing expected cash', type: 'checkbox' },
    { name: 'pos.variance_review_threshold', label: 'Cash variance needing manager review', money: true }, { name: 'pos.idle_lock_minutes', label: 'Lock idle terminals after (minutes)', type: 'number', min: 1, max: 120 },
    { name: 'pos.open_drawer_on_cash', label: 'Open cash drawer on cash transactions', type: 'checkbox' }, { name: 'refund.max_days', label: 'Return window (days)', type: 'number', min: 0, max: 365 },
    { name: 'barcode.variable_weight_enabled', label: 'Read price/weight-embedded scale labels (EAN-13 prefix 21/22, weight in grams)', type: 'checkbox', full: true },
    { name: 'loyalty.enabled', label: 'Loyalty points enabled', type: 'checkbox' }, { name: 'loyalty.points_per_currency_unit', label: 'Points per 1 unit of currency', type: 'number', step: '0.001', min: 0 },
    { name: 'security.session_idle_minutes', label: 'Sign-out after inactivity (minutes)', type: 'number', min: 5, max: 720 }, { name: 'security.max_failed_logins', label: 'Lock account after failed sign-ins', type: 'number', min: 3, max: 20 },
  ];
  const { formHtml, readForm } = await import('../ui.js');
  mount(body, html`<form class="panel panel-body stack" data-f>${formHtml(fields, s)}<div class="row"><button class="btn primary">Save</button></div></form>`);
  $('[data-f]', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const v = readForm(e.target, fields); for (const k of Object.keys(v)) if (v[k] === null) v[k] = typeof s[k] === 'string' ? '' : s[k]; await put('/api/admin/settings', v); await refreshMe(); toast('Settings saved', 'ok'); } catch (ex) { showError(ex); }
  });
}

async function tabTax(body, reload) {
  const rates = await get('/api/tax-rates');
  mount(body, html`<div class="stack"><div class="callout info">Tax configuration is yours to set — this system does not decide which goods are taxable. Confirm rates and exemptions with your tax adviser.</div>
    <div class="row"><button class="btn primary" data-new>Add tax rate</button></div><div class="panel">${table({ rows: rates, onRowAttr: (r) => `class="clickable" data-id="${r.id}"`, columns: [{ key: 'code', label: 'Code', cls: 'mono' }, { key: 'name', label: 'Name' }, { key: 'rate_bp', label: 'Rate', num: true, render: (r) => `${(r.rate_bp / 100).toFixed(2)}%` }, { key: 'is_active', label: 'Status', render: (r) => badge(r.is_active ? 'active' : 'inactive') }] })}</div></div>`);
  const fields = [{ name: 'code', label: 'Code', required: true, hint: 'UPPERCASE, e.g. VAT' }, { name: 'name', label: 'Name', required: true }, { name: 'rate', label: 'Rate (%)', type: 'number', step: '0.01', min: 0, max: 100, required: true }, { name: 'is_active', label: 'Active', type: 'checkbox' }];
  const save = (id) => (v) => { const b = { code: v.code, name: v.name, rate_bp: Math.round(Number(v.rate) * 100), is_active: v.is_active }; return id ? put(`/api/tax-rates/${id}`, b) : post('/api/tax-rates', b); };
  on(body, 'click', '[data-new]', async () => { if (await formDlg({ title: 'Add tax rate', size: 'narrow', cls: 'stack', fields, values: { is_active: true }, submit: save(null) })) { await refreshMe(); reload(); } });
  on(body, 'click', '[data-id]', async (e, tr) => { const r = rates.find((x) => x.id === tr.dataset.id); if (await formDlg({ title: 'Edit tax rate', sub: 'Changes apply to new sales only; completed sales keep the rate they were sold at.', size: 'narrow', cls: 'stack', fields, values: { ...r, rate: r.rate_bp / 100, is_active: !!r.is_active }, submit: save(r.id) })) { await refreshMe(); reload(); } });
}

async function tabPayments(body, reload) {
  const [methods, providers] = await Promise.all([get('/api/admin/payment-methods'), get('/api/admin/providers')]);
  mount(body, html`<div class="stack">
    <div class="panel"><div class="panel-head"><h2>Payment methods (what the cashier sees)</h2><button class="btn primary sm" data-new>Add method</button></div>
      ${table({ rows: methods, onRowAttr: (m) => `class="clickable" data-mid="${m.id}"`, columns: [{ key: 'name', label: 'Method' }, { key: 'type', label: 'Type', render: (m) => titleCase(m.type) }, { key: 'provider_name', label: 'Processed by', render: (m) => html`${m.provider_name} ${m.test_mode ? html`<span class="badge warn plain">TEST</span>` : ''}` },
        { key: 'allow_offline', label: 'Works offline', render: (m) => (m.allow_offline ? 'Yes' : 'No') }, { key: 'shortcut', label: 'Key' }, { key: 'is_active', label: 'Status', render: (m) => badge(m.is_active ? 'active' : 'inactive') }] })}</div>
    <div class="panel"><div class="panel-head"><h2>Payment provider adapters</h2></div>${table({ rows: providers, onRowAttr: (p) => `class="clickable" data-pc="${p.code}"`, columns: [{ key: 'display_name', label: 'Adapter' }, { key: 'code', label: 'Code', cls: 'mono' },
      { key: 'integration', label: 'Integration', render: (p) => badge(p.integration === 'integrated' ? 'integrated' : p.integration === 'test_only' ? 'test_only' : 'not_integrated', p.integration === 'test_only' ? 'Test simulator' : titleCase(p.integration)) }, { key: 'mode', label: 'Mode', render: (p) => (p.mode ? titleCase(p.mode) : '—') }, { key: 'has_secret', label: 'Secret', render: (p) => (p.kind === 'local' ? '—' : p.has_secret ? 'Stored (encrypted)' : 'Not set') }, { key: 'is_active', label: 'Status', render: (p) => badge(p.is_active ? 'active' : 'inactive') }] })}
      <div class="panel-body muted small" style="border-top:1px solid var(--line)">Real gateways (card terminals, bank transfer APIs, mobile money) plug in as adapters implementing the PaymentProvider interface — see <span class="mono">server/services/payments/providers/http-gateway-template.js</span>. Card data never passes through this application.</div></div></div>`);
  const mFields = [{ name: 'name', label: 'Button label', required: true }, { name: 'code', label: 'Code', required: true, hint: 'lowercase, e.g. card2' }, { name: 'type', label: 'Type', type: 'select', required: true, options: ['cash', 'card', 'bank_transfer', 'mobile_money', 'wallet', 'other'].map((t) => ({ value: t, label: titleCase(t) })) },
    { name: 'provider_code', label: 'Processed by', type: 'select', required: true, options: providers.map((p) => ({ value: p.code, label: p.display_name })) }, { name: 'sort_order', label: 'Order', type: 'number', min: 0 }, { name: 'shortcut', label: 'Keyboard shortcut', hint: 'e.g. F11' },
    { name: 'allow_offline', label: 'Allow while offline (local/manual adapters only)', type: 'checkbox' }, { name: 'requires_reference', label: 'Require reference/approval code', type: 'checkbox' }, { name: 'is_active', label: 'Active', type: 'checkbox' }];
  const saveM = (id) => (v) => (id ? put(`/api/admin/payment-methods/${id}`, v) : post('/api/admin/payment-methods', v));
  on(body, 'click', '[data-new]', async () => { if (await formDlg({ title: 'Add payment method', size: 'wide', fields: mFields, values: { is_active: true, allow_offline: false }, submit: saveM(null) })) { await refreshMe(); reload(); } });
  on(body, 'click', '[data-mid]', async (e, tr) => { const m = methods.find((x) => x.id === tr.dataset.mid); if (await formDlg({ title: m.name, size: 'wide', fields: mFields, values: { ...m, allow_offline: !!m.allow_offline, requires_reference: !!m.requires_reference, is_active: !!m.is_active }, submit: saveM(m.id) })) { await refreshMe(); reload(); } });
  on(body, 'click', '[data-pc]', async (e, tr) => {
    const p = providers.find((x) => x.code === tr.dataset.pc);
    if (p.kind === 'local') return toast('Local adapters have no configuration', '');
    const r = await formDlg({
      title: p.display_name, sub: `${p.code} · ${p.integration === 'test_only' ? 'TEST-MODE simulator' : p.integration}`, size: 'wide',
      fields: [{ name: 'display_name', label: 'Display name', required: true }, { name: 'config', label: 'Settings (JSON, non-secret)', type: 'textarea', rows: 5, full: true, hint: p.kind === 'simulated' ? 'scenario: auto_approve | await_customer · delay_ms · terminal_id' : 'e.g. base_url, merchant_id, terminal_id' },
        { name: 'secret', label: 'API secret / webhook signing key', type: 'password', full: true, hint: p.has_secret ? 'A secret is stored (encrypted). Leave blank to keep it.' : 'Stored encrypted; never shown again' }, { name: 'is_active', label: 'Active', type: 'checkbox' }],
      values: { display_name: p.display_name, config: JSON.stringify(p.config, null, 2), is_active: p.is_active },
      submit: (v) => { let cfg; try { cfg = JSON.parse(v.config || '{}'); } catch (_) { throw new Error('Settings must be valid JSON'); } return put(`/api/admin/providers/${p.code}`, { display_name: v.display_name, config: cfg, secret: v.secret || undefined, is_active: v.is_active }); },
    });
    if (r) { toast('Provider saved', 'ok'); reload(); }
  });
}

async function tabStores(body, reload) {
  const b = await get('/api/admin/business');
  mount(body, html`<div class="grid g2"><div class="panel"><div class="panel-head"><h2>Locations</h2><button class="btn sm primary" data-newloc>Add location</button></div>
      ${table({ rows: b.locations, onRowAttr: (l) => `class="clickable" data-lid="${l.id}"`, columns: [{ key: 'code', label: 'Code', cls: 'mono' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type', render: (l) => titleCase(l.type) }, { key: 'is_active', label: 'Status', render: (l) => badge(l.is_active ? 'active' : 'inactive') }] })}</div>
    <div class="panel"><div class="panel-head"><h2>Registers (lanes)</h2><button class="btn sm primary" data-newreg>Add register</button></div>
      ${table({ rows: b.registers, onRowAttr: (r) => `class="clickable" data-rid="${r.id}"`, columns: [{ key: 'code', label: 'Code', cls: 'mono', render: (r) => `${r.location_code}-${r.code}` }, { key: 'name', label: 'Name' }, { key: 'location_name', label: 'Location' }, { key: 'next_sale_seq', label: 'Next receipt #', type: 'int' }, { key: 'is_active', label: 'Status', render: (r) => badge(r.is_active ? 'active' : 'inactive') }] })}</div></div>`);
  const lf = [{ name: 'code', label: 'Code', required: true, maxlength: 6, hint: 'Used in receipt numbers' }, { name: 'name', label: 'Name', required: true }, { name: 'type', label: 'Type', type: 'select', options: [{ value: 'store', label: 'Store' }, { value: 'warehouse', label: 'Warehouse' }] }, { name: 'phone', label: 'Phone' }, { name: 'address', label: 'Address', full: true }, { name: 'is_active', label: 'Active', type: 'checkbox' }];
  const rf = [{ name: 'location_id', label: 'Location', type: 'select', required: true, options: b.locations.map((l) => ({ value: l.id, label: l.name })) }, { name: 'code', label: 'Code', required: true, maxlength: 6 }, { name: 'name', label: 'Name', required: true }, { name: 'is_active', label: 'Active', type: 'checkbox' }];
  const done = async (r) => { if (r) { await refreshMe(); reload(); } };
  on(body, 'click', '[data-newloc]', async () => done(await formDlg({ title: 'Add location', size: 'wide', fields: lf, values: { is_active: true, type: 'store' }, submit: (v) => post('/api/admin/locations', v) })));
  on(body, 'click', '[data-lid]', async (e, tr) => { const l = b.locations.find((x) => x.id === tr.dataset.lid); done(await formDlg({ title: l.name, size: 'wide', fields: lf, values: { ...l, is_active: !!l.is_active }, submit: (v) => put(`/api/admin/locations/${l.id}`, v) })); });
  on(body, 'click', '[data-newreg]', async () => done(await formDlg({ title: 'Add register', size: 'narrow', cls: 'stack', fields: rf, values: { is_active: true }, submit: (v) => post('/api/admin/registers', v) })));
  on(body, 'click', '[data-rid]', async (e, tr) => { const r = b.registers.find((x) => x.id === tr.dataset.rid); done(await formDlg({ title: r.name, size: 'narrow', cls: 'stack', fields: rf, values: { ...r, is_active: !!r.is_active }, submit: (v) => put(`/api/admin/registers/${r.id}`, v) })); });
}

async function tabAccounts(body, reload) {
  const [accounts, suppliers] = await Promise.all([get('/api/accounts'), get('/api/suppliers')]);
  mount(body, html`<div class="grid g2"><div class="panel"><div class="panel-head"><h2>Financial accounts</h2><button class="btn sm primary" data-newacc>Add account</button></div>
      ${table({ rows: accounts, onRowAttr: (a) => `class="clickable" data-aid="${a.id}"`, columns: [{ key: 'code', label: 'Code', cls: 'mono' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type', render: (a) => titleCase(a.type) }, { key: 'account_mask', label: 'Account', render: (a) => (a.account_mask ? `${a.bank_name || ''} ••${a.account_mask}` : '—') }] })}
      <div class="panel-body xs muted" style="border-top:1px solid var(--line)">Only the last 4 digits of bank accounts are stored.</div></div>
    <div class="panel"><div class="panel-head"><h2>Suppliers</h2><button class="btn sm primary" data-newsup>Add supplier</button></div>
      ${table({ rows: suppliers, onRowAttr: (s) => `class="clickable" data-sid="${s.id}"`, columns: [{ key: 'name', label: 'Supplier' }, { key: 'contact_name', label: 'Contact' }, { key: 'phone', label: 'Phone' }, { key: 'is_active', label: 'Status', render: (s) => badge(s.is_active ? 'active' : 'inactive') }] })}</div></div>`);
  const af = [{ name: 'code', label: 'Code', required: true, hint: 'UPPERCASE' }, { name: 'name', label: 'Name', required: true }, { name: 'type', label: 'Type', type: 'select', required: true, options: ['cash_safe', 'bank', 'provider_balance', 'other'].map((t) => ({ value: t, label: titleCase(t) })) }, { name: 'provider_code', label: 'Provider code (provider balances)' }, { name: 'bank_name', label: 'Bank' }, { name: 'account_mask', label: 'Last 4 digits', maxlength: 4 }, { name: 'is_active', label: 'Active', type: 'checkbox' }];
  const sf = [{ name: 'name', label: 'Name', required: true }, { name: 'contact_name', label: 'Contact person' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'address', label: 'Address', full: true }, { name: 'is_active', label: 'Active', type: 'checkbox' }];
  const done = async (r) => { if (r) { await refreshMe(); reload(); } };
  on(body, 'click', '[data-newacc]', async () => done(await formDlg({ title: 'Add account', size: 'wide', fields: af, values: { is_active: true }, submit: (v) => post('/api/accounts', v) })));
  on(body, 'click', '[data-aid]', async (e, tr) => { const a = accounts.find((x) => x.id === tr.dataset.aid); done(await formDlg({ title: a.name, size: 'wide', fields: af, values: { ...a, is_active: !!a.is_active }, submit: (v) => put(`/api/accounts/${a.id}`, v) })); });
  on(body, 'click', '[data-newsup]', async () => done(await formDlg({ title: 'Add supplier', size: 'wide', fields: sf, values: { is_active: true }, submit: (v) => post('/api/suppliers', v) })));
  on(body, 'click', '[data-sid]', async (e, tr) => { const s = suppliers.find((x) => x.id === tr.dataset.sid); done(await formDlg({ title: s.name, size: 'wide', fields: sf, values: { ...s, is_active: !!s.is_active }, submit: (v) => put(`/api/suppliers/${s.id}`, v) })); });
}

async function tabHardware(body, reload) {
  const devices = await get('/api/hardware');
  const b = await get('/api/admin/business'); const s = b.settings;
  mount(body, html`<div class="stack"><div class="callout info">Status is honest: <strong>Integrated</strong> works in this build; <strong>Experimental</strong> is implemented to the published protocol but not verified on physical hardware; <strong>Not integrated</strong> needs an adapter.</div>
    <div class="grid g2">${devices.map((d) => html`<div class="panel"><div class="panel-head"><h3>${d.label}</h3><span class="muted small">Using: <span class="mono">${d.selected}</span></span></div><div class="panel-body stack tight">${d.adapters.map((a) => html`<div><div class="row">${badge(a.status, titleCase(a.status))} <strong class="mono small">${a.code}</strong></div><div class="xs muted">${a.note}</div></div>`)}</div></div>`)}</div>
    <form class="panel panel-body grid g3" data-hw><div class="field"><label>Receipt printer</label><select class="input" name="hardware.receipt_printer">${['system', 'escpos_network', 'file_spool'].map((x) => html`<option value="${x}" ${s['hardware.receipt_printer'] === x ? 'selected' : ''}>${x}</option>`)}</select></div>
      <div class="field"><label>Printer host:port (ESC/POS)</label><input class="input" name="hardware.receipt_printer_host" value="${s['hardware.receipt_printer_host']}" placeholder="192.168.1.50:9100"></div>
      <div class="field"><label>Cash drawer</label><select class="input" name="hardware.cash_drawer">${['none', 'escpos_kick'].map((x) => html`<option value="${x}" ${s['hardware.cash_drawer'] === x ? 'selected' : ''}>${x}</option>`)}</select></div>
      <div><button class="btn primary">Save hardware settings</button></div></form></div>`);
  $('[data-hw]', body).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try { await put('/api/admin/settings', { 'hardware.receipt_printer': f['hardware.receipt_printer'].value, 'hardware.receipt_printer_host': f['hardware.receipt_printer_host'].value, 'hardware.cash_drawer': f['hardware.cash_drawer'].value }); await refreshMe(); toast('Hardware settings saved', 'ok'); reload(); } catch (ex) { showError(ex); }
  });
}

async function tabNetwork(body, reload) {
  const [n, ob] = await Promise.all([get('/api/network'), get('/api/sync/outbox?limit=100')]);
  mount(body, html`<div class="stack"><div class="grid g3">
      <div class="panel kpi"><div class="label">Connectivity</div><div class="value" style="font-size:20px">${n.online ? badge('active', 'Online') : badge('failed', 'Offline')}</div><div class="delta muted">Checked ${ago(n.last_check)} · ${n.providers.map((p) => `${p.code}: ${p.ok ? 'ok' : 'down'}`).join(', ') || 'no electronic providers'}</div></div>
      <div class="panel kpi"><div class="label">Sync queue</div><div class="value">${(ob.stats.pending || 0) + (ob.stats.failed || 0)}</div><div class="delta muted">${ob.stats.sent || 0} sent · ${ob.stats.conflict || 0} conflicts</div></div>
      <div class="panel kpi"><div class="label">Payments in flight</div><div class="value">${n.inflight_payments}</div><div class="delta muted">re-checked automatically</div></div></div>
    <div class="panel panel-body stack"><h3>Offline operation</h3>
      <p class="muted" style="margin:0">When providers are unreachable: cash and manually-confirmed methods keep working and sales complete locally; card, transfer and mobile payments are refused (never assumed successful); in-flight payments stay pending and are re-queried when the connection returns; completed records queue in the sync outbox.</p>
      <div class="row">${n.simulated_offline ? html`<button class="btn primary" data-sim="0">End simulated outage</button>` : html`<button class="btn danger" data-sim="1">Simulate network outage (test)</button>`}<button class="btn" data-probe>Check now</button><button class="btn" data-flush>Sync now</button></div></div>
    <div class="panel"><div class="panel-head"><h3>Sync outbox</h3><span class="muted small">Transactional outbox → head office</span></div>
      ${table({ rows: ob.rows, empty: 'Nothing queued', columns: [{ key: 'seq', label: '#', type: 'int' }, { key: 'entity_type', label: 'Record' }, { key: 'entity_id', label: 'ID', cls: 'mono' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'attempts', label: 'Attempts', type: 'int' }, { key: 'last_error', label: 'Last error' }, { key: 'created_at', label: 'Queued', type: 'datetime' },
        { key: 'x', label: '', render: (r) => (['conflict', 'failed'].includes(r.status) ? html`<button class="btn sm" data-retry="${r.seq}">Retry</button> <button class="btn sm" data-resolve="${r.seq}">Mark resolved</button>` : '') }] })}</div></div>`);
  on(body, 'click', '[data-sim]', async (e, b) => { try { await post('/api/network/simulate', { offline: b.dataset.sim === '1' }); toast(b.dataset.sim === '1' ? 'Simulated outage started — electronic payments disabled' : 'Back online', b.dataset.sim === '1' ? 'warn' : 'ok'); const { refreshNetwork } = await import('../app.js'); refreshNetwork(); reload(); } catch (ex) { showError(ex); } });
  on(body, 'click', '[data-probe]', async () => { await post('/api/network/probe'); reload(); });
  on(body, 'click', '[data-flush]', async () => { const r = await post('/api/sync/flush'); toast(`${r.pushed} record(s) processed`, 'ok'); reload(); });
  on(body, 'click', '[data-retry]', async (e, b) => { await post(`/api/sync/outbox/${b.dataset.retry}/resolve`, { action: 'retry' }); reload(); });
  on(body, 'click', '[data-resolve]', async (e, b) => { const v = await formDlg({ title: 'Resolve sync conflict', size: 'narrow', cls: 'stack', fields: [{ name: 'note', label: 'How was it resolved?', type: 'textarea', required: true }], submit: (x) => post(`/api/sync/outbox/${b.dataset.resolve}/resolve`, { action: 'mark_resolved', note: x.note }) }); if (v) reload(); });
}
void money; void dt; void qs; void toMajor; void toMinor;
