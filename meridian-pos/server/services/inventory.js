'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');
const { roundQty } = require('../lib/money');

/**
 * Inventory is a ledger: every change is an inventory_movements row with a type, reference
 * and resulting balance. stock_levels is the running total, updated in the same transaction.
 */
module.exports = function inventoryService(app) {
  const { db } = app;

  /** Must run inside db.tx. qty is signed (negative for deductions). */
  function move(ctx, { productId, locationId, type, qty, unitCost = null, reason = null, referenceType = null, referenceId = null, allowNegative = true }) {
    const change = roundQty(qty);
    if (!change) return null;
    const p = db.get('SELECT id, track_stock, cost FROM products WHERE id = ?', productId);
    if (!p) throw E.notFound('Product');
    if (!p.track_stock && !['opening', 'receive', 'adjustment', 'stocktake'].includes(type)) return null;
    const now = nowIso();
    db.run(`INSERT INTO stock_levels (product_id, location_id, qty, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(product_id, location_id) DO NOTHING`, productId, locationId, now);
    const cur = db.value('SELECT qty FROM stock_levels WHERE product_id = ? AND location_id = ?', productId, locationId);
    const after = roundQty(cur + change);
    if (after < 0 && !allowNegative) throw E.conflict(`Insufficient stock (on hand ${cur}, requested ${-change})`);
    db.run('UPDATE stock_levels SET qty = ?, updated_at = ? WHERE product_id = ? AND location_id = ?', after, now, productId, locationId);
    const id = newId('mov');
    db.run(`INSERT INTO inventory_movements (id,business_id,product_id,location_id,type,qty_change,balance_after,unit_cost,reference_type,reference_id,reason,user_id,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, ctx.businessId, productId, locationId, type, change, after, unitCost ?? p.cost, referenceType, referenceId, reason, ctx.user ? ctx.user.id : null, now);
    return { id, balance: after };
  }

  function assertLocation(ctx, locationId) {
    const l = db.get('SELECT * FROM locations WHERE id = ? AND business_id = ?', locationId, ctx.businessId);
    if (!l) throw E.validation('Unknown location');
    return l;
  }
  function assertProduct(ctx, productId) {
    const p = db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', productId, ctx.businessId);
    if (!p) throw E.validation('Unknown product');
    return p;
  }

  const ADJUST_TYPES = ['adjustment', 'stocktake', 'damage', 'expired', 'theft'];

  function adjust(ctx, body) {
    app.auth.require(ctx, 'inventory.adjust');
    const productId = v.str(body, 'product_id', { required: true, max: 64 });
    const locationId = v.str(body, 'location_id', { required: true, max: 64 });
    const type = v.oneOf(body, 'type', ADJUST_TYPES, { required: true });
    const reason = v.str(body, 'reason', { required: true, max: 300 });
    const p = assertProduct(ctx, productId);
    assertLocation(ctx, locationId);
    return db.tx(() => {
      const cur = db.value('SELECT qty FROM stock_levels WHERE product_id = ? AND location_id = ?', productId, locationId) || 0;
      let delta;
      if (type === 'stocktake') {
        const counted = v.num(body, 'counted_qty', { required: true, min: 0 });
        delta = roundQty(counted - cur);
        if (!delta) return { product_id: productId, balance: cur, unchanged: true };
      } else if (type === 'adjustment') {
        delta = v.num(body, 'qty', { required: true, min: -1e7, max: 1e7 });
        if (!delta) throw E.validation('qty: must not be zero');
      } else {
        const q = v.num(body, 'qty', { required: true, min: 0.001, max: 1e7 });
        delta = -Math.abs(q);
      }
      const m = move(ctx, { productId, locationId, type, qty: delta, reason, referenceType: 'adjustment' });
      app.audit.log(ctx, 'inventory.adjust', { entityType: 'product', entityId: productId, reference: p.sku, oldValue: { qty: cur }, newValue: { qty: m.balance }, meta: { type, reason, location_id: locationId } });
      return { product_id: productId, balance: m.balance, delta };
    });
  }

  function receive(ctx, body) {
    app.auth.require(ctx, 'inventory.receive');
    const locationId = v.str(body, 'location_id', { required: true, max: 64 });
    assertLocation(ctx, locationId);
    const supplierId = v.str(body, 'supplier_id', { max: 64 });
    if (supplierId && !db.get('SELECT 1 FROM suppliers WHERE id = ? AND business_id = ?', supplierId, ctx.businessId)) throw E.validation('Unknown supplier');
    const supplierRef = v.str(body, 'supplier_ref', { max: 60 });
    const note = v.str(body, 'note', { max: 500 });
    const updateCost = v.bool(body, 'update_cost', false);
    if (updateCost) app.auth.require(ctx, 'product.price');
    const items = v.arr(body, 'items', { required: true, max: 500 }).map((it, i) => ({
      product_id: v.str(it, 'product_id', { required: true, max: 64, label: `items[${i}].product_id` }),
      qty: v.num(it, 'qty', { required: true, min: 0.001, max: 1e7, label: `items[${i}].qty` }),
      unit_cost: v.money(it, 'unit_cost', { required: true, label: `items[${i}].unit_cost` }),
    }));
    if (!items.length) throw E.validation('Add at least one item');
    items.forEach((it) => assertProduct(ctx, it.product_id));
    return db.tx(() => {
      const id = newId('grn');
      const number = app.numbering.next(ctx.businessId, 'grn', 'GRN-');
      const total = items.reduce((a, it) => a + Math.round(it.qty * it.unit_cost), 0);
      db.run(`INSERT INTO goods_receipts (id,business_id,number,location_id,supplier_id,supplier_ref,total_cost,note,received_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, ctx.businessId, number, locationId, supplierId, supplierRef, total, note, ctx.user.id, nowIso());
      for (const it of items) {
        db.run('INSERT INTO goods_receipt_items (id,receipt_id,product_id,qty,unit_cost) VALUES (?,?,?,?,?)', newId('gri'), id, it.product_id, it.qty, it.unit_cost);
        move(ctx, { productId: it.product_id, locationId, type: 'receive', qty: it.qty, unitCost: it.unit_cost, referenceType: 'goods_receipt', referenceId: id, reason: supplierRef ? `Supplier ref ${supplierRef}` : 'Goods received' });
        if (updateCost) {
          const before = db.get('SELECT cost, sku FROM products WHERE id = ?', it.product_id);
          if (before.cost !== it.unit_cost) {
            db.run('UPDATE products SET cost = ?, updated_at = ? WHERE id = ?', it.unit_cost, nowIso(), it.product_id);
            app.audit.log(ctx, 'product.price_change', { entityType: 'product', entityId: it.product_id, reference: before.sku, oldValue: { cost: before.cost }, newValue: { cost: it.unit_cost }, meta: { source: number } });
          }
        }
      }
      app.audit.log(ctx, 'inventory.receive', { entityType: 'goods_receipt', entityId: id, reference: number, newValue: { items: items.length, total_cost: total, supplier_id: supplierId } });
      return { id, number, total_cost: total };
    });
  }

  function transfer(ctx, body) {
    app.auth.require(ctx, 'inventory.transfer');
    const from = v.str(body, 'from_location_id', { required: true, max: 64 });
    const to = v.str(body, 'to_location_id', { required: true, max: 64 });
    if (from === to) throw E.validation('Source and destination must differ');
    assertLocation(ctx, from); assertLocation(ctx, to);
    const note = v.str(body, 'note', { max: 500 });
    const items = v.arr(body, 'items', { required: true }).map((it, i) => ({
      product_id: v.str(it, 'product_id', { required: true, max: 64, label: `items[${i}].product_id` }),
      qty: v.num(it, 'qty', { required: true, min: 0.001, max: 1e7, label: `items[${i}].qty` }),
    }));
    if (!items.length) throw E.validation('Add at least one item');
    items.forEach((it) => assertProduct(ctx, it.product_id));
    return db.tx(() => {
      const id = newId('trf');
      const number = app.numbering.next(ctx.businessId, 'transfer', 'TRF-');
      db.run(`INSERT INTO stock_transfers (id,business_id,number,from_location_id,to_location_id,status,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, ctx.businessId, number, from, to, 'completed', note, ctx.user.id, nowIso());
      for (const it of items) {
        db.run('INSERT INTO stock_transfer_items (id,transfer_id,product_id,qty) VALUES (?,?,?,?)', newId('tri'), id, it.product_id, it.qty);
        move(ctx, { productId: it.product_id, locationId: from, type: 'transfer_out', qty: -it.qty, referenceType: 'transfer', referenceId: id, reason: number, allowNegative: false });
        move(ctx, { productId: it.product_id, locationId: to, type: 'transfer_in', qty: it.qty, referenceType: 'transfer', referenceId: id, reason: number });
      }
      app.audit.log(ctx, 'inventory.transfer', { entityType: 'stock_transfer', entityId: id, reference: number, newValue: { from, to, items } });
      return { id, number };
    });
  }

  function movements(ctx, { productId, locationId, type, from, to, limit = 200, offset = 0 }) {
    const where = ['m.business_id = ?']; const p = [ctx.businessId];
    if (productId) { where.push('m.product_id = ?'); p.push(productId); }
    if (locationId) { where.push('m.location_id = ?'); p.push(locationId); }
    if (type) { where.push('m.type = ?'); p.push(type); }
    if (from) { where.push('m.created_at >= ?'); p.push(from); }
    if (to) { where.push('m.created_at < ?'); p.push(to); }
    return db.all(`SELECT m.*, pr.name AS product_name, pr.sku, pr.unit, l.name AS location_name, u.full_name AS user_name,
        CASE m.reference_type WHEN 'sale' THEN (SELECT number FROM sales WHERE id = m.reference_id)
          WHEN 'refund' THEN (SELECT number FROM refunds WHERE id = m.reference_id)
          WHEN 'goods_receipt' THEN (SELECT number FROM goods_receipts WHERE id = m.reference_id)
          WHEN 'transfer' THEN (SELECT number FROM stock_transfers WHERE id = m.reference_id) END AS reference_number
      FROM inventory_movements m JOIN products pr ON pr.id = m.product_id JOIN locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.user_id
      WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`, ...p, Math.min(limit, 1000), offset);
  }

  function lowStock(ctx, locationId, limit = 50) {
    return db.all(`SELECT p.id, p.sku, p.name, p.unit, p.min_stock, p.reorder_qty, COALESCE(s.qty,0) AS qty, sup.name AS supplier_name
      FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id AND s.location_id = ? LEFT JOIN suppliers sup ON sup.id = p.supplier_id
      WHERE p.business_id = ? AND p.is_active = 1 AND p.track_stock = 1 AND COALESCE(s.qty,0) <= p.min_stock
      ORDER BY (COALESCE(s.qty,0) - p.min_stock), p.name LIMIT ?`, locationId, ctx.businessId, limit);
  }

  function valuation(ctx, locationId) {
    return db.get(`SELECT COUNT(*) AS products, COALESCE(SUM(s.qty),0) AS units, COALESCE(SUM(ROUND(s.qty * p.cost)),0) AS cost_value, COALESCE(SUM(ROUND(s.qty * p.price)),0) AS retail_value
      FROM stock_levels s JOIN products p ON p.id = s.product_id WHERE p.business_id = ? AND s.location_id = ? AND s.qty > 0`, ctx.businessId, locationId);
  }

  return { move, adjust, receive, transfer, movements, lowStock, valuation, ADJUST_TYPES };
};
