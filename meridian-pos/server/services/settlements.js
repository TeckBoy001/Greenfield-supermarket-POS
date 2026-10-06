'use strict';
const { newId, nowIso } = require('../lib/ids');
const { E } = require('../lib/errors');
const { v } = require('../lib/validate');
const { localDate, localMidnightUtc } = require('../lib/time');
const { REGISTRY } = require('./payments/providers');

/**
 * Provider settlements: what a payment provider reports it has paid (or will pay) to the business
 * for a period, net of fees and refunds. Each settlement line is matched to our payment / refund
 * records by provider reference. Mismatches are flagged, never "fixed" by editing payments.
 */
module.exports = function settlementService(app) {
  const { db } = app;

  function importBatch(ctx, providerCode, batch, source) {
    return db.tx(() => {
      const exists = db.get('SELECT id FROM settlements WHERE provider_code = ? AND provider_settlement_ref = ?', providerCode, batch.provider_settlement_ref);
      if (exists) return { id: exists.id, duplicate: true };
      const b = db.get('SELECT currency FROM businesses WHERE id = ?', ctx.businessId);
      const account = db.get(`SELECT id FROM financial_accounts WHERE business_id = ? AND type = 'bank' AND (provider_code = ? OR provider_code IS NULL) AND is_active = 1 ORDER BY provider_code IS NULL LIMIT 1`, ctx.businessId, providerCode);
      const id = newId('stl');
      const net = batch.gross_amount - batch.refund_amount - batch.fee_amount + (batch.adjustment_amount || 0);
      if (batch.net_amount !== undefined && batch.net_amount !== net) throw E.validation(`Net amount ${batch.net_amount} does not equal gross − refunds − fees + adjustments (${net})`);
      db.run(`INSERT INTO settlements (id,business_id,provider_code,provider_settlement_ref,settlement_date,period_start,period_end,currency,gross_amount,refund_amount,fee_amount,adjustment_amount,net_amount,status,destination_account_id,source,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, ctx.businessId, providerCode, batch.provider_settlement_ref, batch.settlement_date, batch.period_start, batch.period_end,
      b.currency, batch.gross_amount, batch.refund_amount, batch.fee_amount, batch.adjustment_amount || 0, net, 'reported', account ? account.id : null, source, ctx.user ? ctx.user.id : null, nowIso());
      const counts = { matched: 0, amount_mismatch: 0, unknown_reference: 0, not_applicable: 0 };
      for (const it of batch.items || []) {
        let paymentId = null; let refundPaymentId = null; let status = 'not_applicable';
        if (it.type === 'payment') {
          const p = db.get('SELECT id, amount FROM payments WHERE business_id = ? AND provider_code = ? AND (provider_ref = ? OR id = ?)', ctx.businessId, providerCode, it.provider_ref, it.merchant_ref || '');
          if (!p) status = 'unknown_reference'; else { paymentId = p.id; status = p.amount === it.amount ? 'matched' : 'amount_mismatch'; }
        } else if (it.type === 'refund') {
          const rp = db.get('SELECT id, amount FROM refund_payments WHERE provider_code = ? AND (provider_ref = ? OR id = ?)', providerCode, it.provider_ref, it.merchant_ref || '');
          if (!rp) status = 'unknown_reference'; else { refundPaymentId = rp.id; status = rp.amount === it.amount ? 'matched' : 'amount_mismatch'; }
        }
        counts[status]++;
        db.run(`INSERT INTO settlement_items (id,settlement_id,type,provider_ref,amount,fee,payment_id,refund_payment_id,match_status) VALUES (?,?,?,?,?,?,?,?,?)`,
          newId('sti'), id, it.type, it.provider_ref, it.amount, it.fee || 0, paymentId, refundPaymentId, status);
      }
      const status = counts.amount_mismatch || counts.unknown_reference ? 'discrepancy' : 'matched';
      db.run('UPDATE settlements SET status = ?, match_summary_json = ? WHERE id = ?', status, JSON.stringify(counts), id);
      app.audit.log(ctx, 'settlement.import', { entityType: 'settlement', entityId: id, reference: batch.provider_settlement_ref, newValue: { provider: providerCode, gross: batch.gross_amount, fees: batch.fee_amount, net, status, source, counts } });
      return { id, status, counts };
    });
  }

  async function fetchFromProvider(ctx, body) {
    app.auth.require(ctx, 'settlement.manage');
    const providerCode = v.str(body, 'provider_code', { required: true, max: 40 });
    const reg = REGISTRY[providerCode];
    if (!reg || reg.kind === 'local') throw E.validation('This provider does not publish settlement reports — import them manually');
    const tz = db.value('SELECT timezone FROM businesses WHERE id = ?', ctx.businessId);
    const includeToday = v.bool(body, 'include_today', false);
    const to = includeToday ? new Date().toISOString() : localMidnightUtc(localDate(new Date(), tz), tz).toISOString();
    const provider = app.payments.buildProvider(ctx.businessId, providerCode);
    let batches;
    try {
      batches = await provider.fetchSettlements({ to, timeZone: tz, simulateDiscrepancy: v.bool(body, 'simulate_discrepancy', false) && reg.kind === 'simulated' });
    } catch (e) { throw E.provider(`Could not fetch settlements: ${e.message}`); }
    const results = batches.map((b) => ({ ref: b.provider_settlement_ref, ...importBatch(ctx, providerCode, b, 'provider_api') }));
    return { imported: results.filter((r) => !r.duplicate).length, results };
  }

  function importManual(ctx, body) {
    app.auth.require(ctx, 'settlement.manage');
    const providerCode = v.str(body, 'provider_code', { required: true, max: 40 });
    const batch = {
      provider_settlement_ref: v.str(body, 'provider_settlement_ref', { required: true, max: 80 }),
      settlement_date: v.str(body, 'settlement_date', { required: true, pattern: /^\d{4}-\d{2}-\d{2}$/ }),
      gross_amount: v.money(body, 'gross_amount', { required: true }),
      refund_amount: v.money(body, 'refund_amount') || 0,
      fee_amount: v.money(body, 'fee_amount') || 0,
      adjustment_amount: v.int(body, 'adjustment_amount') || 0,
      items: v.arr(body, 'items', { max: 5000 }).map((it, i) => ({
        type: v.oneOf(it, 'type', ['payment', 'refund', 'fee', 'adjustment'], { required: true }),
        provider_ref: v.str(it, 'provider_ref', { max: 120, label: `items[${i}].provider_ref` }),
        amount: v.int(it, 'amount', { required: true, label: `items[${i}].amount` }),
        fee: v.int(it, 'fee', { label: `items[${i}].fee` }) || 0,
      })),
    };
    batch.period_start = v.str(body, 'period_start', { pattern: /^\d{4}-\d{2}-\d{2}$/ }) || batch.settlement_date;
    batch.period_end = v.str(body, 'period_end', { pattern: /^\d{4}-\d{2}-\d{2}$/ }) || batch.settlement_date;
    return importBatch(ctx, providerCode, batch, 'manual');
  }

  function list(ctx, { status, provider, limit = 200 }) {
    app.auth.require(ctx, 'settlement.manage');
    const where = ['s.business_id = ?']; const p = [ctx.businessId];
    if (status) { where.push('s.status = ?'); p.push(status); }
    if (provider) { where.push('s.provider_code = ?'); p.push(provider); }
    return db.all(`SELECT s.*, fa.name AS destination_name,
        (SELECT COALESCE(SUM(amount),0) FROM payouts po WHERE po.settlement_id = s.id AND po.status = 'paid') AS received_amount,
        (SELECT number FROM payouts po WHERE po.settlement_id = s.id AND po.status = 'paid' LIMIT 1) AS payout_number
      FROM settlements s LEFT JOIN financial_accounts fa ON fa.id = s.destination_account_id WHERE ${where.join(' AND ')} ORDER BY s.settlement_date DESC, s.created_at DESC LIMIT ?`, ...p, limit);
  }

  function get(ctx, id) {
    app.auth.require(ctx, 'settlement.manage');
    const s = db.get('SELECT * FROM settlements WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!s) throw E.notFound('Settlement');
    s.items = db.all(`SELECT si.*, sa.number AS sale_number, sa.id AS sale_id FROM settlement_items si LEFT JOIN payments p ON p.id = si.payment_id LEFT JOIN sales sa ON sa.id = p.sale_id
      WHERE si.settlement_id = ? ORDER BY si.match_status <> 'matched' DESC, si.type`, id);
    s.payouts = db.all('SELECT id, number, status, amount, reference, paid_at FROM payouts WHERE settlement_id = ?', id);
    return s;
  }

  function resolve(ctx, id, body) {
    app.auth.require(ctx, 'reconciliation.manage');
    const s = db.get('SELECT * FROM settlements WHERE id = ? AND business_id = ?', id, ctx.businessId);
    if (!s) throw E.notFound('Settlement');
    if (s.status !== 'discrepancy') throw E.conflict('Only settlements with discrepancies need resolving');
    const note = v.str(body, 'note', { required: true, max: 500 });
    db.tx(() => {
      db.run(`UPDATE settlements SET status = 'resolved' WHERE id = ?`, id);
      app.audit.log(ctx, 'settlement.resolve', { entityType: 'settlement', entityId: id, reference: s.provider_settlement_ref, meta: { note } });
    });
    return get(ctx, id);
  }

  return { fetchFromProvider, importManual, importBatch, list, get, resolve };
};
