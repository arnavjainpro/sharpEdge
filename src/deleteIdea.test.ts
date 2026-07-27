import { expect, test, afterAll } from "bun:test";
import { db, deleteIdea } from "./db";
import { createUser, hashPassword } from "./auth";

// SHARP-25 shipped with `UPDATE outcomes ...` in deleteIdea. The real table is
// `trade_outcomes`, so every delete threw and "delete a past analysis" silently
// never worked — typecheck can't see inside a SQL string, and no test had ever
// run the function against a database.
//
// So this exercises the real query path, including the two foreign keys that
// are the whole reason the function is more than one statement.
//
// NOTE: writes to the configured database; throwaway rows, cleaned up after.

const made: number[] = [];
async function throwawayUser(): Promise<number> {
  const id = await createUser(`delidea-test-${crypto.randomUUID()}@example.invalid`, await hashPassword("x"));
  made.push(id);
  return id;
}

async function makeIdea(userId: number, ticker = "NVDA"): Promise<number> {
  const row = await db.query(
    `INSERT INTO ideas (ts, ticker, direction, rating, confidence, source, report, user_id)
     VALUES (extract(epoch from now())::int, ?, 'long', 'setup', 'high', 'validate', '{}', ?) RETURNING id`
  ).get<{ id: number }>(ticker, userId);
  return row!.id;
}

afterAll(async () => {
  for (const id of made) {
    await db.query(`DELETE FROM trade_outcomes WHERE user_id = ?`).run(id);
    await db.query(`DELETE FROM tracked_trades WHERE user_id = ?`).run(id);
    await db.query(`DELETE FROM ideas WHERE user_id = ?`).run(id);
    await db.query(`DELETE FROM users WHERE id = ?`).run(id);
  }
});

test("deleting a plain idea works and is idempotent", async () => {
  const u = await throwawayUser();
  const id = await makeIdea(u);

  expect(await deleteIdea(u, id)).toBe(true);
  expect(await db.query(`SELECT id FROM ideas WHERE id = ?`).get(id)).toBeNull();
  // Second call finds nothing — a double-click must not throw.
  expect(await deleteIdea(u, id)).toBe(false);
});

test("a journalled idea deletes, and the journal entry survives without it", async () => {
  const u = await throwawayUser();
  const id = await makeIdea(u, "AAPL");
  await db.query(
    `INSERT INTO trade_outcomes (user_id, ticker, direction, idea_id, outcome, closed_at, created_at)
     VALUES (?, 'AAPL', 'long', ?, 'win', extract(epoch from now())::int, extract(epoch from now())::int)`
  ).run(u, id);

  // This is the call that used to throw on the missing table.
  expect(await deleteIdea(u, id)).toBe(true);

  const outcome = await db.query(`SELECT idea_id, outcome FROM trade_outcomes WHERE user_id = ?`).get(u) as any;
  expect(outcome).not.toBeNull();     // the trade record is history, it stays
  expect(outcome.idea_id).toBeNull(); // only the link to the deleted idea goes
});

test("a tracked trade is detached rather than blocking the delete", async () => {
  const u = await throwawayUser();
  const id = await makeIdea(u, "TSLA");
  await db.query(
    `INSERT INTO tracked_trades (user_id, ticker, direction, idea_id, opened_at)
     VALUES (?, 'TSLA', 'long', ?, extract(epoch from now())::int)`
  ).run(u, id);

  expect(await deleteIdea(u, id)).toBe(true);
  const tracked = await db.query(`SELECT idea_id FROM tracked_trades WHERE user_id = ?`).get(u) as any;
  expect(tracked).not.toBeNull();
  expect(tracked.idea_id).toBeNull();
});

test("another account's idea is untouched, links and all", async () => {
  const mine = await throwawayUser();
  const theirs = await throwawayUser();
  const id = await makeIdea(theirs, "AMD");
  await db.query(
    `INSERT INTO trade_outcomes (user_id, ticker, direction, idea_id, outcome, closed_at, created_at)
     VALUES (?, 'AMD', 'long', ?, 'loss', extract(epoch from now())::int, extract(epoch from now())::int)`
  ).run(theirs, id);

  expect(await deleteIdea(mine, id)).toBe(false);
  expect(await db.query(`SELECT id FROM ideas WHERE id = ?`).get(id)).not.toBeNull();
  // Ownership is checked BEFORE anything is detached — a failed delete must not
  // strip the journal link on the way to matching nothing.
  const outcome = await db.query(`SELECT idea_id FROM trade_outcomes WHERE user_id = ?`).get(theirs) as any;
  expect(outcome.idea_id).toBe(id);
});
