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

import { db, getSettingFor, setSettingFor } from "../db";
import { fetchDailyCandles, fetchIntradayBars, type DailyCandles } from "../ingest/yahoo";
import { atr, sma, rsi, vwap, pivotLevels } from "./technicals";
import { replayIdea, rMultiple } from "./insights";

// Drills are posed on 15-minute bars: the read they train (structure, a level to
// lean on, a stop outside the noise) is the one the rest of the app is about,
// and a 120-bar window is a little under a week of sessions rather than the six
// months of daily bars this used to show.
//
// Yahoo serves 60 days of 15m history (yahoo.ts:72), which at ~26 bars a session
// is ~1,500 bars — plenty to pick a random as-of point inside.
export const INTERVAL = "15m" as const;
export const RANGE = "60d";
export const VISIBLE = 120;   // bars of history the drill shows (~4.6 sessions)
export const HORIZON = 26;    // bars revealed when the plan is graded (~1 session)
export const GRADING_VERSION = 2;
export const MIN_N = 5;       // stats stay blank under this, matching insights.ts

// A drill's numbers only mean something next to drills posed the same way, so
// every stat query is scoped to one cohort. Legacy daily drills keep their rows
// and their history; they simply are not averaged in with intraday ones.
export interface Cohort {
  interval: string;
  visibleBars: number;
  horizon: number;
  gradingVersion: number;
}
export const CURRENT_COHORT: Cohort = {
  interval: INTERVAL, visibleBars: VISIBLE, horizon: HORIZON, gradingVersion: GRADING_VERSION,
};

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

// Keyed by ticker AND interval. A legacy daily drill being graded and a new
// intraday drill being posed can ask for the same symbol inside the TTL, and a
// ticker-only key would hand one of them the other's bars.
async function candlesFor(ticker: string, interval: string = INTERVAL): Promise<DailyCandles | null> {
  const key = `${ticker}:${interval}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.candles;
  let candles: DailyCandles | null = null;
  try {
    candles = interval === "1d"
      ? await fetchDailyCandles(ticker, "5y", 120 + 40 + 20)
      : await fetchIntradayBars(ticker, INTERVAL, RANGE);
  } catch { candles = null; }
  candleCache.set(key, { at: Date.now(), candles });
  return candles;
}

// The exact bars a drill was posed with, stored on the row at creation.
// Grading used to re-fetch and match on as_of_ts, which meant a drill could
// become ungradeable once the 60-day intraday window rolled past it, and could
// be graded against OHLC values Yahoo had since revised. Storing the slice makes
// grading deterministic and needs no network at all.
interface IssuedBars {
  timestamps: number[]; opens: number[]; highs: number[]; lows: number[]; closes: number[];
  // Volumes are stored too: VWAP is volume-weighted by definition, so dropping
  // them here silently produces a 0/0 and the reveal loses VWAP without erroring.
  volumes: number[];
  asOf: number;   // index of the last visible bar within these arrays
}

const sliceBars = (c: DailyCandles, from: number, to: number) => ({
  timestamps: c.timestamps.slice(from, to), opens: c.opens.slice(from, to),
  highs: c.highs.slice(from, to), lows: c.lows.slice(from, to), closes: c.closes.slice(from, to),
  volumes: (c.volumes ?? []).slice(from, to),
});

function parseIssued(raw: string | null): IssuedBars | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as IssuedBars;
    // Every series has to be the same length: grading indexes highs/lows/opens
    // as well as closes, so a truncated payload would silently grade against
    // undefined and produce a wrong outcome or NaN technicals rather than
    // falling back to the re-fetch path.
    const n = Array.isArray(b?.closes) ? b.closes.length : 0;
    const ok = n > 0
      && typeof b.asOf === "number" && b.asOf >= 0 && b.asOf < n
      && b.timestamps?.length === n && b.opens?.length === n
      && b.highs?.length === n && b.lows?.length === n;
    return ok ? b : null;   // corrupt payload falls back to the re-fetch path
  } catch {
    return null;
  }
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
    // Store visible + forward together; `asOf` indexes the last visible bar, so
    // grading can split them again without trusting anything from the client.
    const to = Math.min(c.closes.length, asOf + 1 + HORIZON);
    const issued: IssuedBars = { ...sliceBars(c, from, to), asOf: asOf - from };

    const id = (await db.query(
      `INSERT INTO practice_attempts
         (user_id, ts, ticker, as_of_ts, horizon, status, interval, visible_bars, grading_version, bars)
       VALUES (?, extract(epoch from now())::int, ?, ?, ?, 'open', ?, ?, ?, ?) RETURNING id`
    ).get(userId, row.ticker, c.timestamps[asOf], HORIZON,
      INTERVAL, VISIBLE, GRADING_VERSION, JSON.stringify(issued))) as { id: number };

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
  technicals: Readable[];       // what was readable at the as-of point
}

export async function gradeDrill(userId: number, id: number, plan: Plan, targetRR: number): Promise<Grade | { error: string }> {
  const row = await db.query(
    `SELECT id, ticker, as_of_ts, horizon, status, interval, bars FROM practice_attempts WHERE id = ? AND user_id = ?`
  ).get(id, userId) as
    { id: number; ticker: string; as_of_ts: number; horizon: number; status: string; interval: string; bars: string | null } | null;
  if (!row) return { error: "Drill not found." };
  if (row.status === "graded") return { error: "This drill has already been graded." };

  // Preferred path: the bars the drill was actually posed with. No network, no
  // rolling-window expiry, no chance of grading against revised OHLC values.
  let c: DailyCandles | null = null;
  let asOf = -1;
  const issued = parseIssued(row.bars);
  if (issued) {
    c = { ticker: row.ticker, ...issued, volumes: issued.volumes ?? [] } as unknown as DailyCandles;
    asOf = issued.asOf;
  } else {
    // Legacy row from before bars were stored. Fetch at the interval it was
    // POSED at — a daily drill re-fetched as 15m would never find its as_of_ts
    // and would be permanently ungradeable.
    c = await candlesFor(row.ticker, row.interval ?? "1d");
    if (!c) return { error: "Could not reload the chart to grade it. Try again in a moment." };
    asOf = c.timestamps.indexOf(row.as_of_ts);
  }
  if (!c || asOf < 0) return { error: "The chart data shifted underneath this drill and it can no longer be graded." };

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

  // `AND status = 'open'` makes this the race guard as well as the write: a
  // double-submit, or a reset landing between the SELECT above and here, must
  // not produce a second grade (and a second history artifact) for one drill.
  const done = await db.query(
    `UPDATE practice_attempts
     SET status = 'graded', direction = ?, entry = ?, stop = ?, target = ?,
         outcome = ?, r_multiple = ?, process_score = ?, process_detail = ?,
         graded_at = extract(epoch from now())::int
     WHERE id = ? AND user_id = ? AND status = 'open' RETURNING id`
  ).get(plan.direction, num(plan.entry), num(plan.stop), num(plan.target),
    outcome, r, process.score, JSON.stringify(process.detail), id, userId) as { id: number } | null;
  if (!done) return { error: "This drill is no longer open — it was already graded or the record was reset." };

  return {
    outcome, rMultiple: r, process, netAtr, ticker: row.ticker, asOfTs: row.as_of_ts, plan, forward, history,
    technicals: readableAt(c, asOf, a, plan),
  };
}

// ── what was readable at decision time ───────────────────────────────────────
// Computed ONLY from bars at or before the as-of point, and only ever returned
// from gradeDrill — the whole drill rests on the reveal describing what could
// have been read, not what turned out to be true.
//
// Every level comes from technicals.ts, so a drill and the screener agree on
// what "support" or "the 20 SMA" means.

export interface Readable {
  label: string;
  value: string;
  meant: string;      // what it implied at the as-of point
  plan: string;       // how the trader's plan sat against it
  level?: number;     // drawn on the chart when present
  kind?: "support" | "resistance" | "sma20" | "sma50" | "vwap";
}

export function readableAt(c: DailyCandles, asOf: number, atrValue: number, plan: Plan): Readable[] {
  const to = asOf + 1;
  const closes = c.closes.slice(0, to), highs = c.highs.slice(0, to), lows = c.lows.slice(0, to);
  const price = closes[closes.length - 1];
  const out: Readable[] = [];
  const entry = num(plan.entry), stop = num(plan.stop), target = num(plan.target);
  const long = plan.direction === "long";
  const f = (v: number) => (v >= 10 ? v.toFixed(2) : v.toFixed(3));

  const piv = pivotLevels(highs, lows, price);
  const support = piv.supports[0] ?? null;
  const resistance = piv.resistances[0] ?? null;

  if (support != null) {
    out.push({
      label: "Support", value: `$${f(support)}`, level: support, kind: "support",
      meant: `Buyers turned price back here before. It is the level a long can lean on, and the one a breakdown would have to lose.`,
      plan: stop == null ? "No stop to compare."
        : long
          ? (stop < support ? `Your stop at $${f(stop)} sits below it, so normal defence of the level doesn't take you out.`
            : `Your stop at $${f(stop)} sits above it — you get stopped out while the level is still holding.`)
          : (target != null && target <= support ? `Your target at $${f(target)} is at or below it, so you're aiming into the level buyers defend.`
            : `Short target is above support, leaving room before the level matters.`),
    });
  }
  if (resistance != null) {
    out.push({
      label: "Resistance", value: `$${f(resistance)}`, level: resistance, kind: "resistance",
      meant: `Sellers capped price here before. A long has to get through it; a short can lean on it.`,
      plan: target == null ? "No target to compare."
        : long
          ? (target > resistance ? `Your target at $${f(target)} is beyond it — the trade needs a breakout, not just a bounce.`
            : `Your target at $${f(target)} stops short of it, which is the higher-probability ask.`)
          : (stop != null && stop > resistance ? `Your stop at $${f(stop)} is above it, so the level has to genuinely fail before you're wrong.`
            : `Your stop sits below resistance — a normal retest of the level can take you out.`),
    });
  }

  for (const [period, kind] of [[20, "sma20"], [50, "sma50"]] as const) {
    const v = sma(closes, period);
    if (v == null) continue;
    const above = price > v;
    out.push({
      label: `SMA ${period}`, value: `$${f(v)}`, level: v, kind,
      meant: `Price was ${above ? "above" : "below"} its ${period}-bar average, so the short-term drift was ${above ? "up" : "down"}.`,
      plan: plan.direction === "no_trade" ? "No direction to compare."
        : long === above ? `Your ${plan.direction} traded with that drift.`
          : `Your ${plan.direction} traded against it — possible, but it needs a reason beyond the trend.`,
    });
  }

  const r = rsi(closes);
  if (r != null) {
    out.push({
      label: "RSI 14", value: r.toFixed(0),
      meant: r > 70 ? "Momentum was strong but stretched — moves starting here often need a pause first."
        : r < 30 ? "Momentum was weak and stretched — falling knives and bounces both start from here."
          : "Momentum was in its normal band, so it neither helped nor argued against the setup.",
      plan: plan.direction === "no_trade" ? "Passing on an unstretched tape is a defensible read."
        : (r > 70 && long) || (r < 30 && !long)
          ? "You entered in the direction price had already stretched — the worse half of the entry."
          : "Your entry was not chasing a stretched move.",
    });
  }

  // VWAP is a SESSION measure. Anchoring it to the whole 120-bar window would
  // silently average across several days and mean nothing, so it is computed
  // from the last session boundary in the visible bars.
  const day = (ts: number) => Math.floor(ts / 86400);
  const lastDay = day(c.timestamps[asOf]);
  let sessionFrom = asOf;
  while (sessionFrom > 0 && day(c.timestamps[sessionFrom - 1]) === lastDay) sessionFrom--;
  const vols = c.volumes ?? [];
  const sessionBars = [];
  for (let i = sessionFrom; i <= asOf; i++) {
    sessionBars.push({
      ts: c.timestamps[i], high: c.highs[i], low: c.lows[i],
      close: c.closes[i], open: c.opens[i], volume: vols[i] ?? 0,
    });
  }
  // Needs real volume: vwap() divides by the volume sum, so a zero-volume series
  // yields 0/0 and the line vanishes from the reveal without any error. Drills
  // issued before volumes were stored fall into that case and simply omit VWAP.
  const hasVolume = sessionBars.some((b) => b.volume > 0);
  const vw = sessionBars.length > 1 && hasVolume ? vwap(sessionBars as any) : null;
  if (vw != null && vw > 0) {
    const above = price > vw;
    const dist = ((price - vw) / vw) * 100;
    out.push({
      label: "VWAP (session)", value: `$${f(vw)}`, level: vw, kind: "vwap",
      meant: `Price was ${Math.abs(dist).toFixed(1)}% ${above ? "above" : "below"} the session's volume-weighted average, so ${above ? "buyers" : "sellers"} held the session.`,
      plan: entry == null ? "No entry to compare."
        : Math.abs((entry - vw) / vw) * 100 < 0.2 ? "You entered right at VWAP, which is where the session is fairly priced."
          : `You entered ${entry > vw ? "above" : "below"} it — ${((long && entry > vw) || (!long && entry < vw)) ? "paying up rather than waiting for a retest" : "on the favourable side of the session average"}.`,
    });
  }

  out.push({
    label: "ATR", value: `$${f(atrValue)}`,
    meant: "The typical distance one bar travels. It is what makes a stop 'too tight' or 'too wide' measurable instead of a feeling.",
    plan: entry == null || stop == null ? "No stop distance to judge."
      : `Your stop was ${(Math.abs(entry - stop) / atrValue).toFixed(2)}x ATR from entry.`,
  });

  return out;
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

// Reset is an archive, not a delete: it moves a marker forward and stats count
// only drills taken after it. Nothing is destroyed, so the confirmation can stay
// proportionate and a record can be brought back if it was cleared by mistake.
const RESET_KEY = "practice_reset_at";

export async function resetPractice(userId: number): Promise<{ archived: number }> {
  const now = Math.floor(Date.now() / 1000);
  const n = await db.query(
    `SELECT count(*)::int AS n FROM practice_attempts WHERE user_id = ? AND status = 'graded' AND ts >= ?`
  ).get(userId, await resetAt(userId)) as { n: number };
  await setSettingFor(userId, RESET_KEY, String(now));
  return { archived: n?.n ?? 0 };
}

export async function resetAt(userId: number): Promise<number> {
  const raw = Number(await getSettingFor(userId, RESET_KEY, "0"));
  return Number.isFinite(raw) ? raw : 0;
}

export async function practiceStats(userId: number, cohort: Cohort = CURRENT_COHORT): Promise<PracticeStats> {
  // Scoped to one cohort AND to drills at or after the last reset. A 26-bar
  // intraday drill and a 40-day daily one are not the same measurement, so
  // averaging them into a single "Avg R" would produce a number that means
  // nothing.
  //
  // `>=`, not `>`: both timestamps are whole seconds, and resetting then
  // immediately starting a drill is a normal flow — that drill would land on the
  // same second as the marker and be excluded from the record forever.
  const rows = await db.query(
    `SELECT direction, outcome, r_multiple, process_score
     FROM practice_attempts
     WHERE user_id = ? AND status = 'graded' AND ts >= ?
       AND interval = ? AND visible_bars = ? AND horizon = ? AND grading_version = ?`
  ).all(userId, await resetAt(userId),
    cohort.interval, cohort.visibleBars, cohort.horizon, cohort.gradingVersion,
  ) as { direction: string; outcome: string; r_multiple: number | null; process_score: number | null }[];

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
