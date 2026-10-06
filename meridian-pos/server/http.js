'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { AppError } = require('./lib/errors');
const { sha256 } = require('./lib/crypto');
const { nowIso } = require('./lib/ids');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    this.routes.push({ method, re, keys, handler, opts });
  }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf ? 'application/octet-stream' : (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
    'cache-control': 'no-store', ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new AppError(413, 'too_large', 'Request body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function mapDbError(e) {
  const msg = String(e.message || '');
  if (/UNIQUE constraint failed/.test(msg)) return new AppError(409, 'conflict', 'That record already exists or conflicts with another', { db: msg.replace(/.*failed: /, '') });
  if (/CHECK constraint failed/.test(msg)) return new AppError(422, 'validation_error', 'A value is outside the allowed range', { db: msg.replace(/.*failed: /, '') });
  if (/FOREIGN KEY constraint failed/.test(msg)) return new AppError(422, 'validation_error', 'A referenced record does not exist');
  if (/append-only|immutable|cannot be deleted|illegal|not open for editing|final state|can only be voided/.test(msg)) return new AppError(409, 'integrity', msg);
  return null;
}

function createHttpServer(app, { staticDir, allowedHosts = [], log = () => {} } = {}) {
  const router = new Router();
  require('./routes')(router, app);

  async function handleApi(req, res, url) {
    const m = router.match(req.method, url.pathname);
    if (!m) throw new AppError(404, 'not_found', 'Unknown API endpoint');
    const { route, params } = m;

    // CSRF defence in depth: tokens are bearer headers (never cookies), and cross-origin writes are refused.
    if (req.method !== 'GET' && req.headers.origin && !route.opts.public) {
      const originHost = (() => { try { return new URL(req.headers.origin).host; } catch (_) { return ''; } })();
      if (originHost !== req.headers.host) throw new AppError(403, 'forbidden', 'Cross-origin request refused');
    }

    const raw = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
    let body = {};
    if (raw && !route.opts.rawBody) {
      try { body = JSON.parse(raw); } catch (_) { throw new AppError(400, 'bad_json', 'Malformed JSON body'); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'bad_json', 'JSON body must be an object');
    }

    let ctx = null;
    if (!route.opts.public) {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : (route.opts.tokenInQuery ? url.searchParams.get('token') : null);
      ctx = app.auth.authenticate(token);
      if (!ctx) throw new AppError(401, 'unauthorized', 'Your session has expired. Please sign in again.');
    }

    // Generic idempotency for any mutating call that sends an Idempotency-Key header.
    const idemKey = req.headers['idempotency-key'];
    let idemStored = false;
    if (idemKey && req.method !== 'GET') {
      if (!/^[A-Za-z0-9_:.-]{8,100}$/.test(idemKey)) throw new AppError(400, 'bad_request', 'Invalid Idempotency-Key');
      const hash = sha256(`${req.method} ${url.pathname} ${raw}`);
      const prior = app.db.get('SELECT * FROM idempotency_keys WHERE key = ?', idemKey);
      if (prior) {
        if (prior.request_hash !== hash) throw new AppError(409, 'idempotency_mismatch', 'This request key was already used for a different request');
        if (prior.status_code === null) throw new AppError(409, 'in_progress', 'The same request is still being processed');
        return send(res, prior.status_code, prior.response_json, { 'content-type': 'application/json; charset=utf-8', 'idempotent-replay': 'true' });
      }
      app.db.run('INSERT INTO idempotency_keys (key,user_id,method,path,request_hash,created_at) VALUES (?,?,?,?,?,?)', idemKey, ctx ? ctx.user.id : null, req.method, url.pathname, hash, nowIso());
      idemStored = true;
    }

    try {
      const q = Object.fromEntries(url.searchParams.entries());
      const out = await route.handler({ ctx, params, body, query: q, raw, headers: req.headers, req });
      if (out && out.__raw) {
        const headers = { 'content-type': out.contentType };
        if (out.filename) headers['content-disposition'] = `${out.inline ? 'inline' : 'attachment'}; filename="${out.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
        if (out.contentType.startsWith('text/html')) headers['content-security-policy'] = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
        if (idemStored) app.db.run('DELETE FROM idempotency_keys WHERE key = ?', idemKey);
        return send(res, 200, out.body, headers);
      }
      const status = out && out.__status ? out.__status : 200;
      const payload = out && out.__status ? out.data : out;
      const json = JSON.stringify(payload === undefined ? { ok: true } : payload);
      if (idemStored) app.db.run('UPDATE idempotency_keys SET status_code = ?, response_json = ? WHERE key = ?', status, json, idemKey);
      return send(res, status, json, { 'content-type': 'application/json; charset=utf-8' });
    } catch (e) {
      if (idemStored) app.db.run('DELETE FROM idempotency_keys WHERE key = ?', idemKey); // failures may be retried with the same key
      throw e;
    }
  }

  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(staticDir, p));
    if (!file.startsWith(path.normalize(staticDir + path.sep))) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        // SPA fallback
        if (!path.extname(p)) return serveStatic(req, res, new URL('/index.html', url));
        return send(res, 404, 'Not found');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'content-security-policy': CSP });
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    // DNS-rebinding protection: only answer to expected Host headers.
    const host = String(req.headers.host || '').toLowerCase();
    const port = server.address() && server.address().port;
    const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...allowedHosts.map((h) => h.toLowerCase())]);
    if (!okHosts.has(host)) return send(res, 421, 'Misdirected request');
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch (_) { return send(res, 400, 'Bad request'); }
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET') serveStatic(req, res, url);
      else send(res, 405, 'Method not allowed');
    } catch (e0) {
      const e = e0 instanceof AppError ? e0 : (mapDbError(e0) || e0);
      if (e instanceof AppError) send(res, e.status, { error: { code: e.code, message: e.message, details: e.details || null } });
      else {
        log('error', `${req.method} ${url.pathname}: ${e.stack || e}`);
        send(res, 500, { error: { code: 'internal', message: 'Unexpected error. The action was not completed.' } });
      }
    } finally {
      if (url && url.pathname.startsWith('/api/')) log('debug', `${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  return server;
}

module.exports = { createHttpServer };
