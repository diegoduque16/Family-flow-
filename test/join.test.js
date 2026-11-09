import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, signedUp, client } from './harness.js';

test('family is notified when someone joins the family or a group', async () => {
  const env = makeEnv();
  const owner = await signedUp(env, { demo: false });
  const inv = await owner.c.post('/api/invites', { role: 'adult' });
  const hayley = client(env);
  await hayley.post('/api/auth/signup', { name: 'Hayley Duque', email: 'hayley@example.com', password: 'password 123', inviteToken: inv.data.url.split('/join/')[1] });
  let n = (await owner.c.get('/api/notifications')).data.notifications;
  assert.ok(n.some((x) => x.title === 'Hayley Duque joined Duque Family'), JSON.stringify(n.map((x) => x.title)));

  const g = (await owner.c.post('/api/groups', { name: 'Nuclear family', memberIds: [] })).data.group;
  const link = await owner.c.post('/api/invites', { groupId: g.id });
  assert.equal(link.status, 201);
  assert.equal((await hayley.post(`/api/invites/${link.data.url.split('/join/')[1]}/accept`)).status, 200);
  n = (await owner.c.get('/api/notifications')).data.notifications;
  assert.ok(n.some((x) => x.title === 'Hayley Duque joined “Nuclear family”'), JSON.stringify(n.map((x) => x.title)));
  // Joining again via the same link doesn't notify twice
  await hayley.post(`/api/invites/${link.data.url.split('/join/')[1]}/accept`);
  n = (await owner.c.get('/api/notifications')).data.notifications;
  assert.equal(n.filter((x) => x.title.includes('Nuclear family')).length, 1);
  // The joiner doesn't get their own alert
  const hn = (await hayley.get('/api/notifications')).data.notifications;
  assert.ok(!hn.some((x) => x.title.includes('joined')));
});
