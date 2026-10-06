'use strict';
const { nowIso } = require('../lib/ids');
const { sha256, hmac } = require('../lib/crypto');
const { E } = require('../lib/errors');

/**
 * Store → head-office synchronisation via a transactional outbox.
 * Completed sales, refunds and closed sessions are written to sync_outbox in the SAME transaction
 * that creates them, so nothing can be lost between "sale saved" and "sale queued".
 * A worker pushes pending rows when online, with exponential backoff.
 *
 * Conflict policy: this terminal's financial records are authoritative for what happened at the till.
 * The receiver must treat entity ids as idempotency keys. If it already holds the same id with
 * different content, the row is marked 'conflict' for a human to review — never overwritten silently.
 *
 * Adapters: 'sim-hq' (built-in simulated head office for testing), 'http' (POST JSON with HMAC —
 * implemented but not verified against a real HQ service), 'none'.
 */
module.exports = function syncService(app) {
  const { db } = app;
  let current = null;

  function enqueue(businessId, entityType, entityId, payloadFn) {
    const payload = JSON.stringify(payloadFn());
    db.run(`INSERT INTO sync_outbox (business_id,entity_type,entity_id,payload_json,payload_hash,status,created_at,next_attempt_at) VALUES (?,?,?,?,?,?,?,?)`,
      businessId, entityType, entityId, payload, sha256(payload), 'pending', nowIso(), nowIso());
  }

  const adapters = {
    'sim-hq': {
      async push(row) {
        const existing = db.get('SELECT payload_hash FROM sim_hq_records WHERE entity_type = ? AND entity_id = ?', row.entity_type, row.entity_id);
        if (existing && existing.payload_hash !== row.payload_hash) return { status: 'conflict', error: 'HQ already holds a different version of this record' };
        if (!existing) db.run('INSERT INTO sim_hq_records (entity_type, entity_id, payload_hash, received_at) VALUES (?,?,?,?)', row.entity_type, row.entity_id, row.payload_hash, nowIso());
        return { status: 'sent' };
      },
    },
    http: {
      async push(row, businessId) {
        const url = app.settings.get(businessId, 'sync.endpoint');
        if (!url) return { status: 'failed', error: 'sync.endpoint not configured' };
        const key = app.secrets.get(`sync:${businessId}`) || '';
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': hmac(key, row.payload_json), 'idempotency-key': `${row.entity_type}:${row.entity_id}` }, body: row.payload_json });
        if (res.status === 409) return { status: 'conflict', error: 'Receiver reported a conflicting version' };
        if (!res.ok) return { status: 'failed', error: `HTTP ${res.status}` };
        return { status: 'sent' };
      },
    },
    none: { async push() { return { status: 'failed', error: 'Sync disabled' }; } },
  };

  /** Push pending rows. Concurrent callers share the in-progress run instead of skipping it. */
  function flush() {
    if (!current) current = doFlush().finally(() => { current = null; });
    return current;
  }

  async function doFlush() {
    let n = 0;
    try {
      const businesses = db.all(`SELECT DISTINCT business_id FROM sync_outbox WHERE status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`, nowIso());
      for (const { business_id: b } of businesses) {
        if (!app.connectivity.isOnline(b)) continue;
        const adapter = adapters[app.settings.get(b, 'sync.adapter')] || adapters.none;
        // drain the due backlog in batches of 100 (bounded so one call can't run forever)
        for (let batch = 0; batch < 50; batch++) {
        if (!app.connectivity.isOnline(b)) break;
        const rows = db.all(`SELECT * FROM sync_outbox WHERE business_id = ? AND status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY seq LIMIT 100`, b, nowIso());
        if (!rows.length) break;
        for (const row of rows) {
          let r;
          try { r = await adapter.push(row, b); } catch (e) { r = { status: 'failed', error: e.message }; }
          if (r.status === 'sent') db.run(`UPDATE sync_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE seq = ?`, nowIso(), row.seq);
          else if (r.status === 'conflict') db.run(`UPDATE sync_outbox SET status = 'conflict', attempts = attempts + 1, last_error = ? WHERE seq = ?`, r.error, row.seq);
          else {
            const backoff = Math.min(3600000, 5000 * Math.pow(2, Math.min(row.attempts, 10)));
            db.run(`UPDATE sync_outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE seq = ?`, r.error, new Date(Date.now() + backoff).toISOString(), row.seq);
          }
          n++;
        }
        }
      }
    } catch (e) { app.log('error', `sync: ${e.message}`); }
    return n;
  }

  function list(ctx, { status, limit = 200 }) {
    app.auth.require(ctx, 'sync.manage');
    const where = ['business_id = ?']; const p = [ctx.businessId];
    if (status) { where.push('status = ?'); p.push(status); }
    return db.all(`SELECT seq, entity_type, entity_id, status, attempts, last_error, created_at, sent_at, next_attempt_at FROM sync_outbox WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`, ...p, limit);
  }

  function stats(businessId) {
    return Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM sync_outbox WHERE business_id = ? GROUP BY status', businessId).map((r) => [r.status, r.n]));
  }

  function resolve(ctx, seq, action, note) {
    app.auth.require(ctx, 'sync.manage');
    const row = db.get('SELECT * FROM sync_outbox WHERE seq = ? AND business_id = ?', seq, ctx.businessId);
    if (!row) throw E.notFound('Outbox entry');
    if (!['conflict', 'failed'].includes(row.status)) throw E.conflict(`Entry is ${row.status}`);
    if (action === 'retry') db.run(`UPDATE sync_outbox SET status = 'pending', next_attempt_at = ? WHERE seq = ?`, nowIso(), seq);
    else if (action === 'mark_resolved') {
      if (!note) throw E.validation('note: explain how the conflict was resolved');
      db.run(`UPDATE sync_outbox SET status = 'resolved', last_error = COALESCE(last_error,'') || ' | resolved: ' || ? WHERE seq = ?`, note, seq);
    } else throw E.validation('action must be retry or mark_resolved');
    app.audit.log(ctx, 'sync.resolve', { entityType: row.entity_type, entityId: row.entity_id, meta: { seq, action, note } });
    return db.get('SELECT seq, status, last_error FROM sync_outbox WHERE seq = ?', seq);
  }

  return { enqueue, flush, list, stats, resolve, adapters };
};
