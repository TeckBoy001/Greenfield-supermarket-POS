// Customers — optional; walk-in sales never need one.
import { get, post, put, qs } from '../api.js';
import { html, mount, $, on, money, dt, toast, showError, modal, formDlg, table, can, debounce, badge } from '../ui.js';

const FIELDS = [
  { name: 'full_name', label: 'Full name', required: true, full: true }, { name: 'phone', label: 'Phone', placeholder: '+234…' }, { name: 'email', label: 'Email', type: 'email' },
  { name: 'address', label: 'Address', full: true }, { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
  { name: 'marketing_consent', label: 'Agrees to marketing messages', type: 'checkbox' },
];

export async function render(el, nav) {
  nav.setTitle('Customers');
  const f = { q: '' };
  mount(el, html`<div class="page-head"><div><h1>Customers</h1><div class="sub">Purchase history and loyalty for customers who choose to be identified. Personal details are kept to the minimum needed.</div></div>${can('customer.edit') ? html`<button class="btn primary" data-new>New customer</button>` : ''}</div>
    <div class="filters"><input class="input" data-q placeholder="Search name, phone, email or code" style="width:320px"></div><div class="panel" data-list></div>`);
  const load = async () => {
    try {
      const r = await get(`/api/customers${qs({ q: f.q, limit: 200 })}`);
      mount($('[data-list]', el), table({ rows: r.rows, empty: 'No customers found', onRowAttr: (c) => `class="clickable" data-id="${c.id}"`,
        columns: [{ key: 'code', label: 'Code', cls: 'mono' }, { key: 'full_name', label: 'Name', render: (c) => html`${c.full_name} ${!c.is_active ? badge('inactive') : ''}` }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
          { key: 'visits', label: 'Visits', type: 'int' }, { key: 'lifetime_spend', label: 'Lifetime spend', type: 'money' }, { key: 'loyalty_points', label: 'Points', type: 'int' }, { key: 'last_visit', label: 'Last visit', type: 'datetime' }] }));
    } catch (e) { showError(e); }
  };
  on(el, 'input', '[data-q]', debounce((e) => { f.q = e.target.value; load(); }, 250));
  on(el, 'click', '[data-new]', async () => { const c = await formDlg({ title: 'New customer', size: 'wide', fields: FIELDS, submitText: 'Create', submit: (v) => post('/api/customers', v) }); if (c) { toast(`Customer ${c.code} created`, 'ok'); load(); } });
  on(el, 'click', 'tr[data-id]', async (e, tr) => { await customerModal(tr.dataset.id); load(); });
  load();
}

async function customerModal(id) {
  let c;
  try { c = await get(`/api/customers/${id}`); } catch (e) { return showError(e); }
  const m = modal({
    title: c.full_name, sub: `${c.code} · customer since ${dt(c.created_at, { time: false })}`, size: 'wide',
    body: html`<div class="stack"><div class="grid g4">
      <div class="panel kpi"><div class="label">Visits</div><div class="value">${c.stats.visits}</div></div><div class="panel kpi"><div class="label">Lifetime spend</div><div class="value" style="font-size:20px">${money(c.stats.lifetime_spend)}</div></div>
      <div class="panel kpi"><div class="label">Avg basket</div><div class="value" style="font-size:20px">${money(Math.round(c.stats.avg_basket))}</div></div><div class="panel kpi"><div class="label">Loyalty points</div><div class="value">${c.loyalty_points}</div></div></div>
      <dl class="kv"><dt>Phone</dt><dd>${c.phone || '—'}</dd><dt>Email</dt><dd>${c.email || '—'}</dd><dt>Address</dt><dd>${c.address || '—'}</dd><dt>Marketing</dt><dd>${c.marketing_consent ? 'Consented' : 'No consent'}</dd><dt>Refunded</dt><dd>${money(c.stats.refunded)}</dd>${c.notes ? html`<dt>Notes</dt><dd>${c.notes}</dd>` : ''}</dl>
      <div class="grid g2"><div class="panel"><div class="panel-head"><h3>Recent purchases</h3></div>${table({ rows: c.recent_sales, empty: 'No purchases yet', onRowAttr: (s) => `class="clickable" data-sale="${s.id}"`, columns: [{ key: 'number', label: 'Receipt', cls: 'mono' }, { key: 'completed_at', label: 'Date', type: 'datetime' }, { key: 'status', label: '', type: 'status' }, { key: 'total', label: 'Total', type: 'money' }] })}</div>
      <div class="panel"><div class="panel-head"><h3>Favourite products</h3></div>${table({ rows: c.top_products, empty: '—', columns: [{ key: 'name', label: 'Product' }, { key: 'qty', label: 'Qty', type: 'qty' }, { key: 'spend', label: 'Spend', type: 'money' }] })}</div></div></div>`,
    foot: html`${can('customer.edit') ? html`<button class="btn" data-edit>Edit details</button>` : ''}<div class="grow"></div><button class="btn primary" data-dismiss>Close</button>`,
  });
  on(m.el, 'click', '[data-sale]', async (e, tr) => { const { saleDetailModal } = await import('./sales.js'); saleDetailModal(tr.dataset.sale); });
  on(m.el, 'click', '[data-edit]', async () => {
    const r = await formDlg({ title: 'Edit customer', size: 'wide', fields: [...FIELDS, { name: 'is_active', label: 'Active', type: 'checkbox' }], values: c, submit: (v) => put(`/api/customers/${id}`, v) });
    if (r) { toast('Saved', 'ok'); m.close(); customerModal(id); }
  });
  await m.promise;
}
