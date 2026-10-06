'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');
const { roundQty } = require('../lib/money');
const { ProviderNetworkError } = require('./payments/providers/base');
const { REGISTRY, buildProvider } = require('./payments/providers');

/**
 * Refunds, returns and voids. Completed sales are never edited or deleted: every correction is a
 * new refund record that references the original sale lines and payments, carries a reason and
 * the authorizing supervisor, returns stock through inventory movements, and pays money back
 * through refund_payments (each processed by the original payment's adapter, or cash).
 */
const REASONS = ['customer_return', 'damaged', 'wrong_item', 'price_error', 'duplicate_charge', 'customer_dissatisfied', 'cashier_error', 'other'];

module.exports = function refundService(app) {
  const { db } = app;
  const busy = new Set();

  function refundedByPayment(paymentId) {
    return db.value(`SELECT COALESCE(SUM(amount),0) FROM refund_payments WHERE original_payment_id = ? AND status <> 'failed'`, paymentId) || 0;
  }

  /** Allocate `total` to the sale's payments, most recent tender first. Returns [{payment, amount}]. */
  function allocateToPayments(saleId, total) {
    const pays = db.all(`SELECT * FROM payments WHERE sale_id = ? AND status = 'succeeded' ORDER BY created_at DESC`, saleId);
    const out = [];
    let left = total;
    for (const p of pays) {
      if (left <= 0) break;
      const avail = p.amount - refundedByPayment(p.id);
      if (avail <= 0) continue;
      const amt = Math.min(avail, left);
      out.push({ payment: p, amount: amt });
      left -= amt;
    }
    if (left > 0) throw E.conflict('Refund exceeds the refundable amount remaining on the original payments');
    return out;
  }

  function lineAmounts(item, qty) {
    const already = db.get(`SELECT COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(tax_amount),0) AS tax FROM refund_items WHERE sale_item_id = ?`, item.id);
    const remainingQty = roundQty(item.qty - already.qty);
    if (qty > remainingQty + 1e-9) throw E.validation(`Only ${remainingQty} of “${item.name}” can still be returned`);
    if (Math.abs(qty - remainingQty) < 1e-9) {
      return { amount: item.line_total - already.amount, tax: item.tax_amount - already.tax }; // exact remainder: no rounding drift
    }
    return { amount: Math.round((item.line_total * qty) / item.qty), tax: Math.round((item.tax_amount * qty) / item.qty) };
  }

  async function create(ctx, saleId, body, { kind = 'refund' } = {}) {
    const key = v.str(body, 'idempotency_key', { required: true, min: 8, max: 80 });
    const dup = db.get('SELECT id FROM refunds WHERE idempotency_key = ?', key);
    if (dup) return get(ctx, dup.id);

    const sale = app.sales.loadSale(ctx, saleId);
    if (sale.status !== 'completed') throw E.conflict(`Only completed sales can be ${kind === 'void' ? 'voided' : 'refunded'} (this one is ${sale.status})`);
    const reasonCode = kind === 'void' ? v.oneOf(body, 'reason_code', REASONS, { def: 'cashier_error' }) : v.oneOf(body, 'reason_code', REASONS, { required: true });
    const reasonNote = v.str(body, 'reason_note', { max: 500 });
    if ((reasonCode === 'other' || kind === 'void') && !reasonNote) throw E.validation('reason_note: please describe the reason');
    const refundMethod = v.oneOf(body, 'refund_method', ['original', 'cash'], { def: 'original' });
    const manualRef = v.str(body, 'manual_reference', { max: 80 });
    const settings = app.settings.all(ctx.businessId);

    let approver;
    if (kind === 'void') {
      approver = app.auth.authorize(ctx, 'sale.void', body.override, `Void ${sale.number}`);
      const session = app.sessions.current(ctx);
      if (!session || session.id !== sale.session_id) throw E.conflict('A sale can only be voided in the same open register session it was rung up in. Use a refund instead.');
      if (db.value('SELECT COUNT(*) FROM refunds WHERE sale_id = ?', saleId)) throw E.conflict('This sale already has refunds — it cannot be voided');
    } else {
      app.auth.require(ctx, 'refund.create');
      approver = app.auth.authorize(ctx, 'refund.approve', body.override, `Refund on ${sale.number}`);
      const ageDays = (Date.now() - new Date(sale.completed_at)) / 86400000;
      if (ageDays > settings['refund.max_days'] && !v.bool(body, 'allow_late', false)) {
        throw E.conflict(`Sale is ${Math.floor(ageDays)} days old; the return window is ${settings['refund.max_days']} days. A manager can confirm a late return.`, { code: 'late_return' });
      }
    }
    if (refundMethod === 'cash' && kind === 'refund') app.auth.authorize(ctx, 'refund.approve', body.override, 'Refund to cash instead of original method');

    // Which lines and quantities
    const items = db.all('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY line_no', saleId);
    let req;
    if (kind === 'void' || v.bool(body, 'full', false)) {
      req = items.map((it) => ({ item: it, qty: roundQty(it.qty - (db.value('SELECT COALESCE(SUM(qty),0) FROM refund_items WHERE sale_item_id = ?', it.id) || 0)), condition: kind === 'void' ? 'resaleable' : (body.condition || 'resaleable') })).filter((r) => r.qty > 0);
    } else {
      req = v.arr(body, 'items', { required: true }).map((x, i) => {
        const it = items.find((s) => s.id === x.sale_item_id);
        if (!it) throw E.validation(`items[${i}]: not a line of this sale`);
        return { item: it, qty: roundQty(v.num(x, 'qty', { required: true, min: 0.001, label: `items[${i}].qty` })), condition: v.oneOf(x, 'condition', ['resaleable', 'damaged', 'not_returned'], { def: 'resaleable' }) };
      });
    }
    if (!req.length) throw E.conflict('Nothing left to refund on this sale');
    req.forEach((r) => { if (!['resaleable', 'damaged', 'not_returned'].includes(r.condition)) throw E.validation('Invalid item condition'); });

    const refundId = newId('ref');
    const rpList = [];
    db.tx(() => {
      const lines = req.map((r) => ({ ...r, ...lineAmounts(r.item, r.qty) }));
      const total = lines.reduce((a, l) => a + l.amount, 0);
      const tax = lines.reduce((a, l) => a + l.tax, 0);
      // money allocation
      let alloc;
      if (refundMethod === 'cash') {
        alloc = [{ payment: null, amount: total }];
        // cap: cannot refund more than was paid in total minus prior refunds
        const paid = db.value(`SELECT COALESCE(SUM(amount),0) FROM payments WHERE sale_id = ? AND status = 'succeeded'`, saleId);
        const prior = db.value(`SELECT COALESCE(SUM(rp.amount),0) FROM refund_payments rp JOIN refunds r ON r.id = rp.refund_id WHERE r.sale_id = ? AND rp.status <> 'failed'`, saleId);
        if (total > paid - prior) throw E.conflict('Refund exceeds amount paid');
      } else {
        alloc = total > 0 ? allocateToPayments(saleId, total) : [];
      }
      const needsCash = alloc.some((a) => !a.payment || a.payment.method_type === 'cash');
      const session = app.sessions.current(ctx);
      if (needsCash && (!session || session.status !== 'open')) throw E.conflict('Cash refunds need an open register session on this terminal (the cash comes out of this drawer)');
      if (needsCash && session.user_id !== ctx.user.id && !app.auth.can(ctx, 'session.manage_all')) throw E.conflict('The open register session belongs to another cashier');
      const online = app.connectivity.isOnline(ctx.businessId);
      for (const a of alloc) {
        if (a.payment && a.payment.method_type !== 'cash') {
          const reg = REGISTRY[a.payment.provider_code];
          if (reg && reg.kind !== 'local' && !online) throw E.offline(`Cannot refund ${a.payment.method_code} while offline. Refund to cash (supervisor) or try again when back online.`);
          if (a.payment.provider_code === 'manual' && !manualRef) throw E.validation(`manual_reference: enter the refund/reversal reference from the external terminal for ${a.payment.method_code}`);
        }
      }
      const number = app.numbering.next(ctx.businessId, kind === 'void' ? 'void' : 'refund', kind === 'void' ? 'VD-' : 'RF-');
      const now = nowIso();
      db.run(`INSERT INTO refunds (id,business_id,number,sale_id,kind,status,reason_code,reason_note,subtotal,tax_total,total,location_id,register_id,session_id,requested_by,authorized_by,idempotency_key,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, refundId, ctx.businessId, number, saleId, kind, 'pending', reasonCode, reasonNote, total - tax, tax, total,
      sale.location_id, ctx.registerId, session ? session.id : null, ctx.user.id, approver, key, now);
      for (const l of lines) {
        db.run('INSERT INTO refund_items (id,refund_id,sale_item_id,product_id,qty,amount,tax_amount,condition) VALUES (?,?,?,?,?,?,?,?)',
          newId('rfi'), refundId, l.item.id, l.item.product_id, l.qty, l.amount, l.tax, l.condition);
        if (l.condition !== 'not_returned') {
          const type = kind === 'void' ? 'void_reversal' : 'return';
          app.inventory.move(ctx, { productId: l.item.product_id, locationId: sale.location_id, type, qty: l.qty, unitCost: l.item.unit_cost, referenceType: 'refund', referenceId: refundId, reason: `${number} (${sale.number})` });
          if (l.condition === 'damaged') {
            app.inventory.move(ctx, { productId: l.item.product_id, locationId: sale.location_id, type: 'damage', qty: -l.qty, unitCost: l.item.unit_cost, referenceType: 'refund', referenceId: refundId, reason: `Returned damaged — ${number}` });
          }
        }
      }
      for (const a of alloc) {
        const p = a.payment;
        const methodCode = p ? p.method_code : (db.value(`SELECT code FROM payment_methods WHERE business_id = ? AND type = 'cash' AND is_active = 1 ORDER BY sort_order LIMIT 1`, ctx.businessId) || 'cash');
        const rpId = newId('rfp');
        const isCash = !p || p.method_type === 'cash';
        db.run(`INSERT INTO refund_payments (id,refund_id,original_payment_id,session_id,method_code,method_type,provider_code,amount,status,reference,idempotency_key,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, rpId, refundId, p ? p.id : null, isCash ? session.id : (session ? session.id : null), methodCode,
        p ? p.method_type : 'cash', p ? p.provider_code : 'cash', a.amount, 'pending', p && p.provider_code === 'manual' ? manualRef : null, `${key}:${rpId}`, now);
        rpList.push(rpId);
      }
      if (kind === 'void') {
        db.run(`UPDATE sales SET status = 'voided', voided_at = ?, voided_by = ?, void_reason = ?, updated_at = ? WHERE id = ?`, now, approver, reasonNote, now, saleId);
      }
      app.audit.log(ctx, kind === 'void' ? 'sale.void' : 'refund.create', {
        entityType: 'refund', entityId: refundId, reference: `${number} / ${sale.number}`, approvedBy: approver !== ctx.user.id ? approver : approver,
        newValue: { total, items: lines.map((l) => ({ sku: l.item.sku, qty: l.qty, amount: l.amount, condition: l.condition })), method: refundMethod, reason: reasonCode, note: reasonNote },
      });
      if (total === 0) db.run(`UPDATE refunds SET status = 'completed', completed_at = ? WHERE id = ?`, now, refundId);
    });

    for (const rpId of rpList) await processRefundPayment(ctx, rpId, kind);
    return get(ctx, refundId);
  }

  async function processRefundPayment(ctx, rpId, kind) {
    const rp = db.get('SELECT * FROM refund_payments WHERE id = ?', rpId);
    if (!rp || rp.status !== 'pending' || busy.has(rpId)) return;
    const refund = db.get('SELECT * FROM refunds WHERE id = ?', rp.refund_id);
    const provider = buildProvider(app, refund.business_id, rp.provider_code);
    busy.add(rpId);
    try {
      if (provider.confirmsLocally) {
        applyRefundPaymentResult(rpId, { status: 'succeeded', source: rp.provider_code === 'manual' ? 'manual' : 'local' }, ctx);
        if (rp.method_type === 'cash') app.hardware.openDrawer(ctx, 'cash refund');
        return;
      }
      const orig = db.get('SELECT * FROM payments WHERE id = ?', rp.original_payment_id);
      let r;
      if (kind === 'void') {
        r = await provider.voidPayment({ providerRef: orig.provider_ref });
        if (r.status === 'voided') r = { ...r, status: 'succeeded' };
        else if (r.failureReason && r.failureReason.includes('settled')) r = await provider.refundPayment({ providerRef: orig.provider_ref, amount: rp.amount, merchantRef: rp.id, idempotencyKey: rp.idempotency_key });
      } else {
        r = await provider.refundPayment({ providerRef: orig.provider_ref, amount: rp.amount, merchantRef: rp.id, idempotencyKey: rp.idempotency_key });
      }
      app.payments.logAttempt({ refundPaymentId: rpId, providerCode: rp.provider_code, action: 'refund', outcome: r.status, response: r.raw || r });
      applyRefundPaymentResult(rpId, r, ctx);
    } catch (e) {
      const network = e instanceof ProviderNetworkError;
      app.payments.logAttempt({ refundPaymentId: rpId, providerCode: rp.provider_code, action: 'refund', outcome: network ? 'network_error' : 'error', error: e.message });
      if (network) db.run(`UPDATE refund_payments SET status = 'processing', failure_reason = ? WHERE id = ? AND status = 'pending'`, 'Provider not reachable — will retry', rpId);
      else applyRefundPaymentResult(rpId, { status: 'failed', failureReason: e.message }, ctx);
    } finally { busy.delete(rpId); }
  }

  function applyRefundPaymentResult(rpId, result, ctx) {
    db.tx(() => {
      const rp = db.get('SELECT * FROM refund_payments WHERE id = ?', rpId);
      if (!rp || ['succeeded', 'failed'].includes(rp.status)) return;
      const st = result.status === 'voided' ? 'succeeded' : result.status;
      if (!['processing', 'succeeded', 'failed'].includes(st)) return;
      db.run(`UPDATE refund_payments SET status = ?, provider_ref = COALESCE(?, provider_ref), confirmation_source = ?, failure_reason = ?, confirmed_at = ? WHERE id = ?`,
        st, result.providerRef || null, st === 'succeeded' ? (result.source || 'provider') : null, st === 'failed' ? (result.failureReason || 'Refund failed') : null,
        st === 'succeeded' ? nowIso() : null, rpId);
      const refund = db.get('SELECT * FROM refunds WHERE id = ?', rp.refund_id);
      const agg = db.get(`SELECT COALESCE(SUM(CASE WHEN status='succeeded' THEN amount END),0) AS ok, COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN 1 END),0) AS open,
        COALESCE(SUM(CASE WHEN status='failed' THEN 1 END),0) AS failed FROM refund_payments WHERE refund_id = ?`, refund.id);
      let status = refund.status;
      if (!agg.open) status = agg.ok >= refund.total ? 'completed' : 'failed';
      if (status !== refund.status) {
        db.run('UPDATE refunds SET status = ?, completed_at = ? WHERE id = ?', status, status === 'completed' ? nowIso() : null, refund.id);
        app.audit.log(ctx && ctx.user ? ctx : { actor: 'system', businessId: refund.business_id }, `refund.${status}`, { entityType: 'refund', entityId: refund.id, reference: refund.number, businessId: refund.business_id, newValue: { status, paid_back: agg.ok } });
        if (status === 'completed') app.sync.enqueue(refund.business_id, 'refund', refund.id, () => exportRefund(refund.id));
      }
    });
  }

  /** Retry a failed refund payment through the same provider, or pay it out in cash (supervisor). */
  async function retryPayment(ctx, rpId, body) {
    const rp = db.get(`SELECT rp.*, r.business_id, r.kind FROM refund_payments rp JOIN refunds r ON r.id = rp.refund_id WHERE rp.id = ?`, rpId);
    if (!rp || rp.business_id !== ctx.businessId) throw E.notFound('Refund payment');
    if (rp.status !== 'failed') throw E.conflict(`Refund payment is ${rp.status}`);
    const toCash = v.bool(body, 'to_cash', false);
    const approver = app.auth.authorize(ctx, 'refund.approve', body && body.override, 'Retry refund payment');
    let session = null;
    if (toCash) {
      session = app.sessions.current(ctx);
      if (!session) throw E.conflict('Open a register session to pay out cash');
    }
    const newRp = newId('rfp');
    db.tx(() => {
      db.run(`INSERT INTO refund_payments (id,refund_id,original_payment_id,session_id,method_code,method_type,provider_code,amount,status,idempotency_key,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`, newRp, rp.refund_id, toCash ? null : rp.original_payment_id, toCash ? session.id : rp.session_id,
      toCash ? 'cash' : rp.method_code, toCash ? 'cash' : rp.method_type, toCash ? 'cash' : rp.provider_code, rp.amount, 'pending', `retry:${newRp}`, nowIso());
      db.run(`UPDATE refunds SET status = 'pending' WHERE id = ?`, rp.refund_id);
      app.audit.log(ctx, 'refund.retry', { entityType: 'refund', entityId: rp.refund_id, approvedBy: approver, meta: { failed_payment: rpId, to_cash: toCash } });
    });
    // failed row stays as history; exclude it from totals by marking it superseded via failure_reason
    db.run(`UPDATE refund_payments SET failure_reason = COALESCE(failure_reason,'') || ' [superseded by retry]' WHERE id = ?`, rpId);
    await processRefundPayment(ctx, newRp, rp.kind);
    return get(ctx, rp.refund_id);
  }

  async function recoverInflight() {
    const rows = db.all(`SELECT rp.id, rp.provider_code, rp.provider_ref, r.business_id, r.kind FROM refund_payments rp JOIN refunds r ON r.id = rp.refund_id WHERE rp.status IN ('pending','processing') LIMIT 25`);
    for (const rp of rows) {
      if (busy.has(rp.id)) continue;
      try {
        const provider = buildProvider(app, rp.business_id, rp.provider_code);
        if (provider.confirmsLocally) { await processRefundPayment({ actor: 'system', businessId: rp.business_id }, rp.id, rp.kind); continue; }
        const full = db.get('SELECT status FROM refund_payments WHERE id = ?', rp.id);
        if (full.status === 'pending' && !rp.provider_ref) {
          // request never reached the provider (or response lost): ask by merchant ref, else re-send (idempotent)
          const st = await provider.getRefundStatus({ merchantRef: rp.id });
          if (st.providerStatus === undefined && st.status === 'failed') { await processRefundPayment({ actor: 'system', businessId: rp.business_id }, rp.id, rp.kind); continue; }
          applyRefundPaymentResult(rp.id, st, null);
          continue;
        }
        const st = await provider.getRefundStatus({ providerRef: rp.provider_ref, merchantRef: rp.id });
        if (st.failureReason === 'Unknown refund at provider') {
          db.run(`UPDATE refund_payments SET status = 'pending' WHERE id = ? AND status = 'processing'`, rp.id);
          await processRefundPayment({ actor: 'system', businessId: rp.business_id }, rp.id, rp.kind);
          continue;
        }
        applyRefundPaymentResult(rp.id, st, null);
      } catch (_) { /* network still down: try later */ }
    }
  }

  function exportRefund(id) {
    return { refund: db.get('SELECT * FROM refunds WHERE id = ?', id), items: db.all('SELECT * FROM refund_items WHERE refund_id = ?', id), payments: db.all('SELECT * FROM refund_payments WHERE refund_id = ?', id) };
  }

  function get(ctx, id) {
    const r = db.get(`SELECT r.*, s.number AS sale_number, s.completed_at AS sale_completed_at, rq.full_name AS requested_by_name, au.full_name AS authorized_by_name
      FROM refunds r JOIN sales s ON s.id = r.sale_id JOIN users rq ON rq.id = r.requested_by JOIN users au ON au.id = r.authorized_by WHERE r.id = ? AND r.business_id = ?`, id, ctx.businessId);
    if (!r) throw E.notFound('Refund');
    r.items = db.all(`SELECT ri.*, si.name, si.sku, si.unit, si.unit_price FROM refund_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.refund_id = ?`, id);
    r.payments = db.all(`SELECT rp.*, p.provider_ref AS original_provider_ref FROM refund_payments rp LEFT JOIN payments p ON p.id = rp.original_payment_id WHERE rp.refund_id = ? ORDER BY rp.created_at`, id);
    return r;
  }

  function list(ctx, { from, to, status, kind, limit = 200 }) {
    const where = ['r.business_id = ?']; const p = [ctx.businessId];
    if (!app.auth.can(ctx, 'sale.view_all')) { where.push('(r.requested_by = ? OR r.authorized_by = ?)'); p.push(ctx.user.id, ctx.user.id); }
    if (from) { where.push('r.created_at >= ?'); p.push(from); }
    if (to) { where.push('r.created_at < ?'); p.push(to); }
    if (status) { where.push('r.status = ?'); p.push(status); }
    if (kind) { where.push('r.kind = ?'); p.push(kind); }
    return db.all(`SELECT r.id, r.number, r.kind, r.status, r.total, r.reason_code, r.reason_note, r.created_at, s.number AS sale_number, s.id AS sale_id,
        rq.full_name AS requested_by_name, au.full_name AS authorized_by_name,
        (SELECT GROUP_CONCAT(DISTINCT method_code) FROM refund_payments rp WHERE rp.refund_id = r.id) AS methods
      FROM refunds r JOIN sales s ON s.id = r.sale_id JOIN users rq ON rq.id = r.requested_by JOIN users au ON au.id = r.authorized_by
      WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ?`, ...p, Math.min(limit, 1000));
  }

  return { create, void: (ctx, saleId, body) => create(ctx, saleId, body, { kind: 'void' }), get, list, applyRefundPaymentResult, retryPayment, recoverInflight, REASONS };
};
