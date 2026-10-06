'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');
const { localMidnightUtc, addDays, localDate } = require('../lib/time');
const { REGISTRY } = require('./payments/providers');

/**
 * Daily reconciliation. Compares independent records for one business date and flags differences:
 *   expected sales ↔ recorded payments ↔ provider settlements ↔ money received in bank
 *   cash sessions: expected ↔ counted;  cash drops ↔ bank deposits;  refunds ↔ refund payouts
 * A run is a snapshot: its figures are immutable (DB trigger). Re-running creates a new run and
 * marks the old one superseded. Resolving an item records who/why — it never alters financial data.
 */
function statusFor(expected, actual, { pendingIfShort = false } = {}) {
  if (expected === actual) return 'matched';
  if (pendingIfShort && actual === 0) return 'pending';
  if (pendingIfShort && actual > 0 && actual < expected) return 'partially_matched';
  return 'discrepancy';
}

module.exports = function reconciliationService(app) {
  const { db } = app;

  function run(ctx, body) {
    app.auth.require(ctx, 'reconciliation.manage');
    const date = v.str(body, 'business_date', { required: true, pattern: /^\d{4}-\d{2}-\d{2}$/ });
    const tz = db.value('SELECT timezone FROM businesses WHERE id = ?', ctx.businessId);
    const from = localMidnightUtc(date, tz).toISOString();
    const to = localMidnightUtc(addDays(date, 1), tz).toISOString();
    const isPastDay = date < localDate(new Date(), tz);
    const B = ctx.businessId;
    const items = [];
    const add = (category, label, expected, actual, opts = {}) => items.push({
      category, label, expected, actual, difference: actual - expected, status: opts.status || statusFor(expected, actual, opts), detail: opts.detail || null,
      reference_type: opts.refType || null, reference_id: opts.refId || null,
    });

    // 1. Sales ↔ payments
    const sales = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM sales WHERE business_id = ? AND completed_at >= ? AND completed_at < ? AND status IN ('completed','voided')`, B, from, to);
    const paid = db.value(`SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.business_id = ? AND s.completed_at >= ? AND s.completed_at < ? AND s.status IN ('completed','voided') AND p.status = 'succeeded'`, B, from, to);
    add('sales', `Sales (${sales.n}) vs recorded payments`, sales.total, paid);
    const stuck = db.value(`SELECT COUNT(*) FROM payments WHERE business_id = ? AND created_at >= ? AND created_at < ? AND status IN ('pending','processing')`, B, from, to);
    if (stuck) add('payments', `${stuck} electronic payment(s) still awaiting provider confirmation`, 0, 0, { status: 'pending', detail: 'Payments → filter "In flight" to re-check status' });

    // 2. Refunds ↔ money returned
    const refunds = db.all(`SELECT r.id, r.number, r.total, r.status, (SELECT COALESCE(SUM(amount),0) FROM refund_payments rp WHERE rp.refund_id = r.id AND rp.status = 'succeeded') AS paid_back
      FROM refunds r WHERE r.business_id = ? AND r.created_at >= ? AND r.created_at < ?`, B, from, to);
    const rTotal = refunds.reduce((a, r) => a + r.total, 0); const rPaid = refunds.reduce((a, r) => a + r.paid_back, 0);
    const openRefunds = refunds.filter((r) => r.paid_back !== r.total);
    add('refunds', `Refunds & voids (${refunds.length}) vs money returned`, rTotal, rPaid, { detail: openRefunds.length ? `Not fully paid back: ${openRefunds.map((r) => r.number).join(', ')}` : null, pendingIfShort: !isPastDay });

    // 3. Cash sessions
    const sessions = db.all(`SELECT rs.*, u.full_name FROM register_sessions rs JOIN users u ON u.id = rs.user_id WHERE rs.business_id = ? AND rs.opened_at >= ? AND rs.opened_at < ?`, B, from, to);
    for (const s of sessions) {
      if (s.status === 'open') { add('cash', `Session ${s.number} (${s.full_name}) still open`, 0, 0, { status: 'pending', refType: 'register_session', refId: s.id }); continue; }
      const st = s.variance === 0 ? 'matched' : (s.review_status === 'approved' ? 'resolved' : 'discrepancy');
      add('cash', `Session ${s.number} (${s.full_name}) expected vs counted cash`, s.expected_cash, s.counted_cash, { status: st, refType: 'register_session', refId: s.id, detail: s.review_note ? `Reviewed: ${s.review_note}` : null });
    }

    // 4. Electronic providers: payments ↔ settlement lines
    const providers = db.all(`SELECT DISTINCT provider_code FROM payments WHERE business_id = ? AND confirmed_at >= ? AND confirmed_at < ? AND status IN ('succeeded','voided') AND provider_code <> 'cash'`, B, from, to).map((r) => r.provider_code);
    for (const pc of providers) {
      const reg = REGISTRY[pc];
      const rows = db.all(`SELECT p.id, p.amount, p.status,
          (SELECT COALESCE(SUM(si.amount),0) FROM settlement_items si WHERE si.payment_id = p.id AND si.type = 'payment') AS settled,
          (SELECT COALESCE(SUM(rp.amount),0) FROM refund_payments rp JOIN refunds r ON r.id = rp.refund_id WHERE rp.original_payment_id = p.id AND r.kind = 'void' AND rp.status = 'succeeded') AS reversed
        FROM payments p WHERE p.business_id = ? AND p.provider_code = ? AND p.confirmed_at >= ? AND p.confirmed_at < ? AND p.status IN ('succeeded','voided')`, B, pc, from, to);
      // voided-before-completion and same-day voids are reversed at the provider and never settle
      const expected = rows.reduce((a, r) => a + (r.status === 'voided' ? 0 : r.amount - r.reversed), 0);
      const settled = rows.reduce((a, r) => a + r.settled, 0);
      const unsettled = rows.filter((r) => r.status === 'succeeded' && r.amount - r.reversed > 0 && r.settled === 0).length;
      const label = reg && reg.kind === 'local' ? `${pc}: externally-confirmed payments vs imported settlement` : `${pc}: payments vs provider settlement`;
      add('settlement', label, expected, settled, { pendingIfShort: true, detail: unsettled ? `${unsettled} payment(s) not yet in any settlement` : null });
    }
    // unknown references on settlements dated this day
    const unknown = db.all(`SELECT si.provider_ref, si.amount, s.provider_code, s.provider_settlement_ref, s.id FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id
      WHERE s.business_id = ? AND s.settlement_date = ? AND si.match_status IN ('unknown_reference','amount_mismatch')`, B, date);
    for (const u of unknown) add('settlement', `${u.provider_settlement_ref}: line ${u.provider_ref} does not match our records`, 0, u.amount, { status: 'discrepancy', refType: 'settlement', refId: u.id });

    // 5. Settlements ↔ money received in bank (provider payouts)
    const stls = db.all(`SELECT s.*, (SELECT COALESCE(SUM(amount),0) FROM payouts p WHERE p.settlement_id = s.id AND p.status = 'paid') AS received FROM settlements s WHERE s.business_id = ? AND s.settlement_date = ?`, B, date);
    for (const s of stls) add('payout', `${s.provider_settlement_ref} net vs received in bank`, s.net_amount, s.received, { pendingIfShort: true, refType: 'settlement', refId: s.id });

    // 6. Cash drops ↔ bank deposits
    const drops = db.value(`SELECT COALESCE(SUM(cm.amount),0) FROM cash_movements cm JOIN register_sessions rs ON rs.id = cm.session_id WHERE rs.business_id = ? AND cm.type = 'cash_drop' AND cm.created_at >= ? AND cm.created_at < ?`, B, from, to);
    const deposits = db.value(`SELECT COALESCE(SUM(amount),0) FROM payouts WHERE business_id = ? AND type = 'bank_deposit' AND status = 'paid' AND (
        session_id IN (SELECT id FROM register_sessions WHERE business_id = ? AND opened_at >= ? AND opened_at < ?) OR (session_id IS NULL AND created_at >= ? AND created_at < ?))`, B, B, from, to, from, to);
    if (drops || deposits) add('cash', 'Cash drops to safe vs bank deposits', drops, deposits, { pendingIfShort: true });

    // 7. Other payouts made that day (informational — must be approved)
    const unapproved = db.value(`SELECT COUNT(*) FROM payouts WHERE business_id = ? AND created_at >= ? AND created_at < ? AND status = 'pending_approval'`, B, from, to);
    if (unapproved) add('payout', `${unapproved} payout request(s) awaiting approval`, 0, 0, { status: 'pending' });

    const statuses = items.map((i) => i.status);
    const runStatus = statuses.includes('discrepancy') ? 'discrepancy' : statuses.includes('partially_matched') ? 'partially_matched' : statuses.includes('pending') ? 'pending' : 'matched';
    const summary = { sales_total: sales.total, payments_total: paid, refunds_total: rTotal, items: items.length, discrepancies: statuses.filter((s) => s === 'discrepancy').length };

    return db.tx(() => {
      const id = newId('rcn');
      db.run(`INSERT INTO reconciliation_runs (id,business_id,business_date,status,summary_json,created_by,created_at) VALUES (?,?,?,?,?,?,?)`, id, B, date, runStatus, JSON.stringify(summary), ctx.user.id, nowIso());
      db.run(`UPDATE reconciliation_runs SET superseded_by = ? WHERE business_id = ? AND business_date = ? AND id <> ? AND superseded_by IS NULL`, id, B, date, id);
      for (const it of items) {
        db.run(`INSERT INTO reconciliation_items (id,run_id,category,label,reference_type,reference_id,expected,actual,difference,status,detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          newId('rci'), id, it.category, it.label, it.reference_type, it.reference_id, it.expected, it.actual, it.difference, it.status, it.detail);
      }
      app.audit.log(ctx, 'reconciliation.run', { entityType: 'reconciliation_run', entityId: id, reference: date, newValue: { status: runStatus, ...summary } });
      return get(ctx, id);
    });
  }

  function get(ctx, id) {
    app.auth.require(ctx, 'reconciliation.manage');
    const r = db.get(`SELECT rr.*, u.full_name AS created_by_name FROM reconciliation_runs rr JOIN users u ON u.id = rr.created_by WHERE rr.id = ? AND rr.business_id = ?`, id, ctx.businessId);
    if (!r) throw E.notFound('Reconciliation run');
    r.summary = JSON.parse(r.summary_json || '{}');
    r.items = db.all(`SELECT ri.*, u.full_name AS resolved_by_name FROM reconciliation_items ri LEFT JOIN users u ON u.id = ri.resolved_by WHERE run_id = ?
      ORDER BY CASE status WHEN 'discrepancy' THEN 0 WHEN 'partially_matched' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, category`, id);
    return r;
  }

  function list(ctx, { limit = 60 }) {
    app.auth.require(ctx, 'reconciliation.manage');
    return db.all(`SELECT rr.id, rr.business_date, rr.status, rr.summary_json, rr.created_at, u.full_name AS created_by_name FROM reconciliation_runs rr JOIN users u ON u.id = rr.created_by
      WHERE rr.business_id = ? AND rr.superseded_by IS NULL ORDER BY rr.business_date DESC LIMIT ?`, ctx.businessId, limit).map((r) => ({ ...r, summary: JSON.parse(r.summary_json || '{}') }));
  }

  function resolveItem(ctx, itemId, body) {
    app.auth.require(ctx, 'reconciliation.manage');
    const it = db.get(`SELECT ri.*, rr.business_id, rr.business_date, rr.superseded_by FROM reconciliation_items ri JOIN reconciliation_runs rr ON rr.id = ri.run_id WHERE ri.id = ?`, itemId);
    if (!it || it.business_id !== ctx.businessId) throw E.notFound('Reconciliation item');
    if (it.superseded_by) throw E.conflict('This run was superseded by a newer run');
    if (['matched', 'resolved'].includes(it.status)) throw E.conflict(`Item is already ${it.status}`);
    const note = v.str(body, 'note', { required: true, min: 5, max: 500 });
    return db.tx(() => {
      db.run(`UPDATE reconciliation_items SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?`, ctx.user.id, nowIso(), note, itemId);
      const open = db.value(`SELECT COUNT(*) FROM reconciliation_items WHERE run_id = ? AND status NOT IN ('matched','resolved')`, it.run_id);
      if (!open) db.run(`UPDATE reconciliation_runs SET status = 'resolved' WHERE id = ?`, it.run_id);
      app.audit.log(ctx, 'reconciliation.resolve', { entityType: 'reconciliation_item', entityId: itemId, reference: it.business_date, oldValue: { status: it.status, difference: it.difference }, newValue: { status: 'resolved', note } });
      return get(ctx, it.run_id);
    });
  }

  return { run, get, list, resolveItem };
};
