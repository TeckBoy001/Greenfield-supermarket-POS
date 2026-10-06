// Sales, sale detail, returns/refunds and voids.
import { get, post, qs, newKey, fetchText, download } from '../api.js';
import { S, html, mount, $, on, money, qty, dt, tm, toast, showError, errMsg, modal, formDlg, withOverride, badge, table, can, periodHtml, bindPeriod, titleCase, debounce } from '../ui.js';

export async function render(el, nav) {
  if (nav.page === 'refunds') return renderRefunds(el, nav);
  nav.setTitle('Sales');
  const f = { period: 'today', from: '', to: '', q: '', status: '', cashier_id: '', payment_method: '', register_id: '', offset: 0 };
  mount(el, html`<div class="page-head"><div><h1>Sales</h1><div class="sub">Every completed and voided transaction. Click a row for details, receipt, refunds or void.</div></div>
      <div class="row">${can('refund.create') ? html`<button class="btn" data-ret>Process a return</button>` : ''}</div></div>
    <div class="filters" data-filters>${periodHtml(f)}
      <input class="input" data-q placeholder="Receipt no., customer, payment ref" style="width:240px">
      <select class="input" data-status style="width:140px"><option value="">Completed & voided</option><option value="completed">Completed</option><option value="voided">Voided</option><option value="held">Held</option><option value="cancelled">Cancelled</option></select>
      ${S.lookups.staff.length ? html`<select class="input" data-cashier style="width:170px"><option value="">All cashiers</option>${S.lookups.staff.map((u) => html`<option value="${u.id}">${u.full_name}</option>`)}</select>` : ''}
      <select class="input" data-method style="width:170px"><option value="">All payment methods</option>${S.lookups.methods.map((m) => html`<option value="${m.code}">${m.name}</option>`)}</select>
      <select class="input" data-register style="width:170px"><option value="">All registers</option>${S.lookups.registers.map((r) => html`<option value="${r.id}">${S.lookups.locations.find((l) => l.id === r.location_id)?.code || ''}-${r.code} ${r.name}</option>`)}</select>
    </div><div class="panel"><div data-list></div></div>`);
  const load = async () => {
    try {
      const r = await get(`/api/sales${qs({ ...f, limit: 100 })}`);
      mount($('[data-list]', el), html`${table({
        rows: r.rows, empty: 'No sales in this period', onRowAttr: (x) => `class="clickable" data-id="${x.id}"`,
        columns: [{ key: 'number', label: 'Receipt', cls: 'mono' }, { key: 'completed_at', label: 'Time', render: (x) => dt(x.completed_at || x.created_at) }, { key: 'status', label: 'Status', render: (x) => html`${badge(x.status)}${x.completed_offline ? html` <span class="badge plain">offline</span>` : ''}${x.refunded ? html` <span class="badge warn plain">refunded ${money(x.refunded)}</span>` : ''}` },
          { key: 'cashier_name', label: 'Cashier' }, { key: 'register_name', label: 'Register' }, { key: 'customer_name', label: 'Customer', render: (x) => x.customer_name || html`<span class="muted">Walk-in</span>` },
          { key: 'item_count', label: 'Lines', type: 'int' }, { key: 'methods', label: 'Paid by', render: (x) => (x.methods || '—').replace(/,/g, ', ') }, { key: 'total', label: 'Total', type: 'money' }],
      })}<div class="row between" style="padding:10px 14px;border-top:1px solid var(--line)"><span class="muted small">${r.total} sale(s)${r.total > r.rows.length ? ` · showing ${r.rows.length}` : ''}</span></div>`);
    } catch (e) { showError(e); }
  };
  bindPeriod(el, f, load);
  on(el, 'input', '[data-q]', debounce((e, i) => { f.q = (i || e.target).value; load(); }, 300));
  on(el, 'change', '[data-status]', (e, s) => { f.status = s.value; load(); });
  on(el, 'change', '[data-cashier]', (e, s) => { f.cashier_id = s.value; load(); });
  on(el, 'change', '[data-method]', (e, s) => { f.payment_method = s.value; load(); });
  on(el, 'change', '[data-register]', (e, s) => { f.register_id = s.value; load(); });
  on(el, 'click', 'tr[data-id]', async (e, tr) => { await saleDetailModal(tr.dataset.id); load(); });
  on(el, 'click', '[data-ret]', async () => { await refundFlow(); load(); });
  if (nav.params[0]) saleDetailModal(nav.params[0]).then(load);
  load();
}

/** Sale detail with receipt and correction actions. */
export async function saleDetailModal(id, { fromPos = false } = {}) {
  let s;
  try { s = await get(`/api/sales/${id}`); } catch (e) { showError(e); return; }
  const refundable = s.status === 'completed' && s.items.some((i) => i.qty - i.refunded_qty > 0.0001);
  const m = modal({
    title: `Sale ${s.number}`, sub: html`${badge(s.status)} · ${dt(s.completed_at || s.created_at)} · ${s.cashier_name} · ${s.register_name}, ${s.location_name}`, size: 'xwide',
    body: html`<div class="grid" style="grid-template-columns:minmax(0,1.4fr) minmax(300px,1fr);gap:18px;align-items:start"><div class="stack">
      ${s.status === 'voided' ? html`<div class="callout bad">Voided ${dt(s.voided_at)} by ${s.voided_by_name}: ${s.void_reason || ''}</div>` : ''}
      ${s.status === 'cancelled' ? html`<div class="callout warn">Cancelled ${dt(s.cancelled_at)}: ${s.cancel_reason || ''}</div>` : ''}
      <div class="panel">${table({ rows: s.items, columns: [{ key: 'name', label: 'Item', render: (i) => html`<div class="strong">${i.name}</div><div class="xs muted">${i.sku}${i.line_discount_reason ? ` · ${i.line_discount_reason}` : ''}${i.price_override_by ? ' · price overridden' : ''}</div>` },
        { key: 'qty', label: 'Qty', type: 'qty' }, { key: 'unit_price', label: 'Price', type: 'money' }, { key: 'disc', label: 'Discount', type: 'money', value: (i) => i.line_discount + i.cart_discount_alloc }, { key: 'tax_amount', label: 'Tax', type: 'money' },
        { key: 'line_total', label: 'Total', type: 'money' }, { key: 'refunded_qty', label: 'Returned', render: (i) => (i.refunded_qty ? html`<span class="badge warn plain">${qty(i.refunded_qty, i.unit)}</span>` : '') }] })}</div>
      <div class="grid g2"><div class="panel panel-body"><dl class="kv"><dt>Subtotal</dt><dd class="num">${money(s.subtotal)}</dd><dt>Discounts</dt><dd class="num">${money(s.discount_total)}</dd><dt>Tax ${s.prices_include_tax ? '(included)' : ''}</dt><dd class="num">${money(s.tax_total)}</dd><dt class="strong">Total</dt><dd class="num strong">${money(s.total)}</dd>
        <dt>Paid</dt><dd class="num">${money(s.paid)}</dd>${s.change_given ? html`<dt>Change</dt><dd class="num">${money(s.change_given)}</dd>` : ''}${s.refunded_total ? html`<dt>Refunded</dt><dd class="num" style="color:var(--bad)">${money(s.refunded_total)}</dd>` : ''}</dl></div>
        <div class="panel panel-body"><dl class="kv"><dt>Customer</dt><dd>${s.customer_name ? html`${s.customer_name} <span class="muted">${s.customer_code}</span>` : 'Walk-in'}</dd>${s.loyalty_points_earned ? html`<dt>Points</dt><dd>+${s.loyalty_points_earned}</dd>` : ''}
        <dt>Offline</dt><dd>${s.completed_offline ? 'Completed offline' : 'No'}</dd><dt>Receipts printed</dt><dd>${s.receipt_print_count}</dd>${s.cart_discount_reason ? html`<dt>Sale discount</dt><dd>${s.cart_discount_reason}</dd>` : ''}</dl></div></div>
      <div class="panel"><div class="panel-head"><h3>Payments</h3></div>${table({ rows: s.payments, empty: 'No payments', columns: [{ key: 'method_name', label: 'Method', render: (p) => p.method_name || p.method_code }, { key: 'status', label: 'Status', type: 'status' },
        { key: 'amount', label: 'Amount', type: 'money' }, { key: 'tendered', label: 'Tendered', type: 'money' }, { key: 'confirmation_source', label: 'Confirmed by', render: (p) => (p.confirmation_source ? titleCase(p.confirmation_source) : '—') }, { key: 'provider_ref', label: 'Reference', cls: 'mono', render: (p) => p.provider_ref || p.reference || '—' }, { key: 'confirmed_at', label: 'At', render: (p) => tm(p.confirmed_at || p.created_at) }] })}</div>
      ${s.refunds.length ? html`<div class="panel"><div class="panel-head"><h3>Refunds & voids</h3></div>${table({ rows: s.refunds, onRowAttr: (r) => `class="clickable" data-refund="${r.id}"`, columns: [{ key: 'number', label: 'Number', cls: 'mono' }, { key: 'kind', label: 'Type', render: (r) => titleCase(r.kind) }, { key: 'status', label: 'Status', type: 'status' }, { key: 'reason_code', label: 'Reason', render: (r) => titleCase(r.reason_code) }, { key: 'authorized_by_name', label: 'Authorized by' }, { key: 'total', label: 'Amount', type: 'money' }] })}</div>` : ''}
    </div><div class="stack"><iframe class="receipt-frame" style="height:520px" sandbox="allow-same-origin allow-modals" title="Receipt" data-frame></iframe></div></div>`,
    foot: html`${['completed', 'voided'].includes(s.status) ? html`<button class="btn" data-print>Print copy</button><button class="btn" data-pdf>PDF</button><button class="btn" data-send>Email / SMS</button>` : ''}
      <div class="grow"></div>
      ${s.status === 'completed' && can('pos.sell') ? html`<button class="btn danger" data-void title="Same register session only; needs supervisor">Void sale</button>` : ''}
      ${refundable && can('refund.create') ? html`<button class="btn primary" data-refund-start>Refund / return items</button>` : ''}
      <button class="btn" data-dismiss>Close</button>`,
  });
  if (['completed', 'voided'].includes(s.status)) fetchText(`/api/sales/${id}/receipt?format=html`).then((h) => { $('[data-frame]', m.el).srcdoc = h; }).catch(() => {});
  else $('[data-frame]', m.el).remove();
  on(m.el, 'click', '[data-print]', async () => {
    try {
      await post(`/api/sales/${id}/receipt/printed`);
      const h = await fetchText(`/api/sales/${id}/receipt?format=html&copy=1`);
      if (window.meridian && window.meridian.printHtml) return window.meridian.printHtml(h);
      const fr = $('[data-frame]', m.el); fr.srcdoc = h; setTimeout(() => fr.contentWindow.print(), 250);
    } catch (e) { showError(e); }
  });
  on(m.el, 'click', '[data-pdf]', () => download(`/api/sales/${id}/receipt?format=pdf&download=1`, `${s.number}.pdf`).catch(showError));
  on(m.el, 'click', '[data-send]', () => formDlg({ title: 'Send receipt', size: 'narrow', cls: 'stack', submitText: 'Send', fields: [{ name: 'channel', label: 'Channel', type: 'select', required: true, options: ['email', 'sms', 'whatsapp'].map((c) => ({ value: c, label: titleCase(c) })) }, { name: 'destination', label: 'Email or phone', required: true, value: s.customer_phone || '' }],
    submit: async (v) => { const r = await post('/api/receipts/deliver', { sale_id: id, ...v }); toast(r.status === 'sent' ? 'Receipt sent' : r.detail, r.status === 'sent' ? 'ok' : 'warn'); } }));
  on(m.el, 'click', '[data-refund-start]', async () => { m.close(); await refundDialog(s); });
  on(m.el, 'click', '[data-refund]', (e, tr) => refundDetailModal(tr.dataset.refund));
  on(m.el, 'click', '[data-void]', async () => {
    const v = await formDlg({
      title: `Void ${s.number}`, sub: 'Reverses the whole sale: stock goes back, cash is returned from this drawer, electronic payments are reversed with the provider. Only possible in the same open session.', size: 'narrow', cls: 'stack', danger: true, submitText: 'Void sale',
      fields: [{ name: 'reason_note', label: 'Reason', required: true, placeholder: 'e.g. rung up on wrong customer' }],
      submit: (vals) => withOverride((override) => post(`/api/sales/${id}/void`, { reason_note: vals.reason_note, idempotency_key: newKey('void'), override })),
    });
    if (v) { toast(`Sale voided (${v.number})`, 'ok'); m.close(); }
  });
  await m.promise;
  void fromPos;
}

/** Step 1 of a return: find the original sale (scan the receipt or type its number). */
export async function refundFlow() {
  const m = modal({
    title: 'Return / refund', sub: 'Scan or type the receipt number from the original sale.', size: 'wide',
    body: html`<div class="stack"><input class="input lg" data-q placeholder="Receipt number (e.g. LEK-R01-000123), customer phone or payment reference" autofocus><div data-res></div></div>`,
  });
  const search = debounce(async (q) => {
    if (!q || q.length < 3) return mount($('[data-res]', m.el), html`<div class="muted small">Enter at least 3 characters.</div>`);
    try {
      const r = await get(`/api/sales${qs({ q, period: 'custom', from: '2000-01-01', to: '2100-01-01', status: 'completed', limit: 15 })}`);
      mount($('[data-res]', m.el), r.rows.length ? html`<div class="list-pick">${r.rows.map((x) => html`<button data-id="${x.id}"><div><div class="strong mono">${x.number}</div><div class="xs muted">${dt(x.completed_at)} · ${x.cashier_name} · ${x.customer_name || 'Walk-in'} · ${x.item_count} lines${x.refunded ? ` · already refunded ${money(x.refunded)}` : ''}</div></div><strong class="num">${money(x.total)}</strong></button>`)}</div>`
        : html`<div class="empty"><strong>No completed sale found</strong>Check the receipt number. Returns without a receipt need a manager.</div>`);
    } catch (e) { showError(e); }
  }, 250);
  on(m.el, 'input', '[data-q]', (e, i) => search(i.value.trim()));
  $('[data-q]', m.el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(e.target.value.trim()); } });
  on(m.el, 'click', '[data-id]', async (e, b) => { m.close(); try { await refundDialog(await get(`/api/sales/${b.dataset.id}`)); } catch (ex) { showError(ex); } });
  await m.promise;
}

/** Step 2: choose lines, quantities, condition, reason and refund method. */
async function refundDialog(s) {
  const lines = s.items.filter((i) => i.qty - i.refunded_qty > 0.0001);
  if (!lines.length) { toast('Everything on this sale has already been returned', 'warn'); return; }
  const methods = [...new Set(s.payments.filter((p) => p.status === 'succeeded').map((p) => p.method_name || p.method_code))];
  const hasManual = s.payments.some((p) => p.status === 'succeeded' && p.provider_code === 'manual');
  const m = modal({
    title: `Refund — ${s.number}`, sub: `${dt(s.completed_at)} · paid by ${methods.join(' + ')}${s.customer_name ? ` · ${s.customer_name}` : ''}`, size: 'xwide',
    body: html`<div class="stack">
      <div class="panel"><div class="table-wrap"><table class="t"><thead><tr><th style="width:36px"></th><th>Item</th><th class="num">Sold</th><th class="num">Returnable</th><th class="num">Paid per unit</th><th style="width:130px">Return qty</th><th style="width:170px">Condition</th></tr></thead><tbody>
        ${lines.map((i) => { const left = Math.round((i.qty - i.refunded_qty) * 1000) / 1000; return html`<tr data-line="${i.id}"><td><input type="checkbox" data-pick style="width:18px;height:18px;accent-color:var(--accent)"></td>
          <td><div class="strong">${i.name}</div><div class="xs muted">${i.sku}</div></td><td class="num">${qty(i.qty, i.unit)}</td><td class="num">${qty(left, i.unit)}</td><td class="num">${money(Math.round(i.line_total / i.qty))}${i.unit !== 'each' ? `/${i.unit}` : ''}</td>
          <td><input class="input" type="number" data-qty min="0" max="${left}" step="${i.unit === 'each' ? 1 : 0.001}" value="${left}" disabled></td>
          <td><select class="input" data-cond disabled><option value="resaleable">Back to shelf</option><option value="damaged">Damaged — write off</option><option value="not_returned">Not returned (price adj.)</option></select></td></tr>`; })}
      </tbody></table></div></div>
      <div class="grid g3"><div class="field"><label>Reason *</label><select class="input" data-reason>${S.lookups.refund_reasons.map((r) => html`<option value="${r}">${titleCase(r)}</option>`)}</select></div>
        <div class="field"><label>Refund to</label><select class="input" data-method><option value="original">Original payment method(s)</option><option value="cash">Cash from this drawer (supervisor)</option></select></div>
        <div class="field"><label>Note</label><input class="input" data-note placeholder="Details (required for Other)"></div></div>
      ${hasManual ? html`<div class="field"><label>Reversal reference from the standalone terminal *</label><input class="input" data-mref placeholder="Needed to refund the external card payment"></div>` : ''}
      <div class="row between"><div class="callout info grow">Refund amounts are calculated from what the customer actually paid per unit, including discounts. Stock is returned automatically.</div>
        <div class="tender-summary" style="min-width:220px"><div class="line big"><span>Refund</span><span data-total>${money(0)}</span></div></div></div>
      <div class="callout bad hidden" data-err></div></div>`,
    foot: html`<button class="btn" data-dismiss>Cancel</button><button class="btn primary" data-go disabled>Refund</button>`,
  });
  const key = newKey('refund');
  const calc = () => {
    let total = 0; let any = false;
    m.el.querySelectorAll('tr[data-line]').forEach((tr) => {
      const on_ = tr.querySelector('[data-pick]').checked;
      tr.querySelector('[data-qty]').disabled = !on_; tr.querySelector('[data-cond]').disabled = !on_;
      if (!on_) return;
      const it = lines.find((i) => i.id === tr.dataset.line); const q = Number(tr.querySelector('[data-qty]').value) || 0;
      if (q > 0) { any = true; const left = it.qty - it.refunded_qty; total += Math.abs(q - left) < 1e-9 ? it.line_total - it.refunded_amount : Math.round((it.line_total * q) / it.qty); }
    });
    $('[data-total]', m.el).textContent = money(total); $('[data-go]', m.el).disabled = !any;
  };
  on(m.el, 'change', '[data-pick], [data-qty]', calc); on(m.el, 'input', '[data-qty]', calc);
  on(m.el, 'click', '[data-go]', async (e, btn) => {
    const err = $('[data-err]', m.el); err.classList.add('hidden');
    const items = [];
    m.el.querySelectorAll('tr[data-line]').forEach((tr) => { if (tr.querySelector('[data-pick]').checked) items.push({ sale_item_id: tr.dataset.line, qty: Number(tr.querySelector('[data-qty]').value), condition: tr.querySelector('[data-cond]').value }); });
    btn.disabled = true;
    try {
      const r = await withOverride((override) => post(`/api/sales/${s.id}/refunds`, {
        items, reason_code: $('[data-reason]', m.el).value, reason_note: $('[data-note]', m.el).value || null, refund_method: $('[data-method]', m.el).value,
        manual_reference: $('[data-mref]', m.el) ? $('[data-mref]', m.el).value || null : null, idempotency_key: key, override,
      }));
      m.close();
      toast(`Refund ${r.number}: ${money(r.total)} — ${r.status}`, r.status === 'completed' ? 'ok' : 'warn');
      await refundDetailModal(r.id);
    } catch (ex) { if (ex.code !== 'cancelled') { err.textContent = errMsg(ex); err.classList.remove('hidden'); } btn.disabled = false; }
  });
  await m.promise;
}

export async function refundDetailModal(id) {
  let r;
  try { r = await get(`/api/refunds/${id}`); } catch (e) { showError(e); return; }
  const m = modal({
    title: `${r.kind === 'void' ? 'Void' : 'Refund'} ${r.number}`, sub: html`${badge(r.status)} · original sale ${r.sale_number} · ${dt(r.created_at)}`, size: 'wide',
    body: html`<div class="stack">
      ${r.status === 'failed' ? html`<div class="callout bad">Money could not be returned through the original method. Retry it or pay the customer in cash below. Stock has already been returned.</div>` : ''}
      ${r.status === 'pending' ? html`<div class="callout info">Waiting for the payment provider to confirm the refund. It updates automatically.</div>` : ''}
      <dl class="kv"><dt>Reason</dt><dd>${titleCase(r.reason_code)}${r.reason_note ? ` — ${r.reason_note}` : ''}</dd><dt>Requested by</dt><dd>${r.requested_by_name}</dd><dt>Authorized by</dt><dd>${r.authorized_by_name}</dd><dt>Total</dt><dd class="strong">${money(r.total)} <span class="muted small">(tax ${money(r.tax_total)})</span></dd></dl>
      <div class="panel">${table({ rows: r.items, columns: [{ key: 'name', label: 'Item' }, { key: 'qty', label: 'Qty', type: 'qty' }, { key: 'condition', label: 'Condition', render: (i) => titleCase(i.condition) }, { key: 'amount', label: 'Amount', type: 'money' }] })}</div>
      <div class="panel"><div class="panel-head"><h3>Money returned</h3></div>${table({ rows: r.payments, columns: [{ key: 'method_code', label: 'Method' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'provider_ref', label: 'Reference', cls: 'mono', render: (p) => p.provider_ref || p.reference || '—' }, { key: 'failure_reason', label: 'Note', render: (p) => p.failure_reason || '' },
        { key: 'act', label: '', render: (p) => (p.status === 'failed' && !String(p.failure_reason || '').includes('superseded') ? html`<button class="btn sm" data-retry="${p.id}">Retry</button> <button class="btn sm" data-cash="${p.id}">Pay cash</button>` : '') }] })}</div></div>`,
    foot: html`<button class="btn" data-rcpt>Refund receipt</button><div class="grow"></div><button class="btn primary" data-dismiss>Done</button>`,
  });
  const retry = async (rpId, toCash) => { try { await withOverride((override) => post(`/api/refund-payments/${rpId}/retry`, { to_cash: toCash, override })); m.close(); refundDetailModal(id); } catch (e) { if (e.code !== 'cancelled') showError(e); } };
  on(m.el, 'click', '[data-retry]', (e, b) => retry(b.dataset.retry, false));
  on(m.el, 'click', '[data-cash]', (e, b) => retry(b.dataset.cash, true));
  on(m.el, 'click', '[data-rcpt]', async () => {
    const h = await fetchText(`/api/refunds/${id}/receipt?format=html`);
    if (window.meridian && window.meridian.printHtml) return window.meridian.printHtml(h);
    const w = modal({ title: 'Refund receipt', size: 'narrow', body: html`<iframe class="receipt-frame" sandbox="allow-same-origin allow-modals" data-f></iframe>`, foot: html`<button class="btn" data-p>Print</button><button class="btn primary" data-dismiss>Close</button>` });
    const fr = $('[data-f]', w.el); fr.srcdoc = h; on(w.el, 'click', '[data-p]', () => fr.contentWindow.print());
  });
  await m.promise;
}

async function renderRefunds(el, nav) {
  nav.setTitle('Refunds & voids');
  const f = { period: 'this_week', from: '', to: '', status: '', kind: '' };
  mount(el, html`<div class="page-head"><div><h1>Refunds & voids</h1><div class="sub">Corrections never edit the original sale — each is its own authorized, auditable record.</div></div>${can('refund.create') ? html`<button class="btn primary" data-ret>Process a return</button>` : ''}</div>
    <div class="filters">${periodHtml(f)}<select class="input" data-kind style="width:140px"><option value="">Refunds & voids</option><option value="refund">Refunds</option><option value="void">Voids</option></select>
      <select class="input" data-status style="width:140px"><option value="">Any status</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="failed">Failed</option></select></div><div class="panel" data-list></div>`);
  const load = async () => {
    try {
      const rows = await get(`/api/refunds${qs(f)}`);
      mount($('[data-list]', el), table({ rows, empty: 'No refunds or voids in this period', onRowAttr: (r) => `class="clickable" data-id="${r.id}"`,
        columns: [{ key: 'number', label: 'Number', cls: 'mono' }, { key: 'created_at', label: 'When', type: 'datetime' }, { key: 'kind', label: 'Type', render: (r) => titleCase(r.kind) }, { key: 'status', label: 'Status', type: 'status' }, { key: 'sale_number', label: 'Original sale', cls: 'mono' },
          { key: 'reason_code', label: 'Reason', render: (r) => titleCase(r.reason_code) }, { key: 'methods', label: 'Refunded to' }, { key: 'requested_by_name', label: 'Requested' }, { key: 'authorized_by_name', label: 'Authorized' }, { key: 'total', label: 'Amount', type: 'money' }],
        foot: rows.length ? { total: rows.reduce((a, r) => a + r.total, 0) } : null }));
    } catch (e) { showError(e); }
  };
  bindPeriod(el, f, load);
  on(el, 'change', '[data-kind]', (e, s) => { f.kind = s.value; load(); });
  on(el, 'change', '[data-status]', (e, s) => { f.status = s.value; load(); });
  on(el, 'click', 'tr[data-id]', async (e, tr) => { await refundDetailModal(tr.dataset.id); load(); });
  on(el, 'click', '[data-ret]', async () => { await refundFlow(); load(); });
  load();
}
