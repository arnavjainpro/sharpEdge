import { expect, test, afterAll } from "bun:test";
import { db } from "../db";
import {
  hashPassword, verifyPassword, findUserByEmail,
  startSignup, confirmSignup, pendingSignupExists, cleanupExpiredSignups,
} from "./index";

// Signup verification's whole point is that an unconfirmed address never becomes
// an account. That matters more here than in most apps: since SHARP-29 every row
// in `users` joins the monitored set and starts costing AI tokens, so a row
// created on an unverified address is both a squat and a bill.
//
// NOTE: writes to the configured database, using @example.invalid addresses that
// are deleted afterwards.

const emails: string[] = [];
const freshEmail = () => {
  const e = `signup-test-${crypto.randomUUID()}@example.invalid`;
  emails.push(e);
  return e;
};

afterAll(async () => {
  for (const e of emails) {
    await db.query(`DELETE FROM pending_signups WHERE email = ?`).run(e);
    await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)`).run(e);
    await db.query(`DELETE FROM users WHERE email = ?`).run(e);
  }
});

test("staging a signup creates no account", async () => {
  const email = freshEmail();
  await startSignup(email, await hashPassword("correct horse battery"));

  expect(await pendingSignupExists(email)).toBe(true);
  // The critical assertion: nothing in `users`, so nothing is monitored,
  // nothing is billable, and the address isn't claimed.
  expect(await findUserByEmail(email)).toBeNull();
});

test("the right code creates the account, with the password chosen at signup", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("correct horse battery"));

  const res = await confirmSignup(email, code);
  expect(res.ok).toBe(true);

  const user = await findUserByEmail(email);
  expect(user).not.toBeNull();
  // The hash staged at signup is the one that lands — not a re-hash of something else.
  expect(await verifyPassword("correct horse battery", user!.password_hash)).toBe(true);
  // Pending row is consumed, so the code can't be replayed.
  expect(await pendingSignupExists(email)).toBe(false);
  expect((await confirmSignup(email, code)).ok).toBe(false);
});

test("wrong codes are capped, and the fifth discards the signup", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("x".repeat(12)));
  const wrong = code === "000000" ? "111111" : "000000";

  for (let i = 0; i < 4; i++) {
    expect((await confirmSignup(email, wrong)).ok).toBe(false);
    expect(await pendingSignupExists(email)).toBe(true);
  }
  expect(await confirmSignup(email, wrong)).toEqual({ ok: false, error: "too many wrong codes — create the account again" });
  expect(await pendingSignupExists(email)).toBe(false);
  // Still no account, and the real code is now worthless.
  expect(await findUserByEmail(email)).toBeNull();
  expect((await confirmSignup(email, code)).ok).toBe(false);
});

test("an expired code is dead even when it matches", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("x".repeat(12)));
  await db.query(`UPDATE pending_signups SET expires_at = extract(epoch from now())::int - 1 WHERE email = ?`).run(email);

  expect(await confirmSignup(email, code)).toEqual({ ok: false, error: "that code expired — create the account again" });
  expect(await findUserByEmail(email)).toBeNull();
});

test("signing up again reissues a code and invalidates the old one", async () => {
  const email = freshEmail();
  const first = await startSignup(email, await hashPassword("first pass ok"));
  const second = await startSignup(email, await hashPassword("second pass ok"));
  expect(second).not.toBe(first);

  // This is also the "resend" path, so the stale code must not still work.
  expect((await confirmSignup(email, first)).ok).toBe(false);
  const res = await confirmSignup(email, second);
  expect(res.ok).toBe(true);
  // The password from the LATEST attempt is the one that counts.
  const user = await findUserByEmail(email);
  expect(await verifyPassword("second pass ok", user!.password_hash)).toBe(true);
});

test("a wrong guess doesn't burn attempts on a resent code", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("x".repeat(12)));
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) await confirmSignup(email, wrong);
  // Re-staging resets the counter — otherwise a fumbled first attempt would
  // leave the next code with one try left for no reason.
  const fresh = await startSignup(email, await hashPassword("x".repeat(12)));
  const wrong2 = fresh === "000000" ? "111111" : "000000";
  const res = await confirmSignup(email, wrong2);
  expect(res.ok).toBe(false);
  expect(res.ok === false && res.error).toContain("4 attempts left");
});

test("expired signups are swept without touching live ones", async () => {
  const stale = freshEmail();
  const live = freshEmail();
  await startSignup(stale, await hashPassword("x".repeat(12)));
  await startSignup(live, await hashPassword("x".repeat(12)));
  await db.query(`UPDATE pending_signups SET expires_at = extract(epoch from now())::int - 1 WHERE email = ?`).run(stale);

  await cleanupExpiredSignups();
  expect(await pendingSignupExists(stale)).toBe(false);
  expect(await pendingSignupExists(live)).toBe(true);
});
