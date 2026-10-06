'use strict';
const { nowIso } = require('../lib/ids');

/** Business preferences with typed defaults. Every change is audited with old/new values. */
const DEFAULTS = {
  'receipt.header': '',
  'receipt.footer': 'Thank you for shopping with us!',
  'receipt.show_tax_breakdown': true,
  'receipt.show_cashier': true,
  'receipt.width_chars': 42,
  'receipt.auto_print': false,
  'pos.allow_negative_stock': true,
  'pos.require_customer_for_electronic': false,
  'pos.blind_close': true,                   // cashier counts before seeing expected cash
  'pos.variance_review_threshold': 50000,    // minor units; larger variances need manager review
  'pos.idle_lock_minutes': 10,
  'pos.quick_cash_notes': [100000, 50000, 20000, 10000],
  'pos.cash_denominations': [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 100, 50],
  'pos.void_window': 'same_session',
  'pos.open_drawer_on_cash': true,
  'barcode.variable_weight_enabled': true,
  'barcode.variable_weight_prefixes': ['21', '22'],
  'barcode.variable_weight_mode': 'weight_grams', // digits 8-12 = weight in grams (EAN-13 in-store format)
  'loyalty.enabled': false,
  'loyalty.points_per_currency_unit': 0,       // points per 1 major currency unit; 0 = off
  'security.session_idle_minutes': 60,
  'security.session_max_hours': 14,
  'security.max_failed_logins': 5,
  'security.lockout_minutes': 15,
  'network.simulate_offline': false,
  'sync.adapter': 'sim-hq',
  'sync.endpoint': '',
  'hardware.receipt_printer': 'system',
  'hardware.receipt_printer_host': '',
  'hardware.cash_drawer': 'none',
  'hardware.customer_display': 'window',
  'refund.require_receipt': true,
  'refund.max_days': 30,
  'delivery.email': 'not_configured',
  'delivery.sms': 'not_configured',
  'delivery.whatsapp': 'not_configured',
  'system.demo_mode': false,                  // shows demo sign-in helpers on the login screen
};

module.exports = function settingsService(app) {
  const { db } = app;
  const cache = new Map();

  function all(businessId) {
    if (cache.has(businessId)) return cache.get(businessId);
    const out = { ...DEFAULTS };
    for (const r of db.all('SELECT key, value_json FROM settings WHERE business_id = ?', businessId)) {
      try { out[r.key] = JSON.parse(r.value_json); } catch (_) { /* ignore bad row */ }
    }
    cache.set(businessId, out);
    return out;
  }
  const get = (businessId, key) => all(businessId)[key];

  function set(ctx, key, value) {
    if (!(key in DEFAULTS)) throw new Error(`unknown setting ${key}`);
    const def = DEFAULTS[key];
    if (typeof def === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    if (typeof def === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${key} must be a number`);
    if (Array.isArray(def) && !Array.isArray(value)) throw new Error(`${key} must be a list`);
    if (typeof def === 'string' && typeof value !== 'string') throw new Error(`${key} must be text`);
    const old = get(ctx.businessId, key);
    db.run(`INSERT INTO settings (business_id,key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?)
            ON CONFLICT(business_id,key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    ctx.businessId, key, JSON.stringify(value), nowIso(), ctx.user ? ctx.user.id : null);
    cache.delete(ctx.businessId);
    if (JSON.stringify(old) !== JSON.stringify(value)) app.audit.log(ctx, 'settings.change', { entityType: 'setting', entityId: key, reference: key, oldValue: old, newValue: value });
  }

  return { all, get, set, DEFAULTS, invalidate: (b) => cache.delete(b) };
};
module.exports.DEFAULTS = DEFAULTS;
