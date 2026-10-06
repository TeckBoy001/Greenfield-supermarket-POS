'use strict';
const { EventEmitter } = require('events');

/**
 * Connectivity monitor. "Online" means the payment providers (and HQ sync) are reachable.
 * Probes every active electronic provider's healthCheck(). A test switch (network.simulate_offline)
 * lets you exercise offline behaviour on demand; it is visible to admins and audited.
 *
 * Offline policy (explicit, enforced server-side in PaymentService):
 *   - Cash and manually-confirmed methods flagged allow_offline keep working; sales complete locally
 *     and are queued in the sync outbox.
 *   - Electronic methods (card terminal, transfer, wallet) are refused — nothing is ever marked paid
 *     without the provider confirming it.
 *   - In-flight electronic payments stay pending and are re-queried when connectivity returns.
 */
module.exports = function connectivityService(app) {
  const { db } = app;
  const events = new EventEmitter();
  const state = new Map(); // businessId -> { probeOk, lastCheck, providers }

  const simulatedOffline = (businessId) => !!app.settings.get(businessId, 'network.simulate_offline');

  function isOnline(businessId) {
    if (simulatedOffline(businessId)) return false;
    const s = state.get(businessId);
    return !s || s.probeOk !== false;
  }

  async function probe(businessId) {
    const codes = db.all(`SELECT DISTINCT provider_code FROM payment_methods WHERE business_id = ? AND is_active = 1 AND provider_code NOT IN ('cash','manual')`, businessId).map((r) => r.provider_code);
    const providers = [];
    for (const code of codes) {
      try {
        const p = app.payments.buildProvider(businessId, code);
        const h = await p.healthCheck();
        providers.push({ code, ok: !!h.ok, error: h.error || null });
      } catch (e) { providers.push({ code, ok: false, error: e.message }); }
    }
    const prev = isOnline(businessId);
    state.set(businessId, { probeOk: providers.length ? providers.some((p) => p.ok) : true, lastCheck: new Date().toISOString(), providers });
    const now = isOnline(businessId);
    if (prev !== now) events.emit('change', { businessId, online: now });
    return status(businessId);
  }

  function status(businessId) {
    const s = state.get(businessId) || {};
    return {
      online: isOnline(businessId), simulated_offline: simulatedOffline(businessId), last_check: s.lastCheck || null, providers: s.providers || [],
      outbox_pending: db.value(`SELECT COUNT(*) FROM sync_outbox WHERE business_id = ? AND status IN ('pending','failed')`, businessId),
      outbox_conflicts: db.value(`SELECT COUNT(*) FROM sync_outbox WHERE business_id = ? AND status = 'conflict'`, businessId),
      inflight_payments: db.value(`SELECT COUNT(*) FROM payments WHERE business_id = ? AND status IN ('pending','processing')`, businessId),
    };
  }

  async function setSimulatedOffline(ctx, offline) {
    app.auth.require(ctx, 'sync.manage');
    app.settings.set(ctx, 'network.simulate_offline', !!offline);
    const st = await probe(ctx.businessId);
    events.emit('change', { businessId: ctx.businessId, online: st.online });
    if (st.online) { app.payments.recoverInflight().catch(() => {}); app.sync.flush().catch(() => {}); }
    return st;
  }

  return { isOnline, simulatedOffline, probe, status, setSimulatedOffline, events };
};
