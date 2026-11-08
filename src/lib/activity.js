// "Family activity" alerts: tell the rest of the family when someone adds, moves or cancels an event,
// or assigns them a task. Inbox entry immediately + Web Push (after the response when possible).
import { all, one, run } from './db.js';
import { uid, now } from './util.js';
import { sendPush } from './push.js';
import { humanWhen } from './reminders.js';

export async function actorName(db, ctx) {
  if (ctx.memberId) {
    const m = await one(db, 'SELECT name FROM members WHERE id = ?', ctx.memberId);
    if (m && m.name) return m.name;
  }
  return String(ctx.user.name || 'Someone').split(' ')[0];
}

export function eventWhen(ev) {
  const when = humanWhen(ev.start_utc, ev.tz, !!ev.all_day);
  return [when, ev.location_name || (ev.location_address || '').split(',')[0]].filter(Boolean).join(' · ');
}

async function recordPushResult(db, sub, r) {
  if (r.ok) await run(db, 'UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL WHERE id = ?', now(), sub.id);
  else if (r.gone) await run(db, 'DELETE FROM push_subscriptions WHERE id = ?', sub.id);
  else await run(db, 'UPDATE push_subscriptions SET last_error = ? WHERE id = ?', r.error || 'unknown', sub.id);
}

// userIds: everyone who can see the item. The person who made the change and anyone who muted alerts are skipped.
export async function notifyActivity(ctx, { userIds, title, body, refType, refId }) {
  const env = ctx.env || {};
  const db = env.DB;
  if (!db || !ctx.household) return 0;
  const want = [...new Set(userIds || [])].filter((u) => u && u !== ctx.user.id);
  if (!want.length) return 0;
  const muted = new Set((await all(db, 'SELECT user_id FROM memberships WHERE household_id = ? AND notify_activity = 0', ctx.household.id)).map((r) => r.user_id));
  const recipients = want.filter((u) => !muted.has(u));
  if (!recipients.length) return 0;
  const t = now();
  for (const u of recipients) {
    await run(db, 'INSERT INTO notifications (id, household_id, user_id, kind, title, body, ref_type, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      uid('n_'), ctx.household.id, u, 'activity', title, body, refType, refId, t);
  }
  const push = (async () => {
    const url = refType === 'event' ? `/#/event/${refId}` : refType === 'task' ? '/#/tasks' : '/#/inbox';
    for (const u of recipients) {
      const subs = await all(db, 'SELECT * FROM push_subscriptions WHERE user_id = ?', u);
      for (const s of subs) {
        try {
          const r = await sendPush(db, s, { title, body, tag: `activity:${refType}:${refId}`, url }, env);
          await recordPushResult(db, s, r);
        } catch (e) { console.error('activity push failed', e); }
      }
    }
  })();
  if (ctx.waitUntil) ctx.waitUntil(push); else await push;
  return recipients.length;
}
