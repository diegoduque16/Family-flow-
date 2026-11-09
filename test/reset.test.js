import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, signedUp, client } from './harness.js';

test('password reset link: owner creates, person sets a new password, link works once', async () => {
  const env = makeEnv();
  const owner = await signedUp(env, { demo: false });
  const inv = await owner.c.post('/api/invites', { role: 'adult' });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  const token = inv.data.url.split('/join/')[1];
  const hayley = client(env);
  const su = await hayley.post('/api/auth/signup', { name: 'Hayley', email: 'hayley@example.com', password: 'old password 1', inviteToken: token });
  assert.equal(su.status, 201, JSON.stringify(su.data));
  const people = (await owner.c.get('/api/household/people')).data.people;
  const h = people.find((p) => p.email === 'hayley@example.com');

  // Hayley (adult) can't reset the owner; owner can't use it on themself
  assert.equal((await hayley.post(`/api/household/people/${owner.me.user.id}/reset-link`)).status, 403);
  assert.equal((await owner.c.post(`/api/household/people/${owner.me.user.id}/reset-link`)).status, 422);

  const r = await owner.c.post(`/api/household/people/${h.id}/reset-link`);
  assert.equal(r.status, 201);
  const rt = r.data.url.split('/reset/')[1];
  const stranger = client(env);
  const info = await stranger.get(`/api/password-reset/${rt}`);
  assert.equal(info.data.email, 'hayley@example.com');
  assert.equal((await stranger.post(`/api/password-reset/${rt}`, { password: 'short' })).status, 422);
  const ok = await stranger.post(`/api/password-reset/${rt}`, { password: 'brand new password' });
  assert.equal(ok.status, 200);
  assert.equal((await stranger.get('/api/me')).data.user.email, 'hayley@example.com'); // signed in
  assert.equal((await hayley.get('/api/me')).status, 401); // old sessions signed out
  assert.equal((await stranger.post(`/api/password-reset/${rt}`, { password: 'another password' })).status, 410); // one use
  const fresh = client(env);
  assert.equal((await fresh.post('/api/auth/login', { email: 'hayley@example.com', password: 'brand new password' })).status, 200);
  assert.equal((await client(env).post('/api/auth/login', { email: 'hayley@example.com', password: 'old password 1' })).status, 401);
});
