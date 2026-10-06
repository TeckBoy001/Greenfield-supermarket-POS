// Customer-facing display: read-only view of the lane's current basket.
import { get, setToken } from './api.js';
import { S, html, mount, money, qty } from './ui.js';

const m = /token=([^&]+)/.exec(location.hash);
if (m) { setToken(decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname); }
const root = document.getElementById('cd');

async function tick() {
  let d;
  try { d = await get('/api/pos/display'); } catch (e) { mount(root, html`<div class="cd-welcome"><div><h1>Welcome</h1><p>${e.status === 401 ? 'Display signed out — reopen it from the till.' : 'Waiting for the till…'}</p></div></div>`); return; }
  S.me = { business: { ...d.business, timezone: 'UTC' } };
  const s = d.sale && d.sale.item_count ? d.sale : null;
  if (!s && d.last) {
    const l = d.last;
    mount(root, html`<div class="cd"><div class="cd-items"><h1>Thank you for shopping with us</h1>${l.items.map((i) => html`<div class="cd-line"><span><span class="q">${qty(i.qty, i.unit)} ×</span>${i.name}</span><span class="t">${money(i.total)}</span></div>`)}</div>
      <div class="cd-side"><div class="cd-label">Paid</div><div class="cd-total">${money(l.paid)}</div>${l.change ? html`<div class="cd-label" style="margin-top:20px">Your change</div><div class="cd-total" style="color:#7fe0c3">${money(l.change)}</div>` : ''}<div class="cd-thanks" style="margin-top:24px">Thank you!</div></div></div>`);
    return;
  }
  if (!s) { mount(root, html`<div class="cd-welcome"><div><h1>Welcome to ${d.business.name}</h1><p>${d.register ? `${d.register.location} · ${d.register.name}` : ''}</p></div></div>`); return; }
  mount(root, html`<div class="cd"><div class="cd-items"><h1>Your items (${s.item_count})</h1>${s.items.map((i) => html`<div class="cd-line"><span><span class="q">${qty(i.qty, i.unit)} ×</span>${i.name}</span><span class="t">${money(i.total)}</span></div>`)}</div>
    <div class="cd-side"><div class="row2"><span>Subtotal</span><span>${money(s.subtotal)}</span></div>${s.discount ? html`<div class="row2"><span>You saved</span><span>${money(s.discount)}</span></div>` : ''}
      <div class="cd-label" style="margin-top:12px">Total to pay</div><div class="cd-total">${money(s.total)}</div>${s.paid ? html`<div class="row2" style="margin-top:12px"><span>Paid</span><span>${money(s.paid)}</span></div><div class="row2"><span>Remaining</span><span>${money(s.due)}</span></div>` : ''}</div></div>`);
}
tick();
setInterval(tick, 1000);
