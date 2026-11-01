import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, signedUp, client, fakeFetch } from './harness.js';
import { refreshDueSources } from '../src/routes/sources.js';
import { utcToLocal } from '../src/lib/time.js';

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function providerMocks(state) {
  const tokenCalls = [];
  const f = fakeFetch([
    // ---- Google ----
    [(u) => u === 'https://oauth2.googleapis.com/token', async (u, init) => {
      const p = new URLSearchParams(init.body);
      tokenCalls.push(Object.fromEntries(p));
      if (p.get('grant_type') === 'refresh_token' && state.googleRevoked) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'g-access', refresh_token: p.get('grant_type') === 'authorization_code' ? 'g-refresh-1' : undefined,
        id_token: `x.${Buffer.from(JSON.stringify({ email: 'ana@gmail.com' })).toString('base64url')}.y` });
    }],
    [(u) => u.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList'), async (u, init) => {
      assert.equal(init.headers.authorization, 'Bearer g-access');
      return Response.json({ items: [{ id: 'ana@gmail.com', summary: 'Ana', primary: true }, { id: 'kids@group.calendar.google.com', summary: 'Kids school' }] });
    }],
    [(u) => u.startsWith('https://www.googleapis.com/calendar/v3/calendars/'), async (u) => {
      const cal = decodeURIComponent(new URL(u).pathname.split('/')[4]);
      if (cal === 'ana@gmail.com') {
        return Response.json({ items: [
          { id: 'e1', status: 'confirmed', summary: state.googleTitle || 'Dentist', location: '5 Main St', start: { dateTime: `${day(2)}T20:00:00Z` }, end: { dateTime: `${day(2)}T21:00:00Z` } },
          { id: 'e2_20261105', status: 'confirmed', summary: 'Yoga', start: { dateTime: `${day(3)}T18:00:00Z` }, end: { dateTime: `${day(3)}T19:00:00Z` } },
          { id: 'e3', status: 'cancelled' },
          { id: 'e4', status: 'confirmed', summary: 'Long weekend', start: { date: day(5) }, end: { date: day(8) } },
        ] });
      }
      return Response.json({ items: [{ id: 'k1', status: 'confirmed', summary: 'Field trip', start: { date: day(4) }, end: { date: day(5) } }] });
    }],
    // ---- Microsoft ----
    [(u) => u === 'https://login.microsoftonline.com/common/oauth2/v2.0/token', async (u, init) => {
      const p = new URLSearchParams(init.body);
      tokenCalls.push(Object.fromEntries(p));
      const n = tokenCalls.filter((x) => x.client_id === 'ms-id').length;
      return Response.json({ access_token: 'm-access', refresh_token: `m-refresh-${n}` }); // Microsoft rotates refresh tokens
    }],
    [(u) => u.startsWith('https://graph.microsoft.com/v1.0/me?'), async () => Response.json({ mail: 'leo@contoso.com' })],
    [(u) => u.startsWith('https://graph.microsoft.com/v1.0/me/calendars?'), async () => Response.json({ value: [{ id: 'AAMk1', name: 'Calendar', isDefaultCalendar: true }] })],
    [(u) => u.includes('/calendarView?'), async (u, init) => {
      assert.equal(init.headers.prefer, 'outlook.timezone="UTC"');
      return Response.json({ value: [
        { id: 'm1', subject: 'Client lunch', isAllDay: false, isCancelled: false, location: { displayName: 'Cafe' }, start: { dateTime: `${day(1)}T16:00:00.0000000` }, end: { dateTime: `${day(1)}T17:00:00.0000000` } },
        { id: 'm2', subject: 'Cancelled sync', isCancelled: true, start: { dateTime: `${day(1)}T18:00:00.0000000` }, end: { dateTime: `${day(1)}T19:00:00.0000000` } },
      ] });
    }],
  ]);
  return { f, tokenCalls };
}

async function connect(env, c, provider, body = {}) {
  const start = await c.post(`/api/calendar-accounts/${provider}/start`, body);
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const auth = new URL(start.data.url);
  const state = auth.searchParams.get('state');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), `https://ff.test/oauth/${provider}/callback`);
  const cb = await c.get(`/oauth/${provider}/callback?code=abc&state=${state}`);
  return { cb, auth, state };
}

test('Sign in with Google: imports the main calendar, read-only, tokens stored encrypted; pick more calendars', async () => {
  const st = {};
  const env = makeEnv({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' });
  const { f, tokenCalls } = providerMocks(st);
  env.__fetch = f;
  const { c, sync } = await signedUp(env);
  assert.equal((await c.get('/api/me')).data.features.googleCalendar, true);
  assert.equal((await c.get('/api/me')).data.features.microsoftCalendar, false);
  const mom = sync.members.find((m) => m.name === 'Mom');
  const { cb, auth } = await connect(env, c, 'google', { memberId: mom.id });
  assert.match(auth.searchParams.get('scope'), /calendar\.readonly/);
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get('location'), /#\/more\/sync\?connected=cs_[^&]+&count=3$/);
  assert.equal(tokenCalls[0].code_verifier.length > 40, true);

  const src = (await c.get('/api/calendar-sources')).data.sources[0];
  assert.equal(src.kind, 'google');
  assert.equal(src.accountEmail, 'ana@gmail.com');
  assert.deepEqual(src.calendars.map((x) => x.name), ['Ana']);
  const row = await env.DB.prepare('SELECT token_enc FROM calendar_sources').first();
  assert.ok(!row.token_enc.includes('g-refresh-1'), 'refresh token is not stored in plain text');

  const occ = (await c.get(`/api/events?from=${day(0)}&to=${day(10)}`)).data.occurrences;
  const dentist = occ.find((o) => o.title === 'Dentist');
  assert.equal(dentist.start, utcToLocal(Date.parse(`${day(2)}T20:00:00Z`), 'America/New_York'));
  assert.deepEqual(dentist.assignees, [mom.id]);
  assert.equal(dentist.readOnly, true);
  const yoga = occ.find((o) => o.title === 'Yoga');
  assert.equal(yoga.start, utcToLocal(Date.parse(`${day(3)}T18:00:00Z`), 'America/New_York'));
  assert.ok(occ.some((o) => o.title === 'Long weekend' && o.allDay));

  // list + choose calendars
  const cals = (await c.get(`/api/calendar-sources/${src.id}/calendars`)).data.calendars;
  assert.deepEqual(cals.map((x) => [x.name, x.selected]), [['Ana', true], ['Kids school', false]]);
  const r = await c.post(`/api/calendar-sources/${src.id}/calendars`, { calendars: cals.map(({ id, name }) => ({ id, name })) });
  assert.equal(r.data.ok, true);
  assert.ok((await c.get(`/api/events?from=${day(0)}&to=${day(10)}`)).data.occurrences.some((o) => o.title === 'Field trip'));

  // scheduled refresh uses the stored refresh token and picks up changes
  st.googleTitle = 'Dentist (moved)';
  const res = await refreshDueSources(env, Date.now() + 16 * 60000);
  assert.equal(res.failed, 0);
  assert.ok(tokenCalls.some((t) => t.grant_type === 'refresh_token' && t.refresh_token === 'g-refresh-1'));
  assert.ok((await c.get(`/api/events?from=${day(0)}&to=${day(10)}`)).data.occurrences.some((o) => o.title === 'Dentist (moved)'));

  // access revoked at Google: clear message, Reconnect, events kept
  st.googleRevoked = true;
  const bad = (await c.post(`/api/calendar-sources/${src.id}/sync`, {})).data;
  assert.equal(bad.sync.ok, false);
  assert.match(bad.source.error, /Reconnect/);
  assert.ok((await c.get(`/api/events?from=${day(0)}&to=${day(10)}`)).data.occurrences.some((o) => o.title === 'Dentist (moved)'));
  // reconnecting the same account updates it instead of adding a duplicate
  st.googleRevoked = false;
  await connect(env, c, 'google');
  assert.equal((await c.get('/api/calendar-sources')).data.sources.length, 1);
});

test('Sign in with Microsoft: Outlook events in UTC, cancelled skipped, rotating refresh token saved', async () => {
  const env = makeEnv({ MS_CLIENT_ID: 'ms-id', MS_CLIENT_SECRET: 'ms-secret' });
  const { f } = providerMocks({});
  env.__fetch = f;
  const { c } = await signedUp(env);
  const { cb, auth } = await connect(env, c, 'microsoft');
  assert.match(auth.searchParams.get('scope'), /offline_access/);
  assert.match(cb.headers.get('location'), /connected=.*count=1$/);
  const occ = (await c.get(`/api/events?from=${day(0)}&to=${day(5)}`)).data.occurrences;
  assert.deepEqual(occ.map((o) => o.title), ['Client lunch']);
  assert.equal(occ[0].start, utcToLocal(Date.parse(`${day(1)}T16:00:00Z`), 'America/New_York'));
  const before = (await env.DB.prepare('SELECT token_enc FROM calendar_sources').first()).token_enc;
  await refreshDueSources(env, Date.now() + 16 * 60000);
  const after = (await env.DB.prepare('SELECT token_enc FROM calendar_sources').first()).token_enc;
  assert.notEqual(before, after, 'rotated refresh token stored');
});

test('OAuth safety: state must match the signed-in user, expire, and be single-use; not configured is explained', async () => {
  const env = makeEnv({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' });
  env.__fetch = providerMocks({}).f;
  const a = await signedUp(env);
  const b = await signedUp(env, { household: 'Other' });
  const start = await a.c.post('/api/calendar-accounts/google/start', {});
  const state = new URL(start.data.url).searchParams.get('state');
  // another user (or a logged-out browser) can't finish someone else's sign-in
  assert.match((await b.c.get(`/oauth/google/callback?code=x&state=${state}`)).headers.get('location'), /error=(session|expired)/);
  assert.match((await client(env).get(`/oauth/google/callback?code=x&state=${state}`)).headers.get('location'), /error=expired/);
  assert.match((await a.c.get(`/oauth/google/callback?code=x&state=bogus`)).headers.get('location'), /error=expired/);
  assert.match((await a.c.get('/oauth/google/callback?error=access_denied')).headers.get('location'), /error=denied/);
  assert.equal((await a.c.get('/api/calendar-sources')).data.sources.length, 0);
  const ms = await a.c.post('/api/calendar-accounts/microsoft/start', {});
  assert.equal(ms.status, 503);
  assert.match(ms.data.error.message, /calendar link/);
});
