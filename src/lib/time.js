// Time-zone and recurrence helpers with no external libraries.
// Local wall times are strings: 'YYYY-MM-DDTHH:MM' (timed) or 'YYYY-MM-DD' (all-day).

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function zonedParts(ms, tz) {
  const parts = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    h: +parts.hour === 24 ? 0 : +parts.hour, mi: +parts.minute, s: +parts.second,
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Wall-clock time in tz -> UTC epoch ms. Nonexistent times (DST gap) roll forward.
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetMs(guess, tz);
  const o2 = offsetMs(t, tz);
  if (guess - o2 !== t) {
    const t2 = guess - o2;
    const back = zonedParts(t2, tz);
    if (back.h === h && back.mi === mi) t = t2;
    else t = Math.max(t, t2);
  }
  return t;
}

export function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, timed: !!m[4] };
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtLocal({ y, m, d, h, mi }, timed = true) {
  const date = `${y}-${pad(m)}-${pad(d)}`;
  return timed ? `${date}T${pad(h)}:${pad(mi)}` : date;
}

export function localToUtc(s, tz) {
  const p = parseLocal(s);
  if (!p) return NaN;
  return zonedToUtc(p.y, p.m, p.d, p.h, p.mi, tz);
}

export function utcToLocal(ms, tz, timed = true) {
  return fmtLocal(zonedParts(ms, tz), timed);
}

export function todayLocal(tz, ms = Date.now()) {
  return utcToLocal(ms, tz, false);
}

// Calendar arithmetic on plain dates (no tz needed).
export function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
export function weekday(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function dayNumber(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

// ---------- RRULE subset ----------
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseRrule(rule) {
  if (!rule) return null;
  const out = { freq: null, interval: 1, byday: null, count: null, until: null };
  for (const part of rule.split(';')) {
    const [k, val] = part.split('=');
    if (!val) continue;
    switch (k.toUpperCase()) {
      case 'FREQ':
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(val)) throw new Error('Unsupported FREQ');
        out.freq = val; break;
      case 'INTERVAL': out.interval = Math.max(1, Math.min(99, parseInt(val, 10) || 1)); break;
      case 'BYDAY': out.byday = val.split(',').map((x) => DAYS.indexOf(x)).filter((x) => x >= 0); break;
      case 'COUNT': out.count = Math.max(1, Math.min(1000, parseInt(val, 10) || 1)); break;
      case 'UNTIL': if (/^\d{4}-\d{2}-\d{2}$/.test(val)) out.until = val; else throw new Error('UNTIL must be YYYY-MM-DD'); break;
      default: throw new Error(`Unsupported rule part ${k}`);
    }
  }
  if (!out.freq) throw new Error('FREQ is required');
  if (out.byday && !out.byday.length) out.byday = null;
  return out;
}

export function buildRrule(r) {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byday && r.byday.length) parts.push(`BYDAY=${r.byday.map((d) => DAYS[d]).join(',')}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (r.until) parts.push(`UNTIL=${r.until}`);
  return parts.join(';');
}

// Generate occurrence start dates (local wall-clock, plain objects) in order.
// Stops after `limit` items or when beyond `stopDate` (YYYY-MM-DD, inclusive) if given.
export function* occurrenceDates(startLocal, rrule, { stopDate = null, limit = 5000 } = {}) {
  const s = parseLocal(startLocal);
  const r = typeof rrule === 'string' ? parseRrule(rrule) : rrule;
  const untilDay = r.until ? dayNumber(...r.until.split('-').map(Number)) : Infinity;
  const stopDay = stopDate ? dayNumber(...stopDate.split('-').map(Number)) : Infinity;
  const lastDay = Math.min(untilDay, stopDay);
  let produced = 0;
  const emit = (y, m, d) => ({ y, m, d, h: s.h, mi: s.mi });

  if (r.freq === 'DAILY') {
    for (let i = 0; ; i += r.interval) {
      const dt = addDays(s.y, s.m, s.d, i);
      if (dayNumber(dt.y, dt.m, dt.d) > lastDay) return;
      yield emit(dt.y, dt.m, dt.d);
      if (++produced >= (r.count || limit)) return;
    }
  }
  if (r.freq === 'WEEKLY') {
    const days = r.byday ? [...r.byday].sort((a, b) => a - b) : [weekday(s.y, s.m, s.d)];
    const startDayNum = dayNumber(s.y, s.m, s.d);
    const wd0 = weekday(s.y, s.m, s.d);
    const weekStart = addDays(s.y, s.m, s.d, -wd0); // Sunday of first week
    for (let w = 0; ; w += r.interval) {
      for (const wd of days) {
        const dt = addDays(weekStart.y, weekStart.m, weekStart.d, w * 7 + wd);
        const dn = dayNumber(dt.y, dt.m, dt.d);
        if (dn < startDayNum) continue;
        if (dn > lastDay) return;
        yield emit(dt.y, dt.m, dt.d);
        if (++produced >= (r.count || limit)) return;
      }
    }
  }
  if (r.freq === 'MONTHLY') {
    for (let i = 0; i < 12 * 200; i += r.interval) {
      const mm0 = s.m - 1 + i;
      const y = s.y + Math.floor(mm0 / 12);
      const m = (mm0 % 12) + 1;
      if (s.d > daysInMonth(y, m)) continue; // e.g. the 31st skips short months (RFC 5545 behaviour)
      if (dayNumber(y, m, s.d) > lastDay) return;
      yield emit(y, m, s.d);
      if (++produced >= (r.count || limit)) return;
    }
    return;
  }
  if (r.freq === 'YEARLY') {
    for (let i = 0; i < 200; i += r.interval) {
      const y = s.y + i;
      if (s.d > daysInMonth(y, s.m)) continue; // Feb 29
      if (dayNumber(y, s.m, s.d) > lastDay) return;
      yield emit(y, s.m, s.d);
      if (++produced >= (r.count || limit)) return;
    }
  }
}

// Expand an event row into concrete occurrences overlapping [fromMs, toMs).
export function expandEvent(ev, fromMs, toMs) {
  const durMs = ev.end_utc - ev.start_utc;
  const timed = !ev.all_day;
  if (!ev.rrule) {
    return ev.start_utc < toMs && ev.end_utc > fromMs ? [{ start_local: ev.start_local, end_local: ev.end_local, start_utc: ev.start_utc, end_utc: ev.end_utc }] : [];
  }
  const ex = new Set(Array.isArray(ev.exdates) ? ev.exdates : JSON.parse(ev.exdates || '[]'));
  const stopDate = utcToLocal(toMs + 86400000 * 2, ev.tz, false);
  const out = [];
  const startParts = parseLocal(ev.start_local);
  const endParts = parseLocal(ev.end_local);
  const allDaySpan = ev.all_day ? dayNumber(endParts.y, endParts.m, endParts.d) - dayNumber(startParts.y, startParts.m, startParts.d) : 0;
  for (const o of occurrenceDates(ev.start_local, ev.rrule, { stopDate })) {
    const sl = fmtLocal(o, timed);
    if (ex.has(sl)) continue;
    const su = zonedToUtc(o.y, o.m, o.d, o.h, o.mi, ev.tz);
    let eu, el;
    if (ev.all_day) {
      const e = addDays(o.y, o.m, o.d, allDaySpan);
      el = fmtLocal(e, false);
      eu = zonedToUtc(e.y, e.m, e.d, 0, 0, ev.tz);
    } else {
      eu = su + durMs;
      el = utcToLocal(eu, ev.tz, true);
    }
    if (su >= toMs) break;
    if (eu > fromMs) out.push({ start_local: sl, end_local: el, start_utc: su, end_utc: eu });
  }
  return out;
}

// Last occurrence end (ms) for bounded series, or null if open-ended.
export function seriesEndUtc(ev) {
  if (!ev.rrule) return ev.end_utc;
  const r = parseRrule(ev.rrule);
  if (!r.count && !r.until) return null;
  let last = null;
  for (const o of occurrenceDates(ev.start_local, r)) last = o;
  if (!last) return ev.end_utc;
  const su = zonedToUtc(last.y, last.m, last.d, last.h, last.mi, ev.tz);
  return su + (ev.end_utc - ev.start_utc) + 86400000; // generous: covers DST / all-day spans
}
