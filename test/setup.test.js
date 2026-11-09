import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, signedUp } from './harness.js';

test('setup wizard: new members are asked once; finishing or skipping is remembered', async () => {
  const env = makeEnv();
  const { c } = await signedUp(env, { demo: false });
  assert.equal((await c.get('/api/me')).data.setupNeeded, true);
  assert.equal((await c.patch('/api/me/prefs', { setupDone: true })).status, 200);
  const me = (await c.get('/api/me')).data;
  assert.equal(me.setupNeeded, false);
  assert.equal(me.notifyActivity, true); // other prefs untouched
  assert.equal((await c.patch('/api/me/prefs', { notifyActivity: false })).status, 200);
  assert.equal((await c.get('/api/me')).data.notifyActivity, false);
});
