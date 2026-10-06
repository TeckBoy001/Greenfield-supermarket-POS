'use strict';
const { mulQty, pct, allocate, taxInclusive, taxExclusive, roundHalfUp } = require('../lib/money');

/**
 * Pure pricing engine. Deterministic integer arithmetic; the sum of line totals always equals the sale total.
 *
 * Per line: gross = qty × unit_price → minus line discount → minus allocated cart discount → tax.
 * Cart discounts are spread over discountable lines by largest-remainder allocation so refunds of
 * individual items return exactly the discounted amount the customer paid.
 * pricesIncludeTax: shelf prices contain tax (tax is extracted) vs tax added on top.
 */
function lineDiscountAmount(gross, type, value) {
  if (!type || !value) return 0;
  if (type === 'percent') return Math.min(gross, pct(gross, value));
  return Math.min(gross, roundHalfUp(value));
}

function computeSale(items, cartDiscount, pricesIncludeTax) {
  const lines = items.map((it) => {
    const gross = mulQty(it.unit_price, it.qty);
    const lineDisc = it.allow_discount === 0 ? 0 : lineDiscountAmount(gross, it.line_discount_type, it.line_discount_value);
    return { gross, line_discount: lineDisc, afterLine: gross - lineDisc, discountable: it.allow_discount !== 0 };
  });

  let cartAmount = 0;
  const base = lines.reduce((a, l) => a + (l.discountable ? l.afterLine : 0), 0);
  if (cartDiscount && cartDiscount.type && cartDiscount.value) {
    cartAmount = cartDiscount.type === 'percent' ? pct(base, cartDiscount.value) : roundHalfUp(cartDiscount.value);
    cartAmount = Math.max(0, Math.min(cartAmount, base));
  }
  const alloc = allocate(cartAmount, lines.map((l) => (l.discountable ? l.afterLine : 0)));

  const totals = { subtotal: 0, discount_total: 0, tax_total: 0, total: 0, cart_discount: cartAmount, tax_breakdown: {} };
  const out = lines.map((l, i) => {
    const net = l.afterLine - alloc[i];
    const bp = items[i].tax_rate_bp || 0;
    const tax = pricesIncludeTax ? taxInclusive(net, bp) : taxExclusive(net, bp);
    const lineTotal = pricesIncludeTax ? net : net + tax;
    totals.subtotal += l.gross;
    totals.discount_total += l.line_discount + alloc[i];
    totals.tax_total += tax;
    totals.total += lineTotal;
    const key = String(bp);
    const tb = totals.tax_breakdown[key] || (totals.tax_breakdown[key] = { rate_bp: bp, taxable: 0, tax: 0 });
    tb.taxable += pricesIncludeTax ? net - tax : net;
    tb.tax += tax;
    return { gross: l.gross, line_discount: l.line_discount, cart_discount_alloc: alloc[i], tax_amount: tax, line_total: lineTotal };
  });
  return { lines: out, totals };
}

module.exports = { computeSale, lineDiscountAmount };
