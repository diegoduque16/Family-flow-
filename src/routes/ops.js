// Notifications inbox, push subscriptions, scheduled jobs (reminders, backups, cleanup) and diagnostics.
import { HttpError, json, readJson, validate, v, uid, now } from '../lib/util.js';
import { one, all, run, getSetting, setSetting } from '../lib/db.js';
import { requireRole } from '../lib/auth.js';
import { getVapidKeys, sendPush } from '../lib/push.js';
import { refreshRecurringReminders } from '../lib/reminders.js';
import { geoapify, photon } from './places.js';

// ---------- inbox ----------
export async function listNotifications(req, env, ctx) {
  const rows = await all(env.DB,
    `SELECT n.*, r.read_at FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
     WHERE n.household_id = ? AND (n.user_id IS NULL OR n.user_id = ?)
     ORDER BY n.created_at DESC LIMIT 100`, ctx.user.id, ctx.household.id, ctx.user.id);
  return json({ notifications: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, refType: r.ref_type, refId: r.ref_id, createdAt: r.created_at, read: !!r.read_at })) });
}

export async function markRead(req, env, ctx) {
  const body = validate(v.object({ ids: v.array(v.string({ max: 60 }), { max: 200 }).optional(), all: v.boolean().optional() }), await readJson(req));
  const ids = body.all
    ? (await all(env.DB, 'SELECT id FROM notifications WHERE household_id = ? AND (user_id IS NULL OR user_id = ?)', ctx.household.id, ctx.user.id)).map((r) => r.id)
    : body.ids || [];
  for (const id of ids) {
    await run(env.DB, 'INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?,?,?)', id, ctx.user.id, now());
  }
  return json({ ok: true, count: ids.length });
}

// ---------- push subscriptions ----------
export async function pushKey(req, env) {
  const { publicKey } = await getVapidKeys(env.DB);
  return json({ publicKey });
}

const subSchema = v.object({
  endpoint: v.string({ min: 10, max: 1000, pattern: /^https:\/\// }),
  keys: v.object({ p256dh: v.string({ min: 20, max: 200 }), auth: v.string({ min: 8, max: 100 }) }),
});

export async function subscribe(req, env, ctx) {
  const s = validate(subSchema, await readJson(req));
  await run(env.DB,
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, last_error = NULL`,
    uid('ps_'), ctx.user.id, s.endpoint, s.keys.p256dh, s.keys.auth, now());
  return json({ ok: true });
}

export async function unsubscribe(req, env, ctx) {
  const { endpoint } = validate(v.object({ endpoint: v.string({ max: 1000 }) }), await readJson(req));
  await run(env.DB, 'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, ctx.user.id);
  return json({ ok: true });
}

export async function testPush(req, env, ctx) {
  const subs = await all(env.DB, 'SELECT * FROM push_subscriptions WHERE user_id = ?', ctx.user.id);
  if (!subs.length) throw new HttpError(409, 'no_subscription', 'Notifications are not turned on for this device yet.');
  const results = [];
  for (const s of subs) {
    const r = await sendPush(env.DB, s, { title: 'Family Flow', body: 'Notifications are working on this device.', tag: 'test', url: '/' }, env);
    await recordPushResult(env.DB, s, r);
    results.push({ endpointHost: new URL(s.endpoint).host, ok: r.ok, status: r.status, error: r.error });
  }
  return json({ results, delivered: results.filter((r) => r.ok).length });
}

async function recordPushResult(db, sub, r) {
  if (r.ok) await run(db, 'UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL WHERE id = ?', now(), sub.id);
  else if (r.gone) await run(db, 'DELETE FROM push_subscriptions WHERE id = ?', sub.id);
  else await run(db, 'UPDATE push_subscriptions SET last_error = ? WHERE id = ?', r.error || 'unknown', sub.id);
}

// ---------- cron: reminders ----------
export async function deliverDueReminders(env, at = now()) {
  const db = env.DB;
  // Recover rows claimed by a run that crashed mid-way.
  await run(db, "UPDATE scheduled_notifications SET status = 'pending' WHERE status = 'sending' AND fire_at < ?", at - 10 * 60000);
  const due = await all(db, "SELECT * FROM scheduled_notifications WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at LIMIT 200", at);
  let sent = 0;
  let pushed = 0;
  let failed = 0;
  for (const n of due) {
    // Claim the row first so overlapping cron runs never double-send.
    const claim = await run(db, "UPDATE scheduled_notifications SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'", n.id);
    if (!claim.meta || claim.meta.changes !== 1) continue;
    try {
      const stale = at - n.fire_at > 6 * 3600000; // more than 6h late: inbox only, don't buzz phones
      await run(db, 'INSERT INTO notifications (id, household_id, user_id, kind, title, body, ref_type, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        uid('n_'), n.household_id, n.only_user_id, 'reminder', n.title, n.body, n.ref_type, n.ref_id, at);
      const users = n.only_user_id
        ? [{ user_id: n.only_user_id }]
        : await all(db, 'SELECT user_id FROM memberships WHERE household_id = ?', n.household_id);
      const errors = [];
      if (!stale) {
        for (const u of users) {
          const subs = await all(db, 'SELECT * FROM push_subscriptions WHERE user_id = ?', u.user_id);
          for (const s of subs) {
            const r = await sendPush(db, s, { title: n.title, body: n.body, tag: `${n.ref_type}:${n.ref_id}:${n.fire_at}`, url: n.ref_type === 'event' ? `/#/event/${n.ref_id}` : '/#/tasks' }, env);
            await recordPushResult(db, s, r);
            if (r.ok) pushed++; else errors.push(r.error);
          }
        }
      }
      await run(db, "UPDATE scheduled_notifications SET status = 'sent', sent_at = ?, error = ? WHERE id = ?", now(), errors.length ? errors.join('; ').slice(0, 500) : null, n.id);
      sent++;
    } catch (e) {
      failed++;
      const status = n.attempts + 1 >= 5 ? 'failed' : 'pending';
      await run(db, 'UPDATE scheduled_notifications SET status = ?, error = ? WHERE id = ?', status, String(e.message || e).slice(0, 500), n.id);
    }
  }
  await setSetting(db, 'cron_last_run', JSON.stringify({ at, due: due.length, sent, pushed, failed }));
  return { due: due.length, sent, pushed, failed };
}

// ---------- cron: daily backup + housekeeping ----------
const BACKUP_TABLES = ['users', 'households', 'members', 'memberships', 'events', 'lists', 'tasks', 'places', 'push_subscriptions', 'settings'];

export async function runBackup(env) {
  const db = env.DB;
  if (!env.BACKUPS) {
    await setSetting(db, 'backup_last_run', JSON.stringify({ at: now(), ok: false, error: 'No R2 bucket bound (BACKUPS)' }));
    return { ok: false, error: 'No R2 bucket bound' };
  }
  const dump = { createdAt: new Date().toISOString(), tables: {} };
  for (const t of BACKUP_TABLES) dump.tables[t] = await all(db, `SELECT * FROM ${t}`);
  const text = JSON.stringify(dump);
  const gz = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const key = `backups/${dump.createdAt.slice(0, 10)}.json.gz`;
  await env.BACKUPS.put(key, gz, { httpMetadata: { contentType: 'application/gzip' } });
  // verify by reading it back
  const head = await env.BACKUPS.head(key);
  const ok = !!head && head.size === gz.byteLength;
  // keep 35 days
  const listed = await env.BACKUPS.list({ prefix: 'backups/' });
  const cutoff = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  for (const o of listed.objects || []) {
    if (o.key.slice(8, 18) < cutoff) await env.BACKUPS.delete(o.key);
  }
  await setSetting(db, 'backup_last_run', JSON.stringify({ at: now(), ok, key, bytes: gz.byteLength, rows: Object.fromEntries(Object.entries(dump.tables).map(([k, v]) => [k, v.length])) }));
  return { ok, key, bytes: gz.byteLength };
}

export async function housekeeping(env) {
  const db = env.DB;
  const t = now();
  await run(db, 'DELETE FROM sessions WHERE expires_at < ?', t);
  await run(db, 'DELETE FROM rate_limits WHERE window_start < ?', t - 86400000);
  await run(db, "DELETE FROM scheduled_notifications WHERE status IN ('sent','failed') AND fire_at < ?", t - 30 * 86400000);
  await run(db, 'DELETE FROM notifications WHERE created_at < ?', t - 90 * 86400000);
  await run(db, "DELETE FROM proposals WHERE status != 'pending' AND created_at < ?", t - 30 * 86400000);
  await run(db, 'DELETE FROM usage WHERE day < ?', new Date(t - 60 * 86400000).toISOString().slice(0, 10));
  await run(db, 'DELETE FROM audit WHERE created_at < ?', t - 365 * 86400000);
  const ext = await refreshRecurringReminders(db);
  await setSetting(db, 'daily_last_run', JSON.stringify({ at: t, remindersExtended: ext }));
}

// ---------- diagnostics ----------
async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { name, status: r.status || 'ok', detail: r.detail || '', ms: Date.now() - t0 };
  } catch (e) {
    return { name, status: 'fail', detail: String(e.message || e).slice(0, 300), ms: Date.now() - t0 };
  }
}

export async function runDiagnostics(env, { live = true } = {}) {
  const db = env.DB;
  const checks = [];
  checks.push(await timed('Database write/read', async () => {
    const id = uid('diag_');
    await run(db, 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', id, 'ping', now());
    const r = await one(db, 'SELECT value FROM settings WHERE key = ?', id);
    await run(db, 'DELETE FROM settings WHERE key = ?', id);
    if (!r || r.value !== 'ping') throw new Error('read-back mismatch');
    return { detail: 'Wrote, read back and deleted a test row' };
  }));
  checks.push(await timed('Database schema', async () => {
    const t = await all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events','tasks','members','households','scheduled_notifications')");
    if (t.length !== 5) throw new Error(`missing tables (found ${t.map((x) => x.name).join(', ')})`);
    return { detail: 'All core tables present' };
  }));
  checks.push(await timed('Reminder scheduler (cron)', async () => {
    const s = JSON.parse((await getSetting(db, 'cron_last_run')) || 'null');
    if (!s) return { status: 'warn', detail: 'Has not run yet. It runs every minute once deployed with the cron trigger.' };
    const age = Math.round((now() - s.at) / 1000);
    if (age > 600) return { status: 'fail', detail: `Last ran ${Math.round(age / 60)} minutes ago` };
    return { detail: `Last ran ${age}s ago · ${s.sent} sent, ${s.failed} failed` };
  }));
  checks.push(await timed('Pending reminders', async () => {
    const late = await one(db, "SELECT COUNT(*) AS n FROM scheduled_notifications WHERE status = 'pending' AND fire_at < ?", now() - 5 * 60000);
    const failed = await one(db, "SELECT COUNT(*) AS n FROM scheduled_notifications WHERE status = 'failed' AND fire_at > ?", now() - 7 * 86400000);
    const upcoming = await one(db, "SELECT COUNT(*) AS n FROM scheduled_notifications WHERE status = 'pending' AND fire_at >= ?", now());
    if (late.n > 0) return { status: 'fail', detail: `${late.n} reminders are more than 5 minutes overdue` };
    if (failed.n > 0) return { status: 'warn', detail: `${failed.n} reminders failed in the last 7 days · ${upcoming.n} scheduled` };
    return { detail: `${upcoming.n} reminders scheduled, none overdue` };
  }));
  checks.push(await timed('Push notifications', async () => {
    await getVapidKeys(db);
    const subs = await one(db, 'SELECT COUNT(*) AS n, SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS bad FROM push_subscriptions');
    if (!subs.n) return { status: 'warn', detail: 'Keys ready; no device has turned on notifications yet' };
    return { status: subs.bad ? 'warn' : 'ok', detail: `${subs.n} device(s) subscribed${subs.bad ? `, ${subs.bad} with recent errors` : ''}` };
  }));
  checks.push(await timed('Backups', async () => {
    if (!env.BACKUPS) return { status: 'warn', detail: 'R2 bucket not bound; relying on D1 Time Travel (30-day point-in-time restore)' };
    const s = JSON.parse((await getSetting(db, 'backup_last_run')) || 'null');
    if (!s) return { status: 'warn', detail: 'No backup yet (runs daily at 03:17 UTC)' };
    const hrs = (now() - s.at) / 3600000;
    if (!s.ok) return { status: 'fail', detail: s.error || 'Last backup failed' };
    if (hrs > 30) return { status: 'fail', detail: `Last backup ${Math.round(hrs)}h ago` };
    return { detail: `${s.key} · ${(s.bytes / 1024).toFixed(1)} KB · ${Math.round(hrs)}h ago` };
  }));
  if (live) {
    checks.push(await timed('Address search: Geoapify', async () => {
      if (!env.GEOAPIFY_API_KEY) return { status: 'warn', detail: 'GEOAPIFY_API_KEY not set (using fallback provider)' };
      const r = await geoapify(env, '1600 Pennsylvania Ave', null, env.__fetch || fetch);
      if (!r.length) throw new Error('No results for a known address');
      return { detail: `Returned ${r.length} results` };
    }));
    checks.push(await timed('Address search: fallback (Photon)', async () => {
      const r = await photon('Central Park New York', null, env.__fetch || fetch);
      if (!r.length) throw new Error('No results for a known place');
      return { detail: `Returned ${r.length} results` };
    }));
    checks.push(await timed('AI assistant (Claude)', async () => {
      if (!env.ANTHROPIC_API_KEY) return { status: 'fail', detail: 'ANTHROPIC_API_KEY not set' };
      const f = env.__fetch || fetch;
      const res = await f('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}`);
      const data = await res.json();
      const ids = (data.data || []).map((m) => m.id);
      const want = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
      if (ids.length && !ids.includes(want)) return { status: 'warn', detail: `Key works, but model "${want}" is not listed; a fallback model will be used. Set ANTHROPIC_MODEL to one of: ${ids.slice(0, 5).join(', ')}` };
      return { detail: `Key valid · model ${want}` };
    }));
    checks.push(await timed('Voice transcription (Workers AI)', async () => {
      if (!env.AI) return { status: 'fail', detail: 'AI binding missing' };
      return { detail: 'Workers AI binding present (Whisper)' };
    }));
  }
  const overall = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { overall, checkedAt: new Date().toISOString(), checks };
}

function isAdmin(env, ctx) {
  const admins = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return admins.includes(ctx.user.email.toLowerCase());
}

export async function diagnostics(req, env, ctx) {
  if (!isAdmin(env, ctx)) requireRole(ctx, ['owner']);
  return json(await runDiagnostics(env, { live: new URL(req.url).searchParams.get('live') !== '0' }));
}

export async function runBackupNow(req, env, ctx) {
  if (!isAdmin(env, ctx)) throw new HttpError(403, 'forbidden', 'Only the app administrator can run backups manually.');
  return json(await runBackup(env));
}
