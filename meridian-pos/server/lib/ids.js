'use strict';
const crypto = require('crypto');

// Time-sortable unique id: prefix_ + 10 chars time (base32) + 12 chars random.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
let lastTime = 0;
let seq = 0;
function encodeTime(t, len) {
  let s = '';
  for (let i = 0; i < len; i++) { s = ALPHABET[t % 32] + s; t = Math.floor(t / 32); }
  return s;
}
function newId(prefix) {
  const now = Date.now();
  if (now === lastTime) seq++; else { seq = 0; lastTime = now; }
  const rnd = crypto.randomBytes(8);
  let r = encodeTime(seq, 2);
  for (let i = 0; i < 10; i++) r += ALPHABET[rnd[i % 8] % 32];
  return `${prefix}_${encodeTime(now, 10)}${r}`;
}

// Clock indirection: lets the demo seeder backdate history through the real services.
let clock = null;
const nowIso = () => (clock ? clock() : new Date()).toISOString();
const setClock = (fn) => { clock = fn; };

module.exports = { newId, nowIso, setClock };
