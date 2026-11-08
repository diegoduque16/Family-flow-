import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, signedUp, fakeFetch } from './harness.js';

const pdf = new TextEncoder().encode('%PDF-1.4\n' + 'x'.repeat(200));

test('PDF import: Claude reads the file, entries come back for review, then bulk-add saves them', async () => {
  const env = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
  const sent = [];
  env.__fetch = fakeFetch([[(u) => u === 'https://api.anthropic.com/v1/messages', async (u, init) => {
    const b = JSON.parse(init.body);
    sent.push(b);
    return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'extract_events', input: {
      summary: 'Lincoln Elementary 2026–27 calendar',
      events: [
        { title: 'No school – Teacher workday', date: '2026-11-03' },
        { title: 'Winter break', date: '2026-12-21', end_date: '2027-01-01' },
        { title: 'Early dismissal', date: '2026-11-25', start_time: '12:30', notes: 'Pick up at 12:30' },
        { title: 'Soccer vs. Essex', date: '2026-11-14', start_time: '10:00', end_time: '11:30', location: 'Town Field', who: ['Kiddo 1'] },
        { title: 'Soccer vs. Essex', date: '2026-11-14', start_time: '10:00' },
        { title: 'Bad date', date: 'sometime' },
      ] } }] });
  }]]);
  const { c, sync } = await signedUp(env);
  const k1 = sync.members.find((m) => m.name === 'Kiddo 1');
  await c.post('/api/events', { title: 'No school – Teacher workday', start: '2026-11-03', allDay: true });
  const r = await c.call('POST', '/api/import/document', pdf, { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('School calendar.pdf') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(sent[0].messages[0].content[0].type, 'document');
  assert.equal(sent[0].messages[0].content[0].source.media_type, 'application/pdf');
  assert.equal(sent[0].tool_choice.name, 'extract_events');
  const ev = r.data.events;
  assert.equal(ev.length, 4, 'bad date dropped, duplicate removed');
  const wb = ev.find((e) => e.title === 'Winter break');
  assert.deepEqual([wb.start, wb.end, wb.allDay], ['2026-12-21', '2027-01-02', true]);
  const soc = ev.find((e) => e.title.startsWith('Soccer'));
  assert.deepEqual([soc.start, soc.end, soc.allDay, soc.assignees], ['2026-11-14T10:00', '2026-11-14T11:30', false, [k1.id]]);
  assert.equal(ev.find((e) => e.title.startsWith('No school')).exists, true, 'already on the calendar');
  // nothing saved yet
  assert.equal((await c.get('/api/events?from=2026-11-10&to=2027-01-10')).data.occurrences.length, 0);
  // bulk add (the person unticked the duplicate)
  const toAdd = ev.filter((e) => !e.exists).map(({ exists, ...e }) => e);
  const b = await c.post('/api/events/bulk', { events: toAdd, source: 'School calendar.pdf' });
  assert.equal(b.status, 201, JSON.stringify(b.data));
  assert.equal(b.data.created.length, 3);
  assert.equal(b.data.failed.length, 0);
  const occ = (await c.get('/api/events?from=2026-11-10&to=2027-01-10')).data.occurrences;
  assert.equal(occ.filter((o) => o.title === 'Winter break').length, 1);
  // wrong file type
  assert.equal((await c.call('POST', '/api/import/document', pdf, { 'content-type': 'text/plain' })).status, 415);
});

test('bulk add: one family alert instead of one per event; bad rows are reported, not fatal', async () => {
  const env = makeEnv();
  const a = await signedUp(env, { name: 'Diego Duque', label: 'Dad', demo: false });
  const inv = await a.c.post('/api/invites', { role: 'adult' });
  const h = await signedUp(env, { name: 'Hayley', label: 'Mom', inviteToken: inv.data.token });
  const r = await a.c.post('/api/events/bulk', { source: 'Soccer schedule.pdf', events: [
    { title: 'Game 1', start: '2026-11-14T10:00' }, { title: 'Game 2', start: '2026-11-21T10:00' }, { title: '', start: 'nope' }] });
  assert.equal(r.data.created.length, 2);
  assert.equal(r.data.failed.length, 1);
  const alerts = (await h.c.get('/api/notifications')).data.notifications.filter((n) => n.kind === 'activity');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Dad added 2 events from “Soccer schedule.pdf”');
});
