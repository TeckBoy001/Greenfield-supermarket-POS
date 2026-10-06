'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');
const { roundQty, mulQty } = require('../lib/money');
const { computeSale } = require('./pricing');

/**
 * Sales / cart service. The cart lives in the database from the first scan, so a crash, power
 * cut or app restart never loses a basket, and no financial figure is ever computed by the UI.
 *
 * Status machine:  open ⇄ held;  open → completed (fully paid) | cancelled (no money taken);
 *                  completed → voided (same session, via refunds service).
 */
module.exports = function salesService(app) {
  const { db } = app;

  function business(ctx) { return db.get('SELECT * FROM businesses WHERE id = ?', ctx.businessId); }

  function loadSale(ctx, id) {
    const s = db.get('SELECT * FROM sales WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!s) throw E.notFound('Sale');
    return s;
  }

  function paidSummary(saleId) {
    return db.get(`SELECT
        COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount END),0) AS paid,
        COALESCE(SUM(CASE WHEN status = 'succeeded' THEN change_given END),0) AS change_given,
        COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN 1 END),0) AS inflight,
        COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount END),0) AS inflight_amount
      FROM payments WHERE sale_id = ?`, saleId);
  }

  /** Cart can be edited only while open and before any money has been taken or is in flight. */
  function assertEditable(ctx, sale) {
    if (sale.status !== 'open') throw E.conflict(sale.status === 'held' ? 'This sale is on hold. Resume it first.' : `Sale is ${sale.status}`);
    if (sale.cashier_id !== ctx.user.id && !app.auth.can(ctx, 'session.manage_all')) throw E.forbidden('This sale belongs to another cashier');
    const ps = paidSummary(sale.id);
    if (ps.paid > 0 || ps.inflight > 0) {
      throw E.conflict('Payment has started on this sale. Remove the payments first to change the cart.', { code: 'payments_exist' });
    }
  }

  /** Recompute every line and the sale totals from source values. Must run inside a tx. */
  function recalc(saleId) {
    const sale = db.get('SELECT * FROM sales WHERE id = ?', saleId);
    const items = db.all(`SELECT si.*, p.allow_discount FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? ORDER BY line_no`, saleId);
    const { lines, totals } = computeSale(items, { type: sale.cart_discount_type, value: sale.cart_discount_value }, !!sale.prices_include_tax);
    items.forEach((it, i) => {
      const l = lines[i];
      if (it.gross !== l.gross || it.line_discount !== l.line_discount || it.cart_discount_alloc !== l.cart_discount_alloc || it.tax_amount !== l.tax_amount || it.line_total !== l.line_total) {
        db.run('UPDATE sale_items SET gross=?, line_discount=?, cart_discount_alloc=?, tax_amount=?, line_total=? WHERE id=?',
          l.gross, l.line_discount, l.cart_discount_alloc, l.tax_amount, l.line_total, it.id);
      }
    });
    db.run('UPDATE sales SET subtotal=?, discount_total=?, tax_total=?, total=?, updated_at=? WHERE id=?',
      totals.subtotal, totals.discount_total, totals.tax_total, totals.total, nowIso(), saleId);
    return totals;
  }

  function create(ctx) {
    app.auth.require(ctx, 'pos.sell');
    const session = app.sessions.requireSellingSession(ctx);
    return db.tx(() => {
      // Reuse an existing empty open cart on this register instead of piling up blanks.
      const existing = db.get(`SELECT s.id FROM sales s WHERE s.register_id = ? AND s.session_id = ? AND s.status = 'open' AND s.cashier_id = ?
        ORDER BY s.created_at DESC LIMIT 1`, ctx.registerId, session.id, ctx.user.id);
      if (existing) return existing.id;
      const reg = db.get('SELECT r.*, l.code AS location_code FROM registers r JOIN locations l ON l.id = r.location_id WHERE r.id = ?', ctx.registerId);
      db.run('UPDATE registers SET next_sale_seq = next_sale_seq + 1 WHERE id = ?', reg.id);
      const number = `${reg.location_code}-${reg.code}-${String(reg.next_sale_seq).padStart(6, '0')}`;
      const b = business(ctx);
      const id = newId('sal');
      const now = nowIso();
      db.run(`INSERT INTO sales (id,business_id,number,location_id,register_id,session_id,cashier_id,status,currency,prices_include_tax,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, ctx.businessId, number, reg.location_id, reg.id, session.id, ctx.user.id, 'open', b.currency, b.prices_include_tax, now, now);
      return id;
    });
  }

  /** The cashier's current working sale on this register (open), or null. */
  function currentOpen(ctx) {
    if (!ctx.registerId) return null;
    const s = db.get(`SELECT id FROM sales WHERE register_id = ? AND status = 'open' AND cashier_id = ? ORDER BY updated_at DESC LIMIT 1`, ctx.registerId, ctx.user.id);
    return s ? get(ctx, s.id) : null;
  }

  function addItem(ctx, saleId, body) {
    app.auth.require(ctx, 'pos.sell');
    const session = app.sessions.requireSellingSession(ctx);
    let product; let qty; let scannedCode = null; let source = 'manual';
    const mult = v.num(body, 'qty', { min: 0.001, max: 100000 });
    if (body && body.code) {
      const hit = app.catalog.lookupScan(ctx, v.str(body, 'code', { required: true, max: 64 }), session.location_id);
      if (!hit) throw E.notFound(`No product matches “${String(body.code).slice(0, 64)}”`);
      if (hit.error) throw E.validation(hit.error);
      product = hit.product; scannedCode = hit.code; source = hit.source;
      qty = hit.qty == null ? null : roundQty(hit.qty * (mult || 1));
      if (qty == null) {
        const w = v.num(body, 'weight', { min: 0.001, max: 1000 });
        if (!w) throw E.validation(`${product.name} is sold by weight — enter the weight`, { code: 'weight_required', product_id: product.id });
        qty = roundQty(w);
      }
    } else {
      const pid = v.str(body, 'product_id', { required: true, max: 64 });
      product = db.get(`SELECT p.*, t.rate_bp AS tax_rate_bp FROM products p LEFT JOIN tax_rates t ON t.id = p.tax_rate_id WHERE p.id = ? AND p.business_id = ?`, pid, ctx.businessId);
      if (!product) throw E.notFound('Product');
      if (product.is_weighed) {
        const w = v.num(body, 'weight', { min: 0.001, max: 1000 }) || mult;
        if (!w) throw E.validation(`${product.name} is sold by weight — enter the weight`, { code: 'weight_required', product_id: product.id });
        qty = roundQty(w);
      } else qty = mult || 1;
    }
    if (!product.is_active) throw E.conflict(`${product.name} is not available for sale (inactive)`);
    if (product.age_restricted && !v.bool(body, 'age_verified', false)) {
      throw E.conflict(`${product.name} is age-restricted. Confirm the customer's ID before continuing.`, { code: 'age_check_required', product_id: product.id });
    }

    const settings = app.settings.all(ctx.businessId);
    return db.tx(() => {
      const sale = loadSale(ctx, saleId);
      assertEditable(ctx, sale);
      if (sale.session_id !== session.id) throw E.conflict('This sale belongs to a different session');
      const warnings = [];
      if (product.track_stock) {
        const stock = db.value('SELECT qty FROM stock_levels WHERE product_id = ? AND location_id = ?', product.id, sale.location_id) || 0;
        const inCart = db.value('SELECT COALESCE(SUM(qty),0) FROM sale_items WHERE sale_id = ? AND product_id = ?', saleId, product.id) || 0;
        if (stock - inCart - qty < 0) {
          if (!settings['pos.allow_negative_stock']) throw E.conflict(`Only ${Math.max(0, stock - inCart)} ${product.unit} of ${product.name} in stock`);
          warnings.push(`System shows ${Math.max(0, stock - inCart)} in stock for ${product.name} — check shelf count`);
        }
      }
      const taxBp = product.tax_rate_bp || 0;
      // Merge rescans of the same product into one line (not weighed labels, not discounted/overridden lines).
      const mergeable = !product.is_weighed && db.get(`SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ? AND unit_price = ? AND price_override_by IS NULL
        AND line_discount_type IS NULL ORDER BY line_no DESC LIMIT 1`, saleId, product.id, product.price);
      let itemId;
      if (mergeable) {
        itemId = mergeable.id;
        db.run('UPDATE sale_items SET qty = ? WHERE id = ?', roundQty(mergeable.qty + qty), itemId);
      } else {
        itemId = newId('sli');
        const lineNo = (db.value('SELECT MAX(line_no) FROM sale_items WHERE sale_id = ?', saleId) || 0) + 1;
        db.run(`INSERT INTO sale_items (id,sale_id,line_no,product_id,sku,name,unit,barcode,qty,unit_price,list_price,unit_cost,tax_rate_bp,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, itemId, saleId, lineNo, product.id, product.sku, product.name, product.unit, scannedCode, qty,
        product.price, product.price, product.cost || 0, taxBp, nowIso());
      }
      if (product.age_restricted) app.audit.log(ctx, 'sale.age_verified', { entityType: 'sale', entityId: saleId, reference: sale.number, meta: { product: product.sku } });
      recalc(saleId);
      const out = get(ctx, saleId);
      out.last_item_id = itemId;
      out.scan = { source, product_name: product.name, qty, warnings };
      return out;
    });
  }

  function updateItem(ctx, saleId, itemId, body) {
    app.auth.require(ctx, 'pos.sell');
    return db.tx(() => {
      const sale = loadSale(ctx, saleId);
      assertEditable(ctx, sale);
      const item = db.get('SELECT si.*, p.allow_discount, p.is_weighed FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.id = ? AND si.sale_id = ?', itemId, saleId);
      if (!item) throw E.notFound('Line');
      const changes = {};
      if (body.qty !== undefined) {
        const q = v.num(body, 'qty', { required: true, min: 0.001, max: 100000 });
        if (!item.is_weighed && !Number.isInteger(q) && item.unit === 'each') throw E.validation('Quantity must be a whole number for this item');
        if (q < item.qty) app.audit.log(ctx, 'sale.qty_reduce', { entityType: 'sale', entityId: saleId, reference: sale.number, oldValue: { qty: item.qty }, newValue: { qty: q }, meta: { sku: item.sku } });
        changes.qty = roundQty(q);
      }
      if (body.unit_price !== undefined) {
        const price = v.money(body, 'unit_price', { required: true });
        if (price !== item.unit_price) {
          const approver = app.auth.authorize(ctx, 'pos.price_override', body.override, 'Price override');
          const reason = v.str(body, 'reason', { required: true, max: 200 });
          changes.unit_price = price; changes.price_override_by = approver;
          app.audit.log(ctx, 'sale.price_override', { entityType: 'sale', entityId: saleId, reference: sale.number, oldValue: { unit_price: item.unit_price }, newValue: { unit_price: price }, approvedBy: approver, meta: { sku: item.sku, reason } });
        }
      }
      if (body.discount !== undefined) {
        if (body.discount === null) {
          changes.line_discount_type = null; changes.line_discount_value = null; changes.line_discount_reason = null; changes.line_discount_by = null;
        } else {
          if (!item.allow_discount) throw E.conflict(`${item.name} is excluded from discounts`);
          const d = body.discount;
          const type = v.oneOf(d, 'type', ['percent', 'amount'], { required: true });
          const value = v.num(d, 'value', { required: true, min: 0.01, max: type === 'percent' ? 100 : 1e12 });
          const reason = v.str(d, 'reason', { required: true, max: 200 });
          const gross = mulQty(changes.unit_price ?? item.unit_price, changes.qty ?? item.qty);
          const pctEq = type === 'percent' ? value : (gross ? (value / gross) * 100 : 100);
          const approver = discountApprover(ctx, pctEq, body.override);
          Object.assign(changes, { line_discount_type: type, line_discount_value: value, line_discount_reason: reason, line_discount_by: approver });
          app.audit.log(ctx, 'sale.discount_line', { entityType: 'sale', entityId: saleId, reference: sale.number, newValue: { type, value, reason, sku: item.sku }, approvedBy: approver !== ctx.user.id ? approver : null });
        }
      }
      const keys = Object.keys(changes);
      if (keys.length) db.run(`UPDATE sale_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => changes[k]), itemId);
      recalc(saleId);
      return get(ctx, saleId);
    });
  }

  /**
   * Discounts: a user may give up to their role's limit. Above it, a supervisor approves — and the
   * approver's own limit applies too (or they hold pos.discount.unlimited).
   */
  function discountApprover(ctx, pctEquivalent, override) {
    app.auth.require(ctx, 'pos.discount');
    const limit = app.auth.discountLimit(ctx.user.id);
    if (pctEquivalent <= limit + 1e-9 || app.auth.can(ctx, 'pos.discount.unlimited')) return ctx.user.id;
    const what = `Discount of ${pctEquivalent.toFixed(1)}% (your limit is ${limit}%)`;
    const approver = app.auth.verifyOverride(ctx, 'pos.discount', override, what);
    const approverLimit = app.auth.rolePerms(approver.role_id).has('pos.discount.unlimited') ? 100 : app.auth.discountLimit(approver.id);
    if (pctEquivalent > approverLimit + 1e-9) throw E.forbidden(`${approver.full_name} can approve discounts up to ${approverLimit}% — ask a manager`);
    return approver.id;
  }

  function removeItem(ctx, saleId, itemId) {
    app.auth.require(ctx, 'pos.sell');
    return db.tx(() => {
      const sale = loadSale(ctx, saleId);
      assertEditable(ctx, sale);
      const item = db.get('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?', itemId, saleId);
      if (!item) throw E.notFound('Line');
      db.run('DELETE FROM sale_items WHERE id = ?', itemId);
      // Line voids are a classic shrinkage signal — always audited.
      app.audit.log(ctx, 'sale.line_remove', { entityType: 'sale', entityId: saleId, reference: sale.number, oldValue: { sku: item.sku, name: item.name, qty: item.qty, unit_price: item.unit_price } });
      recalc(saleId);
      return get(ctx, saleId);
    });
  }

  function setCartDiscount(ctx, saleId, body) {
    return db.tx(() => {
      const sale = loadSale(ctx, saleId);
      assertEditable(ctx, sale);
      if (!body || body.type === null || body.type === undefined) {
        db.run('UPDATE sales SET cart_discount_type=NULL, cart_discount_value=NULL, cart_discount_reason=NULL, cart_discount_by=NULL WHERE id=?', saleId);
        app.audit.log(ctx, 'sale.discount_cart_remove', { entityType: 'sale', entityId: saleId, reference: sale.number });
      } else {
        const type = v.oneOf(body, 'type', ['percent', 'amount'], { required: true });
        const value = v.num(body, 'value', { required: true, min: 0.01, max: type === 'percent' ? 100 : 1e12 });
        const reason = v.str(body, 'reason', { required: true, max: 200 });
        const pre = recalc(saleId);
        const base = pre.subtotal - (pre.discount_total - pre.cart_discount);
        const pctEq = type === 'percent' ? value : (base ? (value / base) * 100 : 100);
        const approver = discountApprover(ctx, pctEq, body.override);
        db.run('UPDATE sales SET cart_discount_type=?, cart_discount_value=?, cart_discount_reason=?, cart_discount_by=? WHERE id=?', type, value, reason, approver, saleId);
        app.audit.log(ctx, 'sale.discount_cart', { entityType: 'sale', entityId: saleId, reference: sale.number, newValue: { type, value, reason }, approvedBy: approver !== ctx.user.id ? approver : null });
      }
      recalc(saleId);
      return get(ctx, saleId);
    });
  }

  function setCustomer(ctx, saleId, body) {
    return db.tx(() => {
      const sale = loadSale(ctx, saleId);
      if (sale.status !== 'open') throw E.conflict(`Sale is ${sale.status}`);
      const customerId = body ? v.str(body, 'customer_id', { max: 64 }) : null;
      if (customerId && !db.get('SELECT 1 FROM customers WHERE id = ? AND business_id = ? AND is_active = 1', customerId, ctx.businessId)) throw E.validation('Unknown customer');
      db.run('UPDATE sales SET customer_id = ?, updated_at = ? WHERE id = ?', customerId, nowIso(), saleId);
      return get(ctx, saleId);
    });
  }

  function hold(ctx, saleId, body) {
    return db.tx(() => {
      const sale = loadSale(ctx, saleId);
      assertEditable(ctx, sale);
      const count = db.value('SELECT COUNT(*) FROM sale_items WHERE sale_id = ?', saleId);
      if (!count) throw E.conflict('Nothing to hold — the cart is empty');
      const label = v.str(body, 'label', { max: 60 }) || `Held ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
      db.run(`UPDATE sales SET status = 'held', hold_label = ?, updated_at = ? WHERE id = ?`, label, nowIso(), saleId);
      app.audit.log(ctx, 'sale.hold', { entityType: 'sale', entityId: saleId, reference: sale.number, meta: { label, total: sale.total } });
      return get(ctx, saleId);
    });
  }

  function resume(ctx, saleId) {
    app.auth.require(ctx, 'pos.sell');
    const session = app.sessions.requireSellingSession(ctx);
    return db.tx(() => {
      const sale = loadSale(ctx, saleId);
      if (sale.status !== 'held') throw E.conflict('Only held sales can be resumed');
      if (sale.location_id !== session.location_id) throw E.conflict('This sale was held at another store');
      const active = db.get(`SELECT s.id, s.number, (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS items FROM sales s
        WHERE s.register_id = ? AND s.status = 'open' AND s.cashier_id = ?`, ctx.registerId, ctx.user.id);
      if (active && active.items > 0) throw E.conflict(`Finish or hold the current sale (${active.number}) first`);
      if (active) db.run(`UPDATE sales SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'Empty cart replaced by resumed sale', updated_at = ? WHERE id = ?`, nowIso(), nowIso(), active.id);
      // Resuming re-prices nothing: held baskets keep the prices shown to the customer.
      db.run(`UPDATE sales SET status = 'open', register_id = ?, session_id = ?, cashier_id = ?, updated_at = ? WHERE id = ?`, ctx.registerId, session.id, ctx.user.id, nowIso(), saleId);
      app.audit.log(ctx, 'sale.resume', { entityType: 'sale', entityId: saleId, reference: sale.number });
      return get(ctx, saleId);
    });
  }

  function cancel(ctx, saleId, body) {
    return db.tx(() => {
      const sale = loadSale(ctx, saleId);
      if (!['open', 'held'].includes(sale.status)) throw E.conflict(`A ${sale.status} sale cannot be cancelled${sale.status === 'completed' ? ' — use Void or Refund' : ''}`);
      const ps = paidSummary(saleId);
      if (ps.paid > 0 || ps.inflight > 0) throw E.conflict('Remove the payments on this sale before cancelling it');
      const items = db.value('SELECT COUNT(*) FROM sale_items WHERE sale_id = ?', saleId);
      if (items) app.auth.require(ctx, 'sale.cancel');
      const reason = v.str(body, 'reason', { max: 200 }) || (items ? null : 'Empty cart');
      if (!reason) throw E.validation('reason: is required');
      db.run(`UPDATE sales SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?`, nowIso(), reason, nowIso(), saleId);
      app.audit.log(ctx, 'sale.cancel', { entityType: 'sale', entityId: saleId, reference: sale.number, meta: { reason, items, total: sale.total } });
      return get(ctx, saleId);
    });
  }

  /**
   * Complete a fully-paid sale. Idempotent: calling it on a completed sale is a no-op.
   * Runs inside the caller's transaction (payments service) or its own.
   */
  function completeIfPaid(ctx, saleId) {
    return db.tx(() => {
      const sale = db.get('SELECT * FROM sales WHERE id = ?', saleId);
      if (sale.status === 'completed') return { completed: true, already: true };
      if (sale.status !== 'open') return { completed: false };
      const items = db.all('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY line_no', saleId);
      if (!items.length) return { completed: false };
      const ps = paidSummary(saleId);
      if (ps.inflight > 0 || ps.paid < sale.total) return { completed: false, due: sale.total - ps.paid };
      if (ps.paid > sale.total) throw E.conflict('Overpayment detected — payments exceed the sale total'); // cash overtender is recorded as change, never as payment
      const now = nowIso();
      const online = app.connectivity.isOnline(sale.business_id);
      const settings = app.settings.all(sale.business_id);
      let points = 0;
      if (sale.customer_id && settings['loyalty.enabled'] && settings['loyalty.points_per_currency_unit'] > 0) {
        const b = db.get('SELECT currency_minor FROM businesses WHERE id = ?', sale.business_id);
        points = Math.floor((sale.total / Math.pow(10, b.currency_minor)) * settings['loyalty.points_per_currency_unit']);
        if (points) db.run('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?', points, sale.customer_id);
      }
      const sysCtx = { ...ctx, businessId: sale.business_id };
      for (const it of items) {
        app.inventory.move(sysCtx, { productId: it.product_id, locationId: sale.location_id, type: 'sale', qty: -it.qty, unitCost: it.unit_cost, referenceType: 'sale', referenceId: saleId, reason: sale.number });
      }
      db.run(`UPDATE sales SET status = 'completed', amount_paid = ?, change_given = ?, completed_at = ?, completed_offline = ?, loyalty_points_earned = ?, updated_at = ? WHERE id = ?`,
        ps.paid, ps.change_given, now, online ? 0 : 1, points, now, saleId);
      app.audit.log(sysCtx, 'sale.complete', { entityType: 'sale', entityId: saleId, reference: sale.number, newValue: { total: sale.total, paid: ps.paid, change: ps.change_given, items: items.length, offline: !online } });
      app.sync.enqueue(sale.business_id, 'sale', saleId, () => exportSale(saleId));
      return { completed: true };
    });
  }

  /** Explicit completion (used for zero-total sales and as a safety net from the UI). */
  function complete(ctx, saleId) {
    const sale = loadSale(ctx, saleId);
    if (sale.status === 'completed') return get(ctx, saleId);
    if (sale.status !== 'open') throw E.conflict(`Sale is ${sale.status}`);
    const r = completeIfPaid(ctx, saleId);
    if (!r.completed) {
      const ps = paidSummary(saleId);
      if (ps.inflight) throw E.conflict('A payment is still processing');
      throw E.conflict(`Balance due: ${sale.total - ps.paid}`, { code: 'balance_due', due: sale.total - ps.paid });
    }
    const out = get(ctx, saleId);
    return out;
  }

  function exportSale(saleId) {
    const s = db.get('SELECT * FROM sales WHERE id = ?', saleId);
    return {
      sale: s,
      items: db.all('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY line_no', saleId),
      payments: db.all('SELECT id, method_code, provider_code, amount, change_given, status, provider_ref, confirmation_source, confirmed_at FROM payments WHERE sale_id = ?', saleId),
    };
  }

  function get(ctx, id) {
    const s = db.get(`SELECT s.*, u.full_name AS cashier_name, c.full_name AS customer_name, c.phone AS customer_phone, c.code AS customer_code, c.loyalty_points AS customer_points,
        r.name AS register_name, l.name AS location_name, vb.full_name AS voided_by_name
      FROM sales s JOIN users u ON u.id = s.cashier_id LEFT JOIN customers c ON c.id = s.customer_id JOIN registers r ON r.id = s.register_id
      JOIN locations l ON l.id = s.location_id LEFT JOIN users vb ON vb.id = s.voided_by WHERE s.id = ? AND s.business_id = ?`, id, ctx.businessId);
    if (!s) throw E.notFound('Sale');
    if (s.cashier_id !== ctx.user.id && !app.auth.can(ctx, 'sale.view_all') && !app.auth.can(ctx, 'refund.approve')) {
      // cashiers can look up any completed sale for returns, but only see their own open ones
      if (s.status === 'open' || s.status === 'held') throw E.forbidden();
    }
    s.items = db.all(`SELECT si.*, (SELECT COALESCE(SUM(ri.qty),0) FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE ri.sale_item_id = si.id) AS refunded_qty,
        (SELECT COALESCE(SUM(ri.amount),0) FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE ri.sale_item_id = si.id) AS refunded_amount
      FROM sale_items si WHERE si.sale_id = ? ORDER BY line_no`, id);
    s.payments = db.all(`SELECT p.id, p.method_code, p.method_type, p.provider_code, p.amount, p.tendered, p.change_given, p.status, p.provider_ref, p.provider_status,
        p.confirmation_source, p.reference, p.failure_reason, p.instructions_json, p.created_at, p.confirmed_at, pm.name AS method_name
      FROM payments p LEFT JOIN payment_methods pm ON pm.code = p.method_code AND pm.business_id = p.business_id WHERE p.sale_id = ? ORDER BY p.created_at`, id);
    s.payments.forEach((p) => { p.instructions = p.instructions_json ? JSON.parse(p.instructions_json) : null; delete p.instructions_json; });
    s.refunds = db.all(`SELECT r.id, r.number, r.kind, r.status, r.total, r.reason_code, r.created_at, u.full_name AS authorized_by_name FROM refunds r JOIN users u ON u.id = r.authorized_by WHERE r.sale_id = ? ORDER BY r.created_at`, id);
    const ps = paidSummary(id);
    s.paid = ps.paid;
    s.inflight = ps.inflight;
    s.balance_due = Math.max(0, s.total - ps.paid);
    s.change_due = ps.change_given;
    s.refunded_total = s.refunds.reduce((a, r) => a + r.total, 0);
    s.tax_breakdown = Object.values(taxBreakdownFromItems(s.items));
    return s;
  }

  /** Net (ex-tax) amount and tax per rate, from the stored line figures. */
  function taxBreakdownFromItems(items) {
    const out = {};
    for (const it of items) {
      const k = String(it.tax_rate_bp);
      const t = out[k] || (out[k] = { rate_bp: it.tax_rate_bp, taxable: 0, tax: 0 });
      t.tax += it.tax_amount;
      t.taxable += it.line_total - it.tax_amount;
    }
    return out;
  }

  function list(ctx, { status, q, from, to, cashierId, registerId, customerId, paymentMethod, limit = 100, offset = 0 }) {
    const where = ['s.business_id = ?']; const p = [ctx.businessId];
    if (!app.auth.can(ctx, 'sale.view_all')) { where.push('s.cashier_id = ?'); p.push(ctx.user.id); } else if (cashierId) { where.push('s.cashier_id = ?'); p.push(cashierId); }
    if (status === 'held') where.push("s.status = 'held'"); else if (status) { where.push('s.status = ?'); p.push(status); } else where.push("s.status IN ('completed','voided')");
    if (q) { where.push('(s.number LIKE ? OR c.full_name LIKE ? OR c.phone LIKE ? OR EXISTS (SELECT 1 FROM payments pp WHERE pp.sale_id = s.id AND (pp.provider_ref = ? OR pp.reference = ?)))'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, q, q); }
    if (from) { where.push('COALESCE(s.completed_at, s.created_at) >= ?'); p.push(from); }
    if (to) { where.push('COALESCE(s.completed_at, s.created_at) < ?'); p.push(to); }
    if (registerId) { where.push('s.register_id = ?'); p.push(registerId); }
    if (customerId) { where.push('s.customer_id = ?'); p.push(customerId); }
    if (paymentMethod) { where.push("EXISTS (SELECT 1 FROM payments pp WHERE pp.sale_id = s.id AND pp.method_code = ? AND pp.status = 'succeeded')"); p.push(paymentMethod); }
    const base = `FROM sales s JOIN users u ON u.id = s.cashier_id LEFT JOIN customers c ON c.id = s.customer_id JOIN registers r ON r.id = s.register_id WHERE ${where.join(' AND ')}`;
    const rows = db.all(`SELECT s.id, s.number, s.status, s.total, s.discount_total, s.tax_total, s.completed_at, s.created_at, s.hold_label, s.completed_offline,
        u.full_name AS cashier_name, c.full_name AS customer_name, r.name AS register_name,
        (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS item_count,
        (SELECT GROUP_CONCAT(DISTINCT method_code) FROM payments pp WHERE pp.sale_id = s.id AND pp.status = 'succeeded') AS methods,
        (SELECT COALESCE(SUM(total),0) FROM refunds rf WHERE rf.sale_id = s.id AND rf.status = 'completed' AND rf.kind = 'refund') AS refunded
      ${base} ORDER BY COALESCE(s.completed_at, s.updated_at) DESC LIMIT ? OFFSET ?`, ...p, Math.min(limit, 500), offset);
    return { rows, total: db.value(`SELECT COUNT(*) ${base}`, ...p) };
  }

  function held(ctx) {
    const loc = ctx.registerId ? db.value('SELECT location_id FROM registers WHERE id = ?', ctx.registerId) : null;
    return db.all(`SELECT s.id, s.number, s.hold_label, s.total, s.updated_at, u.full_name AS cashier_name, c.full_name AS customer_name,
        (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS item_count
      FROM sales s JOIN users u ON u.id = s.cashier_id LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.business_id = ? AND s.status = 'held' ${loc ? 'AND s.location_id = ?' : ''} ORDER BY s.updated_at DESC`, ctx.businessId, ...(loc ? [loc] : []));
  }

  return {
    create, currentOpen, addItem, updateItem, removeItem, setCartDiscount, setCustomer, hold, resume, cancel, complete, completeIfPaid,
    get, list, held, recalc, paidSummary, loadSale, exportSale,
  };
};
