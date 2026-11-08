// Family groups inside a household (e.g. "Nuclear family", "Extended family").
// Events and lists can be limited to a group: only its members (and an event's creator) see them and get alerts.
import { HttpError, json, readJson, validate, v, uid, now, parseJsonCol } from '../lib/util.js';
import { one, all, run, nextSeq, audit } from '../lib/db.js';
import { requireRole } from '../lib/auth.js';

export function groupOut(r) {
  return { id: r.id, name: r.name, memberIds: parseJsonCol(r.member_ids, []), sort: r.sort, version: r.version, seq: r.seq, deleted: !!r.deleted_at };
}

async function checkMembers(db, ctx, ids) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return uniq;
  const rows = await all(db, `SELECT id FROM members WHERE household_id = ? AND deleted_at IS NULL AND id IN (${uniq.map(() => '?').join(',')})`, ctx.household.id, ...uniq);
  if (rows.length !== uniq.length) throw new HttpError(422, 'invalid', 'memberIds contains an unknown family member', { field: 'memberIds' });
  return uniq;
}

// Re-send everything limited to this group in the sync feed, so people who joined see it and people who left drop it.
async function touchGroupItems(db, householdId, groupId) {
  for (const table of ['events', 'lists']) {
    const rows = await all(db, `SELECT id FROM ${table} WHERE household_id = ? AND group_id = ?`, householdId, groupId);
    for (const r of rows) await run(db, `UPDATE ${table} SET seq = ? WHERE id = ?`, await nextSeq(db, householdId), r.id);
  }
  const tasks = await all(db, 'SELECT t.id FROM tasks t JOIN lists l ON l.id = t.list_id WHERE l.household_id = ? AND l.group_id = ?', householdId, groupId);
  for (const r of tasks) await run(db, 'UPDATE tasks SET seq = ? WHERE id = ?', await nextSeq(db, householdId), r.id);
}

const groupSchema = v.object({
  name: v.string({ min: 1, max: 40 }),
  memberIds: v.array(v.string({ max: 60 }), { max: 30 }).default([]),
});

export async function createGroup(req, env, ctx) {
  requireRole(ctx, ['owner', 'adult']);
  const body = validate(groupSchema, await readJson(req));
  const db = env.DB;
  const n = await one(db, 'SELECT COUNT(*) AS n FROM family_groups WHERE household_id = ? AND deleted_at IS NULL', ctx.household.id);
  if (n.n >= 20) throw new HttpError(422, 'limit', 'A household can have up to 20 groups.');
  const memberIds = await checkMembers(db, ctx, body.memberIds);
  const id = uid('g_');
  const t = now();
  await run(db, 'INSERT INTO family_groups (id, household_id, name, member_ids, sort, version, seq, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)',
    id, ctx.household.id, body.name.trim(), JSON.stringify(memberIds), n.n, await nextSeq(db, ctx.household.id), t, t);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'group.create', refType: 'group', refId: id });
  return json({ group: groupOut(await one(db, 'SELECT * FROM family_groups WHERE id = ?', id)) }, 201);
}

export async function updateGroup(req, env, ctx, { id }) {
  requireRole(ctx, ['owner', 'adult']);
  const body = validate(v.object({
    name: v.string({ min: 1, max: 40 }).optional(),
    memberIds: v.array(v.string({ max: 60 }), { max: 30 }).optional(),
    version: v.number({ int: true, min: 1 }),
  }), await readJson(req));
  const db = env.DB;
  const cur = await one(db, 'SELECT * FROM family_groups WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!cur) throw new HttpError(404, 'not_found', 'Group not found.');
  if (cur.version !== body.version) throw new HttpError(409, 'conflict', 'Someone else changed this group.', { current: groupOut(cur) });
  const memberIds = body.memberIds ? await checkMembers(db, ctx, body.memberIds) : parseJsonCol(cur.member_ids, []);
  await run(db, 'UPDATE family_groups SET name = ?, member_ids = ?, version = version + 1, seq = ?, updated_at = ? WHERE id = ?',
    (body.name ?? cur.name).trim(), JSON.stringify(memberIds), await nextSeq(db, ctx.household.id), now(), id);
  if (body.memberIds) await touchGroupItems(db, ctx.household.id, id);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'group.update', refType: 'group', refId: id });
  return json({ group: groupOut(await one(db, 'SELECT * FROM family_groups WHERE id = ?', id)) });
}

// Deleting a group shares its events and lists with the whole family (nothing is lost).
export async function deleteGroup(req, env, ctx, { id }) {
  requireRole(ctx, ['owner', 'adult']);
  const db = env.DB;
  const cur = await one(db, 'SELECT * FROM family_groups WHERE id = ? AND household_id = ? AND deleted_at IS NULL', id, ctx.household.id);
  if (!cur) throw new HttpError(404, 'not_found', 'Group not found.');
  await touchGroupItems(db, ctx.household.id, id);
  await run(db, 'UPDATE events SET group_id = NULL WHERE household_id = ? AND group_id = ?', ctx.household.id, id);
  await run(db, 'UPDATE lists SET group_id = NULL WHERE household_id = ? AND group_id = ?', ctx.household.id, id);
  await run(db, 'UPDATE family_groups SET deleted_at = ?, version = version + 1, seq = ? WHERE id = ?', now(), await nextSeq(db, ctx.household.id), id);
  await audit(db, { householdId: ctx.household.id, userId: ctx.user.id, action: 'group.delete', refType: 'group', refId: id });
  return json({ ok: true });
}

// Validates a groupId sent with an event or list; returns it or null.
export async function checkGroup(db, ctx, groupId) {
  if (!groupId) return null;
  const g = await one(db, 'SELECT id FROM family_groups WHERE id = ? AND household_id = ? AND deleted_at IS NULL', groupId, ctx.household.id);
  if (!g) throw new HttpError(422, 'invalid', 'That group no longer exists.', { field: 'groupId' });
  return g.id;
}
