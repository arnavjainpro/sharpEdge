// On-demand single-ticker scoring for the search / ⌘K detail panel.
//
// The screener{} map only holds scores for the ~1500 scanned-universe tickers.
// To score ANY searched ticker we rerun the same pipeline here on demand:
//
//   sym ──▶ [validate] ──▶ [60s cache?] ──▶ [scan running? back off] ──▶
//           fetchDailyCandles ──▶ computeIndicators(candles, spy, sector) ──▶
//           scoreLong/scoreShort/directionOf  +  fetchCompanyNews (skip ^-index)
//
// Never writes the screener table (computeBreadth counts every row → off-universe
// rows would corrupt the regime breadth input and pollute sector boards).
import { db } from "../db";
import { fetchDailyCandles } from "../ingest/yahoo";
import { sectorEtf } from "../ingest/universe";
import { benchmarkCandles, refreshMarketContext } from "./market";
import { computeIndicators, scoreLong, scoreShort, directionOf, isScanRunning, type Indicators } from "./screener";
import { fetchCompanyNews } from "../ingest/finnhub";

// Leading ^ allowed for index symbols (^GSPC); 1-6 letters/dot/dash otherwise.
const VALID = /^\^?[A-Za-z.\-]{1,6}$/;
export const validTicker = (sym: string) => VALID.test(sym);

export interface TickerNews { headline: string; url: string; source: string; datetime: number }
export interface TickerResult {
  ticker: string;
  name: string | null;
  sector: string | null;
  price: number | null;
  long_score: number | null;
  short_score: number | null;
  direction: string | null;
  indicators: Indicators | null;
  news: TickerNews[];
  note?: string;        // why score is null, if it is
}
export type ScoreTickerOutcome =
  | { ok: true; data: TickerResult }
  | { ok: false; error: string; status: number };

const cache = new Map<string, { ts: number; data: TickerResult }>();
const TTL_MS = 60_000;

export async function scoreTicker(rawSym: string): Promise<ScoreTickerOutcome> {
  // BRK.B / BRK/B → BRK-B: storage and Yahoo use dash form (^-indexes untouched).
  const sym = (rawSym ?? "").trim().toUpperCase().replace(/[./]/g, "-");
  if (!validTicker(sym)) return { ok: false, error: "Invalid ticker", status: 400 };

  // During the 10-min screener run, serve stale cache instead of 503ing every
  // search — stale scores beat a dead search box. True misses still 503.
  const hit = cache.get(sym);
  if (hit && (Date.now() - hit.ts < TTL_MS || isScanRunning())) return { ok: true, data: hit.data };

  if (isScanRunning()) return { ok: false, error: "Scan in progress, retry shortly", status: 503 };

  const candles = await fetchDailyCandles(sym, "1y", 60);
  const meta = await db.query(`SELECT name, sector FROM universe WHERE ticker = ?`).get(sym) as
    | { name?: string; sector?: string }
    | null;
  const sector = meta?.sector ?? null;

  let indicators: Indicators | null = null;
  let note: string | undefined;
  if (candles) {
    if (!benchmarkCandles("SPY")) await refreshMarketContext();
    const spyCloses = benchmarkCandles("SPY")?.closes ?? null;
    const sectorCloses = sector ? benchmarkCandles(sectorEtf(sector))?.closes ?? null : null;
    indicators = computeIndicators(candles, spyCloses, sectorCloses);
    if (!indicators) note = "Not enough price history to score (needs ~1 year of trading).";
  } else {
    note = "No market data found for this symbol.";
  }

  // Finnhub /company-news 4xxs on ^-index symbols; skip news for those.
  let news: TickerNews[] = [];
  if (!sym.startsWith("^") && candles) {
    try {
      const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const items = await fetchCompanyNews(sym, iso(Date.now() - 7 * 86400_000), iso(Date.now()));
      news = (items ?? [])
        .slice(0, 8)
        .map((n) => ({ headline: n.headline, url: n.url, source: n.source, datetime: n.datetime }));
    } catch {
      /* news is best-effort — price + score still return */
    }
  }

  const longScore = indicators ? scoreLong(indicators) : null;
  const shortScore = indicators ? scoreShort(indicators) : null;
  const data: TickerResult = {
    ticker: sym,
    name: meta?.name ?? null,
    sector,
    price: candles ? candles.closes.at(-1)! : null,
    long_score: longScore,
    short_score: shortScore,
    direction: longScore != null && shortScore != null ? directionOf(longScore, shortScore) : null,
    indicators,
    news,
    note,
  };

  if (cache.size > 500) cache.clear(); // ponytail: crude cap; single-user dash never needs LRU
  cache.set(sym, { ts: Date.now(), data });
  return { ok: true, data };
}
