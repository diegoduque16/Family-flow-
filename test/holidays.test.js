import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usHolidays, holidaysBetween, effectiveHolidays } from '../public/js/holidays.js';
import { makeEnv, signedUp } from './harness.js';

const find = (y, name) => usHolidays(y).find((h) => h.name === name)?.date;

test('US holiday dates are right (2026 and 2027)', () => {
  assert.equal(find(2026, 'Martin Luther King Jr. Day'), '2026-01-19');
  assert.equal(find(2026, 'Presidents’ Day'), '2026-02-16');
  assert.equal(find(2026, 'Easter Sunday'), '2026-04-05');
  assert.equal(find(2027, 'Easter Sunday'), '2027-03-28');
  assert.equal(find(2026, 'Mother’s Day'), '2026-05-10');
  assert.equal(find(2026, 'Memorial Day'), '2026-05-25');
  assert.equal(find(2026, 'Father’s Day'), '2026-06-21');
  assert.equal(find(2026, 'Labor Day'), '2026-09-07');
  assert.equal(find(2026, 'Columbus Day / Indigenous Peoples’ Day'), '2026-10-12');
  assert.equal(find(2026, 'Thanksgiving'), '2026-11-26');
  assert.equal(find(2027, 'Thanksgiving'), '2027-11-25');
  // July 4 2026 is a Saturday -> observed Friday July 3
  assert.equal(find(2026, 'Independence Day (observed)'), '2026-07-03');
  // Christmas 2027 is a Saturday -> observed Friday Dec 24; New Year 2028 (Sat) observed Fri Dec 31 2027
  assert.equal(find(2027, 'Christmas Day (observed)'), '2027-12-24');
  assert.ok(holidaysBetween('US', '2027-12-30', '2028-01-02').some((h) => h.date === '2027-12-31' && h.name === 'New Year’s Day (observed)'));
  assert.equal(holidaysBetween('US', '2026-11-01', '2026-12-01').map((h) => h.name).join(', '), 'Veterans Day, Thanksgiving');
  assert.deepEqual(holidaysBetween('none', '2026-01-01', '2027-01-01'), []);
});

test('holiday setting: automatic from the time zone, can be turned off or on', async () => {
  assert.equal(effectiveHolidays(null, 'America/New_York'), 'US');
  assert.equal(effectiveHolidays(null, 'America/Indiana/Indianapolis'), 'US');
  assert.equal(effectiveHolidays(null, 'Europe/Paris'), null);
  assert.equal(effectiveHolidays('US', 'Europe/Paris'), 'US');
  assert.equal(effectiveHolidays('none', 'America/Chicago'), null);
  const env = makeEnv();
  const a = await signedUp(env);
  assert.equal(a.sync.household.holidays, 'US');
  assert.equal(a.sync.household.holidaysSetting, 'auto');
  assert.equal((await a.c.patch('/api/household', { holidays: 'none' })).status, 200);
  assert.equal((await a.c.get('/api/sync')).data.household.holidays, null);
  assert.equal((await a.c.patch('/api/household', { holidays: 'auto' })).status, 200);
  assert.equal((await a.c.get('/api/sync')).data.household.holidays, 'US');
  assert.equal((await a.c.patch('/api/household', { holidays: 'Mars' })).status, 422);
});
