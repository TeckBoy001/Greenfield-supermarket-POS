'use strict';
/**
 * TEST-MODE SIMULATED GATEWAYS — not real payment processors.
 *
 * These adapters behave like an external provider so the full electronic-payment lifecycle can be
 * exercised without credentials: async confirmation, status queries by merchant reference,
 * HMAC-signed webhooks, refunds, voids, network failure and settlement batches with fees.
 * They keep their own "provider-side" ledger in sim_provider_transactions, separate from our
 * payments table — exactly like a real provider keeps its own records.
 *
 * Deterministic test triggers (by amount, minor units):
 *   ends in 51 → declined (insufficient funds)
 *   ends in 52 → never auto-resolves (use the simulator to approve/decline/expire)
 * Scenarios (provider config.scenario): 'auto_approve' (after config.delay_ms) | 'await_customer'
 */
const { PaymentProvider, ProviderNetworkError } = require('./base');
const { hmac, safeEqual } = require('../../../lib/crypto');
const { nowIso, newId } = require('../../../lib/ids');
const { localDate, addDays } = require('../../../lib/time');

const FEES = {
  // Simulated fee schedule for testing only. Real fees come from the provider's settlement report.
  card: (amt) => Math.min(Math.round(amt * 0.015), 200000),
  bank_transfer: () => 5000,
  mobile_money: (amt) => Math.round(amt * 0.01),
  wallet: (amt) => Math.round(amt * 0.01),
};

class SimulatedGateway extends PaymentProvider {
  constructor(opts) {
    super(opts);
    this.kind = opts.config.kind || 'card';
  }
  get capabilities() { return { refunds: true, void: true, webhooks: true, settlementReports: true, statusQuery: true }; }
  get db() { return this.app.db; }

  network() {
    if (this.app.connectivity.simulatedOffline(this.businessId)) throw new ProviderNetworkError(`${this.displayName}: network unreachable`);
  }
  async healthCheck() {
    try { this.network(); return { ok: true, mode: 'test' }; } catch (e) { return { ok: false, error: e.message }; }
  }

  row(where, ...p) { return this.db.get(`SELECT * FROM sim_provider_transactions WHERE provider_code = ? AND ${where}`, this.code, ...p); }

  /** Provider-side lazy state progression. */
  tick(tx) {
    if (!tx || tx.status !== 'processing' || !tx.resolve_at || tx.resolve_at > nowIso()) return tx;
    const suffix = tx.amount % 100;
    const status = tx.kind === 'refund' ? 'succeeded' : (suffix === 51 ? 'declined' : 'succeeded');
    this.db.run('UPDATE sim_provider_transactions SET status = ?, updated_at = ? WHERE ref = ?', status, nowIso(), tx.ref);
    return { ...tx, status };
  }

  toResult(tx) {
    const map = { processing: 'processing', succeeded: 'succeeded', declined: 'failed', expired: 'failed', cancelled: 'cancelled', reversed: 'voided' };
    const reasons = { declined: 'Declined by issuer (insufficient funds) [simulated]', expired: 'Customer did not complete payment in time [simulated]' };
    return { status: map[tx.status], providerRef: tx.ref, providerStatus: tx.status, failureReason: reasons[tx.status] || null, raw: { ref: tx.ref, status: tx.status, amount: tx.amount } };
  }

  instructions(tx) {
    if (this.kind === 'card') return { title: 'Present card on terminal', message: 'Customer taps, inserts or swipes on the payment terminal.', terminal_id: this.config.terminal_id || 'SIM-T1' };
    if (this.kind === 'bank_transfer') {
      const acct = `99${String(Math.abs(hashCode(tx.ref)) % 1e8).padStart(8, '0')}`;
      return { title: 'Bank transfer', message: 'Ask the customer to transfer the exact amount to this one-time account.', bank_name: 'Simulated Bank', account_number: acct, account_name: 'Meridian POS Checkout (TEST)', expires_in_minutes: 30 };
    }
    return { title: 'Mobile payment', message: 'A payment prompt was sent to the customer\'s phone. Ask them to approve it.', channel: this.kind };
  }

  async initiatePayment({ merchantRef, amount, currency }) {
    this.network();
    const existing = this.row('merchant_ref = ?', merchantRef); // provider-side idempotency on merchant reference
    if (existing) return { ...this.toResult(this.tick(existing)), instructions: this.instructions(existing) };
    const scenario = amount % 100 === 52 ? 'manual' : (this.config.scenario || 'auto_approve');
    const delay = Number(this.config.delay_ms ?? 2500);
    const ref = `${this.code.toUpperCase().replace(/[^A-Z]/g, '')}_${newId('tx').slice(3)}`;
    const now = nowIso();
    const resolveAt = scenario === 'auto_approve' ? new Date(Date.now() + delay).toISOString() : null;
    this.db.run(`INSERT INTO sim_provider_transactions (ref,provider_code,kind,merchant_ref,amount,currency,status,scenario,resolve_at,created_at,updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ref, this.code, 'charge', merchantRef, amount, currency, 'processing', scenario, resolveAt, now, now);
    const tx = this.row('ref = ?', ref);
    return { ...this.toResult(tx), instructions: this.instructions(tx) };
  }

  async getPaymentStatus({ providerRef, merchantRef }) {
    this.network();
    const tx = providerRef ? this.row('ref = ?', providerRef) : this.row('merchant_ref = ?', merchantRef);
    if (!tx) return { status: 'failed', failureReason: 'Unknown at provider', providerStatus: 'not_found' };
    return this.toResult(this.tick(tx));
  }

  async cancelPayment({ providerRef, merchantRef }) {
    this.network();
    const tx = this.tick(providerRef ? this.row('ref = ?', providerRef) : this.row('merchant_ref = ?', merchantRef));
    if (!tx) return { status: 'cancelled', providerStatus: 'not_found' };
    if (tx.status === 'processing') {
      this.db.run(`UPDATE sim_provider_transactions SET status = 'cancelled', updated_at = ? WHERE ref = ?`, nowIso(), tx.ref);
      return this.toResult({ ...tx, status: 'cancelled' });
    }
    return this.toResult(tx); // already final at provider: caller must accept provider truth
  }

  async voidPayment({ providerRef }) {
    this.network();
    const tx = this.row('ref = ?', providerRef);
    if (!tx) throw new Error('Unknown provider reference');
    if (tx.status === 'succeeded' && !tx.settled_ref) {
      this.db.run(`UPDATE sim_provider_transactions SET status = 'reversed', updated_at = ? WHERE ref = ?`, nowIso(), tx.ref);
      return this.toResult({ ...tx, status: 'reversed' });
    }
    return { ...this.toResult(tx), failureReason: 'Cannot void: already settled — refund instead' };
  }

  async refundPayment({ providerRef, amount, merchantRef }) {
    this.network();
    const parent = this.row('ref = ?', providerRef);
    if (!parent || parent.status !== 'succeeded') return { status: 'failed', failureReason: 'Original charge not refundable at provider' };
    const prior = this.db.value(`SELECT COALESCE(SUM(amount),0) FROM sim_provider_transactions WHERE parent_ref = ? AND kind = 'refund' AND status IN ('processing','succeeded')`, parent.ref);
    const existing = this.row('merchant_ref = ?', merchantRef);
    if (existing) return this.toResult(this.tick(existing));
    if (prior + amount > parent.amount) return { status: 'failed', failureReason: 'Refund exceeds captured amount' };
    const ref = `${this.code.toUpperCase().replace(/[^A-Z]/g, '')}_RF_${newId('tx').slice(3)}`;
    const now = nowIso();
    this.db.run(`INSERT INTO sim_provider_transactions (ref,provider_code,kind,merchant_ref,parent_ref,amount,currency,status,scenario,resolve_at,created_at,updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ref, this.code, 'refund', merchantRef, parent.ref, amount, parent.currency, 'processing', 'auto_approve',
    new Date(Date.now() + Number(this.config.refund_delay_ms ?? 1500)).toISOString(), now, now);
    return this.toResult(this.row('ref = ?', ref));
  }

  async getRefundStatus({ providerRef, merchantRef }) {
    this.network();
    const tx = providerRef ? this.row('ref = ?', providerRef) : this.row('merchant_ref = ?', merchantRef);
    if (!tx) return { status: 'failed', failureReason: 'Unknown refund at provider' };
    return this.toResult(this.tick(tx));
  }

  // ── webhooks ──
  sign(body) { return hmac(this.secret, body); }
  verifyWebhook(headers, rawBody) {
    const sig = headers['x-sim-signature'];
    if (!sig || !this.secret || !safeEqual(sig, this.sign(rawBody))) {
      const e = new Error('Invalid webhook signature'); e.status = 401; throw e;
    }
    const evt = JSON.parse(rawBody);
    return { eventId: evt.id, type: evt.type, providerRef: evt.data.ref, merchantRef: evt.data.merchant_ref, kind: evt.data.kind, status: this.toResult(evt.data).status, raw: evt };
  }

  /** Simulator control (the "customer/bank side"). Returns the signed webhook to deliver. */
  simulate(providerRef, action) {
    const tx = this.row('ref = ?', providerRef);
    if (!tx) throw new Error('Unknown simulated transaction');
    if (tx.status !== 'processing') return { tx, webhook: null };
    const status = { approve: 'succeeded', decline: 'declined', expire: 'expired' }[action];
    if (!status) throw new Error('Unknown simulator action');
    this.db.run('UPDATE sim_provider_transactions SET status = ?, updated_at = ? WHERE ref = ?', status, nowIso(), tx.ref);
    const data = { ...tx, status };
    const body = JSON.stringify({ id: newId('evt'), type: `${tx.kind}.${status}`, created_at: nowIso(), data });
    return { tx: data, webhook: { body, headers: { 'x-sim-signature': this.sign(body), 'content-type': 'application/json' } } };
  }

  /**
   * Settlement report. Settles every succeeded, unsettled charge/refund created before `to`,
   * grouped by business date. `opts.simulateDiscrepancy` drops one charge and adds an unknown
   * reference so reconciliation can be tested.
   */
  async fetchSettlements({ to, timeZone = 'Africa/Lagos', simulateDiscrepancy = false }) {
    this.network();
    const rows = this.db.all(`SELECT * FROM sim_provider_transactions WHERE provider_code = ? AND settled_ref IS NULL AND status IN ('succeeded','reversed') AND created_at < ? ORDER BY created_at`, this.code, to);
    const byDate = {};
    for (const r of rows) {
      if (r.status === 'reversed') { this.db.run('UPDATE sim_provider_transactions SET settled_ref = ? WHERE ref = ?', 'VOIDED', r.ref); continue; }
      const d = localDate(new Date(r.created_at), timeZone);
      (byDate[d] = byDate[d] || []).push(r);
    }
    const out = [];
    for (const [date, txs] of Object.entries(byDate)) {
      const ref = `STL-${this.code.toUpperCase()}-${date.replace(/-/g, '')}-${newId('x').slice(-4).toUpperCase()}`;
      let items = txs.map((t) => ({
        type: t.kind === 'refund' ? 'refund' : 'payment', provider_ref: t.ref, merchant_ref: t.merchant_ref,
        amount: t.amount, fee: t.kind === 'refund' ? 0 : (FEES[this.kind] || FEES.card)(t.amount),
      }));
      if (simulateDiscrepancy && items.length) {
        const dropped = items.findIndex((i) => i.type === 'payment');
        if (dropped >= 0) items = items.filter((_, i) => i !== dropped);
        items.push({ type: 'payment', provider_ref: `UNKNOWN_${newId('x').slice(-6)}`, merchant_ref: null, amount: 123400, fee: 1851 });
      }
      const gross = items.filter((i) => i.type === 'payment').reduce((a, i) => a + i.amount, 0);
      const refunds = items.filter((i) => i.type === 'refund').reduce((a, i) => a + i.amount, 0);
      const fees = items.reduce((a, i) => a + i.fee, 0);
      for (const t of txs) this.db.run('UPDATE sim_provider_transactions SET settled_ref = ? WHERE ref = ?', ref, t.ref);
      out.push({ provider_settlement_ref: ref, settlement_date: addDays(date, 1) /* T+1 payout */, period_start: date, period_end: date, gross_amount: gross, refund_amount: refunds, fee_amount: fees, adjustment_amount: 0, net_amount: gross - refunds - fees, items });
    }
    return out;
  }
}

function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h; }

module.exports = { SimulatedGateway };
