'use strict';
const { newId, nowIso } = require('../../lib/ids');
const { E } = require('../../lib/errors');
const { v } = require('../../lib/validate');
const { ProviderNetworkError } = require('./providers/base');
const { REGISTRY, buildProvider } = require('./providers');

/**
 * Payment service — the only code that creates or changes payment records.
 *
 * Lifecycle: pending → processing → succeeded | failed | cancelled   (succeeded → voided before completion)
 *  1. A payment row is committed as 'pending' BEFORE any provider call, keyed by a client-supplied
 *     idempotency key. A double-click, retry or replay returns the same payment, never a second charge.
 *  2. The adapter is called outside the DB transaction. Its answer is applied in a new transaction.
 *  3. If the provider is unreachable or the response is lost, the payment stays in flight and the
 *     recovery poller re-queries the provider by our merchant reference (also on app restart).
 *  4. Electronic payments reach 'succeeded' only from the provider (API status or signed webhook).
 *  5. When succeeded payments cover the total and nothing is in flight, the sale completes server-side.
 */
module.exports = function paymentService(app) {
  const { db } = app;
  const inflightCalls = new Set();

  function logAttempt({ paymentId = null, refundPaymentId = null, providerCode, action, outcome, request, response, error }) {
    db.run(`INSERT INTO payment_attempts (id,payment_id,refund_payment_id,provider_code,action,outcome,request_json,response_json,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId('att'), paymentId, refundPaymentId, providerCode, action, outcome, request ? JSON.stringify(request) : null, response ? JSON.stringify(response) : null, error || null, nowIso());
  }

  function methods(ctx) {
    const online = app.connectivity.isOnline(ctx.businessId);
    return db.all('SELECT * FROM payment_methods WHERE business_id = ? ORDER BY sort_order, name', ctx.businessId).map((m) => {
      const reg = REGISTRY[m.provider_code];
      const local = reg && reg.kind === 'local';
      const available = !!m.is_active && !!reg && (online || (local && !!m.allow_offline));
      return {
        ...m, provider_name: reg ? reg.name : 'Unregistered adapter', provider_status: reg ? reg.status : 'missing', test_mode: reg ? reg.kind === 'simulated' : false,
        available, unavailable_reason: !m.is_active ? 'Disabled' : !reg ? 'No adapter installed' : (!available ? 'Needs network — offline' : null),
      };
    });
  }

  function getMethod(ctx, code) {
    const m = db.get('SELECT * FROM payment_methods WHERE business_id = ? AND code = ?', ctx.businessId, code);
    if (!m || !m.is_active) throw E.validation('Unknown or disabled payment method');
    return m;
  }

  /** Apply a provider result to a payment row. Idempotent; enforces legal transitions. Runs in its own tx. */
  function applyResult(paymentId, result, { source = 'provider', actorCtx = null } = {}) {
    let completed = false;
    db.tx(() => {
      const p = db.get('SELECT * FROM payments WHERE id = ?', paymentId);
      if (!p) return;
      const target = result.status;
      const final = ['succeeded', 'failed', 'cancelled', 'voided'];
      const updates = { provider_status: result.providerStatus ?? p.provider_status, updated_at: nowIso() };
      if (result.providerRef && !p.provider_ref) updates.provider_ref = result.providerRef;
      if (result.instructions) updates.instructions_json = JSON.stringify(result.instructions);
      if (p.status === target || final.includes(p.status)) {
        if (p.status === 'succeeded' && target === 'voided') { /* allowed below */ } else {
          db.run(`UPDATE payments SET ${Object.keys(updates).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(updates), paymentId);
          return;
        }
      }
      updates.status = target;
      if (target === 'succeeded') { updates.confirmed_at = nowIso(); updates.confirmation_source = source; updates.next_check_at = null; }
      if (['failed', 'cancelled'].includes(target)) { updates.failure_reason = result.failureReason || p.failure_reason || target; updates.next_check_at = null; }
      if (['pending', 'processing'].includes(target)) updates.next_check_at = new Date(Date.now() + 2000).toISOString();
      db.run(`UPDATE payments SET ${Object.keys(updates).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(updates), paymentId);
      const sale = db.get('SELECT number, business_id FROM sales WHERE id = ?', p.sale_id);
      app.audit.log(actorCtx || { actor: `provider:${p.provider_code}`, businessId: sale.business_id }, 'payment.status_change', {
        entityType: 'payment', entityId: paymentId, reference: sale.number, businessId: sale.business_id,
        oldValue: { status: p.status }, newValue: { status: target, provider_ref: updates.provider_ref || p.provider_ref, source },
      });
      if (target === 'succeeded') {
        const r = app.sales.completeIfPaid(actorCtx || { actor: 'system', businessId: sale.business_id }, p.sale_id);
        completed = r.completed && !r.already;
      }
    });
    if (completed) app.events.emit('sale.completed', paymentId);
    return db.get('SELECT * FROM payments WHERE id = ?', paymentId);
  }

  async function create(ctx, saleId, body) {
    app.auth.require(ctx, 'pos.sell');
    const session = app.sessions.requireSellingSession(ctx);
    const methodCode = v.str(body, 'method_code', { required: true, max: 40 });
    const key = v.str(body, 'idempotency_key', { required: true, min: 8, max: 80 });
    const reference = v.str(body, 'reference', { max: 80 });
    const method = getMethod(ctx, methodCode);
    const reg = REGISTRY[method.provider_code];
    if (!reg) throw E.conflict(`Payment method ${method.name} has no installed adapter`);
    const local = reg.kind === 'local';

    // Duplicate submission → return the original payment untouched.
    const dup = db.get('SELECT * FROM payments WHERE idempotency_key = ?', key);
    if (dup) {
      if (dup.sale_id !== saleId || dup.method_code !== methodCode) throw E.conflict('Idempotency key reused for a different payment');
      return { payment: dup, sale: app.sales.get(ctx, saleId), duplicate: true };
    }

    const online = app.connectivity.isOnline(ctx.businessId);
    if (!online && !(local && method.allow_offline)) throw E.offline(`${method.name} needs a network connection. Take cash or another offline-capable method.`);
    if (method.requires_reference && !reference) throw E.validation(`${method.name}: enter the approval code / reference from the external device`);
    if (method.provider_code === 'manual') app.auth.require(ctx, 'payment.manual_confirm');

    const paymentId = newId('pay');
    db.tx(() => {
      const sale = app.sales.loadSale(ctx, saleId);
      if (sale.status !== 'open') throw E.conflict(`Sale is ${sale.status}`);
      if (sale.session_id !== session.id) throw E.conflict('Sale belongs to another session');
      const items = db.value('SELECT COUNT(*) FROM sale_items WHERE sale_id = ?', saleId);
      if (!items) throw E.conflict('Cart is empty');
      const ps = app.sales.paidSummary(saleId);
      if (ps.inflight) throw E.conflict('Another payment is still processing for this sale. Wait for it or cancel it first.', { code: 'payment_inflight' });
      const due = sale.total - ps.paid;
      if (due <= 0) throw E.conflict('Nothing left to pay');
      let amount; let tendered = null; let change = 0;
      if (method.allow_change) {
        tendered = v.money(body, 'tendered') ?? v.money(body, 'amount', { required: true });
        if (tendered <= 0) throw E.validation('Amount tendered must be greater than zero');
        amount = Math.min(tendered, due);
        change = tendered - amount;
      } else {
        amount = v.money(body, 'amount', { required: true, min: 1 });
        if (amount > due) throw E.validation(`Amount exceeds balance due (${due}). Only cash can be over-tendered.`);
      }
      const now = nowIso();
      db.run(`INSERT INTO payments (id,business_id,sale_id,session_id,method_code,method_type,provider_code,amount,tendered,change_given,currency,status,idempotency_key,reference,created_offline,created_by,created_at,updated_at,next_check_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      paymentId, ctx.businessId, saleId, session.id, method.code, method.type, method.provider_code, amount, tendered, change, sale.currency, 'pending', key, reference,
      online ? 0 : 1, ctx.user.id, now, now, local ? null : new Date(Date.now() + 3000).toISOString());
      app.audit.log(ctx, 'payment.create', { entityType: 'payment', entityId: paymentId, reference: sale.number, newValue: { method: method.code, amount, tendered, change } });
    });

    const provider = buildProvider(app, ctx.businessId, method.provider_code);
    const pay = db.get('SELECT * FROM payments WHERE id = ?', paymentId);
    const req = { merchantRef: paymentId, amount: pay.amount, currency: pay.currency, idempotencyKey: key, reference, methodType: method.type };
    inflightCalls.add(paymentId);
    try {
      const result = await provider.initiatePayment(req);
      logAttempt({ paymentId, providerCode: provider.code, action: 'initiate', outcome: result.status, request: { ...req, reference: reference ? '***' : null }, response: result.raw || { status: result.status } });
      if (local && result.status === 'succeeded') {
        applyResult(paymentId, result, { source: method.provider_code === 'manual' ? 'manual' : 'local', actorCtx: ctx });
        if (method.provider_code === 'manual') db.run('UPDATE payments SET confirmed_by = ? WHERE id = ?', ctx.user.id, paymentId);
        if (method.type === 'cash') app.hardware.openDrawer(ctx, 'cash payment');
      } else {
        applyResult(paymentId, result, { source: 'provider', actorCtx: ctx });
      }
    } catch (e) {
      if (e instanceof ProviderNetworkError) {
        // Outcome unknown: the provider may or may not have the charge. Keep it in flight and re-query.
        logAttempt({ paymentId, providerCode: provider.code, action: 'initiate', outcome: 'network_error', request: req, error: e.message });
        db.run(`UPDATE payments SET status = 'processing', failure_reason = ?, next_check_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
          'Provider not reachable — status will be re-checked automatically', new Date(Date.now() + 5000).toISOString(), nowIso(), paymentId);
      } else {
        logAttempt({ paymentId, providerCode: provider.code, action: 'initiate', outcome: 'error', request: req, error: e.message });
        applyResult(paymentId, { status: 'failed', failureReason: e.message }, { actorCtx: ctx });
      }
    } finally { inflightCalls.delete(paymentId); }
    return { payment: db.get('SELECT * FROM payments WHERE id = ?', paymentId), sale: app.sales.get(ctx, saleId) };
  }

  /** Re-query the provider for an in-flight payment. Used by the UI "check status" button and the recovery poller. */
  async function refresh(ctx, paymentId) {
    const p = db.get('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!p) throw E.notFound('Payment');
    if (ctx && ctx.businessId && p.business_id !== ctx.businessId) throw E.notFound('Payment');
    if (!['pending', 'processing'].includes(p.status) || inflightCalls.has(paymentId)) return p;
    const provider = buildProvider(app, p.business_id, p.provider_code);
    if (provider.confirmsLocally) return p;
    inflightCalls.add(paymentId);
    try {
      const result = await provider.getPaymentStatus({ providerRef: p.provider_ref, merchantRef: p.id });
      logAttempt({ paymentId, providerCode: p.provider_code, action: 'status', outcome: result.status, response: result.raw || result });
      return applyResult(paymentId, result, { actorCtx: ctx && ctx.user ? ctx : null });
    } catch (e) {
      const attempts = db.value(`SELECT COUNT(*) FROM payment_attempts WHERE payment_id = ? AND action = 'status'`, paymentId);
      const backoff = Math.min(60000, 2000 * Math.pow(1.5, Math.min(attempts, 10)));
      logAttempt({ paymentId, providerCode: p.provider_code, action: 'status', outcome: 'network_error', error: e.message });
      db.run('UPDATE payments SET next_check_at = ?, updated_at = ? WHERE id = ?', new Date(Date.now() + backoff).toISOString(), nowIso(), paymentId);
      return db.get('SELECT * FROM payments WHERE id = ?', paymentId);
    } finally { inflightCalls.delete(paymentId); }
  }

  /**
   * Cancel an in-flight payment, or void a succeeded one on a sale that isn't complete yet.
   * The provider has the last word: if it says the charge already succeeded, we record that.
   */
  async function cancel(ctx, paymentId, body) {
    const p = db.get('SELECT * FROM payments WHERE id = ? AND business_id = ?', paymentId, ctx.businessId);
    if (!p) throw E.notFound('Payment');
    const sale = app.sales.loadSale(ctx, p.sale_id);
    if (sale.status !== 'open') throw E.conflict('The sale is no longer open — use a refund instead');
    const reason = v.str(body, 'reason', { max: 200 }) || 'Cancelled at till';
    const provider = buildProvider(app, ctx.businessId, p.provider_code);
    if (['pending', 'processing'].includes(p.status)) {
      app.auth.require(ctx, 'pos.sell');
      if (provider.confirmsLocally) return applyResult(paymentId, { status: 'cancelled', failureReason: reason }, { actorCtx: ctx });
      try {
        const r = await provider.cancelPayment({ providerRef: p.provider_ref, merchantRef: p.id });
        logAttempt({ paymentId, providerCode: p.provider_code, action: 'cancel', outcome: r.status, response: r.raw || r });
        return applyResult(paymentId, r.status === 'cancelled' ? { ...r, failureReason: reason } : r, { actorCtx: ctx });
      } catch (e) {
        logAttempt({ paymentId, providerCode: p.provider_code, action: 'cancel', outcome: 'network_error', error: e.message });
        throw E.offline('Could not reach the provider to cancel. The payment stays pending and will be re-checked — do not take a second payment for the same amount until it resolves.');
      }
    }
    if (p.status === 'succeeded') {
      const approver = app.auth.authorize(ctx, 'pos.line_remove_after_payment', body && body.override, 'Removing a completed payment');
      if (!provider.confirmsLocally) {
        let r;
        try { r = await provider.voidPayment({ providerRef: p.provider_ref }); } catch (e) { throw E.offline(`Could not reach the provider to reverse the payment: ${e.message}`); }
        logAttempt({ paymentId, providerCode: p.provider_code, action: 'cancel', outcome: r.status, response: r.raw || r });
        if (r.status !== 'voided') throw E.conflict(r.failureReason || 'Provider refused to reverse this payment');
      }
      const out = applyResult(paymentId, { status: 'voided', providerStatus: provider.confirmsLocally ? 'returned_to_customer' : 'reversed' }, { actorCtx: ctx });
      app.audit.log(ctx, 'payment.void', { entityType: 'payment', entityId: paymentId, reference: sale.number, approvedBy: approver !== ctx.user.id ? approver : null, meta: { reason, amount: p.amount, method: p.method_code } });
      if (p.method_type === 'cash') app.hardware.openDrawer(ctx, 'cash returned');
      return out;
    }
    throw E.conflict(`Payment is already ${p.status}`);
  }

  /** Signed provider webhook → payment/refund update. Idempotent per provider event id. */
  function handleWebhook(providerCode, headers, rawBody, businessId) {
    const biz = businessId || db.value('SELECT business_id FROM provider_configs WHERE provider_code = ? LIMIT 1', providerCode) || db.value('SELECT id FROM businesses LIMIT 1');
    const provider = buildProvider(app, biz, providerCode);
    let evt;
    try { evt = provider.verifyWebhook(headers, rawBody); } catch (e) {
      db.run('INSERT OR IGNORE INTO webhook_events (id,provider_code,event_id,signature_ok,payload_json,processed,error,received_at) VALUES (?,?,?,?,?,?,?,?)',
        newId('whk'), providerCode, `invalid-${newId('x')}`, 0, String(rawBody).slice(0, 4000), 0, e.message, nowIso());
      app.audit.log({ actor: `webhook:${providerCode}`, businessId: biz }, 'payment.webhook_rejected', { meta: { reason: e.message } });
      throw E.unauthorized('Invalid webhook signature');
    }
    const ins = db.run('INSERT OR IGNORE INTO webhook_events (id,provider_code,event_id,signature_ok,payload_json,processed,received_at) VALUES (?,?,?,?,?,?,?)',
      newId('whk'), providerCode, evt.eventId, 1, rawBody, 0, nowIso());
    if (!ins.changes) return { duplicate: true };
    let handled = false;
    if (evt.kind === 'refund') {
      const rp = db.get('SELECT id FROM refund_payments WHERE provider_code = ? AND (provider_ref = ? OR id = ?)', providerCode, evt.providerRef, evt.merchantRef);
      if (rp) { app.refunds.applyRefundPaymentResult(rp.id, { status: evt.status, providerRef: evt.providerRef }); handled = true; }
    } else {
      const p = db.get('SELECT id FROM payments WHERE provider_code = ? AND (provider_ref = ? OR id = ?)', providerCode, evt.providerRef, evt.merchantRef);
      if (p) {
        logAttempt({ paymentId: p.id, providerCode, action: 'webhook', outcome: evt.status, response: evt.raw });
        applyResult(p.id, { status: evt.status, providerRef: evt.providerRef, providerStatus: evt.raw.data.status });
        handled = true;
      }
    }
    db.run('UPDATE webhook_events SET processed = ?, error = ? WHERE provider_code = ? AND event_id = ?', handled ? 1 : 0, handled ? null : 'no matching record', providerCode, evt.eventId);
    return { handled };
  }

  /** Recovery loop: resolves in-flight payments and refunds (runs at startup and every few seconds). */
  async function recoverInflight() {
    const due = db.all(`SELECT id FROM payments WHERE status IN ('pending','processing') AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY created_at LIMIT 25`, nowIso());
    for (const p of due) { try { await refresh(null, p.id); } catch (_) { /* logged in refresh */ } }
    await app.refunds.recoverInflight();
    return due.length;
  }

  function list(ctx, { status, method, provider, from, to, q, limit = 200 }) {
    app.auth.require(ctx, 'payment.view');
    const where = ['p.business_id = ?']; const pr = [ctx.businessId];
    if (status === 'inflight') where.push("p.status IN ('pending','processing')"); else if (status) { where.push('p.status = ?'); pr.push(status); }
    if (method) { where.push('p.method_code = ?'); pr.push(method); }
    if (provider) { where.push('p.provider_code = ?'); pr.push(provider); }
    if (from) { where.push('p.created_at >= ?'); pr.push(from); }
    if (to) { where.push('p.created_at < ?'); pr.push(to); }
    if (q) { where.push('(p.provider_ref LIKE ? OR p.reference LIKE ? OR s.number LIKE ?)'); pr.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    return db.all(`SELECT p.id, p.sale_id, p.method_code, p.method_type, p.provider_code, p.amount, p.tendered, p.change_given, p.currency, p.status, p.provider_ref, p.provider_status,
        p.confirmation_source, p.reference, p.failure_reason, p.created_offline, p.created_at, p.confirmed_at, s.number AS sale_number, s.status AS sale_status, u.full_name AS created_by_name,
        (SELECT st.provider_settlement_ref FROM settlement_items si JOIN settlements st ON st.id = si.settlement_id WHERE si.payment_id = p.id LIMIT 1) AS settlement_ref
      FROM payments p JOIN sales s ON s.id = p.sale_id JOIN users u ON u.id = p.created_by WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT ?`, ...pr, Math.min(limit, 1000));
  }

  function detail(ctx, id) {
    app.auth.require(ctx, 'payment.view');
    const p = db.get('SELECT p.*, s.number AS sale_number FROM payments p JOIN sales s ON s.id = p.sale_id WHERE p.id = ? AND p.business_id = ?', id, ctx.businessId);
    if (!p) throw E.notFound('Payment');
    p.attempts = db.all('SELECT action, outcome, error, response_json, created_at FROM payment_attempts WHERE payment_id = ? ORDER BY created_at', id);
    return p;
  }

  return { methods, create, refresh, cancel, applyResult, handleWebhook, recoverInflight, list, detail, logAttempt, buildProvider: (b, c) => buildProvider(app, b, c) };
};
