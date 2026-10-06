'use strict';
const { E } = require('../../lib/errors');
const money = require('../../lib/money');

/**
 * Receipt model builder. Renderers (text/ESC-POS, HTML, PDF) consume this structure, so a business
 * can change layout without touching financial logic, and every channel prints identical figures.
 */
module.exports = function receiptModel(app) {
  const { db } = app;

  function fmtFactory(b) { return (m) => money.format(m, b.currency, b.currency_minor, b.locale); }
  function maskPhone(p) { return p ? p.replace(/.(?=.{3})/g, (c, i) => (i < 4 ? c : '•')) : null; }
  function maskRef(r) { return r && r.length > 8 ? `…${r.slice(-8)}` : r; }

  function header(b, s) {
    return {
      name: b.name, legal_name: b.legal_name, address: b.address, phone: b.phone, email: b.email, website: b.website, tax_id: b.tax_id, logo: b.logo_data,
      custom_header: s['receipt.header'], footer: s['receipt.footer'],
    };
  }

  function forSale(ctx, saleId, { copy = false } = {}) {
    const sale = app.sales.get(ctx, saleId);
    if (!['completed', 'voided'].includes(sale.status)) throw E.conflict('A receipt is available once the sale is paid');
    const b = db.get('SELECT * FROM businesses WHERE id = ?', ctx.businessId);
    const loc = db.get('SELECT * FROM locations WHERE id = ?', sale.location_id);
    const s = app.settings.all(ctx.businessId);
    const fmt = fmtFactory(b);
    return {
      kind: 'sale', title: sale.status === 'voided' ? 'SALE — VOIDED' : 'SALES RECEIPT', copy, fmt,
      business: { ...header(b, s), address: loc.address || b.address, phone: loc.phone || b.phone, branch: loc.name },
      number: sale.number, date: sale.completed_at, cashier: s['receipt.show_cashier'] ? sale.cashier_name : null, register: sale.register_name,
      customer: sale.customer_id ? { name: sale.customer_name, phone: maskPhone(sale.customer_phone), code: sale.customer_code, points_earned: sale.loyalty_points_earned, points_balance: sale.customer_points } : null,
      prices_include_tax: !!sale.prices_include_tax,
      items: sale.items.map((i) => ({
        name: i.name, sku: i.sku, qty: i.qty, unit: i.unit, unit_price: i.unit_price, list_price: i.list_price, gross: i.gross,
        discount: i.line_discount + i.cart_discount_alloc, line_discount: i.line_discount, line_total: i.line_total, tax_rate_bp: i.tax_rate_bp,
      })),
      totals: { subtotal: sale.subtotal, discount: sale.discount_total, tax: sale.tax_total, total: sale.total, paid: sale.amount_paid, change: sale.change_given },
      tax_breakdown: s['receipt.show_tax_breakdown'] ? sale.tax_breakdown.filter((t) => t.rate_bp > 0 || t.tax > 0) : [],
      payments: sale.payments.filter((p) => p.status === 'succeeded').map((p) => ({
        method: p.method_name || p.method_code, amount: p.amount, tendered: p.tendered, change: p.change_given,
        reference: maskRef(p.provider_ref || p.reference), manual: p.confirmation_source === 'manual',
      })),
      item_count: sale.items.reduce((a, i) => a + (i.unit === 'each' ? i.qty : 1), 0),
      offline: !!sale.completed_offline,
      void_info: sale.status === 'voided' ? { at: sale.voided_at, by: sale.voided_by_name, reason: sale.void_reason } : null,
    };
  }

  function forRefund(ctx, refundId, { copy = false } = {}) {
    const r = app.refunds.get(ctx, refundId);
    const b = db.get('SELECT * FROM businesses WHERE id = ?', ctx.businessId);
    const loc = db.get('SELECT * FROM locations WHERE id = ?', r.location_id);
    const s = app.settings.all(ctx.businessId);
    return {
      kind: 'refund', title: r.kind === 'void' ? 'VOID RECEIPT' : 'REFUND RECEIPT', copy, fmt: fmtFactory(b),
      business: { ...header(b, s), address: loc.address || b.address, phone: loc.phone || b.phone, branch: loc.name },
      number: r.number, original: r.sale_number, date: r.created_at, cashier: r.requested_by_name, authorized_by: r.authorized_by_name,
      reason: `${r.reason_code.replace(/_/g, ' ')}${r.reason_note ? ` — ${r.reason_note}` : ''}`, status: r.status,
      items: r.items.map((i) => ({ name: i.name, sku: i.sku, qty: i.qty, unit: i.unit, unit_price: i.unit_price, line_total: i.amount, condition: i.condition })),
      totals: { subtotal: r.subtotal, tax: r.tax_total, total: r.total },
      payments: r.payments.filter((p) => p.status !== 'failed').map((p) => ({ method: p.method_code, amount: p.amount, status: p.status, reference: maskRef(p.provider_ref || p.reference) })),
    };
  }

  return { forSale, forRefund };
};
