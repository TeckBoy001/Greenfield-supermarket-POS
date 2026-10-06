'use strict';
/**
 * TEMPLATE for integrating a real payment gateway (card-present terminal SDK, bank-transfer
 * virtual accounts, mobile money, wallets). Not registered by default — copy this file,
 * implement the calls against your provider's API, then register it in providers/index.js.
 *
 * Rules the integration must keep:
 *  - Use the provider's hosted/terminal flow. Never send raw card numbers (PAN), CVV or PIN
 *    through this application; the terminal/hosted page handles card data (PCI scope reduction).
 *  - Send merchantRef (our payment id) as the provider's idempotency key / reference, so a
 *    retried or recovered request can never create a second charge.
 *  - Report 'processing' until the provider confirms; confirmation must come from the provider
 *    (API status or a signature-verified webhook), never from a button in the UI.
 *  - Throw ProviderNetworkError on timeouts / connection failures so the payment stays in flight
 *    and gets re-queried, instead of being marked failed while the customer may have been charged.
 *  - Keep API keys in the SecretStore (secret_ref), never in provider_configs.config_json.
 */
const { PaymentProvider, ProviderNetworkError } = require('./base');

class HttpGatewayTemplate extends PaymentProvider {
  get capabilities() { return { refunds: true, void: true, webhooks: true, settlementReports: true, statusQuery: true }; }

  async request(method, path, body, idempotencyKey) {
    const base = this.config.base_url;
    if (!base) throw new Error(`${this.displayName} is not configured (base_url missing)`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(this.config.timeout_ms || 15000));
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (res.status >= 500) throw new ProviderNetworkError(`${this.displayName} ${res.status}`);
      return { status: res.status, json };
    } catch (e) {
      if (e instanceof ProviderNetworkError) throw e;
      throw new ProviderNetworkError(`${this.displayName} unreachable: ${e.message}`);
    } finally { clearTimeout(timer); }
  }

  // Map your provider's statuses onto: pending | processing | succeeded | failed | cancelled | voided
  // async initiatePayment({ merchantRef, amount, currency, idempotencyKey, metadata }) { ... }
  // async getPaymentStatus({ providerRef, merchantRef }) { ... }
  // async cancelPayment({ providerRef }) { ... }
  // async voidPayment({ providerRef }) { ... }
  // async refundPayment({ providerRef, amount, merchantRef, idempotencyKey }) { ... }
  // async getRefundStatus({ providerRef, merchantRef }) { ... }
  // verifyWebhook(headers, rawBody) { verify HMAC/signature with this.secret, then map event }
  // async fetchSettlements({ from, to }) { ... }
}

module.exports = { HttpGatewayTemplate };
