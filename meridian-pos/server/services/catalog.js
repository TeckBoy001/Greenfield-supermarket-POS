'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');
const { roundQty } = require('../lib/money');

function eanCheckOk(code) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

const UNITS = ['each', 'kg', 'g', 'l', 'ml', 'pack', 'box', 'm'];

module.exports = function catalogService(app) {
  const { db } = app;

  const PRODUCT_SELECT = `SELECT p.*, c.name AS category_name, t.name AS tax_name, t.rate_bp AS tax_rate_bp, s.name AS supplier_name,
      (SELECT barcode FROM product_barcodes b WHERE b.product_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS barcode
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN tax_rates t ON t.id = p.tax_rate_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id`;

  function withStock(p, locationId) {
    if (!p) return p;
    if (locationId) {
      const s = db.get('SELECT qty FROM stock_levels WHERE product_id = ? AND location_id = ?', p.id, locationId);
      p.stock = s ? s.qty : 0;
    }
    return p;
  }

  function getProduct(ctx, id, locationId) {
    const p = db.get(`${PRODUCT_SELECT} WHERE p.id = ? AND p.business_id = ?`, id, ctx.businessId);
    if (!p) throw E.notFound('Product');
    p.barcodes = db.all('SELECT id, barcode, pack_qty, is_primary FROM product_barcodes WHERE product_id = ? ORDER BY is_primary DESC, created_at', id);
    p.stock_by_location = db.all(`SELECT l.id AS location_id, l.name AS location_name, COALESCE(s.qty, 0) AS qty
      FROM locations l LEFT JOIN stock_levels s ON s.location_id = l.id AND s.product_id = ? WHERE l.business_id = ? AND l.is_active = 1 ORDER BY l.name`, id, ctx.businessId);
    return withStock(p, locationId);
  }

  /**
   * Resolve scanner/keyboard input to a product and quantity.
   * Order: exact barcode → in-store variable-weight EAN-13 → SKU → PLU.
   */
  function lookupScan(ctx, rawCode, locationId) {
    const code = String(rawCode || '').trim();
    if (!code || code.length > 64) return null;
    const bc = db.get(`SELECT b.product_id, b.pack_qty FROM product_barcodes b JOIN products p ON p.id = b.product_id
                       WHERE b.business_id = ? AND b.barcode = ?`, ctx.businessId, code);
    if (bc) return { product: withStock(db.get(`${PRODUCT_SELECT} WHERE p.id = ?`, bc.product_id), locationId), qty: bc.pack_qty, source: 'barcode', code };

    const s = app.settings.all(ctx.businessId);
    if (s['barcode.variable_weight_enabled'] && /^\d{13}$/.test(code) && s['barcode.variable_weight_prefixes'].includes(code.slice(0, 2))) {
      if (!eanCheckOk(code)) return { error: 'Barcode check digit is invalid — rescan the label', code };
      const plu = code.slice(2, 7);
      const p = db.get(`${PRODUCT_SELECT} WHERE p.business_id = ? AND p.plu = ? AND p.is_weighed = 1`, ctx.businessId, plu);
      if (p) {
        const value = Number(code.slice(7, 12));
        const qty = s['barcode.variable_weight_mode'] === 'weight_grams' ? roundQty(value / 1000) : null;
        if (!qty) return { error: 'Scale label has zero weight', code };
        return { product: withStock(p, locationId), qty, source: 'variable_weight', code };
      }
    }
    const bySku = db.get(`${PRODUCT_SELECT} WHERE p.business_id = ? AND p.sku = ? COLLATE NOCASE`, ctx.businessId, code);
    if (bySku) return { product: withStock(bySku, locationId), qty: 1, source: 'sku', code };
    const byPlu = db.get(`${PRODUCT_SELECT} WHERE p.business_id = ? AND p.plu = ?`, ctx.businessId, code);
    if (byPlu) return { product: withStock(byPlu, locationId), qty: byPlu.is_weighed ? null : 1, source: 'plu', code };
    return null;
  }

  function search(ctx, { q, categoryId, active = 'active', lowStock, locationId, limit = 50, offset = 0 }) {
    const where = ['p.business_id = ?'];
    const p = [ctx.businessId];
    if (q) {
      where.push(`(p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ? OR p.plu = ? OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode LIKE ?))`);
      p.push(`%${q}%`, `${q}%`, `%${q}%`, q, `${q}%`);
    }
    if (categoryId) { where.push('p.category_id = ?'); p.push(categoryId); }
    if (active === 'active') where.push('p.is_active = 1');
    if (active === 'inactive') where.push('p.is_active = 0');
    let stockJoin = '';
    if (locationId) {
      stockJoin = 'LEFT JOIN stock_levels sl ON sl.product_id = p.id AND sl.location_id = ?';
      p.unshift(locationId);
      if (lowStock) where.push('p.track_stock = 1 AND COALESCE(sl.qty,0) <= p.min_stock');
    }
    const sql = `${PRODUCT_SELECT.replace('FROM products p', `${locationId ? ', COALESCE(sl.qty,0) AS stock' : ''} FROM products p ${stockJoin}`)}
      WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT ? OFFSET ?`;
    const rows = db.all(sql, ...p, Math.min(limit, 500), offset);
    const countSql = `SELECT COUNT(*) FROM products p ${stockJoin} WHERE ${where.join(' AND ')}`;
    return { rows, total: db.value(countSql, ...p) };
  }

  function readProductBody(body, { partial }) {
    const req = !partial;
    const out = {};
    const set = (k, val) => { if (val !== null || (body && body[k] === null)) out[k] = val; };
    if (!partial || 'name' in body) set('name', v.str(body, 'name', { required: req, max: 160 }));
    if (!partial || 'sku' in body) set('sku', v.str(body, 'sku', { required: req, max: 40, pattern: /^[A-Za-z0-9._\-/]+$/ }));
    if ('description' in body) set('description', v.str(body, 'description', { max: 1000 }));
    if ('category_id' in body) set('category_id', v.str(body, 'category_id', { max: 64 }));
    if ('brand' in body) set('brand', v.str(body, 'brand', { max: 80 }));
    if (!partial || 'unit' in body) set('unit', v.oneOf(body, 'unit', UNITS, { def: 'each' }));
    if ('is_weighed' in body) set('is_weighed', v.bool(body, 'is_weighed') ? 1 : 0);
    if ('plu' in body) set('plu', v.str(body, 'plu', { max: 5, pattern: /^\d{4,5}$/ }));
    if (!partial || 'price' in body) set('price', v.money(body, 'price', { required: req }));
    if ('cost' in body) set('cost', v.money(body, 'cost'));
    if ('tax_rate_id' in body) set('tax_rate_id', v.str(body, 'tax_rate_id', { max: 64 }));
    if ('track_stock' in body) set('track_stock', v.bool(body, 'track_stock') ? 1 : 0);
    if ('min_stock' in body) set('min_stock', v.num(body, 'min_stock', { min: 0 }) || 0);
    if ('reorder_qty' in body) set('reorder_qty', v.num(body, 'reorder_qty', { min: 0 }) || 0);
    if ('supplier_id' in body) set('supplier_id', v.str(body, 'supplier_id', { max: 64 }));
    if ('allow_discount' in body) set('allow_discount', v.bool(body, 'allow_discount') ? 1 : 0);
    if ('age_restricted' in body) set('age_restricted', v.bool(body, 'age_restricted') ? 1 : 0);
    if ('is_active' in body) set('is_active', v.bool(body, 'is_active') ? 1 : 0);
    if (out.plu === undefined && out.is_weighed === 1) throw E.validation('Weighed products need a 4–5 digit PLU');
    return out;
  }

  function checkRefs(ctx, data) {
    if (data.category_id && !db.get('SELECT 1 FROM categories WHERE id = ? AND business_id = ?', data.category_id, ctx.businessId)) throw E.validation('Unknown category');
    if (data.tax_rate_id && !db.get('SELECT 1 FROM tax_rates WHERE id = ? AND business_id = ?', data.tax_rate_id, ctx.businessId)) throw E.validation('Unknown tax rate');
    if (data.supplier_id && !db.get('SELECT 1 FROM suppliers WHERE id = ? AND business_id = ?', data.supplier_id, ctx.businessId)) throw E.validation('Unknown supplier');
  }

  function addBarcode(ctx, productId, barcode, packQty = 1, isPrimary = false) {
    const code = String(barcode || '').trim();
    if (!/^[A-Za-z0-9\-]{3,40}$/.test(code)) throw E.validation('Barcode must be 3–40 letters/digits');
    const exists = db.get(`SELECT p.name FROM product_barcodes b JOIN products p ON p.id = b.product_id WHERE b.business_id = ? AND b.barcode = ?`, ctx.businessId, code);
    if (exists) throw E.conflict(`Barcode ${code} is already assigned to “${exists.name}”`);
    if (isPrimary) db.run('UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?', productId);
    const id = newId('bar');
    db.run('INSERT INTO product_barcodes (id,business_id,product_id,barcode,pack_qty,is_primary,created_at) VALUES (?,?,?,?,?,?,?)',
      id, ctx.businessId, productId, code, packQty, isPrimary ? 1 : 0, nowIso());
    return id;
  }

  function createProduct(ctx, body) {
    app.auth.require(ctx, 'product.edit');
    const data = readProductBody(body, { partial: false });
    if ((data.price !== undefined || data.cost !== undefined) && !app.auth.can(ctx, 'product.price')) throw E.forbidden('Setting prices requires the product.price permission');
    checkRefs(ctx, data);
    const barcode = v.str(body, 'barcode', { max: 40 });
    const openingQty = v.num(body, 'opening_stock', { min: 0 });
    const locationId = v.str(body, 'location_id', { max: 64 });
    return db.tx(() => {
      if (db.get('SELECT 1 FROM products WHERE business_id = ? AND sku = ? COLLATE NOCASE', ctx.businessId, data.sku)) throw E.conflict(`SKU ${data.sku} already exists`);
      const id = newId('prd');
      const now = nowIso();
      const cols = { id, business_id: ctx.businessId, created_at: now, updated_at: now, cost: 0, ...data };
      const keys = Object.keys(cols);
      db.run(`INSERT INTO products (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => cols[k]));
      if (barcode) addBarcode(ctx, id, barcode, 1, true);
      if (openingQty && locationId) {
        app.inventory.move(ctx, { productId: id, locationId, type: 'opening', qty: openingQty, unitCost: cols.cost, reason: 'Opening stock', referenceType: 'product', referenceId: id });
      }
      app.audit.log(ctx, 'product.create', { entityType: 'product', entityId: id, reference: data.sku, newValue: { ...data, barcode } });
      return getProduct(ctx, id);
    });
  }

  function updateProduct(ctx, id, body) {
    app.auth.require(ctx, 'product.edit');
    const data = readProductBody(body, { partial: true });
    const before = db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!before) throw E.notFound('Product');
    const priceChanging = (data.price !== undefined && data.price !== before.price) || (data.cost !== undefined && data.cost !== before.cost);
    if (priceChanging && !app.auth.can(ctx, 'product.price')) throw E.forbidden('Changing price or cost requires the product.price permission', { permission: 'product.price' });
    if (data.is_weighed === 1 && !(data.plu || before.plu)) throw E.validation('Weighed products need a PLU');
    checkRefs(ctx, data);
    return db.tx(() => {
      if (data.sku && data.sku.toLowerCase() !== before.sku.toLowerCase() && db.get('SELECT 1 FROM products WHERE business_id = ? AND sku = ? COLLATE NOCASE', ctx.businessId, data.sku)) throw E.conflict(`SKU ${data.sku} already exists`);
      const changed = Object.keys(data).filter((k) => data[k] !== before[k]);
      if (!changed.length) return getProduct(ctx, id);
      db.run(`UPDATE products SET ${changed.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...changed.map((k) => data[k]), nowIso(), id);
      const oldV = Object.fromEntries(changed.map((k) => [k, before[k]]));
      const newV = Object.fromEntries(changed.map((k) => [k, data[k]]));
      if (changed.includes('price') || changed.includes('cost')) {
        app.audit.log(ctx, 'product.price_change', { entityType: 'product', entityId: id, reference: before.sku, oldValue: { price: before.price, cost: before.cost }, newValue: { price: data.price ?? before.price, cost: data.cost ?? before.cost } });
      }
      if (changed.includes('is_active')) app.audit.log(ctx, data.is_active ? 'product.enable' : 'product.disable', { entityType: 'product', entityId: id, reference: before.sku });
      const other = changed.filter((k) => !['price', 'cost', 'is_active'].includes(k));
      if (other.length) app.audit.log(ctx, 'product.update', { entityType: 'product', entityId: id, reference: before.sku, oldValue: Object.fromEntries(other.map((k) => [k, oldV[k]])), newValue: Object.fromEntries(other.map((k) => [k, newV[k]])) });
      return getProduct(ctx, id);
    });
  }

  function addBarcodeRoute(ctx, productId, body) {
    app.auth.require(ctx, 'product.edit');
    const p = db.get('SELECT sku FROM products WHERE id = ? AND business_id = ?', productId, ctx.businessId);
    if (!p) throw E.notFound('Product');
    const packQty = v.num(body, 'pack_qty', { min: 0.001, max: 10000 }) || 1;
    return db.tx(() => {
      const id = addBarcode(ctx, productId, body.barcode, packQty, v.bool(body, 'is_primary', false));
      app.audit.log(ctx, 'product.barcode_add', { entityType: 'product', entityId: productId, reference: p.sku, newValue: { barcode: body.barcode, pack_qty: packQty } });
      return getProduct(ctx, productId);
    });
  }
  function removeBarcode(ctx, productId, barcodeId) {
    app.auth.require(ctx, 'product.edit');
    const b = db.get(`SELECT b.* FROM product_barcodes b WHERE b.id = ? AND b.product_id = ? AND b.business_id = ?`, barcodeId, productId, ctx.businessId);
    if (!b) throw E.notFound('Barcode');
    db.tx(() => {
      db.run('DELETE FROM product_barcodes WHERE id = ?', barcodeId);
      app.audit.log(ctx, 'product.barcode_remove', { entityType: 'product', entityId: productId, oldValue: { barcode: b.barcode } });
    });
    return getProduct(ctx, productId);
  }

  // ── reference data ──
  const listCategories = (ctx) => db.all(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count FROM categories c WHERE business_id = ? ORDER BY name`, ctx.businessId);
  const listTaxRates = (ctx) => db.all('SELECT * FROM tax_rates WHERE business_id = ? ORDER BY rate_bp DESC, name', ctx.businessId);
  const listSuppliers = (ctx) => db.all('SELECT * FROM suppliers WHERE business_id = ? ORDER BY name', ctx.businessId);

  function saveCategory(ctx, id, body) {
    app.auth.require(ctx, 'product.edit');
    const name = v.str(body, 'name', { required: true, max: 80 });
    const active = v.bool(body, 'is_active', true);
    return db.tx(() => {
      if (id) {
        const before = db.get('SELECT * FROM categories WHERE id = ? AND business_id = ?', id, ctx.businessId);
        if (!before) throw E.notFound('Category');
        db.run('UPDATE categories SET name = ?, is_active = ? WHERE id = ?', name, active ? 1 : 0, id);
        app.audit.log(ctx, 'category.update', { entityType: 'category', entityId: id, oldValue: { name: before.name, is_active: before.is_active }, newValue: { name, is_active: active } });
        return id;
      }
      if (db.get('SELECT 1 FROM categories WHERE business_id = ? AND name = ?', ctx.businessId, name)) throw E.conflict('Category already exists');
      const nid = newId('cat');
      db.run('INSERT INTO categories (id,business_id,name,is_active,created_at) VALUES (?,?,?,?,?)', nid, ctx.businessId, name, 1, nowIso());
      app.audit.log(ctx, 'category.create', { entityType: 'category', entityId: nid, newValue: { name } });
      return nid;
    });
  }

  function saveSupplier(ctx, id, body) {
    app.auth.require(ctx, 'product.edit');
    const d = {
      name: v.str(body, 'name', { required: true, max: 120 }), contact_name: v.str(body, 'contact_name', { max: 120 }),
      phone: v.phone(body, 'phone'), email: v.email(body, 'email'), address: v.str(body, 'address', { max: 300 }),
      is_active: v.bool(body, 'is_active', true) ? 1 : 0,
    };
    return db.tx(() => {
      if (id) {
        if (!db.get('SELECT 1 FROM suppliers WHERE id = ? AND business_id = ?', id, ctx.businessId)) throw E.notFound('Supplier');
        db.run('UPDATE suppliers SET name=?, contact_name=?, phone=?, email=?, address=?, is_active=? WHERE id = ?', d.name, d.contact_name, d.phone, d.email, d.address, d.is_active, id);
        app.audit.log(ctx, 'supplier.update', { entityType: 'supplier', entityId: id, newValue: d });
        return id;
      }
      const nid = newId('sup');
      db.run('INSERT INTO suppliers (id,business_id,name,contact_name,phone,email,address,is_active,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        nid, ctx.businessId, d.name, d.contact_name, d.phone, d.email, d.address, d.is_active, nowIso());
      app.audit.log(ctx, 'supplier.create', { entityType: 'supplier', entityId: nid, newValue: d });
      return nid;
    });
  }

  function saveTaxRate(ctx, id, body) {
    app.auth.require(ctx, 'settings.manage');
    const d = { code: v.str(body, 'code', { required: true, max: 20, pattern: /^[A-Z0-9_]+$/ }), name: v.str(body, 'name', { required: true, max: 60 }),
      rate_bp: v.int(body, 'rate_bp', { required: true, min: 0, max: 10000 }), is_active: v.bool(body, 'is_active', true) ? 1 : 0 };
    return db.tx(() => {
      if (id) {
        const before = db.get('SELECT * FROM tax_rates WHERE id = ? AND business_id = ?', id, ctx.businessId);
        if (!before) throw E.notFound('Tax rate');
        db.run('UPDATE tax_rates SET code=?, name=?, rate_bp=?, is_active=? WHERE id=?', d.code, d.name, d.rate_bp, d.is_active, id);
        app.audit.log(ctx, 'tax_rate.update', { entityType: 'tax_rate', entityId: id, oldValue: before, newValue: d });
        return id;
      }
      const nid = newId('tax');
      db.run('INSERT INTO tax_rates (id,business_id,code,name,rate_bp,is_active,created_at) VALUES (?,?,?,?,?,?,?)', nid, ctx.businessId, d.code, d.name, d.rate_bp, d.is_active, nowIso());
      app.audit.log(ctx, 'tax_rate.create', { entityType: 'tax_rate', entityId: nid, newValue: d });
      return nid;
    });
  }

  return {
    getProduct, lookupScan, search, createProduct, updateProduct, addBarcode, addBarcodeRoute, removeBarcode,
    listCategories, listTaxRates, listSuppliers, saveCategory, saveSupplier, saveTaxRate, eanCheckOk, UNITS,
  };
};
module.exports.eanCheckOk = eanCheckOk;
