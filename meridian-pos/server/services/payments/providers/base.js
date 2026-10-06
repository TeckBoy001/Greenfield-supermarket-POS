'use strict';
/**
 * Payment provider adapter contract.
 *
 * Every provider (cash drawer, manual/external terminal, a real gateway such as a card-terminal
 * SDK or a bank-transfer API) implements this interface. The PaymentService never talks to a
 * gateway directly and never decides that an electronic payment succeeded on its own — it only
 * records what the adapter reports, and the adapter must get that from the provider
 * (API response, status query or signed webhook).
 *
 * Result object returned by initiate/getStatus/cancel/voidPayment:
 *   { status: 'pending'|'processing'|'succeeded'|'failed'|'cancelled'|'voided',
 *     providerRef?: string, providerStatus?: string, instructions?: object, failureReason?: string, raw?: object }
 *
 * Throw ProviderNetworkError when the provider could not be reached or the response was lost.
 * The service will then keep the payment in-flight and re-query status (by merchantRef) later —
 * which is why adapters must support lookup by our merchant reference (idempotency).
 */
class ProviderNetworkError extends Error {
  constructor(msg) { super(msg); this.name = 'ProviderNetworkError'; }
}

class PaymentProvider {
  constructor({ code, displayName, config = {}, app, businessId, secret }) {
    this.code = code;
    this.displayName = displayName;
    this.config = config;
    this.app = app;
    this.businessId = businessId;
    this.secret = secret;
  }
  /** Does this adapter confirm locally (cash, manual) — i.e. can it work offline? */
  get confirmsLocally() { return false; }
  get capabilities() { return { refunds: false, void: false, webhooks: false, settlementReports: false, statusQuery: false }; }
  async healthCheck() { return { ok: true }; }
  // eslint-disable-next-line no-unused-vars
  async initiatePayment(req) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  async getPaymentStatus({ providerRef, merchantRef }) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  async cancelPayment({ providerRef, merchantRef }) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  async voidPayment({ providerRef }) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  async refundPayment({ providerRef, amount, merchantRef, idempotencyKey }) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  async getRefundStatus({ providerRef, merchantRef }) { throw new Error('not implemented'); }
  /** @returns {{eventId, type, providerRef, merchantRef, status, raw}} or throws if the signature is invalid */
  // eslint-disable-next-line no-unused-vars
  verifyWebhook(headers, rawBody) { throw new Error('webhooks not supported'); }
  // eslint-disable-next-line no-unused-vars
  async fetchSettlements({ from, to }) { return []; }
}

module.exports = { PaymentProvider, ProviderNetworkError };
