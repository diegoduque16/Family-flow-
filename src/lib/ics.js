// iCalendar (RFC 5545) reader for importing Google / Outlook / Apple calendars.
// Parses VEVENTs and expands them into concrete instances (UTC ms) inside a time window,
// handling TZID (IANA and Windows names), all-day dates, RRULE (DAILY/WEEKLY/MONTHLY/YEARLY with
// INTERVAL, COUNT, UNTIL, BYDAY incl. "2TU"/"-1FR", BYMONTHDAY, BYMONTH, BYSETPOS, WKST), EXDATE,
// RECURRENCE-ID overrides and cancelled instances.
import { zonedToUtc } from './time.js';
import { isValidTimeZone as isValidTz } from './util.js';

// Outlook / Exchange publish Windows zone names. Most common ones mapped to IANA.
const WINDOWS_TZ = {
  'Eastern Standard Time': 'America/New_York', 'US Eastern Standard Time': 'America/Indianapolis',
  'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax', 'Newfoundland Standard Time': 'America/St_Johns', 'Canada Central Standard Time': 'America/Regina',
  'Central America Standard Time': 'America/Guatemala', 'Mexico Standard Time': 'America/Mexico_City', 'Central Standard Time (Mexico)': 'America/Mexico_City',
  'SA Pacific Standard Time': 'America/Bogota', 'SA Western Standard Time': 'America/La_Paz', 'Venezuela Standard Time': 'America/Caracas',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Buenos_Aires', 'Pacific SA Standard Time': 'America/Santiago',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev', 'Russian Standard Time': 'Europe/Moscow', 'Turkey Standard Time': 'Europe/Istanbul', 'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg', 'W. Central Africa Standard Time': 'Africa/Lagos', 'E. Africa Standard Time': 'Africa/Nairobi',
  'Egypt Standard Time': 'Africa/Cairo', 'Arabian Standard Time': 'Asia/Dubai', 'Arab Standard Time': 'Asia/Riyadh', 'India Standard Time': 'Asia/Calcutta',
  'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore', 'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'E. Australia Standard Time': 'Australia/Brisbane', 'W. Australia Standard Time': 'Australia/Perth',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

export function resolveTz(tzid, fallback) {
  if (!tzid) return fallback;
  const t = tzid.replace(/^"|"$/g, '').replace(/^\/[^/]+\/[^/]+\//, ''); // strip "/mozilla.org/20050126_1/" style prefixes
  if (isValidTz(t)) return t;
  if (WINDOWS_TZ[t]) return WINDOWS_TZ[t];
  const found = Object.keys(WINDOWS_TZ).find((k) => t.includes(k));
  return found ? WINDOWS_TZ[found] : fallback;
}

const unescapeText = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

// ---------- parsing ----------
export function parseIcs(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  let depth = 0; // ignore nested components (VALARM) inside VEVENT
  let calName = null;
  for (const line of lines) {
    if (!line) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value === 'VEVENT' && !cur) { cur = { props: {} }; depth = 0; } else if (cur) depth++;
      continue;
    }
    if (p.name === 'END') {
      if (cur && depth > 0) depth--;
      else if (p.value === 'VEVENT' && cur) { events.push(cur.props); cur = null; }
      continue;
    }
    if (!cur) { if (p.name === 'X-WR-CALNAME') calName = unescapeText(p.value); continue; }
    if (depth > 0) continue;
    if (p.name === 'EXDATE' || p.name === 'RDATE') (cur.props[p.name] ||= []).push(p);
    else if (!cur.props[p.name]) cur.props[p.name] = p;
  }
  return { calName, events };
}

function parseLine(line) {
  let inQ = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(';');
  const params = {};
  for (const kv of head.slice(1)) {
    const eq = kv.indexOf('=');
    if (eq > 0) params[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

// Parse a DATE or DATE-TIME property value. Returns { allDay, y,m,d,h,mi, utc?: ms, tz }.
export function parseDateProp(p, fallbackTz) {
  const v = p.value.trim().split(',')[0];
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mi, , z] = m;
  const parts = { y: +y, m: +mo, d: +d, h: hh ? +hh : 0, mi: mi ? +mi : 0 };
  if (!hh || p.params.VALUE === 'DATE') return { allDay: true, ...parts, h: 0, mi: 0 };
  if (z) return { allDay: false, ...parts, utc: Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.mi), tz: 'UTC' };
  const tz = resolveTz(p.params.TZID, fallbackTz);
  return { allDay: false, ...parts, tz, utc: zonedToUtc(parts.y, parts.m, parts.d, parts.h, parts.mi, tz) };
}

function parseDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((s || '').trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((+(m[2] || 0)) * 604800000 + (+(m[3] || 0)) * 86400000 + (+(m[4] || 0)) * 3600000 + (+(m[5] || 0)) * 60000 + (+(m[6] || 0)) * 1000);
}

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
export function parseRruleFull(s) {
  const r = { freq: null, interval: 1, count: null, until: null, byday: [], bymonthday: [], bymonth: [], bysetpos: [], wkst: 1 };
  for (const part of s.split(';')) {
    const [k, v] = part.split('=');
    if (!v) continue;
    const K = k.toUpperCase();
    if (K === 'FREQ') r.freq = v.toUpperCase();
    else if (K === 'INTERVAL') r.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (K === 'COUNT') r.count = Math.max(1, parseInt(v, 10) || 1);
    else if (K === 'UNTIL') r.until = v;
    else if (K === 'BYDAY') r.byday = v.split(',').map((x) => { const mm = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(x.trim()); return mm ? { n: mm[1] ? parseInt(mm[1], 10) : 0, wd: WD[mm[2].toUpperCase()] } : null; }).filter(Boolean);
    else if (K === 'BYMONTHDAY') r.bymonthday = v.split(',').map((x) => parseInt(x, 10)).filter((x) => x && Math.abs(x) <= 31);
    else if (K === 'BYMONTH') r.bymonth = v.split(',').map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 12);
    else if (K === 'BYSETPOS') r.bysetpos = v.split(',').map((x) => parseInt(x, 10)).filter(Boolean);
    else if (K === 'WKST') r.wkst = WD[v.toUpperCase()] ?? 1;
  }
  return r;
}

// ---------- plain-date arithmetic (UTC Date used as a calendar) ----------
const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const parts = (dt) => ({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const key = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

function monthCandidates(y, m, r, start) {
  const n = dim(y, m);
  let days = [];
  if (r.byday.length) {
    for (const { n: nth, wd } of r.byday) {
      const all = [];
      for (let d = 1; d <= n; d++) if (D(y, m, d).getUTCDay() === wd) all.push(d);
      if (!nth) days.push(...all);
      else { const pick = nth > 0 ? all[nth - 1] : all[all.length + nth]; if (pick) days.push(pick); }
    }
    if (r.bymonthday.length) {
      const md = new Set(r.bymonthday.map((x) => (x > 0 ? x : n + x + 1)));
      days = days.filter((d) => md.has(d));
    }
  } else if (r.bymonthday.length) {
    days = r.bymonthday.map((x) => (x > 0 ? x : n + x + 1)).filter((d) => d >= 1 && d <= n);
  } else if (start.d <= n) days = [start.d];
  return [...new Set(days)].sort((a, b) => a - b).map((d) => ({ y, m, d }));
}

function applySetpos(list, r) {
  if (!r.bysetpos.length) return list;
  const out = [];
  for (const p of r.bysetpos) { const x = p > 0 ? list[p - 1] : list[list.length + p]; if (x) out.push(x); }
  return out.sort((a, b) => key(a).localeCompare(key(b)));
}

// Yields candidate dates (plain {y,m,d}) in order, starting from the series start.
function* candidates(start, r) {
  const s = D(start.y, start.m, start.d);
  for (let k = 0; k < 5000; k++) {
    let list = [];
    if (r.freq === 'DAILY') {
      const dt = new Date(s); dt.setUTCDate(dt.getUTCDate() + k * r.interval);
      const p = parts(dt);
      if (r.bymonth.length && !r.bymonth.includes(p.m)) continue;
      if (r.bymonthday.length && !r.bymonthday.map((x) => (x > 0 ? x : dim(p.y, p.m) + x + 1)).includes(p.d)) continue;
      if (r.byday.length && !r.byday.some((b) => b.wd === dt.getUTCDay())) continue;
      list = [p];
    } else if (r.freq === 'WEEKLY') {
      const ws = new Date(s); ws.setUTCDate(ws.getUTCDate() - ((s.getUTCDay() - r.wkst + 7) % 7) + k * 7 * r.interval);
      const wds = r.byday.length ? r.byday.map((b) => b.wd) : [s.getUTCDay()];
      for (let i = 0; i < 7; i++) {
        const dt = new Date(ws); dt.setUTCDate(dt.getUTCDate() + i);
        if (!wds.includes(dt.getUTCDay())) continue;
        const p = parts(dt);
        if (r.bymonth.length && !r.bymonth.includes(p.m)) continue;
        list.push(p);
      }
      list = applySetpos(list, r);
    } else if (r.freq === 'MONTHLY') {
      const mi = start.m - 1 + k * r.interval;
      const y = start.y + Math.floor(mi / 12); const m = (mi % 12) + 1;
      if (r.bymonth.length && !r.bymonth.includes(m)) continue;
      list = applySetpos(monthCandidates(y, m, r, start), r);
    } else if (r.freq === 'YEARLY') {
      const y = start.y + k * r.interval;
      const months = r.bymonth.length ? r.bymonth : [start.m];
      if (!r.bymonth.length && r.byday.some((b) => b.n) && !r.bymonthday.length) {
        // nth weekday of the year (rare)
        for (const { n, wd } of r.byday) {
          const all = [];
          for (let dt = D(y, 1, 1); dt.getUTCFullYear() === y; dt.setUTCDate(dt.getUTCDate() + 1)) if (dt.getUTCDay() === wd) all.push(parts(dt));
          const pick = n > 0 ? all[n - 1] : all[all.length + n];
          if (pick) list.push(pick);
        }
      } else {
        for (const m of months) list.push(...monthCandidates(y, m, r.byday.length || r.bymonthday.length ? r : { ...r, bymonthday: [start.d] }, start));
      }
      list = applySetpos(list.sort((a, b) => key(a).localeCompare(key(b))), r);
    } else return;
    for (const p of list) yield p;
  }
}

// ---------- expansion ----------
// Returns instances [{uid, recurrenceKey, title, notes, location, allDay, startUtc, endUtc, startDate, endDate}]
// for all VEVENTs overlapping [fromMs, toMs). For all-day instances startDate/endDate are YYYY-MM-DD (end exclusive).
export function expandIcs(text, { fromMs, toMs, fallbackTz, maxInstances = 4000 }) {
  const { calName, events } = parseIcs(text);
  const masters = new Map();
  const overrides = new Map(); // uid -> Map(recurrenceKey -> props)
  const singles = [];
  for (const ev of events) {
    const uid = ev.UID ? ev.UID.value : null;
    if (!ev.DTSTART) continue;
    if (ev['RECURRENCE-ID'] && uid) {
      const rid = parseDateProp(ev['RECURRENCE-ID'], fallbackTz);
      if (!rid) continue;
      if (!overrides.has(uid)) overrides.set(uid, new Map());
      overrides.get(uid).set(rid.allDay ? key(rid) : String(rid.utc), ev);
    } else if (ev.RRULE && uid) masters.set(uid, ev);
    else singles.push(ev);
  }
  const out = [];
  let truncated = false;
  const push = (inst) => { if (out.length >= maxInstances) { truncated = true; return false; } out.push(inst); return true; };

  const instanceOf = (ev, uid, startProp, recurrenceKey) => {
    if (ev.STATUS && ev.STATUS.value.toUpperCase() === 'CANCELLED') return null;
    const st = startProp || parseDateProp(ev.DTSTART, fallbackTz);
    if (!st) return null;
    const base = {
      uid: uid || `nouid:${ev.SUMMARY ? ev.SUMMARY.value : ''}:${ev.DTSTART.value}`,
      recurrenceKey,
      title: ev.SUMMARY ? unescapeText(ev.SUMMARY.value).trim().slice(0, 200) || '(No title)' : '(No title)',
      notes: ev.DESCRIPTION ? unescapeText(ev.DESCRIPTION.value).slice(0, 5000) : '',
      location: ev.LOCATION ? unescapeText(ev.LOCATION.value).slice(0, 300) : '',
      transparent: ev.TRANSP && ev.TRANSP.value.toUpperCase() === 'TRANSPARENT',
    };
    if (st.allDay) {
      let endKey;
      const en = ev.DTEND && parseDateProp(ev.DTEND, fallbackTz);
      const dur = ev.DURATION && parseDuration(ev.DURATION.value);
      if (startProp && ev.__span) { const e = D(st.y, st.m, st.d); e.setUTCDate(e.getUTCDate() + ev.__span); endKey = key(parts(e)); }
      else if (en && en.allDay) endKey = key(en);
      else if (dur) { const e = D(st.y, st.m, st.d); e.setUTCDate(e.getUTCDate() + Math.max(1, Math.round(dur / 86400000))); endKey = key(parts(e)); }
      else { const e = D(st.y, st.m, st.d); e.setUTCDate(e.getUTCDate() + 1); endKey = key(parts(e)); }
      if (endKey <= key(st)) { const e = D(st.y, st.m, st.d); e.setUTCDate(e.getUTCDate() + 1); endKey = key(parts(e)); }
      return { ...base, allDay: true, startDate: key(st), endDate: endKey };
    }
    let durMs = 0;
    if (startProp && ev.__durMs !== undefined) durMs = ev.__durMs;
    else if (ev.DTEND) { const en = parseDateProp(ev.DTEND, fallbackTz); if (en && !en.allDay) durMs = en.utc - st.utc; }
    else if (ev.DURATION) durMs = parseDuration(ev.DURATION.value) || 0;
    if (durMs < 0) durMs = 0;
    return { ...base, allDay: false, startUtc: st.utc, endUtc: st.utc + durMs };
  };
  const overlaps = (i) => (i.allDay ? i.startDate < isoDay(toMs) && i.endDate > isoDay(fromMs) : i.startUtc < toMs && Math.max(i.endUtc, i.startUtc + 1) > fromMs);

  for (const ev of singles) {
    const i = instanceOf(ev, ev.UID && ev.UID.value, null, '');
    if (i && overlaps(i) && !push(i)) break;
  }
  for (const [uid, ev] of masters) {
    const st = parseDateProp(ev.DTSTART, fallbackTz);
    if (!st) continue;
    const r = parseRruleFull(ev.RRULE.value);
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq)) {
      const i = instanceOf(ev, uid, null, ''); if (i && overlaps(i)) push(i); continue;
    }
    // remember the series' duration so generated instances keep it
    const first = instanceOf(ev, uid, null, '');
    if (!first) continue;
    if (first.allDay) ev.__span = Math.round((Date.parse(`${first.endDate}T00:00:00Z`) - Date.parse(`${first.startDate}T00:00:00Z`)) / 86400000);
    else ev.__durMs = first.endUtc - first.startUtc;
    const tz = st.allDay ? fallbackTz : st.tz;
    const local = st.allDay ? st : (st.tz === 'UTC' ? { ...st } : st);
    let until = null;
    if (r.until) {
      const u = parseDateProp({ value: r.until, params: {} }, tz);
      until = u ? (u.allDay ? (st.allDay ? key(u) : zonedToUtc(u.y, u.m, u.d, 23, 59, tz)) : u.utc) : null;
    }
    const ex = new Set();
    for (const p of ev.EXDATE || []) {
      for (const val of p.value.split(',')) {
        const x = parseDateProp({ ...p, value: val }, tz);
        if (x) ex.add(x.allDay ? key(x) : String(x.utc));
      }
    }
    const ovr = overrides.get(uid) || new Map();
    const usedOverrides = new Set();
    let count = 0;
    for (const c of candidates(local, r)) {
      if (key(c) < key(local)) continue;
      const startUtc = st.allDay ? null : zonedToUtc(c.y, c.m, c.d, local.h, local.mi, tz);
      const rk = st.allDay ? key(c) : String(startUtc);
      if (until !== null && (st.allDay ? rk > until : startUtc > until)) break;
      count++;
      if (r.count && count > r.count) break;
      if (!st.allDay && startUtc >= toMs) break;
      if (st.allDay && key(c) >= isoDay(toMs)) break;
      if (ex.has(rk)) continue;
      let inst;
      if (ovr.has(rk)) { usedOverrides.add(rk); inst = instanceOf(ovr.get(rk), uid, null, rk); }
      else inst = instanceOf(ev, uid, st.allDay ? { allDay: true, ...c } : { allDay: false, utc: startUtc }, rk);
      if (inst && overlaps(inst) && !push(inst)) break;
    }
    // overrides that moved an instance into the window from outside the generated range
    for (const [rk, o] of ovr) {
      if (usedOverrides.has(rk) || ex.has(rk)) continue;
      const inst = instanceOf(o, uid, null, rk);
      if (inst && overlaps(inst) && !out.some((x) => x.uid === uid && x.recurrenceKey === rk)) push(inst);
    }
  }
  // overrides without a master in the file
  for (const [uid, ovr] of overrides) {
    if (masters.has(uid)) continue;
    for (const [rk, o] of ovr) { const i = instanceOf(o, uid, null, rk); if (i && overlaps(i)) push(i); }
  }
  return { calName, instances: out, truncated, eventCount: events.length };
}
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
