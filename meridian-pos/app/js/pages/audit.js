// Audit log — append-only, hash-chained.
import { get, qs } from '../api.js';
import { S, html, mount, $, on, dt, showError, toast, modal, table, periodHtml, bindPeriod, debounce } from '../ui.js';

const GROUPS = [['', 'All events'], ['auth', 'Sign-in & overrides'], ['sale', 'Sales & discounts'], ['payment', 'Payments'], ['refund', 'Refunds'], ['product', 'Products & prices'], ['inventory', 'Inventory'], ['session', 'Cash sessions'], ['payout', 'Payouts'], ['settlement', 'Settlements'], ['reconciliation', 'Reconciliation'], ['user', 'Users'], ['role', 'Roles'], ['settings', 'Settings'], ['drawer', 'Drawer opens']];

export async function render(el, nav) {
  nav.setTitle('Audit log');
  const f = { period: 'today', from: '', to: '', action: '', user_id: '', q: '' };
  mount(el, html`<div class="page-head"><div><h1>Audit log</h1><div class="sub">Who did what, when, with old and new values. Entries cannot be edited or deleted, and each is chained to the previous by a hash.</div></div><button class="btn" data-verify>Verify integrity</button></div>
    <div class="filters">${periodHtml(f)}<select class="input" data-action style="width:190px">${GROUPS.map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
      <select class="input" data-user style="width:180px"><option value="">Everyone</option>${S.lookups.staff.map((u) => html`<option value="${u.id}">${u.full_name}</option>`)}</select><input class="input" data-q placeholder="Reference, user, action" style="width:220px"></div>
    <div class="panel" data-list></div>`);
  let rows = [];
  const load = async () => {
    try {
      rows = await get(`/api/audit${qs({ ...f, limit: 500 })}`);
      mount($('[data-list]', el), table({ rows, empty: 'No events', onRowAttr: (r) => `class="clickable" data-seq="${r.seq}"`,
        columns: [{ key: 'occurred_at', label: 'When', render: (r) => dt(r.occurred_at, { seconds: true }) }, { key: 'username', label: 'User' }, { key: 'action', label: 'Action', cls: 'mono' }, { key: 'reference', label: 'Reference', cls: 'mono' },
          { key: 'approved_by_name', label: 'Approved by', render: (r) => r.approved_by_name || '' }, { key: 'change', label: 'Change', render: (r) => html`<span class="xs muted">${summarize(r)}</span>` }] }));
    } catch (e) { showError(e); }
  };
  bindPeriod(el, f, load);
  on(el, 'change', '[data-action]', (e, s) => { f.action = s.value; load(); });
  on(el, 'change', '[data-user]', (e, s) => { f.user_id = s.value; load(); });
  on(el, 'input', '[data-q]', debounce((e) => { f.q = e.target.value; load(); }, 300));
  on(el, 'click', 'tr[data-seq]', (e, tr) => {
    const r = rows.find((x) => String(x.seq) === tr.dataset.seq);
    const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch (_) { return s; } };
    modal({ title: r.action, sub: `${dt(r.occurred_at, { seconds: true })} · ${r.username}${r.terminal ? ` · terminal ${r.terminal}` : ''}`, size: 'wide',
      body: html`<div class="stack"><dl class="kv"><dt>Entity</dt><dd>${r.entity_type || '—'} <span class="mono xs">${r.entity_id || ''}</span></dd><dt>Reference</dt><dd>${r.reference || '—'}</dd><dt>Approved by</dt><dd>${r.approved_by_name || '—'}</dd></dl>
        ${r.old_value ? html`<div><div class="label">Old value</div><pre class="mono panel panel-body" style="white-space:pre-wrap;margin:4px 0 0">${pretty(r.old_value)}</pre></div>` : ''}
        ${r.new_value ? html`<div><div class="label">New value</div><pre class="mono panel panel-body" style="white-space:pre-wrap;margin:4px 0 0">${pretty(r.new_value)}</pre></div>` : ''}
        ${r.meta ? html`<div><div class="label">Details</div><pre class="mono panel panel-body" style="white-space:pre-wrap;margin:4px 0 0">${pretty(r.meta)}</pre></div>` : ''}</div>` });
  });
  on(el, 'click', '[data-verify]', async () => {
    try { const r = await get('/api/audit/verify'); r.ok ? toast(`Audit chain intact — ${r.count} entries verified`, 'ok') : toast(`Audit chain BROKEN at entry ${r.brokenAt}: ${r.reason}`, 'bad'); } catch (e) { showError(e); }
  });
  load();
}

function summarize(r) {
  try {
    const o = r.old_value ? JSON.parse(r.old_value) : null; const n = r.new_value ? JSON.parse(r.new_value) : null;
    if (o && n && typeof o === 'object' && typeof n === 'object') return Object.keys(n).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k])).slice(0, 3).map((k) => `${k}: ${JSON.stringify(o[k])} → ${JSON.stringify(n[k])}`).join('; ').slice(0, 140);
    if (n) return JSON.stringify(n).slice(0, 140);
    if (r.meta) return r.meta.slice(0, 140);
  } catch (_) { /* ignore */ }
  return '';
}
