'use strict';
const { E } = require('../lib/errors');
const { resolvePeriod, localDate, addDays } = require('../lib/time');

/**
 * Reports. Every report returns { title, columns, rows, summary } so the UI table, CSV and PDF
 * exports all share one definition. Column types drive formatting: money | int | qty | pct | date | text.
 */
module.exports = function reportService(app) {
  const { db } = app;

  function period(ctx, q) {
    const tz = db.value('SELECT timezone FROM businesses WHERE id = ?', ctx.businessId);
    return { ...resolvePeriod({ period: q.period || 'today', from: q.from, to: q.to }, tz), tz };
  }

  function saleFilters(q, alias = 's') {
    const w = []; const p = [];
    if (q.cashier_id) { w.push(`${alias}.cashier_id = ?`); p.push(q.cashier_id); }
    if (q.location_id) { w.push(`${alias}.location_id = ?`); p.push(q.location_id); }
    if (q.register_id) { w.push(`${alias}.register_id = ?`); p.push(q.register_id); }
    if (q.payment_method) { w.push(`EXISTS (SELECT 1 FROM payments pm WHERE pm.sale_id = ${alias}.id AND pm.method_code = ? AND pm.status = 'succeeded')`); p.push(q.payment_method); }
    return { sql: w.length ? ` AND ${w.join(' AND ')}` : '', params: p };
  }
  function itemFilters(q) {
    const w = []; const p = [];
    if (q.category_id) { w.push('pr.category_id = ?'); p.push(q.category_id); }
    if (q.product_id) { w.push('si.product_id = ?'); p.push(q.product_id); }
    return { sql: w.length ? ` AND ${w.join(' AND ')}` : '', params: p };
  }

  const REPORTS = {
    sales_summary: {
      title: 'Sales summary by day', perm: 'report.view',
      run(ctx, q) {
        const P = period(ctx, q); const f = saleFilters(q);
        const days = [];
        for (let d = P.fromDate; d <= P.toDate; d = addDays(d, 1)) days.push(d);
        const sales = db.all(`SELECT s.completed_at, s.total, s.subtotal, s.discount_total, s.tax_total, s.status FROM sales s
          WHERE s.business_id = ? AND s.completed_at >= ? AND s.completed_at < ? AND s.status IN ('completed','voided') ${f.sql}`, ctx.businessId, P.from, P.to, ...f.params);
        const refunds = db.all(`SELECT r.created_at, r.total, r.tax_total, r.kind FROM refunds r JOIN sales s ON s.id = r.sale_id WHERE r.business_id = ? AND r.created_at >= ? AND r.created_at < ? ${f.sql}`, ctx.businessId, P.from, P.to, ...f.params);
        const rows = days.map((d) => ({ date: d, transactions: 0, gross: 0, discounts: 0, tax: 0, sales: 0, refunds: 0, voids: 0, net: 0, avg_basket: 0 }));
        const idx = Object.fromEntries(rows.map((r, i) => [r.date, i]));
        for (const s of sales) {
          const r = rows[idx[localDate(new Date(s.completed_at), P.tz)]]; if (!r) continue;
          r.transactions++; r.gross += s.subtotal; r.discounts += s.discount_total; r.tax += s.tax_total; r.sales += s.total;
        }
        for (const x of refunds) {
          const r = rows[idx[localDate(new Date(x.created_at), P.tz)]]; if (!r) continue;
          if (x.kind === 'void') r.voids += x.total; else r.refunds += x.total;
        }
        rows.forEach((r) => { r.net = r.sales - r.refunds - r.voids; r.avg_basket = r.transactions ? Math.round(r.sales / r.transactions) : 0; });
        const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
        return {
          columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'transactions', label: 'Transactions', type: 'int' }, { key: 'gross', label: 'Gross', type: 'money' },
            { key: 'discounts', label: 'Discounts', type: 'money' }, { key: 'sales', label: 'Sales', type: 'money' }, { key: 'tax', label: 'Tax in sales', type: 'money' },
            { key: 'refunds', label: 'Refunds', type: 'money' }, { key: 'voids', label: 'Voids', type: 'money' }, { key: 'net', label: 'Net sales', type: 'money' }, { key: 'avg_basket', label: 'Avg basket', type: 'money' }],
          rows,
          summary: { transactions: sum('transactions'), gross: sum('gross'), discounts: sum('discounts'), sales: sum('sales'), tax: sum('tax'), refunds: sum('refunds'), voids: sum('voids'), net: sum('net'), avg_basket: sum('transactions') ? Math.round(sum('sales') / sum('transactions')) : 0 },
        };
      },
    },
    product_performance: {
      title: 'Product performance', perm: 'report.view',
      run(ctx, q) {
        const P = period(ctx, q); const f = saleFilters(q); const fi = itemFilters(q);
        const fin = app.auth.can(ctx, 'report.financial');
        const rows = db.all(`SELECT si.product_id, pr.sku, pr.name, c.name AS category, SUM(si.qty) AS qty, SUM(si.line_total) AS revenue, SUM(si.line_discount + si.cart_discount_alloc) AS discounts,
            SUM(si.tax_amount) AS tax, SUM(ROUND(si.qty * si.unit_cost)) AS cost, COUNT(DISTINCT s.id) AS baskets,
            COALESCE((SELECT SUM(ri.qty) FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE ri.product_id = si.product_id AND r.created_at >= ? AND r.created_at < ?),0) AS returned_qty
          FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products pr ON pr.id = si.product_id LEFT JOIN categories c ON c.id = pr.category_id
          WHERE s.business_id = ? AND s.status = 'completed' AND s.completed_at >= ? AND s.completed_at < ? ${f.sql} ${fi.sql}
          GROUP BY si.product_id ORDER BY revenue DESC LIMIT ?`, P.from, P.to, ctx.businessId, P.from, P.to, ...f.params, ...fi.params, Number(q.limit) || 500);
        rows.forEach((r) => { const netRev = r.revenue - r.tax; r.margin = netRev - r.cost; r.margin_pct = netRev ? Math.round((r.margin / netRev) * 1000) / 10 : 0; });
        const cols = [{ key: 'sku', label: 'SKU', type: 'text' }, { key: 'name', label: 'Product', type: 'text' }, { key: 'category', label: 'Category', type: 'text' },
          { key: 'qty', label: 'Qty sold', type: 'qty' }, { key: 'returned_qty', label: 'Returned', type: 'qty' }, { key: 'baskets', label: 'Baskets', type: 'int' },
          { key: 'discounts', label: 'Discounts', type: 'money' }, { key: 'revenue', label: 'Revenue', type: 'money' }];
        if (fin) cols.push({ key: 'cost', label: 'Cost', type: 'money' }, { key: 'margin', label: 'Gross margin', type: 'money' }, { key: 'margin_pct', label: 'Margin %', type: 'pct' });
        return { columns: cols, rows: fin ? rows : rows.map(({ cost, margin, margin_pct: mp, ...r }) => (void cost, void margin, void mp, r)), summary: { qty: rows.reduce((a, r) => a + r.qty, 0), revenue: rows.reduce((a, r) => a + r.revenue, 0), ...(fin ? { cost: rows.reduce((a, r) => a + r.cost, 0), margin: rows.reduce((a, r) => a + r.margin, 0) } : {}) } };
      },
    },
    sales_by_category: {
      title: 'Sales by category', perm: 'report.view',
      run(ctx, q) {
        const P = period(ctx, q); const f = saleFilters(q);
        const rows = db.all(`SELECT COALESCE(c.name,'Uncategorised') AS category, SUM(si.qty) AS qty, SUM(si.line_total) AS revenue, SUM(si.tax_amount) AS tax, COUNT(DISTINCT s.id) AS baskets
          FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products pr ON pr.id = si.product_id LEFT JOIN categories c ON c.id = pr.category_id
          WHERE s.business_id = ? AND s.status = 'completed' AND s.completed_at >= ? AND s.completed_at < ? ${f.sql} GROUP BY c.id ORDER BY revenue DESC`, ctx.businessId, P.from, P.to, ...f.params);
        const total = rows.reduce((a, r) => a + r.revenue, 0);
        rows.forEach((r) => { r.share = total ? Math.round((r.revenue / total) * 1000) / 10 : 0; });
        return { columns: [{ key: 'category', label: 'Category', type: 'text' }, { key: 'qty', label: 'Qty', type: 'qty' }, { key: 'baskets', label: 'Baskets', type: 'int' }, { key: 'revenue', label: 'Revenue', type: 'money' }, { key: 'tax', label: 'Tax', type: 'money' }, { key: 'share', label: 'Share', type: 'pct' }], rows, summary: { revenue: total } };
      },
    },
    cashier_performance: {
      title: 'Sales by cashier', perm: 'report.view',
      run(ctx, q) {
        const P = period(ctx, q);
        const rows = db.all(`SELECT u.full_name AS cashier, COUNT(*) AS transactions, SUM(s.total) AS sales, SUM(s.discount_total) AS discounts,
            ROUND(AVG(s.total)) AS avg_basket, SUM(CASE WHEN s.status = 'voided' THEN 1 ELSE 0 END) AS voids,
            (SELECT COUNT(*) FROM sales c WHERE c.cashier_id = u.id AND c.status = 'cancelled' AND c.cancelled_at >= ? AND c.cancelled_at < ?) AS cancelled,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.user_id = u.id AND a.action = 'sale.line_remove' AND a.occurred_at >= ? AND a.occurred_at < ?) AS line_voids,
            (SELECT COALESCE(SUM(variance),0) FROM register_sessions rs WHERE rs.user_id = u.id AND rs.closed_at >= ? AND rs.closed_at < ?) AS cash_variance
          FROM sales s JOIN users u ON u.id = s.cashier_id WHERE s.business_id = ? AND s.completed_at >= ? AND s.completed_at < ? AND s.status IN ('completed','voided')
          GROUP BY u.id ORDER BY sales DESC`, P.from, P.to, P.from, P.to, P.from, P.to, ctx.businessId, P.from, P.to);
        return { columns: [{ key: 'cashier', label: 'Cashier', type: 'text' }, { key: 'transactions', label: 'Transactions', type: 'int' }, { key: 'sales', label: 'Sales', type: 'money' },
          { key: 'avg_basket', label: 'Avg basket', type: 'money' }, { key: 'discounts', label: 'Discounts given', type: 'money' }, { key: 'voids', label: 'Voided sales', type: 'int' },
          { key: 'cancelled', label: 'Cancelled', type: 'int' }, { key: 'line_voids', label: 'Line removals', type: 'int' }, { key: 'cash_variance', label: 'Cash variance', type: 'money' }], rows, summary: {} };
      },
    },
    payments_by_method: {
      title: 'Payments by method', perm: 'report.financial',
      run(ctx, q) {
        const P = period(ctx, q);
        const rows = db.all(`SELECT p.method_code AS method, pm.name AS method_name, p.provider_code AS provider, COUNT(*) AS count, SUM(p.amount) AS amount,
            SUM(CASE WHEN p.confirmation_source = 'manual' THEN p.amount ELSE 0 END) AS manually_confirmed,
            COALESCE((SELECT SUM(rp.amount) FROM refund_payments rp WHERE rp.method_code = p.method_code AND rp.status = 'succeeded' AND rp.created_at >= ? AND rp.created_at < ?),0) AS refunded
          FROM payments p LEFT JOIN payment_methods pm ON pm.code = p.method_code AND pm.business_id = p.business_id
          WHERE p.business_id = ? AND p.status = 'succeeded' AND p.confirmed_at >= ? AND p.confirmed_at < ? GROUP BY p.method_code ORDER BY amount DESC`, P.from, P.to, ctx.businessId, P.from, P.to);
        rows.forEach((r) => { r.net = r.amount - r.refunded; });
        const failed = db.all(`SELECT method_code AS method, status, COUNT(*) AS n FROM payments WHERE business_id = ? AND created_at >= ? AND created_at < ? AND status IN ('failed','cancelled','pending','processing') GROUP BY method_code, status`, ctx.businessId, P.from, P.to);
        return { columns: [{ key: 'method_name', label: 'Method', type: 'text' }, { key: 'provider', label: 'Processed by', type: 'text' }, { key: 'count', label: 'Payments', type: 'int' },
          { key: 'amount', label: 'Collected', type: 'money' }, { key: 'manually_confirmed', label: 'Manually confirmed', type: 'money' }, { key: 'refunded', label: 'Refunded', type: 'money' }, { key: 'net', label: 'Net', type: 'money' }],
        rows, summary: { amount: rows.reduce((a, r) => a + r.amount, 0), refunded: rows.reduce((a, r) => a + r.refunded, 0), net: rows.reduce((a, r) => a + r.net, 0) }, notes: failed.map((f) => `${f.n} ${f.status} ${f.method} payment(s)`) };
      },
    },
    tax: {
      title: 'Tax report', perm: 'report.financial',
      run(ctx, q) {
        const P = period(ctx, q);
        const sales = db.all(`SELECT si.tax_rate_bp AS rate_bp, SUM(si.line_total - si.tax_amount) AS net, SUM(si.tax_amount) AS tax FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.business_id = ? AND s.status IN ('completed','voided') AND s.completed_at >= ? AND s.completed_at < ? GROUP BY si.tax_rate_bp`, ctx.businessId, P.from, P.to);
        const refunds = db.all(`SELECT si.tax_rate_bp AS rate_bp, SUM(ri.amount - ri.tax_amount) AS net, SUM(ri.tax_amount) AS tax FROM refund_items ri JOIN sale_items si ON si.id = ri.sale_item_id JOIN refunds r ON r.id = ri.refund_id
          WHERE r.business_id = ? AND r.created_at >= ? AND r.created_at < ? GROUP BY si.tax_rate_bp`, ctx.businessId, P.from, P.to);
        const rates = db.all('SELECT rate_bp, name FROM tax_rates WHERE business_id = ?', ctx.businessId);
        const keys = [...new Set([...sales.map((s) => s.rate_bp), ...refunds.map((r) => r.rate_bp)])].sort((a, b) => b - a);
        const rows = keys.map((k) => {
          const s = sales.find((x) => x.rate_bp === k) || { net: 0, tax: 0 }; const r = refunds.find((x) => x.rate_bp === k) || { net: 0, tax: 0 };
          return { rate: (rates.find((x) => x.rate_bp === k) || { name: `${k / 100}%` }).name, rate_pct: k / 100, sales_net: s.net, sales_tax: s.tax, refund_net: r.net, refund_tax: r.tax, net_taxable: s.net - r.net, tax_due: s.tax - r.tax };
        });
        return { columns: [{ key: 'rate', label: 'Tax rate', type: 'text' }, { key: 'rate_pct', label: 'Rate', type: 'pct' }, { key: 'sales_net', label: 'Taxable sales', type: 'money' }, { key: 'sales_tax', label: 'Tax on sales', type: 'money' },
          { key: 'refund_net', label: 'Taxable refunds', type: 'money' }, { key: 'refund_tax', label: 'Tax on refunds', type: 'money' }, { key: 'net_taxable', label: 'Net taxable', type: 'money' }, { key: 'tax_due', label: 'Net tax', type: 'money' }],
        rows, summary: { tax_due: rows.reduce((a, r) => a + r.tax_due, 0) }, notes: ['Figures summarise tax recorded at the till. Confirm filing obligations with your tax adviser.'] };
      },
    },
    refunds: {
      title: 'Refunds & voids', perm: 'report.view',
      run(ctx, q) {
        const P = period(ctx, q);
        const rows = db.all(`SELECT r.number, r.kind, r.status, r.created_at, s.number AS sale_number, r.reason_code, r.reason_note, r.total, rq.full_name AS requested_by, au.full_name AS authorized_by,
            (SELECT GROUP_CONCAT(DISTINCT method_code) FROM refund_payments rp WHERE rp.refund_id = r.id AND rp.status <> 'failed') AS methods
          FROM refunds r JOIN sales s ON s.id = r.sale_id JOIN users rq ON rq.id = r.requested_by JOIN users au ON au.id = r.authorized_by
          WHERE r.business_id = ? AND r.created_at >= ? AND r.created_at < ? ORDER BY r.created_at DESC`, ctx.businessId, P.from, P.to);
        return { columns: [{ key: 'number', label: 'Number', type: 'text' }, { key: 'kind', label: 'Type', type: 'text' }, { key: 'created_at', label: 'When', type: 'datetime' }, { key: 'sale_number', label: 'Sale', type: 'text' },
          { key: 'reason_code', label: 'Reason', type: 'text' }, { key: 'total', label: 'Amount', type: 'money' }, { key: 'methods', label: 'Refunded to', type: 'text' }, { key: 'requested_by', label: 'Requested by', type: 'text' }, { key: 'authorized_by', label: 'Authorized by', type: 'text' }, { key: 'status', label: 'Status', type: 'status' }],
        rows, summary: { total: rows.reduce((a, r) => a + r.total, 0) } };
      },
    },
    sessions: {
      title: 'Cashier sessions', perm: 'report.view',
      run(ctx, q) {
        const P = period(ctx, q);
        const rows = db.all(`SELECT rs.number, u.full_name AS cashier, r.name AS register, rs.opened_at, rs.closed_at, rs.status, rs.opening_float, rs.expected_cash, rs.counted_cash, rs.variance, rs.review_status
          FROM register_sessions rs JOIN users u ON u.id = rs.user_id JOIN registers r ON r.id = rs.register_id WHERE rs.business_id = ? AND rs.opened_at >= ? AND rs.opened_at < ? ORDER BY rs.opened_at DESC`, ctx.businessId, P.from, P.to);
        return { columns: [{ key: 'number', label: 'Session', type: 'text' }, { key: 'cashier', label: 'Cashier', type: 'text' }, { key: 'register', label: 'Register', type: 'text' }, { key: 'opened_at', label: 'Opened', type: 'datetime' },
          { key: 'closed_at', label: 'Closed', type: 'datetime' }, { key: 'opening_float', label: 'Float', type: 'money' }, { key: 'expected_cash', label: 'Expected', type: 'money' }, { key: 'counted_cash', label: 'Counted', type: 'money' },
          { key: 'variance', label: 'Variance', type: 'money' }, { key: 'review_status', label: 'Review', type: 'status' }], rows, summary: { variance: rows.reduce((a, r) => a + (r.variance || 0), 0) } };
      },
    },
    inventory_valuation: {
      title: 'Inventory valuation', perm: 'inventory.view', noPeriod: true,
      run(ctx, q) {
        const loc = q.location_id || db.value('SELECT id FROM locations WHERE business_id = ? ORDER BY created_at LIMIT 1', ctx.businessId);
        const fin = app.auth.can(ctx, 'report.financial');
        const w = []; const p = [];
        if (q.category_id) { w.push('pr.category_id = ?'); p.push(q.category_id); }
        const rows = db.all(`SELECT pr.sku, pr.name, c.name AS category, pr.unit, COALESCE(s.qty,0) AS qty, pr.min_stock, pr.cost, pr.price,
            ROUND(COALESCE(s.qty,0) * pr.cost) AS cost_value, ROUND(COALESCE(s.qty,0) * pr.price) AS retail_value
          FROM products pr LEFT JOIN stock_levels s ON s.product_id = pr.id AND s.location_id = ? LEFT JOIN categories c ON c.id = pr.category_id
          WHERE pr.business_id = ? AND pr.track_stock = 1 AND pr.is_active = 1 ${w.length ? `AND ${w.join(' AND ')}` : ''} ORDER BY c.name, pr.name`, loc, ctx.businessId, ...p);
        const cols = [{ key: 'sku', label: 'SKU', type: 'text' }, { key: 'name', label: 'Product', type: 'text' }, { key: 'category', label: 'Category', type: 'text' }, { key: 'qty', label: 'On hand', type: 'qty' }, { key: 'min_stock', label: 'Min', type: 'qty' },
          { key: 'price', label: 'Price', type: 'money' }, { key: 'retail_value', label: 'Retail value', type: 'money' }];
        if (fin) cols.splice(5, 0, { key: 'cost', label: 'Unit cost', type: 'money' }, { key: 'cost_value', label: 'Cost value', type: 'money' });
        return { columns: cols, rows, summary: { qty: rows.reduce((a, r) => a + Math.max(0, r.qty), 0), retail_value: rows.reduce((a, r) => a + Math.max(0, r.retail_value), 0), ...(fin ? { cost_value: rows.reduce((a, r) => a + Math.max(0, r.cost_value), 0) } : {}) } };
      },
    },
    inventory_movements: {
      title: 'Stock movement summary', perm: 'inventory.view',
      run(ctx, q) {
        const P = period(ctx, q);
        const rows = db.all(`SELECT pr.sku, pr.name, SUM(CASE WHEN m.type IN ('receive','opening') THEN m.qty_change ELSE 0 END) AS received,
            -SUM(CASE WHEN m.type = 'sale' THEN m.qty_change ELSE 0 END) AS sold, SUM(CASE WHEN m.type IN ('return','void_reversal') THEN m.qty_change ELSE 0 END) AS returned,
            -SUM(CASE WHEN m.type IN ('damage','expired','theft') THEN m.qty_change ELSE 0 END) AS written_off, SUM(CASE WHEN m.type IN ('adjustment','stocktake') THEN m.qty_change ELSE 0 END) AS adjusted,
            SUM(CASE WHEN m.type IN ('transfer_in','transfer_out') THEN m.qty_change ELSE 0 END) AS transferred, SUM(m.qty_change) AS net_change
          FROM inventory_movements m JOIN products pr ON pr.id = m.product_id WHERE m.business_id = ? AND m.created_at >= ? AND m.created_at < ? ${q.location_id ? 'AND m.location_id = ?' : ''}
          GROUP BY m.product_id ORDER BY pr.name`, ctx.businessId, P.from, P.to, ...(q.location_id ? [q.location_id] : []));
        return { columns: [{ key: 'sku', label: 'SKU', type: 'text' }, { key: 'name', label: 'Product', type: 'text' }, { key: 'received', label: 'Received', type: 'qty' }, { key: 'sold', label: 'Sold', type: 'qty' },
          { key: 'returned', label: 'Returned', type: 'qty' }, { key: 'written_off', label: 'Written off', type: 'qty' }, { key: 'adjusted', label: 'Adjusted', type: 'qty' }, { key: 'transferred', label: 'Transfers', type: 'qty' }, { key: 'net_change', label: 'Net change', type: 'qty' }], rows, summary: {} };
      },
    },
    low_stock: {
      title: 'Low stock / reorder', perm: 'inventory.view', noPeriod: true,
      run(ctx, q) {
        const loc = q.location_id || db.value('SELECT id FROM locations WHERE business_id = ? ORDER BY created_at LIMIT 1', ctx.businessId);
        const rows = app.inventory.lowStock(ctx, loc, 1000);
        rows.forEach((r) => { r.suggested = Math.max(r.reorder_qty, r.min_stock * 2 - r.qty); });
        return { columns: [{ key: 'sku', label: 'SKU', type: 'text' }, { key: 'name', label: 'Product', type: 'text' }, { key: 'qty', label: 'On hand', type: 'qty' }, { key: 'min_stock', label: 'Minimum', type: 'qty' },
          { key: 'reorder_qty', label: 'Reorder qty', type: 'qty' }, { key: 'suggested', label: 'Suggested order', type: 'qty' }, { key: 'supplier_name', label: 'Supplier', type: 'text' }], rows, summary: { items: rows.length } };
      },
    },
    payouts: {
      title: 'Payouts & settlements', perm: 'report.financial',
      run(ctx, q) {
        const P = period(ctx, q);
        const rows = db.all(`SELECT po.number, po.type, po.status, po.amount, po.reason, po.reference, po.created_at, po.paid_at, rq.full_name AS requested_by, ap.full_name AS approved_by, st.provider_settlement_ref AS settlement
          FROM payouts po JOIN users rq ON rq.id = po.requested_by LEFT JOIN users ap ON ap.id = po.approved_by LEFT JOIN settlements st ON st.id = po.settlement_id
          WHERE po.business_id = ? AND po.created_at >= ? AND po.created_at < ? ORDER BY po.created_at DESC`, ctx.businessId, P.from, P.to);
        const stl = db.get(`SELECT COALESCE(SUM(gross_amount),0) AS gross, COALESCE(SUM(fee_amount),0) AS fees, COALESCE(SUM(net_amount),0) AS net FROM settlements WHERE business_id = ? AND settlement_date >= ? AND settlement_date <= ?`, ctx.businessId, P.fromDate, P.toDate);
        return { columns: [{ key: 'number', label: 'Number', type: 'text' }, { key: 'type', label: 'Type', type: 'text' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'amount', label: 'Amount', type: 'money' },
          { key: 'reason', label: 'Reason', type: 'text' }, { key: 'settlement', label: 'Settlement', type: 'text' }, { key: 'reference', label: 'Reference', type: 'text' }, { key: 'requested_by', label: 'Requested', type: 'text' }, { key: 'approved_by', label: 'Approved', type: 'text' }, { key: 'created_at', label: 'Created', type: 'datetime' }],
        rows, summary: { paid: rows.filter((r) => r.status === 'paid').reduce((a, r) => a + r.amount, 0), settlement_gross: stl.gross, settlement_fees: stl.fees, settlement_net: stl.net } };
      },
    },
    reconciliation: {
      title: 'Reconciliation status', perm: 'reconciliation.manage',
      run(ctx, q) {
        const P = period(ctx, q);
        const rows = db.all(`SELECT rr.business_date, rr.status, rr.summary_json, rr.created_at, u.full_name AS run_by,
            (SELECT COUNT(*) FROM reconciliation_items ri WHERE ri.run_id = rr.id AND ri.status = 'discrepancy') AS discrepancies,
            (SELECT COUNT(*) FROM reconciliation_items ri WHERE ri.run_id = rr.id AND ri.status = 'pending') AS pending
          FROM reconciliation_runs rr JOIN users u ON u.id = rr.created_by WHERE rr.business_id = ? AND rr.superseded_by IS NULL AND rr.business_date >= ? AND rr.business_date <= ? ORDER BY rr.business_date DESC`, ctx.businessId, P.fromDate, P.toDate);
        return { columns: [{ key: 'business_date', label: 'Date', type: 'date' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'discrepancies', label: 'Discrepancies', type: 'int' }, { key: 'pending', label: 'Pending', type: 'int' }, { key: 'run_by', label: 'Run by', type: 'text' }, { key: 'created_at', label: 'Run at', type: 'datetime' }], rows, summary: {} };
      },
    },
    customers: {
      title: 'Top customers', perm: 'customer.view',
      run(ctx, q) {
        const P = period(ctx, q);
        const rows = db.all(`SELECT c.code, c.full_name AS name, c.phone, COUNT(s.id) AS visits, SUM(s.total) AS spend, ROUND(AVG(s.total)) AS avg_basket, MAX(s.completed_at) AS last_visit, c.loyalty_points AS points
          FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.business_id = ? AND s.status = 'completed' AND s.completed_at >= ? AND s.completed_at < ?
          GROUP BY c.id ORDER BY spend DESC LIMIT 200`, ctx.businessId, P.from, P.to);
        const anon = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS t FROM sales WHERE business_id = ? AND status = 'completed' AND customer_id IS NULL AND completed_at >= ? AND completed_at < ?`, ctx.businessId, P.from, P.to);
        return { columns: [{ key: 'code', label: 'Code', type: 'text' }, { key: 'name', label: 'Customer', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'visits', label: 'Visits', type: 'int' }, { key: 'spend', label: 'Spend', type: 'money' },
          { key: 'avg_basket', label: 'Avg basket', type: 'money' }, { key: 'points', label: 'Points', type: 'int' }, { key: 'last_visit', label: 'Last visit', type: 'datetime' }], rows, summary: { walk_in_transactions: anon.n, walk_in_sales: anon.t } };
      },
    },
    discounts_overrides: {
      title: 'Discounts, overrides & line removals', perm: 'report.view',
      run(ctx, q) {
        const P = period(ctx, q);
        const rows = db.all(`SELECT a.occurred_at, a.username, a.action, a.reference, (SELECT full_name FROM users WHERE id = a.approved_by) AS approved_by, a.old_value, a.new_value
          FROM audit_logs a WHERE a.business_id = ? AND a.occurred_at >= ? AND a.occurred_at < ? AND a.action IN ('sale.discount_line','sale.discount_cart','sale.price_override','sale.line_remove','sale.cancel','payment.void','auth.override.granted','drawer.open')
          ORDER BY a.occurred_at DESC LIMIT 2000`, ctx.businessId, P.from, P.to);
        rows.forEach((r) => { r.detail = [r.old_value && `from ${r.old_value}`, r.new_value && `to ${r.new_value}`].filter(Boolean).join(' ').slice(0, 200); });
        return { columns: [{ key: 'occurred_at', label: 'When', type: 'datetime' }, { key: 'username', label: 'User', type: 'text' }, { key: 'action', label: 'Action', type: 'text' }, { key: 'reference', label: 'Sale', type: 'text' }, { key: 'approved_by', label: 'Approved by', type: 'text' }, { key: 'detail', label: 'Detail', type: 'text' }], rows, summary: { events: rows.length } };
      },
    },
  };

  function catalog(ctx) {
    return Object.entries(REPORTS).filter(([, r]) => app.auth.can(ctx, r.perm)).map(([key, r]) => ({ key, title: r.title, period: !r.noPeriod }));
  }

  function run(ctx, key, q) {
    const r = REPORTS[key];
    if (!r) throw E.notFound('Report');
    app.auth.require(ctx, r.perm);
    let out;
    try { out = r.run(ctx, q || {}); } catch (e) { if (/period/.test(e.message)) throw E.validation(e.message); throw e; }
    const p = r.noPeriod ? null : period(ctx, q || {});
    return { key, title: r.title, period: p ? { from: p.fromDate, to: p.toDate } : null, ...out };
  }

  return { catalog, run, REPORTS };
};
