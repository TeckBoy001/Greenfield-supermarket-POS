// Cashier sessions: open/close, cash in/out, blind count, variance review.
import { get, post, qs, newKey } from '../api.js';
import { S, html, mount, $, $$, on, money, dt, tm, toast, showError, errMsg, modal, formDlg, withOverride, badge, table, can, periodHtml, bindPeriod, toMajor, toMinor, titleCase } from '../ui.js';

export async function render(el, nav) {
  nav.setTitle('Cash sessions');
  const f = { period: 'this_week', from: '', to: '', status: '' };
  mount(el, html`<div class="page-head"><div><h1>Cash sessions</h1><div class="sub">Opening float → cash sales → refunds → cash in/out → expected vs counted. Variances above the threshold need a manager review.</div></div>
    <div class="row">${S.me.register && can('session.cash_movement') ? html`<button class="btn" data-cash>Cash in / out</button>` : ''}</div></div>
    <div data-current></div>
    <div class="filters">${periodHtml(f)}<select class="input" data-status style="width:170px"><option value="">All sessions</option><option value="open">Open</option><option value="closed">Closed</option><option value="review">Needs review</option></select></div>
    <div class="panel" data-list></div>`);
  const load = async () => {
    try {
      const [cur, rows] = await Promise.all([S.me.register ? get('/api/sessions/current') : null, get(`/api/sessions${qs(f)}`)]);
      mount($('[data-current]', el), cur ? html`<div class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>This register — ${cur.register_name}</h2>${badge('open')}</div><div class="panel-body grid g4">
        <div><div class="label">Session</div><div class="strong">${cur.number}</div><div class="xs muted">${cur.cashier_name} · since ${tm(cur.opened_at)}</div></div>
        <div><div class="label">Opening float</div><div class="strong num">${money(cur.opening_float)}</div></div>
        <div><div class="label">Cash sales / refunds</div><div class="strong num">${money(cur.figures.cash_sales)} / ${money(cur.figures.cash_refunds)}</div></div>
        <div><div class="label">Expected in drawer</div><div class="strong num">${cur.figures.blind ? html`<span class="muted">Hidden until count (blind close)</span>` : money(cur.figures.expected_cash)}</div></div>
        </div><div class="panel-body row" style="border-top:1px solid var(--line)"><div class="grow muted small">${cur.figures.sales.count} sales · ${money(cur.figures.sales.total)}</div><button class="btn" data-open-detail="${cur.id}">Details</button><button class="btn primary" data-close="${cur.id}">Close & count</button></div></div>` : '');
      mount($('[data-list]', el), table({
        rows, empty: 'No sessions in this period', onRowAttr: (r) => `class="clickable" data-open-detail="${r.id}"`,
        columns: [{ key: 'number', label: 'Session', cls: 'mono' }, { key: 'status', label: 'Status', render: (r) => html`${badge(r.status)} ${r.review_status === 'required' ? badge('review', 'Needs review') : r.review_status === 'approved' ? badge('approved', 'Reviewed') : ''}` },
          { key: 'cashier_name', label: 'Cashier' }, { key: 'register_name', label: 'Register', render: (r) => `${r.location_name} · ${r.register_name}` }, { key: 'opened_at', label: 'Opened', type: 'datetime' }, { key: 'closed_at', label: 'Closed', type: 'datetime' },
          { key: 'sales_count', label: 'Sales', type: 'int' }, { key: 'sales_total', label: 'Takings', type: 'money' }, { key: 'expected_cash', label: 'Expected cash', type: 'money' }, { key: 'counted_cash', label: 'Counted', type: 'money' },
          { key: 'variance', label: 'Variance', type: 'money', render: (r) => (r.variance === null ? '—' : html`<span style="color:${r.variance === 0 ? 'var(--ok)' : r.variance < 0 ? 'var(--bad)' : 'var(--warn)'};font-weight:600">${money(r.variance, { sign: true })}</span>`) }],
      }));
    } catch (e) { showError(e); }
  };
  bindPeriod(el, f, load);
  on(el, 'change', '[data-status]', (e, s) => { f.status = s.value; load(); });
  on(el, 'click', '[data-open-detail]', async (e, b) => { await sessionDetail(b.dataset.openDetail); load(); });
  on(el, 'click', '[data-close]', async (e, b) => { e.stopPropagation(); await closeSessionFlow(b.dataset.close); load(); });
  on(el, 'click', '[data-cash]', async () => { await cashMovementFlow(); load(); });
  load();
}

export async function sessionDetail(id) {
  let s;
  try { s = await get(`/api/sessions/${id}`); } catch (e) { return showError(e); }
  const f = s.figures;
  const m = modal({
    title: `Session ${s.number}`, sub: html`${badge(s.status)} · ${s.cashier_name} · ${s.location_name}, ${s.register_name} · ${dt(s.opened_at)} → ${s.closed_at ? dt(s.closed_at) : 'now'}`, size: 'wide',
    body: html`<div class="stack">
      ${s.review_status === 'required' ? html`<div class="callout warn">Variance of ${money(s.variance, { sign: true })} exceeds the review threshold. A manager must review it.</div>` : ''}
      ${s.review_status === 'approved' ? html`<div class="callout ok">Reviewed by ${s.reviewed_by_name} ${dt(s.reviewed_at)}: ${s.review_note}</div>` : ''}
      <div class="grid g2"><div class="panel panel-body"><h3 style="margin-bottom:8px">Cash drawer</h3><dl class="kv">
        <dt>Opening float</dt><dd class="num">${money(f.opening_float)}</dd><dt>+ Cash sales</dt><dd class="num">${money(f.cash_sales)}</dd><dt>− Cash refunds</dt><dd class="num">${money(f.cash_refunds)}</dd>
        <dt>+ Paid in</dt><dd class="num">${money(f.paid_in)}</dd><dt>− Paid out</dt><dd class="num">${money(f.paid_out)}</dd><dt>− Safe drops</dt><dd class="num">${money(f.cash_drops)}</dd>
        <dt class="strong">Expected</dt><dd class="num strong">${f.blind ? 'Hidden (blind close)' : money(s.expected_cash ?? f.expected_cash)}</dd>
        ${s.status === 'closed' ? html`<dt class="strong">Counted</dt><dd class="num strong">${money(s.counted_cash)}</dd><dt class="strong">Variance</dt><dd class="num strong" style="color:${s.variance === 0 ? 'var(--ok)' : 'var(--bad)'}">${money(s.variance, { sign: true })}</dd>` : ''}</dl></div>
        <div class="panel panel-body"><h3 style="margin-bottom:8px">Takings by method</h3><dl class="kv">${f.by_method.map((x) => html`<dt>${x.method_code} (${x.count})</dt><dd class="num">${money(x.total)}</dd>`)}
          <dt>Sales</dt><dd>${f.sales.count} · ${money(f.sales.total)}</dd><dt>Discounts</dt><dd class="num">${money(f.sales.discounts)}</dd><dt>Refunds</dt><dd>${f.refunds.count} · ${money(f.refunds.total)}</dd><dt>Voids</dt><dd>${f.voids.count} · ${money(f.voids.total)}</dd><dt>Cancelled carts</dt><dd>${f.cancelled_sales}</dd></dl></div></div>
      ${s.count_detail ? html`<div class="panel panel-body"><h3 style="margin-bottom:8px">Count by denomination</h3><div class="row wrap">${Object.entries(s.count_detail).sort((a, b) => b[0] - a[0]).map(([d, c]) => html`<span class="badge plain">${money(Number(d))} × ${c}</span>`)}</div></div>` : ''}
      <div class="panel"><div class="panel-head"><h3>Cash movements</h3></div>${table({ rows: s.cash_movements, empty: 'No cash in/out', columns: [{ key: 'created_at', label: 'Time', render: (r) => tm(r.created_at) }, { key: 'type', label: 'Type', render: (r) => titleCase(r.type) }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'reason', label: 'Reason' }, { key: 'reference', label: 'Ref' }, { key: 'user_name', label: 'By' }, { key: 'authorized_by_name', label: 'Authorized' }] })}</div>
      ${s.close_note ? html`<div class="muted small">Notes: ${s.close_note}</div>` : ''}</div>`,
    foot: html`${s.review_status === 'required' && can('session.manage_all') ? html`<button class="btn primary" data-review>Review variance</button>` : ''}${s.status === 'open' ? html`<button class="btn primary" data-close>Close & count</button>` : ''}<div class="grow"></div><button class="btn" data-dismiss>Close</button>`,
  });
  on(m.el, 'click', '[data-close]', async () => { m.close(); await closeSessionFlow(id); });
  on(m.el, 'click', '[data-review]', async () => {
    const r = await formDlg({ title: 'Review variance', sub: `${s.cashier_name}: ${money(s.variance, { sign: true })}`, size: 'narrow', cls: 'stack', submitText: 'Mark reviewed', fields: [{ name: 'note', label: 'Finding / action taken', type: 'textarea', required: true }], submit: (v) => post(`/api/sessions/${id}/review`, v) });
    if (r) { toast('Session reviewed', 'ok'); m.close(); }
  });
  await m.promise;
}

/** Count the drawer and close. With blind close, the cashier counts before seeing the expected figure. */
export async function closeSessionFlow(id) {
  let s;
  try { s = await get(`/api/sessions/${id}`); } catch (e) { showError(e); return false; }
  const denoms = (S.me.settings['pos.cash_denominations'] || []).slice().sort((a, b) => b - a);
  const key = newKey('close');
  const m = modal({
    title: `Close ${s.register_name}`, sub: `${s.number} · ${s.cashier_name} · opened ${dt(s.opened_at)}`, size: 'wide',
    body: html`<div class="stack"><div class="callout info">Count every note and coin in the drawer. ${s.figures.blind ? 'The expected amount is shown after you submit (blind count).' : ''}</div>
      <div class="grid g4">${denoms.map((d) => html`<div class="field"><label>${money(d)}</label><input class="input" type="number" min="0" step="1" data-den="${d}" placeholder="0" inputmode="numeric"></div>`)}</div>
      <div class="grid g2"><div class="field"><label>Total counted</label><input class="input xl" data-total inputmode="decimal" placeholder="0.00"><span class="hint">Fills from the denominations, or type the total directly.</span></div>
        <div class="field"><label>Note (optional)</label><textarea class="input" rows="3" data-note placeholder="Anything unusual during the shift"></textarea></div></div>
      ${s.figures.blind ? '' : html`<div class="tender-summary"><div class="line"><span>Expected</span><span>${money(s.figures.expected_cash)}</span></div><div class="line big"><span>Variance</span><span data-var>—</span></div></div>`}
      <div class="callout bad hidden" data-err></div></div>`,
    foot: html`<button class="btn" data-dismiss>Cancel</button><button class="btn primary" data-go>Close session</button>`,
  });
  let usedDenoms = false;
  const sync = () => {
    const vals = $$('[data-den]', m.el).map((i) => [Number(i.dataset.den), Number(i.value) || 0]);
    usedDenoms = vals.some(([, c]) => c > 0);
    if (usedDenoms) $('[data-total]', m.el).value = toMajor(vals.reduce((a, [d, c]) => a + d * c, 0));
    const v = $('[data-var]', m.el); const t = toMinor($('[data-total]', m.el).value);
    if (v) v.textContent = Number.isFinite(t) ? money(t - s.figures.expected_cash, { sign: true }) : '—';
  };
  on(m.el, 'input', '[data-den]', sync); on(m.el, 'input', '[data-total]', () => { usedDenoms = false; $$('[data-den]', m.el).forEach((i) => { i.value = ''; }); sync(); });
  let result = false;
  on(m.el, 'click', '[data-go]', async (e, btn) => {
    const err = $('[data-err]', m.el); err.classList.add('hidden');
    const total = toMinor($('[data-total]', m.el).value);
    if (!Number.isFinite(total) || $('[data-total]', m.el).value.trim() === '') { err.textContent = 'Enter the counted cash'; err.classList.remove('hidden'); return; }
    const body = { counted_cash: total, note: $('[data-note]', m.el).value || null };
    if (usedDenoms) body.denominations = Object.fromEntries($$('[data-den]', m.el).filter((i) => Number(i.value) > 0).map((i) => [i.dataset.den, Number(i.value)]));
    btn.disabled = true;
    try {
      const closed = await post(`/api/sessions/${id}/close`, body, { idempotencyKey: key });
      result = true; m.close();
      const v = closed.variance;
      await modal({
        title: 'Session closed', sub: closed.number, size: 'narrow',
        body: html`<div class="stack"><div class="tender-summary"><div class="line"><span>Expected</span><span>${money(closed.expected_cash)}</span></div><div class="line"><span>Counted</span><span>${money(closed.counted_cash)}</span></div>
          <div class="line big" style="color:${v === 0 ? 'var(--ok)' : 'var(--bad)'}"><span>${v === 0 ? 'Balanced' : v < 0 ? 'Short' : 'Over'}</span><span>${money(v, { sign: true })}</span></div></div>
          ${closed.review_status === 'required' ? html`<div class="callout warn">This variance is above the review threshold and has been flagged for a manager.</div>` : ''}</div>`,
        foot: html`<button class="btn primary" data-dismiss>Done</button>`,
      }).promise;
    } catch (ex) { err.textContent = errMsg(ex); err.classList.remove('hidden'); btn.disabled = false; }
  });
  await m.promise;
  return result;
}

export async function cashMovementFlow() {
  const r = await formDlg({
    title: 'Cash in / out', sub: 'Records non-sale cash through this drawer. Needs a supervisor unless your role allows it.', size: 'narrow', cls: 'stack', submitText: 'Record',
    fields: [{ name: 'type', label: 'Type', type: 'select', required: true, options: [{ value: 'cash_drop', label: 'Safe drop (drawer → safe)' }, { value: 'paid_out', label: 'Paid out (petty cash expense)' }, { value: 'paid_in', label: 'Paid in (add change/float)' }] },
      { name: 'amount', label: 'Amount', money: true, required: true }, { name: 'reason', label: 'Reason', required: true }, { name: 'reference', label: 'Reference (receipt/bag no.)' }],
    submit: (v) => withOverride((override) => post('/api/sessions/cash-movement', { ...v, override }, { idempotencyKey: newKey('cash') })),
  });
  if (r) toast('Cash movement recorded', 'ok');
  return r;
}
