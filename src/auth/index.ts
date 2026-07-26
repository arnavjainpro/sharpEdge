// Email/password auth with server-side sessions. Bun.password (bcrypt) for
// hashing, no new deps. Sessions are opaque tokens stored in Postgres so logout
// is an instant DELETE — no JWT signing/verification needed at this scale.
import { db } from "../db";

const SESSION_TTL_SEC = 30 * 24 * 3600; // 30 days

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

export async function createUser(email: string, passwordHash: string): Promise<number> {
  const res = await db
    .query(`INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, extract(epoch from now())::int) RETURNING id`)
    .get<{ id: number }>(email.toLowerCase().trim(), passwordHash);
  if (res!.id === 1) await adoptLegacySingleUserData(res!.id);
  return res!.id;
}

// The first account created inherits everything from the pre-auth, single-user
// era: the Robinhood link and any broker-import blob were stored in the global
// settings namespace (user_id=0) before users existed. Move them under the new
// owner so the link keeps working after the upgrade.
async function adoptLegacySingleUserData(userId: number) {
  const rh = await db.query(`SELECT value FROM settings WHERE user_id = 0 AND key = 'robinhood_auth'`).get<{ value: string }>();
  if (rh?.value) {
    await db.query(
      `INSERT INTO broker_links (user_id, provider, auth_json, linked_at) VALUES (?, 'robinhood', ?, extract(epoch from now())::int)
       ON CONFLICT(user_id) DO NOTHING`
    ).run(userId, rh.value);
    await db.query(`DELETE FROM settings WHERE user_id = 0 AND key = 'robinhood_auth'`).run();
    console.log(`[auth] migrated legacy Robinhood link to user ${userId}`);
  }
  const imp = await db.query(`SELECT value FROM settings WHERE user_id = 0 AND key = 'broker_import'`).get<{ value: string }>();
  if (imp?.value) {
    await db.query(`INSERT INTO settings (user_id, key, value) VALUES (?, 'broker_import', ?) ON CONFLICT(user_id, key) DO NOTHING`).run(userId, imp.value);
    await db.query(`DELETE FROM settings WHERE user_id = 0 AND key = 'broker_import'`).run();
    console.log(`[auth] migrated legacy broker import to user ${userId}`);
  }
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  return await db
    .query(`SELECT id, email, password_hash FROM users WHERE email = ?`)
    .get<UserRow>(email.toLowerCase().trim());
}

export async function findUserById(id: number): Promise<{ id: number; email: string } | null> {
  return await db.query(`SELECT id, email FROM users WHERE id = ?`).get<{ id: number; email: string }>(id);
}

export async function getProfile(id: number): Promise<{ email: string; full_name: string | null; phone: string | null } | null> {
  return await db.query(`SELECT email, full_name, phone FROM users WHERE id = ?`).get<{ email: string; full_name: string | null; phone: string | null }>(id);
}

export async function updateProfile(id: number, fields: { full_name: string | null; phone: string | null }) {
  await db.query(`UPDATE users SET full_name = ?, phone = ? WHERE id = ?`).run(fields.full_name, fields.phone, id);
}

export async function getPasswordHash(id: number): Promise<string | null> {
  const row = await db.query(`SELECT password_hash FROM users WHERE id = ?`).get<{ password_hash: string }>(id);
  return row?.password_hash ?? null;
}

// Email is the sign-in identity, so this changes what the account logs in as.
// Callers must have verified the current password first. Returns false when the
// address is already taken — checked by the UNIQUE index, not a prior SELECT,
// so two simultaneous changes can't both win.
export async function updateEmail(id: number, email: string): Promise<boolean> {
  try {
    await db.query(`UPDATE users SET email = ? WHERE id = ?`).run(email.toLowerCase().trim(), id);
    return true;
  } catch {
    return false;
  }
}

export async function createSession(userId: number): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID(); // 256+ bits, unguessable
  const now = Math.floor(Date.now() / 1000);
  await db.query(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, now, now + SESSION_TTL_SEC);
  return token;
}

export async function validateSession(token: string): Promise<number | null> {
  const row = await db.query(`SELECT user_id, expires_at FROM sessions WHERE token = ?`).get<{ user_id: number; expires_at: number }>(token);
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row.user_id;
}

export async function destroySession(token: string) {
  await db.query(`DELETE FROM sessions WHERE token = ?`).run(token);
}

export async function cleanupExpiredSessions() {
  await db.query(`DELETE FROM sessions WHERE expires_at < ?`).run(Math.floor(Date.now() / 1000));
}
