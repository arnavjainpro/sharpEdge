// Full-market universe: every listed US stock with sector/industry/market-cap
// metadata from NASDAQ's screener feed (one request, ~7000 rows), filtered to a
// liquid, scannable subset. Replaces the old S&P-500-only universe: the scan now
// spans large/mid/small caps ranked by dollar volume, and every ticker carries a
// sector so ideas can be grouped and compared within their sector.
import { parse } from "yaml";
import { readFileSync } from "fs";
import { join } from "path";
import { db } from "../db";
import { loadUniverseFilters, allTickers, type Portfolio } from "../config";

export interface UniverseRow {
  ticker: string;
  name: string;
  sector: string;      // "Technology", "Finance", ... "Unknown" when the feed has none
  industry: string;
  marketCap: number;
  lastPrice: number;
  dayVolume: number;
  sp500: boolean;
  inScan: boolean;
}

// NASDAQ sector taxonomy → SPDR sector ETF used for relative-strength and rotation.
export const SECTOR_ETF: Record<string, string> = {
  Technology: "XLK",
  "Health Care": "XLV",
  Finance: "XLF",
  Energy: "XLE",
  Utilities: "XLU",
  "Basic Materials": "XLB",
  Industrials: "XLI",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  "Real Estate": "XLRE",
  Telecommunications: "XLC",
};
export const sectorEtf = (sector: string | null | undefined) => SECTOR_ETF[sector ?? ""] ?? "SPY";

const num = (s: any) => {
  const n = Number(String(s ?? "").replace(/[$,%]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// Base symbol + optional one-letter class suffix. NASDAQ's feed writes class
// shares with a slash (BRK/B); the S&P list uses dots (BRK.B); Yahoo uses
// dashes (BRK-B). Accept all three, store dash form. Still skips ^-preferreds,
// units/warrants, and multi-letter suffix garbage.
export const SYMBOL_RE = /^[A-Z]{1,5}([./-][A-Z])?$/;
// Storage convention is dash form (Yahoo-compatible, matches fetchSP500).
export const normalizeSymbol = (s: string) => s.trim().toUpperCase().replace(/[./]/g, "-");

async function fetchNasdaq(path: string): Promise<any[]> {
  const res = await fetch(`https://api.nasdaq.com/api/screener/${path}?tableonly=true&limit=0&download=true`, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sharpEdge personal-use", Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`nasdaq ${path} ${res.status}`);
  const data = (await res.json()) as any;
  // stocks nests rows at data.rows; the etf endpoint at data.data.rows: accept either.
  return data?.data?.rows ?? data?.data?.data?.rows ?? [];
}

async function fetchNasdaqScreener(): Promise<UniverseRow[]> {
  const rows = await fetchNasdaq("stocks");
  return rows
    .filter((r) => SYMBOL_RE.test(r.symbol ?? ""))
    .map((r) => ({
      ticker: normalizeSymbol(r.symbol),
      name: String(r.name ?? "").replace(/ (Common|Class [A-Z]|Ordinary).*$/i, ""),
      sector: r.sector?.trim() || "Unknown",
      industry: r.industry?.trim() || "Unknown",
      marketCap: num(r.marketCap),
      lastPrice: num(r.lastsale),
      dayVolume: num(r.volume),
      sp500: false,
      inScan: false,
    }));
}

// ETFs: stored for search/on-demand scoring, never scanned (unless held/watched -
// dollar-volume ranking would let SPY/QQQ crowd stocks out of the scan slots).
// Feed has no sector/marketCap; field names differ from the stocks feed.
async function fetchNasdaqEtfs(): Promise<UniverseRow[]> {
  const rows = await fetchNasdaq("etf");
  return rows
    .filter((r) => SYMBOL_RE.test(r.symbol ?? ""))
    .map((r) => ({
      ticker: normalizeSymbol(r.symbol),
      name: String(r.companyName ?? r.name ?? "").trim() || normalizeSymbol(r.symbol),
      sector: "ETF",
      industry: "ETF",
      marketCap: 0,
      lastPrice: num(r.lastSalePrice ?? r.lastsale),
      dayVolume: num(r.volume),
      sp500: false,
      inScan: false,
    }));
}

// Current S&P 500 constituents from a maintained public dataset. Yahoo uses
// dashes where the index uses dots (BRK.B → BRK-B).
export async function fetchSP500(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
    );
    if (!res.ok) return [];
    const csv = await res.text();
    return csv
      .split("\n")
      .slice(1)
      .map((l) => l.split(",")[0]?.trim().toUpperCase() ?? "")
      .filter((t) => /^[A-Z.\-]{1,6}$/.test(t))
      .map((t) => t.replace(/\./g, "-"));
  } catch {
    return [];
  }
}

function extraTickersFromConfig(): string[] {
  try {
    const raw = parse(readFileSync(join(import.meta.dir, "../../config/screener.yaml"), "utf-8"));
    return (raw?.universe ?? []).map((t: any) => String(t).toUpperCase());
  } catch {
    return [];
  }
}

// Rebuild the universe table. Returns the active scan list (tickers).
// Selection: pass liquidity filters OR be an S&P 500 name OR be held/watched/config-listed;
// then rank by dollar volume and cap at max_stocks (protected names always kept).
export async function refreshUniverse(portfolio: Portfolio): Promise<string[]> {
  const filters = loadUniverseFilters();
  const [sp500, extras] = [await fetchSP500(), extraTickersFromConfig()];
  const protectedSet = new Set([...sp500, ...extras, ...allTickers(portfolio)].map(normalizeSymbol));

  // Feeds fetched independently: an ETF-endpoint breakage must not shrink the
  // stock universe (and vice versa).
  let all: UniverseRow[] = [];
  try {
    all = await fetchNasdaqScreener();
    console.log(`[universe] NASDAQ feed: ${all.length} listed stocks`);
  } catch (err) {
    console.warn("[universe] NASDAQ feed failed: falling back to S&P 500 + config:", err);
  }
  let etfs: UniverseRow[] = [];
  try {
    etfs = await fetchNasdaqEtfs();
    console.log(`[universe] NASDAQ ETF feed: ${etfs.length} ETFs`);
  } catch (err) {
    console.warn("[universe] NASDAQ ETF feed failed: ETFs skipped this refresh:", err);
  }

  const bySymbol = new Map(all.map((r) => [r.ticker, r]));
  const etfSet = new Set(etfs.map((r) => r.ticker));
  for (const r of etfs) if (!bySymbol.has(r.ticker)) bySymbol.set(r.ticker, r);
  // Protected names missing from the feed (dots→dashes classes etc.) still scan.
  for (const t of protectedSet) {
    if (!bySymbol.has(t)) {
      bySymbol.set(t, {
        ticker: t, name: t, sector: "Unknown", industry: "Unknown",
        marketCap: 0, lastPrice: 0, dayVolume: 0, sp500: false, inScan: false,
      });
    }
  }
  for (const t of sp500) {
    const r = bySymbol.get(t);
    if (r) r.sp500 = true;
  }

  const rows = [...bySymbol.values()];
  const passes = (r: UniverseRow) =>
    r.marketCap >= filters.min_market_cap &&
    r.lastPrice >= filters.min_price &&
    r.dayVolume >= filters.min_volume;

  // ETFs never compete for scan slots unless held/watched/config-listed.
  const candidates = rows
    .filter((r) => protectedSet.has(r.ticker) || (!etfSet.has(r.ticker) && passes(r)))
    .sort((a, b) => b.lastPrice * b.dayVolume - a.lastPrice * a.dayVolume);

  const scan = new Set<string>();
  for (const r of candidates) {
    if (scan.size >= filters.max_stocks && !protectedSet.has(r.ticker)) continue;
    scan.add(r.ticker);
  }
  for (const r of rows) r.inScan = scan.has(r.ticker);

  // Chunked multi-row upsert. Over network Postgres a row-at-a-time loop would be
  // ~12k round-trips (minutes) and blocks boot; batching keeps it to a handful of
  // statements. 9 bound params/row (updated_at is a server-side literal) → stay
  // well under Postgres's 65535-param cap.
  const now = Math.floor(Date.now() / 1000);
  const ROWS_PER_CHUNK = 5000;
  for (let i = 0; i < rows.length; i += ROWS_PER_CHUNK) {
    const chunk = rows.slice(i, i + ROWS_PER_CHUNK);
    const values = chunk.map(() => `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).join(", ");
    const params: (string | number)[] = [];
    for (const r of chunk) {
      params.push(r.ticker, r.name, r.sector, r.industry, r.marketCap, r.lastPrice, r.dayVolume, r.sp500 ? 1 : 0, r.inScan ? 1 : 0, now);
    }
    await db.query(
      `INSERT INTO universe (ticker, name, sector, industry, market_cap, last_price, day_volume, sp500, in_scan, updated_at)
       VALUES ${values}
       ON CONFLICT(ticker) DO UPDATE SET name=excluded.name, sector=excluded.sector, industry=excluded.industry,
         market_cap=excluded.market_cap, last_price=excluded.last_price, day_volume=excluded.day_volume,
         sp500=excluded.sp500, in_scan=excluded.in_scan, updated_at=excluded.updated_at`
    ).run(...params);
  }

  console.log(`[universe] scan universe: ${scan.size} tickers (filters: cap≥$${(filters.min_market_cap / 1e6).toFixed(0)}M, px≥$${filters.min_price}, vol≥${filters.min_volume / 1000}k, max ${filters.max_stocks})`);
  return [...scan];
}

export async function scanUniverse(): Promise<string[]> {
  return (await db.query(`SELECT ticker FROM universe WHERE in_scan = 1`).all<{ ticker: string }>()).map((r) => r.ticker);
}

export async function universeMeta(ticker: string): Promise<{ name: string; sector: string; industry: string; marketCap: number } | null> {
  const r = await db.query(`SELECT name, sector, industry, market_cap FROM universe WHERE ticker = ?`).get(ticker) as any;
  return r ? { name: r.name, sector: r.sector ?? "Unknown", industry: r.industry ?? "Unknown", marketCap: r.market_cap ?? 0 } : null;
}

// ticker → sector for a set of tickers (screener rows join).
export async function sectorMap(): Promise<Map<string, string>> {
  const rows = await db.query(`SELECT ticker, sector FROM universe`).all<{ ticker: string; sector: string | null }>();
  return new Map(rows.map((r) => [r.ticker, r.sector ?? "Unknown"]));
}
