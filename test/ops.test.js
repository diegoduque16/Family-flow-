import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, client, signedUp, fakeFetch } from './harness.js';
import { deliverDueReminders, runBackup, housekeeping } from '../src/routes/ops.js';
import { utcToLocal } from '../src/lib/time.js';
import { b64url, b64urlDecode } from '../src/lib/util.js';

const enc = new TextEncoder();
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// A fake browser push subscription that can decrypt what the server sends (RFC 8291), proving the payload is real.
async function fakeBrowser() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  async function decrypt(body) {
    const b = new Uint8Array(body);
    const salt = b.slice(0, 16);
    const idlen = b[20];
    const asPub = b.slice(21, 21 + idlen);
    const cipher = b.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, kp.privateKey, 256));
    const prkKey = await hmac(auth, ecdh);
    const ikm = (await hmac(prkKey, cat(enc.encode('WebPush: info\0'), pub, asPub, new Uint8Array([1])))).slice(0, 32);
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
    const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, cipher));
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    assert.equal(plain[end], 2, 'last-record padding delimiter');
    return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
  }
  return { keys: { p256dh: b64url(pub), auth: b64url(auth) }, decrypt };
}

async function verifyVapid(authHeader, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader);
  assert.ok(m, 'vapid header');
  const [h, c, s] = m[1].split('.');
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
  assert.equal(claims.aud, new URL(endpoint).origin);
  const key = await crypto.subtle.importKey('raw', b64urlDecode(m[2]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(s), enc.encode(`${h}.${c}`));
  assert.ok(ok, 'VAPID signature verifies with the advertised public key');
}

test('event reminder is delivered once: inbox entry + encrypted, signed Web Push that decrypts', async () => {
  const pushes = [];
  const env = makeEnv();
  env.__fetch = fakeFetch([[(u) => u.startsWith('https://push.example.com/'), async (u, init) => { pushes.push({ u, init }); return new Response('', { status: 201 }); }]]);
  const { c } = await signedUp(env);
  const browser = await fakeBrowser();
  assert.equal((await c.post('/api/push/subscribe', { endpoint: 'https://push.example.com/abc123', keys: browser.keys })).status, 200);

  const startMs = Date.now() + 3 * 3600000;
  const start = utcToLocal(startMs, 'America/New_York');
  const ev = (await c.post('/api/events', { title: 'Dentist', start, reminders: [60], location: { name: 'Smile Dental', address: '2 Main St' } })).data.event;
  const fireAt = new Date(ev.startUtc).getTime() - 3600000;

  // too early: nothing
  assert.equal((await deliverDueReminders(env, fireAt - 60000)).sent, 0);
  const r = await deliverDueReminders(env, fireAt + 1000);
  assert.deepEqual({ sent: r.sent, pushed: r.pushed, failed: r.failed }, { sent: 1, pushed: 1, failed: 0 });
  // a second, overlapping run must not double-send
  assert.equal((await deliverDueReminders(env, fireAt + 2000)).sent, 0);
  assert.equal(pushes.length, 1);

  const msg = await browser.decrypt(await new Response(pushes[0].init.body).arrayBuffer());
  assert.equal(msg.title, 'Dentist');
  assert.match(msg.body, /Smile Dental/);
  assert.equal(pushes[0].init.headers['Content-Encoding'], 'aes128gcm');
  await verifyVapid(pushes[0].init.headers.Authorization, pushes[0].u);

  const inbox = (await c.get('/api/notifications')).data.notifications;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].title, 'Dentist');
  assert.equal(inbox[0].read, false);
  await c.post('/api/notifications/read', { all: true });
  assert.equal((await c.get('/api/notifications')).data.notifications[0].read, true);
});

test('moving an event reschedules its reminder; deleting cancels it; dead subscriptions are removed', async () => {
  const env = makeEnv();
  env.__fetch = fakeFetch([[() => true, async () => new Response('gone', { status: 410 })]]);
  const { c } = await signedUp(env);
  const browser = await fakeBrowser();
  await c.post('/api/push/subscribe', { endpoint: 'https://push.example.com/dead', keys: browser.keys });
  const start = utcToLocal(Date.now() + 5 * 3600000, 'America/New_York');
  let ev = (await c.post('/api/events', { title: 'Call', start, reminders: [10] })).data.event;
  const later = utcToLocal(Date.now() + 8 * 3600000, 'America/New_York');
  ev = (await c.patch(`/api/events/${ev.id}`, { version: ev.version, start: later })).data.event;
  const oldFire = Date.now() + 5 * 3600000 - 600000;
  assert.equal((await deliverDueReminders(env, oldFire + 60000)).sent, 0, 'old time no longer fires');
  const newFire = new Date(ev.startUtc).getTime() - 600000;
  const r = await deliverDueReminders(env, newFire + 1000);
  assert.equal(r.sent, 1);
  assert.equal(r.pushed, 0);
  const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first();
  assert.equal(subs.n, 0, '410 Gone removes the subscription');

  const ev2 = (await c.post('/api/events', { title: 'Cancelled', start, reminders: [10] })).data.event;
  await c.del(`/api/events/${ev2.id}?version=${ev2.version}`);
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduled_notifications WHERE ref_id = ? AND status = 'pending'").bind(ev2.id).first();
  assert.equal(pending.n, 0);
});

test('private event reminders go only to their owner', async () => {
  const env = makeEnv();
  const a = await signedUp(env);
  const inv = await a.c.post('/api/invites', { role: 'adult' });
  const b = await signedUp(env, { name: 'Partner', inviteToken: inv.data.token });
  const start = utcToLocal(Date.now() + 2 * 3600000, 'America/New_York');
  const ev = (await a.c.post('/api/events', { title: 'Gift shopping', start, visibility: 'private', reminders: [30] })).data.event;
  await deliverDueReminders(env, new Date(ev.startUtc).getTime() - 30 * 60000 + 1000);
  assert.equal((await a.c.get('/api/notifications')).data.notifications.length, 1);
  assert.equal((await b.c.get('/api/notifications')).data.notifications.length, 0);
});

test('places: saved first, Geoapify primary, Photon fallback, honest degraded flag', async () => {
  const geo = { results: [{ formatted: '200 Main St, Old Saybrook, CT 06475, United States of America', address_line1: '200 Main St', lat: 41.29, lon: -72.38, result_type: 'building' }] };
  const pho = { features: [{ properties: { countrycode: 'US', housenumber: '5', street: 'Pool St', city: 'Essex', state: 'CT', postcode: '06426' }, geometry: { coordinates: [-72.39, 41.35] } }] };
  let geoUp = true;
  let phoUp = true;
  const env = makeEnv({ GEOAPIFY_API_KEY: 'test-key' });
  env.__fetch = fakeFetch([
    [(u) => u.startsWith('https://api.geoapify.com/'), async () => (geoUp ? Response.json(geo) : new Response('err', { status: 500 }))],
    [(u) => u.startsWith('https://photon.komoot.io/'), async () => (phoUp ? Response.json(pho) : new Response('err', { status: 503 }))],
  ]);
  const { c } = await signedUp(env);
  await c.post('/api/events', { title: 'Lunch', start: '2026-11-12T12:00', location: { name: 'Main Diner', address: '10 Main St, Essex, CT' } });

  let r = (await c.get('/api/places?q=Main')).data;
  assert.equal(r.provider, 'geoapify');
  assert.equal(r.results[0].source, 'saved');
  assert.equal(r.results[0].name, 'Main Diner');
  assert.equal(r.results[1].address, '200 Main St, Old Saybrook, CT 06475, United States of America');
  assert.ok(env.__fetch.calls.some((x) => x.url.includes('apiKey=test-key')));

  geoUp = false;
  r = (await c.get('/api/places?q=Pool')).data;
  assert.equal(r.provider, 'photon');
  assert.equal(r.results[0].address, '5 Pool St, Essex, CT 06426');
  assert.equal(r.degraded, false);

  phoUp = false;
  r = (await c.get('/api/places?q=Nowhere')).data;
  assert.equal(r.provider, null);
  assert.equal(r.degraded, true);
  assert.equal((await c.get('/api/places?q=M')).data.results.length, 0, 'needs 2+ characters');

  const fav = await c.post('/api/places/saved', { name: 'School', address: '1 School Ln, Essex, CT', favorite: true });
  assert.equal(fav.status, 200, JSON.stringify(fav.data));
  assert.equal((await c.get('/api/places/saved')).data.places[0].name, 'School');
});

test('assistant: Claude tool calls become proposals; nothing is saved until confirmed', async () => {
  const env = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
  const bodies = [];
  const turns = [
    { stop_reason: 'tool_use', content: [{ type: 'text', text: '' }, { type: 'tool_use', id: 'tu1', name: 'propose_event', input: { title: 'Soccer practice', start: '2026-11-10T16:00', end: '2026-11-10T17:00', assignees: ['Kiddo 1'], reminders_minutes: [30], recurrence: { freq: 'WEEKLY', weekdays: ['TU'] }, assumptions: ['Assumed 1 hour'] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I’ve prepared weekly soccer practice for Kiddo 1 on Tuesdays at 4pm. Tap Confirm to save.' }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'propose_event', input: { title: 'Dinner', start: '2026-11-11T19:00', assignees: ['Uncle Bob'] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Who is Uncle Bob? I don’t see him in your family.' }] },
  ];
  env.__fetch = fakeFetch([[(u) => u === 'https://api.anthropic.com/v1/messages', async (u, init) => {
    bodies.push(JSON.parse(init.body));
    assert.equal(init.headers['x-api-key'], 'sk-test');
    return Response.json(turns.shift());
  }]]);
  const { c } = await signedUp(env);
  const r = await c.post('/api/assistant', { text: 'Kiddo 1 has soccer every Tuesday at 4' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.proposals.length, 1);
  const p = r.data.proposals[0];
  assert.equal(p.payload.rrule, 'FREQ=WEEKLY;BYDAY=TU');
  assert.deepEqual(p.notes, ['Assumed 1 hour']);
  assert.match(bodies[0].system, /Kiddo 1/);
  assert.equal(bodies[0].tools.length, 3);
  // second request carries the tool result back
  assert.equal(bodies[1].messages.at(-1).content[0].type, 'tool_result');

  // not saved yet
  assert.equal((await c.get('/api/events?from=2026-11-01&to=2026-12-01')).data.occurrences.length, 0);
  assert.equal((await c.get('/api/proposals')).data.proposals.length, 1);
  // confirm with an edit (user changed the time)
  const acc = await c.post(`/api/proposals/${p.id}/accept`, { payload: { ...p.payload, start: '2026-11-10T16:30', end: '2026-11-10T17:30' } });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  const occ = (await c.get('/api/events?from=2026-11-01&to=2026-12-01')).data.occurrences;
  assert.deepEqual(occ.map((o) => o.occurrence.start_local), ['2026-11-10T16:30', '2026-11-17T16:30', '2026-11-24T16:30']);
  assert.equal((await c.post(`/api/proposals/${p.id}/accept`, {})).status, 409, 'cannot save twice');

  // unknown person -> tool error fed back, Claude asks, no proposal
  const r2 = await c.post('/api/assistant', { text: 'dinner with uncle bob wed 7pm', conversationId: r.data.conversationId });
  assert.equal(r2.data.proposals.length, 0);
  assert.match(r2.data.reply, /Uncle Bob/);
  const toolResult = bodies.at(-1).messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  // history alternates roles correctly (API requirement)
  const roles = bodies.at(-1).messages.map((m) => m.role);
  for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1]);
});

test('assistant without a key says so plainly; Claude outage gives a clear error', async () => {
  const env = makeEnv();
  const { c } = await signedUp(env);
  const r = await c.post('/api/assistant', { text: 'hi' });
  assert.equal(r.status, 503);
  assert.equal(r.data.error.code, 'ai_not_configured');
  env.ANTHROPIC_API_KEY = 'sk-test';
  env.__fetch = fakeFetch([[() => true, async () => new Response('overloaded', { status: 529 })]]);
  const r2 = await c.post('/api/assistant', { text: 'hi' });
  assert.equal(r2.status, 502);
  assert.equal(r2.data.error.code, 'ai_unavailable');
});

test('voice transcription uses Workers AI and reports failure honestly', async () => {
  const env = makeEnv({ AI: { run: async (model, input) => { assert.equal(model, '@cf/openai/whisper-large-v3-turbo'); assert.ok(input.audio.length > 0); return { text: ' Pick up milk tomorrow ' }; } } });
  const { c } = await signedUp(env);
  const r = await c.call('POST', '/api/transcribe', new Uint8Array([1, 2, 3, 4]));
  assert.equal(r.status, 200);
  assert.equal(r.data.text, 'Pick up milk tomorrow');
  env.AI = { run: async () => { throw new Error('boom'); } };
  assert.equal((await c.call('POST', '/api/transcribe', new Uint8Array([1]))).status, 502);
  delete env.AI;
  assert.equal((await c.call('POST', '/api/transcribe', new Uint8Array([1]))).status, 503);
});

test('backup writes a verified gzip to R2 that restores the data; diagnostics reflect reality', async () => {
  const env = makeEnv({ ADMIN_EMAILS: 'boss@example.com' });
  const { c } = await signedUp(env, { email: 'boss@example.com' });
  await c.post('/api/events', { title: 'Backed up', start: '2026-11-10T10:00' });

  let d = (await c.get('/api/diagnostics?live=0')).data;
  const by = (n) => d.checks.find((x) => x.name === n);
  assert.equal(by('Database write/read').status, 'ok');
  assert.equal(by('Reminder scheduler (cron)').status, 'warn');
  assert.equal(by('Backups').status, 'warn');
  assert.equal(d.overall, 'warn');

  const b = await c.post('/api/diagnostics/backup', {});
  assert.equal(b.status, 200);
  assert.equal(b.data.ok, true);
  const obj = await env.BACKUPS.get(b.data.key);
  const text = await new Response(new Blob([await obj.arrayBuffer()]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const dump = JSON.parse(text);
  assert.equal(dump.tables.events[0].title, 'Backed up');
  assert.ok(!('password_hash' in dump.tables.users[0]) || dump.tables.users[0].password_hash.startsWith('pbkdf2'), 'hashes only');

  await deliverDueReminders(env);
  await housekeeping(env);
  d = (await c.get('/api/diagnostics?live=0')).data;
  assert.equal(by('Reminder scheduler (cron)').status, 'ok');
  assert.equal(by('Backups').status, 'ok');

  // live checks with no keys: assistant must fail, not show green
  env.__fetch = fakeFetch([[(u) => u.startsWith('https://photon'), async () => Response.json({ features: [] })]]);
  d = (await c.get('/api/diagnostics')).data;
  assert.equal(by('AI assistant (Claude)').status, 'fail');
  assert.equal(by('Address search: fallback (Photon)').status, 'fail');
  assert.equal(d.overall, 'fail');

  // non-admin adult cannot see diagnostics or run backups
  const inv = await c.post('/api/invites', { role: 'adult' });
  const p = await signedUp(env, { name: 'P', inviteToken: inv.data.token });
  assert.equal((await p.c.get('/api/diagnostics?live=0')).status, 403);
  assert.equal((await p.c.post('/api/diagnostics/backup', {})).status, 403);
});

test('backup retention keeps 35 days', async () => {
  const env = makeEnv();
  await env.BACKUPS.put('backups/2020-01-01.json.gz', new ArrayBuffer(3));
  const r = await runBackup(env);
  assert.equal(r.ok, true);
  assert.equal(await env.BACKUPS.head('backups/2020-01-01.json.gz'), null);
});

test('Geoapify key is accepted bare or as a pasted example URL', async () => {
  const { geoapifyKey } = await import('../src/routes/places.js');
  assert.equal(geoapifyKey('abc123'), 'abc123');
  assert.equal(geoapifyKey('https://api.geoapify.com/v1/geocode/search?text=x&apiKey=abc123def'), 'abc123def');
});
