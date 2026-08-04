// Daily OHLCV via Financial Modeling Prep: keyed, documented, ToS-clean.
// Primary source for daily candles; ingest/candles.ts falls back to Yahoo
// whenever this returns null, so nothing here is load-bearing on its own.
//
// Two plan quirks drive the shape of this file:
//   1. Restricted symbols answer HTTP 200 with a prose body, not an error status.
//   2. Omitting `from` silently caps history at ~5 years, which would quietly
//      truncate the backtester's "max" request. Every call sends an explicit
//      window.
// Only daily bars live here. Intraday, batch quotes and options chains are
// plan-gated or absent on FMP and stay on Yahoo.

import { config, etWallToEpoch } from "../config";
import type { DailyCandles } from "./candles";

const BASE = "https://financialmodelingprep.com/stable";

export const fmpEnabled = () => config.fmpKey !== "";

// FMP quotes class shares with a dot (BRK.B); storage convention is dash form.
const toFmp = (t: string) => t.replace(/-/g, ".");

// Symbols this plan won't serve. Populated on first refusal so a 1,500-name
// screener pass doesn't re-buy the same rejection every six hours.
const restricted = new Set<string>();

export const isRestricted = (ticker: string) => restricted.has(ticker);

// The exact wording of a plan refusal, as returned by the live API.
const REFUSAL_RE = /Restricted Endpoint|Premium Query Parameter|not available under your current subscription/i;

// Once the plan's request allowance is gone, FMP answers 429 with
// {"Error Message": "Limit Reach ..."}. That is a fact about the ACCOUNT, not
// about the symbol, so it trips a global breaker rather than being retried per
// ticker. A screener pass covers ~3,000 names; without this, every one of them
// spends a futile round-trip before falling back to Yahoo, on every scan.
const QUOTA_RE = /Limit Reach|rate limit|too many requests/i;
const QUOTA_COOLDOWN_MS = 60 * 60_000;
let quotaBlockedUntil = 0;

export const fmpQuotaBlocked = () => Date.now() < quotaBlockedUntil;

// Test seam, alongside _clearRestricted.
export const _clearQuotaBlock = () => {
  quotaBlockedUntil = 0;
};

// Test seam: the memo is process-lifetime by design, so tests need a reset.
export const _clearRestricted = () => restricted.clear();

// Yahoo range strings, since callers speak Yahoo. "max" leans on FMP's own
// 5,000-row ceiling (~20y) rather than pretending to know a listing date.
const RANGE_DAYS: Record<string, number> = {
  "1mo": 31, "3mo": 92, "6mo": 183, "1y": 366, "2y": 731, "5y": 1827, "10y": 3653,
};

function windowFor(range: string): { from: string; to: string } {
  const day = 86400_000;
  const now = Date.now();
  const days = range === "max" ? 365 * 40 : RANGE_DAYS[range] ?? 366;
  // Pad the lookback: RANGE_DAYS is calendar days but callers size minBars in
  // trading days (~252/yr), so an exact window would fail every minBars check.
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(now - days * day * 1.05), to: iso(now + day) };
}

interface EodRow {
  date: string;      // "YYYY-MM-DD"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// FMP dates carry no time. Yahoo stamps each daily bar at 09:30 ET, and
// insights.ts/backtest.ts align bars against idea timestamps: so the two
// providers have to agree to the second or a replay can pick the wrong session.
const barTimestamp = (date: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return Math.floor(etWallToEpoch(Number(m[1]), Number(m[2]), Number(m[3]), 9, 30) / 1000);
};

function parseRows(rows: EodRow[], ticker: string): DailyCandles | null {
  const out: DailyCandles = { ticker, opens: [], highs: [], lows: [], closes: [], volumes: [], timestamps: [] };
  // FMP returns newest-first; DailyCandles is oldest → newest.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const ts = barTimestamp(r?.date);
    if (ts == null || !Number.isFinite(r.close)) continue;
    out.closes.push(r.close);
    out.opens.push(Number.isFinite(r.open) ? r.open : r.close);
    out.highs.push(Number.isFinite(r.high) ? r.high : r.close);
    out.lows.push(Number.isFinite(r.low) ? r.low : r.close);
    out.volumes.push(Number.isFinite(r.volume) ? r.volume : 0);
    out.timestamps.push(ts);
  }
  return out.closes.length ? out : null;
}

// Daily OHLCV. Null means "ask Yahoo": never throws, so the router's fallback
// is a plain null check.
export async function fetchDailyCandlesFmp(
  ticker: string,
  range = "1y",
  minBars = 210
): Promise<DailyCandles | null> {
  if (!fmpEnabled() || restricted.has(ticker) || fmpQuotaBlocked()) return null;
  const { from, to } = windowFor(range);
  const qs = new URLSearchParams({ symbol: toFmp(ticker), from, to, apikey: config.fmpKey });
  try {
    const res = await fetch(`${BASE}/historical-price-eod/full?${qs}`, { signal: AbortSignal.timeout(20_000) });
    // A plan refusal is a 402 carrying BARE PROSE: "Premium Query Parameter: …",
    // "Restricted Endpoint: …": which is not valid JSON. So the body has to be
    // read as text, and read BEFORE the status check: bailing on !res.ok first
    // would classify a permanent refusal as a transient miss and re-bill a
    // request for that symbol on every screener pass.
    const text = await res.text();
    if (res.status === 429 || QUOTA_RE.test(text)) {
      // Log only on the transition, not once per remaining ticker in the scan.
      if (!fmpQuotaBlocked()) {
        console.warn(`[fmp] request allowance exhausted: using Yahoo for the next ${QUOTA_COOLDOWN_MS / 60_000} minutes`);
      }
      quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
      return null;
    }
    if (REFUSAL_RE.test(text)) {
      restricted.add(ticker);
      console.warn(`[fmp] ${ticker} unavailable on this plan: falling back to Yahoo`);
      return null;
    }
    // Everything else that isn't a bar array (bad key, outage, 5xx) is treated
    // as transient: fall back to Yahoo now, but don't condemn the symbol for the
    // life of the process.
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    if (!Array.isArray(body)) return null;
    const bars = parseRows(body as EodRow[], ticker);
    return bars && bars.closes.length >= minBars ? bars : null;
  } catch {
    return null;
  }
}
