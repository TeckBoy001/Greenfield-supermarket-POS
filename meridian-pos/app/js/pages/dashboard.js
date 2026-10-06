// Operational dashboard — only numbers someone can act on.
import { get } from '../api.js';
import { S, html, mount, $, money, qty, tm, showError, badge, can, icon, ago } from '../ui.js';

export async function render(el, nav) {
  nav.setTitle('Dashboard');
  let timer;
  const load = async () => {
    let d;
    try { d = await get('/api/dashboard'); } catch (e) { return showError(e); }
    const t = d.today; const ys = d.yesterday_same_time;
    const delta = (a, b) => { if (!b) return html`<span class="muted">no sales same time yesterday</span>`; const p = ((a - b) / b) * 100; return html`<span class="delta ${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(1)}%</span> <span class="muted">vs same time yesterday</span>`; };
    const maxH = Math.max(1, ...d.hourly.map((h) => h.sales));
    const nowH = Number(new Intl.DateTimeFormat('en-GB', { timeZone: S.me.business.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const hours = d.hourly.slice(7, 22);
    const payTotal = d.payments.reduce((a, p) => a + p.amount, 0) || 1;
    const F = d.finance;
    const alerts = [];
    if (!d.network.online) alerts.push(['bad', 'Offline — electronic payments unavailable. Cash sales continue and will sync.', '#/settings/network']);
    if (d.network.outbox_conflicts) alerts.push(['bad', `${d.network.outbox_conflicts} sync conflict(s) need review`, '#/settings/network']);
    if (F && F.inflight_payments) alerts.push(['warn', `${F.inflight_payments} electronic payment(s) awaiting provider confirmation`, '#/payments?status=inflight']);
    if (F && F.failed_refunds) alerts.push(['bad', `${F.failed_refunds} refund(s) failed to pay back — customer still owed`, '#/refunds']);
    if (F && F.sessions_to_review) alerts.push(['warn', `${F.sessions_to_review} cash session variance(s) need review`, '#/sessions']);
    if (F && F.settlements_discrepancy) alerts.push(['bad', `${F.settlements_discrepancy} settlement(s) with discrepancies`, '#/settlements']);
    if (F && F.payouts_pending.count) alerts.push(['warn', `${F.payouts_pending.count} payout(s) awaiting approval/payment · ${money(F.payouts_pending.amount)}`, '#/payouts']);
    if (d.inventory && d.inventory.out_of_stock) alerts.push(['warn', `${d.inventory.out_of_stock} product(s) out of stock`, '#/inventory?tab=low']);

    mount(el, html`<div class="page-head"><div><h1>Today</h1><div class="sub">Live figures for ${new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: S.me.business.timezone }).format(new Date())} · refreshed ${tm(new Date().toISOString())}</div></div>
        ${can('pos.sell') ? html`<a class="btn primary" href="#/pos">${icon('pos', 16)} Open checkout</a>` : ''}</div>
      ${alerts.length ? html`<div class="stack tight" style="margin-bottom:16px">${alerts.map(([k, msg, href]) => html`<a class="callout has-icon ${k}" href="${href}" style="text-decoration:none">${icon('alert', 16)} <span class="grow">${msg}</span><span>Review →</span></a>`)}</div>` : ''}
      <div class="grid g4" style="margin-bottom:16px">
        <div class="panel kpi"><div class="label">Sales today</div><div class="value">${money(t.sales)}</div><div class="delta">${delta(t.sales, ys.sales)}</div></div>
        <div class="panel kpi"><div class="label">Transactions</div><div class="value">${t.transactions}</div><div class="delta">${delta(t.transactions, ys.transactions)}</div></div>
        <div class="panel kpi"><div class="label">Average basket</div><div class="value">${money(t.avg_basket)}</div><div class="delta muted">Yesterday ${money(d.yesterday.avg_basket)}</div></div>
        <div class="panel kpi"><div class="label">Refunds & voids</div><div class="value">${money(t.refunds.total)}</div><div class="delta muted">${t.refunds.count} today · discounts given ${money(t.discounts)}</div></div>
      </div>
      <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr);margin-bottom:16px">
        <div class="panel"><div class="panel-head"><h2>Sales by hour</h2><span class="muted small">07:00–21:00</span></div><div class="panel-body">
          <div class="bars">${hours.map((h) => html`<div class="b ${h.hour === nowH ? 'now' : ''}" style="height:${Math.max(1, (h.sales / maxH) * 100)}%" data-tip="${String(h.hour).padStart(2, '0')}:00 · ${money(h.sales)} · ${h.transactions} sales"></div>`)}</div>
          <div class="bar-axis">${hours.map((h) => html`<span>${h.hour % 2 ? '' : String(h.hour).padStart(2, '0')}</span>`)}</div></div></div>
        <div class="panel"><div class="panel-head"><h2>Payment mix</h2></div><div class="panel-body stack tight">${d.payments.length ? d.payments.map((p) => html`<div><div class="row between small"><span>${p.name || p.method_code} <span class="muted">(${p.count})</span></span><strong class="num">${money(p.amount)}</strong></div><div class="meter"><i style="width:${(p.amount / payTotal) * 100}%"></i></div></div>`) : html`<div class="muted">No payments yet today</div>`}</div></div>
      </div>
      <div class="grid g3">
        <div class="panel"><div class="panel-head"><h2>Top products today</h2></div><div class="panel-body flush">${d.top_products.length ? html`<table class="t">${d.top_products.map((p) => html`<tr><td>${p.name}</td><td class="num muted">${qty(p.qty)}</td><td class="num strong">${money(p.revenue)}</td></tr>`)}</table>` : html`<div class="empty">No sales yet</div>`}</div></div>
        <div class="panel"><div class="panel-head"><h2>Open registers</h2><a class="small" href="#/sessions">All sessions</a></div><div class="panel-body flush">${d.sessions.length ? html`<table class="t">${d.sessions.map((s) => html`<tr><td><div class="strong">${s.register}</div><div class="xs muted">${s.cashier} · since ${tm(s.opened_at)}</div></td><td class="num">${s.sales_count}</td><td class="num strong">${money(s.sales_total)}</td></tr>`)}</table>` : html`<div class="empty">No registers open</div>`}
          <div class="small muted" style="padding:10px 14px;border-top:1px solid var(--line)">${d.held_sales} held sale(s) across the store</div></div></div>
        ${d.inventory ? html`<div class="panel"><div class="panel-head"><h2>Stock alerts</h2><a class="small" href="#/inventory?tab=low">${d.inventory.low_stock} low</a></div><div class="panel-body flush">${d.inventory.items.length ? html`<table class="t">${d.inventory.items.map((p) => html`<tr><td>${p.name}<div class="xs muted">${p.supplier_name || ''}</div></td><td class="num">${p.qty <= 0 ? badge('bad', 'Out') : html`<span class="strong">${qty(p.qty, p.unit)}</span>`}<div class="xs muted">min ${qty(p.min_stock)}</div></td></tr>`)}</table>` : html`<div class="empty">All stocked</div>`}</div></div>` : ''}
      </div>
      ${F ? html`<h2 style="margin:22px 0 10px">Money flow</h2><div class="grid g4">
        <div class="panel kpi"><div class="label">Unsettled electronic</div><div class="value">${money(F.unsettled.amount)}</div><div class="delta muted">${F.unsettled.count} payment(s) not yet in a provider settlement</div></div>
        <div class="panel kpi"><div class="label">Last settlement</div><div class="value" style="font-size:18px">${F.last_settlement ? money(F.last_settlement.net_amount) : '—'}</div><div class="delta">${F.last_settlement ? html`${F.last_settlement.provider_code} · ${F.last_settlement.settlement_date} ${badge(F.last_settlement.status)}` : html`<span class="muted">none yet</span>`}</div></div>
        <div class="panel kpi"><div class="label">Awaiting funds in bank</div><div class="value">${F.settlements_awaiting_funds}</div><div class="delta muted">settlement(s) not yet confirmed received</div></div>
        <div class="panel kpi"><div class="label">Reconciliation</div><div class="value" style="font-size:18px">${F.last_recon ? badge(F.last_recon.status) : '—'}</div><div class="delta muted">${F.last_recon ? `Last run for ${F.last_recon.business_date}` : 'Not run yet'} · ${F.recon_issues} open issue(s)</div></div>
      </div>` : ''}
      <div class="muted xs" style="margin-top:16px">Sync: ${d.network.outbox_pending} record(s) waiting · last connectivity check ${ago(d.network.last_check)}</div>`);
  };
  await load();
  timer = setInterval(load, 30000);
  return () => clearInterval(timer);
}
void $;
