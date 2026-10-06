'use strict';
const { E } = require('./lib/errors');
const { toCsv } = require('./lib/csv');
const { textPdf } = require('./lib/pdf');
const money = require('./lib/money');
const { resolvePeriod } = require('./lib/time');
const { REGISTRY } = require('./services/payments/providers');

const raw = (contentType, body, filename, inline = false) => ({ __raw: true, contentType, body, filename, inline });
const created = (data) => ({ __status: 201, data });

module.exports = function routes(r, app) {
  const { db } = app;
  const P = { public: true };
  const range = (ctx, q) => {
    if (!q.period && !q.from) return {};
    const tz = db.value('SELECT timezone FROM businesses WHERE id = ?', ctx.businessId);
    try { const x = resolvePeriod({ period: q.period || 'custom', from: q.from, to: q.to }, tz); return { from: x.from, to: x.to }; } catch (e) { throw E.validation(e.message); }
  };
  const num = (x, d) => (x === undefined || x === '' ? d : Math.max(0, Math.min(Number(x) || 0, 1000)));

  // ── public ──
  r.add('GET', '/api/health', () => ({ ok: true, driver: db.driverName, time: new Date().toISOString() }), P);
  r.add('GET', '/api/bootstrap', () => {
    const b = db.get('SELECT id, name, logo_data, currency FROM businesses ORDER BY created_at LIMIT 1');
    if (!b) return { configured: false };
    return {
      configured: true, business: { name: b.name, logo: b.logo_data, currency: b.currency }, demo: !!app.settings.get(b.id, 'system.demo_mode'),
      registers: db.all(`SELECT r.id, r.code, r.name, l.name AS location_name, l.code AS location_code FROM registers r JOIN locations l ON l.id = r.location_id WHERE l.business_id = ? AND r.is_active = 1 AND l.is_active = 1 ORDER BY l.code, r.code`, b.id),
    };
  }, P);
  r.add('POST', '/api/auth/login', ({ body, headers }) => app.auth.login({ username: body.username, password: body.password, pin: body.pin, registerId: body.register_id, client: headers['user-agent'] }), P);
  r.add('POST', '/api/webhooks/:provider', ({ params, raw: rawBody, headers }) => {
    if (!REGISTRY[params.provider]) throw E.notFound('Provider');
    return app.payments.handleWebhook(params.provider, headers, rawBody);
  }, { public: true, rawBody: true });

  // ── session / me ──
  r.add('POST', '/api/auth/logout', ({ ctx }) => { app.auth.logout(ctx); return { ok: true }; });
  r.add('GET', '/api/me', ({ ctx }) => {
    const b = db.get('SELECT id, name, legal_name, currency, currency_minor, locale, timezone, prices_include_tax, logo_data FROM businesses WHERE id = ?', ctx.businessId);
    const reg = ctx.registerId ? db.get(`SELECT r.id, r.code, r.name, l.id AS location_id, l.name AS location_name FROM registers r JOIN locations l ON l.id = r.location_id WHERE r.id = ?`, ctx.registerId) : null;
    const s = app.settings.all(ctx.businessId);
    return {
      user: app.auth.publicUser(ctx.user), permissions: [...ctx.perms], business: b, register: reg,
      settings: Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith('pos.') || k.startsWith('receipt.') || k.startsWith('hardware.') || k === 'network.simulate_offline' || k.startsWith('refund.'))),
      discount_limit: app.auth.discountLimit(ctx.user.id),
    };
  });
  r.add('POST', '/api/me/password', ({ ctx, body }) => app.admin.changeOwnPassword(ctx, body));
  r.add('POST', '/api/me/pin', ({ ctx, body }) => app.admin.changeOwnPin(ctx, body));
  r.add('GET', '/api/lookups', ({ ctx }) => ({
    locations: db.all('SELECT id, code, name, type FROM locations WHERE business_id = ? AND is_active = 1 ORDER BY name', ctx.businessId),
    registers: db.all('SELECT r.id, r.code, r.name, r.location_id FROM registers r JOIN locations l ON l.id = r.location_id WHERE l.business_id = ? ORDER BY r.code', ctx.businessId),
    categories: db.all('SELECT id, name FROM categories WHERE business_id = ? AND is_active = 1 ORDER BY name', ctx.businessId),
    suppliers: db.all('SELECT id, name FROM suppliers WHERE business_id = ? AND is_active = 1 ORDER BY name', ctx.businessId),
    tax_rates: db.all('SELECT id, code, name, rate_bp FROM tax_rates WHERE business_id = ? AND is_active = 1 ORDER BY rate_bp DESC', ctx.businessId),
    methods: db.all('SELECT code, name, type FROM payment_methods WHERE business_id = ? ORDER BY sort_order', ctx.businessId),
    staff: app.auth.can(ctx, 'report.view') || app.auth.can(ctx, 'sale.view_all') || app.auth.can(ctx, 'session.manage_all')
      ? db.all('SELECT id, full_name FROM users WHERE business_id = ? ORDER BY full_name', ctx.businessId) : [],
    accounts: db.all('SELECT id, code, name, type, provider_code FROM financial_accounts WHERE business_id = ? AND is_active = 1 ORDER BY name', ctx.businessId),
    refund_reasons: app.refunds.REASONS,
    payout_types: app.payouts.TYPES,
  }));

  // ── POS ──
  r.add('GET', '/api/pos/state', ({ ctx }) => ({
    session: app.sessions.current(ctx), sale: app.sales.currentOpen(ctx), held: app.sales.held(ctx).length,
    methods: app.payments.methods(ctx), network: app.connectivity.status(ctx.businessId),
  }));
  r.add('GET', '/api/pos/methods', ({ ctx }) => app.payments.methods(ctx));
  r.add('GET', '/api/pos/lookup', ({ ctx, query }) => {
    const s = app.sessions.current(ctx);
    const loc = s ? s.location_id : (ctx.registerId ? db.value('SELECT location_id FROM registers WHERE id = ?', ctx.registerId) : null);
    const hit = app.catalog.lookupScan(ctx, query.code, loc);
    if (!hit) throw E.notFound('Product');
    if (hit.error) throw E.validation(hit.error);
    return hit;
  });
  r.add('GET', '/api/pos/held', ({ ctx }) => app.sales.held(ctx));
  r.add('GET', '/api/pos/display', ({ ctx }) => {
    const reg = ctx.registerId ? db.get('SELECT r.name, l.name AS location FROM registers r JOIN locations l ON l.id = r.location_id WHERE r.id = ?', ctx.registerId) : null;
    const b = db.get('SELECT name, currency, currency_minor, locale, logo_data FROM businesses WHERE id = ?', ctx.businessId);
    const open = ctx.registerId ? db.get(`SELECT id FROM sales WHERE register_id = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1`, ctx.registerId) : null;
    const last = ctx.registerId ? db.get(`SELECT id, completed_at FROM sales WHERE register_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`, ctx.registerId) : null;
    const pick = (id) => { const s = app.sales.get(ctx, id); return { number: s.number, status: s.status, items: s.items.slice(-8).map((i) => ({ name: i.name, qty: i.qty, unit: i.unit, total: i.line_total })), item_count: s.items.length, subtotal: s.subtotal, discount: s.discount_total, tax: s.tax_total, total: s.total, paid: s.paid, due: s.balance_due, change: s.change_given, completed_at: s.completed_at }; };
    const recent = last && Date.now() - new Date(last.completed_at) < 45000;
    return { business: b, register: reg, sale: open ? pick(open.id) : null, last: recent ? pick(last.id) : null };
  });

  // ── sales ──
  r.add('POST', '/api/pos/sales', ({ ctx }) => app.sales.get(ctx, app.sales.create(ctx)));
  r.add('GET', '/api/sales', ({ ctx, query }) => app.sales.list(ctx, { ...query, ...range(ctx, query), cashierId: query.cashier_id, registerId: query.register_id, customerId: query.customer_id, paymentMethod: query.payment_method, limit: num(query.limit, 100), offset: num(query.offset, 0) }));
  r.add('GET', '/api/sales/:id', ({ ctx, params }) => app.sales.get(ctx, params.id));
  r.add('POST', '/api/sales/:id/items', ({ ctx, params, body }) => app.sales.addItem(ctx, params.id, body));
  r.add('PATCH', '/api/sales/:id/items/:itemId', ({ ctx, params, body }) => app.sales.updateItem(ctx, params.id, params.itemId, body));
  r.add('DELETE', '/api/sales/:id/items/:itemId', ({ ctx, params }) => app.sales.removeItem(ctx, params.id, params.itemId));
  r.add('POST', '/api/sales/:id/discount', ({ ctx, params, body }) => app.sales.setCartDiscount(ctx, params.id, body));
  r.add('POST', '/api/sales/:id/customer', ({ ctx, params, body }) => app.sales.setCustomer(ctx, params.id, body));
  r.add('POST', '/api/sales/:id/hold', ({ ctx, params, body }) => app.sales.hold(ctx, params.id, body));
  r.add('POST', '/api/sales/:id/resume', ({ ctx, params }) => app.sales.resume(ctx, params.id));
  r.add('POST', '/api/sales/:id/cancel', ({ ctx, params, body }) => app.sales.cancel(ctx, params.id, body));
  r.add('POST', '/api/sales/:id/complete', ({ ctx, params }) => app.sales.complete(ctx, params.id));
  r.add('POST', '/api/sales/:id/payments', async ({ ctx, params, body }) => created(await app.payments.create(ctx, params.id, body)));
  r.add('GET', '/api/sales/:id/receipt', ({ ctx, params, query }) => {
    const out = app.receipts.render(ctx, { saleId: params.id, format: query.format || 'html', copy: query.copy === '1' });
    return raw(out.contentType, out.body, out.filename, query.download !== '1');
  });
  r.add('POST', '/api/sales/:id/receipt/printed', ({ ctx, params }) => app.receipts.recordPrint(ctx, params.id));
  r.add('POST', '/api/sales/:id/receipt/hardware', async ({ ctx, params }) => app.hardware.print(ctx, { saleId: params.id }));
  r.add('POST', '/api/receipts/deliver', ({ ctx, body }) => app.receipts.deliver(ctx, body));
  r.add('POST', '/api/sales/:id/refunds', async ({ ctx, params, body }) => created(await app.refunds.create(ctx, params.id, body)));
  r.add('POST', '/api/sales/:id/void', async ({ ctx, params, body }) => created(await app.refunds.void(ctx, params.id, body)));

  // ── payments ──
  r.add('GET', '/api/payments', ({ ctx, query }) => app.payments.list(ctx, { ...query, ...range(ctx, query) }));
  r.add('GET', '/api/payments/:id', ({ ctx, params }) => app.payments.detail(ctx, params.id));
  r.add('POST', '/api/payments/:id/refresh', async ({ ctx, params }) => {
    const p = db.get('SELECT * FROM payments WHERE id = ? AND business_id = ?', params.id, ctx.businessId);
    if (!p) throw E.notFound('Payment');
    if (p.created_by !== ctx.user.id && !app.auth.can(ctx, 'payment.resolve')) throw E.forbidden();
    await app.payments.refresh(ctx, params.id);
    return { payment: db.get('SELECT * FROM payments WHERE id = ?', params.id), sale: app.sales.get(ctx, p.sale_id) };
  });
  r.add('POST', '/api/payments/:id/cancel', async ({ ctx, params, body }) => {
    const p = await app.payments.cancel(ctx, params.id, body);
    return { payment: p, sale: app.sales.get(ctx, p.sale_id) };
  });
  // Test-mode simulator: plays the customer/bank side of a simulated provider, then delivers a signed webhook.
  r.add('POST', '/api/sim/:provider/:ref/:action', ({ ctx, params }) => {
    const reg = REGISTRY[params.provider];
    if (!reg || reg.kind !== 'simulated') throw E.forbidden('Simulator is only available for TEST-MODE simulated providers');
    app.auth.require(ctx, 'pos.sell');
    const provider = app.payments.buildProvider(ctx.businessId, params.provider);
    let out;
    try { out = provider.simulate(params.ref, params.action); } catch (e) { throw E.validation(e.message); }
    let delivered = false;
    if (out.webhook && app.connectivity.isOnline(ctx.businessId)) {
      app.payments.handleWebhook(params.provider, out.webhook.headers, out.webhook.body, ctx.businessId);
      delivered = true;
    }
    app.audit.log(ctx, 'simulator.action', { reference: params.ref, meta: { provider: params.provider, action: params.action, webhook_delivered: delivered } });
    return { provider_status: out.tx.status, webhook_delivered: delivered };
  });

  // ── refunds ──
  r.add('GET', '/api/refunds', ({ ctx, query }) => app.refunds.list(ctx, { ...query, ...range(ctx, query) }));
  r.add('GET', '/api/refunds/:id', ({ ctx, params }) => app.refunds.get(ctx, params.id));
  r.add('GET', '/api/refunds/:id/receipt', ({ ctx, params, query }) => { const out = app.receipts.render(ctx, { refundId: params.id, format: query.format || 'html' }); return raw(out.contentType, out.body, out.filename, query.download !== '1'); });
  r.add('POST', '/api/refund-payments/:id/retry', async ({ ctx, params, body }) => app.refunds.retryPayment(ctx, params.id, body));

  // ── sessions ──
  r.add('GET', '/api/sessions/current', ({ ctx }) => { const s = app.sessions.current(ctx); return s ? app.sessions.get(ctx, s.id) : null; });
  r.add('POST', '/api/sessions/open', ({ ctx, body }) => app.sessions.open(ctx, body));
  r.add('POST', '/api/sessions/cash-movement', ({ ctx, body }) => app.sessions.cashMovement(ctx, body));
  r.add('GET', '/api/sessions', ({ ctx, query }) => app.sessions.list(ctx, { ...query, ...range(ctx, query), userId: query.user_id }));
  r.add('GET', '/api/sessions/:id', ({ ctx, params }) => app.sessions.get(ctx, params.id));
  r.add('POST', '/api/sessions/:id/close', ({ ctx, params, body }) => app.sessions.close(ctx, params.id, body));
  r.add('POST', '/api/sessions/:id/review', ({ ctx, params, body }) => app.sessions.review(ctx, params.id, body));

  // ── catalogue ──
  r.add('GET', '/api/products', ({ ctx, query }) => {
    app.auth.require(ctx, 'product.view');
    return app.catalog.search(ctx, { q: query.q, categoryId: query.category_id, active: query.active || 'active', lowStock: query.low_stock === '1', locationId: query.location_id, limit: num(query.limit, 50), offset: num(query.offset, 0) });
  });
  r.add('GET', '/api/products/export', ({ ctx }) => {
    app.auth.require(ctx, 'product.view');
    const loc = db.value(`SELECT id FROM locations WHERE business_id = ? ORDER BY created_at LIMIT 1`, ctx.businessId);
    const rows = app.catalog.search(ctx, { active: 'all', locationId: loc, limit: 100000 }).rows;
    const cols = [{ key: 'sku', label: 'SKU' }, { key: 'barcode', label: 'Barcode' }, { key: 'name', label: 'Name' }, { key: 'category_name', label: 'Category' }, { key: 'brand', label: 'Brand' }, { key: 'unit', label: 'Unit' },
      { key: 'price', label: 'Price', csv: (x) => (x.price / 100).toFixed(2) }, ...(app.auth.can(ctx, 'report.financial') ? [{ key: 'cost', label: 'Cost', csv: (x) => (x.cost / 100).toFixed(2) }] : []),
      { key: 'tax_name', label: 'Tax' }, { key: 'stock', label: 'Stock' }, { key: 'min_stock', label: 'Min stock' }, { key: 'is_active', label: 'Active' }];
    return raw('text/csv; charset=utf-8', toCsv(cols, rows), 'products.csv');
  });
  r.add('GET', '/api/products/:id', ({ ctx, params, query }) => { app.auth.require(ctx, 'product.view'); return app.catalog.getProduct(ctx, params.id, query.location_id); });
  r.add('POST', '/api/products', ({ ctx, body }) => created(app.catalog.createProduct(ctx, body)));
  r.add('PUT', '/api/products/:id', ({ ctx, params, body }) => app.catalog.updateProduct(ctx, params.id, body));
  r.add('POST', '/api/products/:id/barcodes', ({ ctx, params, body }) => app.catalog.addBarcodeRoute(ctx, params.id, body));
  r.add('DELETE', '/api/products/:id/barcodes/:bid', ({ ctx, params }) => app.catalog.removeBarcode(ctx, params.id, params.bid));
  r.add('GET', '/api/categories', ({ ctx }) => app.catalog.listCategories(ctx));
  r.add('POST', '/api/categories', ({ ctx, body }) => ({ id: app.catalog.saveCategory(ctx, null, body) }));
  r.add('PUT', '/api/categories/:id', ({ ctx, params, body }) => ({ id: app.catalog.saveCategory(ctx, params.id, body) }));
  r.add('GET', '/api/suppliers', ({ ctx }) => app.catalog.listSuppliers(ctx));
  r.add('POST', '/api/suppliers', ({ ctx, body }) => ({ id: app.catalog.saveSupplier(ctx, null, body) }));
  r.add('PUT', '/api/suppliers/:id', ({ ctx, params, body }) => ({ id: app.catalog.saveSupplier(ctx, params.id, body) }));
  r.add('GET', '/api/tax-rates', ({ ctx }) => app.catalog.listTaxRates(ctx));
  r.add('POST', '/api/tax-rates', ({ ctx, body }) => ({ id: app.catalog.saveTaxRate(ctx, null, body) }));
  r.add('PUT', '/api/tax-rates/:id', ({ ctx, params, body }) => ({ id: app.catalog.saveTaxRate(ctx, params.id, body) }));

  // ── inventory ──
  r.add('GET', '/api/inventory/movements', ({ ctx, query }) => { app.auth.require(ctx, 'inventory.view'); return app.inventory.movements(ctx, { ...query, ...range(ctx, query), productId: query.product_id, locationId: query.location_id, limit: num(query.limit, 200) }); });
  r.add('POST', '/api/inventory/adjust', ({ ctx, body }) => app.inventory.adjust(ctx, body));
  r.add('POST', '/api/inventory/receive', ({ ctx, body }) => created(app.inventory.receive(ctx, body)));
  r.add('POST', '/api/inventory/transfer', ({ ctx, body }) => created(app.inventory.transfer(ctx, body)));
  r.add('GET', '/api/inventory/low-stock', ({ ctx, query }) => { app.auth.require(ctx, 'inventory.view'); return app.inventory.lowStock(ctx, query.location_id, 500); });
  r.add('GET', '/api/inventory/receipts', ({ ctx }) => {
    app.auth.require(ctx, 'inventory.view');
    return db.all(`SELECT g.*, s.name AS supplier_name, l.name AS location_name, u.full_name AS received_by_name, (SELECT COUNT(*) FROM goods_receipt_items i WHERE i.receipt_id = g.id) AS lines
      FROM goods_receipts g LEFT JOIN suppliers s ON s.id = g.supplier_id JOIN locations l ON l.id = g.location_id JOIN users u ON u.id = g.received_by WHERE g.business_id = ? ORDER BY g.created_at DESC LIMIT 100`, ctx.businessId);
  });

  // ── customers ──
  r.add('GET', '/api/customers', ({ ctx, query }) => app.customers.list(ctx, { q: query.q, limit: num(query.limit, 50), offset: num(query.offset, 0) }));
  r.add('GET', '/api/customers/:id', ({ ctx, params }) => app.customers.get(ctx, params.id));
  r.add('POST', '/api/customers', ({ ctx, body }) => created(app.customers.create(ctx, body)));
  r.add('PUT', '/api/customers/:id', ({ ctx, params, body }) => app.customers.update(ctx, params.id, body));

  // ── finance ──
  r.add('GET', '/api/settlements', ({ ctx, query }) => app.settlements.list(ctx, query));
  r.add('POST', '/api/settlements/fetch', async ({ ctx, body }) => app.settlements.fetchFromProvider(ctx, body));
  r.add('POST', '/api/settlements/manual', ({ ctx, body }) => created(app.settlements.importManual(ctx, body)));
  r.add('GET', '/api/settlements/:id', ({ ctx, params }) => app.settlements.get(ctx, params.id));
  r.add('POST', '/api/settlements/:id/resolve', ({ ctx, params, body }) => app.settlements.resolve(ctx, params.id, body));
  r.add('POST', '/api/settlements/:id/received', ({ ctx, params, body }) => created(app.payouts.confirmSettlementReceived(ctx, params.id, body)));
  r.add('GET', '/api/payouts', ({ ctx, query }) => app.payouts.list(ctx, { ...query, ...range(ctx, query) }));
  r.add('POST', '/api/payouts', ({ ctx, body }) => created(app.payouts.request(ctx, body)));
  r.add('GET', '/api/payouts/:id', ({ ctx, params }) => app.payouts.get(ctx, params.id));
  r.add('POST', '/api/payouts/:id/:action', ({ ctx, params, body }) => app.payouts.transition(ctx, params.id, params.action, body));
  r.add('GET', '/api/accounts', ({ ctx }) => app.payouts.accounts(ctx));
  r.add('POST', '/api/accounts', ({ ctx, body }) => ({ id: app.payouts.saveAccount(ctx, null, body) }));
  r.add('PUT', '/api/accounts/:id', ({ ctx, params, body }) => ({ id: app.payouts.saveAccount(ctx, params.id, body) }));
  r.add('GET', '/api/reconciliation', ({ ctx, query }) => app.reconciliation.list(ctx, query));
  r.add('POST', '/api/reconciliation/run', ({ ctx, body }) => created(app.reconciliation.run(ctx, body)));
  r.add('GET', '/api/reconciliation/:id', ({ ctx, params }) => app.reconciliation.get(ctx, params.id));
  r.add('POST', '/api/reconciliation/items/:id/resolve', ({ ctx, params, body }) => app.reconciliation.resolveItem(ctx, params.id, body));

  // ── reports & dashboard ──
  r.add('GET', '/api/dashboard', ({ ctx, query }) => app.dashboard.get(ctx, query));
  r.add('GET', '/api/reports', ({ ctx }) => app.reports.catalog(ctx));
  r.add('GET', '/api/reports/:key', ({ ctx, params, query }) => app.reports.run(ctx, params.key, query));
  r.add('GET', '/api/reports/:key/export', ({ ctx, params, query }) => {
    const rep = app.reports.run(ctx, params.key, query);
    const b = db.get('SELECT name, currency, currency_minor, locale FROM businesses WHERE id = ?', ctx.businessId);
    const div = Math.pow(10, b.currency_minor);
    const fmtCell = (c, row) => {
      const x = row[c.key];
      if (x === null || x === undefined) return '';
      if (c.type === 'money') return (x / div).toFixed(b.currency_minor);
      if (c.type === 'pct') return `${x}`;
      return x;
    };
    const fname = `${params.key}-${rep.period ? `${rep.period.from}_${rep.period.to}` : new Date().toISOString().slice(0, 10)}`;
    if (query.format === 'pdf') {
      const cols = rep.columns;
      const widths = cols.map((c) => Math.min(28, Math.max(c.label.length, ...rep.rows.slice(0, 500).map((row) => String(c.type === 'money' ? money.format(row[c.key] || 0, b.currency, b.currency_minor, b.locale) : (row[c.key] ?? '')).length))));
      const cell = (c, s, w) => { s = String(s ?? '').slice(0, w); return ['money', 'int', 'qty', 'pct'].includes(c.type) ? s.padStart(w) : s.padEnd(w); };
      const lines = [`${b.name} — ${rep.title}`, rep.period ? `Period: ${rep.period.from} to ${rep.period.to}` : `As of ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by ${ctx.user.full_name}`, ''];
      lines.push(cols.map((c, i) => cell(c, c.label, widths[i])).join('  '));
      lines.push(cols.map((c, i) => '-'.repeat(widths[i])).join('  '));
      for (const row of rep.rows) lines.push(cols.map((c, i) => cell(c, c.type === 'money' ? money.format(row[c.key] || 0, b.currency, b.currency_minor, b.locale) : (c.type === 'datetime' && row[c.key] ? String(row[c.key]).slice(0, 16).replace('T', ' ') : row[c.key]), widths[i])).join('  '));
      if (rep.summary && Object.keys(rep.summary).length) {
        lines.push('', 'Summary');
        for (const [k, val] of Object.entries(rep.summary)) {
          const col = cols.find((c) => c.key === k);
          const isMoney = (col && col.type === 'money') || /amount|sales|net|gross|fees|value|revenue|refunds|voids|discounts|tax|cost|margin|total|paid|basket|variance|spend/.test(k);
          lines.push(`  ${k.replace(/_/g, ' ')}: ${isMoney ? money.format(val, b.currency, b.currency_minor, b.locale) : val}`);
        }
      }
      (rep.notes || []).forEach((n) => lines.push(`Note: ${n}`));
      const width = lines.reduce((a, l) => Math.max(a, l.length), 0);
      const landscape = width > 95;
      return raw('application/pdf', textPdf(lines, { pageWidth: landscape ? 842 : 595, pageHeight: landscape ? 595 : 842, fontSize: width > 150 ? 6 : width > 120 ? 7 : 8, title: rep.title }), `${fname}.pdf`);
    }
    return raw('text/csv; charset=utf-8', toCsv(rep.columns.map((c) => ({ ...c, csv: (row) => fmtCell(c, row) })), rep.rows), `${fname}.csv`);
  });

  // ── audit ──
  r.add('GET', '/api/audit', ({ ctx, query }) => { app.auth.require(ctx, 'audit.view'); return app.audit.list(ctx, { ...query, ...range(ctx, query), entityType: query.entity_type, entityId: query.entity_id, userId: query.user_id, limit: num(query.limit, 200), offset: num(query.offset, 0) }); });
  r.add('GET', '/api/audit/verify', ({ ctx }) => { app.auth.require(ctx, 'audit.view'); return app.audit.verify(); });

  // ── administration ──
  r.add('GET', '/api/admin/users', ({ ctx }) => app.admin.listUsers(ctx));
  r.add('POST', '/api/admin/users', ({ ctx, body }) => created({ id: app.admin.saveUser(ctx, null, body) }));
  r.add('PUT', '/api/admin/users/:id', ({ ctx, params, body }) => ({ id: app.admin.saveUser(ctx, params.id, body) }));
  r.add('GET', '/api/admin/roles', ({ ctx }) => app.admin.listRoles(ctx));
  r.add('POST', '/api/admin/roles', ({ ctx, body }) => created({ id: app.admin.saveRole(ctx, null, body) }));
  r.add('PUT', '/api/admin/roles/:id', ({ ctx, params, body }) => ({ id: app.admin.saveRole(ctx, params.id, body) }));
  r.add('GET', '/api/admin/permissions', () => app.admin.permissionsCatalog());
  r.add('GET', '/api/admin/business', ({ ctx }) => app.admin.getBusiness(ctx));
  r.add('PUT', '/api/admin/business', ({ ctx, body }) => app.admin.updateBusiness(ctx, body));
  r.add('PUT', '/api/admin/settings', ({ ctx, body }) => app.admin.updateSettings(ctx, body));
  r.add('POST', '/api/admin/locations', ({ ctx, body }) => ({ id: app.admin.saveLocation(ctx, null, body) }));
  r.add('PUT', '/api/admin/locations/:id', ({ ctx, params, body }) => ({ id: app.admin.saveLocation(ctx, params.id, body) }));
  r.add('POST', '/api/admin/registers', ({ ctx, body }) => ({ id: app.admin.saveRegister(ctx, null, body) }));
  r.add('PUT', '/api/admin/registers/:id', ({ ctx, params, body }) => ({ id: app.admin.saveRegister(ctx, params.id, body) }));
  r.add('GET', '/api/admin/providers', ({ ctx }) => { app.auth.require(ctx, 'settings.manage'); return app.admin.listProviders(ctx); });
  r.add('PUT', '/api/admin/providers/:code', ({ ctx, params, body }) => app.admin.saveProvider(ctx, params.code, body));
  r.add('GET', '/api/admin/payment-methods', ({ ctx }) => app.payments.methods(ctx));
  r.add('POST', '/api/admin/payment-methods', ({ ctx, body }) => ({ id: app.admin.savePaymentMethod(ctx, null, body) }));
  r.add('PUT', '/api/admin/payment-methods/:id', ({ ctx, params, body }) => ({ id: app.admin.savePaymentMethod(ctx, params.id, body) }));
  r.add('GET', '/api/hardware', ({ ctx }) => app.hardware.list(ctx));

  // ── network & sync ──
  r.add('GET', '/api/network', ({ ctx }) => app.connectivity.status(ctx.businessId));
  r.add('POST', '/api/network/probe', async ({ ctx }) => app.connectivity.probe(ctx.businessId));
  r.add('POST', '/api/network/simulate', async ({ ctx, body }) => app.connectivity.setSimulatedOffline(ctx, !!body.offline));
  r.add('GET', '/api/sync/outbox', ({ ctx, query }) => ({ stats: app.sync.stats(ctx.businessId), rows: app.sync.list(ctx, query) }));
  r.add('POST', '/api/sync/flush', async ({ ctx }) => { app.auth.require(ctx, 'sync.manage'); return { pushed: await app.sync.flush(), stats: app.sync.stats(ctx.businessId) }; });
  r.add('POST', '/api/sync/outbox/:seq/resolve', ({ ctx, params, body }) => app.sync.resolve(ctx, Number(params.seq), body.action, body.note));
};
