// Who can see an event or list, and who should be told about changes to it.
import { all, one } from './db.js';
import { parseJsonCol } from './util.js';

// Ids of the groups the signed-in person's profile belongs to (set on ctx per request).
export async function loadMyGroups(db, householdId, memberId) {
  if (!householdId || !memberId) return new Set();
  const rows = await all(db, 'SELECT id, member_ids FROM family_groups WHERE household_id = ? AND deleted_at IS NULL', householdId);
  return new Set(rows.filter((g) => parseJsonCol(g.member_ids, []).includes(memberId)).map((g) => g.id));
}

const inGroup = (ctx, groupId) => !!(ctx.groupIds && ctx.groupIds.has(groupId));

export function eventVisible(r, ctx) {
  if (r.visibility === 'private') return r.owner_user_id === ctx.user.id;
  if (r.group_id) return r.owner_user_id === ctx.user.id || inGroup(ctx, r.group_id);
  return true;
}

export function listVisible(l, ctx) {
  return !l || !l.group_id || inGroup(ctx, l.group_id);
}

// User ids that can see something limited to a group (null groupId = everyone in the household).
export async function audienceUserIds(db, householdId, { visibility = 'shared', ownerUserId = null, groupId = null } = {}) {
  if (visibility === 'private') return ownerUserId ? [ownerUserId] : [];
  const people = await all(db, 'SELECT user_id, member_id FROM memberships WHERE household_id = ?', householdId);
  if (!groupId) return people.map((p) => p.user_id);
  const g = await one(db, 'SELECT member_ids FROM family_groups WHERE id = ? AND household_id = ?', groupId, householdId);
  const ids = g ? parseJsonCol(g.member_ids, []) : [];
  return people.filter((p) => (p.member_id && ids.includes(p.member_id)) || p.user_id === ownerUserId).map((p) => p.user_id);
}

export const eventAudience = (db, ev) =>
  audienceUserIds(db, ev.household_id, { visibility: ev.visibility, ownerUserId: ev.owner_user_id, groupId: ev.group_id || null });

// For reminders: null when everyone in the household may see it, otherwise the list of user ids.
export async function restrictedAudience(db, refType, refId) {
  if (refType === 'event') {
    const ev = await one(db, 'SELECT household_id, visibility, owner_user_id, group_id FROM events WHERE id = ?', refId);
    if (!ev || !ev.group_id || ev.visibility === 'private') return null;
    return eventAudience(db, ev);
  }
  if (refType === 'task') {
    const t = await one(db, 'SELECT t.household_id, l.group_id FROM tasks t JOIN lists l ON l.id = t.list_id WHERE t.id = ?', refId);
    if (!t || !t.group_id) return null;
    return audienceUserIds(db, t.household_id, { groupId: t.group_id });
  }
  return null;
}
