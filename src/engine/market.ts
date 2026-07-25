// Market context engine: benchmark trend/volatility regime, sector rotation,
// and breadth. Pure math over free Yahoo data — no AI cost. Everything that
// judges an individual setup (screener scores, validator, intraday analyzer,
// briefings) reads this context so ideas are never rated in a vacuum.
import { db } from "../db";
import { fetchDailyCandles, type DailyCandles } from "../ingest/yahoo";
import { SECTOR_ETF } from "../ingest/universe";
import { sma, slopePctPerBar } from "./technicals";

// SPY/QQQ/IWM stay in the fetch set: SPY drives regime + every sector's rel1m +
// breadth (see refreshMarketContext), and QQQ/IWM feed relative-strength math.
// The ^-prefixed indices are added so the dashboard can DISPLAY the real indices
// (Dow/S&P/Nasdaq/Russell) instead of the ETF proxies — renderMarket picks which
// keys to show; the math keeps using SPY.
export const BENCHMARKS = ["SPY", "QQQ", "IWM", "^VIX", "^GSPC", "^DJI", "^IXIC", "^RUT"] as const;

export interface SectorRotation {
  sector: string;          // NASDAQ taxonomy name
  etf: string;
  ret1w: number;
  ret1m: number;
  ret3m: number;
  rel1m: number;           // 1m return minus SPY 1m return (relative strength)
  relTrend: number;        // rel1m now minus rel1m one week ago (improving vs fading)
  state: "leading" | "improving" | "weakening" | "lagging";
}

export interface MarketRegime {
  trend: "up" | "down" | "sideways";
  volatility: "low" | "normal" | "high";
  breadthPct: number | null;   // % of scanned stocks above their 200-day average
  riskOff: boolean;
  vix: number | null;
  vixChange5d: number | null;
  spyVs200: number | null;     // % above/below SMA200
  label: string;               // e.g. "Uptrend, normal volatility"
  description: string;         // one plain-English paragraph
}

export interface MarketSnapshot {
  ts: number;
  regime: MarketRegime;
  sectors: SectorRotation[];
  benchmarks: Record<string, { price: number; ret1d: number; ret1w: number; ret1m: number }>;
}

// In-memory benchmark candle cache — the screener reuses these closes for
// relative-strength and beta math without refetching per ticker.
const candleCache = new Map<string, DailyCandles>();
export const benchmarkCandles = (symbol: string) => candleCache.get(symbol) ?? null;

const pctBack = (closes: number[], bars: number) => {
  const n = closes.length;
  if (n <= bars) return 0;
  return ((closes[n - 1] - closes[n - 1 - bars]) / closes[n - 1 - bars]) * 100;
};

async function loadBenchmark(symbol: string): Promise<DailyCandles | null> {
  const c = await fetchDailyCandles(symbol, "1y", 60); // VIX etc. tolerate shorter history
  if (c) candleCache.set(symbol, c);
  await Bun.sleep(250);
  return c;
}

function classifySector(rel1m: number, relTrend: number): SectorRotation["state"] {
  if (rel1m >= 0) return relTrend >= 0 ? "leading" : "weakening";
  return relTrend >= 0 ? "improving" : "lagging";
}

// % of scanned stocks above their 200-day SMA, from the latest screener pass.
export async function computeBreadth(): Promise<number | null> {
  const row = await db
    .query(
      `SELECT COUNT(*)::int total,
              SUM(CASE WHEN (indicators::jsonb->>'pctVs200')::double precision > 0 THEN 1 ELSE 0 END)::int above
       FROM screener`
    )
    .get() as { total: number; above: number | null };
  if (!row.total) return null;
  return (100 * (row.above ?? 0)) / row.total;
}

export async function refreshMarketContext(): Promise<MarketSnapshot> {
  const symbols = [...BENCHMARKS, ...new Set(Object.values(SECTOR_ETF))];
  for (const s of symbols) await loadBenchmark(s);

  const spy = candleCache.get("SPY");
  const vixC = candleCache.get("^VIX");

  // ── Regime ──
  let trend: MarketRegime["trend"] = "sideways";
  let spyVs200: number | null = null;
  if (spy) {
    const closes = spy.closes;
    const price = closes.at(-1)!;
    const s50 = sma(closes, 50), s200 = sma(closes, 200);
    const slope20 = slopePctPerBar(closes, 20) ?? 0;
    if (s200 != null) spyVs200 = ((price - s200) / s200) * 100;
    if (s50 != null && s200 != null) {
      if (price > s50 && s50 > s200 && slope20 > 0.02) trend = "up";
      else if (price < s50 && (price < s200 || slope20 < -0.05)) trend = "down";
    }
  }
  const vix = vixC?.closes.at(-1) ?? null;
  const vixChange5d = vixC && vixC.closes.length > 5 ? vix! - vixC.closes.at(-6)! : null;
  const volatility: MarketRegime["volatility"] = vix == null ? "normal" : vix >= 25 ? "high" : vix <= 15 ? "low" : "normal";
  const breadthPct = await computeBreadth();
  const riskOff =
    (vix != null && vix >= 25) ||
    (trend === "down" && (vixChange5d ?? 0) > 3) ||
    (spyVs200 != null && spyVs200 < -3 && (breadthPct ?? 50) < 35);

  const trendWord = trend === "up" ? "Uptrend" : trend === "down" ? "Downtrend" : "Sideways/choppy";
  const regime: MarketRegime = {
    trend, volatility, breadthPct, riskOff, vix, vixChange5d, spyVs200,
    label: `${trendWord}, ${volatility} volatility${riskOff ? " — RISK-OFF" : ""}`,
    description:
      `S&P 500 is in a ${trendWord.toLowerCase()} regime` +
      (spyVs200 != null ? ` (${spyVs200 >= 0 ? "+" : ""}${spyVs200.toFixed(1)}% vs its 200-day average)` : "") +
      (vix != null ? `, VIX at ${vix.toFixed(1)}${vixChange5d != null ? ` (${vixChange5d >= 0 ? "+" : ""}${vixChange5d.toFixed(1)} over 5 sessions)` : ""}` : "") +
      (breadthPct != null ? `, ${breadthPct.toFixed(0)}% of scanned stocks above their 200-day average` : "") +
      (riskOff ? ". Conditions look risk-off: favor smaller size, tighter risk, and skepticism toward breakouts." : "."),
  };

  // ── Sector rotation ──
  const spyRet1m = spy ? pctBack(spy.closes, 21) : 0;
  const spyRet1mPrior = spy ? pctBack(spy.closes.slice(0, -5), 21) : 0;
  const sectors: SectorRotation[] = [];
  for (const [sector, etf] of Object.entries(SECTOR_ETF)) {
    const c = candleCache.get(etf);
    if (!c) continue;
    const rel1m = pctBack(c.closes, 21) - spyRet1m;
    const rel1mPrior = pctBack(c.closes.slice(0, -5), 21) - spyRet1mPrior;
    const relTrend = rel1m - rel1mPrior;
    sectors.push({
      sector, etf,
      ret1w: pctBack(c.closes, 5),
      ret1m: pctBack(c.closes, 21),
      ret3m: pctBack(c.closes, 63),
      rel1m, relTrend,
      state: classifySector(rel1m, relTrend),
    });
  }
  sectors.sort((a, b) => b.rel1m - a.rel1m);

  const benchmarks: MarketSnapshot["benchmarks"] = {};
  for (const s of BENCHMARKS) {
    const c = candleCache.get(s);
    if (!c) continue;
    benchmarks[s.replace("^", "")] = {
      price: c.closes.at(-1)!,
      ret1d: pctBack(c.closes, 1),
      ret1w: pctBack(c.closes, 5),
      ret1m: pctBack(c.closes, 21),
    };
  }

  const snapshot: MarketSnapshot = { ts: Math.floor(Date.now() / 1000), regime, sectors, benchmarks };
  await db.query(
    `INSERT INTO market_snapshot (id, ts, regime, sectors, benchmarks) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, regime=excluded.regime, sectors=excluded.sectors, benchmarks=excluded.benchmarks`
  ).run(snapshot.ts, JSON.stringify(regime), JSON.stringify(sectors), JSON.stringify(benchmarks));

  // F6a: append rotation history, but only when a sector's state changes or its
  // last row is ≥1h old — cadence-proof, so a burst of refreshes can't flood it.
  const lastFor = db.query(`SELECT state, ts FROM sector_history WHERE sector = ? ORDER BY ts DESC LIMIT 1`);
  const appendHist = db.query(`INSERT INTO sector_history (sector, ts, state, rel1m) VALUES (?, ?, ?, ?) ON CONFLICT (sector, ts) DO NOTHING`);
  for (const s of sectors) {
    const last = await lastFor.get(s.sector) as { state: string; ts: number } | null;
    if (!last || last.state !== s.state || snapshot.ts - last.ts >= 3600) {
      await appendHist.run(s.sector, snapshot.ts, s.state, s.rel1m);
    }
  }

  console.log(`[market] regime: ${regime.label} · sectors leading: ${sectors.filter((s) => s.state === "leading").map((s) => s.etf).join(",") || "none"}`);
  return snapshot;
}

export async function getMarketSnapshot(): Promise<MarketSnapshot | null> {
  const row = await db.query(`SELECT ts, regime, sectors, benchmarks FROM market_snapshot WHERE id = 1`).get() as any;
  if (!row) return null;
  return {
    ts: row.ts,
    regime: JSON.parse(row.regime),
    sectors: JSON.parse(row.sectors),
    benchmarks: JSON.parse(row.benchmarks),
  };
}

// Compact text block for AI prompts (validator, intraday, briefing, advisor).
export async function marketContextText(): Promise<string> {
  const snap = await getMarketSnapshot();
  if (!snap) return "MARKET CONTEXT: unavailable (no snapshot yet).";
  const r = snap.regime;
  const lines = [
    `MARKET CONTEXT (as of ${new Date(snap.ts * 1000).toISOString().slice(0, 16)} UTC):`,
    `- Regime: ${r.label}. ${r.description}`,
    `- Sector rotation (1-month return vs SPY, best→worst): ` +
      snap.sectors.map((s) => `${s.sector} ${s.rel1m >= 0 ? "+" : ""}${s.rel1m.toFixed(1)}% (${s.state})`).join(", "),
  ];
  return lines.join("\n");
}
