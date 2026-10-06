'use strict';
/** Business-day helpers. Reports and reconciliation work in the business's local timezone. */

function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** YYYY-MM-DD of `date` in the given timezone. */
function localDate(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(date);
}

/** UTC ISO instant for local midnight of YYYY-MM-DD in timeZone. */
function localMidnightUtc(ymd, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const off = tzOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - off * 60000);
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Resolve a named period into [fromIso, toIso) plus the local dates it covers. */
function resolvePeriod({ period = 'today', from, to }, timeZone, now = new Date()) {
  const today = localDate(now, timeZone);
  let a; let b;
  switch (period) {
    case 'today': a = today; b = addDays(today, 1); break;
    case 'yesterday': a = addDays(today, -1); b = today; break;
    case 'this_week': {
      const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0=Sun
      const back = (dow + 6) % 7; // week starts Monday
      a = addDays(today, -back); b = addDays(today, 1); break;
    }
    case 'this_month': a = `${today.slice(0, 8)}01`; b = addDays(today, 1); break;
    case 'last_30': a = addDays(today, -29); b = addDays(today, 1); break;
    case 'custom': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw new Error('custom period needs from/to as YYYY-MM-DD');
      a = from; b = addDays(to, 1); break;
    }
    default: throw new Error(`unknown period ${period}`);
  }
  return { fromDate: a, toDate: addDays(b, -1), from: localMidnightUtc(a, timeZone).toISOString(), to: localMidnightUtc(b, timeZone).toISOString() };
}

module.exports = { tzOffsetMinutes, localDate, localMidnightUtc, addDays, resolvePeriod };
