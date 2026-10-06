// Finance: provider settlements, payouts, reconciliation.
import { get, post, qs, newKey } from '../api.js';
import { S, html, mount, $, on, money, dt, toast, showError, modal, formDlg, table, can, badge, titleCase, periodHtml, bindPeriod } from '../ui.js';

export async function render(el, nav) {
  if (nav.page === 'payouts') return payouts(el, nav);
  if (nav.page === 'reconciliation') return reconciliation(el, nav);
  return settlements(el, nav);
}

// ─────────────── settlements ───────────────
async function settlements(el, nav) {
  nav.setTitle('Settlements');
  const providers = (await get('/api/pos/methods').catch(() => [])).filter((m) => !['cash', 'manual'].includes(m.provider_code));
  const provCodes = [...new Set(providers.map((p) => p.provider_code))];
  mount(el, html`<div class="page-head"><div><h1>Provider settlements</h1><div class="sub">What each payment provider reports it paid to the business, net of fees and refunds — matched line-by-line to our payment records.</div></div>
    <div class="row"><button class="btn" data-manual>Import manually</button><button class="btn primary" data-fetch>Fetch from provider</button></div></div>
    <div class="callout info" style="margin-bottom:14px">Flow: customer payment → provider settlement (reported here) → funds received in bank (payout) → reconciliation. Unmatched or mismatched lines are flagged, never auto-corrected.</div>
    <div class="panel" data-list></div>`);
  const load = async () => {
    try {
      const rows = await get('/api/settlements');
      mount($('[data-list]', el), table({ rows, empty: 'No settlements imported yet', emptyHint: 'Fetch them from a provider or import a settlement report manually.', onRowAttr: (s) => `class="clickable" data-id="${s.id}"`,
        columns: [{ key: 'settlement_date', label: 'Paid on', type: 'date' }, { key: 'provider_code', label: 'Provider' }, { key: 'provider_settlement_ref', label: 'Reference', cls: 'mono' }, { key: 'period_start', label: 'For sales on', type: 'date' },
          { key: 'gross_amount', label: 'Gross', type: 'money' }, { key: 'refund_amount', label: 'Refunds', type: 'money' }, { key: 'fee_amount', label: 'Fees', type: 'money' }, { key: 'net_amount', label: 'Net', type: 'money' },
          { key: 'status', label: 'Match', type: 'status' }, { key: 'received_amount', label: 'In bank', render: (s) => (s.received_amount >= s.net_amount ? badge('paid', 'Received') : s.received_amount ? badge('partially_matched', money(s.received_amount)) : badge('pending', 'Awaiting')) }] }));
    } catch (e) { showError(e); }
  };
  on(el, 'click', 'tr[data-id]', async (e, tr) => { await settlementModal(tr.dataset.id); load(); });
  on(el, 'click', '[data-fetch]', async () => {
    const r = await formDlg({
      title: 'Fetch settlements', sub: 'Asks the provider adapter for settlement reports not yet imported.', size: 'narrow', cls: 'stack', submitText: 'Fetch',
      fields: [{ name: 'provider_code', label: 'Provider', type: 'select', required: true, options: provCodes.map((c) => ({ value: c, label: c })) }, { name: 'include_today', label: "Include today's transactions (test providers settle on demand)", type: 'checkbox' },
        { name: 'simulate_discrepancy', label: 'TEST MODE: inject a discrepancy (drop one line, add an unknown one)', type: 'checkbox' }],
      submit: (v) => post('/api/settlements/fetch', v),
    });
    if (r) { toast(r.imported ? `${r.imported} settlement batch(es) imported` : 'No new settlements available', r.imported ? 'ok' : ''); load(); }
  });
  on(el, 'click', '[data-manual]', async () => {
    const r = await formDlg({
      title: 'Import settlement', sub: "Enter the totals from the provider's or bank terminal's settlement report. Line items can be added via the API/CSV importer.", size: 'wide', submitText: 'Import',
      fields: [{ name: 'provider_code', label: 'Provider / method', type: 'select', required: true, options: [{ value: 'manual', label: 'Standalone card terminal (manual)' }, ...provCodes.map((c) => ({ value: c, label: c }))] }, { name: 'provider_settlement_ref', label: 'Settlement reference', required: true },
        { name: 'settlement_date', label: 'Paid on', type: 'date', required: true }, { name: 'period_start', label: 'For sales on', type: 'date' }, { name: 'gross_amount', label: 'Gross', money: true, required: true }, { name: 'refund_amount', label: 'Refunds', money: true }, { name: 'fee_amount', label: 'Fees', money: true }],
      submit: (v) => post('/api/settlements/manual', { ...v, refund_amount: v.refund_amount || 0, fee_amount: v.fee_amount || 0 }),
    });
    if (r) { toast('Settlement imported', 'ok'); load(); }
  });
  load();
}

async function settlementModal(id) {
  let s;
  try { s = await get(`/api/settlements/${id}`); } catch (e) { return showError(e); }
  const received = s.payouts.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amount, 0);
  const counts = JSON.parse(s.match_summary_json || '{}');
  const m = modal({
    title: `Settlement ${s.provider_settlement_ref}`, sub: html`${s.provider_code} · paid ${s.settlement_date} · ${badge(s.status)} · source: ${titleCase(s.source)}`, size: 'xwide',
    body: html`<div class="stack"><div class="grid g4"><div class="panel kpi"><div class="label">Gross</div><div class="value" style="font-size:19px">${money(s.gross_amount)}</div></div><div class="panel kpi"><div class="label">Fees</div><div class="value" style="font-size:19px">${money(s.fee_amount)}</div></div>
      <div class="panel kpi"><div class="label">Net</div><div class="value" style="font-size:19px">${money(s.net_amount)}</div></div><div class="panel kpi"><div class="label">Received in bank</div><div class="value" style="font-size:19px">${money(received)}</div></div></div>
      ${s.status === 'discrepancy' ? html`<div class="callout bad">${counts.unknown_reference || 0} line(s) reference payments we have no record of; ${counts.amount_mismatch || 0} line(s) have different amounts. Investigate with the provider before resolving.</div>` : ''}
      <div class="panel">${table({ rows: s.items, columns: [{ key: 'type', label: 'Type', render: (i) => titleCase(i.type) }, { key: 'provider_ref', label: 'Provider ref', cls: 'mono' }, { key: 'sale_number', label: 'Our sale', cls: 'mono', render: (i) => i.sale_number || '—' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'fee', label: 'Fee', type: 'money' },
        { key: 'match_status', label: 'Match', render: (i) => badge(i.match_status === 'matched' ? 'matched' : i.match_status === 'not_applicable' ? 'pending' : 'discrepancy', titleCase(i.match_status)) }] })}</div></div>`,
    foot: html`${s.status === 'discrepancy' && can('reconciliation.manage') ? html`<button class="btn" data-resolve>Resolve discrepancy</button>` : ''}${received < s.net_amount ? html`<button class="btn primary" data-received>Confirm funds received in bank</button>` : ''}<div class="grow"></div><button class="btn" data-dismiss>Close</button>`,
  });
  on(m.el, 'click', '[data-resolve]', async () => { const r = await formDlg({ title: 'Resolve discrepancy', size: 'narrow', cls: 'stack', submitText: 'Mark resolved', extra: html`<div class="callout warn" style="margin-bottom:10px">Figures stay as reported. Record what was found and what was done.</div>`, fields: [{ name: 'note', label: 'Resolution', type: 'textarea', required: true }], submit: (v) => post(`/api/settlements/${id}/resolve`, v) }); if (r) { m.close(); settlementModal(id); } });
  on(m.el, 'click', '[data-received]', async () => {
    const r = await formDlg({ title: 'Funds received', sub: 'Record the bank statement entry for this settlement. Creates a provider payout record.', size: 'narrow', cls: 'stack', submitText: 'Record receipt',
      fields: [{ name: 'amount', label: 'Amount received', money: true, required: true, value: s.net_amount - received }, { name: 'bank_reference', label: 'Bank statement reference', required: true }], submit: (v) => post(`/api/settlements/${id}/received`, v, { idempotencyKey: newKey('rcv') }) });
    if (r) { toast(`Recorded as ${r.number}`, 'ok'); m.close(); settlementModal(id); }
  });
  await m.promise;
}

// ─────────────── payouts ───────────────
async function payouts(el, nav) {
  nav.setTitle('Payouts');
  const f = { period: 'this_month', from: '', to: '', status: '' };
  mount(el, html`<div class="page-head"><div><h1>Payouts</h1><div class="sub">Money leaving the business or moving between its accounts. Outbound payouts need approval by a different person.</div></div>${can('payout.request') ? html`<button class="btn primary" data-new>New payout request</button>` : ''}</div>
    <div class="filters">${periodHtml(f)}<select class="input" data-status style="width:170px"><option value="">Any status</option>${['pending_approval', 'approved', 'paid', 'rejected', 'cancelled'].map((s) => html`<option value="${s}">${titleCase(s)}</option>`)}</select></div>
    <div class="panel" data-list></div>`);
  const load = async () => {
    try {
      const rows = await get(`/api/payouts${qs(f)}`);
      mount($('[data-list]', el), table({ rows, empty: 'No payouts in this period', onRowAttr: (p) => `class="clickable" data-id="${p.id}"`,
        columns: [{ key: 'number', label: 'Number', cls: 'mono' }, { key: 'created_at', label: 'Requested', type: 'datetime' }, { key: 'type', label: 'Type', render: (p) => titleCase(p.type) }, { key: 'status', label: 'Status', type: 'status' },
          { key: 'destination_name', label: 'To', render: (p) => p.destination_name || p.destination_note || '—' }, { key: 'reason', label: 'Reason' }, { key: 'requested_by_name', label: 'Requested by' }, { key: 'approved_by_name', label: 'Approved by', render: (p) => p.approved_by_name || '—' }, { key: 'amount', label: 'Amount', type: 'money' }] }));
    } catch (e) { showError(e); }
  };
  bindPeriod(el, f, load);
  on(el, 'change', '[data-status]', (e, s) => { f.status = s.value; load(); });
  on(el, 'click', 'tr[data-id]', async (e, tr) => { await payoutModal(tr.dataset.id); load(); });
  on(el, 'click', '[data-new]', async () => {
    const acc = S.lookups.accounts;
    const r = await formDlg({
      title: 'New payout request', sub: 'Goes to an approver. You cannot approve your own request.', size: 'wide', submitText: 'Submit for approval',
      fields: [{ name: 'type', label: 'Type', type: 'select', required: true, options: S.lookups.payout_types.filter((t) => t !== 'provider_payout').map((t) => ({ value: t, label: titleCase(t) })) },
        { name: 'amount', label: 'Amount', money: true, required: true }, { name: 'source_account_id', label: 'From account', type: 'select', placeholder: '— select —', options: acc.map((a) => ({ value: a.id, label: `${a.name} (${titleCase(a.type)})` })) },
        { name: 'destination_account_id', label: 'To account (internal)', type: 'select', placeholder: '— external payee —', options: acc.map((a) => ({ value: a.id, label: a.name })) },
        { name: 'destination_note', label: 'External payee / details', full: true, placeholder: 'e.g. supplier name and invoice number' }, { name: 'reason', label: 'Reason', required: true, full: true }, { name: 'reference', label: 'Reference' }],
      submit: (v) => post('/api/payouts', v, { idempotencyKey: newKey('po') }),
    });
    if (r) { toast(`${r.number} submitted for approval`, 'ok'); load(); }
  });
  load();
}

async function payoutModal(id) {
  let p;
  try { p = await get(`/api/payouts/${id}`); } catch (e) { return showError(e); }
  const mine = p.requested_by === S.me.user.id;
  const m = modal({
    title: `Payout ${p.number}`, sub: html`${titleCase(p.type)} · ${badge(p.status)}`, size: 'wide',
    body: html`<div class="stack"><div class="tender-summary"><div class="line big"><span>Amount</span><span>${money(p.amount)}</span></div></div>
      <dl class="kv"><dt>From</dt><dd>${p.source_name || '—'}</dd><dt>To</dt><dd>${p.destination_name || p.destination_note || '—'}</dd><dt>Reason</dt><dd>${p.reason}</dd><dt>Reference</dt><dd>${p.reference || '—'}</dd>
        ${p.provider_settlement_ref ? html`<dt>Settlement</dt><dd class="mono">${p.provider_settlement_ref}</dd>` : ''}${p.session_number ? html`<dt>Cash session</dt><dd>${p.session_number}</dd>` : ''}
        <dt>Requested</dt><dd>${p.requested_by_name} · ${dt(p.created_at)}</dd>${p.approved_by_name ? html`<dt>Approved</dt><dd>${p.approved_by_name} · ${dt(p.approved_at)}</dd>` : ''}
        ${p.rejected_by_name ? html`<dt>Rejected</dt><dd>${p.rejected_by_name}: ${p.rejection_reason}</dd>` : ''}${p.paid_at ? html`<dt>Paid</dt><dd>${p.paid_by_name || ''} · ${dt(p.paid_at)}</dd>` : ''}</dl>
      ${p.status === 'approved' ? html`<div class="callout info">Approved. Execute the transfer in your banking system, then record the bank reference here. (No bank is integrated for automatic execution.)</div>` : ''}
      ${p.status === 'pending_approval' && mine ? html`<div class="callout warn">Waiting for another authorized person to approve.</div>` : ''}</div>`,
    foot: html`${p.status === 'pending_approval' && can('payout.approve') && !mine ? html`<button class="btn danger" data-act="reject">Reject</button><button class="btn primary" data-act="approve">Approve</button>` : ''}
      ${p.status === 'approved' && can('payout.request') ? html`<button class="btn primary" data-act="mark_paid">Record as paid</button>` : ''}
      ${['pending_approval', 'approved'].includes(p.status) && (mine || can('payout.approve')) ? html`<button class="btn" data-act="cancel">Cancel request</button>` : ''}<div class="grow"></div><button class="btn" data-dismiss>Close</button>`,
  });
  on(m.el, 'click', '[data-act]', async (e, b) => {
    const a = b.dataset.act;
    let body = {};
    if (a === 'reject') { const v = await formDlg({ title: 'Reject payout', size: 'narrow', cls: 'stack', danger: true, submitText: 'Reject', fields: [{ name: 'reason', label: 'Reason', required: true }] }); if (!v) return; body = v; }
    if (a === 'mark_paid') { const v = await formDlg({ title: 'Record payment', size: 'narrow', cls: 'stack', submitText: 'Mark paid', fields: [{ name: 'reference', label: 'Bank transfer / deposit reference', required: true }] }); if (!v) return; body = v; }
    try { await post(`/api/payouts/${id}/${a}`, body); toast(`Payout ${titleCase(a).toLowerCase()}`, 'ok'); m.close(); payoutModal(id); } catch (ex) { showError(ex); }
  });
  await m.promise;
}

// ─────────────── reconciliation ───────────────
async function reconciliation(el, nav) {
  nav.setTitle('Reconciliation');
  mount(el, html`<div class="page-head"><div><h1>Reconciliation</h1><div class="sub">Compares expected sales, recorded payments, provider settlements, cashier cash, refunds and payouts for a business day. Differences are flagged — never silently changed.</div></div><button class="btn primary" data-run>Run reconciliation</button></div>
    <div class="panel" data-list></div>`);
  const load = async () => {
    try {
      const rows = await get('/api/reconciliation');
      mount($('[data-list]', el), table({ rows, empty: 'No reconciliation runs yet', onRowAttr: (r) => `class="clickable" data-id="${r.id}"`,
        columns: [{ key: 'business_date', label: 'Business day', type: 'date' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'sales', label: 'Sales', num: true, render: (r) => money(r.summary.sales_total) }, { key: 'pay', label: 'Payments', num: true, render: (r) => money(r.summary.payments_total) },
          { key: 'disc', label: 'Discrepancies', num: true, render: (r) => r.summary.discrepancies || 0 }, { key: 'created_by_name', label: 'Run by' }, { key: 'created_at', label: 'Run at', type: 'datetime' }] }));
    } catch (e) { showError(e); }
  };
  on(el, 'click', 'tr[data-id]', async (e, tr) => { await runModal(tr.dataset.id); load(); });
  on(el, 'click', '[data-run]', async () => {
    const y = new Date(Date.now() - 86400000); const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: S.me.business.timezone }).format(y);
    const r = await formDlg({ title: 'Run reconciliation', sub: 'Re-running a day replaces the previous run (kept for history).', size: 'narrow', cls: 'stack', submitText: 'Run', fields: [{ name: 'business_date', label: 'Business day', type: 'date', required: true, value: ymd }], submit: (v) => post('/api/reconciliation/run', v) });
    if (r) { load(); runModal(r.id); }
  });
  load();
}

const isInfo = (i) => i.expected === 0 && i.actual === 0 && i.status !== 'matched';

async function runModal(id) {
  let r;
  try { r = await get(`/api/reconciliation/${id}`); } catch (e) { return showError(e); }
  const m = modal({
    title: `Reconciliation — ${r.business_date}`, sub: html`${badge(r.status)} · run by ${r.created_by_name} ${dt(r.created_at)}${r.superseded_by ? ' · superseded' : ''}`, size: 'xwide',
    body: html`<div class="stack">${table({ rows: r.items, columns: [{ key: 'category', label: 'Area', render: (i) => titleCase(i.category) }, { key: 'label', label: 'Check', render: (i) => html`<div>${i.label}</div>${i.detail ? html`<div class="xs muted">${i.detail}</div>` : ''}${i.resolution_note ? html`<div class="xs" style="color:var(--ok)">Resolved by ${i.resolved_by_name}: ${i.resolution_note}</div>` : ''}` },
      { key: 'expected', label: 'Expected', type: 'money', render: (i) => (isInfo(i) ? '—' : money(i.expected)) }, { key: 'actual', label: 'Actual', type: 'money', render: (i) => (isInfo(i) ? '—' : money(i.actual)) },
      { key: 'difference', label: 'Difference', num: true, render: (i) => (i.difference ? html`<strong style="color:${i.status === 'discrepancy' ? 'var(--bad)' : i.status === 'resolved' ? 'var(--text-3)' : 'var(--warn)'}">${money(i.difference, { sign: true })}</strong>` : '—') },
      { key: 'status', label: 'Status', type: 'status' }, { key: 'x', label: '', render: (i) => (['discrepancy', 'partially_matched', 'pending'].includes(i.status) && !r.superseded_by ? html`<button class="btn sm" data-resolve="${i.id}">Resolve</button>` : '') }] })}
      <div class="callout info">Pending items usually clear on their own (e.g. a settlement not yet paid). Re-run the day after new settlements or deposits arrive.</div></div>`,
    foot: html`<div class="grow"></div><button class="btn primary" data-dismiss>Close</button>`,
  });
  on(m.el, 'click', '[data-resolve]', async (e, b) => {
    const v = await formDlg({ title: 'Resolve item', sub: 'Explain the cause and the action taken. Financial records are not changed.', size: 'narrow', cls: 'stack', submitText: 'Resolve', fields: [{ name: 'note', label: 'Resolution note', type: 'textarea', required: true }], submit: (x) => post(`/api/reconciliation/items/${b.dataset.resolve}/resolve`, x) });
    if (v) { m.close(); runModal(id); }
  });
  await m.promise;
}
