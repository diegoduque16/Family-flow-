import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedToUtc, utcToLocal, localToUtc, occurrenceDates, expandEvent, parseRrule, seriesEndUtc } from '../src/lib/time.js';

test('zoned conversions incl. DST', () => {
  const tz = 'America/New_York';
  assert.equal(new Date(localToUtc('2026-07-04T09:30', tz)).toISOString(), '2026-07-04T13:30:00.000Z');
  assert.equal(new Date(localToUtc('2026-12-04T09:30', tz)).toISOString(), '2026-12-04T14:30:00.000Z');
  // spring-forward gap 2026-03-08 02:30 does not exist -> rolls forward
  const gap = localToUtc('2026-03-08T02:30', tz);
  assert.ok(['2026-03-08T07:30:00.000Z', '2026-03-08T06:30:00.000Z'].includes(new Date(gap).toISOString()));
  // fall-back ambiguity resolves to a valid instant
  assert.equal(utcToLocal(localToUtc('2026-11-01T01:30', tz), tz), '2026-11-01T01:30');
  assert.equal(utcToLocal(Date.parse('2026-01-01T00:00:00Z'), 'Asia/Tokyo'), '2026-01-01T09:00');
});

test('weekly BYDAY, count, until', () => {
  const d = [...occurrenceDates('2026-11-02T16:00', 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5')].map((o) => `${o.m}/${o.d}`);
  assert.deepEqual(d, ['11/2', '11/4', '11/9', '11/11', '11/16']);
  const u = [...occurrenceDates('2026-11-01', 'FREQ=DAILY;INTERVAL=2;UNTIL=2026-11-07')].map((o) => o.d);
  assert.deepEqual(u, [1, 3, 5, 7]);
  const m = [...occurrenceDates('2026-01-31T10:00', 'FREQ=MONTHLY;COUNT=4')].map((o) => `${o.m}/${o.d}`);
  assert.deepEqual(m, ['1/31', '3/31', '5/31', '7/31']);
  assert.throws(() => parseRrule('FREQ=HOURLY'));
});

test('expandEvent keeps wall time across DST and honours exdates', () => {
  const tz = 'America/New_York';
  const ev = { start_local: '2026-10-26T09:30', end_local: '2026-10-26T10:30', tz, all_day: 0,
    start_utc: localToUtc('2026-10-26T09:30', tz), end_utc: localToUtc('2026-10-26T10:30', tz),
    rrule: 'FREQ=WEEKLY', exdates: JSON.stringify(['2026-11-09T09:30']) };
  const occ = expandEvent(ev, Date.parse('2026-10-25T00:00:00Z'), Date.parse('2026-11-20T00:00:00Z'));
  assert.deepEqual(occ.map((o) => o.start_local), ['2026-10-26T09:30', '2026-11-02T09:30', '2026-11-16T09:30']);
  assert.equal(new Date(occ[0].start_utc).toISOString(), '2026-10-26T13:30:00.000Z');
  assert.equal(new Date(occ[1].start_utc).toISOString(), '2026-11-02T14:30:00.000Z');
  assert.equal(seriesEndUtc(ev), null);
});

test('all-day multi-day recurring', () => {
  const tz = 'America/Chicago';
  const ev = { start_local: '2026-12-24', end_local: '2026-12-26', tz, all_day: 1,
    start_utc: localToUtc('2026-12-24', tz), end_utc: localToUtc('2026-12-26', tz), rrule: 'FREQ=YEARLY;COUNT=3', exdates: '[]' };
  const occ = expandEvent(ev, Date.parse('2027-12-01T00:00:00Z'), Date.parse('2028-01-01T00:00:00Z'));
  assert.deepEqual(occ.map((o) => [o.start_local, o.end_local]), [['2027-12-24', '2027-12-26']]);
});

test('browser copy of time.js is identical to the server copy', async () => {
  const { readFileSync } = await import('node:fs');
  const a = readFileSync(new URL('../src/lib/time.js', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../public/js/time.js', import.meta.url), 'utf8');
  assert.equal(a, b, 'run: cp src/lib/time.js public/js/time.js');
});

test('an event starting in the repeated hour when clocks go back gets a valid one-hour default', async () => {
  const { makeEnv, signedUp } = await import('./harness.js');
  const env = makeEnv();
  const { c } = await signedUp(env);
  const r = await c.post('/api/events', { title: 'Late', start: '2026-11-01T01:30' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.event.endUtc - r.data.event.startUtc, 3600000);
  const spring = await c.post('/api/events', { title: 'Gap', start: '2027-03-14T02:30' }); // nonexistent time rolls forward
  assert.equal(spring.status, 201, JSON.stringify(spring.data));
});
