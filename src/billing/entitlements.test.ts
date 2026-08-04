import { expect, test, afterAll } from "bun:test";
import { db } from "../db";
import { createUser, hashPassword } from "../auth";
import {
  planFor, checkProFeature, checkMetered, meter, usageThisPeriod,
  entitlementsFor, upgradePayload, currentPeriod, FREE_LIMITS, FREE_WATCHLIST_MAX, PRO_PRICE_USD,
} from "./entitlements";

// Exercises the freemium chokepoint against the real database, using throwaway
// @example.invalid accounts that are deleted afterwards. The one thing that
// truly matters here: a fresh account is 'free', and the ceilings actually bite
//: a gate that silently passes gives the paid product away.

const userIds: number[] = [];
async function freshUser(): Promise<number> {
  const email = `entitlements-test-${crypto.randomUUID()}@example.invalid`;
  const id = await createUser(email, await hashPassword("x".repeat(12)));
  userIds.push(id);
  return id;
}

// One statement per table over the whole set: the suite runs against remote
// Postgres and a cleanup that overruns the hook budget strands throwaway rows.
afterAll(async () => {
  if (!userIds.length) return;
  const ph = userIds.map(() => "?").join(",");
  await db.query(`DELETE FROM usage_counters WHERE user_id IN (${ph})`).run(...userIds);
  await db.query(`DELETE FROM billing_interest WHERE user_id IN (${ph})`).run(...userIds);
  await db.query(`DELETE FROM sessions WHERE user_id IN (${ph})`).run(...userIds);
  await db.query(`DELETE FROM users WHERE id IN (${ph})`).run(...userIds);
}, 60_000);

test("a fresh account is on the free plan: nobody is silently granted Pro", async () => {
  const id = await freshUser();
  expect(await planFor(id)).toBe("free");
});

test("free accounts are refused Pro-only features with a pro_only reason", async () => {
  const id = await freshUser();
  const gate = await checkProFeature(id, "chat_advisor");
  expect(gate.ok).toBe(false);
  expect(gate.reason).toBe("pro_only");
  expect(gate.feature).toBe("chat_advisor");
});

test("metered features pass until the monthly ceiling, then bite", async () => {
  const id = await freshUser();
  // Fresh account: full allowance available.
  expect((await checkMetered(id, "ai_validation")).ok).toBe(true);

  // Consume exactly the ceiling.
  for (let i = 0; i < FREE_LIMITS.ai_validation; i++) await meter(id, "ai_validation");
  expect(await usageThisPeriod(id, "ai_validation")).toBe(FREE_LIMITS.ai_validation);

  // The next check is refused with the numbers the paywall needs.
  const gate = await checkMetered(id, "ai_validation");
  expect(gate.ok).toBe(false);
  expect(gate.reason).toBe("limit_reached");
  expect(gate.limit).toBe(FREE_LIMITS.ai_validation);
  expect(gate.used).toBe(FREE_LIMITS.ai_validation);
});

test("metering one feature does not spend another's allowance", async () => {
  const id = await freshUser();
  await meter(id, "backtest"); // one backtest used
  expect(await usageThisPeriod(id, "backtest")).toBe(1);
  // ai_validation is untouched: separate counter.
  expect(await usageThisPeriod(id, "ai_validation")).toBe(0);
  expect((await checkMetered(id, "ai_validation")).ok).toBe(true);
});

test("Pro lifts every ceiling and never meters", async () => {
  const id = await freshUser();
  await db.query(`UPDATE users SET plan = 'pro' WHERE id = ?`).run(id);
  expect(await planFor(id)).toBe("pro");

  // Pro-only feature now allowed.
  expect((await checkProFeature(id, "chat_advisor")).ok).toBe(true);

  // Metered feature is unlimited, and meter() is a no-op: no row written.
  for (let i = 0; i < FREE_LIMITS.ai_validation + 5; i++) {
    expect((await checkMetered(id, "ai_validation")).ok).toBe(true);
    await meter(id, "ai_validation");
  }
  expect(await usageThisPeriod(id, "ai_validation")).toBe(0);
});

test("entitlementsFor reflects free usage, then unlimited on Pro", async () => {
  const id = await freshUser();
  await meter(id, "ai_validation");

  const free = await entitlementsFor(id);
  expect(free.plan).toBe("free");
  expect(free.price).toBe(PRO_PRICE_USD);
  expect(free.limits.watchlist).toBe(FREE_WATCHLIST_MAX);
  expect(free.limits.ai_validation).toBe(FREE_LIMITS.ai_validation);
  expect(free.used.ai_validation).toBe(1);

  await db.query(`UPDATE users SET plan = 'pro' WHERE id = ?`).run(id);
  const pro = await entitlementsFor(id);
  expect(pro.plan).toBe("pro");
  // null limits mean unlimited.
  expect(pro.limits.watchlist).toBeNull();
  expect(pro.limits.ai_validation).toBeNull();
  expect(pro.limits.backtest).toBeNull();
});

test("upgradePayload carries a machine-readable upgrade block", () => {
  const body = upgradePayload({ ok: false, reason: "limit_reached", feature: "backtest", limit: 1, used: 1 });
  expect(body.ok).toBe(false);
  expect(body.error).toBe("upgrade_required");
  expect(body.upgrade).toEqual({ reason: "limit_reached", feature: "backtest", limit: 1, used: 1, price: PRO_PRICE_USD });
});

test("currentPeriod is a stable YYYY-MM bucket", () => {
  expect(currentPeriod(new Date("2026-07-31T23:59:59Z"))).toBe("2026-07");
  expect(currentPeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
});
