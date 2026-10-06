// Product catalogue — the single source the POS sells from.
import { get, post, put, del, qs, download } from '../api.js';
import { S, html, mount, $, on, money, qty, toast, showError, modal, formDlg, badge, table, can, debounce, dt, titleCase } from '../ui.js';

export async function render(el, nav) {
  nav.setTitle('Products');
  const f = { q: '', category_id: '', active: 'active', low_stock: '', location_id: (S.me.register && S.me.register.location_id) || (S.lookups.locations[0] || {}).id, offset: 0 };
  mount(el, html`<div class="page-head"><div><h1>Products</h1><div class="sub">Central catalogue used by every register. Price changes are permission-controlled and audited.</div></div>
    <div class="row"><button class="btn" data-export>Export CSV</button>${can('product.edit') ? html`<button class="btn" data-cats>Categories</button><button class="btn primary" data-new>New product</button>` : ''}</div></div>
    <div class="filters"><input class="input" data-q placeholder="Search name, SKU, barcode, brand" style="width:280px">
      <select class="input" data-cat style="width:190px"><option value="">All categories</option>${S.lookups.categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
      <select class="input" data-active style="width:130px"><option value="active">Active</option><option value="inactive">Disabled</option><option value="all">All</option></select>
      <select class="input" data-loc style="width:180px">${S.lookups.locations.map((l) => html`<option value="${l.id}" ${l.id === f.location_id ? 'selected' : ''}>Stock at ${l.name}</option>`)}</select>
      <label class="check"><input type="checkbox" data-low> Low stock only</label></div>
    <div class="panel" data-list></div>`);
  const load = async () => {
    try {
      const r = await get(`/api/products${qs({ ...f, limit: 200 })}`);
      mount($('[data-list]', el), html`${table({
        rows: r.rows, empty: 'No products match', onRowAttr: (p) => `class="clickable" data-id="${p.id}"`,
        columns: [{ key: 'sku', label: 'SKU', cls: 'mono' }, { key: 'name', label: 'Product', render: (p) => html`<div class="strong">${p.name} ${!p.is_active ? badge('inactive', 'Disabled') : ''} ${p.age_restricted ? html`<span class="badge warn plain">18+</span>` : ''}</div><div class="xs muted">${p.brand || ''}${p.barcode ? ` · ${p.barcode}` : ''}${p.plu ? ` · PLU ${p.plu}` : ''}</div>` },
          { key: 'category_name', label: 'Category' }, { key: 'unit', label: 'Unit' }, { key: 'tax_name', label: 'Tax' }, { key: 'price', label: 'Price', type: 'money' },
          ...(can('report.financial') || can('product.price') ? [{ key: 'cost', label: 'Cost', type: 'money' }, { key: 'margin', label: 'Margin', num: true, render: (p) => (p.price ? `${(((p.price - p.cost) / p.price) * 100).toFixed(1)}%` : '—') }] : []),
          { key: 'stock', label: 'Stock', num: true, render: (p) => (p.track_stock ? html`<span style="${p.stock <= p.min_stock ? 'color:var(--bad);font-weight:700' : ''}">${qty(p.stock, p.unit)}</span>` : html`<span class="muted">n/a</span>`) }],
      })}<div class="muted small" style="padding:10px 14px;border-top:1px solid var(--line)">${r.total} product(s)</div>`);
    } catch (e) { showError(e); }
  };
  on(el, 'input', '[data-q]', debounce((e) => { f.q = e.target.value; load(); }, 250));
  on(el, 'change', '[data-cat]', (e, s) => { f.category_id = s.value; load(); });
  on(el, 'change', '[data-active]', (e, s) => { f.active = s.value; load(); });
  on(el, 'change', '[data-loc]', (e, s) => { f.location_id = s.value; load(); });
  on(el, 'change', '[data-low]', (e, c) => { f.low_stock = c.checked ? '1' : ''; load(); });
  on(el, 'click', 'tr[data-id]', async (e, tr) => { await productModal(tr.dataset.id); load(); });
  on(el, 'click', '[data-new]', async () => { await productModal(null); load(); });
  on(el, 'click', '[data-export]', () => download('/api/products/export', 'products.csv').catch(showError));
  on(el, 'click', '[data-cats]', async () => { await categoriesModal(); S.lookups = await get('/api/lookups'); load(); });
  load();
}

function productFields(p, isNew) {
  const priceLocked = !can('product.price');
  return [
    { name: 'name', label: 'Product name', required: true, full: true },
    { name: 'sku', label: 'SKU', required: true, hint: 'Internal stock code' },
    { name: 'barcode', label: isNew ? 'Barcode' : 'Primary barcode', hint: isNew ? 'Scan or type the EAN/UPC' : 'Manage extra barcodes below', disabled: !isNew },
    { name: 'category_id', label: 'Category', type: 'select', placeholder: '— none —', options: S.lookups.categories.map((c) => ({ value: c.id, label: c.name })) },
    { name: 'brand', label: 'Brand' },
    { name: 'unit', label: 'Unit', type: 'select', required: true, options: ['each', 'kg', 'g', 'l', 'ml', 'pack', 'box', 'm'].map((u) => ({ value: u, label: u })) },
    { name: 'tax_rate_id', label: 'Tax', type: 'select', placeholder: '— no tax —', options: S.lookups.tax_rates.map((t) => ({ value: t.id, label: t.name })) },
    { name: 'price', label: `Selling price${S.me.business.prices_include_tax ? ' (tax inclusive)' : ' (before tax)'}`, money: true, required: true, disabled: priceLocked && !isNew, hint: priceLocked ? 'Requires price permission' : '' },
    { name: 'cost', label: 'Cost price', money: true, disabled: priceLocked, hint: priceLocked ? 'Requires price permission' : 'Latest purchase cost' },
    { name: 'supplier_id', label: 'Supplier', type: 'select', placeholder: '— none —', options: S.lookups.suppliers.map((s) => ({ value: s.id, label: s.name })) },
    { name: 'min_stock', label: 'Minimum stock (low-stock alert)', type: 'number', step: 'any', min: 0 },
    { name: 'reorder_qty', label: 'Reorder quantity', type: 'number', step: 'any', min: 0 },
    { name: 'is_weighed', label: 'Sold by weight (scale label / PLU)', type: 'checkbox' },
    { name: 'plu', label: 'PLU (4–5 digits, weighed items)', maxlength: 5 },
    { name: 'track_stock', label: 'Track stock', type: 'checkbox' },
    { name: 'allow_discount', label: 'Discounts allowed', type: 'checkbox' },
    { name: 'age_restricted', label: 'Age-restricted (ID check at till)', type: 'checkbox' },
    { name: 'is_active', label: 'Active (available for sale)', type: 'checkbox' },
    ...(isNew ? [{ name: 'opening_stock', label: 'Opening stock', type: 'number', step: 'any', min: 0 }, { name: 'location_id', label: 'At location', type: 'select', options: S.lookups.locations.map((l) => ({ value: l.id, label: l.name })) }] : []),
    { name: 'description', label: 'Description', type: 'textarea', full: true, rows: 2 },
  ];
}

async function productModal(id) {
  let p = null;
  if (id) { try { p = await get(`/api/products/${id}`); } catch (e) { return showError(e); } }
  const isNew = !p;
  const fields = productFields(p, isNew);
  const values = p ? { ...p } : { unit: 'each', track_stock: true, allow_discount: true, is_active: true, min_stock: 0, reorder_qty: 0, location_id: (S.me.register && S.me.register.location_id) || (S.lookups.locations[0] || {}).id };
  const readonly = !can('product.edit');
  const extra = p ? html`<div class="grid g2" style="margin-bottom:14px"><div class="panel panel-body"><div class="label" style="margin-bottom:6px">Stock by location</div>${p.stock_by_location.map((s) => html`<div class="row between small"><span>${s.location_name}</span><strong class="num">${qty(s.qty, p.unit)}</strong></div>`)}
      <div class="xs muted" style="margin-top:6px">Change stock in Inventory (adjust / receive / transfer) — never here.</div></div>
    <div class="panel panel-body"><div class="label" style="margin-bottom:6px">Barcodes</div>${p.barcodes.map((b) => html`<div class="row between small"><span class="mono">${b.barcode}</span><span>${b.pack_qty !== 1 ? `pack of ${b.pack_qty}` : ''} ${b.is_primary ? badge('active', 'primary') : ''} ${can('product.edit') ? html`<button class="btn sm ghost" type="button" data-rmbar="${b.id}">Remove</button>` : ''}</span></div>`)}
      ${can('product.edit') ? html`<div class="row" style="margin-top:8px"><input class="input" data-newbar placeholder="Add barcode" style="height:30px"><input class="input" data-pack type="number" min="1" value="1" style="width:70px;height:30px" title="Pack quantity"><button class="btn sm" type="button" data-addbar>Add</button></div><div class="xs muted">Pack quantity lets a case barcode ring up several units.</div>` : ''}</div></div>` : '';
  const res = await formDlg({
    title: isNew ? 'New product' : p.name, sub: isNew ? 'Add to the central catalogue' : html`${p.sku} · updated ${dt(p.updated_at)}`, size: 'wide', submitText: isNew ? 'Create product' : 'Save changes', extra,
    fields: readonly ? fields.map((x) => ({ ...x, disabled: true })) : fields, values,
    onMount: (m) => { if (p) bindBarcodes(m, p); },
    submit: async (v) => {
      if (readonly) return true;
      const body = { ...v };
      ['is_weighed', 'track_stock', 'allow_discount', 'age_restricted', 'is_active'].forEach((k) => { body[k] = !!v[k]; });
      if (!body.plu) delete body.plu;
      if (!isNew) { delete body.barcode; if (!can('product.price')) { delete body.price; delete body.cost; } }
      if (isNew) { if (!body.opening_stock) { delete body.opening_stock; delete body.location_id; } }
      Object.keys(body).forEach((k) => { if (body[k] === null && ['category_id', 'tax_rate_id', 'supplier_id', 'brand', 'description'].includes(k)) body[k] = null; });
      const out = isNew ? await post('/api/products', body) : await put(`/api/products/${id}`, body);
      toast(isNew ? `Created ${out.sku}` : 'Saved', 'ok');
      return out;
    },
  });
  return res;
}

function bindBarcodes(m, p) {
  on(m.el, 'click', '[data-addbar]', async () => {
    const input = m.el.querySelector('[data-newbar]'); const code = input.value.trim(); const pack = Number(m.el.querySelector('[data-pack]').value) || 1;
    if (!code) return input.focus();
    try {
      const up = await post(`/api/products/${p.id}/barcodes`, { barcode: code, pack_qty: pack });
      input.value = ''; toast(`Barcode ${code} added`, 'ok');
      const list = up.barcodes.map((b) => `${b.barcode}${b.pack_qty !== 1 ? ` (×${b.pack_qty})` : ''}`).join(', ');
      input.placeholder = `Now: ${list}`.slice(0, 80);
    } catch (ex) { showError(ex); }
  });
  on(m.el, 'click', '[data-rmbar]', async (e, b) => {
    try { await del(`/api/products/${p.id}/barcodes/${b.dataset.rmbar}`); b.closest('.row').remove(); toast('Barcode removed', 'ok'); } catch (ex) { showError(ex); }
  });
}

async function categoriesModal() {
  const draw = async (m) => {
    const cats = await get('/api/categories');
    mount($('[data-cats]', m.el), table({ rows: cats, columns: [{ key: 'name', label: 'Category' }, { key: 'product_count', label: 'Products', type: 'int' }, { key: 'is_active', label: 'Status', render: (c) => badge(c.is_active ? 'active' : 'inactive') },
      { key: 'x', label: '', render: (c) => html`<button class="btn sm" data-edit="${c.id}" data-name="${c.name}" data-active="${c.is_active}">Rename</button>` }] }));
  };
  const m = modal({ title: 'Categories', size: 'wide', body: html`<div class="stack"><form class="row" data-add><input class="input grow" name="name" placeholder="New category name" required><button class="btn primary">Add</button></form><div class="panel" data-cats></div></div>` });
  $('[data-add]', m.el).addEventListener('submit', async (e) => { e.preventDefault(); try { await post('/api/categories', { name: e.target.name.value }); e.target.reset(); draw(m); } catch (ex) { showError(ex); } });
  on(m.el, 'click', '[data-edit]', async (e, b) => {
    const v = await formDlg({ title: 'Edit category', size: 'narrow', cls: 'stack', fields: [{ name: 'name', label: 'Name', required: true, value: b.dataset.name }, { name: 'is_active', label: 'Active', type: 'checkbox', value: b.dataset.active === '1' }], submit: (x) => put(`/api/categories/${b.dataset.edit}`, x) });
    if (v) draw(m);
  });
  await draw(m);
  await m.promise;
}
void titleCase;
