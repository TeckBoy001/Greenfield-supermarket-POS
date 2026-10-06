'use strict';
const { newId, nowIso } = require('../../lib/ids');
const { E } = require('../../lib/errors');
const { v } = require('../../lib/validate');
const { textPdf } = require('../../lib/pdf');
const { toText, toHtml } = require('./render');

/**
 * Receipt service: rendering + delivery.
 * Delivery channels are adapters. Email/SMS/WhatsApp are NOT connected to any gateway out of the box:
 * requests are recorded with status 'not_configured' so nothing pretends a message was sent.
 * Implement a DeliveryAdapter { send({channel, destination, subject, text, pdf}) } and register it.
 */
module.exports = function receiptService(app) {
  const { db } = app;
  const adapters = {}; // channel -> adapter; empty by default (honest: not integrated)

  function registerAdapter(channel, adapter) { adapters[channel] = adapter; }

  function model(ctx, { saleId, refundId, copy }) {
    return saleId ? app.receiptModel.forSale(ctx, saleId, { copy }) : app.receiptModel.forRefund(ctx, refundId, { copy });
  }

  function render(ctx, { saleId, refundId, format = 'html', copy = false, autoPrint = false }) {
    const m = model(ctx, { saleId, refundId, copy });
    const width = app.settings.get(ctx.businessId, 'receipt.width_chars') || 42;
    if (format === 'text') return { contentType: 'text/plain; charset=utf-8', body: toText(m, width).lines.join('\n') };
    if (format === 'pdf') {
      const t = toText(m, width);
      const height = Math.max(300, t.lines.length * 11.25 + 60);
      return { contentType: 'application/pdf', body: textPdf(t.lines, { pageWidth: 250, pageHeight: height, fontSize: 9, margin: 14, boldLines: t.bold, title: m.number }), filename: `${m.number}.pdf` };
    }
    if (format === 'json') { const { fmt, ...rest } = m; void fmt; return { contentType: 'application/json', body: JSON.stringify(rest) }; }
    return { contentType: 'text/html; charset=utf-8', body: toHtml(m, { autoPrint }) };
  }

  /** Record a print (first print is the original; later ones are copies). */
  function recordPrint(ctx, saleId) {
    const sale = app.sales.loadSale(ctx, saleId);
    db.run('UPDATE sales SET receipt_print_count = receipt_print_count + 1 WHERE id = ?', saleId);
    if (sale.receipt_print_count >= 1) app.audit.log(ctx, 'receipt.reprint', { entityType: 'sale', entityId: saleId, reference: sale.number, meta: { count: sale.receipt_print_count + 1 } });
    db.run(`INSERT INTO receipt_deliveries (id,business_id,sale_id,channel,status,created_by,created_at) VALUES (?,?,?,?,?,?,?)`, newId('rcd'), ctx.businessId, saleId, 'print', 'done', ctx.user.id, nowIso());
    return { copy: sale.receipt_print_count >= 1 };
  }

  async function deliver(ctx, body) {
    const saleId = v.str(body, 'sale_id', { max: 64 });
    const refundId = v.str(body, 'refund_id', { max: 64 });
    if (!saleId && !refundId) throw E.validation('sale_id or refund_id is required');
    const channel = v.oneOf(body, 'channel', ['email', 'sms', 'whatsapp'], { required: true });
    const destination = channel === 'email' ? v.email(body, 'destination', { required: true }) : v.phone(body, 'destination', { required: true });
    const m = model(ctx, { saleId, refundId });
    const id = newId('rcd');
    const adapter = adapters[channel];
    let status = 'not_configured'; let detail = `No ${channel} gateway is configured. Configure a delivery adapter in Settings → Receipts.`;
    if (adapter) {
      try {
        const t = toText(m);
        await adapter.send({ channel, destination, subject: `${m.business.name} receipt ${m.number}`, text: t.lines.join('\n'), pdf: textPdf(t.lines, { pageWidth: 250, pageHeight: Math.max(300, t.lines.length * 11.25 + 60), margin: 14 }) });
        status = 'sent'; detail = null;
      } catch (e) { status = 'failed'; detail = e.message; }
    }
    // store a masked destination only (data minimization)
    const masked = channel === 'email' ? destination.replace(/^(.).*(@.*)$/, '$1***$2') : destination.replace(/.(?=.{3})/g, '•');
    db.run(`INSERT INTO receipt_deliveries (id,business_id,sale_id,refund_id,channel,destination,status,detail,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.businessId, saleId, refundId, channel, masked, status, detail, ctx.user.id, nowIso());
    return { id, status, detail };
  }

  return { render, recordPrint, deliver, registerAdapter, model };
};
