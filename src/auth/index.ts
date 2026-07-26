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

// ── Email change: password to start it, a mailed code to finish it ───────────
//
// Email is the sign-in identity, so changing it needs two independent proofs:
// that you're the account holder (current password, checked by the caller) and
// that you can read the new inbox (this code). Until the code comes back the
// new address sits in users.pending_email and the account still signs in with
// the old one — a typo or a hijacked session can't strand you.

const EMAIL_CODE_TTL_SEC = 15 * 60;
const EMAIL_CODE_MAX_ATTEMPTS = 5;

// crypto.getRandomValues, not Math.random: this code is the only thing standing
// between a stranger's inbox and someone's login. Rejection-sampled so the
// digits stay uniform — % 1_000_000 on a u32 skews the low values.
function sixDigitCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  do { crypto.getRandomValues(buf); } while (buf[0]! >= limit);
  return String(buf[0]! % 1_000_000).padStart(6, "0");
}

// Stages the change and returns the code for the caller to email. Starting a
// new one overwrites any previous pending change and resets the attempt count,
// so a fumbled attempt is fixed by just requesting another code.
export async function startEmailChange(id: number, email: string): Promise<string> {
  const code = sixDigitCode();
  await db.query(
    `UPDATE users SET pending_email = ?, pending_email_code = ?,
       pending_email_expires = extract(epoch from now())::int + ?, pending_email_attempts = 0
     WHERE id = ?`
  ).run(email.toLowerCase().trim(), code, EMAIL_CODE_TTL_SEC, id);
  return code;
}

export async function getPendingEmail(id: number): Promise<string | null> {
  const row = await db.query(
    `SELECT pending_email FROM users WHERE id = ? AND pending_email IS NOT NULL
       AND pending_email_expires > extract(epoch from now())::int`
  ).get<{ pending_email: string }>(id);
  return row?.pending_email ?? null;
}

export async function cancelEmailChange(id: number) {
  await db.query(
    `UPDATE users SET pending_email = NULL, pending_email_code = NULL,
       pending_email_expires = NULL, pending_email_attempts = 0 WHERE id = ?`
  ).run(id);
}

// Applies the pending change if the code matches. Every wrong guess burns an
// attempt and the fifth one throws the pending change away entirely, so the
// 6-digit space can't be walked. Uniqueness comes off the UNIQUE index rather
// than a prior SELECT — the address may have been claimed since it was staged.
export async function confirmEmailChange(id: number, code: string): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const row = await db.query(
    `SELECT pending_email, pending_email_code, pending_email_expires, pending_email_attempts FROM users WHERE id = ?`
  ).get<{ pending_email: string | null; pending_email_code: string | null; pending_email_expires: number | null; pending_email_attempts: number }>(id);

  if (!row?.pending_email || !row.pending_email_code) return { ok: false, error: "no email change is pending" };
  if ((row.pending_email_expires ?? 0) <= Math.floor(Date.now() / 1000)) {
    await cancelEmailChange(id);
    return { ok: false, error: "that code expired — start the change again" };
  }
  if (row.pending_email_code !== String(code).trim()) {
    const attempts = row.pending_email_attempts + 1;
    if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      await cancelEmailChange(id);
      return { ok: false, error: "too many wrong codes — start the change again" };
    }
    await db.query(`UPDATE users SET pending_email_attempts = ? WHERE id = ?`).run(attempts, id);
    return { ok: false, error: `that code is wrong — ${EMAIL_CODE_MAX_ATTEMPTS - attempts} attempts left` };
  }

  const email = row.pending_email;
  try {
    await db.query(`UPDATE users SET email = ? WHERE id = ?`).run(email, id);
  } catch {
    return { ok: false, error: "an account with that email already exists" };
  }
  await cancelEmailChange(id);
  return { ok: true, email };
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
