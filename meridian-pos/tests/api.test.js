'use strict';
/* End-to-end API tests against a real server + database seeded with the demo supermarket.
   Run: npm test   (node --test)  */
process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server/app');
const { ean13 } = require('../server/db/seed');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-test-'));
let srv; let BASE; let db; let app;
const T = {}; // tokens
const R = {}; // register ids
const quiet = () => {};

async function call(method, p, body, { token, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  if (raw) return res;
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const as = (who) => ({ get: (p) => call('GET', p, undefined, { token: T[who] }), post: (p, b = {}, o = {}) => call('POST', p, b, { token: T[who], ...o }), put: (p, b = {}) => call('PUT', p, b, { token: T[who] }), patch: (p, b = {}) => call('PATCH', p, b, { token: T[who] }), del: (p) => call('DELETE', p, undefined, { token: T[who] }) });
const key = (p = 't') => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const SUP = { username: 'supervisor', pin: '3791' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for condition'); await wait(200); } }
const BC = { rice: '6150040000004', coke: '6150040012335', cokeCase: '6150080012333', milk: '6150040024666', pampers: '6150040067137', oil: '6150040076726', wine: '6150040069872', indomieCarton: '6150080008220', sugar: '6150040078096', bread: '6150040032883' };

async function login(who, registerCode) {
  const r = await call('POST', '/api/auth/login', { username: who, password: 'demo1234', register_id: registerCode ? R[registerCode] : undefined });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  T[who] = r.body.token;
  return r.body;
}
async function newSale(who) { const r = await as(who).post('/api/pos/sales'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
async function scan(who, saleId, code, extra = {}) { return as(who).post(`/api/sales/${saleId}/items`, { code, ...extra }); }
async function payCash(who, sale, tendered) { return as(who).post(`/api/sales/${sale.id}/payments`, { method_code: 'cash', tendered: tendered ?? sale.total, idempotency_key: key('cash') }); }
const stockOf = (sku, loc = 'LEK') => db.value(`SELECT s.qty FROM stock_levels s JOIN products p ON p.id = s.product_id JOIN locations l ON l.id = s.location_id WHERE p.sku = ? AND l.code = ?`, sku, loc);
const skuOf = (barcode) => db.value('SELECT p.sku FROM product_barcodes b JOIN products p ON p.id = b.product_id WHERE b.barcode = ?', barcode);

before(async () => {
  srv = await start({ dataDir: DATA, port: 0, seed: 'demo', log: quiet });
  BASE = srv.url; db = srv.app.db; app = srv.app;
  for (const r of db.all('SELECT r.id, r.code, l.code AS loc FROM registers r JOIN locations l ON l.id = r.location_id')) R[`${r.loc}-${r.code}`] = r.id;
  // lane 2 has an open session from the seeded "today"; use lanes 1 and 3 for tests
});
after(async () => { await srv.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

// ───────────────────────── security & auth ─────────────────────────
test('rejects wrong host header (DNS rebinding) and unauthenticated API calls', async () => {
  const http = require('http');
  const status = await new Promise((resolve, reject) => {
    const u = new URL(BASE);
    http.get({ host: u.hostname, port: u.port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 421);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/sales')).status, 401);
});

test('login: bad password fails, lockout after 5 attempts, audit records it', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { username: 'cashier3', password: 'wrong' })).status, 401);
  const r = await call('POST', '/api/auth/login', { username: 'cashier3', password: 'demo1234' });
  assert.equal(r.status, 401);
  assert.match(r.body.error.message, /locked/i);
  assert.ok(db.value(`SELECT COUNT(*) FROM audit_logs WHERE action = 'auth.login.failed'`) >= 5);
  db.run('UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE username = ?', 'cashier3');
});

test('PIN login works and passwords are stored as scrypt hashes', async () => {
  const r = await call('POST', '/api/auth/login', { username: 'cashier2', pin: '2690' });
  assert.equal(r.status, 200);
  const h = db.value('SELECT password_hash FROM users WHERE username = ?', 'cashier2');
  assert.match(h, /^scrypt\$/);
  assert.ok(!h.includes('demo1234'));
});

test('cross-origin writes are refused', async () => {
  await login('cashier1', 'LEK-R01');
  const r = await call('POST', '/api/pos/sales', {}, { token: T.cashier1, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('role permissions are enforced server-side', async () => {
  await login('stock'); await login('finance'); await login('manager'); await login('owner');
  assert.equal((await as('cashier1').get('/api/admin/users')).status, 403);
  assert.equal((await as('cashier1').get('/api/audit')).status, 403);
  assert.equal((await as('cashier1').get('/api/settlements')).status, 403);
  assert.equal((await as('stock').post('/api/pos/sales')).status, 403);
  assert.equal((await as('finance').post('/api/pos/sales')).status, 403);
  assert.equal((await as('manager').get('/api/admin/users')).status, 403); // user management is owner-only by default
  assert.equal((await as('owner').get('/api/admin/users')).status, 200);
  const prod = db.get(`SELECT id, price FROM products WHERE sku = ?`, skuOf(BC.sugar));
  assert.equal((await as('cashier1').put(`/api/products/${prod.id}`, { price: 1 })).status, 403);
  const stockPrice = await as('stock').put(`/api/products/${prod.id}`, { price: prod.price + 100 });
  assert.equal(stockPrice.status, 403, 'inventory staff may edit products but not prices');
  assert.equal(stockPrice.body.error.details.permission, 'product.price');
});

// ───────────────────────── session & scanning ─────────────────────────
test('selling requires an open register session; one open session per register', async () => {
  const r = await as('cashier1').post('/api/pos/sales');
  assert.equal(r.status, 409);
  assert.equal(r.body.error.details.code, 'no_session');
  const o = await as('cashier1').post('/api/sessions/open', { opening_float: 5000000 });
  assert.equal(o.status, 200);
  assert.equal((await as('cashier1').post('/api/sessions/open', { opening_float: 1 })).status, 409);
  assert.equal(o.body.figures.expected_cash, null, 'blind close hides expected cash from cashier');
});

test('scanning: barcode, rescan merges, case barcode, multiplier, scale label, unknown code', async () => {
  const sale = await newSale('cashier1');
  let r = await scan('cashier1', sale.id, BC.coke);
  assert.equal(r.status, 200);
  r = await scan('cashier1', sale.id, BC.coke);
  assert.equal(r.body.items.length, 1); assert.equal(r.body.items[0].qty, 2);
  r = await scan('cashier1', sale.id, BC.cokeCase); // case barcode = 12 units of the same product
  assert.equal(r.body.items.length, 1); assert.equal(r.body.items[0].qty, 14);
  assert.equal(r.body.total, 14 * 50000);
  await as('cashier1').post(`/api/sales/${sale.id}/cancel`, { reason: 'test' });
});

test('scanning details and pricing math', async () => {
  const sale = await newSale('cashier1');
  // merge
  await scan('cashier1', sale.id, BC.milk);
  let r = await scan('cashier1', sale.id, BC.milk);
  const milk = r.body.items.find((i) => i.name.startsWith('Peak Evaporated'));
  assert.equal(milk.qty, 2);
  // multiplier
  r = await scan('cashier1', sale.id, BC.rice, { qty: 3 });
  assert.equal(r.body.items.find((i) => i.name.startsWith('Mama Gold')).qty, 3);
  // carton of 40
  r = await scan('cashier1', sale.id, BC.indomieCarton);
  assert.equal(r.body.items.find((i) => i.name.startsWith('Indomie')).qty, 40);
  // scale label: tomatoes PLU 10001, 1.250 kg
  r = await scan('cashier1', sale.id, ean13('21100010125' + '0'));
  const tom = r.body.items.find((i) => i.name === 'Tomatoes');
  assert.equal(tom.qty, 1.25); assert.equal(tom.line_total, 312500);
  // bad check digit
  const bad = ean13('211000101250'); const flipped = bad.slice(0, 12) + ((Number(bad[12]) + 1) % 10);
  assert.equal((await scan('cashier1', sale.id, flipped)).status, 422);
  // unknown
  assert.equal((await scan('cashier1', sale.id, '0000000000000')).status, 404);
  // totals integrity + VAT extraction (prices include tax)
  const s = r.body;
  const sumLines = s.items.reduce((a, i) => a + i.line_total, 0);
  assert.equal(sumLines, s.total);
  const milkLine = s.items.find((i) => i.name.startsWith('Peak Evaporated'));
  assert.equal(milkLine.tax_amount, Math.round((milkLine.line_total * 750) / 10750));
  assert.equal(s.items.find((i) => i.name.startsWith('Mama Gold')).tax_amount, 0, 'VAT-exempt item');
  await as('cashier1').post(`/api/sales/${sale.id}/cancel`, { reason: 'test' });
});

test('age-restricted items need ID confirmation; inactive products cannot be sold', async () => {
  const sale = await newSale('cashier1');
  let r = await scan('cashier1', sale.id, BC.wine);
  assert.equal(r.status, 409); assert.equal(r.body.error.details.code, 'age_check_required');
  r = await scan('cashier1', sale.id, BC.wine, { age_verified: true });
  assert.equal(r.status, 200);
  const p = db.get('SELECT id FROM products WHERE sku = ?', skuOf(BC.bread));
  db.run('UPDATE products SET is_active = 0 WHERE id = ?', p.id);
  assert.equal((await scan('cashier1', sale.id, BC.bread)).status, 409);
  db.run('UPDATE products SET is_active = 1 WHERE id = ?', p.id);
  await as('cashier1').post(`/api/sales/${sale.id}/cancel`, { reason: 'test' });
});

test('discounts: within limit OK, above limit needs supervisor override, cashier cannot self-approve', async () => {
  const sale = await newSale('cashier1');
  const r1 = await scan('cashier1', sale.id, BC.oil);
  const line = r1.body.items[0];
  let r = await as('cashier1').patch(`/api/sales/${sale.id}/items/${line.id}`, { discount: { type: 'percent', value: 5, reason: 'Damaged packaging' } });
  assert.equal(r.status, 200); assert.equal(r.body.discount_total, 49000);
  r = await as('cashier1').patch(`/api/sales/${sale.id}/items/${line.id}`, { discount: { type: 'percent', value: 20, reason: 'Manager goodwill' } });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'override_required');
  r = await as('cashier1').patch(`/api/sales/${sale.id}/items/${line.id}`, { discount: { type: 'percent', value: 12, reason: 'Manager goodwill' }, override: { username: 'cashier2', pin: '2690' } });
  assert.equal(r.status, 403, 'another cashier (5% limit) cannot approve 12%');
  r = await as('cashier1').patch(`/api/sales/${sale.id}/items/${line.id}`, { discount: { type: 'percent', value: 40, reason: 'Manager goodwill' }, override: SUP });
  assert.equal(r.status, 403, "supervisor's own 15% limit applies");
  r = await as('cashier1').patch(`/api/sales/${sale.id}/items/${line.id}`, { discount: { type: 'percent', value: 12, reason: 'Manager goodwill' }, override: SUP });
  assert.equal(r.status, 200); assert.equal(r.body.discount_total, 117600); assert.equal(r.body.total, 862400);
  const aud = db.get(`SELECT * FROM audit_logs WHERE action = 'sale.discount_line' ORDER BY seq DESC LIMIT 1`);
  assert.ok(aud.approved_by, 'approver recorded');
  // price override needs permission
  r = await as('cashier1').patch(`/api/sales/${sale.id}/items/${line.id}`, { unit_price: 100, reason: 'test' });
  assert.equal(r.status, 403);
  // cart discount allocation keeps totals consistent
  await scan('cashier1', sale.id, BC.milk);
  r = await as('cashier1').post(`/api/sales/${sale.id}/discount`, { type: 'amount', value: 333, reason: 'Loyalty promotion' });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.reduce((a, i) => a + i.line_total, 0), r.body.total);
  assert.equal(r.body.items.reduce((a, i) => a + i.cart_discount_alloc, 0), 333);
  await as('cashier1').post(`/api/sales/${sale.id}/cancel`, { reason: 'test' });
});

// ───────────────────────── payments ─────────────────────────
test('cash sale: change, duplicate submission is idempotent, stock and audit updated', async () => {
  const sku = skuOf(BC.sugar);
  const before = stockOf(sku);
  const sale = await newSale('cashier1');
  const s = (await scan('cashier1', sale.id, BC.sugar, { qty: 2 })).body;
  assert.equal(s.total, 260000);
  const k = key('dup');
  const body = { method_code: 'cash', tendered: 500000, idempotency_key: k };
  const [a, b] = await Promise.all([as('cashier1').post(`/api/sales/${sale.id}/payments`, body), as('cashier1').post(`/api/sales/${sale.id}/payments`, body)]);
  assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status), `${a.status} ${b.status} ${JSON.stringify(b.body)}`);
  assert.equal(a.body.payment.id, b.body.payment.id, 'same payment returned for the same key');
  assert.equal(db.value('SELECT COUNT(*) FROM payments WHERE sale_id = ?', sale.id), 1);
  const done = (await as('cashier1').get(`/api/sales/${sale.id}`)).body;
  assert.equal(done.status, 'completed'); assert.equal(done.change_given, 240000); assert.equal(done.amount_paid, 260000);
  assert.equal(stockOf(sku), before - 2);
  assert.equal(db.value(`SELECT COUNT(*) FROM inventory_movements WHERE reference_id = ? AND type = 'sale'`, sale.id), 1);
  // replay after completion is still harmless
  const again = await as('cashier1').post(`/api/sales/${sale.id}/payments`, body);
  assert.equal(again.body.payment.id, a.body.payment.id);
  // a new key on a completed sale is refused
  assert.equal((await payCash('cashier1', done)).status, 409);
  // completed sales are immutable at the database level
  assert.throws(() => db.run('UPDATE sales SET total = 1 WHERE id = ?', sale.id), /immutable/);
  assert.throws(() => db.run('DELETE FROM sales WHERE id = ?', sale.id), /cannot be deleted/);
  assert.equal((await scan('cashier1', sale.id, BC.sugar)).status, 409);
});

test('card payment is never "succeeded" until the provider confirms (poll)', async () => {
  const sale = await newSale('cashier1');
  const s = (await scan('cashier1', sale.id, BC.pampers)).body;
  const r = await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'card', amount: s.total, idempotency_key: key('card') });
  assert.equal(r.status, 201);
  assert.equal(r.body.payment.status, 'processing');
  assert.equal(r.body.sale.status, 'open');
  // UI "complete" cannot force it
  assert.equal((await as('cashier1').post(`/api/sales/${sale.id}/complete`)).status, 409);
  // a second payment while one is in flight is refused (no double charge)
  assert.equal((await payCash('cashier1', { id: sale.id, total: 100 })).status, 409);
  const ok = await until(async () => { const x = await as('cashier1').post(`/api/payments/${r.body.payment.id}/refresh`); return x.body.payment.status === 'succeeded' && x.body; });
  assert.equal(ok.sale.status, 'completed');
  assert.equal(ok.payment.confirmation_source, 'provider');
});

test('bank transfer confirmed by signed webhook; forged and replayed webhooks are rejected', async () => {
  const sale = await newSale('cashier1');
  const s = (await scan('cashier1', sale.id, BC.oil)).body;
  const r = await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'transfer', amount: s.total, idempotency_key: key('trf') });
  const ref = r.body.payment.provider_ref;
  assert.ok(r.body.payment.instructions_json.includes('account_number'));
  // forged webhook
  const forged = await call('POST', '/api/webhooks/sim-transfer', JSON.stringify({ id: 'evt_x', type: 'charge.succeeded', data: { ref, status: 'succeeded', kind: 'charge' } }), { headers: { 'x-sim-signature': 'deadbeef' } });
  assert.equal(forged.status, 401);
  assert.equal(db.value('SELECT status FROM payments WHERE id = ?', r.body.payment.id), 'processing');
  // real (signed) webhook via simulator
  const provider = app.payments.buildProvider(db.value('SELECT id FROM businesses'), 'sim-transfer');
  const out = provider.simulate(ref, 'approve');
  const w1 = await call('POST', '/api/webhooks/sim-transfer', out.webhook.body, { headers: out.webhook.headers });
  assert.equal(w1.status, 200); assert.equal(w1.body.handled, true);
  const w2 = await call('POST', '/api/webhooks/sim-transfer', out.webhook.body, { headers: out.webhook.headers });
  assert.equal(w2.body.duplicate, true);
  assert.equal((await as('cashier1').get(`/api/sales/${sale.id}`)).body.status, 'completed');
});

test('declined card leaves the sale open; split tender cash + card completes it', async () => {
  const sale = await newSale('cashier1');
  await scan('cashier1', sale.id, BC.oil); // 9,800.00
  const decline = await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'card', amount: 500051, idempotency_key: key('dec') }); // ends in 51 → declined
  const pid = decline.body.payment.id;
  const failed = await until(async () => { const x = await as('cashier1').post(`/api/payments/${pid}/refresh`); return x.body.payment.status === 'failed' && x.body; });
  assert.match(failed.payment.failure_reason, /declined/i);
  assert.equal(failed.sale.status, 'open'); assert.equal(failed.sale.paid, 0);
  const cash = await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'cash', tendered: 300000, idempotency_key: key('c') });
  assert.equal(cash.body.sale.balance_due, 680000); assert.equal(cash.body.payment.change_given, 0);
  // cart is locked once money is taken
  assert.equal((await scan('cashier1', sale.id, BC.milk)).status, 409);
  const card = await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'card', amount: 680000, idempotency_key: key('c2') });
  assert.equal((await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'card', amount: 700000, idempotency_key: key('over') })).status, 409);
  await until(async () => (await as('cashier1').post(`/api/payments/${card.body.payment.id}/refresh`)).body.sale.status === 'completed');
});

test('manual (standalone terminal) payments require an approval code and are flagged manual', async () => {
  const sale = await newSale('cashier1');
  const s = (await scan('cashier1', sale.id, BC.rice)).body;
  assert.equal((await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'ext_pos', amount: s.total, idempotency_key: key('m') })).status, 422);
  const r = await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'ext_pos', amount: s.total, reference: '882211', idempotency_key: key('m2') });
  assert.equal(r.body.payment.confirmation_source, 'manual');
  assert.equal(r.body.sale.status, 'completed');
});

// ───────────────────────── offline & recovery ─────────────────────────
test('offline: electronic payments refused, cash continues, sale flagged and queued; sync on reconnect', async () => {
  await login('owner');
  assert.equal((await as('owner').post('/api/network/simulate', { offline: true })).body.online, false);
  const sale = await newSale('cashier1');
  const s = (await scan('cashier1', sale.id, BC.milk)).body;
  const card = await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'card', amount: s.total, idempotency_key: key('off') });
  assert.equal(card.status, 503); assert.equal(card.body.error.code, 'offline');
  const methods = (await as('cashier1').get('/api/pos/methods')).body;
  assert.equal(methods.find((m) => m.code === 'card').available, false);
  assert.equal(methods.find((m) => m.code === 'cash').available, true);
  const cash = await payCash('cashier1', s);
  assert.equal(cash.body.sale.status, 'completed'); assert.equal(cash.body.sale.completed_offline, 1);
  const pending = db.value(`SELECT status FROM sync_outbox WHERE entity_id = ?`, sale.id);
  assert.equal(pending, 'pending');
  await app.sync.flush();
  assert.equal(db.value(`SELECT status FROM sync_outbox WHERE entity_id = ?`, sale.id), 'pending', 'nothing is pushed while offline');
  await as('owner').post('/api/network/simulate', { offline: false });
  await app.sync.flush();
  assert.equal(db.value(`SELECT status FROM sync_outbox WHERE entity_id = ?`, sale.id), 'sent');
});

test('network drop mid-payment: stays processing, resolves from the provider when back online', async () => {
  const sale = await newSale('cashier1');
  const s = (await scan('cashier1', sale.id, BC.rice)).body;
  const r = await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'transfer', amount: s.total, idempotency_key: key('drop') });
  const pid = r.body.payment.id;
  await as('owner').post('/api/network/simulate', { offline: true });
  app.payments.buildProvider(db.value('SELECT id FROM businesses'), 'sim-transfer').simulate(r.body.payment.provider_ref, 'approve'); // customer paid; webhook can't arrive
  await as('cashier1').post(`/api/payments/${pid}/refresh`);
  assert.equal(db.value('SELECT status FROM payments WHERE id = ?', pid), 'processing', 'not marked paid while provider unreachable');
  assert.equal((await as('cashier1').post(`/api/payments/${pid}/cancel`, {})).status, 503, 'cannot cancel blindly while offline');
  await as('owner').post('/api/network/simulate', { offline: false });
  db.run('UPDATE payments SET next_check_at = NULL WHERE id = ?', pid);
  await app.payments.recoverInflight();
  assert.equal(db.value('SELECT status FROM payments WHERE id = ?', pid), 'succeeded');
  assert.equal(db.value('SELECT status FROM sales WHERE id = ?', sale.id), 'completed');
});

test('hold, resume on another lane, cancel rules', async () => {
  await login('supervisor', 'LEK-R03');
  await as('supervisor').post('/api/sessions/open', { opening_float: 1000000 });
  const sale = await newSale('cashier1');
  await scan('cashier1', sale.id, BC.bread);
  const h = await as('cashier1').post(`/api/sales/${sale.id}/hold`, { label: 'Customer fetching wallet' });
  assert.equal(h.body.status, 'held');
  assert.equal((await scan('cashier1', sale.id, BC.bread)).status, 409);
  const resumed = await as('supervisor').post(`/api/sales/${sale.id}/resume`);
  assert.equal(resumed.status, 200); assert.equal(resumed.body.status, 'open'); assert.equal(resumed.body.register_id, R['LEK-R03']);
  const c = await as('supervisor').post(`/api/sales/${sale.id}/cancel`, { reason: 'Customer left' });
  assert.equal(c.body.status, 'cancelled');
  assert.equal((await as('supervisor').post(`/api/sales/${sale.id}/resume`)).status, 409);
});

// ───────────────────────── refunds & voids ─────────────────────────
test('partial refunds: supervisor approval, exact amounts, stock return, damaged write-off, limits', async () => {
  const sale = await newSale('cashier1');
  await scan('cashier1', sale.id, BC.milk, { qty: 3 });
  await as('cashier1').post(`/api/sales/${sale.id}/discount`, { type: 'amount', value: 100, reason: 'Loyalty promotion' });
  const s = (await as('cashier1').get(`/api/sales/${sale.id}`)).body;
  await payCash('cashier1', s, 200000);
  const line = s.items[0];
  const sku = line.sku; const st0 = stockOf(sku);
  // cashier alone cannot refund
  let r = await as('cashier1').post(`/api/sales/${sale.id}/refunds`, { items: [{ sale_item_id: line.id, qty: 1 }], reason_code: 'damaged', idempotency_key: key('r') });
  assert.equal(r.body.error.code, 'override_required');
  r = await as('cashier1').post(`/api/sales/${sale.id}/refunds`, { items: [{ sale_item_id: line.id, qty: 1, condition: 'damaged' }], reason_code: 'damaged', idempotency_key: key('r'), override: SUP });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.total, Math.round((line.line_total * 1) / 3));
  assert.equal(stockOf(sku), st0, 'damaged: returned then written off');
  assert.equal(db.value(`SELECT COUNT(*) FROM inventory_movements WHERE reference_id = ? AND type IN ('return','damage')`, r.body.id), 2);
  // too many
  r = await as('cashier1').post(`/api/sales/${sale.id}/refunds`, { items: [{ sale_item_id: line.id, qty: 3 }], reason_code: 'customer_return', idempotency_key: key('r'), override: SUP });
  assert.equal(r.status, 422);
  // remainder refund is exact
  r = await as('cashier1').post(`/api/sales/${sale.id}/refunds`, { items: [{ sale_item_id: line.id, qty: 2 }], reason_code: 'customer_return', idempotency_key: key('r'), override: SUP });
  assert.equal(stockOf(sku), st0 + 2);
  const total = db.value('SELECT SUM(total) FROM refunds WHERE sale_id = ?', sale.id);
  assert.equal(total, s.total, 'sum of partial refunds equals what was paid');
  // cash left the drawer
  const sess = (await as('cashier1').get('/api/sessions/current')).body;
  assert.ok(sess.figures.cash_refunds >= s.total);
});

test('card refund goes back through the provider and completes on confirmation', async () => {
  const sale = await newSale('cashier1');
  const s = (await scan('cashier1', sale.id, BC.oil)).body;
  const p = await as('cashier1').post(`/api/sales/${sale.id}/payments`, { method_code: 'card', amount: s.total, idempotency_key: key('cr') });
  await until(async () => (await as('cashier1').post(`/api/payments/${p.body.payment.id}/refresh`)).body.sale.status === 'completed');
  const r = await as('cashier1').post(`/api/sales/${sale.id}/refunds`, { full: true, reason_code: 'customer_return', idempotency_key: key('cr'), override: SUP });
  assert.equal(r.status, 201);
  assert.equal(r.body.payments[0].method_code, 'card');
  assert.equal(r.body.status, 'pending');
  const done = await until(async () => { await app.payments.recoverInflight(); const x = await as('cashier1').get(`/api/refunds/${r.body.id}`); return x.body.status === 'completed' && x.body; });
  assert.equal(done.payments[0].status, 'succeeded');
  // refund receipt renders
  const rr = await call('GET', `/api/refunds/${r.body.id}/receipt?format=text`, undefined, { token: T.cashier1 });
  assert.match(rr.body, /REFUND RECEIPT/);
});

test('void: same session only, reverses stock and cash, cannot be voided twice', async () => {
  const sale = await newSale('cashier1');
  await scan('cashier1', sale.id, BC.rice);
  const s = (await as('cashier1').get(`/api/sales/${sale.id}`)).body;
  const st0 = stockOf(s.items[0].sku);
  await payCash('cashier1', s);
  assert.equal(stockOf(s.items[0].sku), st0 - 1);
  let v = await as('cashier1').post(`/api/sales/${sale.id}/void`, { reason_note: 'Wrong customer', idempotency_key: key('v') });
  assert.equal(v.body.error.code, 'override_required');
  v = await as('cashier1').post(`/api/sales/${sale.id}/void`, { reason_note: 'Wrong customer', idempotency_key: key('v'), override: SUP });
  assert.equal(v.status, 201);
  assert.equal((await as('cashier1').get(`/api/sales/${sale.id}`)).body.status, 'voided');
  assert.equal(stockOf(s.items[0].sku), st0);
  assert.equal((await as('cashier1').post(`/api/sales/${sale.id}/void`, { reason_note: 'x', idempotency_key: key('v'), override: SUP })).status, 409);
  // a sale from a previous (closed) session cannot be voided — only refunded
  const old = db.get(`SELECT s.id FROM sales s JOIN register_sessions rs ON rs.id = s.session_id WHERE rs.status = 'closed' AND s.status = 'completed' LIMIT 1`);
  const r = await as('supervisor').post(`/api/sales/${old.id}/void`, { reason_note: 'x', idempotency_key: key('v') });
  assert.equal(r.status, 409);
});

// ───────────────────────── cashier session close ─────────────────────────
test('cash in/out and close: expected cash from ledgers, denominations, variance review', async () => {
  let r = await as('cashier1').post('/api/sessions/cash-movement', { type: 'paid_out', amount: 50000, reason: 'Cleaning supplies' });
  assert.equal(r.body.error.code, 'override_required');
  r = await as('cashier1').post('/api/sessions/cash-movement', { type: 'paid_out', amount: 50000, reason: 'Cleaning supplies', override: SUP });
  assert.equal(r.status, 200);
  const sess = (await as('cashier1').get('/api/sessions/current')).body;
  const f = app.sessions.figures(sess.id);
  assert.equal(f.expected_cash, f.opening_float + f.cash_sales - f.cash_refunds + f.paid_in - f.paid_out - f.cash_drops);
  // close short by 1,000.00 with a denomination count
  const target = f.expected_cash - 100000;
  const n1000 = Math.floor(target / 100000); const rest = target - n1000 * 100000;
  const denoms = { 100000: n1000 }; if (rest) denoms[rest] = 1; // (rest as a single "note" — just for the arithmetic check)
  r = await as('cashier1').post(`/api/sessions/${sess.id}/close`, { denominations: denoms, note: 'test close' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.variance, -100000);
  assert.equal(r.body.review_status, 'required');
  assert.equal((await as('cashier1').post(`/api/sessions/${sess.id}/review`, { note: 'ok' })).status, 403);
  r = await as('manager').post(`/api/sessions/${sess.id}/review`, { note: 'Recount confirmed shortage; cashier briefed' });
  assert.equal(r.body.review_status, 'approved');
  assert.throws(() => db.run('UPDATE register_sessions SET counted_cash = 1 WHERE id = ?', sess.id), /immutable/);
});

// ───────────────────────── inventory & catalogue ─────────────────────────
test('inventory: stocktake, write-off, receiving with cost permission, transfer limits, full history', async () => {
  const p = db.get('SELECT id, sku, cost FROM products WHERE sku = ?', skuOf(BC.bread));
  const loc = db.value(`SELECT id FROM locations WHERE code = 'LEK'`); const whs = db.value(`SELECT id FROM locations WHERE code = 'WHS'`);
  let r = await as('stock').post('/api/inventory/adjust', { product_id: p.id, location_id: loc, type: 'stocktake', counted_qty: 50, reason: 'Monthly count' });
  assert.equal(r.body.balance, 50);
  r = await as('stock').post('/api/inventory/adjust', { product_id: p.id, location_id: loc, type: 'expired', qty: 4, reason: 'Past date' });
  assert.equal(r.body.balance, 46);
  assert.equal((await as('cashier1').post('/api/inventory/adjust', { product_id: p.id, location_id: loc, type: 'damage', qty: 1, reason: 'x' })).status, 403);
  assert.equal((await as('stock').post('/api/inventory/receive', { location_id: loc, update_cost: true, items: [{ product_id: p.id, qty: 10, unit_cost: 1 }] })).status, 403);
  r = await as('stock').post('/api/inventory/receive', { location_id: loc, supplier_ref: 'INV-1', items: [{ product_id: p.id, qty: 10, unit_cost: 150000 }] });
  assert.equal(r.status, 201);
  assert.equal(stockOf(p.sku), 56);
  r = await as('manager').post('/api/inventory/transfer', { from_location_id: loc, to_location_id: whs, items: [{ product_id: p.id, qty: 9999 }] });
  assert.equal(r.status, 409);
  const hist = (await as('stock').get(`/api/inventory/movements?product_id=${p.id}&location_id=${loc}&limit=500`)).body;
  const sum = hist.reduce((a, m) => a + m.qty_change, 0);
  assert.equal(Math.round(sum * 1000) / 1000, 56, 'stock level equals the sum of its movements');
  assert.throws(() => db.run('DELETE FROM inventory_movements WHERE product_id = ?', p.id), /append-only/);
});

test('products: create with barcode, duplicate barcode refused, price change audited', async () => {
  const cat = db.value('SELECT id FROM categories LIMIT 1');
  const loc = db.value(`SELECT id FROM locations WHERE code = 'LEK'`);
  let r = await as('manager').post('/api/products', { name: 'Test Honey 500g', sku: 'TST-1', barcode: '6159999000019', price: 450000, cost: 380000, category_id: cat, opening_stock: 12, location_id: loc });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.stock_by_location.find((x) => x.location_id === loc).qty, 12);
  assert.equal((await as('manager').post('/api/products', { name: 'Dup', sku: 'TST-2', barcode: '6159999000019', price: 1 })).status, 409);
  r = await as('manager').put(`/api/products/${r.body.id}`, { price: 470000 });
  assert.equal(r.body.price, 470000);
  const a = db.get(`SELECT * FROM audit_logs WHERE action = 'product.price_change' AND reference = 'TST-1'`);
  assert.equal(JSON.parse(a.old_value).price, 450000); assert.equal(JSON.parse(a.new_value).price, 470000);
  // new price is used at the till immediately (same central catalogue)
  await login('cashier2', 'LEK-R02');
  const sale = await newSale('cashier2');
  const s = await scan('cashier2', sale.id, '6159999000019');
  assert.equal(s.body.items[0].unit_price, 470000);
  await as('cashier2').post(`/api/sales/${sale.id}/cancel`, { reason: 'test' });
});

// ───────────────────────── finance ─────────────────────────
test('settlements, payouts with segregation of duties, and reconciliation', async () => {
  const r = await as('finance').post('/api/settlements/fetch', { provider_code: 'sim-card', include_today: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.imported >= 1);
  const stl = db.get(`SELECT * FROM settlements WHERE provider_settlement_ref = ?`, r.body.results[0].ref);
  assert.equal(stl.status, 'matched');
  assert.equal(stl.net_amount, stl.gross_amount - stl.refund_amount - stl.fee_amount);
  // discrepancy detection (test injection)
  const sale = await newSale('cashier2');
  const s = (await scan('cashier2', sale.id, BC.pampers)).body;
  const p = await as('cashier2').post(`/api/sales/${sale.id}/payments`, { method_code: 'card', amount: s.total, idempotency_key: key('st') });
  await until(async () => (await as('cashier2').post(`/api/payments/${p.body.payment.id}/refresh`)).body.sale.status === 'completed');
  const d = await as('finance').post('/api/settlements/fetch', { provider_code: 'sim-card', include_today: true, simulate_discrepancy: true });
  const bad = db.get(`SELECT * FROM settlements WHERE provider_settlement_ref = ?`, d.body.results[0].ref);
  assert.equal(bad.status, 'discrepancy');
  // funds received → provider payout
  const rec = await as('finance').post(`/api/settlements/${stl.id}/received`, { bank_reference: 'STMT-1' });
  assert.equal(rec.status, 201); assert.equal(rec.body.type, 'provider_payout'); assert.equal(rec.body.status, 'paid');
  assert.equal((await as('finance').post(`/api/settlements/${stl.id}/received`, { bank_reference: 'STMT-2' })).status, 409, 'cannot receive more than net');
  // outbound payout: request → self-approval refused → approve by owner → paid
  const bank = db.value(`SELECT id FROM financial_accounts WHERE code = 'BANK-OPS'`);
  const po = await as('finance').post('/api/payouts', { type: 'supplier_payment', amount: 1000000, source_account_id: bank, destination_note: 'Supplier X', reason: 'Invoice 42' });
  assert.equal(po.body.status, 'pending_approval');
  assert.equal((await as('finance').post(`/api/payouts/${po.body.id}/approve`)).status, 403);
  assert.throws(() => db.run('UPDATE payouts SET approved_by = requested_by WHERE id = ?', po.body.id), /CHECK/);
  assert.equal((await as('owner').post(`/api/payouts/${po.body.id}/approve`)).body.status, 'approved');
  assert.equal((await as('finance').post(`/api/payouts/${po.body.id}/mark_paid`, { reference: 'TRF-99' })).body.status, 'paid');
  assert.equal((await as('cashier1').get('/api/payouts')).status, 403);
  // reconciliation of today
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
  const rc = await as('finance').post('/api/reconciliation/run', { business_date: today });
  assert.equal(rc.status, 201);
  const salesItem = rc.body.items.find((i) => i.category === 'sales');
  assert.equal(salesItem.status, 'matched', 'every completed sale is fully covered by recorded payments');
  // settlements pay out T+1, so the injected unknown line shows up on the settlement's own date
  const rc2 = await as('finance').post('/api/reconciliation/run', { business_date: bad.settlement_date });
  assert.ok(rc2.body.items.some((i) => i.category === 'settlement' && i.status === 'discrepancy'), 'unknown settlement line flagged');
  assert.equal(rc2.body.status, 'discrepancy');
  const item = rc2.body.items.find((i) => i.status === 'discrepancy');
  const res = await as('finance').post(`/api/reconciliation/items/${item.id}/resolve`, { note: 'Raised with provider, ticket 123' });
  assert.equal(res.body.items.find((i) => i.id === item.id).status, 'resolved');
  void rc;
  assert.throws(() => db.run('UPDATE reconciliation_items SET actual = 0 WHERE id = ?', item.id), /immutable/);
});

// ───────────────────────── receipts, reports, audit ─────────────────────────
test('receipts render as HTML (escaped), text and PDF', async () => {
  const cat = db.value('SELECT id FROM categories LIMIT 1');
  await as('manager').post('/api/products', { name: '<img src=x onerror=alert(1)> Evil', sku: 'XSS-1', barcode: '6159999000026', price: 1000, category_id: cat });
  const sale = await newSale('cashier2');
  const s = (await scan('cashier2', sale.id, '6159999000026')).body;
  await payCash('cashier2', s);
  const h = await call('GET', `/api/sales/${sale.id}/receipt?format=html`, undefined, { token: T.cashier2 });
  assert.equal(h.status, 200);
  assert.ok(h.body.includes('Greenfield Supermarket'));
  assert.ok(!h.body.includes('<img src=x'), 'user content is escaped');
  assert.match(h.headers.get('content-security-policy'), /default-src 'none'/);
  const pdf = await call('GET', `/api/sales/${sale.id}/receipt?format=pdf`, undefined, { token: T.cashier2, raw: true });
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  const d = await as('cashier2').post('/api/receipts/deliver', { sale_id: sale.id, channel: 'email', destination: 'a@b.co' });
  assert.equal(d.body.status, 'not_configured', 'no pretend delivery without a gateway');
});

test('reports agree with the ledger and export to CSV/PDF', async () => {
  const r = await as('manager').get('/api/reports/sales_summary?period=this_month');
  assert.equal(r.status, 200);
  const tz = 'Africa/Lagos';
  const { resolvePeriod } = require('../server/lib/time');
  const P = resolvePeriod({ period: 'this_month' }, tz);
  const direct = db.value(`SELECT COALESCE(SUM(total),0) FROM sales WHERE status IN ('completed','voided') AND completed_at >= ? AND completed_at < ?`, P.from, P.to);
  assert.equal(r.body.summary.sales, direct);
  const csv = await call('GET', '/api/reports/product_performance/export?period=this_week&format=csv', undefined, { token: T.manager, raw: true });
  const text = await csv.text();
  assert.match(text.split('\n')[0], /SKU/);
  const pdf = await call('GET', '/api/reports/tax/export?period=this_week&format=pdf', undefined, { token: T.finance, raw: true });
  assert.equal(Buffer.from(await pdf.arrayBuffer()).slice(0, 5).toString(), '%PDF-');
  assert.equal((await as('cashier1').get('/api/reports/tax?period=today')).status, 403);
  const dash = await as('manager').get('/api/dashboard');
  assert.equal(dash.status, 200); assert.ok(dash.body.today.transactions > 0);
});

test('audit log is append-only and tamper-evident', async () => {
  const v = await as('owner').get('/api/audit/verify');
  assert.equal(v.body.ok, true);
  assert.throws(() => db.run('UPDATE audit_logs SET action = ? WHERE seq = 1', 'x'), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit_logs WHERE seq = 1'), /append-only/);
  // simulate an attacker with raw DB access who drops the trigger and edits history
  db.exec('DROP TRIGGER audit_no_update');
  db.run(`UPDATE audit_logs SET new_value = '{"total":1}' WHERE seq = 5`);
  const bad = app.audit.verify();
  assert.equal(bad.ok, false); assert.equal(bad.brokenAt, 5);
});

test('application restart: open cart and in-flight payment survive and are recovered', async () => {
  const sale = await newSale('cashier2');
  const s = (await scan('cashier2', sale.id, BC.oil)).body;
  const p = await as('cashier2').post(`/api/sales/${sale.id}/payments`, { method_code: 'card', amount: s.total, idempotency_key: key('rst') });
  assert.equal(p.body.payment.status, 'processing');
  // "crash": stop the server without completing anything
  await srv.close();
  await wait(2800); // provider approves the charge while we're down (auto_approve after 2.5s)
  srv = await start({ dataDir: DATA, port: 0, seed: 'demo', log: quiet });
  BASE = srv.url; db = srv.app.db; app = srv.app;
  // startup recovery re-queries the provider
  await until(async () => db.value('SELECT status FROM sales WHERE id = ?', sale.id) === 'completed', 10000);
  assert.equal(db.value('SELECT status FROM payments WHERE id = ?', p.body.payment.id), 'succeeded');
  // tokens persist server-side (sessions are DB-backed), so the cashier can continue
  const st = await as('cashier2').get('/api/pos/state');
  assert.equal(st.status, 200);
  assert.equal(db.value('SELECT COUNT(*) FROM payments WHERE sale_id = ?', sale.id), 1, 'no duplicate charge after restart');
});

test('node:sqlite fallback driver passes a smoke check', async () => {
  const { Database } = require('../server/db/driver');
  const d = new Database(':memory:', { driver: 'node' });
  assert.equal(d.driverName, 'node:sqlite');
  d.exec('CREATE TABLE t (a INTEGER)');
  d.tx(() => d.run('INSERT INTO t VALUES (?)', 1));
  assert.throws(() => d.tx(() => { d.run('INSERT INTO t VALUES (?)', 2); throw new Error('boom'); }));
  assert.equal(d.value('SELECT COUNT(*) FROM t'), 1, 'rollback on error');
  d.close();
});
