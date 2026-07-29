// Portfolio insights that are pure data plumbing (no AI):
//   - upcoming-earnings cache for held tickers (chip on holding rows)
//   - options expiry warnings (events + push notification)
//   - idea outcome scoreboard: replay validated ideas against real candles
//     to measure whether "strong" ratings actually win.
import { db, insertEvent } from "../db";
import { fetchEarningsCalendar } from "../ingest/finnhub";
import { fetchDailyCandlesBulk } from "../ingest/candles";
import { notifyTelegram, telegramEnabled } from "../notify/telegram";
import { notifyMac } from "../notify/macos";
import type { Portfolio, Holding } from "../config";

// ── upcoming earnings (refreshed twice a day for the primary user's tickers) ──
const earningsDates = new Map<string, string>(); // ticker → ISO date (next 14 days)

export async function refreshEarnings(tickers: string[]): Promise<void> {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const from = iso(Date.now()), to = iso(Date.now() + 14 * 86400_000);
  for (const t of tickers) {
    if (t.includes(" ") || t.includes("-USD") || t.startsWith("^")) continue; // options/crypto/indices
    try {
      const rows = await fetchEarningsCalendar(from, to, t);
      const next = rows.filter((r) => r.symbol === t).map((r) => r.date).sort()[0];
      if (next) earningsDates.set(t, next); else earningsDates.delete(t);
    } catch { /* calendar endpoint hiccup — keep last known */ }
    await Bun.sleep(1100); // finnhub free-tier pacing
  }
  if (earningsDates.size) console.log(`[earnings] upcoming: ${[...earningsDates.entries()].map(([t, d]) => `${t} ${d}`).join(", ")}`);
}

// {ticker: date} for just the requested tickers — shipped on /api/state.
export function earningsFor(tickers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tickers) { const d = earningsDates.get(t); if (d) out[t] = d; }
  return out;
}

// ── options expiry warnings ──────────────────────────────────────────────────
export function daysToExpiry(expiryISO: string): number {
  return Math.ceil((new Date(expiryISO + "T16:00:00-05:00").getTime() - Date.now()) / 86400_000);
}

// Warn at ≤7 days and again at ≤1 day. Events are deduped per option+threshold,
// so each warning fires exactly once per contract.
// userId owns the warning: the title names YOUR contract count, and the dedupe
// key has to include the account or the first holder of a contract silences the
// warning for every other holder of the same one.
export async function checkOptionExpiries(portfolio: Portfolio, userId: number): Promise<void> {
  for (const h of portfolio.holdings) {
    if (h.asset_class !== "option" || !h.option) continue;
    const dte = daysToExpiry(h.option.expiry);
    const threshold = dte <= 1 ? 1 : dte <= 7 ? 7 : null;
    if (threshold == null || dte < 0) continue;
    const o = h.option;
    const title = `⏳ ${o.underlying} $${o.strike} ${o.type} expires ${dte <= 1 ? "TODAY/tomorrow" : `in ${dte} days`} (${o.expiry}) — you hold ${Math.abs(h.shares)} contract${Math.abs(h.shares) === 1 ? "" : "s"}`;
    const id = await insertEvent({
      ts: Math.floor(Date.now() / 1000), ticker: h.ticker, kind: "option_expiry",
      title, detail: { dte, ...o }, dedupeKey: `optexp:${userId}:${h.ticker}:${threshold}`, userId,
    });
    if (id) { // first time this warning fires — push it
      console.log(`[insights] ${title}`);
      const results = await Promise.allSettled([
        telegramEnabled() ? notifyTelegram(title) : Promise.resolve(),
        notifyMac("sharpEdge options", title),
      ]);
      for (const r of results) if (r.status === "rejected") console.error("[insights] notify failed:", r.reason);
    }
  }
}

// ── idea outcome scoreboard ──────────────────────────────────────────────────
// The trade plan's entry/stop/target are prose ("pullback to $182-184…"), so
// extract dollar levels heuristically and skip anything that doesn't parse or
// isn't internally consistent (stop < entry < target for longs). Conservative
// tie-break: if stop and target are both touched in the same bar, count a loss.
export function parseLevels(rep: any): { entry: number; stop: number; target: number } | null {
  const nums = (s: unknown) => [...String(s ?? "").matchAll(/\$?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  const tp = rep?.trade_plan ?? {};
  const e = nums(tp.entry_zone);
  const st = nums(tp.stop_loss);
  const tg = nums(Array.isArray(tp.targets) ? tp.targets[0] : "");
  if (!e.length || !st.length || !tg.length) return null;
  const entry = e.length >= 2 ? (e[0] + e[1]) / 2 : e[0];
  const stop = st[0], target = tg[0];
  const long = rep.direction !== "short";
  const sane = long ? stop < entry && entry < target : stop > entry && entry > target;
  // Reject wild parses (e.g. picked an R-multiple or a date out of the prose).
  const nearEntry = (x: number) => x > entry * 0.4 && x < entry * 2.5;
  return sane && nearEntry(stop) && nearEntry(target) ? { entry, stop, target } : null;
}

// Pure replay over daily bars (exported for the self-check).
export function replayIdea(long: boolean, levels: { entry: number; stop: number; target: number },
  bars: { ts: number; high: number; low: number }[]): "win" | "loss" | "open" {
  for (const b of bars) {
    const hitStop = long ? b.low <= levels.stop : b.high >= levels.stop;
    const hitTarget = long ? b.high >= levels.target : b.low <= levels.target;
    if (hitStop) return "loss"; // same-bar tie counts as loss (conservative)
    if (hitTarget) return "win";
  }
  return "open";
}

export interface ScoreboardRow {
  rating: string; direction: string; wins: number; losses: number; open: number;
}

// The six dimensions the validator scores each idea on (0-10), in report.scores.
export const SCORE_DIMENSIONS = [
  "technical", "catalyst", "market_alignment", "news_sentiment", "risk_reward", "invalidation_clarity",
] as const;

// One replayed idea: outcome + realized R + the six dimension scores. R is
// deterministic from the outcome — a win hit the target (planned R:R), a loss
// hit the stop (-1R) — so no need to thread the touched price back out.
export interface IdeaReplay {
  rating: string; direction: string;
  outcome: "win" | "loss" | "open";
  R: number | null;                    // realized R-multiple; null while open
  scores: Record<string, number> | null;
}

// Per-user, matching the Map<userId,...> pattern in broker/index.ts — a
// single-slot cache would thrash (and re-fetch every ticker's candles) any
// time two users' calls interleave. Both ideaScoreboard and calibration read
// this one cache, so the paced Yahoo fetches run once per hour, not twice.
const replayCache = new Map<number, { at: number; ideas: IdeaReplay[]; skipped: number; total: number }>();

export function rMultiple(long: boolean, lv: { entry: number; stop: number; target: number }, outcome: IdeaReplay["outcome"]): number | null {
  if (outcome === "open") return null;
  if (outcome === "loss") return -1;
  const reward = long ? lv.target - lv.entry : lv.entry - lv.target;
  const risk = long ? lv.entry - lv.stop : lv.stop - lv.entry;
  return risk > 0 ? reward / risk : null;
}

export async function replayUserIdeas(userId: number): Promise<{ ideas: IdeaReplay[]; skipped: number; total: number }> {
  const cached = replayCache.get(userId);
  if (cached && Date.now() - cached.at < 3_600_000) return cached;
  const since = Math.floor(Date.now() / 1000) - 120 * 86400;
  const ideas = await db.query(
    `SELECT id, ts, ticker, direction, rating, report FROM ideas
     WHERE user_id = ? AND source != 'intraday' AND rating != 'reject' AND ts > ?
     ORDER BY ts DESC LIMIT 40`
  ).all(userId, since) as any[];

  const out: IdeaReplay[] = [];
  let skipped = 0;
  const candleCache = new Map<string, Awaited<ReturnType<typeof fetchDailyCandlesBulk>>>();
  for (const idea of ideas) {
    let rep: any; try { rep = JSON.parse(idea.report); } catch { skipped++; continue; }
    const levels = parseLevels({ ...rep, direction: idea.direction });
    if (!levels) { skipped++; continue; }
    if (!candleCache.has(idea.ticker)) {
      // Same politeness pacing as the screener's Yahoo fetch loop (screener.ts)
      // — an unthrottled burst on a cold cache risks a 429 that then nulls out
      // every remaining ticker for the rest of this hour's cache window.
      if (candleCache.size) await Bun.sleep(180);
      try { candleCache.set(idea.ticker, await fetchDailyCandlesBulk(idea.ticker, "1y", 30)); } catch { candleCache.set(idea.ticker, null); }
    }
    const c = candleCache.get(idea.ticker);
    if (!c) { skipped++; continue; }
    const bars = c.timestamps
      .map((ts, i) => ({ ts, high: c.highs?.[i] ?? c.closes[i], low: c.lows?.[i] ?? c.closes[i] }))
      .filter((b) => b.ts > idea.ts);
    const long = idea.direction !== "short";
    const outcome = replayIdea(long, levels, bars);
    const s = rep?.scores;
    const scores = s && typeof s === "object" ? s : null;
    out.push({ rating: idea.rating, direction: idea.direction, outcome, R: rMultiple(long, levels, outcome), scores });
  }
  const result = { at: Date.now(), ideas: out, skipped, total: ideas.length };
  replayCache.set(userId, result);
  return result;
}

export async function ideaScoreboard(userId: number): Promise<{ rows: ScoreboardRow[]; skipped: number; total: number }> {
  const { ideas, skipped, total } = await replayUserIdeas(userId);
  const buckets = new Map<string, ScoreboardRow>();
  for (const idea of ideas) {
    const key = `${idea.rating}|${idea.direction}`;
    const row = buckets.get(key) ?? { rating: idea.rating, direction: idea.direction, wins: 0, losses: 0, open: 0 };
    row[idea.outcome === "win" ? "wins" : idea.outcome === "loss" ? "losses" : "open"]++;
    buckets.set(key, row);
  }
  const order = { strong: 0, moderate: 1, weak: 2 } as Record<string, number>;
  const rows = [...buckets.values()].sort((a, b) => (order[a.rating] ?? 9) - (order[b.rating] ?? 9) || a.direction.localeCompare(b.direction));
  return { rows, skipped, total };
}

// ── F0: validator calibration ────────────────────────────────────────────────
// Does the rubric actually predict outcomes? Aggregate replayed ideas into
// hit-rate + avg-R by rating and by direction, plus per-dimension win/loss
// score gaps. Every stat gates at MIN_N resolved trades so tiny samples never
// render a misleading percentage ("weak: 100% (n=1)").
const MIN_N = 5;

export interface CalibrationBucket {
  key: string; wins: number; losses: number; open: number;
  hitRate: number | null;   // wins/(wins+losses), null under MIN_N resolved
  avgR: number | null;      // mean realized R over resolved, null under MIN_N
}
export interface DimensionStat {
  dimension: string;
  avgWin: number | null; avgLoss: number | null;   // mean 0-10 score, gated
  nWin: number; nLoss: number;
  edge: number | null;      // avgWin - avgLoss (positive = predictive), gated
}
export interface Calibration {
  byRating: CalibrationBucket[];
  byDirection: CalibrationBucket[];
  dimensions: DimensionStat[];
  verdict: string;
  resolved: number; total: number; skipped: number;
}

function bucketStats(key: string, items: IdeaReplay[]): CalibrationBucket {
  const wins = items.filter((i) => i.outcome === "win").length;
  const losses = items.filter((i) => i.outcome === "loss").length;
  const open = items.filter((i) => i.outcome === "open").length;
  const resolved = wins + losses;
  const rs = items.map((i) => i.R).filter((r): r is number => r != null);
  return {
    key, wins, losses, open,
    hitRate: resolved >= MIN_N ? wins / resolved : null,
    avgR: rs.length >= MIN_N ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
  };
}

function groupBy(ideas: IdeaReplay[], pick: (i: IdeaReplay) => string, order: string[]): CalibrationBucket[] {
  const groups = new Map<string, IdeaReplay[]>();
  for (const i of ideas) { const k = pick(i); (groups.get(k) ?? groups.set(k, []).get(k)!).push(i); }
  return [...groups.entries()]
    .map(([k, items]) => bucketStats(k, items))
    .sort((a, b) => (order.indexOf(a.key) + 1 || 9) - (order.indexOf(b.key) + 1 || 9) || a.key.localeCompare(b.key));
}

export async function calibration(userId: number): Promise<Calibration> {
  const { ideas, skipped, total } = await replayUserIdeas(userId);
  const resolvedIdeas = ideas.filter((i) => i.outcome !== "open");
  const byRating = groupBy(ideas, (i) => i.rating, ["strong", "moderate", "weak"]);
  const byDirection = groupBy(ideas, (i) => i.direction, ["long", "short"]);

  const dimensions: DimensionStat[] = SCORE_DIMENSIONS.map((dim) => {
    const win = resolvedIdeas.filter((i) => i.outcome === "win" && i.scores?.[dim] != null).map((i) => i.scores![dim]);
    const loss = resolvedIdeas.filter((i) => i.outcome === "loss" && i.scores?.[dim] != null).map((i) => i.scores![dim]);
    const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const avgWin = win.length >= MIN_N ? mean(win) : null;
    const avgLoss = loss.length >= MIN_N ? mean(loss) : null;
    return { dimension: dim, avgWin, avgLoss, nWin: win.length, nLoss: loss.length, edge: avgWin != null && avgLoss != null ? avgWin - avgLoss : null };
  });

  // Verdict compares strong vs weak hit-rate when both clear MIN_N.
  const strong = byRating.find((b) => b.key === "strong");
  const weak = byRating.find((b) => b.key === "weak");
  let verdict: string;
  const resolved = resolvedIdeas.length;
  if (strong?.hitRate != null && weak?.hitRate != null) {
    const sp = Math.round(strong.hitRate * 100), wp = Math.round(weak.hitRate * 100);
    verdict = sp > wp + 5 ? `Strong ideas hit ${sp}% vs weak ${wp}% — the rubric has edge.`
      : sp < wp - 5 ? `Strong ideas hit ${sp}% vs weak ${wp}% — the rubric is inverted, investigate.`
        : `Strong ${sp}% vs weak ${wp}% — no clear separation yet.`;
  } else if (strong?.hitRate != null) {
    verdict = `Strong ideas hit ${Math.round(strong.hitRate * 100)}% (need ${MIN_N}+ resolved weak ideas to compare).`;
  } else {
    verdict = `Not enough resolved ideas to measure edge yet (${resolved}/${MIN_N}).`;
  }
  return { byRating, byDirection, dimensions, verdict, resolved, total, skipped };
}

// ── self-check: `bun src/engine/insights.ts` ─────────────────────────────────
if (import.meta.main) {
  const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

  const rep = { direction: "long", trade_plan: { entry_zone: "pullback to $182-184 holding the breakout", stop_loss: "below $176 (the pivot)", targets: ["$198 measured move", "$210"] } };
  const lv = parseLevels(rep)!;
  assert(!!lv && lv.entry === 183 && lv.stop === 176 && lv.target === 198, `parseLevels long: ${JSON.stringify(lv)}`);
  assert(parseLevels({ direction: "long", trade_plan: { entry_zone: "buy the dip", stop_loss: "structure break", targets: ["momentum"] } }) === null, "no numbers → null");
  assert(parseLevels({ direction: "long", trade_plan: { entry_zone: "$100", stop_loss: "$110", targets: ["$120"] } }) === null, "stop above entry on a long → rejected");
  const sv = parseLevels({ direction: "short", trade_plan: { entry_zone: "$50", stop_loss: "$55", targets: ["$40"] } })!;
  assert(!!sv && sv.stop === 55 && sv.target === 40, "short levels parse");

  const bars = (rows: [number, number][]) => rows.map(([high, low], i) => ({ ts: i + 1, high, low }));
  assert(replayIdea(true, { entry: 183, stop: 176, target: 198 }, bars([[185, 180], [199, 184]])) === "win", "long hits target");
  assert(replayIdea(true, { entry: 183, stop: 176, target: 198 }, bars([[185, 175]])) === "loss", "long hits stop");
  assert(replayIdea(true, { entry: 183, stop: 176, target: 198 }, bars([[199, 175]])) === "loss", "same-bar tie → loss (conservative)");
  assert(replayIdea(true, { entry: 183, stop: 176, target: 198 }, bars([[185, 180]])) === "open", "neither → open");
  assert(replayIdea(false, { entry: 50, stop: 55, target: 40 }, bars([[52, 39]])) === "win", "short hits target");

  assert(daysToExpiry(new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10)) >= 4, "daysToExpiry ~5");

  // rMultiple: win → planned R:R, loss → -1, open → null.
  const lvL = { entry: 100, stop: 90, target: 130 }; // risk 10, reward 30 → 3R
  assert(rMultiple(true, lvL, "win") === 3, "long win = +3R");
  assert(rMultiple(true, lvL, "loss") === -1, "loss = -1R");
  assert(rMultiple(true, lvL, "open") === null, "open = null R");
  const lvS = { entry: 50, stop: 55, target: 40 }; // risk 5, reward 10 → 2R
  assert(rMultiple(false, lvS, "win") === 2, "short win = +2R");

  // bucketStats gates hit-rate/avgR under MIN_N; 6 wins + 0 losses clears it.
  const mk = (outcome: "win" | "loss" | "open", R: number | null): IdeaReplay =>
    ({ rating: "strong", direction: "long", outcome, R, scores: null });
  const few = bucketStats("strong", [mk("win", 3), mk("loss", -1)]);
  assert(few.hitRate === null && few.avgR === null, "under MIN_N → gated null");
  const many = bucketStats("strong", [mk("win", 3), mk("win", 3), mk("win", 3), mk("loss", -1), mk("loss", -1), mk("open", null)]);
  assert(many.wins === 3 && many.losses === 2 && many.open === 1, "bucket counts");
  assert(Math.abs(many.hitRate! - 0.6) < 1e-9, "hitRate 3/5");
  assert(Math.abs(many.avgR! - (3 + 3 + 3 - 1 - 1) / 5) < 1e-9, "avgR mean of resolved");
  console.log("insights self-check: OK");
}
