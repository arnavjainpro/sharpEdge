// Futures support (level 1: searchable / scorable / chartable, like equities).
//
// Continuous front-month futures are seeded into the `universe` table so the
// existing search, screener, and stock-detail paths pick them up unchanged.
// Symbols are Yahoo's continuous-contract form (ES=F, CL=F, …) — the same
// symbol we fetch candles for — kept as the canonical ticker to avoid colliding
// with real equity tickers (e.g. "ES" is Eversource Energy).
//
// Scoring reuses the equity pipeline: technicals/trend/RSI/MACD are price-only
// and work on any candle series; sector relative-strength falls back to SPY
// (sectorEtf returns "SPY" for the unknown "Futures" sector), so a future is
// scored on its own trend + strength vs the S&P, which is the sensible default.
import { db } from "../db";

export type FutureGroup = "index" | "energy" | "metals";
export interface FutureDef {
  symbol: string; // Yahoo continuous-contract symbol, also the canonical ticker
  name: string;
  group: FutureGroup;
}

// Equity index + energy & metals (the demo set).
export const FUTURES: FutureDef[] = [
  { symbol: "ES=F", name: "E-mini S&P 500", group: "index" },
  { symbol: "NQ=F", name: "E-mini Nasdaq-100", group: "index" },
  { symbol: "YM=F", name: "E-mini Dow", group: "index" },
  { symbol: "RTY=F", name: "E-mini Russell 2000", group: "index" },
  { symbol: "CL=F", name: "Crude Oil (WTI)", group: "energy" },
  { symbol: "NG=F", name: "Natural Gas", group: "energy" },
  { symbol: "GC=F", name: "Gold", group: "metals" },
  { symbol: "SI=F", name: "Silver", group: "metals" },
  { symbol: "HG=F", name: "Copper", group: "metals" },
];

const FUTURES_SET = new Set(FUTURES.map((f) => f.symbol));

// True for a seeded futures symbol. Used to widen ticker validation (the `=`
// in "ES=F" fails the equity ticker regexes).
export const isFuture = (sym: string): boolean => FUTURES_SET.has((sym ?? "").trim().toUpperCase());

// Seed the futures contracts into the universe (idempotent). `in_scan = 1` so
// the 6-hourly screener scores them alongside equities; market_cap/price/volume
// are left at 0 (the scan fills price/indicators, and futures have no cap).
export async function seedFutures(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const values = FUTURES.map(() => `(?, ?, 'Futures', ?, 0, 0, 0, 0, 1, ?)`).join(", ");
  const params: (string | number)[] = [];
  for (const f of FUTURES) params.push(f.symbol, f.name, f.group, now);
  await db.query(
    `INSERT INTO universe (ticker, name, sector, industry, market_cap, last_price, day_volume, sp500, in_scan, updated_at)
     VALUES ${values}
     ON CONFLICT(ticker) DO UPDATE SET name = excluded.name, sector = excluded.sector,
       industry = excluded.industry, in_scan = 1`
  ).run(...params);
  console.log(`[futures] seeded ${FUTURES.length} futures contracts (index + energy/metals)`);
}
