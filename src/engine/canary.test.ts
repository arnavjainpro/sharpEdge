import { expect, test } from "bun:test";
import { checkDailyShape, checkIntradayShape, checkQuoteShape, checkNewsShape } from "./canary";
import type { DailyCandles, IntradayBars } from "../ingest/yahoo";

// These validators ARE the canary — the probes around them are just plumbing.
// What's being pinned is that each one still rejects the specific failure it
// exists to catch, because a validator that quietly returns null for everything
// is worse than no canary at all: it reports green while the feed is gone.

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

// A healthy 1-year daily series ending today, oldest → newest.
function goodDaily(bars = 250): DailyCandles {
  const closes = Array.from({ length: bars }, (_, i) => 400 + Math.sin(i / 9) * 20);
  return {
    ticker: "SPY",
    closes: [...closes],
    opens: closes.map((c) => c - 1),
    highs: closes.map((c) => c + 2),
    lows: closes.map((c) => c - 2),
    volumes: closes.map(() => 70_000_000),
    // Newest bar is today; earlier bars step back one day each.
    timestamps: closes.map((_, i) => now() - (bars - 1 - i) * DAY),
  };
}

function goodIntraday(): IntradayBars {
  const d = goodDaily(40);
  return { ...d, interval: "15m", prevClose: 402, regularMarketPrice: 405 };
}

const goodQuote = () => ({ c: 405.2, d: 3.1, dp: 0.77, h: 406, l: 401, o: 402, pc: 402.1, t: now() });

test("healthy payloads pass every validator", () => {
  expect(checkDailyShape(goodDaily())).toBeNull();
  expect(checkIntradayShape(goodIntraday())).toBeNull();
  expect(checkQuoteShape(goodQuote())).toBeNull();
  expect(checkNewsShape([{ id: 1, datetime: now() - 3600, headline: "Something happened", source: "Reuters", summary: "", url: "https://x.test/1" }])).toBeNull();
});

test("a null response is always a complaint, never silence", () => {
  expect(checkDailyShape(null)).toBeString();
  expect(checkIntradayShape(null)).toBeString();
  expect(checkQuoteShape(null)).toBeString();
  expect(checkNewsShape(null)).toBeString();
});

// The whole point of range-checking: these all PARSE fine.
test("a units change is caught even though the payload parses", () => {
  // Prices in cents rather than dollars.
  const cents = goodDaily();
  cents.closes = cents.closes.map((c) => c * 100_000);
  cents.highs = cents.highs.map((c) => c * 100_000);
  expect(checkDailyShape(cents)).toBeString();

  // Quote timestamp in milliseconds rather than seconds.
  expect(checkQuoteShape({ ...goodQuote(), t: Date.now() })).toBeString();
  // News datetime in milliseconds.
  expect(checkNewsShape([{ id: 1, datetime: Date.now(), headline: "h", source: "s", summary: "", url: "u" }])).toBeString();
  // A percent field that's actually a fraction-turned-huge.
  expect(checkQuoteShape({ ...goodQuote(), dp: 412 })).toBeString();
});

test("daily candles: ordering, completeness and staleness all fail loudly", () => {
  // Newest-first, which Yahoo has served before and the engine assumes never happens.
  const reversed = goodDaily();
  reversed.timestamps = [...reversed.timestamps].reverse();
  expect(checkDailyShape(reversed)).toBeString();

  // Too short for SMA200 math.
  expect(checkDailyShape(goodDaily(120))).toBeString();

  // Feed alive but frozen a fortnight ago.
  const stale = goodDaily();
  stale.timestamps = stale.timestamps.map((t) => t - 14 * DAY);
  expect(checkDailyShape(stale)).toBeString();

  // Mismatched array lengths — a partial parse.
  const ragged = goodDaily();
  ragged.timestamps = ragged.timestamps.slice(0, -1);
  expect(checkDailyShape(ragged)).toBeString();

  // Impossible bar.
  const crossed = goodDaily();
  crossed.highs[5] = crossed.lows[5]! - 1;
  expect(checkDailyShape(crossed)).toBeString();

  // A null close that slipped through as zero.
  const zeroed = goodDaily();
  zeroed.closes[10] = 0;
  expect(checkDailyShape(zeroed)).toBeString();
});

test("intraday: losing the meta block is a break, not a shrug", () => {
  // The analyzer's gap math reads these; both absent means the shape moved.
  expect(checkIntradayShape({ ...goodIntraday(), prevClose: null, regularMarketPrice: null })).toBeString();
  // One of the two is enough.
  expect(checkIntradayShape({ ...goodIntraday(), prevClose: null })).toBeNull();
  // Present but nonsense is worse than absent.
  expect(checkIntradayShape({ ...goodIntraday(), regularMarketPrice: 0 })).toBeString();
});

test("news: an empty week is fine, a malformed item is not", () => {
  // Quiet names genuinely have no news — that must not page anyone.
  expect(checkNewsShape([])).toBeNull();
  expect(checkNewsShape([{ id: 1, datetime: now(), headline: "", source: "s", summary: "", url: "u" } as any])).toBeString();
  expect(checkNewsShape([{ id: 1, datetime: now(), source: "s", summary: "", url: "u" } as any])).toBeString();
  expect(checkNewsShape({ error: "nope" } as any)).toBeString();
});
