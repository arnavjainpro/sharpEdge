// Deterministic event detectors. Each returns raw events; AI triage decides what matters.
import { db, insertEvent, recentBars } from "../db";
import { returnStats } from "./technicals";
import { cachedQuote, fetchCompanyNews, fetchEarningsCalendar, type NewsItem } from "../ingest/finnhub";
import { fetchRecentFilings } from "../ingest/edgar";

export interface RawEvent {
  id: number;
  ts: number;
  ticker: string;
  kind: string;
  title: string;
  detail: object;
}

async function emit(e: { ts: number; ticker: string; kind: string; title: string; detail: object; dedupeKey: string }): Promise<RawEvent | null> {
  const id = await insertEvent(e);
  return id ? { id, ...e } : null; // null = duplicate, already alerted
}

async function stats(ticker: string): Promise<{ avg_volume_20d: number; prev_close: number; week52_high: number; week52_low: number } | null> {
  return await db.query(`SELECT * FROM daily_stats WHERE ticker = ?`).get(ticker) as any;
}

// ── Price/volume anomalies from live bars + quotes ──────────────────────────

export async function detectPriceVolume(ticker: string): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  const s = await stats(ticker);
  const q = await cachedQuote(ticker);
  const now = Math.floor(Date.now() / 1000);

  // Large session move vs prev close (thresholded so triage isn't spammed)
  if (s?.prev_close && Math.abs(q.dp) >= 3) {
    const bucket = Math.floor(Math.abs(q.dp)); // re-alert only when it crosses another whole %
    const ev = await emit({
      ts: now, ticker, kind: "price_move",
      title: `${ticker} ${q.dp > 0 ? "up" : "down"} ${q.dp.toFixed(1)}% today ($${q.c})`,
      detail: { pct: q.dp, price: q.c, prevClose: s.prev_close },
      dedupeKey: `price:${ticker}:${new Date().toISOString().slice(0, 10)}:${q.dp > 0 ? "+" : "-"}${bucket}`,
    });
    if (ev) out.push(ev);
  }

  // Short-term z-score spike on 1-min returns
  const bars = await recentBars(ticker, 120);
  if (bars.length >= 30) {
    const rs = returnStats(bars.map((b) => b.close));
    const last = bars.at(-1)!;
    const prev = bars.at(-2)!;
    if (rs && rs.std > 0) {
      const ret = (last.close - prev.close) / prev.close;
      const z = (ret - rs.mean) / rs.std;
      if (Math.abs(z) >= 4 && Math.abs(ret) >= 0.005) {
        const ev = await emit({
          ts: now, ticker, kind: "price_move",
          title: `${ticker} sudden ${ret > 0 ? "spike" : "drop"}: ${(ret * 100).toFixed(2)}% in 1 min (z=${z.toFixed(1)})`,
          detail: { z, ret, price: last.close },
          dedupeKey: `zmove:${ticker}:${last.ts}`,
        });
        if (ev) out.push(ev);
      }
    }
  }

  // Intraday volume spike vs 20-day average
  if (s?.avg_volume_20d && s.avg_volume_20d > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const dayVol = await db
      .query(`SELECT SUM(volume) v FROM bars WHERE ticker = ? AND to_char(to_timestamp(ts),'YYYY-MM-DD') = ?`)
      .get(ticker, today) as { v: number | null };
    if (dayVol.v && dayVol.v > s.avg_volume_20d * 2.5) {
      const ev = await emit({
        ts: now, ticker, kind: "volume_spike",
        title: `${ticker} volume ${(dayVol.v / s.avg_volume_20d).toFixed(1)}x its 20-day average`,
        detail: { dayVolume: dayVol.v, avg20d: s.avg_volume_20d },
        dedupeKey: `vol:${ticker}:${today}`,
      });
      if (ev) out.push(ev);
    }
  }

  // 52-week breaks
  if (s) {
    const today = new Date().toISOString().slice(0, 10);
    if (q.c >= s.week52_high && s.week52_high > 0) {
      const ev = await emit({
        ts: now, ticker, kind: "week52",
        title: `${ticker} hit a new 52-week high ($${q.c})`,
        detail: { price: q.c, prior52High: s.week52_high },
        dedupeKey: `52h:${ticker}:${today}`,
      });
      if (ev) out.push(ev);
    } else if (q.c <= s.week52_low && s.week52_low > 0) {
      const ev = await emit({
        ts: now, ticker, kind: "week52",
        title: `${ticker} hit a new 52-week low ($${q.c})`,
        detail: { price: q.c, prior52Low: s.week52_low },
        dedupeKey: `52l:${ticker}:${today}`,
      });
      if (ev) out.push(ev);
    }
  }

  return out;
}

// ── News arrival ─────────────────────────────────────────────────────────────

export async function detectNews(ticker: string): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const items = await fetchCompanyNews(ticker, today, today);
  const cutoff = Date.now() / 1000 - 2 * 3600; // only news from the last 2h
  for (const n of items as NewsItem[]) {
    if (n.datetime < cutoff) continue;
    const ev = await emit({
      ts: n.datetime, ticker, kind: "news",
      title: `${ticker} news: ${n.headline}`,
      detail: { source: n.source, summary: n.summary?.slice(0, 500), url: n.url },
      dedupeKey: `news:${n.id}`,
    });
    if (ev) out.push(ev);
  }
  return out;
}

// ── SEC filings ──────────────────────────────────────────────────────────────

export async function detectFilings(ticker: string): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  const since = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
  const filings = await fetchRecentFilings(ticker, since);
  for (const f of filings) {
    const ev = await emit({
      ts: Math.floor(new Date(f.filedAt).getTime() / 1000),
      ticker, kind: "filing",
      title: `${ticker} filed ${f.form}: ${f.description}`,
      detail: { form: f.form, url: f.url, filedAt: f.filedAt },
      dedupeKey: `filing:${f.accession}`,
    });
    if (ev) out.push(ev);
  }
  return out;
}

// ── Earnings surprises ───────────────────────────────────────────────────────

export async function detectEarnings(tickers: string[]): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const entries = await fetchEarningsCalendar(yesterday, today);
  const wanted = new Set(tickers);
  for (const e of entries) {
    if (!wanted.has(e.symbol) || e.epsActual == null) continue;
    const surprise =
      e.epsEstimate != null && e.epsEstimate !== 0
        ? ((e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate)) * 100
        : null;
    const ev = await emit({
      ts: Math.floor(Date.now() / 1000),
      ticker: e.symbol, kind: "earnings",
      title: `${e.symbol} reported EPS $${e.epsActual}${
        surprise != null ? ` (${surprise > 0 ? "beat" : "miss"} by ${Math.abs(surprise).toFixed(1)}%)` : ""
      }`,
      detail: e,
      dedupeKey: `earnings:${e.symbol}:${e.date}`,
    });
    if (ev) out.push(ev);
  }
  return out;
}
