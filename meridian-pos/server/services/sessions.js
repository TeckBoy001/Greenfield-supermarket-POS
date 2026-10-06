'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');

/**
 * Cashier / register sessions (a.k.a. shifts, till sessions).
 * Expected cash = opening float + cash sales − cash refunds + paid-ins − paid-outs − cash drops.
 * Figures are always derived from the payment, refund and cash-movement ledgers — never typed in.
 */
module.exports = function sessionService(app) {
  const { db } = app;

  function current(ctx) {
    if (!ctx.registerId) return null;
    const s = db.get(`SELECT rs.*, u.full_name AS cashier_name, r.code AS register_code, r.name AS register_name FROM register_sessions rs
      JOIN users u ON u.id = rs.user_id JOIN registers r ON r.id = rs.register_id WHERE rs.register_id = ? AND rs.status = 'open'`, ctx.registerId);
    return s || null;
  }

  /** Session that the current user may sell on. Throws with a helpful message otherwise. */
  function requireSellingSession(ctx) {
    if (!ctx.registerId) throw E.conflict('This terminal is not assigned to a register. Sign in on a POS terminal.');
    const s = current(ctx);
    if (!s) throw E.conflict('No open register session. Open the register (enter opening cash) before selling.', { code: 'no_session' });
    if (s.user_id !== ctx.user.id && !app.auth.can(ctx, 'session.manage_all')) {
      throw E.conflict(`Register is open under ${s.cashier_name}. Ask them to close it, or a manager to take over.`, { code: 'session_other_user' });
    }
    return s;
  }

  function figures(sessionId) {
    const s = db.get('SELECT * FROM register_sessions WHERE id = ?', sessionId);
    const cashSales = db.value(`SELECT COALESCE(SUM(amount),0) FROM payments WHERE session_id = ? AND method_type = 'cash' AND status = 'succeeded'`, sessionId);
    const cashRefunds = db.value(`SELECT COALESCE(SUM(amount),0) FROM refund_payments WHERE session_id = ? AND method_type = 'cash' AND status = 'succeeded'`, sessionId);
    const mv = Object.fromEntries(db.all(`SELECT type, COALESCE(SUM(amount),0) AS total FROM cash_movements WHERE session_id = ? GROUP BY type`, sessionId).map((r) => [r.type, r.total]));
    const paidIn = mv.paid_in || 0; const paidOut = mv.paid_out || 0; const drops = mv.cash_drop || 0;
    const expected = s.opening_float + cashSales - cashRefunds + paidIn - paidOut - drops;
    const byMethod = db.all(`SELECT method_code, method_type, COUNT(*) AS count, SUM(amount) AS total FROM payments WHERE session_id = ? AND status = 'succeeded' GROUP BY method_code ORDER BY total DESC`, sessionId);
    const refundsByMethod = db.all(`SELECT method_code, COUNT(*) AS count, SUM(amount) AS total FROM refund_payments WHERE session_id = ? AND status = 'succeeded' GROUP BY method_code`, sessionId);
    const sales = db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(discount_total),0) AS discounts, COALESCE(SUM(tax_total),0) AS tax
      FROM sales WHERE session_id = ? AND status IN ('completed','voided')`, sessionId);
    const voids = db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM sales WHERE session_id = ? AND status = 'voided'`, sessionId);
    const refunds = db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM refunds WHERE session_id = ? AND kind = 'refund' AND status = 'completed'`, sessionId);
    const cancelled = db.value(`SELECT COUNT(*) FROM sales WHERE session_id = ? AND status = 'cancelled'`, sessionId);
    return {
      opening_float: s.opening_float, cash_sales: cashSales, cash_refunds: cashRefunds, paid_in: paidIn, paid_out: paidOut, cash_drops: drops,
      expected_cash: expected, by_method: byMethod, refunds_by_method: refundsByMethod, sales, voids, refunds, cancelled_sales: cancelled,
    };
  }

  function open(ctx, body) {
    app.auth.require(ctx, 'session.open_close');
    if (!ctx.registerId) throw E.conflict('Sign in on a register to open a session');
    const float = v.money(body, 'opening_float', { required: true });
    const note = v.str(body, 'note', { max: 300 });
    return db.tx(() => {
      const existing = current(ctx);
      if (existing) throw E.conflict(`Register already open (session ${existing.number} by ${existing.cashier_name})`);
      const mine = db.get(`SELECT rs.number, r.name FROM register_sessions rs JOIN registers r ON r.id = rs.register_id WHERE rs.user_id = ? AND rs.status = 'open'`, ctx.user.id);
      if (mine) throw E.conflict(`You already have session ${mine.number} open on ${mine.name}. Close it first.`);
      const reg = db.get('SELECT * FROM registers WHERE id = ?', ctx.registerId);
      const id = newId('rss');
      const number = app.numbering.next(ctx.businessId, 'session', 'SES-');
      db.run(`INSERT INTO register_sessions (id,business_id,number,register_id,location_id,user_id,status,opening_float,opened_at,close_note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, ctx.businessId, number, reg.id, reg.location_id, ctx.user.id, 'open', float, nowIso(), note ? `Open: ${note}` : null);
      app.audit.log(ctx, 'session.open', { entityType: 'register_session', entityId: id, reference: number, newValue: { opening_float: float, register: reg.code } });
      return get(ctx, id);
    });
  }

  function cashMovement(ctx, body) {
    const s = requireSellingSession(ctx);
    const type = v.oneOf(body, 'type', ['paid_in', 'paid_out', 'cash_drop'], { required: true });
    const amount = v.money(body, 'amount', { required: true, min: 1 });
    const reason = v.str(body, 'reason', { required: true, max: 200 });
    const reference = v.str(body, 'reference', { max: 60 });
    const approver = app.auth.authorize(ctx, 'session.cash_movement', body.override, 'Cash in/out');
    return db.tx(() => {
      if (type !== 'paid_in') {
        const f = figures(s.id);
        if (amount > f.expected_cash) throw E.conflict('Amount exceeds the cash expected in the drawer');
      }
      const id = newId('csh');
      db.run(`INSERT INTO cash_movements (id,session_id,type,amount,reason,reference,user_id,authorized_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, s.id, type, amount, reason, reference, ctx.user.id, approver, nowIso());
      app.audit.log(ctx, `session.${type}`, { entityType: 'register_session', entityId: s.id, reference: s.number, newValue: { amount, reason, reference }, approvedBy: approver !== ctx.user.id ? approver : null });
      app.hardware.openDrawer(ctx, `cash ${type}`);
      return { id, figures: figures(s.id) };
    });
  }

  function close(ctx, id, body) {
    const s = db.get('SELECT * FROM register_sessions WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!s) throw E.notFound('Session');
    if (s.status !== 'open') throw E.conflict('Session is already closed');
    if (s.user_id === ctx.user.id) app.auth.require(ctx, 'session.open_close'); else app.auth.require(ctx, 'session.manage_all');
    const settings = app.settings.all(ctx.businessId);
    let counted = v.money(body, 'counted_cash');
    let detail = null;
    if (body && body.denominations && typeof body.denominations === 'object') {
      detail = {};
      let sum = 0;
      for (const [denom, count] of Object.entries(body.denominations)) {
        const d = Number(denom); const c = Number(count);
        if (!Number.isInteger(d) || d <= 0 || !Number.isInteger(c) || c < 0 || c > 100000) throw E.validation('Invalid denomination count');
        if (c) { detail[d] = c; sum += d * c; }
      }
      if (counted !== null && counted !== sum) throw E.validation('Counted cash does not match the denomination breakdown');
      counted = sum;
    }
    if (counted === null) throw E.validation('counted_cash: is required');
    const note = v.str(body, 'note', { max: 500 });
    return db.tx(() => {
      const pending = db.value(`SELECT COUNT(*) FROM payments WHERE session_id = ? AND status IN ('pending','processing')`, id);
      if (pending) throw E.conflict('There are electronic payments still processing on this session. Resolve them before closing.');
      const held = db.all(`SELECT s.number, (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS items FROM sales s WHERE s.session_id = ? AND s.status IN ('open','held')`, id);
      const nonEmpty = held.filter((h) => h.items > 0);
      if (nonEmpty.length) throw E.conflict(`Complete or cancel open/held sales first: ${nonEmpty.map((h) => h.number).join(', ')}`);
      // empty carts left behind are cancelled automatically — nothing financial happened on them
      for (const h of held) db.run(`UPDATE sales SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'Empty cart at session close', updated_at = ? WHERE number = ?`, nowIso(), nowIso(), h.number);
      const f = figures(id);
      const variance = counted - f.expected_cash;
      const review = Math.abs(variance) > settings['pos.variance_review_threshold'] ? 'required' : 'none';
      db.run(`UPDATE register_sessions SET status = 'closed', closed_at = ?, closed_by = ?, expected_cash = ?, counted_cash = ?, variance = ?, count_detail_json = ?,
        close_note = TRIM(COALESCE(close_note,'') || ' ' || COALESCE(?, '')), review_status = ? WHERE id = ?`,
      nowIso(), ctx.user.id, f.expected_cash, counted, variance, detail ? JSON.stringify(detail) : null, note ? `Close: ${note}` : null, review, id);
      app.audit.log(ctx, 'session.close', { entityType: 'register_session', entityId: id, reference: s.number, newValue: { expected_cash: f.expected_cash, counted_cash: counted, variance, review } });
      return get(ctx, id);
    });
  }

  function review(ctx, id, body) {
    app.auth.require(ctx, 'session.manage_all');
    const s = db.get('SELECT * FROM register_sessions WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!s) throw E.notFound('Session');
    if (s.status !== 'closed') throw E.conflict('Only closed sessions can be reviewed');
    if (s.user_id === ctx.user.id) throw E.forbidden('You cannot review your own session');
    const note = v.str(body, 'note', { required: true, max: 500 });
    db.tx(() => {
      db.run(`UPDATE register_sessions SET review_status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`, ctx.user.id, nowIso(), note, id);
      app.audit.log(ctx, 'session.review', { entityType: 'register_session', entityId: id, reference: s.number, newValue: { variance: s.variance, note } });
    });
    return get(ctx, id);
  }

  function get(ctx, id) {
    const s = db.get(`SELECT rs.*, u.full_name AS cashier_name, cb.full_name AS closed_by_name, rv.full_name AS reviewed_by_name,
        r.code AS register_code, r.name AS register_name, l.name AS location_name
      FROM register_sessions rs JOIN users u ON u.id = rs.user_id LEFT JOIN users cb ON cb.id = rs.closed_by LEFT JOIN users rv ON rv.id = rs.reviewed_by
      JOIN registers r ON r.id = rs.register_id JOIN locations l ON l.id = rs.location_id WHERE rs.id = ? AND rs.business_id = ?`, id, ctx.businessId);
    if (!s) throw E.notFound('Session');
    const own = s.user_id === ctx.user.id;
    if (!own && !app.auth.can(ctx, 'session.manage_all')) throw E.forbidden();
    const f = figures(id);
    // Blind close: a cashier doesn't see expected cash for their open session (reduces "counting to the number").
    const blind = s.status === 'open' && own && app.settings.get(ctx.businessId, 'pos.blind_close') && !app.auth.can(ctx, 'session.manage_all');
    if (blind) { f.expected_cash = null; f.blind = true; }
    s.figures = f;
    s.cash_movements = db.all(`SELECT cm.*, u.full_name AS user_name, a.full_name AS authorized_by_name FROM cash_movements cm JOIN users u ON u.id = cm.user_id
      LEFT JOIN users a ON a.id = cm.authorized_by WHERE session_id = ? ORDER BY created_at`, id);
    s.count_detail = s.count_detail_json ? JSON.parse(s.count_detail_json) : null;
    return s;
  }

  function list(ctx, { status, userId, from, to, limit = 100 }) {
    const where = ['rs.business_id = ?']; const p = [ctx.businessId];
    if (!app.auth.can(ctx, 'session.manage_all')) { where.push('rs.user_id = ?'); p.push(ctx.user.id); } else if (userId) { where.push('rs.user_id = ?'); p.push(userId); }
    if (status === 'review') where.push("rs.review_status = 'required'"); else if (status) { where.push('rs.status = ?'); p.push(status); }
    if (from) { where.push('rs.opened_at >= ?'); p.push(from); }
    if (to) { where.push('rs.opened_at < ?'); p.push(to); }
    return db.all(`SELECT rs.id, rs.number, rs.status, rs.opened_at, rs.closed_at, rs.opening_float, rs.expected_cash, rs.counted_cash, rs.variance, rs.review_status,
        u.full_name AS cashier_name, r.name AS register_name, l.name AS location_name,
        (SELECT COUNT(*) FROM sales s WHERE s.session_id = rs.id AND s.status = 'completed') AS sales_count,
        (SELECT COALESCE(SUM(total),0) FROM sales s WHERE s.session_id = rs.id AND s.status = 'completed') AS sales_total
      FROM register_sessions rs JOIN users u ON u.id = rs.user_id JOIN registers r ON r.id = rs.register_id JOIN locations l ON l.id = rs.location_id
      WHERE ${where.join(' AND ')} ORDER BY rs.opened_at DESC LIMIT ?`, ...p, Math.min(limit, 500));
  }

  return { current, requireSellingSession, figures, open, cashMovement, close, review, get, list };
};
