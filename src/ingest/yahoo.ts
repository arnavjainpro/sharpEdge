// Price history via Yahoo's public chart API — free, no key.
// Daily OHLCV is the fallback behind FMP (see ingest/candles.ts) and the only
// source for the intraday bars the intraday analyzer needs. Polite pacing +
// 429 backoff. Callers should import from ./candles, not from here.

import type { DailyCandles, IntradayBars } from "./candles";

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh) sharpEdge personal-use" };

async function fetchChart(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.status === 429) {
        // Rate-limited: one patient retry, then give up on this symbol.
        if (attempt === 0) {
          console.warn("[yahoo] 429 rate limit — backing off 30s");
          await Bun.sleep(30_000);
          continue;
        }
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
  return null;
}

function parseBars(data: any): Omit<DailyCandles, "ticker"> | null {
  const result = data?.chart?.result?.[0];
  if (!result?.timestamp) return null;
  const quote = result.indicators?.quote?.[0];
  const out = { opens: [] as number[], highs: [] as number[], lows: [] as number[], closes: [] as number[], volumes: [] as number[], timestamps: [] as number[] };
  for (let i = 0; i < result.timestamp.length; i++) {
    const c = quote?.close?.[i];
    if (c == null) continue; // skip holiday/null rows
    out.closes.push(c);
    out.opens.push(quote?.open?.[i] ?? c);
    out.highs.push(quote?.high?.[i] ?? c);
    out.lows.push(quote?.low?.[i] ?? c);
    out.volumes.push(quote?.volume?.[i] ?? 0);
    out.timestamps.push(result.timestamp[i]);
  }
  return out.closes.length ? out : null;
}

// minBars: reject series too short for the caller's math (e.g. SMA200 needs 210).
//
// `range=max` is a trap. Yahoo does not refuse it — it silently drops to
// QUARTERLY bars (168 of them for AAPL, 90 days apart) while still saying
// interval=1d. Every caller asking for the deepest history therefore got a
// series both too short and too coarse: /api/backtest requires 250 bars and so
// failed with "not enough price history" on EVERY ticker, and the stock chart's
// ALL tab was drawing quarterly candles. Named ranges up to 10y are genuinely
// daily; only `max` degrades. period1/period2 returns true daily bars over the
// same span (11,497 for AAPL, back to its 1980 IPO) and clamps to the listing
// date for young tickers.
export async function fetchDailyCandlesYahoo(ticker: string, range = "1y", minBars = 210): Promise<DailyCandles | null> {
  const sym = encodeURIComponent(ticker);
  const url = range === "max"
    ? `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d`
    : `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=1d`;
  const data = await fetchChart(url);
  const bars = data ? parseBars(data) : null;
  if (!bars || bars.closes.length < minBars) return null;
  return { ticker, ...bars };
}

// Intraday OHLCV. Yahoo constraints: 1m ≤ 7d back, 5m/15m ≤ 60d.
export async function fetchIntradayBars(
  ticker: string,
  interval: "1m" | "5m" | "15m" | "60m",
  range?: string
): Promise<IntradayBars | null> {
  const r = range ?? (interval === "1m" ? "1d" : interval === "60m" ? "1mo" : "5d");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${r}&interval=${interval}&includePrePost=false`;
  const data = await fetchChart(url);
  const bars = data ? parseBars(data) : null;
  if (!bars || bars.closes.length < 10) return null;
  const meta = data.chart.result[0].meta ?? {};
  return {
    ticker,
    ...bars,
    interval,
    prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    regularMarketPrice: meta.regularMarketPrice ?? null,
  };
}
