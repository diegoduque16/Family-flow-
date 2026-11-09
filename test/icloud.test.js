import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, signedUp, fakeFetch } from './harness.js';
import { refreshDueSources } from '../src/routes/sources.js';
import { utcToLocal } from '../src/lib/time.js';
import { xmlProp, xmlText, xmlResponses } from '../src/lib/caldav.js';

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ymd = (n) => day(n).replace(/-/g, '');
const GOOD = `Basic ${Buffer.from('ana@icloud.com:abcd-efgh-ijkl-mnop').toString('base64')}`;
const HOST = 'https://p52-caldav.icloud.com';

const ms = (body) => new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:">${body}</multistatus>`, { status: 207, headers: { 'content-type': 'text/xml' } });

// A fake iCloud: root redirects to a partition host (like the real one), then principal → home → calendars → events.
function icloud(state) {
  return fakeFetch([
    [(u) => u.startsWith('https://evil.example'), async () => { throw new Error('credentials sent outside iCloud'); }],
    [(u, init) => init.headers.authorization !== (state.auth || GOOD), async () => new Response('Unauthorized', { status: 401 })],
    [(u) => u === 'https://caldav.icloud.com/', async () => new Response(null, { status: 301, headers: { location: `${HOST}/` } })],
    [(u, init) => u === `${HOST}/` && init.method === 'PROPFIND', async (u, init) => {
      assert.equal(init.headers.depth, '0');
      return ms('<response><href>/</href><propstat><prop><current-user-principal><href>/1234567/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response>');
    }],
    [(u) => u === `${HOST}/1234567/principal/`, async () => ms(`<response><href>/1234567/principal/</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">${HOST}:443/1234567/calendars/</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>`)],
    [(u, init) => u === `${HOST}/1234567/calendars/` && init.method === 'PROPFIND', async (u, init) => {
      assert.equal(init.headers.depth, '1');
      return ms(`
        <response><href>/1234567/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
        <response><href>/1234567/calendars/home/</href><propstat><prop><displayname>Home</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>
          <C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"><C:comp name="VEVENT"/></C:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
        <response><href>/1234567/calendars/work/</href><propstat><prop><displayname>Kids &amp; School</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
        <response><href>/1234567/calendars/tasks/</href><propstat><prop><displayname>Reminders</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>
          <C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"><C:comp name="VTODO"/></C:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
        <response><href>/1234567/calendars/inbox/</href><propstat><prop><displayname>Inbox</displayname><resourcetype><collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`);
    }],
    [(u, init) => init.method === 'REPORT', async (u, init) => {
      assert.match(init.body, /<c:time-range start="\d{8}T\d{6}Z" end="\d{8}T\d{6}Z"\/>/);
      state.reports = (state.reports || 0) + 1;
      if (u.endsWith('/home/')) {
        const piano = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:piano-1\r\nDTSTART;TZID=America/New_York:${ymd(1)}T160000\r\nDTEND;TZID=America/New_York:${ymd(1)}T170000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:${state.pianoTitle || 'Piano'} & theory\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
        const dinner = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:dinner-1\nDTSTART:${ymd(2)}T230000Z\nDTEND:${ymd(3)}T003000Z\nSUMMARY:Dinner at Nonna's\nLOCATION:12 Elm St\nEND:VEVENT\nEND:VCALENDAR\n`;
        return ms(`<response><href>/1234567/calendars/home/piano.ics</href><propstat><prop><getetag>"1"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">${piano.replace(/&/g, '&amp;')}</calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`
          + `<response><href>/1234567/calendars/home/dinner.ics</href><propstat><prop><getetag>"2"</getetag><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav"><![CDATA[${dinner}]]></C:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`);
      }
      const trip = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:trip\nDTSTART;VALUE=DATE:${ymd(4)}\nDTEND;VALUE=DATE:${ymd(5)}\nSUMMARY:Field trip\nEND:VEVENT\nEND:VCALENDAR\n`;
      return ms(`<response><href>/1234567/calendars/work/trip.ics</href><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">${trip}</calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`);
    }],
  ]);
}

test('XML helpers: namespaces, entities, CDATA, self-closing', () => {
  const x = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a%20b/</d:href><d:displayname/></d:response><D:response><D:href>/c/</D:href></D:response></d:multistatus>';
  const rs = xmlResponses(x);
  assert.equal(rs.length, 2);
  assert.equal(xmlText(xmlProp(rs[0], 'href')), '/a%20b/');
  assert.equal(xmlProp(rs[0], 'displayname'), '');
  assert.equal(xmlProp(rs[0], 'getetag'), null);
  assert.equal(xmlText('a &amp; b <![CDATA[x & <y>]]> &#233;'), 'a & b x & <y> é');
});

test('Connect iCloud with Apple ID + app-specific password: all event calendars, repeats expanded, encrypted, refreshed', async () => {
  const st = {};
  const env = makeEnv({ CREDENTIALS_KEY: 'k'.repeat(40) });
  env.__fetch = icloud(st);
  const { c, sync } = await signedUp(env);
  assert.equal((await c.get('/api/me')).data.features.icloudCalendar, true);
  const mom = sync.members.find((m) => m.name === 'Mom');

  // wrong password: clear message, nothing saved
  st.auth = 'nope';
  const bad = await c.post('/api/calendar-accounts/icloud/connect', { appleId: 'Ana@iCloud.com ', password: 'wrongwrongwrong1', memberId: mom.id });
  assert.equal(bad.status, 422);
  assert.match(bad.data.error.message, /app-specific password/);
  assert.equal((await c.get('/api/calendar-sources')).data.sources.length, 0);
  st.auth = null;

  const r = await c.post('/api/calendar-accounts/icloud/connect', { appleId: 'Ana@iCloud.com ', password: 'abcd-efgh-ijkl-mnop', memberId: mom.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.imported, 5); // piano ×3, dinner, field trip

  const src = (await c.get('/api/calendar-sources')).data.sources[0];
  assert.equal(src.kind, 'icloud');
  assert.equal(src.provider, 'apple');
  assert.equal(src.accountEmail, 'ana@icloud.com');
  assert.deepEqual(src.calendars.map((x) => x.name), ['Home', 'Kids & School']);
  const row = await env.DB.prepare('SELECT token_enc, url FROM calendar_sources').first();
  assert.ok(!row.token_enc.includes('efgh') && !row.token_enc.includes('ana@'), 'credentials are not stored in plain text');

  const occ = (await c.get(`/api/events?from=${day(0)}&to=${day(20)}`)).data.occurrences;
  const piano = occ.filter((o) => o.title === 'Piano & theory');
  assert.equal(piano.length, 3);
  assert.equal(piano[0].start, `${day(1)}T16:00`);
  assert.equal(piano[0].readOnly, true);
  assert.deepEqual(piano[0].assignees, [mom.id]);
  const dinner = occ.find((o) => o.title === "Dinner at Nonna's");
  assert.equal(dinner.start, utcToLocal(Date.parse(`${day(2)}T23:00:00Z`), 'America/New_York'));
  assert.ok(occ.some((o) => o.title === 'Field trip' && o.allDay));

  // choose calendars: only ids iCloud listed are accepted (the password is sent to them)
  const cals = (await c.get(`/api/calendar-sources/${src.id}/calendars`)).data.calendars;
  assert.deepEqual(cals.map((x) => [x.name, x.selected]), [['Home', true], ['Kids & School', true]]);
  const evil = await c.post(`/api/calendar-sources/${src.id}/calendars`, { calendars: [{ id: 'https://evil.example/cal/', name: 'x' }] });
  assert.equal(evil.status, 422);
  const only = await c.post(`/api/calendar-sources/${src.id}/calendars`, { calendars: [cals[0]].map(({ id, name }) => ({ id, name })) });
  assert.equal(only.data.ok, true);
  assert.ok(!(await c.get(`/api/events?from=${day(0)}&to=${day(20)}`)).data.occurrences.some((o) => o.title === 'Field trip'));

  // scheduled refresh picks up changes
  st.pianoTitle = 'Piano lesson';
  assert.equal((await refreshDueSources(env, Date.now() + 16 * 60000)).failed, 0);
  assert.equal((await c.get(`/api/events?from=${day(0)}&to=${day(20)}`)).data.occurrences.filter((o) => o.title === 'Piano lesson & theory').length, 3);

  // app-specific password revoked: Reconnect message, events kept; reconnecting updates the same source
  st.auth = 'revoked';
  const s2 = (await c.post(`/api/calendar-sources/${src.id}/sync`, {})).data;
  assert.equal(s2.sync.ok, false);
  assert.match(s2.source.error, /Reconnect/);
  assert.ok((await c.get(`/api/events?from=${day(0)}&to=${day(20)}`)).data.occurrences.some((o) => o.title === 'Piano lesson & theory'));
  st.auth = null;
  const again = await c.post('/api/calendar-accounts/icloud/connect', { appleId: 'ana@icloud.com', password: ' abcd-efgh-ijkl-mnop ' });
  assert.equal(again.status, 201);
  assert.equal((await c.get('/api/calendar-sources')).data.sources.length, 1);
  assert.equal((await c.get('/api/calendar-sources')).data.sources[0].status, 'ok');
});

test('iCloud: not configured is explained; never redirects credentials off icloud.com; OAuth start rejects icloud', async () => {
  const env = makeEnv({});
  const { c } = await signedUp(env);
  assert.equal((await c.get('/api/me')).data.features.icloudCalendar, false);
  const r = await c.post('/api/calendar-accounts/icloud/connect', { appleId: 'a@icloud.com', password: 'abcdefghijklmnop' });
  assert.equal(r.status, 503);
  assert.match(r.data.error.message, /calendar link/);

  const env2 = makeEnv({ CREDENTIALS_KEY: 'k'.repeat(40) });
  env2.__fetch = fakeFetch([[() => true, async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })]]);
  const b = await signedUp(env2);
  const r2 = await b.c.post('/api/calendar-accounts/icloud/connect', { appleId: 'a@icloud.com', password: 'abcdefghijklmnop' });
  assert.equal(r2.status, 502);
  assert.ok(!env2.__fetch.calls.some((x) => x.url.startsWith('https://evil.example')));
  assert.equal((await b.c.post('/api/calendar-accounts/icloud/start', {})).status, 404);
});
