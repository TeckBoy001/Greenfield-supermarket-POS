// Reports: one definition drives the on-screen table, CSV and PDF exports.
import { get, qs, download } from '../api.js';
import { S, html, mount, $, $$, on, money, showError, table, periodHtml, bindPeriod, titleCase, dt } from '../ui.js';

export async function render(el, nav) {
  nav.setTitle('Reports');
  let catalog;
  try { catalog = await get('/api/reports'); } catch (e) { return showError(e); }
  const st = { key: nav.params[0] || (catalog[0] && catalog[0].key), period: 'this_week', from: '', to: '', cashier_id: '', payment_method: '', category_id: '', location_id: '' };
  mount(el, html`<div class="page-head"><div><h1>Reports</h1><div class="sub">Filter, review on screen, export to CSV (spreadsheets) or PDF.</div></div><div class="row"><button class="btn" data-csv>Export CSV</button><button class="btn" data-pdf>Export PDF</button></div></div>
    <div class="grid" style="grid-template-columns:230px minmax(0,1fr);align-items:start">
      <div class="panel" style="position:sticky;top:0"><div class="list-pick" style="border:0">${catalog.map((r) => html`<button data-rep="${r.key}" class="${r.key === st.key ? 'on' : ''}">${r.title}</button>`)}</div></div>
      <div class="stack"><div class="filters" data-filters></div><div data-out></div></div></div>`);
  const drawFilters = () => {
    const rep = catalog.find((r) => r.key === st.key);
    mount($('[data-filters]', el), html`${rep && rep.period ? periodHtml(st) : ''}
      ${['sales_summary'].includes(st.key) && S.lookups.staff.length ? html`<select class="input" data-f="cashier_id" style="width:170px"><option value="">All cashiers</option>${S.lookups.staff.map((u) => html`<option value="${u.id}" ${st.cashier_id === u.id ? 'selected' : ''}>${u.full_name}</option>`)}</select>` : ''}
      ${['sales_summary', 'product_performance'].includes(st.key) ? html`<select class="input" data-f="payment_method" style="width:170px"><option value="">All payment methods</option>${S.lookups.methods.map((m) => html`<option value="${m.code}" ${st.payment_method === m.code ? 'selected' : ''}>${m.name}</option>`)}</select>` : ''}
      ${['product_performance', 'inventory_valuation'].includes(st.key) ? html`<select class="input" data-f="category_id" style="width:180px"><option value="">All categories</option>${S.lookups.categories.map((c) => html`<option value="${c.id}" ${st.category_id === c.id ? 'selected' : ''}>${c.name}</option>`)}</select>` : ''}
      ${['sales_summary', 'inventory_valuation', 'low_stock', 'inventory_movements'].includes(st.key) ? html`<select class="input" data-f="location_id" style="width:180px"><option value="">${st.key === 'sales_summary' ? 'All locations' : 'Main location'}</option>${S.lookups.locations.map((l) => html`<option value="${l.id}" ${st.location_id === l.id ? 'selected' : ''}>${l.name}</option>`)}</select>` : ''}`);
  };
  const params = () => ({ period: st.period, from: st.from, to: st.to, cashier_id: st.cashier_id, payment_method: st.payment_method, category_id: st.category_id, location_id: st.location_id });
  const load = async () => {
    const out = $('[data-out]', el);
    mount(out, html`<div class="panel panel-body muted">Loading…</div>`);
    try {
      const r = await get(`/api/reports/${st.key}${qs(params())}`);
      const summary = Object.entries(r.summary || {});
      const moneyKey = (k) => { const c = r.columns.find((x) => x.key === k); return (c && c.type === 'money') || /amount|sales|net|gross|fees|value|revenue|refunds|voids|discounts|tax|cost|margin|total|paid|basket|variance|spend/.test(k); };
      mount(out, html`<div class="panel"><div class="panel-head"><div><h2>${r.title}</h2><div class="muted small">${r.period ? `${dt(r.period.from + 'T12:00:00Z', { time: false })} – ${dt(r.period.to + 'T12:00:00Z', { time: false })}` : 'Current position'} · ${r.rows.length} row(s)</div></div></div>
        ${summary.length ? html`<div class="row wrap" style="gap:22px;padding:12px 16px;border-bottom:1px solid var(--line)">${summary.map(([k, v]) => html`<div><div class="label">${titleCase(k)}</div><div class="strong num" style="font-size:16px">${moneyKey(k) ? money(v) : v}</div></div>`)}</div>` : ''}
        ${table({ rows: r.rows, columns: r.columns, empty: 'No data for this selection' })}
        ${(r.notes || []).length ? html`<div class="muted small" style="padding:10px 16px;border-top:1px solid var(--line)">${r.notes.map((n) => html`<div>${n}</div>`)}</div>` : ''}</div>`);
    } catch (e) { mount(out, html`<div class="callout bad">${e.message}</div>`); }
  };
  on(el, 'click', '[data-rep]', (e, b) => { st.key = b.dataset.rep; $$('[data-rep]', el).forEach((x) => x.classList.toggle('on', x === b)); history.replaceState(null, '', `#/reports/${st.key}`); drawFilters(); load(); });
  on(el, 'change', '[data-f]', (e, s) => { st[s.dataset.f] = s.value; load(); });
  bindPeriod(el, st, load);
  on(el, 'click', '[data-csv]', () => download(`/api/reports/${st.key}/export${qs({ ...params(), format: 'csv' })}`, `${st.key}.csv`).catch(showError));
  on(el, 'click', '[data-pdf]', () => download(`/api/reports/${st.key}/export${qs({ ...params(), format: 'pdf' })}`, `${st.key}.pdf`).catch(showError));
  drawFilters(); load();
}
