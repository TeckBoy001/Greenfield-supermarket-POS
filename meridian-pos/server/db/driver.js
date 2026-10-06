'use strict';
/**
 * Thin SQLite driver abstraction.
 * Uses Node's built-in node:sqlite inside Electron (no native rebuild needed); under plain Node it
 * prefers better-sqlite3 when installed and falls back to node:sqlite (Node ≥ 22.5). Both are synchronous, which lets
 * financial writes run inside short, atomic transactions.
 */
const fs = require('fs');
const path = require('path');

function normalizeParams(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p !== null && typeof p === 'object' && !(p instanceof Uint8Array)) return JSON.stringify(p);
    return p;
  });
}

function plain(row) {
  if (!row) return row;
  return Object.assign({}, row);
}

class Database {
  constructor(file, { driver } = {}) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    let impl = null;
    // Inside Electron (Node ≥ 22.13 embedded) the built-in driver avoids any native-module ABI rebuild.
    if (!driver && process.versions.electron) driver = 'node';
    if (driver !== 'node') {
      try {
        const BetterSqlite = require('better-sqlite3');
        impl = new BetterSqlite(file);
        this.driverName = 'better-sqlite3';
      } catch (e) {
        if (driver === 'better') throw e;
      }
    }
    if (!impl) {
      const { DatabaseSync } = require('node:sqlite');
      impl = new DatabaseSync(file);
      this.driverName = 'node:sqlite';
    }
    this.impl = impl;
    this.cache = new Map();
    this.txDepth = 0;
    this.exec('PRAGMA journal_mode = WAL');
    this.exec('PRAGMA synchronous = FULL');      // financial durability over raw speed
    this.exec('PRAGMA foreign_keys = ON');
    this.exec('PRAGMA busy_timeout = 5000');
  }

  exec(sql) { this.impl.exec(sql); }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.impl.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  run(sql, ...params) {
    const r = this.stmt(sql).run(...normalizeParams(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  get(sql, ...params) { return plain(this.stmt(sql).get(...normalizeParams(params))); }
  all(sql, ...params) { return this.stmt(sql).all(...normalizeParams(params)).map(plain); }
  value(sql, ...params) {
    const row = this.get(sql, ...params);
    return row ? Object.values(row)[0] : undefined;
  }

  /** Run fn atomically. Nested calls use savepoints. BEGIN IMMEDIATE takes the write lock up front. */
  tx(fn) {
    const depth = this.txDepth;
    const sp = `sp_${depth}`;
    if (depth === 0) this.exec('BEGIN IMMEDIATE'); else this.exec(`SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const out = fn();
      if (out && typeof out.then === 'function') throw new Error('db.tx callback must be synchronous');
      this.txDepth--;
      if (depth === 0) this.exec('COMMIT'); else this.exec(`RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.txDepth--;
      try { if (depth === 0) this.exec('ROLLBACK'); else this.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch (_) { /* ignore */ }
      throw e;
    }
  }

  backupTo(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.impl.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }

  close() { try { this.impl.close(); } catch (_) { /* ignore */ } }
}

module.exports = { Database };
