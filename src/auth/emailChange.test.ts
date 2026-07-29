import { expect, test, afterAll } from "bun:test";
import { db } from "../db";
import {
  hashPassword, createUser, findUserByEmail,
  startEmailChange, confirmEmailChange, cancelEmailChange, getPendingEmail,
} from "./index";

// Mirrors signup.test.ts's threat model: an unconfirmed address must never
// become the login. Here the failure mode is different — the account already
// exists, so a bad confirm can't create a phantom row, but it CAN move a real
// account's sign-in to an address the attacker doesn't actually control.
//
// NOTE: writes to the configured database, using @example.invalid addresses
// that are deleted afterwards — the only other test file that writes besides
// signup.test.ts, deleteIdea.test.ts, heatmap.test.ts and isolation.test.ts.

const emails: string[] = [];
const userIds: number[] = [];
const freshUser = async (email: string) => {
  emails.push(email);
  const id = await createUser(email, await hashPassword("x".repeat(12)));
  userIds.push(id);
  return id;
};
const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

// Batched for the same reason as the other DB-writing suites: a per-row cleanup
// loop against a remote Postgres can overrun the hook budget, and a half-done
// cleanup leaves live accounts behind.
afterAll(async () => {
  if (!userIds.length) return;
  const ids = `(${userIds.map((n) => Number(n)).filter(Number.isInteger).join(",")})`;
  await db.query(`DELETE FROM sessions WHERE user_id IN ${ids}`).run();
  await db.query(`DELETE FROM users WHERE id IN ${ids}`).run();
}, 60_000);

test("staging a change does not move the login", async () => {
  const id = await freshUser(`emailchange-${crypto.randomUUID()}@example.invalid`);
  const newAddr = `emailchange-new-${crypto.randomUUID()}@example.invalid`;
  emails.push(newAddr);
  const code = await startEmailChange(id, newAddr);

  expect(code).toMatch(/^[0-9]{6}$/);
  expect(await getPendingEmail(id)).toBe(newAddr);
  // The critical assertion: the account still signs in with the OLD address
  // until the code comes back — a typo or a hijacked session can't strand it.
  const user = await db.query(`SELECT email FROM users WHERE id = ?`).get<{ email: string }>(id);
  expect(user!.email).not.toBe(newAddr);
});

test("the right code moves the login and clears the pending state", async () => {
  const id = await freshUser(`emailchange-${crypto.randomUUID()}@example.invalid`);
  const newAddr = `emailchange-new-${crypto.randomUUID()}@example.invalid`;
  emails.push(newAddr);
  const code = await startEmailChange(id, newAddr);

  const res = await confirmEmailChange(id, code);
  expect(res).toEqual({ ok: true, email: newAddr });

  const user = await db.query(`SELECT email FROM users WHERE id = ?`).get<{ email: string }>(id);
  expect(user!.email).toBe(newAddr);
  expect(await getPendingEmail(id)).toBeNull();
});

test("concurrent submits of the same code apply exactly once", async () => {
  const id = await freshUser(`emailchange-${crypto.randomUUID()}@example.invalid`);
  const newAddr = `emailchange-new-${crypto.randomUUID()}@example.invalid`;
  emails.push(newAddr);
  const code = await startEmailChange(id, newAddr);

  // Two tabs submitting the same code. The claim is a single atomic UPDATE, so
  // only one can win — the point isn't that a second apply would corrupt
  // anything (both would write the same address), it's that the second must
  // read as "nothing pending", not silently succeed twice.
  const results = await Promise.all([confirmEmailChange(id, code), confirmEmailChange(id, code)]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
});

test("wrong codes are capped, and the fifth discards the change", async () => {
  const id = await freshUser(`emailchange-${crypto.randomUUID()}@example.invalid`);
  const newAddr = `emailchange-new-${crypto.randomUUID()}@example.invalid`;
  const code = await startEmailChange(id, newAddr);
  const wrong = wrongCode(code);

  for (let i = 0; i < 4; i++) {
    const res = await confirmEmailChange(id, wrong);
    expect(res.ok).toBe(false);
    expect(await getPendingEmail(id)).toBe(newAddr);
  }
  expect(await confirmEmailChange(id, wrong)).toEqual({ ok: false, error: "too many wrong codes — start the change again", restart: true });

  // Discarded — the real code is now worthless, and the account never moved.
  expect(await getPendingEmail(id)).toBeNull();
  expect((await confirmEmailChange(id, code)).ok).toBe(false);
  const user = await db.query(`SELECT email FROM users WHERE id = ?`).get<{ email: string }>(id);
  expect(user!.email).not.toBe(newAddr);
});

test("an expired code is dead even though it matches", async () => {
  const id = await freshUser(`emailchange-${crypto.randomUUID()}@example.invalid`);
  const newAddr = `emailchange-new-${crypto.randomUUID()}@example.invalid`;
  const code = await startEmailChange(id, newAddr);
  await db.query(`UPDATE users SET pending_email_expires = extract(epoch from now())::int - 1 WHERE id = ?`).run(id);

  expect(await confirmEmailChange(id, code)).toEqual({ ok: false, error: "that code expired — start the change again", restart: true });
  const user = await db.query(`SELECT email FROM users WHERE id = ?`).get<{ email: string }>(id);
  expect(user!.email).not.toBe(newAddr);
});

test("the address getting claimed elsewhere while staged is refused at confirm", async () => {
  const id = await freshUser(`emailchange-${crypto.randomUUID()}@example.invalid`);
  const contested = `emailchange-contested-${crypto.randomUUID()}@example.invalid`;
  const code = await startEmailChange(id, contested);

  // Someone else's account claims the address after this one was staged but
  // before the code came back. The route's pre-check is advisory (a plain
  // SELECT, done once at stage time); the UNIQUE index at confirm time is
  // what's actually enforced.
  await freshUser(contested);

  const res = await confirmEmailChange(id, code);
  expect(res).toEqual({ ok: false, error: "an account with that email already exists", restart: true });
});

test("cancelling clears the pending change without touching the login", async () => {
  const id = await freshUser(`emailchange-${crypto.randomUUID()}@example.invalid`);
  const newAddr = `emailchange-new-${crypto.randomUUID()}@example.invalid`;
  await startEmailChange(id, newAddr);

  await cancelEmailChange(id);
  expect(await getPendingEmail(id)).toBeNull();
  const user = await db.query(`SELECT email FROM users WHERE id = ?`).get<{ email: string }>(id);
  expect(user!.email).not.toBe(newAddr);
});

test("starting a new change reissues a code, invalidates the old one, and resets attempts", async () => {
  const id = await freshUser(`emailchange-${crypto.randomUUID()}@example.invalid`);
  const firstAddr = `emailchange-first-${crypto.randomUUID()}@example.invalid`;
  const first = await startEmailChange(id, firstAddr);
  // Burn attempts on the first code so the reset is observable.
  for (let i = 0; i < 4; i++) await confirmEmailChange(id, wrongCode(first));

  const secondAddr = `emailchange-second-${crypto.randomUUID()}@example.invalid`;
  emails.push(secondAddr);
  const second = await startEmailChange(id, secondAddr);

  // The stale code — for the address that's no longer even staged — is dead...
  expect((await confirmEmailChange(id, first)).ok).toBe(false);
  // ...and that miss is attempt 1 of 5 against the NEW change, not the last one
  // before discard.
  const res = await confirmEmailChange(id, wrongCode(second));
  expect(res.ok === false && res.error).toContain("3 attempts left");

  expect((await confirmEmailChange(id, second)).ok).toBe(true);
  const user = await db.query(`SELECT email FROM users WHERE id = ?`).get<{ email: string }>(id);
  expect(user!.email).toBe(secondAddr);
});
