import { expect, test, afterAll } from "bun:test";
import { db } from "../db";
import {
  hashPassword, verifyPassword, findUserByEmail,
  startSignup, confirmSignup, pendingSignupExists, discardSignup, cleanupExpiredSignups,
} from "./index";
import { verificationEmail } from "../notify/email";

// Signup verification's whole point is that an unconfirmed address never becomes
// an account. That matters more here than in most apps: since SHARP-29 every row
// in `users` joins the monitored set and starts costing Finnhub calls and AI
// tokens, so a row created on an unverified address is both a squat and a bill.
//
// NOTE: writes to the configured database, using @example.invalid addresses that
// are deleted afterwards.

const emails: string[] = [];
const freshEmail = () => {
  const e = `signup-test-${crypto.randomUUID()}@example.invalid`;
  emails.push(e);
  return e;
};
const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

// One statement per table rather than three round trips per address: this runs
// against a remote Postgres, and a cleanup that overruns the hook budget is
// killed part-done, leaving throwaway accounts in the live database where the
// app treats them as real. Timeout raised so a slow cleanup fails loudly.
afterAll(async () => {
  if (!emails.length) return;
  const ph = emails.map(() => "?").join(",");
  await db.query(`DELETE FROM pending_signups WHERE email IN (${ph})`).run(...emails);
  await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN (${ph}))`).run(...emails);
  await db.query(`DELETE FROM users WHERE email IN (${ph})`).run(...emails);
}, 60_000);

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

  expect((await confirmSignup(email, code)).ok).toBe(true);

  const user = await findUserByEmail(email);
  expect(user).not.toBeNull();
  // The hash staged at signup is the one that lands: not a re-hash of something else.
  expect(await verifyPassword("correct horse battery", user!.password_hash)).toBe(true);
  expect(await pendingSignupExists(email)).toBe(false);
});

test("codes are six digits, uniform, and don't repeat", async () => {
  const seen = new Set<string>();
  const digits = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const code = await startSignup(freshEmail(), await hashPassword("x".repeat(12)));
    expect(code).toMatch(/^[0-9]{6}$/);
    seen.add(code);
    for (const d of code) digits.add(d);
  }
  expect(seen.size).toBeGreaterThan(9);   // 12 draws from 10^6 colliding is ~0
  expect(digits.size).toBe(10);           // rejection sampling reaches 6-9, not just 0-5
});

test("resubmitting a code that already worked is answered gracefully", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("x".repeat(12)));
  expect((await confirmSignup(email, code)).ok).toBe(true);

  // Double-submit: must not create a second account, must not read as "wrong
  // code", and must send the user to sign in rather than keep typing codes.
  const again = await confirmSignup(email, code);
  expect(again).toEqual({ ok: false, error: "that address is already verified: sign in instead", restart: true });

  const rows = await db.query(`SELECT id FROM users WHERE email = ?`).all(email);
  expect(rows).toHaveLength(1);
});

test("concurrent submits of the same code create exactly one account", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("x".repeat(12)));

  // A double-click on Confirm. The claim is a single atomic UPDATE, so only one
  // of these can win the row.
  const results = await Promise.all([confirmSignup(email, code), confirmSignup(email, code), confirmSignup(email, code)]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);

  const rows = await db.query(`SELECT id FROM users WHERE email = ?`).all(email);
  expect(rows).toHaveLength(1);
});

test("wrong codes are capped, and the fifth discards the signup", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("x".repeat(12)));
  const wrong = wrongCode(code);

  for (let i = 0; i < 4; i++) {
    const res = await confirmSignup(email, wrong);
    expect(res).toMatchObject({ ok: false, restart: false });
    expect(await pendingSignupExists(email)).toBe(true);
  }
  expect(await confirmSignup(email, wrong)).toEqual({ ok: false, error: "too many wrong codes: create the account again", restart: true });

  // Still no account, and the real code is now worthless: this is what stops
  // the 10^6 space being walked.
  expect(await pendingSignupExists(email)).toBe(false);
  expect(await findUserByEmail(email)).toBeNull();
  expect((await confirmSignup(email, code)).ok).toBe(false);
});

test("the attempts left counter is accurate", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("x".repeat(12)));
  const wrong = wrongCode(code);

  for (const left of ["4 attempts left", "3 attempts left", "2 attempts left", "1 attempts left"]) {
    const res = await confirmSignup(email, wrong);
    expect(res.ok === false && res.error).toContain(left);
  }
});

test("codes expire 15 minutes out", async () => {
  const email = freshEmail();
  await startSignup(email, await hashPassword("x".repeat(12)));
  const row = await db.query(`SELECT expires_at - extract(epoch from now())::int AS ttl FROM pending_signups WHERE email = ?`)
    .get<{ ttl: number }>(email);
  // The window is short on purpose: 6 digits is only ~20 bits, so the less time
  // a live code exists the better, and a code you type immediately doesn't need
  // longer. Loose bounds so a slow round-trip doesn't flake it.
  expect(row!.ttl).toBeGreaterThan(14 * 60);
  expect(row!.ttl).toBeLessThanOrEqual(15 * 60);
});

test("an expired code is dead even though it matches", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("x".repeat(12)));
  await db.query(`UPDATE pending_signups SET expires_at = extract(epoch from now())::int - 1 WHERE email = ?`).run(email);

  expect(await confirmSignup(email, code)).toEqual({ ok: false, error: "that code expired: create the account again", restart: true });
  expect(await findUserByEmail(email)).toBeNull();
});

test("an unknown address or empty code confirms nothing", async () => {
  expect(await confirmSignup(freshEmail(), "123456")).toMatchObject({ ok: false, restart: true });
  const email = freshEmail();
  await startSignup(email, await hashPassword("x".repeat(12)));
  expect((await confirmSignup(email, "")).ok).toBe(false);
  // A SQL metacharacter is a value, not syntax: parameters are bound, never spliced.
  expect((await confirmSignup(email, "' OR 1=1 --")).ok).toBe(false);
  expect(await findUserByEmail(email)).toBeNull();
});

test("signing up again reissues a code, invalidates the old one, and resets attempts", async () => {
  const email = freshEmail();
  const first = await startSignup(email, await hashPassword("first pass ok"));
  // Burn attempts on the first code so the reset is observable.
  for (let i = 0; i < 4; i++) await confirmSignup(email, wrongCode(first));

  const second = await startSignup(email, await hashPassword("second pass ok"));
  // This is also the "send it again" path, so the stale code must be dead...
  expect((await confirmSignup(email, first)).ok).toBe(false);
  // ...and that miss must be attempt 1 of 5, not the last one before discard.
  const res = await confirmSignup(email, wrongCode(second));
  expect(res.ok === false && res.error).toContain("3 attempts left");

  expect((await confirmSignup(email, second)).ok).toBe(true);
  // The password from the LATEST attempt is the one that counts.
  const user = await findUserByEmail(email);
  expect(await verifyPassword("second pass ok", user!.password_hash)).toBe(true);
});

test("a failed send leaves nothing behind to strand the signup", async () => {
  const email = freshEmail();
  const code = await startSignup(email, await hashPassword("x".repeat(12)));
  await discardSignup(email); // what the route does when sendEmail() returns false

  expect(await pendingSignupExists(email)).toBe(false);
  expect((await confirmSignup(email, code)).ok).toBe(false);
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

test("the email carries the code in the subject and both bodies", async () => {
  const mail = verificationEmail("482913");
  expect(mail.subject).toContain("482913");
  expect(mail.text).toContain("482913");
  expect(mail.html).toContain("482913");
  // Selectable text, not an image: image blocking is on by default in Outlook
  // and Gmail, and an unreadable code is a dead signup.
  expect(mail.html).not.toMatch(/<img/i);
  // Responsive essentials, since an email template silently losing these is
  // exactly the kind of regression nothing else here would catch.
  expect(mail.html).toContain("width=device-width");
  expect(mail.html).toContain("max-width:560px");
  expect(mail.html).toContain("@media only screen and (max-width: 480px)");
});
