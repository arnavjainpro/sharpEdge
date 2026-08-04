// Entitlements: the single chokepoint for "is this account allowed to do this".
//
// Two kinds of gate:
//   • Pro-only features (chat advisor, intraday, briefings, journal-that-learns):
//     allowed iff the account is on Pro.
//   • Metered features (AI trade validation, backtest): Pro is unlimited; Free is
//     allowed up to a monthly ceiling, after which the same 402 upgrade path fires.
//
// Contract for the metered path: CHECK before doing the work (so we reject early
// and never spend AI tokens on a request we're going to refuse), then METER after
// the work succeeds (so a failed validation doesn't burn the user's quota). Every
// paid endpoint in server.ts goes through here; adding an AI call site that skips
// it silently gives away the paid product.
import { db } from "../db";

export type Plan = "free" | "pro";

// Free-tier features that are allowed but capped per calendar month. Pro lifts
// the cap entirely. Keyed by the string stored in usage_counters.metric.
export type MeteredFeature = "ai_validation" | "backtest";

// Features that simply require Pro: no free allowance at all.
export type ProFeature =
  | "chat_advisor"
  | "intraday"
  | "briefing"
  | "portfolio_score"
  | "idea_generate";

// Monthly ceilings on the free tier. These are the upgrade triggers: a free user
// hits them by using the product successfully, which is when "upgrade" lands best.
export const FREE_LIMITS: Record<MeteredFeature, number> = {
  ai_validation: 3,
  backtest: 1,
};

// Free accounts can watch up to this many tickers; Pro is unlimited.
export const FREE_WATCHLIST_MAX = 5;

export const PRO_PRICE_USD = 24;

// The result of a gate check. `ok:false` carries enough for the frontend paywall
// to explain exactly why (Pro-only vs ceiling reached) and how far the user got.
export interface Gate {
  ok: boolean;
  reason?: "pro_only" | "limit_reached";
  feature?: string;
  limit?: number;
  used?: number;
}

export async function planFor(userId: number): Promise<Plan> {
  const row = await db.query(`SELECT plan FROM users WHERE id = ?`).get<{ plan: string }>(userId);
  // Anything that isn't exactly 'pro' is treated as free: the safe closed state
  // for a NULL, a legacy row, or a value we don't recognise.
  return row?.plan === "pro" ? "pro" : "free";
}

// Coarse monthly bucket, e.g. "2026-07". UTC rather than ET: the difference is a
// few hours at a month boundary, which does not matter for a usage ceiling, and
// UTC keeps the bucket stable regardless of where the server runs.
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function usageThisPeriod(userId: number, metric: MeteredFeature): Promise<number> {
  const row = await db
    .query(`SELECT count FROM usage_counters WHERE user_id = ? AND metric = ? AND period = ?`)
    .get<{ count: number }>(userId, metric, currentPeriod());
  return row?.count ?? 0;
}

// Pro-only feature gate.
export async function checkProFeature(userId: number, feature: ProFeature): Promise<Gate> {
  const plan = await planFor(userId);
  if (plan === "pro") return { ok: true };
  return { ok: false, reason: "pro_only", feature };
}

// Metered feature gate. Does NOT consume: call meter() after the work succeeds.
export async function checkMetered(userId: number, metric: MeteredFeature): Promise<Gate> {
  const plan = await planFor(userId);
  if (plan === "pro") return { ok: true };
  const used = await usageThisPeriod(userId, metric);
  const limit = FREE_LIMITS[metric];
  if (used >= limit) return { ok: false, reason: "limit_reached", feature: metric, limit, used };
  return { ok: true, used, limit };
}

// Consume one unit of a metered feature for this period. No-op on Pro (unlimited,
// so nothing to meter). Idempotent UPSERT on the (user, metric, period) key.
//
// A free user firing two requests at once can both pass checkMetered() and then
// both meter, landing one over the ceiling. That over-by-one is an accepted
// trade: the alternative (a lock or check-and-increment in one statement) buys
// nothing against a $24 tier, and metering-after-success is the fairer UX.
export async function meter(userId: number, metric: MeteredFeature): Promise<void> {
  const plan = await planFor(userId);
  if (plan === "pro") return;
  await db
    .query(
      `INSERT INTO usage_counters (user_id, metric, period, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (user_id, metric, period) DO UPDATE SET count = usage_counters.count + 1`,
    )
    .run(userId, metric, currentPeriod());
}

// The JSON body served with an HTTP 402 when a gate fails. The frontend paywall
// reads `upgrade` to decide what to say and which CTA to show.
export function upgradePayload(gate: Gate) {
  return {
    ok: false,
    error: "upgrade_required",
    upgrade: {
      reason: gate.reason ?? "pro_only",
      feature: gate.feature ?? null,
      limit: gate.limit ?? null,
      used: gate.used ?? null,
      price: PRO_PRICE_USD,
    },
  };
}

// Everything the dashboard needs to render the account's plan and remaining
// allowance. `null` limits mean unlimited (Pro). Fed into /api/state.
export interface Entitlements {
  plan: Plan;
  price: number;
  limits: { watchlist: number | null; ai_validation: number | null; backtest: number | null };
  used: { ai_validation: number; backtest: number };
}

export async function entitlementsFor(userId: number): Promise<Entitlements> {
  const plan = await planFor(userId);
  if (plan === "pro") {
    return {
      plan,
      price: PRO_PRICE_USD,
      limits: { watchlist: null, ai_validation: null, backtest: null },
      used: { ai_validation: 0, backtest: 0 },
    };
  }
  const [aiUsed, btUsed] = await Promise.all([
    usageThisPeriod(userId, "ai_validation"),
    usageThisPeriod(userId, "backtest"),
  ]);
  return {
    plan,
    price: PRO_PRICE_USD,
    limits: {
      watchlist: FREE_WATCHLIST_MAX,
      ai_validation: FREE_LIMITS.ai_validation,
      backtest: FREE_LIMITS.backtest,
    },
    used: { ai_validation: aiUsed, backtest: btUsed },
  };
}
