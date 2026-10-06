// Payments ledger: every attempt, its provider status and settlement link.
import { get, post, qs } from '../api.js';
import { html, mount, $, on, money, dt, toast, showError, modal, table, can, periodHtml, bindPeriod, titleCase, debounce, S } from '../ui.js';

export async function render(el, nav) {
  nav.setTitle('Payments');
  const f = { period: nav.query.status === 'inflight' ? 'this_month' : 'today', from: '', to: '', status: nav.query.status || '', method: '', q: '' };
  mount(el, html`<div class="page-head"><div><h1>Payments</h1><div class="sub">Customer payments as recorded and as confirmed by providers. Electronic payments only succeed on provider confirmation.</div></div></div>
    <div class="filters">${periodHtml(f)}<select class="input" data-status style="width:160px"><option value="">Any status</option>${['succeeded', 'inflight', 'failed', 'cancelled', 'voided'].map((s) => html`<option value="${s}" ${f.status === s ? 'selected' : ''}>${s === 'inflight' ? 'In flight (pending/processing)' : titleCase(s)}</option>`)}</select>
      <select class="input" data-method style="width:180px"><option value="">All methods</option>${S.lookups.methods.map((m) => html`<option value="${m.code}">${m.name}</option>`)}</select><input class="input" data-q placeholder="Provider ref / approval code / receipt" style="width:240px"></div>
    <div class="panel" data-list></div>`);
  const load = async () => {
    try {
      const rows = await get(`/api/payments${qs(f)}`);
      mount($('[data-list]', el), table({ rows, empty: 'No payments match', onRowAttr: (p) => `class="clickable" data-id="${p.id}"`,
        columns: [{ key: 'created_at', label: 'Created', type: 'datetime' }, { key: 'sale_number', label: 'Sale', cls: 'mono' }, { key: 'method_code', label: 'Method' }, { key: 'provider_code', label: 'Processed by' }, { key: 'status', label: 'Status', type: 'status' },
          { key: 'confirmation_source', label: 'Confirmed by', render: (p) => (p.confirmation_source ? titleCase(p.confirmation_source) : '—') }, { key: 'provider_ref', label: 'Reference', cls: 'mono', render: (p) => p.provider_ref || p.reference || '—' },
          { key: 'settlement_ref', label: 'Settlement', cls: 'mono', render: (p) => p.settlement_ref || (p.status === 'succeeded' && !['cash'].includes(p.provider_code) ? html`<span class="muted">unsettled</span>` : '—') }, { key: 'amount', label: 'Amount', type: 'money' }],
        foot: rows.length ? { amount: rows.filter((r) => r.status === 'succeeded').reduce((a, r) => a + r.amount, 0), method_code: 'Succeeded total' } : null }));
    } catch (e) { showError(e); }
  };
  bindPeriod(el, f, load);
  on(el, 'change', '[data-status]', (e, s) => { f.status = s.value; load(); });
  on(el, 'change', '[data-method]', (e, s) => { f.method = s.value; load(); });
  on(el, 'input', '[data-q]', debounce((e) => { f.q = e.target.value; load(); }, 300));
  on(el, 'click', 'tr[data-id]', async (e, tr) => { await paymentModal(tr.dataset.id); load(); });
  load();
}

async function paymentModal(id) {
  let p;
  try { p = await get(`/api/payments/${id}`); } catch (e) { return showError(e); }
  const inflight = ['pending', 'processing'].includes(p.status);
  const m = modal({
    title: `Payment ${money(p.amount)} · ${p.method_code}`, sub: html`Sale ${p.sale_number} · ${dt(p.created_at, { seconds: true })}`, size: 'wide',
    body: html`<div class="stack"><dl class="kv"><dt>Status</dt><dd>${titleCase(p.status)}${p.failure_reason ? ` — ${p.failure_reason}` : ''}</dd><dt>Internal ID</dt><dd class="mono">${p.id}</dd><dt>Idempotency key</dt><dd class="mono">${p.idempotency_key}</dd>
      <dt>Provider</dt><dd>${p.provider_code}</dd><dt>Provider reference</dt><dd class="mono">${p.provider_ref || '—'}</dd><dt>Provider status</dt><dd>${p.provider_status || '—'}</dd><dt>Confirmed by</dt><dd>${p.confirmation_source ? titleCase(p.confirmation_source) : '—'} ${p.confirmed_at ? `at ${dt(p.confirmed_at, { seconds: true })}` : ''}</dd>
      <dt>Currency</dt><dd>${p.currency}</dd>${p.tendered ? html`<dt>Tendered / change</dt><dd>${money(p.tendered)} / ${money(p.change_given)}</dd>` : ''}<dt>Created offline</dt><dd>${p.created_offline ? 'Yes' : 'No'}</dd></dl>
      <div class="panel"><div class="panel-head"><h3>Provider interaction log</h3></div>${table({ rows: p.attempts, empty: 'No provider calls (locally confirmed method)', columns: [{ key: 'created_at', label: 'At', render: (a) => dt(a.created_at, { seconds: true }) }, { key: 'action', label: 'Action', render: (a) => titleCase(a.action) }, { key: 'outcome', label: 'Outcome' }, { key: 'error', label: 'Error', render: (a) => a.error || '' }] })}</div></div>`,
    foot: html`${inflight && can('payment.resolve') ? html`<button class="btn" data-check>Re-check with provider</button>` : ''}<div class="grow"></div><button class="btn primary" data-dismiss>Close</button>`,
  });
  on(m.el, 'click', '[data-check]', async () => { try { const r = await post(`/api/payments/${id}/refresh`); toast(`Status: ${r.payment.status}`, r.payment.status === 'succeeded' ? 'ok' : ''); m.close(); paymentModal(id); } catch (e) { showError(e); } });
  await m.promise;
}
