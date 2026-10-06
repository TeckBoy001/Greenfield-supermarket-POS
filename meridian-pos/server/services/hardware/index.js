'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { nowIso } = require('../../lib/ids');

/**
 * Hardware abstraction. Each device kind has adapters with an honest integration status:
 *   integrated   – implemented and exercised in this build
 *   experimental – implemented to the published protocol but NOT verified on physical hardware
 *   not_integrated – interface only; add an adapter to support it
 * The POS calls these services, never device protocols directly, so adding a device never
 * requires changes to checkout code.
 */
const DEVICES = {
  barcode_scanner: {
    label: 'Barcode scanner',
    adapters: {
      keyboard_wedge: { status: 'integrated', note: 'USB/Bluetooth scanners in keyboard-emulation (HID) mode. Burst detection + Enter suffix in the checkout screen.' },
      serial: { status: 'not_integrated', note: 'Serial/COM-port scanners: add an adapter that forwards codes to POST /api/pos/sales/:id/items {code}.' },
    },
  },
  receipt_printer: {
    label: 'Receipt printer',
    adapters: {
      system: { status: 'integrated', note: 'Any printer installed in the OS, via the desktop print dialog / silent print (80mm HTML receipt).' },
      escpos_network: { status: 'experimental', note: 'ESC/POS over TCP port 9100 (Epson/Xprinter compatible). Not verified on a physical printer in this build.' },
      file_spool: { status: 'integrated', note: 'Writes ESC/POS-ready text to a spool folder. For testing and for print-server pickup.' },
    },
  },
  cash_drawer: {
    label: 'Cash drawer',
    adapters: {
      none: { status: 'integrated', note: 'No drawer control; opening events are still logged.' },
      escpos_kick: { status: 'experimental', note: 'Drawer kick pulse (ESC p) through an ESC/POS network printer. Not verified on hardware.' },
    },
  },
  customer_display: {
    label: 'Customer display',
    adapters: {
      window: { status: 'integrated', note: 'Second window for a customer-facing monitor (Desktop app → View → Customer display).' },
      pole_display: { status: 'not_integrated', note: 'VFD pole displays (serial) need an adapter.' },
    },
  },
  payment_terminal: {
    label: 'Card / payment terminal',
    adapters: {
      provider_adapter: { status: 'integrated', note: 'Handled through Payment Provider adapters. Only simulated test terminals are included; a real terminal needs its vendor SDK adapter.' },
      standalone: { status: 'integrated', note: 'Non-integrated bank terminal: cashier records the approval code (manual confirmation, reconciled against settlements).' },
    },
  },
  label_printer: {
    label: 'Shelf / label printer',
    adapters: { none: { status: 'not_integrated', note: 'Not integrated. Product data is available via CSV export for label software.' } },
  },
  scale: {
    label: 'Weighing scale',
    adapters: {
      label_barcodes: { status: 'integrated', note: 'Price/weight-embedded EAN-13 labels from label scales (prefix 21/22).' },
      serial_scale: { status: 'not_integrated', note: 'Direct serial scale reading not integrated — cashier types the weight.' },
    },
  },
};

const ESC = '\x1b'; const GS = '\x1d';
function escposFromLines(lines, bold = new Set(), { cut = true, kick = false } = {}) {
  let out = `${ESC}@`;
  lines.forEach((l, i) => { out += bold.has(i) ? `${ESC}E\x01${l}${ESC}E\x00\n` : `${l}\n`; });
  out += '\n\n\n';
  if (cut) out += `${GS}V\x42\x00`;
  if (kick) out += `${ESC}p\x00\x19\xfa`;
  return Buffer.from(out, 'latin1');
}

function sendTcp(host, port, buf, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port }, () => { s.end(buf); });
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(new Error('Printer timeout')); });
    s.on('error', reject);
    s.on('close', (hadErr) => { if (!hadErr) resolve(); });
  });
}

module.exports = function hardwareService(app, { spoolDir }) {
  const { db } = app;

  function list(ctx) {
    const s = app.settings.all(ctx.businessId);
    const selected = {
      barcode_scanner: 'keyboard_wedge', receipt_printer: s['hardware.receipt_printer'], cash_drawer: s['hardware.cash_drawer'],
      customer_display: s['hardware.customer_display'], payment_terminal: 'provider_adapter', label_printer: 'none', scale: 'label_barcodes',
    };
    return Object.entries(DEVICES).map(([kind, d]) => ({
      kind, label: d.label, selected: selected[kind],
      adapters: Object.entries(d.adapters).map(([code, a]) => ({ code, ...a })),
    }));
  }

  function openDrawer(ctx, reason) {
    const s = app.settings.all(ctx.businessId);
    if (!s['pos.open_drawer_on_cash']) return;
    const mode = s['hardware.cash_drawer'];
    // Drawer opens are a loss-prevention signal; record them regardless of hardware.
    app.audit.log(ctx, 'drawer.open', { reference: reason, meta: { adapter: mode } });
    if (mode === 'escpos_kick' && s['hardware.receipt_printer_host']) {
      const [host, port] = s['hardware.receipt_printer_host'].split(':');
      sendTcp(host, Number(port || 9100), Buffer.from(`${ESC}p\x00\x19\xfa`, 'latin1')).catch(() => {});
    }
  }

  /** Server-side printing for ESC/POS or spool adapters. 'system' printing is done by the desktop shell. */
  async function print(ctx, { saleId, refundId }) {
    const s = app.settings.all(ctx.businessId);
    const mode = s['hardware.receipt_printer'];
    if (mode === 'system') return { handled_by: 'desktop', message: 'Use the desktop print dialog' };
    const m = saleId ? app.receiptModel.forSale(ctx, saleId) : app.receiptModel.forRefund(ctx, refundId);
    const { toText } = require('../receipts/render');
    const t = toText(m, s['receipt.width_chars']);
    const buf = escposFromLines(t.lines, t.bold, { kick: s['hardware.cash_drawer'] === 'escpos_kick' });
    if (mode === 'file_spool') {
      fs.mkdirSync(spoolDir, { recursive: true });
      const file = path.join(spoolDir, `${m.number}-${Date.now()}.txt`);
      fs.writeFileSync(file, t.lines.join('\n'));
      if (saleId) app.receipts.recordPrint(ctx, saleId);
      return { handled_by: 'file_spool', file };
    }
    if (mode === 'escpos_network') {
      const [host, port] = String(s['hardware.receipt_printer_host'] || '').split(':');
      if (!host) throw new Error('Printer host not configured (Settings → Hardware)');
      await sendTcp(host, Number(port || 9100), buf);
      if (saleId) app.receipts.recordPrint(ctx, saleId);
      return { handled_by: 'escpos_network', sent_bytes: buf.length, at: nowIso() };
    }
    throw new Error(`Unknown printer adapter ${mode}`);
  }

  void db;
  return { list, openDrawer, print, escposFromLines, DEVICES };
};
