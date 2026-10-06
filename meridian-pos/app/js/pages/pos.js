// Checkout (POS) screen — built for speed: scan-first, keyboard-driven, touch-friendly.
// Every cart change is persisted server-side immediately; this screen only displays server state.
import { get, post, patch, del, newKey, fetchText, qs, ApiError, getToken } from '../api.js';
import { S, html, mount, $, $$, on, money, qty, toast, showError, errMsg, modal, confirmDlg, formDlg, withOverride, badge, icon, can, toMinor, toMajor, tm, debounce, modalOpen, esc } from '../ui.js';
import { guardInput, parseScanInput, beep } from '../scanner.js';

export async function render(el, nav) {
  const st = { session: null, sale: null, methods: [], network: { online: true }, held: 0, selected: null, lastSaleId: null, destroyed: false, clock: null };
  let queue = Promise.resolve();
  const serial = (fn) => { queue = queue.then(fn, fn); return queue; };
  const me = S.me;

  if (!me.register) {
    mount(el, html`<div class="empty" style="padding-top:120px"><div class="ico">${icon('pos')}</div><strong>This terminal is not assigned to a register</strong>
      Sign out and choose a register on the sign-in screen to use checkout.<div style="margin-top:14px" class="row" style="justify-content:center"><button class="btn primary" data-out>Sign out</button> <a class="btn" href="#/dashboard">Back office</a></div></div>`);
    on(el, 'click', '[data-out]', nav.logout);
    return () => {};
  }

  async function loadState() {
    const s = await get('/api/pos/state');
    Object.assign(st, { session: s.session, sale: s.sale, methods: s.methods, network: s.network, held: s.held });
  }

  // ─────────────── layout ───────────────
  function layout() {
    mount(el, html`<div class="pos">
      <div>
        <div class="pos-top">
          <div class="brand-mark" style="width:26px;height:26px;font-size:13px">M</div>
          <div class="who"><strong>${me.business.name}</strong> · ${me.register.location_name} · ${me.register.name}</div>
          <div class="who" data-sess></div>
          <div class="grow"></div>
          <span data-net></span>
          <span class="who num" data-clock></span>
          <button class="btn sm" data-act="display" title="Open customer-facing display">${icon('display', 15)} Display</button>
          ${can('report.view') || can('sale.view_all') || can('session.open_close') ? html`<a class="btn sm" href="#/sales" title="Back office">Back office</a>` : ''}
          <button class="btn sm" data-act="lock" title="Lock terminal">${icon('lock', 15)}</button>
          <button class="btn sm" data-act="logout" title="Sign out">${icon('logout', 15)} ${me.user.full_name.split(' ')[0]}</button>
        </div>
        <div data-strip></div>
      </div>
      <div data-body style="min-height:0;display:grid"></div>
    </div>`);
    on(el, 'click', '[data-act]', (e, b) => action(b.dataset.act, b));
  }

  function renderTopbar() {
    const s = st.session;
    mount($('[data-sess]', el), s ? html`Session <strong>${s.number}</strong> · ${s.cashier_name} · since ${tm(s.opened_at)}` : html`<span style="color:#f6c35f">Register closed</span>`);
    const n = st.network || {};
    mount($('[data-net]', el), n.online ? html`<span class="net-pill"><span class="dot"></span>Online</span>` : html`<span class="net-pill off"><span class="dot"></span>Offline — cash & offline methods only</span>`);
    const testMode = st.methods.some((m) => m.test_mode && m.is_active);
    mount($('[data-strip]', el), html`${!n.online ? html`<div class="warn-strip">${icon('alert', 16)} Network/payment providers unreachable. Card, transfer and mobile payments are disabled. Cash sales continue and will sync automatically.</div>` : ''}
      ${testMode ? html`<div class="test-strip">TEST MODE — electronic payment methods are connected to simulated providers. No real money moves.</div>` : ''}`);
  }

  function renderBody() {
    const body = $('[data-body]', el);
    if (!st.session) return renderOpenRegister(body);
    mount(body, html`<div class="pos-body">
      <section class="pos-left">
        <form class="scanbar" data-scanform autocomplete="off">
          <input class="input grow" data-scan placeholder="Scan barcode, or type SKU / name and press Enter   (3*code for quantity)" aria-label="Scan or search" autocomplete="off" spellcheck="false">
          <button class="btn lg" type="button" data-act="search">${icon('search', 16)} Search <span class="kbd">F2</span></button>
        </form>
        <div class="cart" data-cart></div>
        <div class="cart-actions">
          <button class="btn" data-act="qty">Quantity<span class="kbd">F3</span></button>
          <button class="btn" data-act="hold">Hold<span class="kbd">F4</span></button>
          <button class="btn" data-act="recall">Recall <span data-heldcount></span><span class="kbd">F5</span></button>
          <button class="btn" data-act="discount">Discount<span class="kbd">F6</span></button>
          <button class="btn" data-act="customer">Customer<span class="kbd">F7</span></button>
          <button class="btn danger" data-act="remove">Remove line<span class="kbd">Del</span></button>
        </div>
      </section>
      <aside class="pos-right">
        <div class="cust-box" data-cust></div>
        <div class="totals" data-totals></div>
        <div data-payments></div>
        <div class="pay-grid" data-pay></div>
        <div class="pos-side-foot">
          <button class="btn sm" data-act="price">Price override</button>
          <button class="btn sm" data-act="cancel">Cancel sale</button>
          <button class="btn sm" data-act="returns">Returns</button>
          <button class="btn sm" data-act="last">Last receipt</button>
          <button class="btn sm" data-act="cash">Cash in/out</button>
          <button class="btn sm" data-act="close">Close register</button>
          <button class="btn sm ghost" data-act="help" title="Keyboard shortcuts">?</button>
        </div>
      </aside></div>`);
    const input = $('[data-scan]', el);
    $('[data-scanform]', el).addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; if (v.trim()) serial(() => scan(v)); });
    on($('[data-cart]', el), 'click', 'tr[data-line]', (e, tr) => { st.selected = tr.dataset.line; renderCart(); });
    on($('[data-cart]', el), 'click', '[data-inc]', (e, b) => { e.stopPropagation(); bumpQty(b.dataset.inc, +1); });
    on($('[data-cart]', el), 'click', '[data-dec]', (e, b) => { e.stopPropagation(); bumpQty(b.dataset.dec, -1); });
    on($('[data-pay]', el), 'click', '[data-method]', (e, b) => pay(b.dataset.method));
    on($('[data-cust]', el), 'click', '[data-act]', (e, b) => action(b.dataset.act));
    on($('[data-payments]', el), 'click', '[data-rmpay]', (e, b) => removePayment(b.dataset.rmpay));
    on($('[data-payments]', el), 'click', '[data-viewpay]', (e, b) => { const m = st.methods.find((x) => x.code === b.dataset.method); if (m) electronicDialog(m, st.sale.balance_due, b.dataset.viewpay); });
    renderAll();
    focusScan();
  }

  function renderAll() { renderTopbar(); if (st.session) { renderCart(); renderTotals(); renderPay(); renderCustomer(); renderPayments(); } const hc = $('[data-heldcount]', el); if (hc) hc.textContent = st.held ? `(${st.held})` : ''; }

  function renderCart() {
    const box = $('[data-cart]', el); if (!box) return;
    const items = st.sale ? st.sale.items : [];
    if (!items.length) {
      mount(box, html`<div class="cart-empty"><div><div class="ico" style="margin:auto;width:56px;height:56px;border-radius:14px;background:var(--accent-50);color:var(--accent);display:grid;place-items:center">${icon('pos', 28)}</div>
        <div class="big">Ready for the next customer</div><div>Scan an item to start a sale. ${st.held ? html`<strong>${st.held}</strong> sale(s) on hold — press <span class="kbd">F5</span> to recall.` : ''}</div></div></div>`);
      return;
    }
    if (!st.selected || !items.find((i) => i.id === st.selected)) st.selected = items[items.length - 1].id;
    const locked = st.sale.paid > 0 || st.sale.inflight > 0;
    mount(box, html`<table class="t"><thead><tr><th style="width:36px">#</th><th>Item</th><th class="num" style="width:150px">Qty</th><th class="num">Price</th><th class="num">Discount</th><th class="num">Total</th></tr></thead><tbody>
      ${items.map((i, idx) => html`<tr data-line="${i.id}" class="clickable ${i.id === st.selected ? 'sel' : ''} ${i.id === st.flash ? 'new' : ''}">
        <td class="muted">${idx + 1}</td>
        <td><div class="iname">${i.name}</div><div class="isub">${i.sku}${i.barcode ? ` · ${i.barcode}` : ''}${i.price_override_by ? html` · <span style="color:var(--warn)">price overridden (list ${money(i.list_price)})</span>` : ''}${i.line_discount_reason ? html` · <span style="color:var(--accent)">${i.line_discount_reason}</span>` : ''}</div></td>
        <td class="num">${i.unit === 'each' && !locked ? html`<span class="qty-ctl"><button data-dec="${i.id}" aria-label="Decrease">−</button><span>${qty(i.qty)}</span><button data-inc="${i.id}" aria-label="Increase">+</button></span>` : html`<strong>${qty(i.qty, i.unit)}</strong>`}</td>
        <td class="num">${money(i.unit_price)}${i.unit !== 'each' ? html`<span class="muted xs">/${i.unit}</span>` : ''}</td>
        <td class="num" style="color:var(--accent)">${i.line_discount + i.cart_discount_alloc ? `−${money(i.line_discount + i.cart_discount_alloc).replace('−', '')}` : ''}</td>
        <td class="num strong">${money(i.line_total)}</td></tr>`)}
    </tbody></table>`);
    const sel = box.querySelector('tr.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
    st.flash = null;
  }

  function renderTotals() {
    const s = st.sale;
    const box = $('[data-totals]', el); if (!box) return;
    const inclusive = me.business.prices_include_tax;
    const n = s ? s.items.reduce((a, i) => a + (i.unit === 'each' ? i.qty : 1), 0) : 0;
    mount(box, html`
      <div class="line"><span>Items</span><span>${n}</span></div>
      <div class="line"><span>Subtotal</span><span>${money(s ? s.subtotal : 0)}</span></div>
      ${s && s.discount_total ? html`<div class="line disc"><span>Discounts${s.cart_discount_reason ? ` (${s.cart_discount_reason})` : ''}</span><span>−${money(s.discount_total).replace('−', '')}</span></div>` : ''}
      <div class="line"><span>${inclusive ? 'VAT / tax included' : 'Tax'}</span><span>${money(s ? s.tax_total : 0)}</span></div>
      <div class="grand"><span class="lbl">Total</span><span class="amt" data-total>${money(s ? s.total : 0)}</span></div>
      ${s && s.paid ? html`<div class="line"><span>Paid</span><span>${money(s.paid)}</span></div><div class="due"><span>Balance due</span><span>${money(s.balance_due)}</span></div>` : ''}`);
  }

  function renderPayments() {
    const box = $('[data-payments]', el); if (!box) return;
    const pays = st.sale ? st.sale.payments.filter((p) => !['failed', 'cancelled', 'voided'].includes(p.status)) : [];
    if (!pays.length) { box.innerHTML = ''; return; }
    mount(box, html`<div style="padding:10px 14px 0"><div class="label" style="margin-bottom:6px">Payments on this sale</div><div class="list-pick">${pays.map((p) => html`<div class="row" style="padding:8px 10px;border-bottom:1px solid var(--line);background:#fff">
      <div class="grow"><strong>${p.method_name || p.method_code}</strong> ${badge(p.status)}<div class="xs muted">${p.tendered && p.method_type === 'cash' ? `Tendered ${money(p.tendered)} · ` : ''}${p.provider_ref ? `Ref ${p.provider_ref}` : ''}</div></div>
      <strong class="num">${money(p.amount)}</strong>
      ${['pending', 'processing'].includes(p.status) ? html`<button class="btn sm" data-viewpay="${p.id}" data-method="${p.method_code}">View</button>` : html`<button class="btn sm ghost" data-rmpay="${p.id}" title="Remove payment (supervisor)">×</button>`}
    </div>`)}</div></div>`);
  }

  function renderPay() {
    const box = $('[data-pay]', el); if (!box) return;
    const due = st.sale ? st.sale.balance_due : 0;
    const hasItems = st.sale && st.sale.items.length;
    const keys = { cash: 'F8', card: 'F9', transfer: 'F10' };
    const active = st.methods.filter((m) => m.is_active);
    mount(box, html`${active.map((m) => {
      const disabled = !hasItems || !m.available || (st.sale && st.sale.inflight > 0) || due <= 0;
      const sub = !m.available ? m.unavailable_reason : m.provider_code === 'manual' ? 'Record approval code' : m.type === 'cash' ? (due ? `Due ${money(due)}` : '') : m.test_mode ? 'Provider confirms' : '';
      return html`<button class="pay-btn ${m.type === 'cash' ? 'cash' : ''}" data-method="${m.code}" ${disabled ? html`disabled` : ''} title="${m.provider_name}">
        <span class="nm">${m.name}</span><span class="sub">${sub}</span>${m.shortcut || keys[m.code] ? html`<span class="kbd">${m.shortcut || keys[m.code]}</span>` : ''}${m.test_mode ? html`<span class="test">TEST</span>` : ''}</button>`;
    })}`);
  }

  function renderCustomer() {
    const box = $('[data-cust]', el); if (!box) return;
    const s = st.sale;
    if (s && s.customer_id) {
      mount(box, html`<div class="avatar">${s.customer_name.split(' ').map((x) => x[0]).slice(0, 2).join('')}</div><div class="grow"><div class="strong">${s.customer_name}</div><div class="xs muted">${s.customer_code} · ${s.customer_points || 0} points</div></div><button class="btn sm" data-act="customer">Change</button>`);
    } else {
      mount(box, html`<div class="avatar" style="background:var(--muted-50);color:var(--text-3)">${icon('user', 16)}</div><div class="grow"><div class="strong">Walk-in customer</div><div class="xs muted">No account needed</div></div><button class="btn sm" data-act="customer">Add customer <span class="kbd">F7</span></button>`);
    }
  }

  function renderOpenRegister(body) {
    const denoms = (me.settings['pos.cash_denominations'] || []);
    mount(body, html`<div style="display:grid;place-items:center;padding:40px"><div class="panel" style="width:min(560px,100%)">
      <div class="panel-head"><h2>Open ${me.register.name}</h2><span class="badge warn">Register closed</span></div>
      <form class="panel-body stack" data-open>
        <p class="muted" style="margin:0">Count the opening float in the drawer. Expected cash at close is calculated from this amount plus all cash sales, refunds and cash movements.</p>
        <div class="field"><label>Opening float</label><input class="input xl" data-float inputmode="decimal" value="${toMajor(5000000)}"></div>
        <details><summary class="small" style="cursor:pointer">Count by denomination</summary>
          <div class="grid g3" style="margin-top:10px">${denoms.map((d) => html`<div class="field"><label>${money(d)}</label><input class="input" type="number" min="0" step="1" data-den="${d}" placeholder="0"></div>`)}</div></details>
        <div class="callout bad hidden" data-err></div>
        <button class="btn primary lg" type="submit">Open register</button>
      </form></div></div>`);
    const form = $('[data-open]', body);
    on(form, 'input', '[data-den]', () => {
      const sum = $$('[data-den]', form).reduce((a, i) => a + Number(i.dataset.den) * (Number(i.value) || 0), 0);
      $('[data-float]', form).value = toMajor(sum);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = toMinor($('[data-float]', form).value);
      const err = $('[data-err]', form);
      if (!Number.isFinite(v) || v < 0) { err.textContent = 'Enter the opening float'; err.classList.remove('hidden'); return; }
      try { await post('/api/sessions/open', { opening_float: v }, { idempotencyKey: newKey('open') }); await loadState(); renderBody(); toast('Register opened', 'ok'); } catch (ex) { err.textContent = errMsg(ex); err.classList.remove('hidden'); }
    });
    setTimeout(() => { const f = $('[data-float]', form); if (f) { f.focus(); f.select(); } }, 30);
  }

  function focusScan() { if (modalOpen()) return; const i = $('[data-scan]', el); if (i && document.activeElement !== i) i.focus(); }
  function flashScan(ok) { const i = $('[data-scan]', el); if (!i) return; i.classList.remove('scan-flash', 'scan-err'); void i.offsetWidth; i.classList.add(ok ? 'scan-flash' : 'scan-err'); }

  async function ensureSale() {
    if (!st.sale) st.sale = await post('/api/pos/sales');
    return st.sale;
  }

  function apply(sale) {
    st.sale = sale && ['open'].includes(sale.status) ? sale : null;
    renderAll();
  }

  // ─────────────── scanning ───────────────
  async function scan(text, extra = {}) {
    const { qty: mult, code } = parseScanInput(text);
    try {
      const sale = await ensureSale();
      const body = { code, ...(mult ? { qty: mult } : {}), ...extra };
      const out = await post(`/api/sales/${sale.id}/items`, body);
      st.flash = out.last_item_id; st.selected = out.last_item_id;
      apply(out);
      flashScan(true); beep(true);
      (out.scan.warnings || []).forEach((w) => toast(w, 'warn'));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict' && e.details && e.details.code === 'age_check_required') {
        beep(false);
        const ok = await confirmDlg('Age-restricted item', `${e.message}\n\nHas the customer shown valid ID proving they are of legal age?`, { confirmText: 'ID checked — add item', cancelText: 'Do not sell' });
        if (ok) return scan(text, { ...extra, age_verified: true });
        return;
      }
      if (e instanceof ApiError && e.details && e.details.code === 'weight_required') {
        const w = await askWeight(e.message);
        if (w) return scan(text, { ...extra, weight: w });
        return;
      }
      if (e instanceof ApiError && e.details && ['no_session', 'session_other_user'].includes(e.details.code)) { await loadState(); renderBody(); }
      flashScan(false); beep(false);
      if (e instanceof ApiError && e.status === 404 && !/^\d+$/.test(code)) { openSearch(code); return; }
      if (e instanceof ApiError && e.details && e.details.code === 'payments_exist') { toast(e.message, 'warn'); return; }
      showError(e);
    } finally { focusScan(); }
  }

  function askWeight(message) {
    return formDlg({ title: 'Enter weight', sub: message, size: 'narrow', submitText: 'Add', cls: 'stack', fields: [{ name: 'w', label: 'Weight (kg)', type: 'number', step: '0.001', min: '0.001', required: true, autofocus: true }] }).then((v) => (v ? Number(v.w) : null));
  }

  async function addProduct(p) {
    try {
      const sale = await ensureSale();
      let body = { product_id: p.id };
      if (p.is_weighed) { const w = await askWeight(`${p.name} is sold by weight`); if (!w) return; body.weight = w; }
      for (;;) {
        try {
          const out = await post(`/api/sales/${sale.id}/items`, body);
          st.flash = out.last_item_id; st.selected = out.last_item_id; apply(out); beep(true);
          (out.scan.warnings || []).forEach((w) => toast(w, 'warn'));
          return;
        } catch (e) {
          if (e.details && e.details.code === 'age_check_required') {
            if (!(await confirmDlg('Age-restricted item', `${e.message}\n\nHas the customer shown valid ID?`, { confirmText: 'ID checked — add item', cancelText: 'Do not sell' }))) return;
            body = { ...body, age_verified: true }; continue;
          }
          throw e;
        }
      }
    } catch (e) { showError(e); } finally { focusScan(); }
  }

  // ─────────────── cart operations ───────────────
  const selectedItem = () => (st.sale ? st.sale.items.find((i) => i.id === st.selected) : null);

  function bumpQty(itemId, d) {
    serial(async () => {
      const it = st.sale && st.sale.items.find((i) => i.id === itemId);
      if (!it) return;
      st.selected = itemId;
      if (it.qty + d <= 0) return removeLine(itemId);
      try { apply(await patch(`/api/sales/${st.sale.id}/items/${itemId}`, { qty: it.qty + d })); } catch (e) { showError(e); }
    });
  }
  async function setQty() {
    const it = selectedItem(); if (!it) return toast('Select a line first', 'warn');
    const v = await formDlg({ title: `Quantity — ${it.name}`, size: 'narrow', cls: 'stack', submitText: 'Set quantity', fields: [{ name: 'q', label: it.unit === 'each' ? 'Quantity' : `Quantity (${it.unit})`, type: 'number', step: it.unit === 'each' ? '1' : '0.001', min: '0', value: it.qty, required: true, autofocus: true }] });
    if (!v) return focusScan();
    if (Number(v.q) === 0) return removeLine(it.id);
    serial(async () => { try { apply(await patch(`/api/sales/${st.sale.id}/items/${it.id}`, { qty: Number(v.q) })); } catch (e) { showError(e); } focusScan(); });
  }
  function removeLine(itemId) {
    const id = itemId || st.selected;
    if (!st.sale || !id) return;
    return serial(async () => {
      try { apply(await del(`/api/sales/${st.sale.id}/items/${id}`)); toast('Line removed', ''); } catch (e) { showError(e); }
      focusScan();
    });
  }

  const REASONS = ['Damaged packaging', 'Price match', 'Near expiry', 'Loyalty promotion', 'Staff discount', 'Manager goodwill', 'Other'];
  async function discount() {
    if (!st.sale || !st.sale.items.length) return toast('Scan items first', 'warn');
    const it = selectedItem();
    const limit = S.me.discount_limit;
    const res = await formDlg({
      title: 'Apply discount', sub: `Your limit is ${limit}% — larger discounts need a supervisor.`, size: 'narrow', cls: 'stack', submitText: 'Apply',
      fields: [
        { name: 'scope', label: 'Apply to', type: 'select', required: true, options: [...(it ? [{ value: 'line', label: `Selected item — ${it.name}` }] : []), { value: 'cart', label: 'Whole sale' }] },
        { name: 'type', label: 'Type', type: 'select', required: true, options: [{ value: 'percent', label: 'Percentage (%)' }, { value: 'amount', label: 'Fixed amount' }] },
        { name: 'value', label: 'Value', type: 'number', step: '0.01', min: '0.01', required: true },
        { name: 'reason', label: 'Reason', type: 'select', required: true, options: REASONS.map((r) => ({ value: r, label: r })) },
        { name: 'note', label: 'Note (required for "Other")', type: 'text' },
      ],
      submit: (v) => {
        const reason = v.reason === 'Other' ? (v.note || '') : v.reason + (v.note ? ` — ${v.note}` : '');
        if (!reason) throw new Error('Describe the reason');
        const value = v.type === 'amount' ? toMinor(v.value) : Number(v.value);
        return withOverride((override) => (v.scope === 'line'
          ? patch(`/api/sales/${st.sale.id}/items/${it.id}`, { discount: { type: v.type, value, reason }, override })
          : post(`/api/sales/${st.sale.id}/discount`, { type: v.type, value, reason, override })));
      },
    });
    if (res && res.id) { apply(res); toast('Discount applied', 'ok'); }
    focusScan();
  }
  async function priceOverride() {
    const it = selectedItem(); if (!it) return toast('Select a line first', 'warn');
    const res = await formDlg({
      title: 'Price override', sub: `${it.name} — list price ${money(it.list_price)}. Requires supervisor approval unless your role allows it.`, size: 'narrow', cls: 'stack', submitText: 'Change price',
      fields: [{ name: 'price', label: 'New unit price', money: true, required: true, value: it.unit_price, autofocus: true }, { name: 'reason', label: 'Reason', required: true, placeholder: 'e.g. shelf label shows lower price' }],
      submit: (v) => withOverride((override) => patch(`/api/sales/${st.sale.id}/items/${it.id}`, { unit_price: v.price, reason: v.reason, override })),
    });
    if (res && res.id) { apply(res); toast('Price changed — recorded in audit log', 'ok'); }
    focusScan();
  }

  async function hold() {
    if (!st.sale || !st.sale.items.length) return toast('Nothing to hold', 'warn');
    const v = await formDlg({ title: 'Hold sale', sub: 'The basket is saved and can be recalled on any lane in this store.', size: 'narrow', cls: 'stack', submitText: 'Hold sale', fields: [{ name: 'label', label: 'Label (optional)', placeholder: 'e.g. Customer went to fetch wallet', autofocus: true }] });
    if (!v) return focusScan();
    try { await post(`/api/sales/${st.sale.id}/hold`, { label: v.label }); st.sale = null; st.held++; renderAll(); toast('Sale held', 'ok'); } catch (e) { showError(e); }
    focusScan();
  }
  async function recall() {
    let list;
    try { list = await get('/api/pos/held'); } catch (e) { return showError(e); }
    const m = modal({
      title: 'Held sales', sub: 'Select a sale to resume it on this lane.', size: 'wide',
      body: list.length ? html`<div class="list-pick">${list.map((h, i) => html`<button data-id="${h.id}" class="${i === 0 ? 'on' : ''}"><div><div class="strong">${h.hold_label || h.number}</div><div class="xs muted">${h.number} · ${h.item_count} items · ${h.cashier_name}${h.customer_name ? ` · ${h.customer_name}` : ''} · held ${tm(h.updated_at)}</div></div><strong class="num">${money(h.total)}</strong></button>`)}</div>`
        : html`<div class="empty"><strong>No held sales</strong></div>`,
    });
    on(m.el, 'click', '[data-id]', async (e, b) => {
      try { const s = await post(`/api/sales/${b.dataset.id}/resume`); m.close(); st.held = Math.max(0, st.held - 1); apply(s); toast(`Resumed ${s.number}`, 'ok'); } catch (ex) { showError(ex); }
    });
    await m.promise; focusScan();
  }
  async function cancelSale() {
    if (!st.sale || !st.sale.items.length) return toast('No active sale', 'warn');
    const v = await formDlg({ title: 'Cancel sale', sub: `${st.sale.number} · ${st.sale.items.length} lines · ${money(st.sale.total)}. Nothing has been paid; the sale is kept on record as cancelled.`, size: 'narrow', cls: 'stack', danger: true, submitText: 'Cancel sale',
      fields: [{ name: 'reason', label: 'Reason', type: 'select', required: true, options: ['Customer left', 'Customer changed mind', 'Insufficient funds', 'Rung up in error', 'Other'].map((x) => ({ value: x, label: x })) }] });
    if (!v) return focusScan();
    try { await withOverride(() => post(`/api/sales/${st.sale.id}/cancel`, { reason: v.reason })); st.sale = null; renderAll(); toast('Sale cancelled'); } catch (e) { if (e.code !== 'cancelled') showError(e); }
    focusScan();
  }

  async function customer() {
    const sale = await ensureSale().catch(showError); if (!sale) return;
    let results = [];
    const m = modal({
      title: 'Customer', sub: 'Optional — link the sale to a customer for history and loyalty points.', size: 'wide',
      body: html`<div class="stack"><div class="row"><input class="input lg grow" data-q placeholder="Search by name, phone or code" autofocus>${sale.customer_id ? html`<button class="btn" data-clear>Remove customer</button>` : ''}</div>
        <div data-results></div>
        <details data-new><summary class="strong" style="cursor:pointer">+ New customer</summary><form class="form-grid" style="margin-top:10px" data-newform>
          <div class="field"><label>Full name *</label><input class="input" name="full_name" required></div><div class="field"><label>Phone</label><input class="input" name="phone" placeholder="+234…"></div>
          <div class="field"><label>Email</label><input class="input" name="email" type="email"></div><div class="field" style="justify-content:flex-end"><label class="check"><input type="checkbox" name="marketing_consent"> Agrees to marketing messages</label></div>
          <div class="full row"><button class="btn primary" type="submit">Create & add to sale</button><span class="muted small" data-nerr></span></div></form></details></div>`,
    });
    const search = debounce(async (q) => {
      try { results = (await get(`/api/customers${qs({ q, limit: 12 })}`)).rows; } catch (e) { return showError(e); }
      mount($('[data-results]', m.el), results.length ? html`<div class="list-pick">${results.map((c) => html`<button data-cid="${c.id}"><div><div class="strong">${c.full_name}</div><div class="xs muted">${c.code} · ${c.phone || 'no phone'} · ${c.visits} visits · ${c.loyalty_points} pts</div></div><span class="muted small">${c.last_visit ? `Last ${tm(c.last_visit)}` : ''}</span></button>`)}</div>` : html`<div class="muted small">No matches. Create a new customer below.</div>`);
    }, 200);
    on(m.el, 'input', '[data-q]', (e, i) => search(i.value));
    search('');
    const attach = async (id) => { try { apply(await post(`/api/sales/${sale.id}/customer`, { customer_id: id })); m.close(); } catch (e) { showError(e); } };
    on(m.el, 'click', '[data-cid]', (e, b) => attach(b.dataset.cid));
    on(m.el, 'click', '[data-clear]', () => attach(null));
    $('[data-newform]', m.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const c = await post('/api/customers', { full_name: f.full_name.value, phone: f.phone.value || null, email: f.email.value || null, marketing_consent: f.marketing_consent.checked });
        await attach(c.id); toast(`Customer ${c.code} created`, 'ok');
      } catch (ex) { $('[data-nerr]', m.el).textContent = errMsg(ex); }
    });
    await m.promise; focusScan();
  }

  async function openSearch(initial = '') {
    const m = modal({
      title: 'Find product', sub: 'Search by name, brand, SKU, PLU or barcode. Shows live price and stock (price check).', size: 'xwide',
      body: html`<div class="stack"><input class="input lg" data-q value="${initial}" placeholder="Type to search…" autofocus><div data-res style="max-height:55vh;overflow:auto"></div></div>`,
    });
    let rows = []; let idx = 0;
    const draw = () => mount($('[data-res]', m.el), rows.length ? html`<div class="list-pick">${rows.map((p, i) => html`<button data-i="${i}" class="${i === idx ? 'on' : ''}">
      <div><div class="strong">${p.name} ${!p.is_active ? badge('inactive') : ''} ${p.age_restricted ? html`<span class="badge warn plain">18+</span>` : ''}</div><div class="xs muted">${p.sku}${p.barcode ? ` · ${p.barcode}` : ''}${p.plu ? ` · PLU ${p.plu}` : ''} · ${p.category_name || ''}</div></div>
      <div class="right"><div class="strong num">${money(p.price)}${p.unit !== 'each' ? `/${p.unit}` : ''}</div><div class="xs ${p.stock <= 0 ? '' : 'muted'}" style="${p.stock <= 0 ? 'color:var(--bad)' : ''}">${p.track_stock ? `${qty(p.stock, p.unit)} in stock` : 'not stocked'}</div></div></button>`)}</div>` : html`<div class="empty"><strong>No products found</strong></div>`);
    const run = debounce(async (q) => {
      try { rows = (await get(`/api/products${qs({ q, limit: 40, location_id: me.register.location_id })}`)).rows; idx = 0; draw(); } catch (e) { showError(e); }
    }, 150);
    const input = $('[data-q]', m.el);
    input.addEventListener('input', () => run(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(rows.length - 1, idx + 1); draw(); $('.list-pick button.on', m.el)?.scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); $('.list-pick button.on', m.el)?.scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'Enter') { e.preventDefault(); if (rows[idx]) { const p = rows[idx]; m.close(); serial(() => addProduct(p)); } }
    });
    on(m.el, 'click', '[data-i]', (e, b) => { const p = rows[Number(b.dataset.i)]; m.close(); serial(() => addProduct(p)); });
    run(initial);
    await m.promise; focusScan();
  }

  // ─────────────── payments ───────────────
  async function pay(code) {
    await queue; // let pending scans land first
    const method = st.methods.find((m) => m.code === code);
    if (!method) return;
    if (!st.sale || !st.sale.items.length) return toast('Scan items first', 'warn');
    if (!method.available) return toast(method.unavailable_reason || 'Method unavailable', 'warn');
    const inflight = st.sale.payments.find((p) => ['pending', 'processing'].includes(p.status));
    if (inflight) { const m = st.methods.find((x) => x.code === inflight.method_code); return electronicDialog(m || method, st.sale.balance_due, inflight.id); }
    if (st.sale.balance_due <= 0) return completeAnyway();
    if (method.type === 'cash') return cashDialog(method);
    if (method.provider_code === 'manual') return manualDialog(method);
    return electronicDialog(method, st.sale.balance_due);
  }

  async function completeAnyway() {
    try { const s = await post(`/api/sales/${st.sale.id}/complete`); if (s.status === 'completed') return finished(s); } catch (e) { showError(e); }
  }

  function afterPayment(res) {
    if (res.sale.status === 'completed') { finished(res.sale); return true; }
    apply(res.sale);
    return false;
  }

  function cashDialog(method) {
    const sale = st.sale; const due = sale.balance_due;
    const key = newKey('cash');
    const notes = me.settings['pos.quick_cash_notes'] || [];
    const unit = Math.pow(10, me.business.currency_minor);
    const rounds = [...new Set([500, 1000, 5000].map((r) => Math.ceil(due / (r * unit)) * r * unit).filter((x) => x > due))].slice(0, 2);
    const quick = [...new Set([due, ...rounds, ...notes.filter((n) => n > due)])].sort((a, b) => a - b).slice(0, 6);
    const m = modal({
      title: `${method.name}`, sub: `Sale ${sale.number}`, size: 'wide',
      body: html`<div class="grid g2" style="gap:18px"><div class="stack">
          <div class="tender-summary"><div class="line"><span>Total</span><span>${money(sale.total)}</span></div>${sale.paid ? html`<div class="line"><span>Already paid</span><span>${money(sale.paid)}</span></div>` : ''}<div class="line big"><span>Due</span><span>${money(due)}</span></div></div>
          <div class="field"><label>Cash received</label><input class="input xl" data-amt inputmode="decimal" value="${toMajor(due)}" autocomplete="off"></div>
          <div class="quick-cash">${quick.map((q, i) => html`<button type="button" data-q="${q}">${i === 0 && q === due ? 'Exact' : money(q)}</button>`)}</div>
          <div class="tender-summary" data-change></div>
          <div class="callout bad hidden" data-err></div></div>
        <div class="keypad" data-pad>${['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '⌫'].map((k) => html`<button type="button" data-k="${k}">${k}</button>`)}<button type="button" data-k="C" style="grid-column:1/-1;font-size:14px">Clear</button></div></div>`,
      foot: html`<button class="btn lg" data-dismiss>Back <span class="kbd">Esc</span></button><button class="btn primary lg" data-ok>Take cash <span class="kbd">Enter</span></button>`,
    });
    const input = $('[data-amt]', m.el); const err = $('[data-err]', m.el); const ok = $('[data-ok]', m.el);
    const upd = () => {
      const v = toMinor(input.value);
      const box = $('[data-change]', m.el);
      if (!Number.isFinite(v) || v <= 0) return mount(box, html`<div class="line"><span>Enter amount received</span></div>`);
      mount(box, v >= due ? html`<div class="line big" style="color:var(--ok)"><span>Change</span><span>${money(v - due)}</span></div>`
        : html`<div class="line big" style="color:var(--warn)"><span>Still due after this</span><span>${money(due - v)}</span></div><div class="xs muted">Partial cash — take the rest with another method.</div>`);
    };
    input.addEventListener('input', upd); upd();
    setTimeout(() => { input.focus(); input.select(); }, 30);
    guardInput(input, () => toast('Scanner input ignored while taking payment', 'warn'));
    on(m.el, 'click', '[data-q]', (e, b) => { input.value = toMajor(Number(b.dataset.q)); upd(); input.focus(); });
    on(m.el, 'click', '[data-k]', (e, b) => {
      const k = b.dataset.k; let s = input.value;
      if (input.dataset.fresh !== '0') { s = ''; input.dataset.fresh = '0'; }
      if (k === 'C') s = ''; else if (k === '⌫') s = s.slice(0, -1); else s += k;
      input.value = s; upd();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    let sending = false;
    const submit = async () => {
      if (sending) return;
      const v = toMinor(input.value);
      if (!Number.isFinite(v) || v <= 0) { err.textContent = 'Enter the amount received'; err.classList.remove('hidden'); return; }
      if (v > due * 20 && v > 1000000 * unit / 100) { if (!(await confirmDlg('Check amount', `${money(v)} is unusually large for a due of ${money(due)}. Is this correct?`, { confirmText: 'Yes, correct' }))) return; }
      sending = true; ok.disabled = true; err.classList.add('hidden');
      try {
        const res = await post(`/api/sales/${sale.id}/payments`, { method_code: method.code, tendered: v, idempotency_key: key });
        m.close(); afterPayment(res);
      } catch (e) { err.textContent = errMsg(e); err.classList.remove('hidden'); }
      finally { sending = false; ok.disabled = false; }
    };
    ok.addEventListener('click', submit);
    m.onEnter = submit;
    return m.promise.then(() => focusScan());
  }

  function manualDialog(method) {
    const sale = st.sale; const due = sale.balance_due;
    const key = newKey('man');
    return formDlg({
      title: method.name, sub: `Sale ${sale.number} · due ${money(due)}`, size: 'narrow', cls: 'stack', submitText: 'Record payment',
      extra: html`<div class="callout warn" style="margin-bottom:12px">This terminal is not connected to this system. Only record the payment after the device shows <strong>APPROVED</strong> and prints a slip. The approval code is matched against the bank's settlement later.</div>`,
      fields: [{ name: 'amount', label: 'Amount charged on the device', money: true, required: true, value: due }, { name: 'reference', label: 'Approval code / reference (from slip)', required: true, autofocus: true, autocomplete: 'off' },
        { name: 'confirm', label: 'I have seen the APPROVED slip', type: 'checkbox' }],
      submit: async (v) => {
        if (!v.confirm) throw new Error('Confirm that the device approved the payment');
        const res = await post(`/api/sales/${sale.id}/payments`, { method_code: method.code, amount: v.amount, reference: v.reference, idempotency_key: key });
        setTimeout(() => afterPayment(res), 0);
        return res;
      },
    }).then(() => focusScan());
  }

  /** Electronic payment: request → provider processes → we wait for provider confirmation (poll + webhook). */
  function electronicDialog(method, due, existingId) {
    const sale = st.sale;
    let key = newKey('epay');
    let payment = existingId ? sale.payments.find((p) => p.id === existingId) : null;
    let timer = null; let closedByDone = false;
    const m = modal({ title: method.name, sub: `Sale ${sale.number}`, size: 'wide', dismissable: true, body: html`<div data-v></div>`, foot: html`<div class="row grow" data-f></div>` });
    const view = $('[data-v]', m.el); const foot = $('[data-f]', m.el);

    const drawRequest = (errText) => {
      mount(view, html`<div class="stack">
        <div class="tender-summary"><div class="line"><span>Total</span><span>${money(sale.total)}</span></div>${sale.paid ? html`<div class="line"><span>Already paid</span><span>${money(sale.paid)}</span></div>` : ''}<div class="line big"><span>Due</span><span>${money(st.sale ? st.sale.balance_due : due)}</span></div></div>
        <div class="field"><label>Amount to charge</label><input class="input xl" data-amt value="${toMajor(st.sale ? st.sale.balance_due : due)}" inputmode="decimal"><span class="hint">Lower the amount to split the bill across methods.</span></div>
        ${method.test_mode ? html`<div class="callout test">TEST MODE: ${method.provider_name}. Amounts ending in .51 are declined; .52 wait for the simulator.</div>` : ''}
        ${errText ? html`<div class="callout bad">${errText}</div>` : ''}</div>`);
      mount(foot, html`<div class="grow"></div><button class="btn lg" data-dismiss>Back</button><button class="btn primary lg" data-send>${method.type === 'card' ? 'Send to terminal' : 'Request payment'}</button>`);
      const input = $('[data-amt]', view); setTimeout(() => { input.focus(); input.select(); }, 20);
      guardInput(input, () => toast('Scanner input ignored while taking payment', 'warn'));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
      $('[data-send]', foot).addEventListener('click', send);
    };

    let sending = false;
    const send = async () => {
      if (sending) return;
      const amt = toMinor($('[data-amt]', view).value);
      if (!Number.isFinite(amt) || amt <= 0) return;
      sending = true; $('[data-send]', foot).disabled = true;
      try {
        const res = await post(`/api/sales/${sale.id}/payments`, { method_code: method.code, amount: amt, idempotency_key: key });
        payment = res.payment; apply(res.sale);
        if (res.sale.status === 'completed') { closedByDone = true; m.close(); finished(res.sale); return; }
        drawStatus();
        clearTimeout(timer); timer = setTimeout(poll, 1200); // keep asking the provider until it confirms
      } catch (e) { drawRequest(errMsg(e)); if (e.code === 'offline') { await loadState(); renderAll(); } }
      finally { sending = false; }
    };

    const drawStatus = () => {
      const p = payment;
      const ins = p.instructions || (p.instructions_json ? JSON.parse(p.instructions_json) : null);
      const inflight = ['pending', 'processing'].includes(p.status);
      mount(view, html`<div class="stack">
        <div class="pay-status">${inflight ? html`<div class="spinner"></div>` : p.status === 'succeeded' ? html`<div class="check-ico" style="width:28px;height:28px;border-radius:50%;background:var(--ok-50);color:var(--ok);display:grid;place-items:center">${icon('check', 16)}</div>` : html`<div style="color:var(--bad)">${icon('alert', 24)}</div>`}
          <div class="grow"><div class="row"><strong style="font-size:16px">${money(p.amount)}</strong> ${badge(p.status)}</div>
            <div class="muted small">${inflight ? 'Waiting for the provider to confirm. The sale completes automatically when it does.' : p.status === 'succeeded' ? 'Confirmed by the provider.' : (p.failure_reason || 'Payment did not go through.')}</div>
            ${p.provider_ref ? html`<div class="xs muted mono">Provider ref ${p.provider_ref}</div>` : ''}</div></div>
        ${ins && inflight ? html`<div class="callout info"><div><strong>${ins.title || ''}</strong><div>${ins.message || ''}</div>${ins.account_number ? html`<div style="margin-top:6px;font-size:18px"><span class="mono" style="font-size:20px;font-weight:700">${ins.account_number}</span> · ${ins.bank_name}<div class="small">${ins.account_name} · expires in ${ins.expires_in_minutes} min</div></div>` : ''}${ins.terminal_id ? html`<div class="small">Terminal ${ins.terminal_id}</div>` : ''}</div></div>` : ''}
        ${inflight && p.failure_reason ? html`<div class="callout warn">${p.failure_reason}. Do not take a second payment for this amount until this one resolves.</div>` : ''}
        ${method.test_mode && inflight && p.provider_ref ? html`<div class="callout test" style="flex-direction:column"><strong>Test-mode simulator — plays the customer / bank side</strong><div class="row wrap">
          <button class="btn sm" data-sim="approve">Customer approves</button><button class="btn sm" data-sim="decline">Declined</button><button class="btn sm" data-sim="expire">Times out</button></div></div>` : ''}
      </div>`);
      mount(foot, inflight ? html`<button class="btn danger" data-cancelpay>Cancel payment</button><div class="grow"></div><button class="btn" data-check>Check status</button><button class="btn" data-bg title="Keep waiting in the background">Hide</button>`
        : p.status === 'succeeded' ? html`<div class="grow"></div><button class="btn primary lg" data-dismiss>Continue</button>`
          : html`<div class="grow"></div><button class="btn" data-dismiss>Choose another method</button><button class="btn primary" data-retry>Try again</button>`);
    };

    const poll = async () => {
      if (!payment || m.closed) return;
      if (!['pending', 'processing'].includes(payment.status)) return;
      try {
        const res = await post(`/api/payments/${payment.id}/refresh`);
        payment = { ...payment, ...res.payment, instructions: payment.instructions };
        apply(res.sale);
        if (res.sale.status === 'completed') { closedByDone = true; m.close(); finished(res.sale); return; }
        if (!m.closed) drawStatus();
      } catch (_) { /* transient; keep polling */ }
      if (!m.closed) timer = setTimeout(poll, 1500);
    };

    on(m.el, 'click', '[data-sim]', async (e, b) => {
      b.disabled = true;
      try { await post(`/api/sim/${method.provider_code}/${payment.provider_ref}/${b.dataset.sim}`); } catch (ex) { showError(ex); }
      clearTimeout(timer); poll();
    });
    on(m.el, 'click', '[data-check]', () => { clearTimeout(timer); poll(); });
    on(m.el, 'click', '[data-bg]', () => m.close());
    on(m.el, 'click', '[data-retry]', () => { key = newKey('epay'); payment = null; drawRequest(); });
    on(m.el, 'click', '[data-cancelpay]', async () => {
      if (!(await confirmDlg('Cancel payment?', 'The provider will be asked to cancel. If the customer already approved it, the payment is kept as paid.', { confirmText: 'Cancel payment', danger: true }))) return;
      try { const res = await post(`/api/payments/${payment.id}/cancel`, { reason: 'Cancelled by cashier' }); payment = { ...payment, ...res.payment }; apply(res.sale); if (res.sale.status === 'completed') { m.close(); finished(res.sale); return; } drawStatus(); } catch (ex) { showError(ex); }
    });

    if (payment) { drawStatus(); poll(); } else drawRequest();
    return m.promise.then(() => { clearTimeout(timer); if (!closedByDone) { refreshSale(); focusScan(); } });
  }

  async function removePayment(paymentId) {
    const p = st.sale.payments.find((x) => x.id === paymentId);
    if (!p) return;
    if (!(await confirmDlg('Remove payment?', `${p.method_name || p.method_code} ${money(p.amount)} will be reversed${p.method_type === 'cash' ? ' — hand the cash back to the customer' : ' with the provider'}. Needs supervisor approval.`, { confirmText: 'Remove payment', danger: true }))) return;
    try { const res = await withOverride((override) => post(`/api/payments/${paymentId}/cancel`, { reason: 'Removed at till', override })); apply(res.sale); toast('Payment removed', 'ok'); } catch (e) { if (e.code !== 'cancelled') showError(e); }
  }

  async function refreshSale() {
    if (!st.sale) return;
    try { const s = await get(`/api/sales/${st.sale.id}`); if (s.status === 'completed') finished(s); else apply(s); } catch (_) { /* ignore */ }
  }

  // ─────────────── completion & receipt ───────────────
  async function finished(sale) {
    st.sale = null; st.lastSaleId = sale.id; renderAll();
    const changeDue = sale.change_given || 0;
    const m = modal({
      title: 'Sale complete', sub: `${sale.number} · ${tm(sale.completed_at)}`, size: 'wide',
      body: html`<div class="grid g2" style="gap:20px;align-items:start"><div class="stack">
          <div class="done-hero"><div class="check-ico">${icon('check', 28)}</div>
            ${changeDue ? html`<div class="muted">Change due</div><div class="change-big">${money(changeDue)}</div>` : html`<div class="muted">Paid in full</div><div class="change-big" style="color:var(--text)">${money(sale.total)}</div>`}</div>
          <div class="tender-summary">${sale.payments.filter((p) => p.status === 'succeeded').map((p) => html`<div class="line"><span>${p.method_name || p.method_code}</span><span>${money(p.tendered || p.amount)}</span></div>`)}
            <div class="line strong"><span>Total</span><span>${money(sale.total)}</span></div></div>
          ${sale.completed_offline ? html`<div class="callout info">Completed offline — it will sync automatically.</div>` : ''}
          <div class="grid g2"><button class="btn lg" data-print>${icon('print', 16)} Print <span class="kbd">P</span></button><button class="btn lg" data-send>Email / SMS</button><button class="btn lg" data-pdf>Save PDF</button><button class="btn lg" data-drawer title="Customer display">${icon('display', 16)} Display</button></div>
        </div><iframe class="receipt-frame" sandbox="allow-same-origin allow-modals" title="Receipt preview" data-frame></iframe></div>`,
      foot: html`<button class="btn primary lg" data-dismiss autofocus>New sale <span class="kbd">Enter</span></button>`,
    });
    const frame = $('[data-frame]', m.el);
    try { frame.srcdoc = await fetchText(`/api/sales/${sale.id}/receipt?format=html`); } catch (e) { showError(e); }
    const doPrint = () => printReceipt(sale.id, frame);
    on(m.el, 'click', '[data-print]', doPrint);
    on(m.el, 'click', '[data-pdf]', () => import('../api.js').then((a) => a.download(`/api/sales/${sale.id}/receipt?format=pdf&download=1`, `${sale.number}.pdf`)).catch(showError));
    on(m.el, 'click', '[data-send]', () => sendReceipt(sale));
    on(m.el, 'click', '[data-drawer]', openDisplay);
    m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'INPUT') { e.preventDefault(); m.close(); } if (e.key.toLowerCase() === 'p' && e.target.tagName !== 'INPUT') { e.preventDefault(); doPrint(); } });
    m.onEnter = () => m.close();
    if (me.settings['receipt.auto_print']) setTimeout(doPrint, 400);
    await m.promise;
    loadState().then(() => renderAll()).catch(() => {});
    focusScan();
  }

  async function printReceipt(saleId, frame) {
    try {
      const r = await post(`/api/sales/${saleId}/receipt/printed`);
      const htmlDoc = await fetchText(`/api/sales/${saleId}/receipt?format=html${r.copy ? '&copy=1' : ''}`);
      if (me.settings['hardware.receipt_printer'] !== 'system') { const out = await post(`/api/sales/${saleId}/receipt/hardware`); toast(out.file ? 'Receipt sent to print spool' : 'Receipt sent to printer', 'ok'); return; }
      if (window.meridian && window.meridian.printHtml) { await window.meridian.printHtml(htmlDoc); return; }
      if (frame) { frame.srcdoc = htmlDoc; setTimeout(() => frame.contentWindow.print(), 250); }
    } catch (e) { showError(e); }
  }

  async function sendReceipt(sale) {
    await formDlg({
      title: 'Send receipt', size: 'narrow', cls: 'stack', submitText: 'Send',
      fields: [{ name: 'channel', label: 'Channel', type: 'select', required: true, options: [{ value: 'email', label: 'Email' }, { value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }] }, { name: 'destination', label: 'Email address or phone number', required: true, value: sale.customer_phone || '' }],
      submit: async (v) => { const r = await post('/api/receipts/deliver', { sale_id: sale.id, ...v }); if (r.status === 'not_configured') toast(r.detail, 'warn'); else if (r.status === 'sent') toast('Receipt sent', 'ok'); else toast(r.detail || 'Delivery failed', 'bad'); },
    });
  }

  async function lastReceipt() {
    if (!st.lastSaleId) {
      try { const r = await get(`/api/sales${qs({ register_id: me.register.id, limit: 1, status: 'completed' })}`); if (r.rows[0]) st.lastSaleId = r.rows[0].id; } catch (_) { /* ignore */ }
    }
    if (!st.lastSaleId) return toast('No completed sale yet on this lane', 'warn');
    const { saleDetailModal } = await import('./sales.js');
    await saleDetailModal(st.lastSaleId, { fromPos: true });
    loadState().then(renderAll); focusScan();
  }

  function openDisplay() {
    if (window.meridian && window.meridian.openCustomerDisplay) return window.meridian.openCustomerDisplay(getToken());
    window.open('/display.html', 'customer-display', 'width=1024,height=700');
  }
  window.meridianOpenDisplay = openDisplay;

  function help() {
    modal({
      title: 'Keyboard shortcuts', size: 'narrow',
      body: html`<table class="t">${[['Scan / Enter', 'Add item'], ['3*code', 'Add 3 of an item'], ['F2', 'Search products / price check'], ['F3', 'Set quantity of selected line'], ['F4', 'Hold sale'], ['F5', 'Recall held sale'], ['F6', 'Discount'], ['F7', 'Customer'], ['F8', 'Cash'], ['F9', 'Card'], ['F10', 'Bank transfer'], ['↑ / ↓', 'Select line'], ['+ / −', 'Change quantity of selected line'], ['Delete', 'Remove selected line'], ['Ctrl + L', 'Lock terminal']].map(([k, v]) => html`<tr><td><span class="kbd">${k}</span></td><td>${v}</td></tr>`)}</table>`,
    }).promise.then(focusScan);
  }

  async function action(a) {
    switch (a) {
      case 'search': return openSearch();
      case 'qty': return setQty();
      case 'hold': return hold();
      case 'recall': return recall();
      case 'discount': return discount();
      case 'customer': return customer();
      case 'remove': return removeLine();
      case 'price': return priceOverride();
      case 'cancel': return cancelSale();
      case 'returns': { const { refundFlow } = await import('./sales.js'); await refundFlow(); return loadState().then(renderAll).then(focusScan); }
      case 'last': return lastReceipt();
      case 'cash': { const { cashMovementFlow } = await import('./sessions.js'); await cashMovementFlow(); return focusScan(); }
      case 'close': {
        if (st.sale && st.sale.items.length) return toast('Finish, hold or cancel the current sale first', 'warn');
        const { closeSessionFlow } = await import('./sessions.js');
        const closed = await closeSessionFlow(st.session.id);
        if (closed) { await loadState(); renderBody(); }
        return;
      }
      case 'display': return openDisplay();
      case 'lock': return nav.lock();
      case 'logout': return nav.logout();
      case 'help': return help();
      default: return null;
    }
  }

  // ─────────────── keyboard ───────────────
  const onKey = (e) => {
    if (modalOpen() || document.querySelector('.lock') || !st.session) return;
    const fmap = { F2: 'search', F3: 'qty', F4: 'hold', F5: 'recall', F6: 'discount', F7: 'customer' };
    if (fmap[e.key]) { e.preventDefault(); action(fmap[e.key]); return; }
    const payKeys = { F8: 'cash', F9: 'card', F10: 'transfer' };
    const byShortcut = st.methods.find((m) => m.shortcut === e.key);
    if (payKeys[e.key] || byShortcut) { e.preventDefault(); pay(byShortcut ? byShortcut.code : payKeys[e.key]); return; }
    if (e.key === 'F1') { e.preventDefault(); help(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); nav.lock(); return; }
    const input = $('[data-scan]', el);
    const inScan = document.activeElement === input;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!st.sale || !st.sale.items.length) return;
      e.preventDefault();
      const i = st.sale.items.findIndex((x) => x.id === st.selected);
      const n = Math.max(0, Math.min(st.sale.items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      st.selected = st.sale.items[n].id; renderCart(); return;
    }
    if (e.key === 'Delete' && (!inScan || !input.value)) { e.preventDefault(); removeLine(); return; }
    if ((e.key === '+' || e.key === '-') && (!inScan || !input.value) && st.selected) { e.preventDefault(); bumpQty(st.selected, e.key === '+' ? 1 : -1); return; }
    if (e.key === 'Escape' && inScan) { input.value = ''; return; }
    // any printable key goes to the scan box, so a scanner works even if focus drifted to a button
    if (!inScan && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      if (input) { input.focus(); }
    }
    if (!inScan && e.key === 'Enter' && input && input.value && document.activeElement.tagName !== 'BUTTON') { e.preventDefault(); const v = input.value; input.value = ''; serial(() => scan(v)); }
  };
  document.addEventListener('keydown', onKey);
  const onNet = async (ev) => { const wasOnline = st.network.online; st.network = ev.detail; if (wasOnline !== ev.detail.online) { try { st.methods = await get('/api/pos/methods'); } catch (_) { /* ignore */ } } renderTopbar(); renderPay(); };
  document.addEventListener('pos:network', onNet);
  const onUnlock = () => { loadState().then(renderAll).then(focusScan).catch(() => {}); };
  document.addEventListener('pos:unlocked', onUnlock);
  const netTimer = setInterval(() => get('/api/network').then((n) => onNet({ detail: n })).catch(() => onNet({ detail: { online: false } })), 8000);
  const clock = setInterval(() => { const c = $('[data-clock]', el); if (c) c.textContent = tm(new Date().toISOString()); }, 1000);
  const refocus = setInterval(() => { if (!modalOpen() && document.activeElement === document.body) focusScan(); }, 1500);

  layout();
  try { await loadState(); } catch (e) { showError(e); }
  renderBody();
  // Resume an in-flight electronic payment after restart / reload
  const inflight = st.sale && st.sale.payments.find((p) => ['pending', 'processing'].includes(p.status));
  if (inflight) { const mth = st.methods.find((x) => x.code === inflight.method_code); if (mth) { toast('A payment was still in progress — resuming', 'warn'); electronicDialog(mth, st.sale.balance_due, inflight.id); } }
  else if (st.sale && st.sale.items.length) toast(`Restored open sale ${st.sale.number}`, '');

  return () => {
    document.removeEventListener('keydown', onKey); document.removeEventListener('pos:network', onNet); document.removeEventListener('pos:unlocked', onUnlock);
    clearInterval(netTimer); clearInterval(clock); clearInterval(refocus);
  };
}
void esc;
