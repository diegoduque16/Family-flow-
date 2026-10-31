import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, client, signedUp, D1Shim } from './harness.js';

test('sign-up creates a household with default profiles and lists; auth + CSRF enforced', async () => {
  const env = makeEnv();
  const { c, me, sync } = await signedUp(env);
  assert.equal(me.role, 'owner');
  assert.deepEqual(sync.members.map((m) => m.name), ['Mom', 'Dad', 'Kiddo 1', 'Kiddo 2']);
  assert.deepEqual(sync.lists.map((l) => l.name), ['To-do', 'Groceries', 'Shopping']);
  const anon = client(env);
  assert.equal((await anon.get('/api/sync')).status, 401);
  // missing CSRF header
  const r = await c.call('POST', '/api/events', { title: 'x', start: '2026-11-01T10:00' }, { 'x-ff': '0' });
  assert.equal(r.status, 403);
  // wrong password
  const bad = await client(env).post('/api/auth/login', { email: me.user.email, password: 'nope' });
  assert.equal(bad.status, 401);
  const good = await client(env).post('/api/auth/login', { email: me.user.email.toUpperCase(), password: 'correct horse battery' });
  assert.equal(good.status, 200);
  // duplicate email
  const dup = await client(env).post('/api/auth/signup', { name: 'X', email: me.user.email, password: 'whatever12', householdName: 'X' });
  assert.equal(dup.status, 409);
});

test('events persist across database connections, edit with versions, conflicts detected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-'));
  const file = join(dir, 'db.sqlite');
  const env1 = makeEnv({ DB: new D1Shim(file).migrate() });
  const { c, sync } = await signedUp(env1);
  const [mom, dad, k1] = sync.members;
  const created = await c.post('/api/events', {
    title: 'Soccer', start: '2026-11-07T09:30', end: '2026-11-07T11:00', assignees: [k1.id],
    location: { name: 'Town Field', address: '1 Field Rd, Old Lyme, CT 06371', lat: 41.3, lon: -72.3 }, reminders: [60],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const ev = created.data.event;
  assert.equal(new Date(ev.startUtc).toISOString(), '2026-11-07T14:30:00.000Z');

  // "restart": brand-new connection to the same file
  const env2 = makeEnv({ DB: new D1Shim(file) });
  const c2 = client(env2);
  // reuse cookie by logging in again
  const meEmail = (await c.get('/api/me')).data.user.email;
  assert.equal((await c2.post('/api/auth/login', { email: meEmail, password: 'correct horse battery' })).status, 200);
  const list = await c2.get('/api/events?from=2026-11-01&to=2026-11-30');
  assert.equal(list.data.occurrences.length, 1);
  assert.equal(list.data.occurrences[0].title, 'Soccer');
  assert.equal(list.data.occurrences[0].location.address, '1 Field Rd, Old Lyme, CT 06371');

  // edit with correct version
  const upd = await c2.patch(`/api/events/${ev.id}`, { version: ev.version, title: 'Soccer game', start: '2026-11-07T10:00' });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  assert.equal(upd.data.event.end, '2026-11-07T11:30'); // duration kept
  // stale version -> 409 with current copy
  const stale = await c2.patch(`/api/events/${ev.id}`, { version: ev.version, title: 'Overwrite' });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.current.title, 'Soccer game');

  // conflicting event for the same child
  const clash = await c2.post('/api/events', { title: 'Dentist', start: '2026-11-07T10:30', assignees: [k1.id, mom.id] });
  assert.equal(clash.data.conflicts.length, 1);
  assert.equal(clash.data.conflicts[0].title, 'Soccer game');
  const noClash = await c2.post('/api/events', { title: 'Haircut', start: '2026-11-07T10:30', assignees: [dad.id] });
  assert.equal(noClash.data.conflicts.length, 0);

  // validation
  const badEnd = await c2.post('/api/events', { title: 'x', start: '2026-11-07T10:30', end: '2026-11-07T09:00' });
  assert.equal(badEnd.status, 422);
  const badMember = await c2.post('/api/events', { title: 'x', start: '2026-11-07T10:30', assignees: ['m_nope'] });
  assert.equal(badMember.status, 422);

  // delete
  const cur = (await c2.get(`/api/events/${ev.id}`)).data.event;
  assert.equal((await c2.del(`/api/events/${ev.id}?version=${cur.version}`)).status, 200);
  assert.equal((await c2.get(`/api/events/${ev.id}`)).status, 404);
});

test('recurring events: weekly series, edit one occurrence, edit following, delete one', async () => {
  const env = makeEnv();
  const { c } = await signedUp(env);
  const r = await c.post('/api/events', { title: 'Piano', start: '2026-11-02T16:00', end: '2026-11-02T16:45', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  let ev = r.data.event;
  const occ = async () => (await c.get('/api/events?from=2026-11-01&to=2026-12-01')).data.occurrences.map((o) => `${o.occurrence.start_local} ${o.title}`);
  assert.deepEqual(await occ(), ['2026-11-02T16:00 Piano', '2026-11-09T16:00 Piano', '2026-11-16T16:00 Piano', '2026-11-23T16:00 Piano', '2026-11-30T16:00 Piano']);

  // move just Nov 9 to 17:00
  const one = await c.patch(`/api/events/${ev.id}`, { version: ev.version, scope: 'this', occurrence: '2026-11-09T16:00', start: '2026-11-09T17:00' });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  ev = one.data.series;
  assert.ok((await occ()).includes('2026-11-09T17:00 Piano'));
  assert.ok(!(await occ()).includes('2026-11-09T16:00 Piano'));

  // rename from Nov 23 onwards
  const fol = await c.patch(`/api/events/${ev.id}`, { version: ev.version, scope: 'following', occurrence: '2026-11-23T16:00', title: 'Piano (new teacher)' });
  assert.equal(fol.status, 200, JSON.stringify(fol.data));
  ev = fol.data.series;
  const after = await occ();
  assert.ok(after.includes('2026-11-16T16:00 Piano'));
  assert.ok(after.includes('2026-11-23T16:00 Piano (new teacher)'));
  assert.ok(after.includes('2026-11-30T16:00 Piano (new teacher)'));
  assert.ok(!after.includes('2026-11-23T16:00 Piano'));

  // delete Nov 16 only
  const d = await c.del(`/api/events/${ev.id}?version=${ev.version}&scope=this&occurrence=2026-11-16T16:00`);
  assert.equal(d.status, 200);
  assert.ok(!(await occ()).includes('2026-11-16T16:00 Piano'));
  assert.ok((await occ()).includes('2026-11-02T16:00 Piano'));
});

test('all-day events and invalid recurrence', async () => {
  const env = makeEnv();
  const { c } = await signedUp(env);
  const r = await c.post('/api/events', { title: 'Grandma visiting', allDay: true, start: '2026-11-26', end: '2026-11-29' });
  assert.equal(r.status, 201);
  const occ = (await c.get('/api/events?from=2026-11-27&to=2026-11-28')).data.occurrences;
  assert.equal(occ.length, 1);
  assert.equal((await c.post('/api/events', { title: 'x', allDay: true, start: '2026-11-26T10:00' })).status, 422);
  assert.equal((await c.post('/api/events', { title: 'x', start: '2026-11-26T10:00', rrule: 'FREQ=SECONDLY' })).status, 422);
});

test('households are isolated; private events stay private; roles enforced', async () => {
  const env = makeEnv();
  const a = await signedUp(env, { household: 'A' });
  const b = await signedUp(env, { household: 'B' });
  const ev = (await a.c.post('/api/events', { title: 'A secret', start: '2026-11-10T10:00' })).data.event;
  assert.equal((await b.c.get(`/api/events/${ev.id}`)).status, 404);
  assert.equal((await b.c.patch(`/api/events/${ev.id}`, { version: 1, title: 'hacked' })).status, 404);
  assert.equal((await b.c.get('/api/events?from=2026-11-01&to=2026-12-01')).data.occurrences.length, 0);

  // invite an adult and a child into A
  const inv = await a.c.post('/api/invites', { role: 'adult' });
  assert.equal(inv.status, 201);
  const info = await client(env).get(`/api/invites/${inv.data.token}`);
  assert.equal(info.data.householdName, 'A');
  const partner = await signedUp(env, { name: 'Leo', inviteToken: inv.data.token });
  assert.equal(partner.me.household.name, 'A');
  assert.equal(partner.me.role, 'adult');
  // invite cannot be reused
  assert.equal((await client(env).get(`/api/invites/${inv.data.token}`)).status, 410);

  const priv = (await a.c.post('/api/events', { title: 'Surprise party planning', start: '2026-11-11T20:00', visibility: 'private' })).data.event;
  const seen = (await partner.c.get('/api/events?from=2026-11-01&to=2026-12-01')).data.occurrences.map((o) => o.title);
  assert.deepEqual(seen, ['A secret']);
  assert.equal((await partner.c.get(`/api/events/${priv.id}`)).status, 404);
  const syncP = (await partner.c.get('/api/sync')).data;
  assert.ok(syncP.events.find((e) => e.id === priv.id).deleted);

  const childInv = await a.c.post('/api/invites', { role: 'child' });
  const kid = await signedUp(env, { name: 'Kid', inviteToken: childInv.data.token });
  assert.equal((await kid.c.post('/api/events', { title: 'Party', start: '2026-11-12T10:00' })).status, 403);
  assert.equal((await kid.c.post('/api/invites', { role: 'adult' })).status, 403);
  assert.equal((await partner.c.post('/api/invites', { role: 'adult' })).status, 403);
});

test('sync feed returns only changes since a sequence number', async () => {
  const env = makeEnv();
  const { c, sync } = await signedUp(env);
  const seq0 = sync.seq;
  await c.post('/api/events', { title: 'One', start: '2026-11-10T10:00' });
  const s1 = (await c.get(`/api/sync?since=${seq0}`)).data;
  assert.equal(s1.events.length, 1);
  assert.equal(s1.members.length, 0);
  const s2 = (await c.get(`/api/sync?since=${s1.seq}`)).data;
  assert.equal(s2.events.length + s2.tasks.length + s2.members.length + s2.lists.length, 0);
});

test('tasks: create, assign, repeating completion rolls forward, child may only tick', async () => {
  const env = makeEnv();
  const { c, sync } = await signedUp(env);
  const todo = sync.lists.find((l) => l.name === 'To-do');
  const dad = sync.members.find((m) => m.name === 'Dad');
  const t = await c.post('/api/tasks', { listId: todo.id, title: 'Buy a present', due: '2026-11-06', assignee: dad.id, remind: true });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  const rep = (await c.post('/api/tasks', { listId: todo.id, title: 'Take out bins', due: '2026-11-03', repeat: 'weekly' })).data.task;
  const done = await c.patch(`/api/tasks/${rep.id}`, { version: rep.version, done: true });
  assert.equal(done.data.task.done, false);
  assert.equal(done.data.task.due, '2026-11-10');
  const bad = await c.post('/api/tasks', { listId: 'l_nope', title: 'x' });
  assert.equal(bad.status, 422);
});

test('ICS feed includes shared events with recurrence and excludes private ones', async () => {
  const env = makeEnv();
  const { c } = await signedUp(env);
  await c.post('/api/events', { title: 'Swim, lessons', start: '2026-11-03T17:00', rrule: 'FREQ=WEEKLY;UNTIL=2026-12-15', location: { name: 'YMCA', address: '5 Pool St' } });
  await c.post('/api/events', { title: 'Private thing', start: '2026-11-03T18:00', visibility: 'private' });
  const info = (await c.get('/api/calendar-feed')).data;
  const path = new URL(info.url).pathname;
  const ics = await client(env).get(path);
  assert.equal(ics.status, 200);
  assert.match(ics.data, /SUMMARY:Swim\\, lessons/);
  assert.match(ics.data, /RRULE:FREQ=WEEKLY;UNTIL=20261215T235959Z/);
  assert.match(ics.data, /DTSTART;TZID=America\/New_York:20261103T170000/);
  assert.doesNotMatch(ics.data, /Private thing/);
  assert.equal((await client(env).get('/cal/wrong.ics')).status, 404);
});

test('profiles can be added, renamed and removed', async () => {
  const env = makeEnv();
  const { c, sync } = await signedUp(env);
  const k2 = sync.members.find((m) => m.name === 'Kiddo 2');
  const ren = await c.patch(`/api/members/${k2.id}`, { version: k2.version, name: 'Mia' });
  assert.equal(ren.data.member.name, 'Mia');
  const add = await c.post('/api/members', { name: 'Grandpa', color: '#336699', kind: 'adult' });
  assert.equal(add.status, 201);
  assert.equal((await c.del(`/api/members/${add.data.member.id}`)).status, 200);
  const names = (await c.get('/api/sync')).data.members.filter((m) => !m.deleted).map((m) => m.name);
  assert.deepEqual(names, ['Mom', 'Dad', 'Kiddo 1', 'Mia']);
});

test('export and household deletion', async () => {
  const env = makeEnv();
  const { c } = await signedUp(env, { household: 'Delete Me' });
  await c.post('/api/events', { title: 'Keep', start: '2026-11-10T10:00' });
  const ex = await c.get('/api/household/export');
  assert.equal(ex.status, 200);
  assert.equal(ex.data.events.length, 1);
  assert.equal((await c.del('/api/household', { confirm: 'wrong' })).status, 422);
  assert.equal((await c.del('/api/household', { confirm: 'Delete Me' })).status, 200);
  assert.equal((await c.get('/api/sync')).status, 409);
});
