import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, signedUp, fakeFetch } from './harness.js';
import { expandIcs, parseRruleFull } from '../src/lib/ics.js';
import { refreshDueSources } from '../src/routes/sources.js';
import { utcToLocal } from '../src/lib/time.js';

const NY = 'America/New_York';
const range = (from, to) => ({ fromMs: Date.parse(from), toMs: Date.parse(to), fallbackTz: NY });
const local = (i) => (i.allDay ? i.startDate : utcToLocal(i.startUtc, NY));

// Shaped like Google's "Secret address in iCal format" export
const GOOGLE = [
  'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'X-WR-CALNAME:Ana Work', 'X-WR-TIMEZONE:America/New_York',
  'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'END:DAYLIGHT', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261102T090000', 'DTEND;TZID=America/New_York:20261102T093000',
  'RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,WE,FR', 'EXDATE;TZID=America/New_York:20261104T090000', 'DTSTAMP:20261030T120000Z',
  'UID:standup123@google.com', 'SUMMARY:Team standup', 'LOCATION:Zoom', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P0DT0H10M0S', 'END:VALARM', 'END:VEVENT',
  // moved instance: Friday Nov 6 moved to 10:00
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261106T100000', 'DTEND;TZID=America/New_York:20261106T103000',
  'RECURRENCE-ID;TZID=America/New_York:20261106T090000', 'UID:standup123@google.com', 'SUMMARY:Team standup (moved)', 'END:VEVENT',
  // cancelled instance Monday Nov 9
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261109T090000', 'DTEND;TZID=America/New_York:20261109T093000',
  'RECURRENCE-ID;TZID=America/New_York:20261109T090000', 'UID:standup123@google.com', 'STATUS:CANCELLED', 'SUMMARY:Team standup', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20261105T220000Z', 'DTEND:20261105T233000Z', 'UID:dinner@google.com', 'SUMMARY:Dinner with Sam\\, Lee',
  'DESCRIPTION:Bring wine\\nand dessert', 'LOCATION:12 Elm St\\, Essex\\, CT', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261126', 'DTEND;VALUE=DATE:20261128', 'UID:thanks@google.com', 'SUMMARY:Thanksgiving trip', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261110T183000', 'DTEND;TZID=America/New_York:20261110T200000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU',
  'UID:pta@google.com', 'SUMMARY:PTA meeting', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// Shaped like Outlook "Publish a calendar": Windows time-zone names, folded lines
const OUTLOOK = [
  'BEGIN:VCALENDAR', 'METHOD:PUBLISH', 'PRODID:Microsoft Exchange Server 2010', 'VERSION:2.0', 'X-WR-CALNAME:Calendar',
  'BEGIN:VEVENT', 'DESCRIPTION:\\n', 'RRULE:FREQ=WEEKLY;UNTIL=20261201T150000Z;INTERVAL=2;BYDAY=TU;WKST=SU',
  'UID:040000008200E00074C5B7101A82E00800000000',
  ' 1A2B3C', 'SUMMARY;LANGUAGE=en-US:Client call', 'DTSTART;TZID=Pacific Standard Time:20261103T070000',
  'DTEND;TZID=Pacific Standard Time:20261103T080000', 'CLASS:PUBLIC', 'TRANSP:OPAQUE', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:outlook-allday', 'SUMMARY:Day off', 'DTSTART;VALUE=DATE:20261113', 'DTEND;VALUE=DATE:20261114', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('Google-style feed: weekly BYDAY, EXDATE, moved + cancelled instances, UTC times, escaping, all-day, nth weekday', () => {
  const r = expandIcs(GOOGLE, range('2026-11-01T00:00:00Z', '2026-12-31T00:00:00Z'));
  assert.equal(r.calName, 'Ana Work');
  const stand = r.instances.filter((i) => i.uid === 'standup123@google.com').map((i) => `${local(i)} ${i.title}`).slice(0, 6);
  assert.deepEqual(stand, [
    '2026-11-02T09:00 Team standup', // Wed 4th excluded by EXDATE
    '2026-11-06T10:00 Team standup (moved)', // Mon 9th cancelled
    '2026-11-11T09:00 Team standup', '2026-11-13T09:00 Team standup', '2026-11-16T09:00 Team standup', '2026-11-18T09:00 Team standup']);
  const dinner = r.instances.find((i) => i.uid === 'dinner@google.com');
  assert.equal(local(dinner), '2026-11-05T17:00'); // 22:00Z = 5pm EST
  assert.equal(dinner.title, 'Dinner with Sam, Lee');
  assert.equal(dinner.notes, 'Bring wine\nand dessert');
  assert.equal(dinner.location, '12 Elm St, Essex, CT');
  const trip = r.instances.find((i) => i.uid === 'thanks@google.com');
  assert.deepEqual([trip.allDay, trip.startDate, trip.endDate], [true, '2026-11-26', '2026-11-28']);
  const pta = r.instances.filter((i) => i.uid === 'pta@google.com').map(local);
  assert.deepEqual(pta, ['2026-11-10T18:30', '2026-12-08T18:30']); // 2nd Tuesday
});

test('Outlook-style feed: Windows time zone, every 2 weeks with UNTIL, folded UID', () => {
  const r = expandIcs(OUTLOOK, range('2026-11-01T00:00:00Z', '2027-01-31T00:00:00Z'));
  const calls = r.instances.filter((i) => i.title === 'Client call');
  assert.deepEqual(calls.map(local), ['2026-11-03T10:00', '2026-11-17T10:00', '2026-12-01T10:00']); // 7am Pacific = 10am Eastern
  assert.equal(calls[0].uid, '040000008200E00074C5B7101A82E008000000001A2B3C');
  assert.equal(calls[0].endUtc - calls[0].startUtc, 3600000);
  assert.ok(r.instances.some((i) => i.title === 'Day off' && i.allDay && i.startDate === '2026-11-13'));
});

test('RRULE edge cases: last Friday, BYSETPOS, month-end, COUNT, yearly', () => {
  const ev = (rule, start = '20260130T120000') => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'SUMMARY:X', `DTSTART;TZID=America/New_York:${start}`, `RRULE:${rule}`, 'END:VEVENT', 'END:VCALENDAR'].join('\n');
  const L = (rule, start) => expandIcs(ev(rule, start), range('2026-01-01T00:00:00Z', '2027-03-01T00:00:00Z')).instances.map((i) => local(i).slice(0, 10));
  assert.deepEqual(L('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', '20260130T120000'), ['2026-01-30', '2026-02-27', '2026-03-27']);
  assert.deepEqual(L('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', '20260130T120000'), ['2026-01-30', '2026-02-27', '2026-03-31']);
  assert.deepEqual(L('FREQ=MONTHLY;COUNT=4', '20260131T120000'), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']); // RFC: skip months without a 31st
  assert.deepEqual(L('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', '20260131T120000'), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(L('FREQ=YEARLY;COUNT=2', '20260315T120000'), ['2026-03-15', '2027-03-15'].filter((d) => d < '2027-03-01'));
  assert.deepEqual(L('FREQ=DAILY;INTERVAL=3;COUNT=3', '20260301T120000'), ['2026-03-01', '2026-03-04', '2026-03-07']);
  assert.equal(parseRruleFull('FREQ=WEEKLY;BYDAY=2TU').byday[0].n, 2);
});

function feedEnv(body) {
  const env = makeEnv();
  const state = { body, status: 200, calls: 0 };
  env.__fetch = fakeFetch([[(u) => u.startsWith('https://calendar.google.com/calendar/ical/'), async () => { state.calls++; return new Response(state.body, { status: state.status, headers: { 'content-type': 'text/calendar' } }); }],
    [(u) => u.startsWith('https://example.com/'), async () => new Response('<!doctype html><html>Sign in</html>', { headers: { 'content-type': 'text/html' } })]]);
  return { env, state };
}
const GURL = 'webcal://calendar.google.com/calendar/ical/ana%40gmail.com/private-abc123/basic.ics';

test('connect a Google calendar: real fetch+parse on add, events appear read-only, assigned to a profile', async () => {
  // shift the fixture into the import window (60 days back .. 400 ahead) relative to now
  const { env } = feedEnv(GOOGLE);
  const { c, sync } = await signedUp(env);
  const mom = sync.members.find((m) => m.name === 'Mom');
  const r = await c.post('/api/calendar-sources', { url: GURL, memberId: mom.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.source.name, 'Ana Work');
  assert.equal(r.data.source.provider, 'google');
  assert.ok(r.data.imported > 10);
  const occ = (await c.get('/api/events?from=2026-11-01&to=2026-11-08')).data.occurrences;
  const dinner = occ.find((o) => o.title === 'Dinner with Sam, Lee');
  assert.ok(dinner);
  assert.equal(dinner.readOnly, true);
  assert.deepEqual(dinner.assignees, [mom.id]);
  assert.equal(dinner.start, '2026-11-05T17:00');
  const edit = await c.patch(`/api/events/${dinner.id}`, { version: dinner.version, title: 'x' });
  assert.equal(edit.status, 403);
  assert.match(edit.data.error.message, /Google Calendar/);
  // a conflicting Family Flow event for Mom is flagged
  const clash = await c.post('/api/events', { title: 'School pickup', start: '2026-11-05T17:15', assignees: [mom.id] });
  assert.equal(clash.data.conflicts[0].title, 'Dinner with Sam, Lee');
  // not re-exported in our own ICS feed (avoids duplicates if both are subscribed)
  const feed = (await c.get('/api/calendar-feed')).data.url;
  const ics = await c.get(new URL(feed).pathname);
  assert.doesNotMatch(ics.data, /Dinner with Sam/);
  // duplicate link refused
  assert.equal((await c.post('/api/calendar-sources', { url: GURL })).status, 409);
});

test('refresh picks up changes and deletions, without touching unchanged events', async () => {
  const { env, state } = feedEnv(GOOGLE);
  const { c } = await signedUp(env);
  const src = (await c.post('/api/calendar-sources', { url: GURL })).data.source;
  const s0 = (await c.get('/api/sync')).data.seq;
  // unchanged feed → no new sync changes
  await c.post(`/api/calendar-sources/${src.id}/sync`, {});
  assert.equal((await c.get(`/api/sync?since=${s0}`)).data.events.length, 0);
  // rename dinner, drop Thanksgiving
  state.body = GOOGLE.replace('Dinner with Sam\\, Lee', 'Dinner at Lee’s').replace(/BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261126[\s\S]*?END:VEVENT\r\n/, '');
  const r = (await c.post(`/api/calendar-sources/${src.id}/sync`, {})).data;
  assert.equal(r.sync.ok, true);
  const ch = (await c.get(`/api/sync?since=${s0}`)).data.events;
  assert.equal(ch.length, 2);
  assert.ok(ch.some((e) => e.title === 'Dinner at Lee’s'));
  assert.ok(ch.some((e) => e.deleted));
  // cron path: nothing due right after a sync, due again after 15 minutes
  assert.equal((await refreshDueSources(env)).checked, 0);
  assert.equal((await refreshDueSources(env, Date.now() + 16 * 60000)).checked, 1);
  // link revoked → clear error kept on the source, events stay as last seen
  state.status = 404;
  const bad = (await c.post(`/api/calendar-sources/${src.id}/sync`, {})).data;
  assert.equal(bad.sync.ok, false);
  assert.match(bad.source.error, /no longer exists/);
  assert.ok((await c.get('/api/events?from=2026-11-01&to=2026-11-08')).data.occurrences.some((o) => o.title === 'Dinner at Lee’s'));
  const diag = (await c.get('/api/diagnostics?live=0')).data.checks.find((x) => x.name === 'Imported calendars');
  assert.equal(diag.status, 'warn');
  // removing the calendar removes its events
  const del = await c.del(`/api/calendar-sources/${src.id}`);
  assert.ok(del.data.removedEvents > 0);
  assert.equal((await c.get('/api/events?from=2026-11-01&to=2026-11-08')).data.occurrences.length, 0);
});

test('bad links get specific explanations; private imports stay private; household isolation', async () => {
  const { env } = feedEnv(GOOGLE);
  const a = await signedUp(env);
  let r = await a.c.post('/api/calendar-sources', { url: 'https://calendar.google.com/calendar/u/0/r' });
  assert.equal(r.data.error.code, 'wrong_google_link');
  r = await a.c.post('/api/calendar-sources', { url: 'https://example.com/cal' });
  assert.equal(r.data.error.code, 'not_a_calendar');
  r = await a.c.post('/api/calendar-sources', { url: 'http://localhost/x.ics' });
  assert.equal(r.data.error.code, 'invalid_url');

  await a.c.post('/api/calendar-sources', { url: GURL, visibility: 'private' });
  const inv = await a.c.post('/api/invites', { role: 'adult' });
  const p = await signedUp(env, { name: 'P', inviteToken: inv.data.token });
  assert.equal((await p.c.get('/api/calendar-sources')).data.sources.length, 0);
  assert.equal((await p.c.get('/api/events?from=2026-11-01&to=2026-11-08')).data.occurrences.length, 0);
  assert.ok((await a.c.get('/api/events?from=2026-11-01&to=2026-11-08')).data.occurrences.length > 0);
  const b = await signedUp(env, { household: 'Other' });
  assert.equal((await b.c.get('/api/events?from=2026-11-01&to=2026-11-08')).data.occurrences.length, 0);
});
