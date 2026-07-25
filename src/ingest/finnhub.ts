import { config, marketPhase } from "../config";
import { upsertBar, db } from "../db";

const BASE = "https://finnhub.io/api/v1";

// Symbol-form boundary: storage/cache use dash form (BRK-B, Yahoo convention);
// Finnhub speaks dot form (BRK.B). Convert at this file's edges only.
export const toFinnhub = (t: string) => t.replace(/-/g, ".");
export const fromFinnhub = (t: string) => t.replace(/\./g, "-");

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  if (params.symbol) params = { ...params, symbol: toFinnhub(params.symbol) };
  const qs = new URLSearchParams({ ...params, token: config.finnhubKey });
  const res = await fetch(`${BASE}${path}?${qs}`);
  if (!res.ok) throw new Error(`Finnhub ${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Quote {
  c: number; // current
  d: number; // change
  dp: number; // percent change
  h: number; l: number; o: number;
  pc: number; // prev close
  t: number;
}

export const fetchQuote = (ticker: string) => get<Quote>("/quote", { symbol: ticker });

// Shared quote cache: single-flight, 60s TTL, patched live by the websocket.
// All read paths (server, alerts, detectors, AI context) go through this so 8
// call sites share one 60/min REST budget instead of competing for it.
const QUOTE_TTL_MS = 60_000;
type QuoteEntry = { at: number; p: Promise<Quote>; q?: Quote };
const quoteCache = new Map<string, QuoteEntry>();

export function cachedQuote(ticker: string, force = false): Promise<Quote> {
  const hit = quoteCache.get(ticker);
  if (!force && hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.p;
  if (quoteCache.size > 500) quoteCache.clear(); // ponytail: crude cap; single-user dash never needs LRU
  const entry: QuoteEntry = { at: Date.now(), p: fetchQuote(ticker) };
  entry.p
    .then((q) => { entry.q = q; })
    .catch(() => { if (quoteCache.get(ticker) === entry) quoteCache.delete(ticker); });
  quoteCache.set(ticker, entry);
  return entry.p;
}

// Websocket trades patch the live price of an existing cache entry (never
// create one — a bare price with zeroed pc/d/dp would corrupt callers).
// TTL is untouched: REST still refreshes pc/h/l/o on expiry.
export function patchQuoteFromTrade(dashSym: string, price: number, tradeTsMs: number) {
  const q = quoteCache.get(dashSym)?.q;
  if (!q) return;
  q.c = price;
  if (q.pc > 0) { q.d = price - q.pc; q.dp = ((price - q.pc) / q.pc) * 100; }
  q.t = Math.floor(tradeTsMs / 1000); // trade t is ms; Quote.t is unix seconds
}

export interface NewsItem {
  id: number;
  datetime: number;
  headline: string;
  source: string;
  summary: string;
  url: string;
}

export function fetchCompanyNews(ticker: string, fromISO: string, toISO: string) {
  return get<NewsItem[]>("/company-news", { symbol: ticker, from: fromISO, to: toISO });
}

export interface EarningsEntry {
  date: string;
  symbol: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  hour: string;
}

export async function fetchEarningsCalendar(fromISO: string, toISO: string, symbol?: string) {
  const res = await get<{ earningsCalendar: EarningsEntry[] }>("/calendar/earnings", {
    from: fromISO,
    to: toISO,
    ...(symbol ? { symbol } : {}),
  });
  return res.earningsCalendar ?? [];
}

// Next scheduled earnings for one ticker (within ~70 days), or null.
// Critical risk input: holding a swing trade through earnings is a different bet.
export async function fetchNextEarnings(ticker: string): Promise<{ date: string; daysAway: number; hour: string } | null> {
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 70 * 86400_000).toISOString().slice(0, 10);
    const entries = await fetchEarningsCalendar(from, to, ticker);
    const next = entries
      .filter((e) => e.symbol === ticker && e.date >= from)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!next) return null;
    const daysAway = Math.round((new Date(next.date).getTime() - Date.now()) / 86400_000);
    return { date: next.date, daysAway, hour: next.hour ?? "" };
  } catch {
    return null;
  }
}

// Refresh per-ticker daily stats (prev close, 20d avg volume, 52wk range) from quote + stored bars.
export async function refreshDailyStats(ticker: string) {
  const q = await fetchQuote(ticker);
  const vol = await db
    .query(
      `SELECT AVG(day_vol) as av FROM (
         SELECT SUM(volume) as day_vol FROM bars WHERE ticker = ?
         GROUP BY to_char(to_timestamp(ts), 'YYYY-MM-DD') ORDER BY to_char(to_timestamp(ts), 'YYYY-MM-DD') DESC LIMIT 20) sub`
    )
    .get(ticker) as { av: number | null };
  const existing = await db
    .query(`SELECT week52_high, week52_low FROM daily_stats WHERE ticker = ?`)
    .get(ticker) as { week52_high: number; week52_low: number } | null;
  const hi = Math.max(existing?.week52_high ?? q.h, q.h);
  const lo = Math.min(existing?.week52_low ?? q.l, q.l);
  await db.query(
    `INSERT INTO daily_stats (ticker, avg_volume_20d, prev_close, week52_high, week52_low, updated_at)
     VALUES (?, ?, ?, ?, ?, extract(epoch from now())::int)
     ON CONFLICT(ticker) DO UPDATE SET avg_volume_20d=excluded.avg_volume_20d,
       prev_close=excluded.prev_close, week52_high=excluded.week52_high,
       week52_low=excluded.week52_low, updated_at=excluded.updated_at`
  ).run(ticker, vol.av ?? 0, q.pc, hi, lo);
  return q;
}

// Live websocket health — exposed on /api/state so silent stalls become visible.
export const wsStatus = {
  connected: false,
  lastMessageAt: 0, // any inbound frame, including Finnhub's {"type":"ping"}
  reconnects: 0,
};

// Live trades websocket → aggregated into 1-minute bars.
// Resilience: exponential-backoff reconnect (5s → 120s cap) + a watchdog that
// force-recycles the socket if no frames arrive while the market is open —
// otherwise a silently-dead socket would leave SQLite bars stale and Opus
// analyzing news against stale technicals.
export function startTradeStream(tickers: string[], onTrade?: (t: { s: string; p: number; v: number; t: number }) => void) {
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let backoffAttempt = 0;

  function connect() {
    ws = new WebSocket(`wss://ws.finnhub.io?token=${config.finnhubKey}`);
    ws.onopen = () => {
      wsStatus.connected = true;
      wsStatus.lastMessageAt = Date.now();
      console.log(`[finnhub] websocket connected, subscribing to ${tickers.length} tickers`);
      for (const t of tickers) ws!.send(JSON.stringify({ type: "subscribe", symbol: toFinnhub(t) }));
    };
    ws.onmessage = async (msg) => {
      wsStatus.lastMessageAt = Date.now();
      backoffAttempt = 0; // stable traffic → reset backoff
      try {
        const data = JSON.parse(String(msg.data));
        if (data.type !== "trade") return; // pings etc. still count as liveness above
        for (const tr of data.data as { s: string; p: number; v: number; t: number }[]) {
          const sym = fromFinnhub(tr.s); // bars/cache keyed dash-form like the rest of storage
          const tsMin = Math.floor(tr.t / 1000 / 60) * 60;
          await upsertBar(sym, tsMin, tr.p, tr.p, tr.p, tr.p, tr.v);
          patchQuoteFromTrade(sym, tr.p, tr.t);
          onTrade?.({ ...tr, s: sym });
        }
      } catch {}
    };
    ws.onclose = () => {
      wsStatus.connected = false;
      if (closedByUs) return;
      const delay = Math.min(5000 * 2 ** backoffAttempt, 120_000);
      backoffAttempt++;
      wsStatus.reconnects++;
      console.warn(`[finnhub] websocket closed, reconnecting in ${delay / 1000}s (attempt ${backoffAttempt})`);
      setTimeout(connect, delay);
    };
    ws.onerror = () => ws?.close();
  }

  // Watchdog: checks every 15s; if the socket claims to be open but nothing has
  // arrived for 60s during market hours (Finnhub pings every ~15-30s even when
  // trades are quiet), the connection is dead — force-close to trigger reconnect.
  // Skipped when the market is closed, where silence is normal.
  const watchdog = setInterval(() => {
    if (!wsStatus.connected || marketPhase() === "closed") return;
    if (Date.now() - wsStatus.lastMessageAt > 60_000) {
      console.warn("[finnhub] watchdog: no frames for 60s during market hours — recycling socket");
      ws?.close();
    }
  }, 15_000);

  connect();
  return () => {
    closedByUs = true;
    clearInterval(watchdog);
    ws?.close();
  };
}
