// Family Flow Worker entry: API router, ICS feed, static app (via Assets), cron jobs.
import { HttpError, json, errorResponse } from './lib/util.js';
import { loadContext, checkCsrf } from './lib/auth.js';
import * as account from './routes/account.js';
import * as cal from './routes/calendar.js';
import * as places from './routes/places.js';
import * as ai from './routes/assistant.js';
import * as ops from './routes/ops.js';
import * as sources from './routes/sources.js';
import * as accounts from './routes/accounts.js';

// [method, path pattern, handler, access]  access: 'public' | 'session' (logged in) | 'household' (logged in + household)
const ROUTES = [
  ['POST', '/api/auth/signup', account.signup, 'public'],
  ['POST', '/api/auth/login', account.login, 'public'],
  ['POST', '/api/auth/logout', account.logout, 'optional'],
  ['GET', '/api/me', account.me, 'session'],
  ['POST', '/api/me/password', account.changePassword, 'session'],
  ['DELETE', '/api/me', account.deleteAccount, 'session'],
  ['POST', '/api/households', account.newHousehold, 'session'],
  ['POST', '/api/households/switch', account.switchHousehold, 'session'],
  ['PATCH', '/api/household', account.updateHousehold, 'household'],
  ['DELETE', '/api/household', account.deleteHousehold, 'household'],
  ['GET', '/api/household/export', account.exportHousehold, 'household'],
  ['GET', '/api/household/people', account.listPeople, 'household'],
  ['PATCH', '/api/household/people/:userId', account.updatePerson, 'household'],
  ['DELETE', '/api/household/people/:userId', account.removePerson, 'household'],
  ['POST', '/api/members', account.createMember, 'household'],
  ['PATCH', '/api/members/:id', account.updateMember, 'household'],
  ['DELETE', '/api/members/:id', account.deleteMember, 'household'],
  ['POST', '/api/invites', account.createInvite, 'household'],
  ['GET', '/api/invites/:token', account.inviteInfo, 'public'],
  ['POST', '/api/invites/:token/accept', account.joinWithInvite, 'session'],

  ['GET', '/api/sync', cal.sync, 'household'],
  ['GET', '/api/events', cal.listEvents, 'household'],
  ['POST', '/api/events', cal.createEvent, 'household'],
  ['POST', '/api/events/conflicts', cal.checkConflicts, 'household'],
  ['GET', '/api/events/:id', cal.getEvent, 'household'],
  ['PATCH', '/api/events/:id', cal.updateEvent, 'household'],
  ['DELETE', '/api/events/:id', cal.deleteEvent, 'household'],
  ['POST', '/api/lists', cal.createList, 'household'],
  ['PATCH', '/api/lists/:id', cal.updateList, 'household'],
  ['DELETE', '/api/lists/:id', cal.deleteList, 'household'],
  ['POST', '/api/tasks', cal.createTask, 'household'],
  ['PATCH', '/api/tasks/:id', cal.updateTask, 'household'],
  ['DELETE', '/api/tasks/:id', cal.deleteTask, 'household'],
  ['GET', '/api/calendar-feed', cal.icsInfo, 'household'],
  ['POST', '/api/calendar-feed/rotate', cal.rotateIcs, 'household'],

  ['GET', '/api/calendar-sources', sources.listSources, 'household'],
  ['POST', '/api/calendar-sources', sources.addSource, 'household'],
  ['PATCH', '/api/calendar-sources/:id', sources.updateSource, 'household'],
  ['DELETE', '/api/calendar-sources/:id', sources.removeSource, 'household'],
  ['POST', '/api/calendar-sources/:id/sync', sources.syncSourceNow, 'household'],
  ['GET', '/api/calendar-sources/:id/calendars', accounts.accountCalendars, 'household'],
  ['POST', '/api/calendar-sources/:id/calendars', accounts.setAccountCalendars, 'household'],
  ['POST', '/api/calendar-accounts/:provider/start', accounts.startConnect, 'household'],
  ['GET', '/oauth/:provider/callback', accounts.oauthCallback, 'optional'],

  ['GET', '/api/places', places.placesSearch, 'household'],
  ['GET', '/api/places/saved', places.savedPlaces, 'household'],
  ['POST', '/api/places/saved', places.savePlace, 'household'],
  ['DELETE', '/api/places/saved/:id', places.deletePlace, 'household'],

  ['POST', '/api/assistant', ai.chat, 'household'],
  ['GET', '/api/proposals', ai.listProposals, 'household'],
  ['POST', '/api/proposals/:id/accept', ai.acceptProposal, 'household'],
  ['POST', '/api/proposals/:id/dismiss', ai.dismissProposal, 'household'],
  ['POST', '/api/transcribe', ai.transcribe, 'household'],

  ['GET', '/api/notifications', ops.listNotifications, 'household'],
  ['POST', '/api/notifications/read', ops.markRead, 'household'],
  ['GET', '/api/push/key', ops.pushKey, 'session'],
  ['POST', '/api/push/subscribe', ops.subscribe, 'session'],
  ['POST', '/api/push/unsubscribe', ops.unsubscribe, 'session'],
  ['POST', '/api/push/test', ops.testPush, 'session'],
  ['GET', '/api/diagnostics', ops.diagnostics, 'session'],
  ['POST', '/api/diagnostics/backup', ops.runBackupNow, 'session'],
  ['GET', '/api/health', async (req, env) => {
    const r = await env.DB.prepare('SELECT 1 AS ok').first();
    return json({ ok: r && r.ok === 1, time: new Date().toISOString() });
  }, 'public'],

  ['GET', '/cal/:token', cal.icsFeed, 'public'],
];

const compiled = ROUTES.map(([method, path, handler, access]) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { method, re, keys, handler, access };
});

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

function withHeaders(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v);
  return r;
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/') && !path.startsWith('/cal/') && !path.startsWith('/oauth/')) {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
  try {
    let pathMatched = false;
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== request.method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      checkCsrf(request);
      let ctx = null;
      if (r.access !== 'public') {
        ctx = await loadContext(request, env.DB);
        if (!ctx && r.access !== 'optional') throw new HttpError(401, 'signed_out', 'Please sign in.');
        if (r.access === 'household' && !ctx.household) throw new HttpError(409, 'no_household', 'Create or join a household first.');
      }
      return withHeaders(await r.handler(request, env, ctx, params));
    }
    if (pathMatched) throw new HttpError(405, 'method', 'Method not allowed.');
    throw new HttpError(404, 'not_found', 'Not found.');
  } catch (e) {
    return withHeaders(errorResponse(e));
  }
}

export default {
  fetch: (request, env) => handle(request, env),
  async scheduled(event, env, execCtx) {
    if (event.cron === '17 3 * * *') {
      execCtx.waitUntil((async () => {
        try { await ops.housekeeping(env); } catch (e) { console.error('housekeeping failed', e); }
        try { await ops.runBackup(env); } catch (e) { console.error('backup failed', e); }
      })());
    } else {
      execCtx.waitUntil(ops.deliverDueReminders(env).catch((e) => console.error('reminders failed', e)));
      execCtx.waitUntil(sources.refreshDueSources(env).catch((e) => console.error('calendar import failed', e)));
    }
  },
};
