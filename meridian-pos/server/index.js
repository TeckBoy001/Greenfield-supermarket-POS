#!/usr/bin/env node
'use strict';
/**
 * Standalone server entry (browser/dev mode, or a back-office "store server" for several lanes).
 *   node server/index.js [--port 4780] [--data ./data] [--host 127.0.0.1] [--seed demo|minimal|none]
 * The desktop app (electron/main.js) embeds the same server in-process.
 */
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
const path = require('path');
const { start } = require('./app');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]); return acc; }, []));
const dataDir = path.resolve(args.data || process.env.POS_DATA || path.join(__dirname, '..', 'data'));
const seed = args.seed === 'none' ? null : (args.seed || 'demo');
const host = args.host || '127.0.0.1';
const allowedHosts = (args['allow-host'] || process.env.POS_ALLOWED_HOSTS || '').split(',').filter(Boolean);

start({ dataDir, port: Number(args.port || process.env.PORT || 4780), host, seed, allowedHosts }).then(({ url, close, app }) => {
  console.log(`\n  Meridian POS running → ${url}\n  Data: ${dataDir}\n`);
  const shutdown = async () => { try { app.backup(); } catch (_) { /* ignore */ } await close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}).catch((e) => { console.error(e); process.exit(1); });
