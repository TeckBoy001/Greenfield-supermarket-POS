'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');

/**
 * Payouts: money moving out of the business, or between business accounts — distinct from customer
 * payments (payments), customer refunds (refunds) and till cash movements (cash_movements).
 *
 *   provider_payout  – a provider settlement landing in the business bank account (inbound, recorded on confirmation)
 *   bank_deposit     – cash from the safe/tills banked
 *   cash_withdrawal, supplier_payment, refund_payout, owner_drawing, other – outbound; need approval
 *
 * Outbound payouts follow request → approve (different person; also enforced by a DB CHECK) → paid.
 * Executing the bank transfer itself is outside this system unless a bank adapter is added;
 * "paid" records the bank reference once it has happened.
 */
const TYPES = ['provider_payout', 'bank_deposit', 'cash_withdrawal', 'supplier_payment', 'refund_payout', 'owner_drawing', 'other'];

module.exports = function payoutService(app) {
  const { db } = app;

  function get(ctx, id) {
    const p = db.get(`SELECT po.*, rq.full_name AS requested_by_name, ap.full_name AS approved_by_name, pb.full_name AS paid_by_name, rj.full_name AS rejected_by_name,
        sa.name AS source_name, da.name AS destination_name, st.provider_settlement_ref, rs.number AS session_number
      FROM payouts po JOIN users rq ON rq.id = po.requested_by LEFT JOIN users ap ON ap.id = po.approved_by LEFT JOIN users pb ON pb.id = po.paid_by LEFT JOIN users rj ON rj.id = po.rejected_by
      LEFT JOIN financial_accounts sa ON sa.id = po.source_account_id LEFT JOIN financial_accounts da ON da.id = po.destination_account_id
      LEFT JOIN settlements st ON st.id = po.settlement_id LEFT JOIN register_sessions rs ON rs.id = po.session_id WHERE po.id = ? AND po.business_id = ?`, id, ctx.businessId);
    if (!p) throw E.notFound('Payout');
    return p;
  }

  function account(ctx, id) {
    if (!id) return null;
    const a = db.get('SELECT * FROM financial_accounts WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!a) throw E.validation('Unknown account');
    return a;
  }

  function request(ctx, body) {
    app.auth.require(ctx, 'payout.request');
    const type = v.oneOf(body, 'type', TYPES, { required: true });
    const amount = v.money(body, 'amount', { required: true, min: 1 });
    const reason = v.str(body, 'reason', { required: true, max: 300 });
    const reference = v.str(body, 'reference', { max: 80 });
    const src = account(ctx, v.str(body, 'source_account_id', { max: 64 }));
    const dst = account(ctx, v.str(body, 'destination_account_id', { max: 64 }));
    const destNote = v.str(body, 'destination_note', { max: 200 });
    const settlementId = v.str(body, 'settlement_id', { max: 64 });
    const sessionId = v.str(body, 'session_id', { max: 64 });
    if (!dst && !destNote) throw E.validation('Choose a destination account or describe the payee');
    if (settlementId) {
      const s = db.get('SELECT * FROM settlements WHERE id = ? AND business_id = ?', settlementId, ctx.businessId);
      if (!s) throw E.validation('Unknown settlement');
      const already = db.value(`SELECT COALESCE(SUM(amount),0) FROM payouts WHERE settlement_id = ? AND status IN ('pending_approval','approved','paid')`, settlementId);
      if (already + amount > s.net_amount) throw E.conflict('Payout exceeds the settlement net amount');
    }
    if (sessionId && !db.get('SELECT 1 FROM register_sessions WHERE id = ? AND business_id = ?', sessionId, ctx.businessId)) throw E.validation('Unknown session');
    const b = db.get('SELECT currency FROM businesses WHERE id = ?', ctx.businessId);
    return db.tx(() => {
      const id = newId('pyo');
      const number = app.numbering.next(ctx.businessId, 'payout', 'PO-');
      db.run(`INSERT INTO payouts (id,business_id,number,type,amount,currency,source_account_id,destination_account_id,destination_note,settlement_id,session_id,status,reason,reference,requested_by,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, ctx.businessId, number, type, amount, b.currency, src ? src.id : null, dst ? dst.id : null, destNote,
      settlementId, sessionId, 'pending_approval', reason, reference, ctx.user.id, nowIso());
      app.audit.log(ctx, 'payout.request', { entityType: 'payout', entityId: id, reference: number, newValue: { type, amount, reason, settlement_id: settlementId } });
      return get(ctx, id);
    });
  }

  /** Inbound provider funds confirmed on the bank statement — recorded as paid provider_payout. */
  function confirmSettlementReceived(ctx, settlementId, body) {
    app.auth.require(ctx, 'settlement.manage');
    const s = db.get('SELECT * FROM settlements WHERE id = ? AND business_id = ?', settlementId, ctx.businessId);
    if (!s) throw E.notFound('Settlement');
    const amount = v.money(body, 'amount') ?? s.net_amount;
    const reference = v.str(body, 'bank_reference', { required: true, max: 80 });
    return db.tx(() => {
      const already = db.value(`SELECT COALESCE(SUM(amount),0) FROM payouts WHERE settlement_id = ? AND status = 'paid'`, settlementId);
      if (already + amount > s.net_amount) throw E.conflict('Received amount exceeds settlement net — record the difference as a discrepancy note instead');
      const src = db.get(`SELECT id FROM financial_accounts WHERE business_id = ? AND type = 'provider_balance' AND provider_code = ?`, ctx.businessId, s.provider_code);
      const id = newId('pyo');
      const number = app.numbering.next(ctx.businessId, 'payout', 'PO-');
      const now = nowIso();
      db.run(`INSERT INTO payouts (id,business_id,number,type,amount,currency,source_account_id,destination_account_id,settlement_id,status,reason,reference,requested_by,paid_by,created_at,paid_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, ctx.businessId, number, 'provider_payout', amount, s.currency, src ? src.id : null, s.destination_account_id, settlementId,
      'paid', `Settlement ${s.provider_settlement_ref} received`, reference, ctx.user.id, ctx.user.id, now, now);
      app.audit.log(ctx, 'payout.provider_received', { entityType: 'payout', entityId: id, reference: number, newValue: { settlement: s.provider_settlement_ref, amount, bank_reference: reference } });
      return get(ctx, id);
    });
  }

  function transition(ctx, id, action, body) {
    const p = db.get('SELECT * FROM payouts WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!p) throw E.notFound('Payout');
    return db.tx(() => {
      const now = nowIso();
      if (action === 'approve') {
        app.auth.require(ctx, 'payout.approve');
        if (p.status !== 'pending_approval') throw E.conflict(`Payout is ${p.status}`);
        if (p.requested_by === ctx.user.id) throw E.forbidden('Segregation of duties: you cannot approve a payout you requested');
        db.run(`UPDATE payouts SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`, ctx.user.id, now, id);
      } else if (action === 'reject') {
        app.auth.require(ctx, 'payout.approve');
        if (p.status !== 'pending_approval') throw E.conflict(`Payout is ${p.status}`);
        const reason = v.str(body, 'reason', { required: true, max: 300 });
        db.run(`UPDATE payouts SET status = 'rejected', rejected_by = ?, rejection_reason = ? WHERE id = ?`, ctx.user.id, reason, id);
      } else if (action === 'mark_paid') {
        app.auth.require(ctx, 'payout.request');
        if (p.status !== 'approved') throw E.conflict('Only approved payouts can be marked paid');
        const reference = v.str(body, 'reference', { required: true, max: 80 });
        db.run(`UPDATE payouts SET status = 'paid', paid_by = ?, paid_at = ?, reference = ? WHERE id = ?`, ctx.user.id, now, reference, id);
      } else if (action === 'cancel') {
        if (p.requested_by !== ctx.user.id) app.auth.require(ctx, 'payout.approve'); else app.auth.require(ctx, 'payout.request');
        if (!['pending_approval', 'approved'].includes(p.status)) throw E.conflict(`Payout is ${p.status}`);
        db.run(`UPDATE payouts SET status = 'cancelled' WHERE id = ?`, id);
      } else throw E.validation('Unknown action');
      app.audit.log(ctx, `payout.${action}`, { entityType: 'payout', entityId: id, reference: p.number, oldValue: { status: p.status }, newValue: { status: db.value('SELECT status FROM payouts WHERE id = ?', id), ...(body || {}) } });
      return get(ctx, id);
    });
  }

  function list(ctx, { status, type, from, to, limit = 200 }) {
    if (!app.auth.can(ctx, 'payout.request') && !app.auth.can(ctx, 'payout.approve')) throw E.forbidden();
    const where = ['po.business_id = ?']; const p = [ctx.businessId];
    if (status) { where.push('po.status = ?'); p.push(status); }
    if (type) { where.push('po.type = ?'); p.push(type); }
    if (from) { where.push('po.created_at >= ?'); p.push(from); }
    if (to) { where.push('po.created_at < ?'); p.push(to); }
    return db.all(`SELECT po.*, rq.full_name AS requested_by_name, ap.full_name AS approved_by_name, da.name AS destination_name, sa.name AS source_name, st.provider_settlement_ref
      FROM payouts po JOIN users rq ON rq.id = po.requested_by LEFT JOIN users ap ON ap.id = po.approved_by
      LEFT JOIN financial_accounts da ON da.id = po.destination_account_id LEFT JOIN financial_accounts sa ON sa.id = po.source_account_id LEFT JOIN settlements st ON st.id = po.settlement_id
      WHERE ${where.join(' AND ')} ORDER BY po.created_at DESC LIMIT ?`, ...p, limit);
  }

  function accounts(ctx) { return db.all('SELECT * FROM financial_accounts WHERE business_id = ? ORDER BY type, name', ctx.businessId); }

  function saveAccount(ctx, id, body) {
    app.auth.require(ctx, 'settings.manage');
    const d = {
      code: v.str(body, 'code', { required: true, max: 30, pattern: /^[A-Z0-9_-]+$/ }), name: v.str(body, 'name', { required: true, max: 80 }),
      type: v.oneOf(body, 'type', ['cash_safe', 'bank', 'provider_balance', 'other'], { required: true }), provider_code: v.str(body, 'provider_code', { max: 40 }),
      bank_name: v.str(body, 'bank_name', { max: 80 }), account_mask: v.str(body, 'account_mask', { max: 4, pattern: /^\d{4}$/, label: 'Last 4 digits' }),
      is_active: v.bool(body, 'is_active', true) ? 1 : 0,
    };
    const cur = db.value('SELECT currency FROM businesses WHERE id = ?', ctx.businessId);
    return db.tx(() => {
      if (id) {
        if (!db.get('SELECT 1 FROM financial_accounts WHERE id = ? AND business_id = ?', id, ctx.businessId)) throw E.notFound('Account');
        db.run('UPDATE financial_accounts SET code=?, name=?, type=?, provider_code=?, bank_name=?, account_mask=?, is_active=? WHERE id=?', d.code, d.name, d.type, d.provider_code, d.bank_name, d.account_mask, d.is_active, id);
      } else {
        id = newId('fac');
        db.run('INSERT INTO financial_accounts (id,business_id,code,name,type,provider_code,bank_name,account_mask,currency,is_active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          id, ctx.businessId, d.code, d.name, d.type, d.provider_code, d.bank_name, d.account_mask, cur, d.is_active, nowIso());
      }
      app.audit.log(ctx, 'account.save', { entityType: 'financial_account', entityId: id, newValue: d });
      return id;
    });
  }

  return { request, confirmSettlementReceived, transition, list, get, accounts, saveAccount, TYPES };
};
