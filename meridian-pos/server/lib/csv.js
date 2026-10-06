'use strict';
/** RFC 4180 CSV with formula-injection protection (cells starting with = + - @ are prefixed). */
function cell(x) {
  if (x === null || x === undefined) return '';
  let s = String(x);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(columns, rows) {
  const head = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(c.csv ? c.csv(r) : r[c.key])).join(',')).join('\r\n');
  return `﻿${head}\r\n${body}\r\n`;
}
module.exports = { toCsv };
