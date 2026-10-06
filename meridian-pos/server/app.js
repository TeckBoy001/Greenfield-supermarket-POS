'use strict';
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { Database } = require('./db/driver');
const { migrate } = require('./db/migrate');
const { SecretStore } = require('./lib/crypto');
const { createHttpServer } = require('./http');

/**
 * Composition root. Builds the service graph around one SQLite database and starts the
 * background workers (payment recovery, connectivity probe, sync outbox, backups).
 */
async function createApp({ dataDir, dbFile, driver, seed = 'demo', log = defaultLogger(), workers = true } = {}) {
  if (!dataDir) throw new Error('dataDir required');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(dbFile || path.join(dataDir, 'meridian-pos.db'), { driver: driver || process.env.POS_DB_DRIVER });
  const migrations = migrate(db);
  const app = { db, log, dataDir, events: new EventEmitter(), secrets: new SecretStore(path.join(dataDir, 'keys')) };

  app.audit = require('./services/audit')(app);
  app.settings = require('./services/settings')(app);
  app.auth = require('./services/auth')(app);
  app.numbering = require('./services/numbering')(app);
  app.inventory = require('./services/inventory')(app);
  app.catalog = require('./services/catalog')(app);
  app.customers = require('./services/customers')(app);
  app.connectivity = require('./services/connectivity')(app);
  app.sync = require('./services/sync')(app);
  app.hardware = require('./services/hardware')(app, { spoolDir: path.join(dataDir, 'print-spool') });
  app.sessions = require('./services/sessions')(app);
  app.sales = require('./services/sales')(app);
  app.payments = require('./services/payments/service')(app);
  app.refunds = require('./services/refunds')(app);
  app.receiptModel = require('./services/receipts/model')(app);
  app.receipts = require('./services/receipts/service')(app);
  app.settlements = require('./services/settlements')(app);
  app.payouts = require('./services/payouts')(app);
  app.reconciliation = require('./services/reconciliation')(app);
  app.reports = require('./services/reports')(app);
  app.dashboard = require('./services/dashboard')(app);
  app.admin = require('./services/admin')(app);

  const empty = !db.value('SELECT COUNT(*) FROM businesses');
  if (empty && seed) {
    const { seedDemo, seedMinimal } = require('./db/seed');
    if (seed === 'demo') await seedDemo(app); else seedMinimal(app);
    log('info', `Seeded ${seed} data`);
  }
  if (migrations.length) log('info', `Applied migrations: ${migrations.join(', ')}`);

  const timers = [];
  app.startWorkers = () => {
    const safe = (name, fn) => async () => { try { await fn(); } catch (e) { log('error', `${name}: ${e.stack || e}`); } };
    const businesses = () => db.all('SELECT id FROM businesses').map((b) => b.id);
    // Restart recovery: immediately re-check any payment/refund that was in flight when the app stopped.
    safe('recovery', () => app.payments.recoverInflight())();
    timers.push(setInterval(safe('recovery', () => app.payments.recoverInflight()), 2000));
    timers.push(setInterval(safe('probe', async () => { for (const b of businesses()) await app.connectivity.probe(b); }), 15000));
    safe('probe', async () => { for (const b of businesses()) await app.connectivity.probe(b); })();
    timers.push(setInterval(safe('sync', () => app.sync.flush()), 10000));
    timers.push(setInterval(safe('cleanup', () => {
      db.run(`DELETE FROM idempotency_keys WHERE created_at < ?`, new Date(Date.now() - 7 * 86400000).toISOString());
      db.run(`DELETE FROM auth_sessions WHERE expires_at < ? OR revoked_at < ?`, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString());
    }), 3600000));
    timers.push(setInterval(safe('backup', () => app.backup()), 6 * 3600000));
    timers.forEach((t) => t.unref && t.unref());
  };
  app.backup = () => {
    if (db.file === ':memory:') return null;
    const dir = path.join(dataDir, 'backups');
    const file = path.join(dir, `meridian-pos-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.backupTo(file);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
    while (files.length > 14) fs.unlinkSync(path.join(dir, files.shift()));
    return file;
  };
  app.stop = () => { timers.forEach(clearInterval); db.close(); };
  if (workers) app.startWorkers();
  return app;
}

function defaultLogger() {
  const level = process.env.POS_LOG || 'info';
  const order = { debug: 0, info: 1, error: 2 };
  return (lvl, msg) => { if (order[lvl] >= order[level]) console[lvl === 'error' ? 'error' : 'log'](`[${new Date().toISOString()}] ${lvl.toUpperCase()} ${msg}`); };
}

/** Start app + HTTP server. Resolves with { app, server, url }. */
async function start({ dataDir, port = 0, host = '127.0.0.1', allowedHosts = [], seed = 'demo', driver, log } = {}) {
  const app = await createApp({ dataDir, seed, driver, log: log || defaultLogger() });
  const server = createHttpServer(app, { staticDir: path.join(__dirname, '..', 'app'), allowedHosts, log: app.log });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`;
      app.log('info', `Meridian POS server listening on ${url} (db driver: ${app.db.driverName})`);
      resolve({ app, server, url, close: () => new Promise((r) => { app.stop(); server.close(() => r()); }) });
    });
  });
}

module.exports = { createApp, start };
