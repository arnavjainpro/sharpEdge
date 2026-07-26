import { expect, test } from "bun:test";
import { db } from "../db";
import {
  createUser, hashPassword, findUserById,
  startEmailChange, confirmEmailChange, getPendingEmail, cancelEmailChange,
} from "./index";

// The email-change flow is a security path: the code is the only thing between
// a stranger's inbox and someone's login. The claims worth pinning are that a
// staged address does NOT become the login until the code comes back, that
// wrong guesses are capped, and that an expired code is dead. None of that can
// be checked without the DB, so these run against the configured database and
// clean up after themselves.
//
// NOTE: this creates and deletes throwaway rows in `users`. Addresses use the
// reserved .invalid TLD so they can never collide with a real account.

async function withUser(fn: (id: number) => Promise<void>) {
  const email = `sharpedge-test-${crypto.randomUUID()}@example.invalid`;
  const id = await createUser(email, await hashPassword("irrelevant-for-these-tests"));
  try {
    await fn(id);
  } finally {
    await db.query(`DELETE FROM users WHERE id = ?`).run(id);
  }
}

const freshAddress = () => `moved-${crypto.randomUUID()}@example.invalid`;

test("a staged address is not the login until the code comes back", async () => {
  await withUser(async (id) => {
    const before = (await findUserById(id))!.email;
    const next = freshAddress();
    await startEmailChange(id, next);

    // Staged, visible as pending — and the account still signs in as before.
    expect(await getPendingEmail(id)).toBe(next);
    expect((await findUserById(id))!.email).toBe(before);
  });
});

test("the right code applies the change and clears the pending state", async () => {
  await withUser(async (id) => {
    const next = freshAddress();
    const code = await startEmailChange(id, next);

    const res = await confirmEmailChange(id, code);
    expect(res).toEqual({ ok: true, email: next });
    expect((await findUserById(id))!.email).toBe(next);
    expect(await getPendingEmail(id)).toBeNull();

    // The code is single-use: replaying it finds nothing pending.
    expect(await confirmEmailChange(id, code)).toEqual({ ok: false, error: "no email change is pending" });
  });
});

test("wrong codes are capped, and the fifth throws the change away", async () => {
  await withUser(async (id) => {
    const before = (await findUserById(id))!.email;
    const code = await startEmailChange(id, freshAddress());
    const wrong = code === "000000" ? "111111" : "000000";

    // Four misses: still pending, still counting down.
    for (let i = 0; i < 4; i++) {
      const res = await confirmEmailChange(id, wrong);
      expect(res.ok).toBe(false);
      expect(await getPendingEmail(id)).not.toBeNull();
    }
    // The fifth discards the pending change entirely, so the 6-digit space
    // can't be walked — a guesser has to start over with a fresh code.
    const last = await confirmEmailChange(id, wrong);
    expect(last).toEqual({ ok: false, error: "too many wrong codes — start the change again" });
    expect(await getPendingEmail(id)).toBeNull();
    expect((await findUserById(id))!.email).toBe(before);

    // And the real code is worthless afterwards.
    expect((await confirmEmailChange(id, code)).ok).toBe(false);
  });
});

test("an expired code is dead even when it matches", async () => {
  await withUser(async (id) => {
    const before = (await findUserById(id))!.email;
    const code = await startEmailChange(id, freshAddress());
    await db.query(`UPDATE users SET pending_email_expires = extract(epoch from now())::int - 1 WHERE id = ?`).run(id);

    expect(await confirmEmailChange(id, code)).toEqual({ ok: false, error: "that code expired — start the change again" });
    expect((await findUserById(id))!.email).toBe(before);
    expect(await getPendingEmail(id)).toBeNull();
  });
});

test("an address claimed while staged is refused at confirm time", async () => {
  await withUser(async (mine) => {
    await withUser(async (theirs) => {
      const taken = (await findUserById(theirs))!.email;
      const before = (await findUserById(mine))!.email;
      // Staged before the collision exists as far as this flow is concerned —
      // the advisory pre-check in the route can't cover this, the UNIQUE index does.
      const code = await startEmailChange(mine, taken);

      expect(await confirmEmailChange(mine, code)).toEqual({ ok: false, error: "an account with that email already exists" });
      expect((await findUserById(mine))!.email).toBe(before);
    });
  });
});

test("cancel drops the pending change", async () => {
  await withUser(async (id) => {
    await startEmailChange(id, freshAddress());
    await cancelEmailChange(id);
    expect(await getPendingEmail(id)).toBeNull();
  });
});
