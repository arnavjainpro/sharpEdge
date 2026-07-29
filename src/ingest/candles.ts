// The one place the rest of the app asks for price history.
//
// Daily bars come from FMP when a key is configured, and from Yahoo otherwise —
// or when FMP declines the symbol, which its cheaper plans do for most ETFs and
// class shares. Intraday is Yahoo-only: FMP gates it behind a higher tier.
//
// Both providers emit the same DailyCandles shape, split-adjusted, stamped at
// 09:30 ET, so a series is interchangeable no matter which one served it.

import { fetchDailyCandlesFmp } from "./fmp";
import { fetchDailyCandlesYahoo } from "./yahoo";

export interface DailyCandles {
  ticker: string;
  opens: number[];    // oldest → newest
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
  timestamps: number[];
}

export interface IntradayBars extends DailyCandles {
  interval: string;
  prevClose: number | null;      // prior session close (for gap/session-change math)
  regularMarketPrice: number | null;
}

// minBars: reject series too short for the caller's math (e.g. SMA200 needs 210).
//
// For USER-FACING, single-symbol lookups: the stock page, ticker search, idea
// validation, backtests. These are a handful of requests at a time, which is
// what FMP's allowance can actually sustain.
export async function fetchDailyCandles(ticker: string, range = "1y", minBars = 210): Promise<DailyCandles | null> {
  return (await fetchDailyCandlesFmp(ticker, range, minBars)) ?? fetchDailyCandlesYahoo(ticker, range, minBars);
}

// For HIGH-VOLUME background paths — the ~3,100-name screener scan, idea replay,
// benchmark refresh. These skip FMP entirely and go straight to Yahoo.
//
// One full scan is ~3,100 requests and runs four times a day. That exhausts
// FMP's allowance within minutes of boot (measured), and once it's gone the
// breaker blocks FMP for everything — starving exactly the user-facing lookups
// it's worth spending on. Yahoo has no key and no quota, and on settled sessions
// the two agree to the penny, so the scan gives up nothing by using it.
export const fetchDailyCandlesBulk = fetchDailyCandlesYahoo;

export { fetchIntradayBars } from "./yahoo";
