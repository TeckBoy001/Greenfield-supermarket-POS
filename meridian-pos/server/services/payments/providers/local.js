'use strict';
const { PaymentProvider } = require('./base');

/** Cash: confirmed locally by the cashier handling notes. Works offline. */
class CashProvider extends PaymentProvider {
  get confirmsLocally() { return true; }
  get capabilities() { return { refunds: true, void: true, webhooks: false, settlementReports: false, statusQuery: false }; }
  async initiatePayment({ amount }) { return { status: 'succeeded', providerStatus: 'cash_received', raw: { amount } }; }
  async voidPayment() { return { status: 'voided' }; }
  async refundPayment() { return { status: 'succeeded', providerStatus: 'cash_paid_out' }; }
}

/**
 * Manual / external confirmation: the payment was taken on equipment this system is NOT
 * integrated with (e.g. a standalone bank card terminal, a cheque, a gift voucher). The cashier
 * records the approval code/reference printed by that device. Marked confirmation_source='manual'
 * so reconciliation can match it against the provider's settlement later.
 */
class ManualProvider extends PaymentProvider {
  get confirmsLocally() { return true; }
  get capabilities() { return { refunds: true, void: true, webhooks: false, settlementReports: false, statusQuery: false }; }
  async initiatePayment({ reference }) {
    if (!reference) return { status: 'failed', failureReason: 'Approval code / reference is required' };
    return { status: 'succeeded', providerStatus: 'manually_confirmed', providerRef: reference };
  }
  async voidPayment() { return { status: 'voided' }; }
  async refundPayment() { return { status: 'succeeded', providerStatus: 'manual_refund_recorded' }; }
}

module.exports = { CashProvider, ManualProvider };
