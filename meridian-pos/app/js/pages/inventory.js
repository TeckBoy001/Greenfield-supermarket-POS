// Inventory: stock ledger, adjustments, goods receiving, transfers, low stock.
import { get, post, qs, newKey } from '../api.js';
import { S, html, mount, $, $$, on, money, qty, toast, showError, errMsg, modal, formDlg, table, can, debounce, periodHtml, bindPeriod, titleCase, toMinor, toMajor, dt } from '../ui.js';

const TYPE_LABEL = { opening: 'Opening', receive: 'Received', sale: 'Sale', return: 'Customer return', damage: 'Damaged', adjustment: 'Adjustment', stocktake: 'Stocktake', transfer_out: 'Transfer out', transfer_in: 'Transfer in', void_reversal: 'Void reversal', expired: 'Expired', theft: 'Theft/loss' };

export async function render(el, nav) {
  nav.setTitle('Inventory');
  const st = { tab: nav.query.tab || 'movements', location_id: (S.me.register && S.me.register.location_id) || (S.lookups.locations[0] || {}).id, product_id: nav.query.product || '', type: '', period: 'this_week', from: '', to: '' };
  mount(el, html`<div class="page-head"><div><h1>Inventory</h1><div class="sub">Stock is a ledger: every change is a movement with a reason, a person and a reference. Quantities are never overwritten.</div></div>
    <div class="row">${can('inventory.receive') ? html`<button class="btn primary" data-receive>Receive stock</button>` : ''}${can('inventory.adjust') ? html`<button class="btn" data-adjust>Adjust / write off</button>` : ''}${can('inventory.transfer') ? html`<button class="btn" data-transfer>Transfer</button>` : ''}</div></div>
    <div class="tabs" data-tabs>${[['movements', 'Movement history'], ['low', 'Low stock'], ['receipts', 'Goods received']].map(([k, l]) => html`<button data-tab="${k}" class="${st.tab === k ? 'on' : ''}">${l}</button>`)}</div>
    <div class="filters"><select class="input" data-loc style="width:200px">${S.lookups.locations.map((l) => html`<option value="${l.id}" ${l.id === st.location_id ? 'selected' : ''}>${l.name}</option>`)}</select><span data-extra></span></div>
    <div class="panel" data-list></div>`);
  const drawFilters = () => {
    mount($('[data-extra]', el), st.tab === 'movements' ? html`<span class="row wrap">${periodHtml(st)}<select class="input" data-type style="width:160px"><option value="">All movement types</option>${Object.entries(TYPE_LABEL).map(([k, l]) => html`<option value="${k}" ${st.type === k ? 'selected' : ''}>${l}</option>`)}</select>
      <input class="input" data-prod placeholder="Filter by product (name/SKU)" style="width:220px"></span>` : '');
  };
  const load = async () => {
    try {
      if (st.tab === 'movements') {
        const rows = await get(`/api/inventory/movements${qs({ location_id: st.location_id, product_id: st.product_id, type: st.type, period: st.period, from: st.from, to: st.to, limit: 500 })}`);
        mount($('[data-list]', el), table({ rows, empty: 'No stock movements in this period',
          columns: [{ key: 'created_at', label: 'When', type: 'datetime' }, { key: 'product_name', label: 'Product', render: (m) => html`<div class="strong">${m.product_name}</div><div class="xs muted">${m.sku}</div>` },
            { key: 'type', label: 'Movement', render: (m) => html`<span class="badge plain ${m.qty_change < 0 ? 'bad' : 'ok'}">${TYPE_LABEL[m.type] || m.type}</span>` },
            { key: 'qty_change', label: 'Change', num: true, render: (m) => html`<strong style="color:${m.qty_change < 0 ? 'var(--bad)' : 'var(--ok)'}">${m.qty_change > 0 ? '+' : ''}${qty(m.qty_change, m.unit)}</strong>` },
            { key: 'balance_after', label: 'Balance', num: true, render: (m) => qty(m.balance_after, m.unit) }, { key: 'reference_number', label: 'Reference', cls: 'mono', render: (m) => m.reference_number || '—' },
            { key: 'reason', label: 'Reason' }, { key: 'user_name', label: 'By', render: (m) => m.user_name || 'System' }] }));
      } else if (st.tab === 'low') {
        const rows = await get(`/api/inventory/low-stock${qs({ location_id: st.location_id })}`);
        mount($('[data-list]', el), table({ rows, empty: 'Nothing below minimum stock', emptyHint: 'Products appear here when on-hand quantity falls to their minimum level.',
          columns: [{ key: 'sku', label: 'SKU', cls: 'mono' }, { key: 'name', label: 'Product' }, { key: 'qty', label: 'On hand', num: true, render: (p) => html`<strong style="color:var(--bad)">${qty(p.qty, p.unit)}</strong>` }, { key: 'min_stock', label: 'Minimum', type: 'qty' }, { key: 'reorder_qty', label: 'Reorder qty', type: 'qty' }, { key: 'supplier_name', label: 'Supplier' }] }));
      } else {
        const rows = await get('/api/inventory/receipts');
        mount($('[data-list]', el), table({ rows, empty: 'No goods received yet', columns: [{ key: 'number', label: 'GRN', cls: 'mono' }, { key: 'created_at', label: 'Received', type: 'datetime' }, { key: 'location_name', label: 'Location' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'supplier_ref', label: 'Supplier invoice' }, { key: 'lines', label: 'Lines', type: 'int' }, { key: 'total_cost', label: 'Cost', type: 'money' }, { key: 'received_by_name', label: 'Received by' }] }));
      }
    } catch (e) { showError(e); }
  };
  on(el, 'click', '[data-tab]', (e, b) => { st.tab = b.dataset.tab; $$('[data-tab]', el).forEach((x) => x.classList.toggle('on', x === b)); drawFilters(); load(); });
  on(el, 'change', '[data-loc]', (e, s) => { st.location_id = s.value; load(); });
  on(el, 'change', '[data-type]', (e, s) => { st.type = s.value; load(); });
  on(el, 'input', '[data-prod]', debounce(async (e) => {
    const q = e.target.value.trim();
    if (!q) { st.product_id = ''; return load(); }
    const r = await get(`/api/products${qs({ q, limit: 1, active: 'all' })}`).catch(() => ({ rows: [] }));
    st.product_id = r.rows[0] ? r.rows[0].id : 'none'; load();
  }, 350));
  bindPeriod(el, st, load);
  on(el, 'click', '[data-receive]', async () => { if (await receiveDialog(st.location_id)) { st.tab = 'receipts'; $$('[data-tab]', el).forEach((x) => x.classList.toggle('on', x.dataset.tab === 'receipts')); drawFilters(); load(); } });
  on(el, 'click', '[data-adjust]', async () => { if (await adjustDialog(st.location_id)) load(); });
  on(el, 'click', '[data-transfer]', async () => { if (await transferDialog(st.location_id)) load(); });
  drawFilters(); load();
}

/** Product line picker used by receive/transfer. */
function linePicker(box, { withCost = false, locationId }) {
  const lines = [];
  const draw = () => mount($('[data-lines]', box), lines.length ? html`<table class="t"><thead><tr><th>Product</th><th class="num">On hand</th><th style="width:120px">Qty</th>${withCost ? html`<th style="width:150px">Unit cost</th>` : ''}<th></th></tr></thead><tbody>
    ${lines.map((l, i) => html`<tr><td><div class="strong">${l.name}</div><div class="xs muted">${l.sku}</div></td><td class="num">${qty(l.stock, l.unit)}</td><td><input class="input" type="number" min="0" step="any" data-lq="${i}" value="${l.qty}"></td>
      ${withCost ? html`<td><input class="input" data-lc="${i}" inputmode="decimal" value="${toMajor(l.unit_cost)}"></td>` : ''}<td><button class="btn sm ghost" type="button" data-lr="${i}">×</button></td></tr>`)}</tbody></table>` : html`<div class="muted small" style="padding:10px">Search and add products above.</div>`);
  mount(box, html`<div class="stack"><div style="position:relative"><input class="input" data-ps placeholder="Search product by name, SKU or scan barcode" autocomplete="off"><div data-pr style="position:absolute;left:0;right:0;top:40px;z-index:5"></div></div><div class="panel" data-lines></div></div>`);
  const results = $('[data-pr]', box);
  const search = debounce(async (q) => {
    if (!q) return mount(results, '');
    const r = await get(`/api/products${qs({ q, limit: 8, location_id: locationId() })}`).catch(() => ({ rows: [] }));
    mount(results, r.rows.length ? html`<div class="list-pick" style="box-shadow:var(--shadow)">${r.rows.map((p) => html`<button type="button" data-add='${JSON.stringify({ id: p.id, name: p.name, sku: p.sku, unit: p.unit, stock: p.stock, cost: p.cost })}'><span>${p.name} <span class="muted xs">${p.sku}</span></span><span class="muted small">${qty(p.stock, p.unit)} on hand</span></button>`)}</div>` : '');
  }, 200);
  on(box, 'input', '[data-ps]', (e) => search(e.target.value.trim()));
  on(box, 'keydown', '[data-ps]', (e) => { if (e.key === 'Enter') { e.preventDefault(); const first = results.querySelector('[data-add]'); if (first) first.click(); } });
  on(box, 'click', '[data-add]', (e, b) => {
    const p = JSON.parse(b.dataset.add);
    const existing = lines.find((l) => l.product_id === p.id);
    if (existing) existing.qty += 1; else lines.push({ product_id: p.id, name: p.name, sku: p.sku, unit: p.unit, stock: p.stock, qty: 1, unit_cost: p.cost });
    $('[data-ps]', box).value = ''; mount(results, ''); draw(); $('[data-ps]', box).focus();
  });
  on(box, 'input', '[data-lq]', (e, i) => { lines[Number(i.dataset.lq)].qty = Number(i.value); });
  on(box, 'input', '[data-lc]', (e, i) => { lines[Number(i.dataset.lc)].unit_cost = toMinor(i.value); });
  on(box, 'click', '[data-lr]', (e, b) => { lines.splice(Number(b.dataset.lr), 1); draw(); });
  draw();
  return () => lines.filter((l) => l.qty > 0);
}

async function receiveDialog(defaultLoc) {
  let getLines;
  const m = modal({
    title: 'Receive stock', sub: 'Goods received note (GRN): adds stock with cost and supplier reference.', size: 'xwide',
    body: html`<div class="stack"><div class="grid g4"><div class="field"><label>Into location</label><select class="input" data-loc>${S.lookups.locations.map((l) => html`<option value="${l.id}" ${l.id === defaultLoc ? 'selected' : ''}>${l.name}</option>`)}</select></div>
      <div class="field"><label>Supplier</label><select class="input" data-sup><option value="">— none —</option>${S.lookups.suppliers.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
      <div class="field"><label>Supplier invoice / delivery ref</label><input class="input" data-ref></div>
      <div class="field" style="justify-content:flex-end">${can('product.price') ? html`<label class="check"><input type="checkbox" data-uc> Update product cost prices</label>` : ''}</div></div>
      <div data-picker></div><div class="field"><label>Note</label><input class="input" data-note></div><div class="callout bad hidden" data-err></div></div>`,
    foot: html`<button class="btn" data-dismiss>Cancel</button><button class="btn primary" data-go>Receive</button>`,
  });
  getLines = linePicker($('[data-picker]', m.el), { withCost: true, locationId: () => $('[data-loc]', m.el).value });
  let ok = false;
  const key = newKey('grn');
  on(m.el, 'click', '[data-go]', async (e, b) => {
    const err = $('[data-err]', m.el); err.classList.add('hidden');
    const items = getLines().map((l) => ({ product_id: l.product_id, qty: l.qty, unit_cost: l.unit_cost }));
    if (!items.length) { err.textContent = 'Add at least one product'; err.classList.remove('hidden'); return; }
    b.disabled = true;
    try {
      const r = await post('/api/inventory/receive', { location_id: $('[data-loc]', m.el).value, supplier_id: $('[data-sup]', m.el).value || null, supplier_ref: $('[data-ref]', m.el).value || null, note: $('[data-note]', m.el).value || null, update_cost: !!($('[data-uc]', m.el) && $('[data-uc]', m.el).checked), items }, { idempotencyKey: key });
      toast(`${r.number} received — ${money(r.total_cost)}`, 'ok'); ok = true; m.close();
    } catch (ex) { err.textContent = errMsg(ex); err.classList.remove('hidden'); b.disabled = false; }
  });
  await m.promise;
  return ok;
}

async function transferDialog(defaultLoc) {
  let ok = false;
  const m = modal({
    title: 'Transfer stock', sub: 'Moves stock between locations. Both sides are recorded as movements.', size: 'xwide',
    body: html`<div class="stack"><div class="grid g3"><div class="field"><label>From</label><select class="input" data-from>${S.lookups.locations.map((l) => html`<option value="${l.id}" ${l.type === 'warehouse' ? 'selected' : ''}>${l.name}</option>`)}</select></div>
      <div class="field"><label>To</label><select class="input" data-to>${S.lookups.locations.map((l) => html`<option value="${l.id}" ${l.id === defaultLoc ? 'selected' : ''}>${l.name}</option>`)}</select></div><div class="field"><label>Note</label><input class="input" data-note></div></div>
      <div data-picker></div><div class="callout bad hidden" data-err></div></div>`,
    foot: html`<button class="btn" data-dismiss>Cancel</button><button class="btn primary" data-go>Transfer</button>`,
  });
  const getLines = linePicker($('[data-picker]', m.el), { locationId: () => $('[data-from]', m.el).value });
  const key = newKey('trf');
  on(m.el, 'click', '[data-go]', async (e, b) => {
    const err = $('[data-err]', m.el); err.classList.add('hidden');
    b.disabled = true;
    try {
      const r = await post('/api/inventory/transfer', { from_location_id: $('[data-from]', m.el).value, to_location_id: $('[data-to]', m.el).value, note: $('[data-note]', m.el).value || null, items: getLines().map((l) => ({ product_id: l.product_id, qty: l.qty })) }, { idempotencyKey: key });
      toast(`${r.number} completed`, 'ok'); ok = true; m.close();
    } catch (ex) { err.textContent = errMsg(ex); err.classList.remove('hidden'); b.disabled = false; }
  });
  await m.promise;
  return ok;
}

async function adjustDialog(defaultLoc) {
  let product = null;
  const m = modal({
    title: 'Adjust stock', sub: 'Record a stocktake count, damage, expiry, loss, or a correction. Every adjustment needs a reason.', size: 'wide',
    body: html`<div class="stack"><div class="field"><label>Product</label><input class="input" data-ps placeholder="Search or scan product" autocomplete="off"><div data-pr></div></div><div data-chosen></div>
      <div class="grid g3"><div class="field"><label>Location</label><select class="input" data-loc>${S.lookups.locations.map((l) => html`<option value="${l.id}" ${l.id === defaultLoc ? 'selected' : ''}>${l.name}</option>`)}</select></div>
        <div class="field"><label>Type</label><select class="input" data-type><option value="stocktake">Stocktake count (set to counted qty)</option><option value="damage">Damaged (write off)</option><option value="expired">Expired (write off)</option><option value="theft">Theft / unexplained loss</option><option value="adjustment">Correction (+/−)</option></select></div>
        <div class="field"><label data-qlabel>Counted quantity</label><input class="input" type="number" step="any" data-qty></div></div>
      <div class="field"><label>Reason</label><input class="input" data-reason placeholder="e.g. Monthly count aisle 4 / crushed in delivery"></div><div class="callout bad hidden" data-err></div></div>`,
    foot: html`<button class="btn" data-dismiss>Cancel</button><button class="btn primary" data-go>Record adjustment</button>`,
  });
  const search = debounce(async (q) => {
    if (!q) return mount($('[data-pr]', m.el), '');
    const r = await get(`/api/products${qs({ q, limit: 6, location_id: $('[data-loc]', m.el).value })}`).catch(() => ({ rows: [] }));
    mount($('[data-pr]', m.el), html`<div class="list-pick">${r.rows.map((p) => html`<button type="button" data-pick='${JSON.stringify({ id: p.id, name: p.name, sku: p.sku, unit: p.unit, stock: p.stock })}'><span>${p.name} <span class="xs muted">${p.sku}</span></span><span class="small muted">${qty(p.stock, p.unit)}</span></button>`)}</div>`);
  }, 200);
  on(m.el, 'input', '[data-ps]', (e) => search(e.target.value.trim()));
  on(m.el, 'click', '[data-pick]', (e, b) => { product = JSON.parse(b.dataset.pick); mount($('[data-pr]', m.el), ''); $('[data-ps]', m.el).value = product.name; mount($('[data-chosen]', m.el), html`<div class="callout info">${product.name} (${product.sku}) — system shows <strong>${qty(product.stock, product.unit)}</strong> at the selected location.</div>`); $('[data-qty]', m.el).focus(); });
  on(m.el, 'change', '[data-type]', (e, s) => { $('[data-qlabel]', m.el).textContent = s.value === 'stocktake' ? 'Counted quantity' : s.value === 'adjustment' ? 'Change (+ adds, − removes)' : 'Quantity written off'; });
  let ok = false;
  const key = newKey('adj');
  on(m.el, 'click', '[data-go]', async (e, b) => {
    const err = $('[data-err]', m.el); err.classList.add('hidden');
    if (!product) { err.textContent = 'Choose a product'; err.classList.remove('hidden'); return; }
    const type = $('[data-type]', m.el).value; const q = Number($('[data-qty]', m.el).value);
    b.disabled = true;
    try {
      const r = await post('/api/inventory/adjust', { product_id: product.id, location_id: $('[data-loc]', m.el).value, type, reason: $('[data-reason]', m.el).value, ...(type === 'stocktake' ? { counted_qty: q } : { qty: q }) }, { idempotencyKey: key });
      toast(r.unchanged ? 'Count matches system — no change recorded' : `Stock now ${qty(r.balance, product.unit)}`, 'ok'); ok = true; m.close();
    } catch (ex) { err.textContent = errMsg(ex); err.classList.remove('hidden'); b.disabled = false; }
  });
  await m.promise;
  return ok;
}
void formDlg; void titleCase; void dt;
