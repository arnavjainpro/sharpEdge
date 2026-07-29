import { test, expect, afterEach, afterAll } from "bun:test";

import { fetchDailyCandlesFmp, isRestricted, fmpQuotaBlocked, _clearRestricted, _clearQuotaBlock } from "./fmp";
import { config } from "../config";

// fmp.ts no-ops without a key. Setting FMP_API_KEY here would be too late in a
// full-suite run — config snapshots process.env at import, and another test file
// may already have pulled it in. Writing the field is order-independent.
const realKey = config.fmpKey;
config.fmpKey = "test-key";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  _clearRestricted();
  _clearQuotaBlock();
});
afterAll(() => {
  config.fmpKey = realKey;
});

// FMP's own ordering: newest first.
const row = (date: string, close: number) => ({ date, open: close - 1, high: close + 1, low: close - 2, close, volume: 1_000_000 });

function stub(body: unknown, ok = true) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
  }) as unknown as typeof fetch;
  return () => calls;
}

// Plan refusals come back as 402 carrying bare prose — NOT JSON, and NOT a 200.
// Stubbing them as JSON, or as an ok response, hides both halves of the bug:
// JSON.parse throws on the body, and an early !res.ok bail skips the check.
function stubRaw(text: string, status = 402) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(text, { status });
  }) as unknown as typeof fetch;
  return () => calls;
}

test("newest-first payload is reversed to oldest → newest", async () => {
  stub([row("2026-07-28", 103), row("2026-07-27", 102), row("2026-07-24", 101)]);
  const c = await fetchDailyCandlesFmp("AAPL", "1y", 3);
  expect(c!.closes).toEqual([101, 102, 103]);
  expect(c!.timestamps[0]).toBeLessThan(c!.timestamps[2]);
  expect(c!.opens).toEqual([100, 101, 102]);
  expect(c!.ticker).toBe("AAPL");
});

test("bars are stamped 09:30 ET, DST-correct on both sides of the boundary", async () => {
  // 2026-03-08 is the US spring-forward. 03-06 is EST (UTC-5) → 14:30Z,
  // 03-09 is EDT (UTC-4) → 13:30Z. A fixed offset would get one of them wrong.
  stub([row("2026-03-09", 101), row("2026-03-06", 100)]);
  const c = await fetchDailyCandlesFmp("AAPL", "1y", 2);
  const utc = c!.timestamps.map((t) => new Date(t * 1000).toISOString());
  expect(utc).toEqual(["2026-03-06T14:30:00.000Z", "2026-03-09T13:30:00.000Z"]);
});

test("a 402 + prose plan refusal returns null and is memoized, not re-requested", async () => {
  // Verbatim from the live API — unquoted prose, so JSON.parse throws on it.
  const calls = stubRaw("Premium Query Parameter: 'Special Endpoint : This value set for 'symbol' is not available under your current subscription");
  expect(await fetchDailyCandlesFmp("XLK", "1y", 1)).toBeNull();
  expect(isRestricted("XLK")).toBe(true);
  // Second call must not spend another request — this is what keeps a
  // 1,500-name screener pass from re-buying the same rejection.
  expect(await fetchDailyCandlesFmp("XLK", "1y", 1)).toBeNull();
  expect(calls()).toBe(1);
  // The memo is per-symbol, not global.
  expect(isRestricted("AAPL")).toBe(false);
});

test("a series shorter than minBars is rejected so the router falls through", async () => {
  stub([row("2026-07-28", 103), row("2026-07-27", 102)]);
  expect(await fetchDailyCandlesFmp("AAPL", "1y", 210)).toBeNull();
  // ...and a short series is not mistaken for a restricted symbol.
  expect(isRestricted("AAPL")).toBe(false);
});

test("null closes and malformed dates are skipped, not emitted as NaN", async () => {
  stub([row("2026-07-28", 103), { ...row("2026-07-27", 0), close: null }, row("not-a-date", 99), row("2026-07-24", 101)]);
  const c = await fetchDailyCandlesFmp("AAPL", "1y", 2);
  expect(c!.closes).toEqual([101, 103]);
  expect(c!.timestamps.every(Number.isFinite)).toBe(true);
});

test("a non-ok response is a plain miss, not a permanent restriction", async () => {
  stub([], false);
  expect(await fetchDailyCandlesFmp("AAPL", "1y", 1)).toBeNull();
  expect(isRestricted("AAPL")).toBe(false);
});

test("a spent request allowance trips a global breaker, not a per-symbol retry", async () => {
  // Verbatim from the live API after a screener pass burned the quota.
  const calls = stubRaw(JSON.stringify({ "Error Message": "Limit Reach . Please upgrade your plan" }), 429);
  expect(await fetchDailyCandlesFmp("AAPL", "1y", 1)).toBeNull();
  expect(fmpQuotaBlocked()).toBe(true);
  // The breaker is account-wide: OTHER symbols must stop calling too. Without
  // this, a ~3,000-name scan spends one futile round-trip per ticker.
  for (const t of ["NVDA", "MSFT", "TSLA"]) expect(await fetchDailyCandlesFmp(t, "1y", 1)).toBeNull();
  expect(calls()).toBe(1);
  // ...and quota exhaustion must not be mistaken for a permanent restriction.
  expect(isRestricted("AAPL")).toBe(false);
});

test("a bad key falls back without condemning the symbol for the process lifetime", async () => {
  // A revoked or mistyped key must not permanently pin every symbol to Yahoo —
  // fixing the key should be enough to recover, without a restart.
  stub({ "Error Message": "Invalid API KEY. Feel free to create a Free API Key" });
  expect(await fetchDailyCandlesFmp("AAPL", "1y", 1)).toBeNull();
  expect(isRestricted("AAPL")).toBe(false);
});

test("class shares are sent in FMP's dot form", async () => {
  let url = "";
  globalThis.fetch = (async (u: string) => {
    url = u;
    return new Response(JSON.stringify([row("2026-07-28", 100)]));
  }) as unknown as typeof fetch;
  await fetchDailyCandlesFmp("BRK-B", "1y", 1);
  expect(url).toContain("symbol=BRK.B");
  // Every request carries an explicit window: without `from`, FMP silently
  // caps history at ~5 years and would truncate the backtester's "max".
  expect(url).toContain("from=");
});
