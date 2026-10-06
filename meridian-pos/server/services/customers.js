'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');

module.exports = function customerService(app) {
  const { db } = app;

  function list(ctx, { q, limit = 50, offset = 0 }) {
    app.auth.require(ctx, 'customer.view');
    const where = ['c.business_id = ?']; const p = [ctx.businessId];
    if (q) { where.push('(c.full_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.code = ?)'); p.push(`%${q}%`, `%${q.replace(/\s/g, '')}%`, `%${q}%`, q); }
    const rows = db.all(`SELECT c.*, (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed') AS visits,
        (SELECT COALESCE(SUM(total),0) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed') AS lifetime_spend,
        (SELECT MAX(completed_at) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed') AS last_visit
      FROM customers c WHERE ${where.join(' AND ')} ORDER BY c.full_name LIMIT ? OFFSET ?`, ...p, Math.min(limit, 500), offset);
    return { rows, total: db.value(`SELECT COUNT(*) FROM customers c WHERE ${where.join(' AND ')}`, ...p) };
  }

  function get(ctx, id) {
    app.auth.require(ctx, 'customer.view');
    const c = db.get('SELECT * FROM customers WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!c) throw E.notFound('Customer');
    c.stats = db.get(`SELECT COUNT(*) AS visits, COALESCE(SUM(total),0) AS lifetime_spend, COALESCE(AVG(total),0) AS avg_basket, MAX(completed_at) AS last_visit
      FROM sales WHERE customer_id = ? AND status = 'completed'`, id);
    c.stats.refunded = db.value(`SELECT COALESCE(SUM(r.total),0) FROM refunds r JOIN sales s ON s.id = r.sale_id WHERE s.customer_id = ? AND r.status = 'completed'`, id);
    c.recent_sales = db.all(`SELECT id, number, status, total, completed_at, created_at FROM sales WHERE customer_id = ? AND status IN ('completed','voided') ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 25`, id);
    c.top_products = db.all(`SELECT si.product_id, si.name, SUM(si.qty) AS qty, SUM(si.line_total) AS spend FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.customer_id = ? AND s.status = 'completed' GROUP BY si.product_id ORDER BY spend DESC LIMIT 5`, id);
    return c;
  }

  function read(body) {
    const d = {
      full_name: v.str(body, 'full_name', { required: true, max: 120 }),
      phone: v.phone(body, 'phone'),
      email: v.email(body, 'email'),
      address: v.str(body, 'address', { max: 300 }),
      notes: v.str(body, 'notes', { max: 1000 }),
      marketing_consent: v.bool(body, 'marketing_consent', false) ? 1 : 0,
    };
    if (d.phone) d.phone = d.phone.replace(/[\s()-]/g, '');
    return d;
  }

  function create(ctx, body) {
    app.auth.require(ctx, 'customer.edit');
    const d = read(body);
    return db.tx(() => {
      if (d.phone && db.get('SELECT 1 FROM customers WHERE business_id = ? AND phone = ?', ctx.businessId, d.phone)) throw E.conflict('A customer with this phone number already exists');
      const id = newId('cus');
      const code = app.numbering.next(ctx.businessId, 'customer', 'C', 5);
      const now = nowIso();
      db.run(`INSERT INTO customers (id,business_id,code,full_name,phone,email,address,notes,marketing_consent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id, ctx.businessId, code, d.full_name, d.phone, d.email, d.address, d.notes, d.marketing_consent, now, now);
      app.audit.log(ctx, 'customer.create', { entityType: 'customer', entityId: id, reference: code });
      return get(ctx, id);
    });
  }

  function update(ctx, id, body) {
    app.auth.require(ctx, 'customer.edit');
    const before = db.get('SELECT * FROM customers WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!before) throw E.notFound('Customer');
    const d = read(body);
    const active = v.bool(body, 'is_active', !!before.is_active) ? 1 : 0;
    return db.tx(() => {
      if (d.phone && db.get('SELECT 1 FROM customers WHERE business_id = ? AND phone = ? AND id <> ?', ctx.businessId, d.phone, id)) throw E.conflict('Another customer has this phone number');
      db.run(`UPDATE customers SET full_name=?, phone=?, email=?, address=?, notes=?, marketing_consent=?, is_active=?, updated_at=? WHERE id=?`,
        d.full_name, d.phone, d.email, d.address, d.notes, d.marketing_consent, active, nowIso(), id);
      // Minimize PII in audit: record which fields changed, not their values.
      const changed = Object.keys(d).filter((k) => d[k] !== before[k]);
      app.audit.log(ctx, 'customer.update', { entityType: 'customer', entityId: id, reference: before.code, meta: { fields: changed } });
      return get(ctx, id);
    });
  }

  return { list, get, create, update };
};
