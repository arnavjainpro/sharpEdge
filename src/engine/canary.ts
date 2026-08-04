// Data-feed canaries (SHARP-9). Every external feed this product stands on -
// Yahoo's chart API, Finnhub REST + websocket, Robinhood's private endpoints -
// can change shape overnight and none of them version their responses. Today
// that's discovered by symptom: a screener pass that quietly scores nothing, a
// dashboard whose prices stopped moving. These probes turn it into an alert.
//
// Two design choices worth keeping:
//
// 1. Probes call the app's OWN accessors (fetchDailyCandles, fetchQuote, …),
//    not hand-rolled requests. A canary that parses the feed independently can
//    stay green while the real parser breaks: it would be testing a copy.
//
// 2. "Parsed without throwing" is not enough. A silent units change (prices in
//    cents, timestamps in ms) parses fine and poisons every downstream number,
//    so each validator also range-checks the values it got back. That's the
//    degradation half of a degradation test.
import { fetchIntradayBars, type DailyCandles, type IntradayBars } from "../ingest/candles";
import { fetchDailyCandlesYahoo } from "../ingest/yahoo";
import { fetchDailyCandlesFmp, fmpEnabled, fmpQuotaBlocked } from "../ingest/fmp";
import { fetchQuote, fetchCompanyNews, wsStatus, type Quote, type NewsItem } from "../ingest/finnhub";
import { db } from "../db";
import { brokerSnapshot } from "../broker";
import { marketPhase } from "../config";
import { notifyTelegram, telegramEnabled } from "../notify/telegram";

export interface CanaryResult {
  feed: string;                              // stable id
  label: string;                             // human name for the dashboard
  status: "ok" | "broken" | "skipped";
  detail: string;
  checkedAt: number;                         // unix seconds
}

// A canary probes a liquid, permanently-listed symbol. SPY/AAPL are the right
// choice precisely because a failure here can't be blamed on the symbol.
const PROBE = "SPY";
const NEWS_PROBE = "AAPL";


// Prices outside this band mean the units changed, not that the market moved.
const MIN_PRICE = 1;
const MAX_PRICE = 100_000;
const finitePrice = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > MIN_PRICE && n < MAX_PRICE;

// Newest bar older than this = the feed is serving stale history. Six days
// covers a long holiday weekend without crying wolf.
const MAX_BAR_AGE_SEC = 6 * 86400;
const agoSec = (ts: number) => Math.floor(Date.now() / 1000) - ts;

// ── Validators: pure, no network, so the shape rules can be tested directly ──
// Each returns null when healthy, or a one-line complaint naming what broke.

export function checkDailyShape(bars: DailyCandles | null, minBars = 210): string | null {
  if (!bars) return "no parsable daily candles came back";
  if (bars.closes.length < minBars) return `only ${bars.closes.length} daily bars, expected ≥${minBars}`;
  if (bars.timestamps.length !== bars.closes.length) return "timestamp/close arrays are different lengths";
  if (!bars.closes.every(finitePrice)) return "a close is missing, zero, or outside a plausible price range";
  if (!bars.highs.every(finitePrice) || !bars.lows.every(finitePrice)) return "a high/low is missing or implausible";
  if (bars.highs.some((h, i) => h < bars.lows[i]!)) return "a bar has high < low";
  // Yahoo has returned newest-first before; the whole engine assumes oldest→newest.
  if (bars.timestamps.some((t, i) => i > 0 && t <= bars.timestamps[i - 1]!)) return "timestamps are not strictly oldest→newest";
  const age = agoSec(bars.timestamps.at(-1)!);
  if (age > MAX_BAR_AGE_SEC) return `newest bar is ${Math.round(age / 86400)} days old`;
  return null;
}

export function checkIntradayShape(bars: IntradayBars | null): string | null {
  if (!bars) return "no parsable intraday bars came back";
  if (bars.closes.length < 10) return `only ${bars.closes.length} intraday bars`;
  if (!bars.closes.every(finitePrice)) return "an intraday close is missing or implausible";
  // meta drives gap math in the analyzer; losing it silently degrades the plan.
  if (bars.prevClose != null && !finitePrice(bars.prevClose)) return "meta.previousClose is present but implausible";
  if (bars.regularMarketPrice != null && !finitePrice(bars.regularMarketPrice)) return "meta.regularMarketPrice is present but implausible";
  if (bars.prevClose == null && bars.regularMarketPrice == null) return "meta carries neither previousClose nor regularMarketPrice";
  return null;
}

export function checkQuoteShape(q: Quote | null): string | null {
  if (!q) return "no quote came back";
  if (!finitePrice(q.c)) return `current price ${q.c} is missing or outside a plausible range`;
  if (!finitePrice(q.pc)) return `previous close ${q.pc} is missing or outside a plausible range`;
  // A >50% daily move on the probe symbol is a units change, not a market event.
  if (!Number.isFinite(q.dp) || Math.abs(q.dp) > 50) return `daily change ${q.dp}% is implausible: check the units`;
  // Quote.t is unix SECONDS everywhere in this codebase; ms would be ~1000x too big.
  if (!Number.isFinite(q.t) || q.t > Math.floor(Date.now() / 1000) + 86400) return `quote timestamp ${q.t} is in the future: seconds vs milliseconds?`;
  return null;
}

export function checkNewsShape(items: NewsItem[] | null): string | null {
  if (!Array.isArray(items)) return "company-news did not return an array";
  // An empty week is legitimate for a quiet name, so emptiness alone isn't a
  // failure: but if there ARE items, the fields the app reads must be there.
  if (!items.length) return null;
  const bad = items.find((n) => typeof n.headline !== "string" || !n.headline || typeof n.url !== "string" || !Number.isFinite(n.datetime));
  if (bad) return "a news item is missing headline/url/datetime";
  const newest = Math.max(...items.map((n) => n.datetime));
  if (newest > Math.floor(Date.now() / 1000) + 86400) return `news datetime ${newest} is in the future: seconds vs milliseconds?`;
  return null;
}

// ── Probes ───────────────────────────────────────────────────────────────────

const result = (feed: string, label: string, complaint: string | null): CanaryResult =>
  ({ feed, label, status: complaint ? "broken" : "ok", detail: complaint ?? "responding with the expected shape", checkedAt: Math.floor(Date.now() / 1000) });

const skip = (feed: string, label: string, why: string): CanaryResult =>
  ({ feed, label, status: "skipped", detail: why, checkedAt: Math.floor(Date.now() / 1000) });

async function probe(feed: string, label: string, fn: () => Promise<string | null>): Promise<CanaryResult> {
  try {
    return result(feed, label, await fn());
  } catch (err) {
    // A throw is itself a canary signal (auth rejected, endpoint moved, DNS).
    return result(feed, label, `request threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function probeAll(): Promise<CanaryResult[]> {
  const checks: Promise<CanaryResult>[] = [
    // Probes the Yahoo fetcher directly, not the router: routed through
    // fetchDailyCandles this would silently become an FMP probe whenever a key
    // is configured, and the fallback leg would go untested until it was needed.
    probe("yahoo_daily", "Yahoo daily candles", async () => checkDailyShape(await fetchDailyCandlesYahoo(PROBE, "1y", 210))),
    probe("yahoo_intraday", "Yahoo intraday bars", async () => checkIntradayShape(await fetchIntradayBars(PROBE, "15m"))),
    // AAPL, not PROBE: SPY is the one ETF the cheaper FMP plans still serve, so
    // probing it would report healthy right through a plan downgrade.
    fmpEnabled()
      ? probe("fmp_daily", "FMP daily candles", async () => {
          const bars = await fetchDailyCandlesFmp(NEWS_PROBE, "1y", 210);
          // A spent request allowance is a distinct, self-healing condition -
          // naming it beats the generic "nothing parsed" complaint, which sends
          // you looking for a shape change that isn't there.
          if (!bars && fmpQuotaBlocked()) return "request allowance exhausted: daily candles are coming from Yahoo until it resets";
          return checkDailyShape(bars);
        })
      : Promise.resolve(skip("fmp_daily", "FMP daily candles", "FMP_API_KEY not set: daily candles come from Yahoo")),
    probe("finnhub_quote", "Finnhub quotes", async () => checkQuoteShape(await fetchQuote(PROBE))),
    probe("finnhub_news", "Finnhub company news", async () => {
      const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      return checkNewsShape(await fetchCompanyNews(NEWS_PROBE, iso(Date.now() - 7 * 86400_000), iso(Date.now())));
    }),
  ];

  const out = await Promise.all(checks);

  // The websocket isn't a request/response feed: its health IS its liveness,
  // and it only carries trades while the market is open. Checking it outside
  // regular hours would report "broken" every evening.
  const label = "Finnhub trade websocket";
  if (marketPhase() !== "open") {
    out.push(skip("finnhub_ws", label, "market closed: no trades expected"));
  } else if (!wsStatus.connected) {
    out.push(result("finnhub_ws", label, "socket is disconnected"));
  } else {
    const stale = wsStatus.lastMessageAt ? Math.round((Date.now() - wsStatus.lastMessageAt) / 1000) : null;
    out.push(result("finnhub_ws", label, stale != null && stale > 120 ? `no frames for ${stale}s while the market is open` : null));
  }

  // Robinhood is checked indirectly and on purpose: refreshBroker() swallows a
  // provider failure and keeps serving the last good snapshot (so the dashboard
  // doesn't lose positions on one bad poll), which means a shape change shows up
  // ONLY as a snapshot that stopped ageing. That staleness is the signal.
  //
  // Since SHARP-29 every linked account is refreshed on the broker timer, so a
  // stale snapshot on ANY of them is a real signal rather than "that account
  // just isn't watched". The worst (oldest) one is reported: one working link
  // shouldn't mask another that's failing.
  const rhLabel = "Robinhood positions";
  const linked = await linkedRobinhoodUsers();
  if (!linked.length) {
    out.push(skip("robinhood", rhLabel, "no account linked"));
  } else {
    const snaps = linked.map((id) => ({ id, snap: brokerSnapshot(id) }));
    const fellBack = snaps.find((s) => s.snap && s.snap.source !== "robinhood");
    const pulled = snaps.filter((s) => s.snap?.source === "robinhood");
    if (fellBack) {
      out.push(result("robinhood", rhLabel, `user ${fellBack.id}'s snapshot fell back to "${fellBack.snap!.source}": their Robinhood pull is failing`));
    } else if (!pulled.length) {
      out.push(skip("robinhood", rhLabel, `${linked.length} linked account(s), none pulled yet this run`));
    } else {
      const oldest = pulled.reduce((a, b) => (a.snap!.asOf <= b.snap!.asOf ? a : b));
      const age = agoSec(oldest.snap!.asOf);
      out.push(result("robinhood", rhLabel, age > 3 * 3600 ? `user ${oldest.id}'s snapshot is ${Math.round(age / 3600)}h old: refreshes are failing` : null));
    }
  }

  return out;
}

// Every account with a Robinhood link. "Are Robinhood's private endpoints still
// working" is a property of the feed, not of one account: and since the broker
// timer refreshes them all, all of them are evidence.
async function linkedRobinhoodUsers(): Promise<number[]> {
  const rows = await db
    .query(`SELECT user_id FROM broker_links WHERE provider = 'robinhood' ORDER BY linked_at DESC`)
    .all<{ user_id: number }>()
    .catch(() => []);
  return rows.map((r) => r.user_id);
}

// ── State + alerting ─────────────────────────────────────────────────────────

let last: CanaryResult[] = [];
export const canaryStatus = (): CanaryResult[] => last;

export async function runCanaries(): Promise<CanaryResult[]> {
  const now = await probeAll();
  const before = new Map(last.map((r) => [r.feed, r.status]));

  // Alert on the TRANSITION only. These run on a timer; alerting on every
  // failed poll would turn a day-long Yahoo outage into a pager loop, and the
  // recovery message is what tells you it's safe to trust the numbers again.
  const broke = now.filter((r) => r.status === "broken" && before.get(r.feed) !== "broken");
  const healed = now.filter((r) => r.status === "ok" && before.get(r.feed) === "broken");
  last = now;

  for (const r of broke) console.error(`[canary] ${r.feed} BROKEN: ${r.detail}`);
  for (const r of healed) console.log(`[canary] ${r.feed} recovered`);

  if (telegramEnabled() && (broke.length || healed.length)) {
    const lines = [
      ...broke.map((r) => `🔴 *${r.label}*: ${r.detail}`),
      ...healed.map((r) => `🟢 *${r.label}*: back to normal`),
    ];
    try {
      await notifyTelegram(`*sharpEdge data feeds*\n\n${lines.join("\n")}\n\n_Numbers from a broken feed are not trustworthy until this clears._`);
    } catch { /* delivery is best-effort; the log above is the record */ }
  }
  return now;
}
