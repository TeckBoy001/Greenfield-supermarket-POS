'use strict';
const { resolvePeriod } = require('../lib/time');

/** Operational dashboard: only numbers someone can act on today. */
module.exports = function dashboardService(app) {
  const { db } = app;

  function get(ctx, { location_id: locationId } = {}) {
    const b = db.get('SELECT timezone FROM businesses WHERE id = ?', ctx.businessId);
    const today = resolvePeriod({ period: 'today' }, b.timezone);
    const yday = resolvePeriod({ period: 'yesterday' }, b.timezone);
    const B = ctx.businessId;
    const locSql = locationId ? ' AND location_id = ?' : '';
    const lp = locationId ? [locationId] : [];
    const kpi = (P) => db.get(`SELECT COUNT(*) AS transactions, COALESCE(SUM(total),0) AS sales, COALESCE(SUM(discount_total),0) AS discounts
      FROM sales WHERE business_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ? ${locSql}`, B, P.from, P.to, ...lp);
    const t = kpi(today); const y = kpi(yday);
    // same time yesterday, for a fair comparison
    const sinceMidnight = Date.now() - new Date(today.from).getTime();
    const ySame = db.get(`SELECT COUNT(*) AS transactions, COALESCE(SUM(total),0) AS sales FROM sales WHERE business_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ? ${locSql}`,
      B, yday.from, new Date(new Date(yday.from).getTime() + sinceMidnight).toISOString(), ...lp);
    const refunds = db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM refunds WHERE business_id = ? AND created_at >= ? AND created_at < ? ${locSql}`, B, today.from, today.to, ...lp);

    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0, transactions: 0 }));
    for (const s of db.all(`SELECT completed_at, total FROM sales WHERE business_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ? ${locSql}`, B, today.from, today.to, ...lp)) {
      const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: b.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(s.completed_at)));
      hourly[h].sales += s.total; hourly[h].transactions++;
    }

    const payments = db.all(`SELECT p.method_code, pm.name, pm.type, COUNT(*) AS count, SUM(p.amount) AS amount FROM payments p LEFT JOIN payment_methods pm ON pm.code = p.method_code AND pm.business_id = p.business_id
      WHERE p.business_id = ? AND p.status = 'succeeded' AND p.confirmed_at >= ? AND p.confirmed_at < ? GROUP BY p.method_code ORDER BY amount DESC`, B, today.from, today.to);
    const top = db.all(`SELECT si.product_id, si.name, SUM(si.qty) AS qty, SUM(si.line_total) AS revenue FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.business_id = ? AND s.status = 'completed' AND s.completed_at >= ? AND s.completed_at < ? GROUP BY si.product_id ORDER BY revenue DESC LIMIT 8`, B, today.from, today.to);
    const loc = locationId || db.value(`SELECT id FROM locations WHERE business_id = ? AND type = 'store' ORDER BY created_at LIMIT 1`, B);
    const lowStockCount = db.value(`SELECT COUNT(*) FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id AND s.location_id = ? WHERE p.business_id = ? AND p.is_active = 1 AND p.track_stock = 1 AND COALESCE(s.qty,0) <= p.min_stock`, loc, B);
    const outOfStock = db.value(`SELECT COUNT(*) FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id AND s.location_id = ? WHERE p.business_id = ? AND p.is_active = 1 AND p.track_stock = 1 AND COALESCE(s.qty,0) <= 0`, loc, B);
    const sessions = db.all(`SELECT rs.id, rs.number, rs.opened_at, u.full_name AS cashier, r.name AS register,
        (SELECT COUNT(*) FROM sales s WHERE s.session_id = rs.id AND s.status = 'completed') AS sales_count,
        (SELECT COALESCE(SUM(total),0) FROM sales s WHERE s.session_id = rs.id AND s.status = 'completed') AS sales_total
      FROM register_sessions rs JOIN users u ON u.id = rs.user_id JOIN registers r ON r.id = rs.register_id WHERE rs.business_id = ? AND rs.status = 'open' ORDER BY r.code`, B);

    const can = (p) => app.auth.can(ctx, p);
    const finance = can('report.financial') || can('reconciliation.manage') ? {
      inflight_payments: db.value(`SELECT COUNT(*) FROM payments WHERE business_id = ? AND status IN ('pending','processing')`, B),
      failed_refunds: db.value(`SELECT COUNT(*) FROM refunds WHERE business_id = ? AND status = 'failed'`, B),
      unsettled: db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(p.amount),0) AS amount FROM payments p WHERE p.business_id = ? AND p.status = 'succeeded' AND p.provider_code LIKE 'sim-%'
        AND NOT EXISTS (SELECT 1 FROM settlement_items si WHERE si.payment_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM refund_payments rp JOIN refunds r ON r.id = rp.refund_id WHERE rp.original_payment_id = p.id AND r.kind = 'void' AND rp.status = 'succeeded')`, B),
      settlements_discrepancy: db.value(`SELECT COUNT(*) FROM settlements WHERE business_id = ? AND status = 'discrepancy'`, B),
      settlements_awaiting_funds: db.value(`SELECT COUNT(*) FROM settlements s WHERE business_id = ? AND status IN ('matched','resolved','discrepancy') AND (SELECT COALESCE(SUM(amount),0) FROM payouts p WHERE p.settlement_id = s.id AND p.status = 'paid') < s.net_amount`, B),
      last_settlement: db.get(`SELECT provider_code, provider_settlement_ref, settlement_date, net_amount, status FROM settlements WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`, B),
      payouts_pending: db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount FROM payouts WHERE business_id = ? AND status IN ('pending_approval','approved')`, B),
      recon_issues: db.value(`SELECT COUNT(*) FROM reconciliation_runs WHERE business_id = ? AND superseded_by IS NULL AND status IN ('discrepancy','partially_matched')`, B),
      last_recon: db.get(`SELECT business_date, status FROM reconciliation_runs WHERE business_id = ? AND superseded_by IS NULL ORDER BY business_date DESC LIMIT 1`, B),
      sessions_to_review: db.value(`SELECT COUNT(*) FROM register_sessions WHERE business_id = ? AND review_status = 'required'`, B),
    } : null;

    return {
      today: { ...t, avg_basket: t.transactions ? Math.round(t.sales / t.transactions) : 0, refunds },
      yesterday: { ...y, avg_basket: y.transactions ? Math.round(y.sales / y.transactions) : 0 },
      yesterday_same_time: ySame,
      hourly, payments, top_products: top,
      inventory: can('inventory.view') ? { low_stock: lowStockCount, out_of_stock: outOfStock, items: app.inventory.lowStock(ctx, loc, 6) } : null,
      sessions, finance,
      network: app.connectivity.status(B),
      held_sales: db.value(`SELECT COUNT(*) FROM sales WHERE business_id = ? AND status = 'held'`, B),
    };
  }

  return { get };
};
