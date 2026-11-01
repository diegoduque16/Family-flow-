// Local dev/e2e server: runs the real Worker code in Node with a SQLite-backed D1 shim and serves public/ like Workers Assets.
// Usage: node scripts/dev-server.js [port] [dbfile]   (MOCK_AI=1 for a scripted assistant; MOCK_PLACES=1 for canned address results)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { D1Shim } from '../test/harness.js';
import worker, { handle } from '../src/index.js';
import { deliverDueReminders } from '../src/routes/ops.js';
import { refreshDueSources } from '../src/routes/sources.js';

const port = Number(process.argv[2] || 8787);
const file = process.argv[3] || ':memory:';
const DB = new D1Shim(file);
try { DB.migrate(); } catch (e) { if (!/already exists/.test(e.message)) throw e; }
const root = new URL('../public/', import.meta.url).pathname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const ASSETS = {
  async fetch(req) {
    const u = new URL(req.url);
    let p = normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    try {
      const body = await readFile(join(root, p));
      return new Response(body, { headers: { 'content-type': types[extname(p)] || 'application/octet-stream' } });
    } catch {
      const body = await readFile(join(root, 'index.html')); // SPA fallback
      return new Response(body, { headers: { 'content-type': types['.html'] } });
    }
  },
};

const env = { DB, ASSETS, ADMIN_EMAILS: process.env.ADMIN_EMAILS || '' };
for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET']) if (process.env[k]) env[k] = process.env[k];
if (process.env.MOCK_PLACES) {
  env.GEOAPIFY_API_KEY = 'mock';
  const real = fetch;
  env.__fetch = async (url, init) => {
    if (String(url).startsWith('https://api.geoapify.com/')) {
      const q = new URL(url).searchParams.get('text').toLowerCase();
      const all = [
        { formatted: '200 Main Street, Old Saybrook, CT 06475, United States of America', address_line1: '200 Main Street', name: '', lat: 41.29, lon: -72.38, result_type: 'building' },
        { formatted: 'Lincoln Elementary School, 50 School Rd, Essex, CT 06426, United States of America', address_line1: '50 School Rd', name: 'Lincoln Elementary School', lat: 41.35, lon: -72.39, result_type: 'amenity' },
      ];
      return Response.json({ results: all.filter((r) => r.formatted.toLowerCase().includes(q.split(' ')[0])) });
    }
    return env.__aiFetch ? env.__aiFetch(url, init) : real(url, init);
  };
}
if (process.env.MOCK_AI) {
  env.ANTHROPIC_API_KEY = 'mock';
  const prev = env.__fetch || fetch;
  env.__aiFetch = async (url, init) => {
    if (String(url) !== 'https://api.anthropic.com/v1/messages') return fetch(url, init);
    const body = JSON.parse(init.body);
    const last = body.messages[body.messages.length - 1];
    if (last.content.some && last.content.some((b) => b.type === 'tool_result')) {
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'I’ve prepared that for you. Check it and tap Confirm.' }] });
    }
    const text = last.content.map ? last.content.map((b) => b.text || '').join(' ') : String(last.content);
    const today = body.system.match(/Today is [A-Za-z]+,? (\d{4}-\d{2}-\d{2})/);
    const d = today ? today[1] : new Date().toISOString().slice(0, 10);
    const next = new Date(`${d}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 2);
    const day = next.toISOString().slice(0, 10);
    if (/milk/i.test(text)) return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'propose_task', input: { title: 'Milk', list: 'Groceries' } }] });
    return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'propose_event', input: { title: 'Dentist', start: `${day}T15:30`, end: `${day}T16:30`, assignees: ['Kiddo 2'], reminders_minutes: [60], assumptions: ['Assumed it takes 1 hour'] } }] });
  };
  if (!process.env.MOCK_PLACES) env.__fetch = env.__aiFetch;
  void prev;
}

// Canned Google/Outlook feeds for the browser test (any calendar.google.com/calendar/ical/... or outlook.office365.com/owa/calendar/... link)
if (process.env.MOCK_CAL) {
  const inner = env.__fetch || fetch;
  env.__fetch = async (url, init) => {
    const u = String(url);
    if (/^https:\/\/(calendar\.google\.com\/calendar\/ical|outlook\.office365\.com\/owa\/calendar)\//.test(u)) {
      const d = new Date(Date.now() + 86400000);
      const day = d.toISOString().slice(0, 10).replace(/-/g, '');
      const google = u.includes('google');
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', `X-WR-CALNAME:${google ? 'Ana Work' : 'Leo Office'}`,
        'BEGIN:VEVENT', `UID:${google ? 'g1' : 'o1'}`, `SUMMARY:${google ? 'Quarterly review' : 'Client lunch'}`,
        google ? `DTSTART;TZID=America/New_York:${day}T100000` : `DTSTART;TZID=Pacific Standard Time:${day}T090000`,
        google ? `DTEND;TZID=America/New_York:${day}T110000` : `DTEND;TZID=Pacific Standard Time:${day}T100000`,
        'LOCATION:HQ\\, 5th floor', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      return new Response(ics, { headers: { 'content-type': 'text/calendar' } });
    }
    return inner(url, init);
  };
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const url = `http://${req.headers.host}${req.url}`;
  try {
    const r = await handle(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
    const out = {};
    r.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { console.error(e); res.writeHead(500); res.end('dev server error'); }
});
server.listen(port, () => console.log(`Family Flow dev server on http://localhost:${port}`));
setInterval(() => { deliverDueReminders(env).catch((e) => console.error('cron', e)); refreshDueSources(env).catch((e) => console.error('import', e)); }, 60000);
void worker;
