'use strict';
/** Money is always integer minor units. These helpers never use floats for stored values. */

function toInt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('money must be a finite number');
  return Math.round(n);
}

/** Round half away from zero — deterministic for negative values too. */
function roundHalfUp(x) { return x < 0 ? -Math.round(-x) : Math.round(x); }

/** Multiply integer money by a quantity (may be fractional for weighed goods). */
function mulQty(minor, qty) { return roundHalfUp(minor * roundQty(qty)); }

function roundQty(q) { return Math.round(Number(q) * 1000) / 1000; }

/** Percent (e.g. 12.5) of an amount. */
function pct(minor, percent) { return roundHalfUp((minor * percent) / 100); }

/** Tax contained in a tax-inclusive amount; rate in basis points. */
function taxInclusive(amount, bp) { return bp ? roundHalfUp((amount * bp) / (10000 + bp)) : 0; }
/** Tax added on top of a tax-exclusive amount. */
function taxExclusive(amount, bp) { return bp ? roundHalfUp((amount * bp) / 10000) : 0; }

/**
 * Split `total` across `weights` proportionally using the largest-remainder method,
 * so the parts always sum exactly to `total`.
 */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let rem = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < order.length && rem > 0; k++, rem--) floors[order[k][1]]++;
  return floors;
}

function format(minor, currency = 'NGN', minorUnits = 2, locale = 'en-NG') {
  const v = minor / Math.pow(10, minorUnits);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: minorUnits, maximumFractionDigits: minorUnits }).format(v);
  } catch (_) {
    return `${currency} ${v.toFixed(minorUnits)}`;
  }
}

module.exports = { toInt, roundHalfUp, mulQty, roundQty, pct, taxInclusive, taxExclusive, allocate, format };
