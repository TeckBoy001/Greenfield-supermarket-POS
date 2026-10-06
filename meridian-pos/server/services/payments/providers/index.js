'use strict';
const { CashProvider, ManualProvider } = require('./local');
const { SimulatedGateway } = require('./simulated');

/**
 * Provider registry. provider_code (stored on payment methods and payments) → adapter class.
 * To add a real gateway: implement PaymentProvider (see http-gateway-template.js) and add it here.
 */
const REGISTRY = {
  cash: { Class: CashProvider, name: 'Cash drawer', kind: 'local', status: 'integrated' },
  manual: { Class: ManualProvider, name: 'External terminal / manual confirmation', kind: 'local', status: 'integrated' },
  'sim-card': { Class: SimulatedGateway, name: 'Simulated card terminal (TEST MODE)', kind: 'simulated', status: 'test_only', defaults: { kind: 'card', scenario: 'auto_approve', delay_ms: 2500 } },
  'sim-transfer': { Class: SimulatedGateway, name: 'Simulated bank transfer (TEST MODE)', kind: 'simulated', status: 'test_only', defaults: { kind: 'bank_transfer', scenario: 'await_customer' } },
  'sim-wallet': { Class: SimulatedGateway, name: 'Simulated mobile money / wallet (TEST MODE)', kind: 'simulated', status: 'test_only', defaults: { kind: 'mobile_money', scenario: 'await_customer' } },
};

function buildProvider(app, businessId, providerCode) {
  const entry = REGISTRY[providerCode];
  if (!entry) throw new Error(`No adapter registered for provider "${providerCode}"`);
  const cfgRow = app.db.get('SELECT * FROM provider_configs WHERE business_id = ? AND provider_code = ?', businessId, providerCode);
  if (cfgRow && !cfgRow.is_active) throw new Error(`${entry.name} is disabled`);
  const config = { ...(entry.defaults || {}), ...(cfgRow ? JSON.parse(cfgRow.config_json || '{}') : {}) };
  const secret = cfgRow && cfgRow.secret_ref ? app.secrets.get(cfgRow.secret_ref) : null;
  return new entry.Class({ code: providerCode, displayName: cfgRow ? cfgRow.display_name : entry.name, config, app, businessId, secret });
}

module.exports = { REGISTRY, buildProvider };
