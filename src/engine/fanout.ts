// SHARP-29: the pure half of multi-account monitoring.
//
// These decide WHO a piece of background work is for. They live here rather
// than in index.ts because index.ts boots the whole process on import — logic
// that lives there can never be tested, and this is exactly the logic where a
// quiet mistake means one account silently stops being monitored.
import type { Portfolio } from "../config";
import { allTickers } from "../config";

export interface MonitoredUser {
  id: number;
  portfolio: Portfolio;
}

// ticker → the accounts that hold or watch it.
//
// This is what makes the fan-out affordable: detection runs once per ticker in
// this map no matter how many accounts appear in its value, and only the AI
// interpretation is repeated per account. Two users holding NVDA is one set of
// Finnhub calls and two triage calls, not two of each.
//
// Tickers come from allTickers(), the same normalization chokepoint the rest of
// the app uses, so option composites and crypto are already stripped.
export function buildWatchMap(users: MonitoredUser[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const u of users) {
    for (const t of allTickers(u.portfolio)) {
      const owners = map.get(t) ?? [];
      // An account listing the same ticker in both holdings and watchlist must
      // not be triaged (and charged) twice for one event.
      if (!owners.includes(u.id)) owners.push(u.id);
      map.set(t, owners);
    }
  }
  return map;
}

// A merged view for jobs that only need "which tickers exist across all
// accounts" — the universe build, the screener's name-biasing, daily stats, the
// quote-cache heartbeat.
//
// Holdings are deduped by ticker keeping the first seen. Share counts and cost
// bases are deliberately NOT summed: nothing reading this cares about size, and
// a blended position across unrelated accounts would be a number that describes
// nobody. Anything that does care about size takes a real per-user portfolio.
export function unionPortfolio(users: MonitoredUser[]): Portfolio {
  const holdings = new Map<string, Portfolio["holdings"][number]>();
  const watchlist = new Set<string>();
  for (const u of users) {
    for (const h of u.portfolio.holdings) if (!holdings.has(h.ticker)) holdings.set(h.ticker, h);
    for (const w of u.portfolio.watchlist) watchlist.add(w);
  }
  return { holdings: [...holdings.values()], watchlist: [...watchlist] };
}
