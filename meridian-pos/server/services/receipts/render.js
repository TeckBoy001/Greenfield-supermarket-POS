'use strict';
/** Receipt renderers: plain text (thermal / ESC-POS / PDF) and HTML (screen + print). */

function pad(l, r, w) {
  l = String(l ?? ''); r = String(r ?? '');
  if (l.length + r.length + 1 > w) l = l.slice(0, Math.max(0, w - r.length - 1));
  return l + ' '.repeat(Math.max(1, w - l.length - r.length)) + r;
}
function center(s, w) { s = String(s ?? '').slice(0, w); const n = Math.floor((w - s.length) / 2); return ' '.repeat(Math.max(0, n)) + s; }
function wrap(s, w) {
  const out = []; let line = '';
  for (const word of String(s ?? '').split(/\s+/)) {
    if ((line + ' ' + word).trim().length > w) { if (line) out.push(line); line = word; } else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out;
}
const qtyStr = (q, unit) => (unit === 'each' ? String(q) : `${Number(q).toFixed(3)} ${unit}`);
const dt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function toText(m, width = 42) {
  const f = m.fmt; const L = []; const rule = '-'.repeat(width); const bold = new Set();
  const b = m.business;
  bold.add(L.length); L.push(center(b.name.toUpperCase(), width));
  if (b.branch) L.push(center(b.branch, width));
  wrap(b.address, width).forEach((x) => L.push(center(x, width)));
  if (b.phone) L.push(center(`Tel: ${b.phone}`, width));
  if (b.tax_id) L.push(center(`TIN: ${b.tax_id}`, width));
  if (b.custom_header) wrap(b.custom_header, width).forEach((x) => L.push(center(x, width)));
  L.push(rule);
  bold.add(L.length); L.push(center(m.title + (m.copy ? ' (COPY)' : ''), width));
  L.push(pad(m.kind === 'sale' ? 'Receipt' : 'Refund', m.number, width));
  if (m.original) L.push(pad('Original sale', m.original, width));
  L.push(pad('Date', dt(m.date), width));
  if (m.cashier) L.push(pad('Cashier', m.cashier, width));
  if (m.register) L.push(pad('Till', m.register, width));
  if (m.authorized_by) L.push(pad('Authorized by', m.authorized_by, width));
  if (m.customer) L.push(pad('Customer', `${m.customer.name} (${m.customer.code})`, width));
  L.push(rule);
  for (const it of m.items) {
    wrap(it.name, width).forEach((x) => L.push(x));
    L.push(pad(`  ${qtyStr(it.qty, it.unit)} x ${f(it.unit_price)}`, f(it.gross ?? it.line_total), width));
    if (it.discount) L.push(pad('  Discount', `-${f(it.discount)}`, width));
    if (it.condition && it.condition !== 'resaleable') L.push(`  (${it.condition.replace('_', ' ')})`);
  }
  L.push(rule);
  if (m.kind === 'sale') {
    L.push(pad('Subtotal', f(m.totals.subtotal), width));
    if (m.totals.discount) L.push(pad('Discounts', `-${f(m.totals.discount)}`, width));
    if (!m.prices_include_tax) L.push(pad('Tax', f(m.totals.tax), width));
    bold.add(L.length); L.push(pad('TOTAL', f(m.totals.total), width));
    L.push(rule);
    for (const p of m.payments) {
      L.push(pad(p.method + (p.manual ? ' (ext.)' : ''), f(p.tendered || p.amount), width));
      if (p.reference) L.push(pad('  Ref', p.reference, width));
    }
    if (m.totals.change) { bold.add(L.length); L.push(pad('CHANGE', f(m.totals.change), width)); }
    if (m.tax_breakdown.length) {
      L.push(rule);
      L.push(pad(m.prices_include_tax ? 'Tax included' : 'Tax', '', width));
      for (const t of m.tax_breakdown) L.push(pad(`  ${(t.rate_bp / 100).toFixed(2)}% on ${f(t.taxable)}`, f(t.tax), width));
    }
    L.push(pad('Items', m.item_count, width));
    if (m.customer && m.customer.points_earned) L.push(pad('Points earned', m.customer.points_earned, width));
    if (m.offline) L.push(center('Processed offline', width));
    if (m.void_info) { L.push(rule); L.push(center(`VOIDED ${dt(m.void_info.at)}`, width)); if (m.void_info.reason) wrap(m.void_info.reason, width).forEach((x) => L.push(center(x, width))); }
  } else {
    L.push(pad('Tax portion', f(m.totals.tax), width));
    bold.add(L.length); L.push(pad('TOTAL REFUNDED', f(m.totals.total), width));
    L.push(rule);
    for (const p of m.payments) L.push(pad(`Refunded to ${p.method}${p.status !== 'succeeded' ? ` (${p.status})` : ''}`, f(p.amount), width));
    L.push(`Reason: ${m.reason}`.slice(0, width));
  }
  L.push(rule);
  if (b.footer) wrap(b.footer, width).forEach((x) => L.push(center(x, width)));
  if (b.website) L.push(center(b.website, width));
  return { lines: L, bold };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toHtml(m, { autoPrint = false } = {}) {
  const f = m.fmt; const b = m.business;
  const row = (l, r, cls = '') => `<div class="row ${cls}"><span>${l}</span><span>${r}</span></div>`;
  const items = m.items.map((it) => `<div class="item"><div class="name">${esc(it.name)}</div>${row(`${esc(qtyStr(it.qty, it.unit))} × ${esc(f(it.unit_price))}`, esc(f(it.gross ?? it.line_total)))}
    ${it.discount ? row('Discount', `−${esc(f(it.discount))}`, 'muted') : ''}${it.condition && it.condition !== 'resaleable' ? `<div class="muted">${esc(it.condition.replace('_', ' '))}</div>` : ''}</div>`).join('');
  let body;
  if (m.kind === 'sale') {
    body = `${row('Subtotal', esc(f(m.totals.subtotal)))}${m.totals.discount ? row('Discounts', `−${esc(f(m.totals.discount))}`) : ''}
      ${!m.prices_include_tax ? row('Tax', esc(f(m.totals.tax))) : ''}${row('TOTAL', esc(f(m.totals.total)), 'total')}<hr>
      ${m.payments.map((p) => row(esc(p.method) + (p.manual ? ' <small>(external)</small>' : ''), esc(f(p.tendered || p.amount))) + (p.reference ? row('Ref', esc(p.reference), 'muted') : '')).join('')}
      ${m.totals.change ? row('CHANGE', esc(f(m.totals.change)), 'total') : ''}
      ${m.tax_breakdown.length ? `<hr><div class="muted">${m.prices_include_tax ? 'Tax included in prices' : 'Tax'}</div>${m.tax_breakdown.map((t) => row(`${(t.rate_bp / 100).toFixed(2)}% on ${esc(f(t.taxable))}`, esc(f(t.tax)), 'muted')).join('')}` : ''}
      ${row('Items', esc(m.item_count), 'muted')}${m.customer && m.customer.points_earned ? row('Points earned', esc(m.customer.points_earned), 'muted') : ''}
      ${m.offline ? '<div class="center muted">Processed offline</div>' : ''}
      ${m.void_info ? `<hr><div class="center stamp">VOIDED</div><div class="center muted">${esc(dt(m.void_info.at))} · ${esc(m.void_info.reason || '')}</div>` : ''}`;
  } else {
    body = `${row('Tax portion', esc(f(m.totals.tax)))}${row('TOTAL REFUNDED', esc(f(m.totals.total)), 'total')}<hr>
      ${m.payments.map((p) => row(`Refunded to ${esc(p.method)}${p.status !== 'succeeded' ? ` (${esc(p.status)})` : ''}`, esc(f(p.amount)))).join('')}
      <div class="muted">Reason: ${esc(m.reason)}</div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.number)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font: 12px/1.35 "Courier New", ui-monospace, monospace; color: #000; background: #fff; margin: 0; }
  .r { width: 72mm; margin: 0 auto; padding: 8px 0; }
  .center { text-align: center; } .muted { color: #444; font-size: 11px; } h1 { font-size: 15px; margin: 4px 0; text-align: center; }
  .row { display: flex; justify-content: space-between; gap: 8px; } .row span:last-child { text-align: right; white-space: nowrap; }
  .total { font-weight: 700; font-size: 14px; margin: 2px 0; } hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .item { margin: 3px 0; } .name { font-weight: 600; } .stamp { font-size: 18px; font-weight: 800; letter-spacing: 4px; }
  .title { text-align: center; font-weight: 700; margin: 4px 0; } img.logo { max-width: 40mm; max-height: 20mm; display: block; margin: 0 auto 4px; }
</style></head><body><div class="r">
${b.logo ? `<img class="logo" alt="" src="${esc(b.logo)}">` : ''}
<h1>${esc(b.name)}</h1>
<div class="center muted">${esc(b.branch || '')}<br>${esc(b.address || '')}${b.phone ? `<br>Tel: ${esc(b.phone)}` : ''}${b.tax_id ? `<br>TIN: ${esc(b.tax_id)}` : ''}</div>
${b.custom_header ? `<div class="center muted">${esc(b.custom_header)}</div>` : ''}
<hr><div class="title">${esc(m.title)}${m.copy ? ' (COPY)' : ''}</div>
${row(m.kind === 'sale' ? 'Receipt' : 'Refund', esc(m.number))}${m.original ? row('Original sale', esc(m.original)) : ''}${row('Date', esc(dt(m.date)))}
${m.cashier ? row('Cashier', esc(m.cashier)) : ''}${m.register ? row('Till', esc(m.register)) : ''}${m.authorized_by ? row('Authorized by', esc(m.authorized_by)) : ''}
${m.customer ? row('Customer', `${esc(m.customer.name)} (${esc(m.customer.code)})`) : ''}
<hr>${items}<hr>${body}<hr>
<div class="center">${esc(b.footer || '')}</div>${b.website ? `<div class="center muted">${esc(b.website)}</div>` : ''}
</div>${autoPrint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),150))</script>' : ''}</body></html>`;
}

module.exports = { toText, toHtml, esc };
