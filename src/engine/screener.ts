// Market screener: scans the full liquid US universe (large/mid/small cap,
// sector-tagged) for BOTH long and short setups using daily candles. Pure math —
// no AI tokens. Every ticker gets a long score and a short score built from
// confluence across trend structure, momentum quality, volume, volatility
// context, support/resistance, and relative strength vs sector and market.
// Momentum alone is capped so it can never dominate a score, and shorts require
// genuine structural breakdown — negative price action by itself is not enough.
import { db, insertEvent } from "../db";
import { fetchDailyCandles } from "../ingest/yahoo";
import { scanUniverse, sectorMap, sectorEtf } from "../ingest/universe";
import { benchmarkCandles, refreshMarketContext, getMarketSnapshot } from "./market";
import { rsi, macd, sma, atr, slopePctPerBar, pivotLevels, rangeBreak, betaVs } from "./technicals";
import { loadUniverseFilters, type Portfolio } from "../config";
import type { RawEvent } from "./detectors";

export interface Indicators {
  price: number;
  sma20: number;
  sma50: number;
  sma200: number;
  pctVs200: number;        // % above/below SMA200
  slope20: number | null;  // 20-day least-squares slope, %/bar
  crossStatus: "golden_formed" | "golden_soon" | "death_formed" | "none";
  crossDetail: string;
  rsi14: number | null;
  macdHist: number | null;
  mom1m: number;           // % return over ~21 trading days
  mom3m: number;
  mom6m: number;
  pct52w: number;          // 0 = at 52wk low, 100 = at 52wk high
  volTrend: number;        // 20d avg volume / 60d avg volume
  atrPct: number | null;   // ATR14 as % of price (volatility context)
  extension: number | null;// (price - SMA20) / ATR — how stretched vs its mean
  support: number | null;  // nearest swing support below
  resistance: number | null;
  rangeState: "breakout" | "breakdown" | "none";
  rangeLevel: number | null;
  rangeVolConfirmed: boolean;
  structure: "higher_lows" | "lower_highs" | "mixed"; // swing structure read
  rsSpy1m: number | null;  // 1m return minus SPY 1m return
  rsSpy3m: number | null;
  rsSector1m: number | null;
  beta: number | null;     // 60d beta vs SPY (stress-test input)
  spark: number[];         // ~30 downsampled closes from the last 90 sessions
}

function downsample(values: number[], points: number): number[] {
  if (values.length <= points) return values.map((v) => Number(v.toFixed(2)));
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    out.push(Number(values[Math.floor((i / (points - 1)) * (values.length - 1))].toFixed(2)));
  }
  return out;
}

function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

const pctBack = (closes: number[], bars: number) => {
  const n = closes.length;
  if (n <= bars) return 0;
  return ((closes[n - 1] - closes[n - 1 - bars]) / closes[n - 1 - bars]) * 100;
};

export function computeIndicators(
  candles: { opens: number[]; highs: number[]; lows: number[]; closes: number[]; volumes: number[] },
  spyCloses: number[] | null,
  sectorCloses: number[] | null
): Indicators | null {
  const { highs, lows, closes, volumes } = candles;
  const n = closes.length;
  if (n < 210) return null;
  const s50 = smaSeries(closes, 50);
  const s200 = smaSeries(closes, 200);
  const price = closes[n - 1];
  const sma50v = s50[n - 1]!;
  const sma200v = s200[n - 1]!;
  const sma20v = sma(closes, 20)!;

  // Cross detection over the last 10 sessions
  let crossStatus: Indicators["crossStatus"] = "none";
  let crossDetail = "";
  for (let i = n - 10; i < n; i++) {
    if (s50[i - 1] == null || s200[i - 1] == null) continue;
    if (s50[i - 1]! <= s200[i - 1]! && s50[i]! > s200[i]!) {
      crossStatus = "golden_formed";
      crossDetail = `SMA50 crossed above SMA200 ${n - 1 - i} sessions ago`;
    } else if (s50[i - 1]! >= s200[i - 1]! && s50[i]! < s200[i]!) {
      crossStatus = "death_formed";
      crossDetail = `SMA50 crossed below SMA200 ${n - 1 - i} sessions ago`;
    }
  }
  // Approaching golden cross: SMA50 below but within 2% of SMA200 AND converging.
  if (crossStatus === "none" && sma50v < sma200v) {
    const gapNow = (sma200v - sma50v) / sma200v;
    const gapPrev = (s200[n - 11]! - s50[n - 11]!) / s200[n - 11]!;
    if (gapNow > 0 && gapNow < 0.02 && gapPrev > gapNow) {
      const closingPerDay = (gapPrev - gapNow) / 10;
      const eta = Math.ceil(gapNow / closingPerDay);
      if (eta <= 20) {
        crossStatus = "golden_soon";
        crossDetail = `SMA50 is ${(gapNow * 100).toFixed(2)}% below SMA200, converging — est. cross in ~${eta} sessions`;
      }
    }
  }

  const hi52 = Math.max(...closes.slice(-252));
  const lo52 = Math.min(...closes.slice(-252));
  const vol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const vol60 = volumes.slice(-60).reduce((a, b) => a + b, 0) / 60;
  const m = macd(closes);
  const atr14 = atr(highs, lows, closes, 14);
  const piv = pivotLevels(highs, lows, price);
  const rb = rangeBreak(highs, lows, closes, volumes, 20);
  const beta = spyCloses ? betaVs(closes, spyCloses, 60) : null;

  // Swing structure: compare the last two confirmed swing highs/lows.
  let structure: Indicators["structure"] = "mixed";
  if (piv.lastSwingHigh != null && piv.priorSwingHigh != null && piv.lastSwingLow != null && piv.priorSwingLow != null) {
    const hh = piv.lastSwingHigh > piv.priorSwingHigh;
    const hl = piv.lastSwingLow > piv.priorSwingLow;
    if (hl && hh) structure = "higher_lows";
    else if (!hh && !hl) structure = "lower_highs";
  }

  return {
    price,
    sma20: sma20v,
    sma50: sma50v,
    sma200: sma200v,
    pctVs200: ((price - sma200v) / sma200v) * 100,
    slope20: slopePctPerBar(closes, 20),
    crossStatus,
    crossDetail,
    rsi14: rsi(closes),
    macdHist: m?.histogram ?? null,
    mom1m: pctBack(closes, 21),
    mom3m: pctBack(closes, 63),
    mom6m: pctBack(closes, 126),
    pct52w: hi52 > lo52 ? ((price - lo52) / (hi52 - lo52)) * 100 : 50,
    volTrend: vol60 > 0 ? vol20 / vol60 : 1,
    atrPct: atr14 != null ? (atr14 / price) * 100 : null,
    extension: atr14 != null && atr14 > 0 ? (price - sma20v) / atr14 : null,
    support: piv.supports[0] ?? null,
    resistance: piv.resistances[0] ?? null,
    rangeState: rb.state,
    rangeLevel: rb.level,
    rangeVolConfirmed: rb.volumeConfirmed,
    structure,
    rsSpy1m: spyCloses ? pctBack(closes, 21) - pctBack(spyCloses, 21) : null,
    rsSpy3m: spyCloses ? pctBack(closes, 63) - pctBack(spyCloses, 63) : null,
    rsSector1m: sectorCloses ? pctBack(closes, 21) - pctBack(sectorCloses, 21) : null,
    beta: beta?.beta ?? null,
    spark: downsample(closes.slice(-90), 30),
  };
}

// ── Directional confluence scores ────────────────────────────────────────────
// Both scores are 0–100. Design targets: neutral tape ≈ 30–45; ≥60 = real setup;
// ≥80 = strong multi-factor confluence. Momentum contributes at most ~20 points,
// so a stock cannot score "strong" on price movement alone.

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function scoreLong(ind: Indicators): number {
  let s = 0;
  // Trend structure (max 30)
  if (ind.price > ind.sma200) s += 10;
  if (ind.sma50 > ind.sma200) s += 8;
  if ((ind.slope20 ?? 0) > 0.05) s += 6;
  if (ind.structure === "higher_lows") s += 6;
  else if (ind.structure === "lower_highs") s -= 6;
  // Cross context (max 10)
  if (ind.crossStatus === "golden_formed") s += 10;
  else if (ind.crossStatus === "golden_soon") s += 6;
  else if (ind.crossStatus === "death_formed") s -= 12;
  // Momentum quality (capped ~20 total so it cannot dominate)
  s += clamp(ind.mom3m * 0.35, -8, 10);
  s += clamp(ind.mom6m * 0.1, -4, 5);
  if (ind.rsi14 != null) {
    if (ind.rsi14 >= 45 && ind.rsi14 <= 65) s += 5;       // healthy regime
    else if (ind.rsi14 > 75) s -= 8;                       // overbought chase
    else if (ind.rsi14 < 30) s += 2;                       // washed out, mild credit
  }
  // Trend confirmation (max 6)
  if (ind.macdHist != null && ind.macdHist > 0) s += 6;
  // Volume confirmation (max 8)
  if (ind.volTrend > 1.15) s += 5;
  if (ind.rangeState === "breakout" && ind.rangeVolConfirmed) s += 3;
  // Structure/levels (max 14)
  if (ind.rangeState === "breakout") s += ind.rangeVolConfirmed ? 8 : 4;
  else if (ind.rangeState === "breakdown") s -= 8;
  if (ind.support != null && ind.atrPct != null && ind.atrPct > 0) {
    const distToSupportAtr = ((ind.price - ind.support) / ind.price) * 100 / ind.atrPct;
    if (distToSupportAtr <= 1.5) s += 3;                   // defined risk near support
  }
  if (ind.extension != null) {
    if (Math.abs(ind.extension) < 2.5) s += 3;             // not chasing an extended move
    else if (ind.extension > 3.5) s -= 6;                  // parabolic — poor entry
  }
  // Relative strength (max 12)
  if (ind.rsSpy1m != null) s += clamp(ind.rsSpy1m * 0.6, -6, 6);
  if (ind.rsSector1m != null) s += clamp(ind.rsSector1m * 0.6, -6, 6);
  // 52-week position (max 4)
  if (ind.pct52w > 85) s += 4;
  else if (ind.pct52w < 15) s -= 4;
  return clamp(Math.round(s + 18), 0, 100); // rebased: neutral ≈ 25-40
}

// Shorts must be validated by structure, not just negative price action:
// without breakdown evidence (below long-term trend / death cross / range
// breakdown / lower-high sequence) the score is hard-capped below setup grade.
export function scoreShort(ind: Indicators): number {
  const structureGate =
    (ind.price < ind.sma200 || ind.crossStatus === "death_formed") &&
    (ind.rangeState === "breakdown" || ind.structure === "lower_highs" ||
      (ind.price < ind.sma50 && (ind.slope20 ?? 0) < -0.05));

  let s = 0;
  // Trend structure (max 30)
  if (ind.price < ind.sma200) s += 10;
  if (ind.sma50 < ind.sma200) s += 8;
  if ((ind.slope20 ?? 0) < -0.05) s += 6;
  if (ind.structure === "lower_highs") s += 6;
  else if (ind.structure === "higher_lows") s -= 6;
  // Cross context (max 10)
  if (ind.crossStatus === "death_formed") s += 10;
  else if (ind.crossStatus === "golden_formed") s -= 12;
  // Momentum quality (capped ~20; crowded oversold is penalized, not rewarded)
  s += clamp(-ind.mom3m * 0.35, -8, 10);
  s += clamp(-ind.mom6m * 0.1, -4, 5);
  if (ind.rsi14 != null) {
    if (ind.rsi14 >= 35 && ind.rsi14 <= 55) s += 5;        // fading rallies, room below
    else if (ind.rsi14 < 25) s -= 8;                        // capitulation — bounce risk
    else if (ind.rsi14 > 65) s -= 3;                        // shorting strength
  }
  // Trend confirmation (max 6)
  if (ind.macdHist != null && ind.macdHist < 0) s += 6;
  // Volume confirmation (max 8)
  if (ind.rangeState === "breakdown" && ind.rangeVolConfirmed) s += 5;
  if (ind.volTrend > 1.15 && ind.mom1m < 0) s += 3;        // distribution volume
  // Structure/levels (max 14)
  if (ind.rangeState === "breakdown") s += ind.rangeVolConfirmed ? 8 : 4;
  else if (ind.rangeState === "breakout") s -= 8;
  if (ind.resistance != null && ind.atrPct != null && ind.atrPct > 0) {
    const distToResAtr = ((ind.resistance - ind.price) / ind.price) * 100 / ind.atrPct;
    if (distToResAtr <= 1.5) s += 3;                       // defined risk below resistance
  }
  if (ind.extension != null) {
    if (Math.abs(ind.extension) < 2.5) s += 3;
    else if (ind.extension < -3.5) s -= 6;                 // chasing a waterfall
  }
  // Relative weakness (max 12)
  if (ind.rsSpy1m != null) s += clamp(-ind.rsSpy1m * 0.6, -6, 6);
  if (ind.rsSector1m != null) s += clamp(-ind.rsSector1m * 0.6, -6, 6);
  // 52-week position (max 4)
  if (ind.pct52w < 15) s += 4;
  else if (ind.pct52w > 85) s -= 4;
  const raw = clamp(Math.round(s + 18), 0, 100);
  return structureGate ? raw : Math.min(raw, 35); // no structure → never setup-grade
}

export function directionOf(longScore: number, shortScore: number): "long" | "short" | "none" {
  if (longScore >= 60 && longScore >= shortScore) return "long";
  if (shortScore >= 60 && shortScore > longScore) return "short";
  return "none";
}

export interface ScreenRow {
  ticker: string;
  score: number;        // = long score (back-compat)
  long_score: number;
  short_score: number;
  direction: string;
  sector: string;
  cross_status: string;
  indicators: Indicators;
  updated_at: number;
  held: boolean;
  market_cap: number | null; // from the universe table (dashboard filters)
}

export async function getScreenerRows(portfolio: Portfolio): Promise<ScreenRow[]> {
  const heldSet = new Set(portfolio.holdings.map((h) => h.ticker));
  const rows = await db
    .query(`SELECT s.*, u.market_cap FROM screener s LEFT JOIN universe u ON u.ticker = s.ticker ORDER BY s.score DESC`)
    .all() as any[];
  return rows.map((r) => ({
    ticker: r.ticker,
    score: r.score,
    long_score: r.long_score ?? r.score,
    short_score: r.short_score ?? 0,
    direction: r.direction ?? "none",
    sector: r.sector ?? "Unknown",
    cross_status: r.cross_status,
    indicators: JSON.parse(r.indicators),
    updated_at: r.updated_at,
    held: heldSet.has(r.ticker),
    market_cap: r.market_cap ?? null,
  }));
}

// Per-sector board: rotation state + breadth + the strongest long and short
// setups inside each sector, so ideas are presented by sector rather than as
// one undifferentiated market-wide list.
export interface SectorBoard {
  sector: string;
  etf: string;
  rotation: { ret1w: number; ret1m: number; rel1m: number; state: string } | null;
  scanned: number;
  breadthPct: number | null;
  longs: { ticker: string; long_score: number; price: number; held: boolean }[];
  shorts: { ticker: string; short_score: number; price: number; held: boolean }[];
}

export async function sectorBoards(portfolio: Portfolio): Promise<SectorBoard[]> {
  const rows = await getScreenerRows(portfolio);
  const rotation = new Map(((await getMarketSnapshot())?.sectors ?? []).map((s) => [s.sector, s]));
  const bySector = new Map<string, ScreenRow[]>();
  for (const r of rows) {
    if (!bySector.has(r.sector)) bySector.set(r.sector, []);
    bySector.get(r.sector)!.push(r);
  }
  const boards: SectorBoard[] = [];
  for (const [sector, rs] of bySector) {
    if (sector === "Unknown" && rs.length < 3) continue;
    const rot = rotation.get(sector) ?? null;
    const above200 = rs.filter((r) => r.indicators.pctVs200 > 0).length;
    boards.push({
      sector,
      etf: sectorEtf(sector),
      rotation: rot ? { ret1w: rot.ret1w, ret1m: rot.ret1m, rel1m: rot.rel1m, state: rot.state } : null,
      scanned: rs.length,
      breadthPct: rs.length ? (100 * above200) / rs.length : null,
      longs: rs
        .filter((r) => r.direction === "long")
        .sort((a, b) => b.long_score - a.long_score)
        .slice(0, 4)
        .map((r) => ({ ticker: r.ticker, long_score: r.long_score, price: r.indicators.price, held: r.held })),
      shorts: rs
        .filter((r) => r.direction === "short")
        .sort((a, b) => b.short_score - a.short_score)
        .slice(0, 4)
        .map((r) => ({ ticker: r.ticker, short_score: r.short_score, price: r.indicators.price, held: r.held })),
    });
  }
  // Leading sectors first (by 1m relative strength), unknown-rotation last.
  boards.sort((a, b) => (b.rotation?.rel1m ?? -999) - (a.rotation?.rel1m ?? -999));
  return boards;
}

// True while a full universe scan is fetching from Yahoo. The on-demand
// /api/ticker path checks this and backs off, so ⌘K browsing can't race the
// ~2400 paced scan fetches into 429s that stall both.
let scanRunning = false;
export const isScanRunning = () => scanRunning;

// Full universe scan. Returns pipeline events for newly-formed setups.
export async function runScan(portfolio: Portfolio): Promise<RawEvent[]> {
  scanRunning = true;
  try {
  // Benchmarks must be loaded for RS/beta math — refresh if the cache is cold.
  if (!benchmarkCandles("SPY")) await refreshMarketContext();
  const spyCloses = benchmarkCandles("SPY")?.closes ?? null;

  const tickers = await scanUniverse();
  const sectors = await sectorMap();
  const heldSet = new Set(portfolio.holdings.map((h) => h.ticker));
  const regime = (await getMarketSnapshot())?.regime;
  const concurrency = loadUniverseFilters().concurrency;
  console.log(`[screener] scanning ${tickers.length} tickers, concurrency ${concurrency} (~${Math.max(1, Math.round((tickers.length * 0.4) / 60 / concurrency))} min)`);
  const events: RawEvent[] = [];
  let scanned = 0;
  // Why scanned < tickers.length: no_data = Yahoo returned nothing (delisted,
  // renamed, or throttled); short_history = candles exist but under the ~1y the
  // indicator math needs; error = fetch/scoring threw.
  const skips = { no_data: 0, short_history: 0, error: 0 };

  const upsert = db.query(
    `INSERT INTO screener (ticker, score, long_score, short_score, direction, sector, cross_status, indicators, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, extract(epoch from now())::int)
     ON CONFLICT(ticker) DO UPDATE SET score=excluded.score, long_score=excluded.long_score,
       short_score=excluded.short_score, direction=excluded.direction, sector=excluded.sector,
       cross_status=excluded.cross_status, indicators=excluded.indicators, updated_at=excluded.updated_at`
  );

  const week = new Date().toISOString().slice(0, 10).slice(0, 8) + String(Math.ceil(new Date().getDate() / 7));
  const emit = async (t: string, ind: Indicators, extra: object, kind: string, title: string, key: string) => {
    const now = Math.floor(Date.now() / 1000);
    const id = await insertEvent({ ts: now, ticker: t, kind, title, detail: { ...ind, ...extra }, dedupeKey: key });
    if (id) events.push({ id, ts: now, ticker: t, kind, title, detail: { ...ind, ...extra } });
  };
  // Pick/short events are emitted top-N AFTER the full pass, so a broad rally
  // can't flood triage — the event budget per scan is bounded by construction.
  const pickCands: { t: string; ind: Indicators; score: number; sector: string }[] = [];
  const shortCands: { t: string; ind: Indicators; score: number; sector: string }[] = [];

  // Bounded-concurrency pool over Yahoo's unauthenticated candle endpoint.
  // Each worker keeps the 180ms politeness delay, so aggregate request rate is
  // concurrency × ~5.5 req/s. If Yahoo starts failing (nulls/429s), workers
  // above the first two park themselves for the rest of the scan.
  let cursor = 0;
  let recentFailures = 0; // rolling penalty: +1 per null fetch, -1 (floor 0) per success
  const scanOne = async (t: string) => {
    const candles = await fetchDailyCandles(t);
    if (!candles) { recentFailures++; skips.no_data++; return; }
    recentFailures = Math.max(0, recentFailures - 1);
    const sector = sectors.get(t) ?? "Unknown";
    const sectorCloses = benchmarkCandles(sectorEtf(sector))?.closes ?? null;
    const ind = computeIndicators(candles, spyCloses, sectorCloses);
    if (!ind) { skips.short_history++; return; }
    const longScore = scoreLong(ind);
    const shortScore = scoreShort(ind);
    const direction = directionOf(longScore, shortScore);
    scanned++;
    if (scanned % 200 === 0) console.log(`[screener] progress: ${scanned}/${tickers.length}`);

    await upsert.run(t, longScore, longScore, shortScore, direction, sector, ind.crossStatus, JSON.stringify(ind));

    // Cross events are self-rate-limited by the 10-session formation window.
    const extra = { longScore, shortScore, sector };
    if (ind.crossStatus === "golden_formed" && longScore >= 65) {
      await emit(t, ind, extra, "golden_cross", `${t} golden cross formed — ${ind.crossDetail} (long score ${longScore})`, `gx:${t}:${week}`);
    } else if (ind.crossStatus === "golden_soon" && longScore >= 68) {
      await emit(t, ind, extra, "golden_cross", `${t} golden cross approaching — ${ind.crossDetail} (long score ${longScore})`, `gxsoon:${t}:${week}`);
    } else if (ind.crossStatus === "death_formed" && heldSet.has(t)) {
      await emit(t, ind, extra, "death_cross", `${t} DEATH CROSS on a held position — ${ind.crossDetail}`, `dx:${t}:${week}`);
    }
    if (longScore >= 84 && !regime?.riskOff) pickCands.push({ t, ind, score: longScore, sector });
    if (shortScore >= 84) shortCands.push({ t, ind, score: shortScore, sector });
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async (_, w) => {
      while (cursor < tickers.length) {
        // Failure spike (sustained nulls): park every worker beyond the first
        // two — serial-ish pace is the safe fallback, and successes heal the counter.
        if (w >= 2 && recentFailures >= 15) {
          console.log(`[screener] worker ${w} parked — Yahoo failure spike (${recentFailures} rolling)`);
          return;
        }
        const t = tickers[cursor++];
        try {
          await scanOne(t);
        } catch (err) {
          recentFailures++;
          skips.error++;
          console.error(`[screener] ${t}:`, err);
        }
        await Bun.sleep(180); // be polite to Yahoo
      }
    })
  );

  // Only the strongest confluences in the whole universe become events.
  for (const c of pickCands.sort((a, b) => b.score - a.score).slice(0, 12)) {
    await emit(c.t, c.ind, { longScore: c.score, sector: c.sector }, "screener_pick",
      `${c.t} strong multi-factor LONG setup (${c.sector}, long score ${c.score}/100)`, `pick:${c.t}:${week}`);
  }
  for (const c of shortCands.sort((a, b) => b.score - a.score).slice(0, 8)) {
    await emit(c.t, c.ind, { shortScore: c.score, sector: c.sector }, "screener_short",
      `${c.t} strong multi-factor SHORT setup (${c.sector}, short score ${c.score}/100 — structural breakdown confirmed)`, `short:${c.t}:${week}`);
  }
  // Prune rows for tickers that left the universe (delistings, filter changes) —
  // but only after a substantially complete pass, never after an aborted one.
  if (scanned > tickers.length * 0.5) {
    const pruned = (await db.query(`DELETE FROM screener WHERE updated_at < extract(epoch from now())::int - 172800 RETURNING ticker`).all()).length;
    if (pruned) console.log(`[screener] pruned ${pruned} stale rows (out of universe >48h)`);
  }
  const skipped = tickers.length - scanned;
  const skipDetail = skipped
    ? ` (skipped ${skipped}: ${skips.no_data} no Yahoo data — delisted/renamed/throttled, ${skips.short_history} under ~1y history, ${skips.error} errors, ${skipped - skips.no_data - skips.short_history - skips.error} unstarted)`
    : "";
  console.log(`[screener] scan complete: ${scanned}/${tickers.length} scored${skipDetail}, ${events.length} new setups`);
  return events;
  } finally {
    scanRunning = false;
  }
}
