import { expect, test, afterAll } from "bun:test";
import { db, insertEvent, insertSignal, setTriageFor } from "../db";
import { createUser, hashPassword } from "../auth";
import { advisorEvents, advisorBriefing } from "./advisor";

// Every advisor answer is built from these two reads, so an unscoped query here
// serves one account's private analysis to another. They are exported for this
// suite precisely so the assertions run the real SQL: a copy of the query in
// the test would be free to drift out of sync with the app, which is how the
// original defect survived as long as it did.
//
// NOTE: writes to the configured database, using throwaway @example.invalid
// accounts that are deleted afterwards.

const TAG = "advisor-isolation-test:";
const made: number[] = [];

async function throwawayUser(): Promise<number> {
  const id = await createUser(
    `advisor-isolation-${crypto.randomUUID()}@example.invalid`,
    await hashPassword("x")
  );
  made.push(id);
  return id;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const since = () => nowSec() - 72 * 3600;

// Only critical/high events inside the 72h window reach the context at all.
async function loudEvent(ticker: string, kind: string, title: string, userId?: number): Promise<number> {
  const id = await insertEvent({
    ts: nowSec(), ticker, kind, title, dedupeKey: `${TAG}${crypto.randomUUID()}`, userId,
  });
  await db.query(`UPDATE events SET severity = 'critical' WHERE id = ?`).run(id!);
  return id!;
}

// Accounts first: every user_id foreign key cascades from users(id) now (see
// the cascade block in schema.sql), so one statement clears the briefings, the
// per-user triage rows and the owned events. The public events are deliberately
// unowned, so those stay keyed on the dedupe prefix.
//
// Set-based, and with an explicit timeout. The loop-per-row version this
// replaces made dozens of sequential round trips against a 15-connection pool
// and regularly blew bun's 5s default hook timeout: and a hook that dies
// midway has already deleted the children and not the account, which is how
// throwaway accounts ended up stranded in the live database.
afterAll(async () => {
  if (made.length) {
    const holes = made.map(() => "?").join(",");
    await db.query(`DELETE FROM users WHERE id IN (${holes})`).run(...made);
  }
  await db.query(`DELETE FROM event_triage WHERE event_id IN (SELECT id FROM events WHERE dedupe_key LIKE ?)`).run(`${TAG}%`);
  await db.query(`DELETE FROM signals WHERE event_id IN (SELECT id FROM events WHERE dedupe_key LIKE ?)`).run(`${TAG}%`);
  await db.query(`DELETE FROM events WHERE dedupe_key LIKE ?`).run(`${TAG}%`);
}, 30_000);

test("a signal written for one account never reaches another account's advisor context", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const eventId = await loudEvent("AAPL", "news", `${TAG}AAPL headline`);
  await insertSignal({
    event_id: eventId, user_id: a, ticker: "AAPL", action: "trim", conviction: "high",
    plain_headline: "Trim AAPL", thesis: "your 400 shares are 22% of the book",
    invalidation: "n/a", portfolio_impact: "n/a",
  });

  const forA = (await advisorEvents(a, since())).find((r) => r.title === `${TAG}AAPL headline`);
  const forB = (await advisorEvents(b, since())).find((r) => r.title === `${TAG}AAPL headline`);

  // Both see the event: it's public market fact.
  expect(forA).toBeDefined();
  expect(forB).toBeDefined();
  // Only A sees the advice, which names A's position size.
  expect(forA.action).toBe("trim");
  expect(forA.thesis).toContain("400 shares");
  expect(forB.action).toBeNull();
  expect(forB.thesis).toBeNull();
});

test("an event owned by one account never reaches another account's advisor context", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  // position_close titles carry realized P&L verbatim: a fact about A's
  // account, not about the market.
  const title = `${TAG}Closed NVDA (long) ~+12%`;
  await loudEvent("NVDA", "position_close", title, a);

  expect((await advisorEvents(a, since())).some((r) => r.title === title)).toBe(true);
  expect((await advisorEvents(b, since())).some((r) => r.title === title)).toBe(false);
});

test("severity is read from this account's own triage, not another's", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const title = `${TAG}MSFT headline`;
  const eventId = await insertEvent({
    ts: nowSec(), ticker: "MSFT", kind: "news", title, dedupeKey: `${TAG}${crypto.randomUUID()}`,
  });
  // Same public event, opposite readings: critical to the holder, noise to
  // everyone else. Only the holder's copy is loud enough to reach the context.
  await setTriageFor(eventId!, a, "critical", "you hold it");
  await setTriageFor(eventId!, b, "info", "not held");

  expect((await advisorEvents(a, since())).some((r) => r.title === title)).toBe(true);
  expect((await advisorEvents(b, since())).some((r) => r.title === title)).toBe(false);
});

test("a briefing written for one account never reaches another account's advisor context", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const probe = `__leak_probe_${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO briefings (ts, kind, content, user_id) VALUES (?, ?, ?, ?)`
  ).run(nowSec(), "close", `Your book is concentrated. ${probe}`, a);

  expect((await advisorBriefing(a))?.content).toContain(probe);
  // B has no briefing of its own, so it must get nothing: not A's.
  expect(await advisorBriefing(b)).toBeNull();
});
