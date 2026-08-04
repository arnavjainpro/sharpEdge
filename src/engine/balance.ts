// The portfolio balance curve, at real daily resolution.
//
// This replaces summing each holding's screener `spark`, which is 30 samples
// across a 90-session window (SPARK_POINTS/SPARK_WINDOW) — one point per ~3
// trading days, so a 1-month view drew about seven vertices and the curve was
// visibly made of straight segments. Raising SPARK_POINTS instead would have
// fixed it for seven tickers by tripling a /api/screener payload that carries
// the whole ~1,500-row table and is re-polled every ten minutes.
//
// Same caveat as before: this prices the shares you hold TODAY back through
// history. It ignores earlier buys, sells, deposits, dividends and closed
// positions, so it is a holdings curve, not an account balance.

import { fetchDailyCandlesBulk } from "../ingest/candles";
import { holdingSymbol, type Portfolio } from "../config";

export interface BalanceSeries {
  values: number[];
  timestamps: number[];
  /** Holdings with no usable price history — options, crypto, dead symbols. */
  skipped: string[];
}

export interface Leg {
  shares: number;
  ts: number[];      // oldest → newest
  closes: number[];
}

/**
 * Sum legs onto one session calendar.
 *
 * Pure and exported so the alignment is testable without a network round trip —
 * it is the part that can be subtly wrong while still producing a plausible
 * curve, which is the worst failure mode for a chart of someone's money.
 */
export function alignAndSum(legs: Leg[]): { values: number[]; timestamps: number[] } {
  const usable = legs.filter((l) => l.ts.length && l.ts.length === l.closes.length);
  if (!usable.length) return { values: [], timestamps: [] };

  // Start where EVERY leg already has a price. A leg that begins mid-window
  // would otherwise blink into the total on its first bar and read as a gain
  // the portfolio never made.
  const start = Math.max(...usable.map((l) => l.ts[0]!));
  const calendar = [...new Set(usable.flatMap((l) => l.ts))]
    .filter((t) => t >= start)
    .sort((a, b) => a - b);

  // One forward-only cursor per leg: the calendar ascends, so the whole walk is
  // O(sessions + bars) rather than a lookup per cell.
  const cursor = usable.map(() => 0);
  const values: number[] = [];
  const timestamps: number[] = [];

  for (const t of calendar) {
    let sum = 0;
    for (let i = 0; i < usable.length; i++) {
      const l = usable[i]!;
      while (cursor[i]! + 1 < l.ts.length && l.ts[cursor[i]! + 1]! <= t) cursor[i]!++;
      // Forward-fill: a leg that did not print this session (halt, or two venues
      // disagreeing about a holiday) holds its last close. Dropping it from the
      // sum instead would draw a one-day crash that never happened.
      sum += l.shares * l.closes[cursor[i]!]!;
    }
    values.push(Number(sum.toFixed(2)));
    timestamps.push(t);
  }
  return { values, timestamps };
}

// Keyed on the holdings themselves, so adding a share busts it immediately
// rather than serving a curve that disagrees with the position list beside it.
const cache = new Map<string, { at: number; data: BalanceSeries }>();
const TTL_MS = 15 * 60_000;

export async function portfolioSeries(
  userId: number,
  pf: Portfolio,
  range = "1y"
): Promise<BalanceSeries> {
  // Options are excluded, not priced off their underlying: contracts x underlying
  // close is not what the position is worth, and a wrong number drawn confidently
  // is worse than a holding left out.
  const equities = pf.holdings.filter((h) => (h.asset_class ?? "equity") !== "option" && h.shares);
  const legs: { sym: string; shares: number }[] = [];
  const skipped: string[] = [];
  for (const h of equities) {
    const sym = holdingSymbol(h);
    if (sym) legs.push({ sym, shares: h.shares });
    else skipped.push(h.ticker);
  }
  for (const h of pf.holdings) if ((h.asset_class ?? "equity") === "option") skipped.push(h.ticker);

  const key = `${userId}:${range}:${legs.map((l) => `${l.sym}:${l.shares}`).sort().join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  if (!legs.length) return { values: [], timestamps: [], skipped };

  // Bulk (Yahoo) rather than fetchDailyCandles: no key, no quota, and this runs
  // on every portfolio open. Parallel is fine at portfolio size — this is a
  // handful of symbols, not the 3,100-name scan the sequential path exists for.
  const fetched = await Promise.all(
    legs.map(async (l) => {
      try {
        const c = await fetchDailyCandlesBulk(l.sym, range, 2);
        return c && c.closes.length > 1 ? { shares: l.shares, ts: c.timestamps, closes: c.closes } : null;
      } catch {
        return null;
      }
    })
  );
  fetched.forEach((c, i) => { if (!c) skipped.push(legs[i]!.sym); });

  const data: BalanceSeries = { ...alignAndSum(fetched.filter((c): c is Leg => !!c)), skipped };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Self-check (bun run src/engine/balance.ts): the alignment is the money path.
if (import.meta.main) {
  const eq = (a: unknown, b: unknown, msg: string) => {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y) throw new Error(`${msg}\n  got      ${x}\n  expected ${y}`);
  };
  const D = 86400, t0 = 1_700_000_000;

  // Two legs on the same calendar: plain weighted sum.
  eq(
    alignAndSum([
      { shares: 2, ts: [t0, t0 + D], closes: [10, 11] },
      { shares: 3, ts: [t0, t0 + D], closes: [100, 90] },
    ]).values,
    [320, 292],
    "same-calendar legs sum by share count"
  );

  // A leg that starts late must not blink into the total: the series begins at
  // the later start, so both legs are present in every printed point.
  eq(
    alignAndSum([
      { shares: 1, ts: [t0, t0 + D, t0 + 2 * D], closes: [10, 20, 30] },
      { shares: 1, ts: [t0 + D, t0 + 2 * D], closes: [5, 6] },
    ]),
    { values: [25, 36], timestamps: [t0 + D, t0 + 2 * D] },
    "series starts where every leg has a price"
  );

  // A leg missing a session holds its last close instead of dropping to zero.
  eq(
    alignAndSum([
      { shares: 1, ts: [t0, t0 + D, t0 + 2 * D], closes: [10, 20, 30] },
      { shares: 1, ts: [t0, t0 + 2 * D], closes: [100, 200] },
    ]).values,
    [110, 120, 230],
    "a leg with no bar that session forward-fills"
  );

  eq(alignAndSum([]), { values: [], timestamps: [] }, "no legs → empty series");
  eq(
    alignAndSum([{ shares: 1, ts: [t0], closes: [1, 2] }]),
    { values: [], timestamps: [] },
    "mismatched ts/closes lengths are dropped, not summed off-by-one"
  );

  console.log("balance.ts self-check passed");
}
