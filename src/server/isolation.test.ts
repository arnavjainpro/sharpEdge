import { expect, test, afterAll } from "bun:test";
import { db, insertEvent, insertSignal, setTriageFor } from "../db";
import { createUser, hashPassword } from "../auth";
import { advisorEvents, advisorBriefing } from "../ai/advisor";
import {
  practiceStats, resetPractice, INTERVAL, VISIBLE, HORIZON, GRADING_VERSION,
} from "../engine/practice";

// The security claim of SHARP-29: fanning monitoring out to every account must
// not let one account see another's reading of the market. Three things are
// per-account: the severity a shared event got, the signal written from it,
// and the handful of events that are private by nature: and this pins the
// exact query /api/state uses to enforce that.
//
// NOTE: writes to the configured database, using throwaway @example.invalid
// accounts that are deleted afterwards.

// Every row this file creates is tagged so cleanup can find it. Events need the
// prefix rather than a user_id: the public ones are deliberately unowned, so
// deleting by owner would leave them behind in the live Activity feed.
const TAG = "fanout-test:";
const made: number[] = [];
async function throwawayUser(): Promise<number> {
  const id = await createUser(`fanout-test-${crypto.randomUUID()}@example.invalid`, await hashPassword("x"));
  made.push(id);
  return id;
}
const testEvent = (ticker: string, kind: string, title: string, userId?: number) =>
  insertEvent({ ts: Math.floor(Date.now() / 1000), ticker, kind, title, dedupeKey: `${TAG}${crypto.randomUUID()}`, userId });

// Exactly the /api/state projection: global events, this user's triage, this
// user's signal, private events filtered to their owner.
const stateEvents = (userId: number) => db.query(
  `SELECT e.id, e.ticker, e.kind,
          COALESCE(t.severity, e.severity) AS severity,
          s.action, s.thesis
   FROM events e
   LEFT JOIN event_triage t ON t.event_id = e.id AND t.user_id = ?
   LEFT JOIN signals s ON s.event_id = e.id AND s.user_id = ?
   WHERE e.user_id IS NULL OR e.user_id = ?
   ORDER BY e.ts DESC LIMIT 100`
).all(userId, userId, userId) as Promise<any[]>;

// Order matters: event_triage and signals reference both users and events, so
// they go first, then the events, then the accounts.
//
// One statement per table, not one per row. This runs against a remote Postgres,
// and the original per-id loop cost two round trips per event plus five per
// throwaway account: past a dozen accounts that overran the 5s hook budget, the
// hook was killed half-done, and the accounts it had not reached yet stayed in
// the live database. They are not inert there: the running app treats every row
// in `users` as a real account, so it kept fetching broker snapshots and paying
// to triage events for each one. 74 of them had accumulated before this was
// caught. The generous timeout is a second belt: a slow cleanup must fail loudly
// rather than silently leave accounts behind.
afterAll(async () => {
  const tagged = `${TAG}%`;
  await db.query(`DELETE FROM event_triage WHERE event_id IN (SELECT id FROM events WHERE dedupe_key LIKE ?)`).run(tagged);
  await db.query(`DELETE FROM signals WHERE event_id IN (SELECT id FROM events WHERE dedupe_key LIKE ?)`).run(tagged);
  await db.query(`DELETE FROM events WHERE dedupe_key LIKE ?`).run(tagged);
  if (!made.length) return;
  // Ints straight from createUser, never user input: safe to inline, and it
  // keeps this to one statement per table instead of one per account.
  const ids = `(${made.map((n) => Number(n)).filter(Number.isInteger).join(",")})`;
  // event_triage/signals again: a throwaway account can own rows against events
  // this file never tagged, and those FKs would block the DELETE below.
  for (const t of ["event_triage", "signals", "briefings", "practice_attempts", "settings", "broker_snapshots", "sessions"]) {
    await db.query(`DELETE FROM ${t} WHERE user_id IN ${ids}`).run();
  }
  await db.query(`DELETE FROM events WHERE user_id IN ${ids}`).run();
  await db.query(`DELETE FROM users WHERE id IN ${ids}`).run();
}, 60_000);

// ── SHARP-32: resetting a practice record is scoped to one account ────────────
// Reset archives rather than deletes, but it still has to be per-account: one
// trader clearing their record must never blank someone else's. A leak here is
// silent: the other account just quietly shows zero drills.

const gradedDrill = (userId: number, ts: number) => db.query(
  `INSERT INTO practice_attempts
     (user_id, ts, ticker, as_of_ts, horizon, status, direction, outcome, r_multiple,
      process_score, interval, visible_bars, grading_version)
   VALUES (?, ?, 'TEST', ?, ?, 'graded', 'long', 'win', 1.5, 80, ?, ?, ?)`
).run(userId, ts, ts, HORIZON, INTERVAL, VISIBLE, GRADING_VERSION);

test("resetting one account's practice record leaves another account's intact", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const now = Math.floor(Date.now() / 1000);
  for (const u of [a, b]) for (let i = 0; i < 6; i++) await gradedDrill(u, now - 600 + i);

  expect((await practiceStats(a)).attempts).toBe(6);
  expect((await practiceStats(b)).attempts).toBe(6);

  await resetPractice(a);

  expect((await practiceStats(a)).attempts).toBe(0);   // A starts fresh
  expect((await practiceStats(b)).attempts).toBe(6);   // B is untouched
});

test("reset archives rather than destroys: the drills are still on record", async () => {
  const a = await throwawayUser();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 4; i++) await gradedDrill(a, now - 600 + i);

  const { archived } = await resetPractice(a);
  expect(archived).toBe(4);

  // Stats stop counting them, but nothing was deleted.
  expect((await practiceStats(a)).attempts).toBe(0);
  const rows = await db.query(`SELECT count(*)::int AS n FROM practice_attempts WHERE user_id = ?`)
    .get(a) as { n: number };
  expect(rows.n).toBe(4);
});

test("drills taken after a reset count again", async () => {
  const a = await throwawayUser();
  const now = Math.floor(Date.now() / 1000);
  await gradedDrill(a, now - 600);
  await resetPractice(a);
  expect((await practiceStats(a)).attempts).toBe(0);

  await gradedDrill(a, Math.floor(Date.now() / 1000) + 5);
  expect((await practiceStats(a)).attempts).toBe(1);
});

// ── SHARP-32: stats never blend one kind of drill with another ────────────────
test("legacy daily drills are kept but never averaged into the intraday record", async () => {
  const a = await throwawayUser();
  const now = Math.floor(Date.now() / 1000);
  // Three drills posed the old way: daily bars, 120-bar read, 40-bar horizon, v1.
  for (let i = 0; i < 3; i++) {
    await db.query(
      `INSERT INTO practice_attempts
         (user_id, ts, ticker, as_of_ts, horizon, status, direction, outcome, r_multiple,
          process_score, interval, visible_bars, grading_version)
       VALUES (?, ?, 'OLD', ?, 40, 'graded', 'long', 'win', 3.0, 95, '1d', 120, 1)`
    ).run(a, now - 900 + i, now - 900 + i);
  }
  await gradedDrill(a, now - 300);   // one current-cohort drill

  const s = await practiceStats(a);
  expect(s.attempts).toBe(1);        // only the intraday one counts

  // The daily rows are still there: history is preserved, not relabelled.
  const kept = await db.query(
    `SELECT count(*)::int AS n FROM practice_attempts WHERE user_id = ? AND interval = '1d'`
  ).get(a) as { n: number };
  expect(kept.n).toBe(3);
});

test("one shared event, two accounts, two different readings", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  // A public market event: one row, detected once.
  const eventId = (await testEvent("NVDA", "price_move", "NVDA test move"))!;
  expect(eventId).toBeNumber();

  // A holds it, B doesn't: so the same event is critical to one and info to the other.
  await setTriageFor(eventId, a, "critical", "you hold 300 shares");
  await setTriageFor(eventId, b, "info", "not held");

  const seenByA = (await stateEvents(a)).find((r) => r.id === eventId);
  const seenByB = (await stateEvents(b)).find((r) => r.id === eventId);
  expect(seenByA.severity).toBe("critical");
  expect(seenByB.severity).toBe("info");
});

test("a signal is only ever attached for the account it was written for", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const eventId = (await testEvent("AAPL", "news", "AAPL test headline"))!;
  await insertSignal({
    event_id: eventId, user_id: a, ticker: "AAPL", action: "trim", conviction: "high",
    plain_headline: "Trim AAPL", thesis: "your 400 shares are 22% of the book",
    invalidation: "n/a", portfolio_impact: "n/a",
  });

  const forA = (await stateEvents(a)).find((r) => r.id === eventId);
  const forB = (await stateEvents(b)).find((r) => r.id === eventId);
  // Both see the event: it's public market fact.
  expect(forA).toBeDefined();
  expect(forB).toBeDefined();
  // Only A sees the advice, which names A's position size.
  expect(forA.action).toBe("trim");
  expect(forB.action).toBeNull();
});

test("a private event never reaches another account", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  // "You closed NVDA: journal it?" is a fact about A's account, not the market.
  const eventId = (await testEvent("NVDA", "position_close", "Closed NVDA (long) ~+12%: journal it?", a))!;

  expect((await stateEvents(a)).some((r) => r.id === eventId)).toBe(true);
  expect((await stateEvents(b)).some((r) => r.id === eventId)).toBe(false);
});

test("re-triage corrects rather than duplicating", async () => {
  const a = await throwawayUser();
  const eventId = (await testEvent("AMD", "news", "AMD test headline"))!;
  await setTriageFor(eventId, a, "info", "first pass");
  await setTriageFor(eventId, a, "high", "second pass");

  const rows = await db.query(`SELECT severity FROM event_triage WHERE event_id = ? AND user_id = ?`).all(eventId, a) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].severity).toBe("high");
});

// ── The AI advisor's chat context is account-scoped ───────────────────────────
// /api/state was always scoped correctly; the advisor's context builder was a
// second, older copy of the same projection that never got the fan-out
// treatment. It read the global events.severity column, joined signals with no
// owner predicate, and took the newest briefing on the instance: so every
// account's chat prompt carried whichever other account had most recently been
// analysed. These pin the real exported queries, not a restatement of the SQL.

test("the advisor sees its own account's triage severity, not another's", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const since = Math.floor(Date.now() / 1000) - 3600;
  // One shared, public market event. A considers it critical; B shrugs.
  const eventId = (await testEvent("AMD", "news", "AMD test headline"))!;
  await setTriageFor(eventId, a, "critical", "A cares");
  await setTriageFor(eventId, b, "info", "B does not");

  expect((await advisorEvents(a, since)).some((r) => r.title === "AMD test headline")).toBe(true);
  // B rated it info, so it must fall below B's critical/high cut: even though
  // A's triage is the one sitting in the shared events.severity column.
  expect((await advisorEvents(b, since)).some((r) => r.title === "AMD test headline")).toBe(false);
});

test("the advisor never quotes another account's signal", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const since = Math.floor(Date.now() / 1000) - 3600;
  const eventId = (await testEvent("AMD", "news", "AMD shared headline"))!;
  for (const u of [a, b]) await setTriageFor(eventId, u, "high", "both care");
  await insertSignal({
    event_id: eventId, user_id: a, ticker: "AMD", action: "buy", conviction: "high",
    plain_headline: "A's call", thesis: "A_PRIVATE_THESIS", invalidation: "", portfolio_impact: "",
  });

  const forA = (await advisorEvents(a, since)).find((r) => r.title === "AMD shared headline");
  const forB = (await advisorEvents(b, since)).find((r) => r.title === "AMD shared headline");
  expect(forA?.thesis).toBe("A_PRIVATE_THESIS");
  // B sees the public event, but none of A's reasoning attached to it.
  expect(forB).toBeTruthy();
  expect(forB?.thesis).toBeNull();
  expect(forB?.action).toBeNull();
});

test("a private event stays out of the advisor context too", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const since = Math.floor(Date.now() / 1000) - 3600;
  const eventId = (await testEvent("NVDA", "position_close", "Closed NVDA: journal it?", a))!;
  await setTriageFor(eventId, a, "high", "A's position");
  await setTriageFor(eventId, b, "high", "B should still never see it");

  expect((await advisorEvents(a, since)).some((r) => r.title === "Closed NVDA: journal it?")).toBe(true);
  expect((await advisorEvents(b, since)).some((r) => r.title === "Closed NVDA: journal it?")).toBe(false);
});

test("the advisor reads its own account's briefing, or none at all", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const now = Math.floor(Date.now() / 1000);
  await db.query(`INSERT INTO briefings (user_id, ts, kind, content) VALUES (?, ?, 'close', ?)`)
    .run(a, now, "A_PRIVATE_BRIEFING");

  expect((await advisorBriefing(a))?.content).toBe("A_PRIVATE_BRIEFING");
  // B has no briefing of their own: the right answer is nothing, not A's.
  expect(await advisorBriefing(b)).toBeNull();
});
