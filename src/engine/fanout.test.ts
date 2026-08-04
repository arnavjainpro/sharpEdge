import { expect, test } from "bun:test";
import { buildWatchMap, unionPortfolio, type MonitoredUser } from "./fanout";
import type { Portfolio } from "../config";

// This is the routing layer for background monitoring: get it wrong and an
// account silently stops being watched, or gets charged twice for one event.
// Neither failure throws, which is why they're pinned here.

const pf = (holdings: string[], watchlist: string[] = []): Portfolio => ({
  holdings: holdings.map((ticker) => ({ ticker, shares: 10, cost_basis: 100 })),
  watchlist,
});
const user = (id: number, holdings: string[], watchlist: string[] = []): MonitoredUser =>
  ({ id, portfolio: pf(holdings, watchlist) });

test("a shared ticker maps to every account that watches it", () => {
  const map = buildWatchMap([
    user(1, ["NVDA", "AAPL"]),
    user(2, ["NVDA"], ["TSLA"]),
  ]);
  // NVDA is detected ONCE but interpreted for both: the whole point.
  expect(map.get("NVDA")).toEqual([1, 2]);
  expect(map.get("AAPL")).toEqual([1]);
  expect(map.get("TSLA")).toEqual([2]);
  // The detector loop walks these keys; a duplicate would mean paying Finnhub twice.
  expect([...map.keys()].length).toBe(new Set(map.keys()).size);
});

test("holding and watching the same ticker doesn't double-charge that account", () => {
  // Left unguarded this appends the id twice, and processEvent would run triage
  // (and the deep model) two times for one event on one account.
  const map = buildWatchMap([user(7, ["NVDA"], ["NVDA"])]);
  expect(map.get("NVDA")).toEqual([7]);
});

test("an account with nothing contributes nothing", () => {
  const map = buildWatchMap([user(1, ["NVDA"]), user(2, [])]);
  expect(map.get("NVDA")).toEqual([1]);
  expect([...map.keys()]).toEqual(["NVDA"]);
});

test("no accounts is an empty map, not a crash", () => {
  expect(buildWatchMap([]).size).toBe(0);
  expect(unionPortfolio([])).toEqual({ holdings: [], watchlist: [] });
});

// allTickers() strips option composites and crypto: the fan-out must inherit
// that rather than re-deriving it, or the detector loop tries to fetch "MRVL
// 2026-07-24 203C" from Finnhub.
test("non-scannable holdings are filtered by the shared normalizer", () => {
  const map = buildWatchMap([user(1, ["MRVL 2026-07-24 203C", "SOL-USD", "NVDA"])]);
  // A bare composite string with no option metadata is dropped outright -
  // there's no symbol in it Finnhub would recognise.
  expect([...map.keys()]).toEqual(["NVDA"]);
});

test("a structured option holding is monitored via its underlying", () => {
  const map = buildWatchMap([{
    id: 1,
    portfolio: {
      holdings: [{
        ticker: "MRVL 2026-07-24 203C", shares: 1, cost_basis: 2,
        asset_class: "option",
        option: { type: "call", strike: 203, expiry: "2026-07-24", underlying: "MRVL" },
      }],
      watchlist: [],
    },
  }]);
  expect([...map.keys()]).toEqual(["MRVL"]);
  expect(map.get("MRVL")).toEqual([1]);
});

test("unionPortfolio dedupes holdings by ticker and unions watchlists", () => {
  const u = unionPortfolio([
    user(1, ["NVDA", "AAPL"], ["TSLA"]),
    user(2, ["NVDA"], ["TSLA", "AMD"]),
  ]);
  expect(u.holdings.map((h) => h.ticker).sort()).toEqual(["AAPL", "NVDA"]);
  expect(u.watchlist.sort()).toEqual(["AMD", "TSLA"]);
});

test("unionPortfolio never invents a blended position", () => {
  // Two accounts, 10 shares each. The union must report one of them verbatim,
  // NOT 20: a summed position describes nobody and would mis-size any caller
  // that mistook this for a real portfolio.
  const u = unionPortfolio([user(1, ["NVDA"]), user(2, ["NVDA"])]);
  expect(u.holdings).toHaveLength(1);
  expect(u.holdings[0]!.shares).toBe(10);
});
