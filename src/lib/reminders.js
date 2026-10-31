// Turns events/tasks into rows in scheduled_notifications, which the cron job delivers.
import { uid, now, parseJsonCol } from './util.js';
import { run, all } from './db.js';
import { expandEvent, localToUtc, parseLocal } from './time.js';

export const HORIZON_DAYS = 35;

export function humanWhen(ms, tz, allDay = false) {
  const opts = allDay
    ? { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }
    : { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms));
}

export async function scheduleEvent(db, ev) {
  await run(db, "DELETE FROM scheduled_notifications WHERE ref_type = 'event' AND ref_id = ? AND status = 'pending'", ev.id);
  if (ev.deleted_at) return 0;
  const reminders = parseJsonCol(ev.reminders, []);
  if (!reminders.length) return 0;
  const t = now();
  const occ = expandEvent(ev, t, t + HORIZON_DAYS * 86400000);
  let n = 0;
  for (const o of occ) {
    for (const mins of reminders) {
      const fireAt = o.start_utc - mins * 60000;
      if (fireAt < t - 60000) continue;
      const when = humanWhen(o.start_utc, ev.tz, !!ev.all_day);
      const body = [mins === 0 ? `Now · ${when}` : `${when}`, ev.location_name || ev.location_address].filter(Boolean).join(' · ');
      await run(db,
        `INSERT OR IGNORE INTO scheduled_notifications (id, household_id, ref_type, ref_id, only_user_id, fire_at, title, body, status)
         VALUES (?,?,?,?,?,?,?,?, 'pending')`,
        uid('sn_'), ev.household_id, 'event', ev.id, ev.visibility === 'private' ? ev.owner_user_id : null, fireAt, ev.title, body);
      n++;
    }
  }
  return n;
}

export async function scheduleTask(db, task, tz) {
  await run(db, "DELETE FROM scheduled_notifications WHERE ref_type = 'task' AND ref_id = ? AND status = 'pending'", task.id);
  if (task.deleted_at || task.done || !task.remind || !task.due_local) return 0;
  const p = parseLocal(task.due_local);
  const fireAt = p.timed ? localToUtc(task.due_local, tz) : localToUtc(`${task.due_local}T09:00`, tz);
  if (fireAt < now() - 60000) return 0;
  await run(db,
    `INSERT OR IGNORE INTO scheduled_notifications (id, household_id, ref_type, ref_id, only_user_id, fire_at, title, body, status)
     VALUES (?,?,?,?,NULL,?,?,?, 'pending')`,
    uid('sn_'), task.household_id, 'task', task.id, fireAt, `To do: ${task.title}`, `Due ${humanWhen(fireAt, tz, !p.timed)}`);
  return 1;
}

// Daily: extend the reminder horizon for open-ended recurring events.
export async function refreshRecurringReminders(db) {
  const rows = await all(db, "SELECT * FROM events WHERE deleted_at IS NULL AND rrule IS NOT NULL AND reminders != '[]' AND (series_end_utc IS NULL OR series_end_utc > ?)", now());
  let n = 0;
  for (const ev of rows) n += await scheduleEvent(db, ev);
  return n;
}
