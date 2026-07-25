// Full-index catalyst sweep — patches the "two-speed" blind spot.
//
// The screener covers all ~508 tickers but only every 6 hours; real-time
// news/filing monitoring covers only holdings+watchlist (Finnhub rate limits).
// This sweep polls the WHOLE universe's intraday price via Yahoo's batch spark
// endpoint (20 symbols/call → ~26 calls, ~15s per sweep, every 15 min during
// market hours). Any un-watched stock with an abnormal move is dynamically
// promoted into the news/filings queue for 60 minutes, so a market-moving
// catalyst anywhere in the index reaches the AI pipeline within minutes.
import { insertEvent } from "../db";
import type { RawEvent } from "./detectors";

const PROMOTE_PCT = 5;        // |day move| ≥ 5% = abnormal enough across a mixed-cap universe
const PROMOTE_TTL_MS = 60 * 60_000;
const MAX_PROMOTIONS_PER_SWEEP = 8; // protect the Finnhub budget
const MAX_SWEEP_SYMBOLS = 2500;     // keep a full sweep under ~2 minutes

// ticker -> expiry epoch-ms
const dynamicWatch = new Map<string, number>();
const promotedToday = new Set<string>();
let promotedDay = "";

export function activeDynamicTickers(): string[] {
  const now = Date.now();
  for (const [t, exp] of dynamicWatch) if (exp < now) dynamicWatch.delete(t);
  return [...dynamicWatch.keys()];
}

interface Mover {
  ticker: string;
  changePct: number;
  price: number;
}

async function fetchBatchChanges(symbols: string[]): Promise<Mover[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols.join(",")}&range=1d&interval=30m`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sharpEdge personal-use" } });
    if (!res.ok) return [];
    // Response is a flat object keyed by symbol:
    // { AAPL: { close: [...], previousClose, chartPreviousClose, ... }, ... }
    const data = (await res.json()) as Record<string, any>;
    const out: Mover[] = [];
    for (const [sym, r] of Object.entries(data)) {
      const closes: number[] = (r?.close ?? []).filter((c: any) => c != null);
      const price = closes.at(-1);
      const prev = r?.previousClose ?? r?.chartPreviousClose;
      if (price == null || !prev) continue;
      out.push({ ticker: sym, price, changePct: ((price - prev) / prev) * 100 });
    }
    return out;
  } catch {
    return [];
  }
}

// Sweep the universe; promote abnormal movers. Returns events for newly-promoted tickers.
export async function sweepIndex(universe: string[], alreadyWatched: Set<string>): Promise<RawEvent[]> {
  const today = new Date().toISOString().slice(0, 10);
  if (promotedDay !== today) {
    promotedDay = today;
    promotedToday.clear();
  }

  const symbols = universe.slice(0, MAX_SWEEP_SYMBOLS);
  const movers: Mover[] = [];
  for (let i = 0; i < symbols.length; i += 20) {
    movers.push(...(await fetchBatchChanges(symbols.slice(i, i + 20))));
    await Bun.sleep(400);
  }

  const candidates = movers
    .filter((m) => Math.abs(m.changePct) >= PROMOTE_PCT)
    .filter((m) => !alreadyWatched.has(m.ticker) && !promotedToday.has(m.ticker))
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, MAX_PROMOTIONS_PER_SWEEP);

  const events: RawEvent[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const m of candidates) {
    dynamicWatch.set(m.ticker, Date.now() + PROMOTE_TTL_MS);
    promotedToday.add(m.ticker);
    const id = await insertEvent({
      ts: now,
      ticker: m.ticker,
      kind: "market_mover",
      title: `${m.ticker} is ${m.changePct > 0 ? "up" : "down"} ${Math.abs(m.changePct).toFixed(1)}% today ($${m.price.toFixed(2)}) — abnormal move, now checking its news and filings`,
      detail: { changePct: m.changePct, price: m.price, promotedFor: "60min" },
      dedupeKey: `mover:${m.ticker}:${today}`,
    });
    if (id) events.push({ id, ts: now, ticker: m.ticker, kind: "market_mover", title: `${m.ticker} moved ${m.changePct.toFixed(1)}% today — promoted to live monitoring`, detail: { changePct: m.changePct, price: m.price } });
  }
  // Always log — a sweep that quotes 0/508 is a broken feed, not a quiet day.
  console.log(`[sweep] ${movers.length}/${universe.length} quoted, ${candidates.length} promoted (active: ${activeDynamicTickers().join(", ") || "none"})`);
  return events;
}
