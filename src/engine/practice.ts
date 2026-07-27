// Practice drills: a real chart from the past with the future hidden, a plan the
// user commits to, and a grade.
//
// The whole point of this module is that it scores the PLAN separately from the
// OUTCOME. A trader who defines risk properly and takes a correct probabilistic
// loss should read better than one who wins by guessing, and that only works if
// the two numbers are never averaged together. They are returned separately and
// stored in separate columns; keep it that way.
//
// No AI anywhere in here — grading is arithmetic over real bars, so a drill is
// instant, free, and reproducible.

import { db } from "../db";
import { fetchDailyCandles, type DailyCandles } from "../ingest/yahoo";
import { atr } from "./technicals";
import { replayIdea, rMultiple } from "./insights";

export const VISIBLE = 120;   // bars of history the drill shows
export const HORIZON = 40;    // bars revealed when the plan is graded
export const MIN_N = 5;       // stats stay blank under this, matching insights.ts

export type Direction = "long" | "short" | "no_trade";
export type Outcome = "win" | "loss" | "open" | "pass_correct" | "pass_missed";

export interface Plan {
  direction: Direction;
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
}

export interface ProcessDetail {
  criterion: string;
  got: number;
  max: number;
  note: string;
}

export interface ProcessResult {
  score: number;              // 0-100
  detail: ProcessDetail[];
}

// ── process scoring ─────────────────────────────────────────────────────────
// Four criteria, 25 points each, all computable from the plan and the chart the
// user could actually see. Nothing here looks at what happened next.

const CRIT_MAX = 25;

export function scoreProcess(
  plan: Plan,
  ctx: { atr: number; recentLow: number; recentHigh: number; targetRR: number }
): ProcessResult {
  // Declining to trade is a legitimate, complete decision — there is no entry or
  // stop to grade. It scores full process marks, and is kept honest by the
  // outcome side (gradePass) plus the pass-rate stat, not by docking process.
  if (plan.direction === "no_trade") {
    return {
      score: 100,
      detail: [{
        criterion: "Passed on the setup",
        got: CRIT_MAX * 4, max: CRIT_MAX * 4,
        note: "No trade is a complete decision. Graded on whether the pass was right, not on plan quality.",
      }],
    };
  }

  const long = plan.direction === "long";
  const entry = num(plan.entry), stop = num(plan.stop), target = num(plan.target);
  const detail: ProcessDetail[] = [];

  // 1. Risk defined — is there a stop, and is it on the losing side of entry?
  const stopSideOk = entry != null && stop != null && (long ? stop < entry : stop > entry);
  detail.push({
    criterion: "Risk defined",
    got: stopSideOk ? CRIT_MAX : 0,
    max: CRIT_MAX,
    note: stop == null ? "No stop. You cannot size a position you cannot lose a known amount on."
      : !stopSideOk ? `Stop is on the wrong side of entry for a ${plan.direction}.`
        : "Stop set below entry, so the loss is bounded and known before you enter.",
  });

  // 2. Reward:risk — full marks at the trader's target, ramping from 1.0.
  const risk = entry != null && stop != null ? Math.abs(entry - stop) : 0;
  const reward = entry != null && target != null ? (long ? target - entry : entry - target) : 0;
  const rr = risk > 0 && reward > 0 ? reward / risk : 0;
  const floor = 1;
  const span = Math.max(0.01, ctx.targetRR - floor);
  const rrPts = rr <= floor ? 0 : Math.round(Math.min(1, (rr - floor) / span) * CRIT_MAX);
  detail.push({
    criterion: "Reward vs risk",
    got: stopSideOk ? rrPts : 0,
    max: CRIT_MAX,
    note: rr <= 0 ? "Target is not beyond entry, so there is no reward to weigh."
      : `Risking 1 to make ${rr.toFixed(2)}. Your target is ${ctx.targetRR.toFixed(1)}R.`,
  });

  // 3. Stop sanity — distance in ATR. Too tight guarantees a noise stop-out; too
  //    wide is not risk management, it is hoping.
  const stopAtr = risk > 0 && ctx.atr > 0 ? risk / ctx.atr : 0;
  const sane = stopAtr >= 0.5 && stopAtr <= 3;
  detail.push({
    criterion: "Stop distance",
    got: stopSideOk && sane ? CRIT_MAX : 0,
    max: CRIT_MAX,
    note: !stopSideOk || stopAtr === 0 ? "No usable stop distance to judge."
      : stopAtr < 0.5 ? `${stopAtr.toFixed(2)}x ATR — inside the daily noise. This gets hit on a normal day.`
        : stopAtr > 3 ? `${stopAtr.toFixed(2)}x ATR — wide enough that the stop is not really controlling the loss.`
          : `${stopAtr.toFixed(2)}x ATR — outside the noise, still a controlled loss.`,
  });

  // 4. Entry realism — is the fill somewhere price actually traded recently?
  const realistic = entry != null && entry >= ctx.recentLow && entry <= ctx.recentHigh;
  detail.push({
    criterion: "Entry realism",
    got: realistic ? CRIT_MAX : 0,
    max: CRIT_MAX,
    note: entry == null ? "No entry given."
      : realistic ? "Entry sits inside the recent range, so it is a fill you could plausibly get."
        : `Entry is outside the last 20 bars (${fmt(ctx.recentLow)}-${fmt(ctx.recentHigh)}). Price has to come to you.`,
  });

  return { score: detail.reduce((a, d) => a + d.got, 0), detail };
}

// ── pass grading ────────────────────────────────────────────────────────────
// Was declining the right call? Measured ATR-relative so it means the same thing
// on a $4 stock and a $400 one: if price went nowhere over the horizon there was
// no trade to take, and passing was correct.

export function gradePass(
  forward: { closes: number[] },
  atrValue: number
): { outcome: "pass_correct" | "pass_missed"; netAtr: number } {
  if (!forward.closes.length || !(atrValue > 0)) return { outcome: "pass_correct", netAtr: 0 };
  const first = forward.closes[0];
  const last = forward.closes[forward.closes.length - 1];
  const netAtr = Math.abs(last - first) / atrValue;
  return { outcome: netAtr < 1 ? "pass_correct" : "pass_missed", netAtr };
}

// ATR as of a given bar index — slice, then reuse the shared indicator so the
// drill and the screener agree on what volatility means.
export function atrAt(c: DailyCandles, idx: number): number | null {
  const to = idx + 1;
  return atr(c.highs.slice(0, to), c.lows.slice(0, to), c.closes.slice(0, to), 14);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fmt = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(2));

// ── candle cache ────────────────────────────────────────────────────────────
// fetchDailyCandles has no cache of its own and Yahoo 429s under bursts. A drill
// needs the same series twice (once to pose it, once to grade it), so hold it
// briefly. Same spirit as the per-user replayCache in insights.ts.

const CACHE_TTL_MS = 15 * 60_000;
const candleCache = new Map<string, { at: number; candles: DailyCandles | null }>();

async function candlesFor(ticker: string): Promise<DailyCandles | null> {
  const hit = candleCache.get(ticker);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.candles;
  let candles: DailyCandles | null = null;
  try {
    candles = await fetchDailyCandles(ticker, "5y", VISIBLE + HORIZON + 20);
  } catch { candles = null; }
  candleCache.set(ticker, { at: Date.now(), candles });
  return candles;
}

// ── drill lifecycle ─────────────────────────────────────────────────────────

export interface Drill {
  id: number;
  sector: string | null;
  atr: number;
  // Bars up to and including the as-of point. No timestamps: a date is a lookup,
  // and the whole drill rests on the chart being unidentifiable.
  bars: { opens: number[]; highs: number[]; lows: number[]; closes: number[] };
}

export async function createDrill(userId: number): Promise<Drill | { error: string }> {
  // Liquid names only, so the chart is a real tradeable setup rather than a
  // thin ticker whose bars are mostly gaps.
  const pool = await db.query(
    `SELECT ticker, sector FROM universe
     WHERE in_scan = 1 AND market_cap > 1e9
     ORDER BY random() LIMIT 8`
  ).all() as { ticker: string; sector: string | null }[];
  if (!pool.length) return { error: "No scan universe yet — the first screener pass has not run." };

  const need = VISIBLE + HORIZON + 1;
  for (const row of pool) {
    const c = await candlesFor(row.ticker);
    if (!c || c.closes.length < need) continue;

    // As-of must leave VISIBLE bars behind it and HORIZON ahead of it.
    const lo = VISIBLE - 1;
    const hi = c.closes.length - HORIZON - 1;
    if (hi <= lo) continue;
    const asOf = lo + Math.floor(Math.random() * (hi - lo + 1));

    const a = atrAt(c, asOf);
    if (!a || !(a > 0)) continue;

    const from = asOf - VISIBLE + 1;
    const id = (await db.query(
      `INSERT INTO practice_attempts (user_id, ts, ticker, as_of_ts, horizon, status)
       VALUES (?, extract(epoch from now())::int, ?, ?, ?, 'open') RETURNING id`
    ).get(userId, row.ticker, c.timestamps[asOf], HORIZON)) as { id: number };

    return {
      id: id.id,
      sector: row.sector,
      atr: a,
      bars: {
        opens: c.opens.slice(from, asOf + 1),
        highs: c.highs.slice(from, asOf + 1),
        lows: c.lows.slice(from, asOf + 1),
        closes: c.closes.slice(from, asOf + 1),
      },
    };
  }
  return { error: "Could not load a chart right now — the market data source may be rate-limiting. Try again in a moment." };
}

export interface Grade {
  outcome: Outcome;
  rMultiple: number | null;
  process: ProcessResult;
  netAtr: number | null;        // pass drills only
  ticker: string;               // revealed here, never before
  asOfTs: number;
  plan: Plan;
  forward: { timestamps: number[]; opens: number[]; highs: number[]; lows: number[]; closes: number[] };
  history: { timestamps: number[]; opens: number[]; highs: number[]; lows: number[]; closes: number[] };
}

export async function gradeDrill(userId: number, id: number, plan: Plan, targetRR: number): Promise<Grade | { error: string }> {
  const row = await db.query(
    `SELECT id, ticker, as_of_ts, horizon, status FROM practice_attempts WHERE id = ? AND user_id = ?`
  ).get(id, userId) as { id: number; ticker: string; as_of_ts: number; horizon: number; status: string } | null;
  if (!row) return { error: "Drill not found." };
  if (row.status === "graded") return { error: "This drill has already been graded." };

  const c = await candlesFor(row.ticker);
  if (!c) return { error: "Could not reload the chart to grade it. Try again in a moment." };

  const asOf = c.timestamps.indexOf(row.as_of_ts);
  if (asOf < 0) return { error: "The chart data shifted underneath this drill and it can no longer be graded." };

  const a = atrAt(c, asOf);
  if (!a || !(a > 0)) return { error: "Could not compute volatility for this drill." };

  const to = Math.min(c.closes.length, asOf + 1 + row.horizon);
  const slice = (arr: number[]) => arr.slice(asOf + 1, to);
  const forward = {
    timestamps: slice(c.timestamps), opens: slice(c.opens),
    highs: slice(c.highs), lows: slice(c.lows), closes: slice(c.closes),
  };

  const from = Math.max(0, asOf - VISIBLE + 1);
  const hSlice = (arr: number[]) => arr.slice(from, asOf + 1);
  const history = {
    timestamps: hSlice(c.timestamps), opens: hSlice(c.opens),
    highs: hSlice(c.highs), lows: hSlice(c.lows), closes: hSlice(c.closes),
  };

  const win = c.highs.slice(Math.max(0, asOf - 19), asOf + 1);
  const lossW = c.lows.slice(Math.max(0, asOf - 19), asOf + 1);
  const process = scoreProcess(plan, {
    atr: a, recentLow: Math.min(...lossW), recentHigh: Math.max(...win), targetRR,
  });

  let outcome: Outcome;
  let r: number | null = null;
  let netAtr: number | null = null;

  if (plan.direction === "no_trade") {
    const p = gradePass(forward, a);
    outcome = p.outcome;
    netAtr = p.netAtr;
  } else {
    const entry = num(plan.entry), stop = num(plan.stop), target = num(plan.target);
    if (entry == null || stop == null || target == null) return { error: "A trade needs an entry, a stop, and a target." };
    const long = plan.direction === "long";
    const levels = { entry, stop, target };
    // Same bar-walk the idea scoreboard uses, so a practice grade and a real
    // idea grade mean the same thing. Stop is checked first: a same-bar tie
    // counts as a loss.
    const bars = forward.timestamps.map((ts, i) => ({ ts, high: forward.highs[i], low: forward.lows[i] }));
    outcome = replayIdea(long, levels, bars);
    r = rMultiple(long, levels, outcome);
  }

  await db.query(
    `UPDATE practice_attempts
     SET status = 'graded', direction = ?, entry = ?, stop = ?, target = ?,
         outcome = ?, r_multiple = ?, process_score = ?, process_detail = ?,
         graded_at = extract(epoch from now())::int
     WHERE id = ? AND user_id = ?`
  ).run(plan.direction, num(plan.entry), num(plan.stop), num(plan.target),
    outcome, r, process.score, JSON.stringify(process.detail), id, userId);

  return { outcome, rMultiple: r, process, netAtr, ticker: row.ticker, asOfTs: row.as_of_ts, plan, forward, history };
}

// ── stats ───────────────────────────────────────────────────────────────────

export interface PracticeStats {
  attempts: number;
  taken: number;
  passed: number;
  hitRate: number | null;       // wins / resolved taken trades
  avgR: number | null;
  avgProcess: number | null;
  passAccuracy: number | null;  // correct passes / passes
  enough: boolean;              // false while under MIN_N
}

export async function practiceStats(userId: number): Promise<PracticeStats> {
  const rows = await db.query(
    `SELECT direction, outcome, r_multiple, process_score
     FROM practice_attempts WHERE user_id = ? AND status = 'graded'`
  ).all(userId) as { direction: string; outcome: string; r_multiple: number | null; process_score: number | null }[];

  const attempts = rows.length;
  const passes = rows.filter((r) => r.direction === "no_trade");
  const taken = rows.filter((r) => r.direction !== "no_trade");
  const resolved = taken.filter((r) => r.outcome === "win" || r.outcome === "loss");
  const enough = attempts >= MIN_N;

  // Every derived stat is gated behind MIN_N, matching insights.ts — a hit rate
  // of "100%" off one trade is worse than no number at all.
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    attempts,
    taken: taken.length,
    passed: passes.length,
    hitRate: enough && resolved.length ? resolved.filter((r) => r.outcome === "win").length / resolved.length : null,
    avgR: enough ? mean(resolved.map((r) => r.r_multiple).filter((x): x is number => x != null)) : null,
    avgProcess: enough ? mean(rows.map((r) => r.process_score).filter((x): x is number => x != null)) : null,
    passAccuracy: enough && passes.length ? passes.filter((r) => r.outcome === "pass_correct").length / passes.length : null,
    enough,
  };
}
