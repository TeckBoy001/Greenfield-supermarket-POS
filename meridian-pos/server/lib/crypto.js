'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// scrypt parameters: N=16384, r=8, p=1 (OWASP-acceptable interactive login cost).
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(secret), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function verifySecret(secret, stored) {
  if (!stored || typeof stored !== 'string') {
    // burn comparable time to avoid user-enumeration timing differences
    crypto.scryptSync('x', 'y', SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return false;
  }
  const [alg, N, r, p, saltB64, dkB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(dkB64, 'base64');
  const dk = crypto.scryptSync(String(secret), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(dk, expected);
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Local encrypted secret store (AES-256-GCM). The key lives in a 0600 file next to the DB,
 * so provider API keys are never stored in the database or in config JSON.
 * In production, swap for OS keychain (Electron safeStorage / DPAPI / Keychain).
 */
class SecretStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, 'master.key');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    this.key = fs.readFileSync(keyFile);
    this.file = path.join(dir, 'secrets.enc.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
  }
  set(ref, value) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
    this.data[ref] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), v: enc.toString('base64') };
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }
  get(ref) {
    const e = this.data[ref];
    if (!e) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.v, 'base64')), d.final()]).toString('utf8');
  }
  has(ref) { return !!this.data[ref]; }
}

module.exports = { hashSecret, verifySecret, randomToken, sha256, hmac, safeEqual, SecretStore };
