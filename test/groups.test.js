import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, client, signedUp } from './harness.js';
import { deliverDueReminders } from '../src/routes/ops.js';

// Mom (owner), Dad and Grandma each have a login linked to their profile.
async function family() {
  const env = makeEnv();
  const mom = await signedUp(env, { name: 'Ana' });
  const [momP, dadP, k1] = mom.sync.members;
  await mom.c.patch('/api/me/profile', { memberId: momP.id });
  const gma = (await mom.c.post('/api/members', { name: 'Grandma', color: '#8D6E63', kind: 'adult' })).data.member;
  const invDad = await mom.c.post('/api/invites', { role: 'adult', memberId: dadP.id });
  const dad = await signedUp(env, { name: 'Leo', inviteToken: invDad.data.token });
  const invGma = await mom.c.post('/api/invites', { role: 'adult', memberId: gma.id });
  const grandma = await signedUp(env, { name: 'Rosa', inviteToken: invGma.data.token });
  const nuclear = (await mom.c.post('/api/groups', { name: 'Nuclear', memberIds: [momP.id, dadP.id, k1.id] })).data.group;
  const extended = (await mom.c.post('/api/groups', { name: 'Extended', memberIds: [momP.id, dadP.id, gma.id] })).data.group;
  return { env, mom, dad, grandma, p: { mom: momP, dad: dadP, k1, gma }, nuclear, extended };
}
const inbox = async (who) => (await who.c.get('/api/notifications')).data.notifications;
const activity = async (who) => (await inbox(who)).filter((n) => n.kind === 'activity');

test('groups: create, validate members, appear in sync for everyone', async () => {
  const f = await family();
  assert.equal(f.nuclear.memberIds.length, 3);
  const s = (await f.grandma.c.get('/api/sync')).data;
  assert.deepEqual(s.groups.map((g) => g.name).sort(), ['Extended', 'Nuclear']);
  const bad = await f.mom.c.post('/api/groups', { name: 'X', memberIds: ['m_nope'] });
  assert.equal(bad.status, 422);
  const kidInv = await f.mom.c.post('/api/invites', { role: 'child' });
  const kid = await signedUp(f.env, { name: 'Kid', inviteToken: kidInv.data.token });
  assert.equal((await kid.c.post('/api/groups', { name: 'Mine' })).status, 403);
});

test('an event limited to a group is only visible to that group (and its creator)', async () => {
  const f = await family();
  const ev = (await f.mom.c.post('/api/events', { title: 'Parent-teacher night', start: '2026-12-03T18:00', groupId: f.nuclear.id })).data.event;
  assert.equal(ev.groupId, f.nuclear.id);
  const dadSync = (await f.dad.c.get('/api/sync')).data;
  assert.ok(dadSync.events.find((e) => e.id === ev.id && !e.deleted));
  const gmaSync = (await f.grandma.c.get('/api/sync')).data;
  assert.ok(!gmaSync.events.find((e) => e.id === ev.id && !e.deleted));
  assert.equal((await f.grandma.c.get(`/api/events/${ev.id}`)).status, 404);
  assert.equal((await f.grandma.c.get('/api/events?from=2026-12-01&to=2026-12-31')).data.occurrences.length, 0);
  // the shared calendar feed leaves group events out
  const feed = await f.mom.c.get('/api/calendar-feed');
  const ics = await client(f.env).get(new URL(feed.data.url).pathname);
  assert.ok(!String(ics.data).includes('Parent-teacher'));
  // adding Grandma to the group makes it appear for her on the next sync
  const since = gmaSync.seq;
  await f.mom.c.patch(`/api/groups/${f.nuclear.id}`, { memberIds: [...f.nuclear.memberIds, f.p.gma.id], version: f.nuclear.version });
  const later = (await f.grandma.c.get(`/api/sync?since=${since}`)).data;
  assert.ok(later.events.find((e) => e.id === ev.id && !e.deleted));
  // deleting the group shares its events with the whole family
  assert.equal((await f.mom.c.del(`/api/groups/${f.nuclear.id}`)).status, 200);
  assert.equal((await f.grandma.c.get(`/api/events/${ev.id}`)).data.event.groupId, null);
});

test('family activity: added / changed / cancelled events alert everyone else who can see them', async () => {
  const f = await family();
  const ev = (await f.dad.c.post('/api/events', { title: 'Soccer', icon: '⚽', start: '2026-12-05T10:00', location: { name: 'Town Field', address: '1 Field Rd' } })).data.event;
  let momA = await activity(f.mom);
  assert.equal(momA.length, 1);
  assert.match(momA[0].title, /^Dad added “⚽ Soccer”$/);
  assert.match(momA[0].body, /Town Field/);
  assert.equal(momA[0].refId, ev.id);
  assert.equal((await activity(f.dad)).length, 0, 'the person who made the change is not alerted');
  assert.equal((await activity(f.grandma)).length, 1);

  // notes-only edits don't alert; moving the time does
  const v2 = (await f.dad.c.patch(`/api/events/${ev.id}`, { version: ev.version, notes: 'bring water' })).data.event;
  assert.equal((await activity(f.mom)).length, 1);
  const v3 = (await f.dad.c.patch(`/api/events/${ev.id}`, { version: v2.version, start: '2026-12-05T11:00' })).data.event;
  momA = await activity(f.mom);
  assert.equal(momA.length, 2);
  assert.match(momA[0].title, /changed/);

  // Grandma mutes family alerts
  assert.equal((await f.grandma.c.patch('/api/me/prefs', { notifyActivity: false })).status, 200);
  assert.equal((await f.grandma.c.get('/api/me')).data.notifyActivity, false);
  assert.equal((await f.dad.c.del(`/api/events/${ev.id}?version=${v3.version}`)).status, 200);
  momA = await activity(f.mom);
  assert.equal(momA.length, 3);
  assert.match(momA[0].title, /cancelled/);
  assert.equal((await activity(f.grandma)).length, 2, 'muted: no new alert');

  // private events never alert anyone
  await f.dad.c.post('/api/events', { title: 'Dentist', start: '2026-12-06T09:00', visibility: 'private' });
  assert.equal((await activity(f.mom)).length, 3);
});

test('family activity respects groups: only group members hear about group events', async () => {
  const f = await family();
  await f.mom.c.post('/api/events', { title: 'Date night', start: '2026-12-12T19:00', groupId: f.nuclear.id });
  assert.equal((await activity(f.dad)).length, 1);
  assert.equal((await activity(f.grandma)).length, 0);
  await f.mom.c.post('/api/events', { title: 'Thanksgiving', start: '2026-11-26', allDay: true, groupId: f.extended.id });
  assert.equal((await activity(f.grandma)).length, 1);
  assert.equal((await activity(f.dad)).length, 2);
});

test('assigning a task alerts the assignee', async () => {
  const f = await family();
  const lists = (await f.mom.c.get('/api/sync')).data.lists;
  const todo = lists.find((l) => l.kind === 'todo');
  const t = (await f.mom.c.post('/api/tasks', { listId: todo.id, title: 'Take out recycling', assignee: f.p.dad.id, due: '2026-12-01' })).data.task;
  const dadA = await activity(f.dad);
  assert.equal(dadA.length, 1);
  assert.match(dadA[0].title, /assigned you “Take out recycling”/);
  assert.equal(dadA[0].refType, 'task');
  assert.equal((await activity(f.grandma)).length, 0);
  // reassigning to Grandma alerts her
  await f.mom.c.patch(`/api/tasks/${t.id}`, { version: t.version, assignee: f.p.gma.id });
  assert.equal((await activity(f.grandma)).length, 1);
});

test('lists limited to a group hide their tasks from everyone else', async () => {
  const f = await family();
  const l = await f.mom.c.post('/api/lists', { name: 'Christmas gifts', kind: 'shopping', groupId: f.nuclear.id });
  assert.equal(l.status, 201, JSON.stringify(l.data));
  await f.mom.c.post('/api/tasks', { listId: l.data.list.id, title: 'Bike for Kiddo' });
  const gma = (await f.grandma.c.get('/api/sync')).data;
  assert.ok(!gma.lists.find((x) => x.id === l.data.list.id && !x.deleted));
  assert.ok(!gma.tasks.find((x) => x.title === 'Bike for Kiddo' && !x.deleted));
  assert.equal((await f.grandma.c.post('/api/tasks', { listId: l.data.list.id, title: 'peek' })).status, 422);
  const dad = (await f.dad.c.get('/api/sync')).data;
  assert.ok(dad.tasks.find((x) => x.title === 'Bike for Kiddo'));
  // you can't limit a list to a group you're not in
  assert.equal((await f.grandma.c.post('/api/lists', { name: 'x', groupId: f.nuclear.id })).status, 422);
});

test('reminders for group events go only to the group', async () => {
  const f = await family();
  const start = new Date(Date.now() + 45 * 60000);
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(start).replace(' ', 'T');
  await f.mom.c.post('/api/events', { title: 'School pickup', start: local, reminders: [30], groupId: f.nuclear.id });
  await deliverDueReminders(f.env, Date.now() + 20 * 60000);
  const dadR = (await inbox(f.dad)).filter((n) => n.kind === 'reminder');
  const gmaR = (await inbox(f.grandma)).filter((n) => n.kind === 'reminder');
  assert.equal(dadR.length, 1);
  assert.equal(gmaR.length, 0);
});

test('profile photos / emoji avatars and event icons', async () => {
  const f = await family();
  const m = f.p.k1;
  const r1 = await f.mom.c.patch(`/api/members/${m.id}`, { version: m.version, avatar: '🦖' });
  assert.equal(r1.data.member.avatar, '🦖');
  const photo = 'data:image/jpeg;base64,' + Buffer.from('fakejpegbytes').toString('base64');
  const r2 = await f.mom.c.patch(`/api/members/${m.id}`, { version: r1.data.member.version, avatar: photo });
  assert.equal(r2.data.member.avatar, photo);
  assert.equal((await f.mom.c.patch(`/api/members/${m.id}`, { version: r2.data.member.version, avatar: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 422);
  assert.equal((await f.mom.c.patch(`/api/members/${m.id}`, { version: r2.data.member.version, avatar: '<img onerror=x>' })).status, 422);
  const cleared = await f.mom.c.patch(`/api/members/${m.id}`, { version: r2.data.member.version, avatar: null });
  assert.equal(cleared.data.member.avatar, null);
  const ev = (await f.mom.c.post('/api/events', { title: 'Piano', icon: '🎹', start: '2026-12-02T16:00' })).data.event;
  assert.equal(ev.icon, '🎹');
  const ev2 = (await f.mom.c.patch(`/api/events/${ev.id}`, { version: ev.version, icon: null })).data.event;
  assert.equal(ev2.icon, null);
});

test('alerts use the suggested icon when none was picked, and none when turned off', async () => {
  const f = await family();
  await f.dad.c.post('/api/events', { title: 'Dentist for Kiddo', start: '2026-12-08T15:00' });
  await f.dad.c.post('/api/events', { title: 'Soccer', icon: '-', start: '2026-12-09T15:00' });
  const a = await activity(f.mom);
  assert.ok(a.some((n) => n.title === 'Dad added “🦷 Dentist for Kiddo”'), JSON.stringify(a.map((n) => n.title)));
  assert.ok(a.some((n) => n.title === 'Dad added “Soccer”'));
});

test('profiles: creator picks who they are; one login per profile; invites can pre-assign a profile', async () => {
  const env = makeEnv();
  const a = await signedUp(env, { name: 'Diego Duque' });
  assert.equal(a.me.memberId, null, 'the creator is not assumed to be Mom');
  const [mom, dad] = a.sync.members;
  assert.equal((await a.c.patch('/api/me/profile', { memberId: dad.id })).status, 200);
  assert.equal((await a.c.get('/api/me')).data.memberId, dad.id);
  // invitation for Mom's profile
  const inv = await a.c.post('/api/invites', { role: 'adult', memberId: mom.id });
  const h = await signedUp(env, { name: 'Hayley', inviteToken: inv.data.token });
  assert.equal(h.me.memberId, mom.id);
  // Hayley (not owner) can't take Dad's profile
  const taken = await h.c.patch('/api/me/profile', { memberId: dad.id });
  assert.equal(taken.status, 409);
  assert.match(taken.data.error.message, /already Diego/);
  // "I'm not listed": creates a profile with your name
  const k = await signedUp(env, { name: 'Leo', inviteToken: (await a.c.post('/api/invites', { role: 'adult' })).data.token });
  assert.equal(k.me.memberId, null);
  const made = await k.c.patch('/api/me/profile', { createNamed: 'Uncle Leo' });
  assert.equal(made.status, 200);
  const s = (await k.c.get('/api/sync')).data;
  assert.ok(s.members.find((m) => m.id === made.data.memberId && m.name === 'Uncle Leo'));
  // owner moving a profile to someone else unlinks the previous person
  const people = (await a.c.get('/api/household/people')).data.people;
  const hay = people.find((p) => p.name === 'Hayley');
  await a.c.patch(`/api/household/people/${hay.id}`, { memberId: dad.id });
  assert.equal((await a.c.get('/api/me')).data.memberId, null);
  assert.equal((await h.c.get('/api/me')).data.memberId, dad.id);
});
