// Minimal CalDAV client for iCloud: Apple has no "Sign in with Apple" for calendars, so people sign in with their
// Apple ID and an app-specific password (made at account.apple.com). Read-only: discovery + calendar-query REPORT.
// Workers has no DOMParser, so the multistatus XML is read with small namespace-agnostic helpers.
import { HttpError } from './util.js';

export const ICLOUD_ROOT = 'https://caldav.icloud.com/';
const MAX_BYTES = 10 * 1024 * 1024;
const isIcloud = (u) => u.protocol === 'https:' && /(^|\.)icloud\.com$/.test(u.hostname);

// ---------- XML helpers ----------
const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');
export function xmlText(s) {
  if (s == null) return null;
  const parts = [];
  let last = 0;
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let m;
  while ((m = re.exec(s))) { parts.push(decodeEntities(s.slice(last, m.index)), m[1]); last = re.lastIndex; }
  parts.push(decodeEntities(s.slice(last)));
  return parts.join('').trim();
}
// Inner XML of the first element with this local name ('' when self-closing, null when absent).
export function xmlProp(block, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}\\s*>)`, 'i');
  const m = re.exec(block);
  return m ? (m[1] ?? '') : null;
}
export function xmlResponses(xml) {
  const out = [];
  const re = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response\s*>/gi;
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
const hrefOf = (block) => xmlText(xmlProp(block, 'href'));

// ---------- HTTP ----------
const basic = (creds) => {
  const raw = new TextEncoder().encode(`${creds.u}:${creds.p}`);
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
};

// Follows iCloud's redirects to its partition hosts (pNN-caldav.icloud.com) itself, keeping the credentials,
// but never sends them anywhere outside icloud.com.
async function dav(env, creds, url, method, depth, body, { connecting = false } = {}) {
  const f = env.__fetch || fetch;
  let u = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (!isIcloud(u)) throw new HttpError(502, 'caldav_error', 'iCloud pointed somewhere unexpected, so Family Flow stopped. Please try again later.');
    let res;
    try {
      res = await f(u.toString(), {
        method,
        headers: { authorization: basic(creds), depth: String(depth), 'content-type': 'application/xml; charset=utf-8', 'user-agent': 'FamilyFlow/1.0 (calendar import)' },
        body, redirect: 'manual', signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new HttpError(502, 'caldav_unreachable', `Couldn’t reach iCloud (${String(e.message || e).slice(0, 80)}). ${connecting ? 'Please try again in a moment.' : 'We’ll try again automatically.'}`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) { u = new URL(res.headers.get('location'), u); continue; }
    if (res.status === 401) {
      throw connecting
        ? new HttpError(422, 'icloud_auth', 'Apple didn’t accept that Apple ID and password. Use an app-specific password made at account.apple.com (not your normal Apple password), and check the Apple ID email.', { field: 'password' })
        : new HttpError(401, 'reconnect', 'Apple stopped accepting the app-specific password (it was removed, or the Apple ID password changed). Tap Reconnect and make a new one.');
    }
    if (res.status === 403) throw new HttpError(403, 'forbidden', 'iCloud refused access to this calendar. Check that iCloud Calendar is turned on for this Apple ID.');
    if (res.status !== 207 && !res.ok) throw new HttpError(502, 'caldav_error', `iCloud returned an error (HTTP ${res.status}). We’ll try again automatically.`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new HttpError(422, 'too_large', 'That iCloud calendar is too large to import.');
    return { xml: new TextDecoder().decode(buf), url: u };
  }
  throw new HttpError(502, 'caldav_error', 'iCloud redirected too many times. We’ll try again automatically.');
}

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';

// Returns { home, calendars: [{ id (absolute URL), name, primary }] } for calendars that hold events.
export async function icloudDiscover(env, creds, { connecting = false } = {}) {
  const opts = { connecting };
  const a = await dav(env, creds, ICLOUD_ROOT, 'PROPFIND', 0, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`, opts);
  const principalHref = xmlText(xmlProp(xmlProp(a.xml, 'current-user-principal') || '', 'href') || '');
  if (!principalHref) throw new HttpError(502, 'caldav_error', 'iCloud didn’t say where this account’s calendars are. Check that iCloud Calendar is turned on for this Apple ID.');
  const principal = new URL(principalHref, a.url);
  const b = await dav(env, creds, principal, 'PROPFIND', 0, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, opts);
  const homeHref = xmlText(xmlProp(xmlProp(b.xml, 'calendar-home-set') || '', 'href') || '');
  if (!homeHref) throw new HttpError(502, 'caldav_error', 'iCloud didn’t list a calendar home for this Apple ID. Check that iCloud Calendar is turned on.');
  const home = new URL(homeHref, b.url);
  const c = await dav(env, creds, home, 'PROPFIND', 1,
    `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`, opts);
  const calendars = [];
  for (const r of xmlResponses(c.xml)) {
    const rt = xmlProp(r, 'resourcetype');
    if (!rt || !/<(?:[\w-]+:)?calendar\b/i.test(rt)) continue;
    const comps = xmlProp(r, 'supported-calendar-component-set');
    if (comps && !/name\s*=\s*["']VEVENT["']/i.test(comps)) continue; // reminders lists (VTODO only)
    const href = hrefOf(r);
    if (!href) continue;
    const url = new URL(href, c.url);
    if (!isIcloud(url)) continue;
    calendars.push({ id: url.toString(), name: (xmlText(xmlProp(r, 'displayname')) || 'Calendar').slice(0, 200) });
  }
  calendars.forEach((x, i) => { x.primary = i === 0; });
  return { home: home.toString(), calendars };
}

const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// Raw VCALENDAR texts (one per event resource, with any overrides and VTIMEZONEs) overlapping [fromMs, toMs).
export async function icloudEvents(env, creds, calUrl, fromMs, toMs) {
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>`
    + `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icsStamp(fromMs)}" end="${icsStamp(toMs)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const r = await dav(env, creds, calUrl, 'REPORT', 1, body);
  const out = [];
  for (const resp of xmlResponses(r.xml)) {
    const data = xmlText(xmlProp(resp, 'calendar-data'));
    if (data && /BEGIN:VCALENDAR/i.test(data)) out.push({ href: hrefOf(resp) || '', ics: data });
  }
  return out;
}
