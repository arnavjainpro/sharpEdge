// Email/password auth with server-side sessions. Bun.password (bcrypt) for
// hashing, no new deps. Sessions are opaque tokens stored in Postgres so logout
// is an instant DELETE: no JWT signing/verification needed at this scale.
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

// ── Signup verification: no account exists until the mailed link comes back ──
//
// The staged signup lives in pending_signups, never in users: see the comment
// on that table in schema.sql for why a `verified` flag on users would be the
// expensive mistake here.

const SIGNUP_TTL_SEC = 15 * 60;
const SIGNUP_MAX_ATTEMPTS = 5;

// Six uniform digits from the platform CSPRNG. Rejection sampling rather than
// `% 10`, which would make 0-5 measurably likelier than 6-9 for a byte source
//: a small bias, but it costs one loop to not have it. Never seeded from the
// email, the password or the clock.
function sixDigitCode(): string {
  const buf = new Uint8Array(6);
  let out = "";
  while (out.length < 6) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= 250) continue; // 250..255 would skew the low digits
      out += b % 10;
      if (out.length === 6) break;
    }
  }
  return out;
}

// Stages a signup and returns the code for the caller to mail. Signing up again
// with the same address overwrites the pending row, reissues the code and
// resets attempts: that is also how "send it again" works, so there's no
// separate resend endpoint, and the previous code dies the moment a new one is
// sent.
export async function startSignup(email: string, passwordHash: string): Promise<string> {
  const code = sixDigitCode();
  await db.query(
    `INSERT INTO pending_signups (email, password_hash, code, expires_at, attempts, created_at, verified_at)
     VALUES (?, ?, ?, extract(epoch from now())::int + ?, 0, extract(epoch from now())::int, NULL)
     ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, code = excluded.code,
       expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at, verified_at = NULL`
  ).run(email.toLowerCase().trim(), passwordHash, code, SIGNUP_TTL_SEC);
  return code;
}

export async function pendingSignupExists(email: string): Promise<boolean> {
  const row = await db.query(
    `SELECT 1 AS x FROM pending_signups WHERE email = ? AND verified_at IS NULL AND expires_at > extract(epoch from now())::int`
  ).get(email.toLowerCase().trim());
  return !!row;
}

// Used to roll a staged signup back when the mail fails to send, so nobody is
// left with a pending account they have no way to confirm.
export async function discardSignup(email: string) {
  await db.query(`DELETE FROM pending_signups WHERE email = ?`).run(email.toLowerCase().trim());
}

export type ConfirmResult =
  | { ok: true; userId: number }
  // `restart` means the pending signup is gone and the address has to be
  // submitted again: the UI uses it to send you back to the signup form
  // instead of leaving you typing codes at a row that no longer exists.
  | { ok: false; error: string; restart: boolean };

export async function confirmSignup(email: string, code: string): Promise<ConfirmResult> {
  const key = email.toLowerCase().trim();
  const submitted = String(code ?? "").trim();

  // Claim the row, match the code and check expiry in one atomic UPDATE. A
  // read-then-write check would let two concurrent submits of the same correct
  // code both pass and race into two createUser() calls; here exactly one
  // UPDATE can match, and it is the one that flips verified_at.
  const claimed = await db.query(
    `UPDATE pending_signups SET verified_at = extract(epoch from now())::int
     WHERE email = ? AND code = ? AND verified_at IS NULL AND expires_at > extract(epoch from now())::int
     RETURNING password_hash`
  ).get<{ password_hash: string }>(key, submitted);

  if (claimed) {
    // Someone may have claimed the address by other means while this sat pending.
    if (await findUserByEmail(key)) {
      return { ok: false, error: "an account with that email already exists: sign in instead", restart: true };
    }
    return { ok: true, userId: await createUser(key, claimed.password_hash) };
  }

  // Nothing claimed. Read the row to say why, so a resubmit of a code that
  // already worked reads as "you're done" rather than "wrong code".
  const row = await db.query(
    `SELECT expires_at, attempts, verified_at FROM pending_signups WHERE email = ?`
  ).get<{ expires_at: number; attempts: number; verified_at: number | null }>(key);

  if (!row) return { ok: false, error: "no signup is pending for that address: create the account again", restart: true };
  if (row.verified_at) return { ok: false, error: "that address is already verified: sign in instead", restart: true };
  if (row.expires_at <= Math.floor(Date.now() / 1000)) {
    await db.query(`DELETE FROM pending_signups WHERE email = ?`).run(key);
    return { ok: false, error: "that code expired: create the account again", restart: true };
  }

  // Wrong code. Six digits is only ~20 bits, so the cap is what actually stops
  // the space being walked: incremented in the UPDATE itself so concurrent
  // guesses can't both read the same count and undercharge themselves.
  const bumped = await db.query(
    `UPDATE pending_signups SET attempts = attempts + 1 WHERE email = ? RETURNING attempts`
  ).get<{ attempts: number }>(key);
  const attempts = bumped?.attempts ?? row.attempts + 1;
  if (attempts >= SIGNUP_MAX_ATTEMPTS) {
    await db.query(`DELETE FROM pending_signups WHERE email = ?`).run(key);
    return { ok: false, error: "too many wrong codes: create the account again", restart: true };
  }
  return { ok: false, error: `that code is wrong: ${SIGNUP_MAX_ATTEMPTS - attempts} attempts left`, restart: false };
}

// Sweeps abandoned signups and, once past their window, the verified rows kept
// only so a late resubmit can be answered politely. Runs daily, so rows outlive
// their 15-minute expiry by a while: that's cosmetic, since every read path
// (confirmSignup, pendingSignupExists) checks expires_at itself.
export async function cleanupExpiredSignups() {
  await db.query(`DELETE FROM pending_signups WHERE expires_at < ?`).run(Math.floor(Date.now() / 1000));
}

// ── Email change: password to start it, a mailed code to finish it ───────────
//
// Email is the sign-in identity, so changing it needs two independent proofs:
// that you're the account holder (current password, checked by the caller
// before startEmailChange is reached) and that you can read the new inbox
// (this code). Until the code comes back the new address sits in
// users.pending_email and the account still signs in with the old one, so a
// typo or a hijacked session can't strand the account.
//
// Same TTL, cap and code generator as signup: same threat, same shape.

const EMAIL_CHANGE_TTL_SEC = SIGNUP_TTL_SEC;
const EMAIL_CHANGE_MAX_ATTEMPTS = SIGNUP_MAX_ATTEMPTS;

// Stages the change and returns the code for the caller to email. Starting a
// new one overwrites any previous pending change and resets attempts, so a
// fumbled code is fixed by just requesting a fresh one: there's no separate
// resend endpoint.
export async function startEmailChange(id: number, email: string): Promise<string> {
  const code = sixDigitCode();
  await db.query(
    `UPDATE users SET pending_email = ?, pending_email_code = ?,
       pending_email_expires = extract(epoch from now())::int + ?, pending_email_attempts = 0
     WHERE id = ?`
  ).run(email.toLowerCase().trim(), code, EMAIL_CHANGE_TTL_SEC, id);
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

export type ConfirmEmailResult =
  | { ok: true; email: string }
  // `restart` means the pending change is gone and Settings should hide the
  // code box rather than leave it up against a change that no longer exists.
  | { ok: false; error: string; restart: boolean };

// Applies the pending change if the code matches. The claim, code match and
// expiry check happen in one atomic UPDATE: two tabs submitting the same
// right code can't both apply it: and a wrong guess increments attempts in
// the same statement, so concurrent guesses can't both read the same count and
// undercharge themselves. The fifth wrong guess discards the pending change
// entirely, which is what actually stops the 6-digit space being walked.
export async function confirmEmailChange(id: number, code: string): Promise<ConfirmEmailResult> {
  const submitted = String(code ?? "").trim();

  // Clearing only pending_email_code here (not pending_email itself) matters:
  // Postgres RETURNING reflects the row AFTER the update, so nulling the same
  // column we then read back would always hand us NULL. Nulling the match key
  // is enough to make the claim exclusive: a second submit of the same code
  // no longer finds a row whose pending_email_code equals it.
  const claimed = await db.query(
    `UPDATE users SET pending_email_code = NULL
     WHERE id = ? AND pending_email_code = ? AND pending_email_expires > extract(epoch from now())::int
     RETURNING pending_email`
  ).get<{ pending_email: string }>(id, submitted);

  if (claimed) {
    const email = claimed.pending_email;
    try {
      // The UNIQUE index, not a prior SELECT, is what actually enforces this -
      // the address may have been claimed by another account since it was staged.
      await db.query(
        `UPDATE users SET email = ?, pending_email = NULL, pending_email_expires = NULL, pending_email_attempts = 0 WHERE id = ?`
      ).run(email, id);
    } catch {
      // The code was already consumed by the claim above, so leaving the rest
      // of the pending state in place would strand it: no code can ever match
      // a NULL pending_email_code again. Clear it fully; the caller starts over.
      await cancelEmailChange(id);
      return { ok: false, error: "an account with that email already exists", restart: true };
    }
    return { ok: true, email };
  }

  const row = await db.query(
    `SELECT pending_email, pending_email_expires, pending_email_attempts FROM users WHERE id = ?`
  ).get<{ pending_email: string | null; pending_email_expires: number | null; pending_email_attempts: number }>(id);

  if (!row?.pending_email) return { ok: false, error: "no email change is pending", restart: true };
  if ((row.pending_email_expires ?? 0) <= Math.floor(Date.now() / 1000)) {
    await cancelEmailChange(id);
    return { ok: false, error: "that code expired: start the change again", restart: true };
  }

  const bumped = await db.query(
    `UPDATE users SET pending_email_attempts = pending_email_attempts + 1 WHERE id = ? RETURNING pending_email_attempts`
  ).get<{ pending_email_attempts: number }>(id);
  const attempts = bumped?.pending_email_attempts ?? row.pending_email_attempts + 1;
  if (attempts >= EMAIL_CHANGE_MAX_ATTEMPTS) {
    await cancelEmailChange(id);
    return { ok: false, error: "too many wrong codes: start the change again", restart: true };
  }
  return { ok: false, error: `that code is wrong: ${EMAIL_CHANGE_MAX_ATTEMPTS - attempts} attempts left`, restart: false };
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
