import { config, allTickers, marketPhase, etNow, type Portfolio } from "./config";
import { aiLive, monitoredUserIds, setTriage, setTriageFor, severityRank } from "./db";
import { findUserById, cleanupExpiredSessions } from "./auth";
import { runScan } from "./engine/screener";
import { evaluateActiveAlerts } from "./engine/alerts";
import { refreshUniverse, scanUniverse } from "./ingest/universe";
import { seedFutures } from "./ingest/futures";
import { refreshMarketContext } from "./engine/market";
import { runCanaries } from "./engine/canary";
import { buildWatchMap, unionPortfolio } from "./engine/fanout";
import { sweepIndex, activeDynamicTickers } from "./engine/sweep";
import { loadCikMap } from "./ingest/edgar";
import { refreshDailyStats, startTradeStream } from "./ingest/finnhub";
import { detectPriceVolume, detectNews, detectFilings, detectEarnings, type RawEvent } from "./engine/detectors";
import { triageEvent } from "./ai/triage";
import { analyzeEvent } from "./ai/analyst";
import { generateBriefing } from "./ai/briefing";
import { setTripHandler } from "./ai/breaker";
import { startCacheHeartbeat } from "./ai/heartbeat";
import { refreshBroker, currentPortfolio } from "./broker";
import { refreshEarnings, checkOptionExpiries } from "./engine/insights";
import { notifyMac } from "./notify/macos";
import { notifyTelegram, telegramEnabled } from "./notify/telegram";
import { startServer, broadcast, broadcastTo, setTestEventHandler, setBriefingHandler } from "./server/server";

if (!config.finnhubKey) {
  console.error("FINNHUB_API_KEY is not set. Get a free key at https://finnhub.io and put it in .env");
  process.exit(1);
}

// SHARP-29: background monitoring covers EVERY account, not just the first
// signup. The split that makes that affordable:
//
//   detection  — a market fact, shared. Each ticker is fetched ONCE per cycle
//                no matter how many accounts watch it, so the Finnhub call
//                budget is driven by the union of everyone's tickers, not by
//                users × tickers.
//   triage/analysis/briefings — an opinion about YOUR portfolio, so these fan
//                out per account. This is the part that costs tokens, and it
//                only runs for accounts that actually hold or watch the ticker.
//
// Cost therefore scales with (accounts × events on tickers they care about),
// not with accounts × the whole universe.
async function monitoredUsers(): Promise<{ id: number; portfolio: Portfolio }[]> {
  const ids = await monitoredUserIds();
  const out: { id: number; portfolio: Portfolio }[] = [];
  for (const id of ids) {
    // Cached per user; the timer below keeps them warm. A first-seen account
    // gets its snapshot pulled here rather than waiting a full broker cycle.
    try { await refreshBroker(id); } catch (err) { console.error(`[broker] refresh failed for user ${id}:`, err); }
    out.push({ id, portfolio: currentPortfolio(id) });
  }
  return out;
}

// Built fresh each cycle so a position opened mid-session is monitored on the
// next pass. The mapping itself lives in engine/fanout.ts where it's testable.
const watchMap = async () => buildWatchMap(await monitoredUsers());

const bootWatch = await watchMap();
console.log(
  `[sharpEdge] monitoring ${bootWatch.size} tickers across ${(await monitoredUserIds()).length} accounts: ` +
  `${[...bootWatch.keys()].join(", ")}`
);

// Circuit breaker trips fire an immediate CRITICAL alert on every channel.
setTripHandler(async (name, count, windowSec) => {
  const msg = `Circuit Breaker Tripped — ${name} hit ${count} calls in ${windowSec}s. AI halted to prevent spend. Monitoring continues; reset from the dashboard.`;
  broadcast("health", { breakerTripped: name });
  await notifyMac("🚨 sharpEdge: AI HALTED", msg);
  if (telegramEnabled()) await notifyTelegram(`🚨 *sharpEdge: AI HALTED*\n\n${msg}`);
});

// ── Pipeline: event → triage → (analysis) → notify → broadcast ──────────────

// No-token severity heuristic used when live AI updates are paused. Takes the
// portfolio explicitly — "held" is the whole point of the heuristic and it
// differs per account.
function heuristicSeverity(event: RawEvent, portfolio: Portfolio): { severity: "critical" | "high" | "info"; rationale: string } {
  const held = portfolio.holdings.some((h) => h.ticker === event.ticker);
  const kind = event.kind;
  if (kind === "death_cross") return { severity: "high", rationale: "AI paused — death cross on held position (rule-based)." };
  if (kind === "market_mover") return { severity: "info", rationale: "AI paused — abnormal mover promoted to monitoring (rule-based)." };
  if (kind === "screener_short" && held) return { severity: "critical", rationale: "AI paused — strong short setup on a HELD position (rule-based)." };
  if (kind === "golden_cross" || kind === "screener_pick" || kind === "screener_short")
    return { severity: "high", rationale: "AI paused — screener setup (rule-based)." };
  if ((kind === "filing" || kind === "earnings" || kind === "price_move") && held)
    return { severity: "high", rationale: "AI paused — material event on held position (rule-based)." };
  return { severity: "info", rationale: "AI paused — rule-based severity." };
}

// One event, interpreted once per account that watches the ticker. `owners` is
// empty for a swept market mover nobody holds — then nothing is triaged and no
// tokens are spent, which is the desired behaviour rather than an edge case.
async function processEvent(event: RawEvent, owners: number[]) {
  if (!owners.length) return;
  const live = await aiLive();
  // Read once: the global events.severity should end up as the strongest
  // reading any account gave it, not whichever account happened to run last.
  let strongest = "";

  for (const userId of owners) {
    const portfolio = currentPortfolio(userId);
    let triage;
    let signal = null;

    if (!live) {
      // Live updates paused: no tokens spent — rule-based severity, no analysis.
      triage = heuristicSeverity(event, portfolio);
    } else {
      triage = await triageEvent(event, portfolio);
      if (triage.severity === "critical" || triage.severity === "high") {
        signal = await analyzeEvent(event, portfolio, userId);
      }
    }

    await setTriageFor(event.id, userId, triage.severity, triage.rationale);
    if (severityRank(triage.severity) > severityRank(strongest)) strongest = triage.severity;
    console.log(`[pipeline] user ${userId} · ${event.ticker} ${event.kind} → ${triage.severity}: ${event.title}`);

    // Targeted: this severity and this signal are this account's reading.
    broadcastTo(userId, "event", {
      id: event.id, ts: event.ts, ticker: event.ticker, kind: event.kind,
      title: event.title, severity: triage.severity, triage_rationale: triage.rationale,
      ...(signal ?? {}),
    });

    // Notifications fire ONLY for actionable buy/sell advice — plain language.
    const isBuy = signal && (signal.action === "buy" || signal.action === "add");
    const isSell = signal && (signal.action === "sell" || signal.action === "trim");
    if (signal && (isBuy || isSell)) {
      const headline = signal.plain_headline || `${isBuy ? "Consider buying" : "Consider selling"} ${event.ticker}.`;
      // macOS and Telegram are single, machine-wide channels — there is one
      // TELEGRAM_CHAT_ID, not one per account. With more than one monitored
      // account the alert is tagged so it's clear whose position it's about.
      const tag = await accountTag(userId);
      await notifyMac(isBuy ? `Buy idea: ${event.ticker}${tag}` : `Sell alert: ${event.ticker}${tag}`, headline);
      if (telegramEnabled()) {
        await notifyTelegram(`*${isBuy ? "Buy idea" : "Sell alert"}: ${event.ticker}*${tag}\n\n${headline}\n\n_${signal.thesis}_`);
      }
    }
  }

  if (strongest) await setTriage(event.id, strongest, `strongest reading across ${owners.length} monitored account(s)`);
}

// " (vignesh@…)" when more than one account is monitored, "" when there's only
// one — a solo user shouldn't have their own email stapled to every alert.
const emailCache = new Map<number, string>();
async function accountTag(userId: number): Promise<string> {
  if ((await monitoredUserIds()).length < 2) return "";
  if (!emailCache.has(userId)) {
    emailCache.set(userId, (await findUserById(userId))?.email ?? `user ${userId}`);
  }
  return ` (${emailCache.get(userId)})`;
}

async function runDetectors() {
  const phase = marketPhase();
  // The union across accounts: each ticker is detected once, then its events
  // are interpreted for whichever accounts watch it. Two users holding NVDA
  // costs one set of Finnhub calls, not two.
  const watch = await watchMap();
  const tickers = [...watch.keys()];
  for (const t of tickers) {
    try {
      const events: RawEvent[] = [];
      if (phase !== "closed") events.push(...(await detectPriceVolume(t)));
      events.push(...(await detectNews(t)));
      events.push(...(await detectFilings(t)));
      for (const e of events) await processEvent(e, watch.get(t) ?? []);
      await Bun.sleep(1100); // respect Finnhub 60 req/min free tier
    } catch (err) {
      console.error(`[detectors] ${t}:`, err);
    }
  }
  // Dynamically-promoted market movers (from the index sweep): news + filings
  // only — they have no local bar history for price detectors, and their move
  // was already captured by the sweep event itself. Nobody holds these by
  // definition, so they go to every monitored account as market awareness.
  const everyone = await monitoredUserIds();
  for (const t of activeDynamicTickers()) {
    try {
      const events: RawEvent[] = [];
      events.push(...(await detectNews(t)));
      events.push(...(await detectFilings(t)));
      for (const e of events) await processEvent(e, watch.get(t) ?? everyone);
      await Bun.sleep(1100);
    } catch (err) {
      console.error(`[detectors:dynamic] ${t}:`, err);
    }
  }
  try {
    for (const e of await detectEarnings(tickers)) await processEvent(e, watch.get(e.ticker) ?? []);
  } catch (err) {
    console.error("[detectors] earnings:", err);
  }
  // Price/score alerts ride the detector cadence (~90s open). The evaluator
  // fetches its own quotes for alert tickers outside the portfolio set.
  try {
    await evaluateActiveAlerts();
  } catch (err) {
    console.error("[detectors] alerts:", err);
  }
}

// ── Scheduling ───────────────────────────────────────────────────────────────

let detectorRunning = false;
async function detectorLoop() {
  if (detectorRunning) return;
  detectorRunning = true;
  try {
    await runDetectors();
  } finally {
    detectorRunning = false;
  }
}

function scheduleDetectors() {
  const tick = async () => {
    const phase = marketPhase();
    await detectorLoop();
    // market open: ~90s cycles; extended: 5 min; closed: 30 min (filings still land off-hours)
    const delay = phase === "open" ? 90_000 : phase === "extended" ? 300_000 : 1_800_000;
    setTimeout(tick, delay);
  };
  tick();
}

let lastBriefingDay = { open: "", close: "" };
function scheduleBriefings() {
  setInterval(async () => {
    const { mins, day } = etNow();
    if (day === 0 || day === 6) return;
    const today = new Date().toISOString().slice(0, 10);
    // 9:00 ET pre-market, 16:15 ET post-close
    const kind = mins >= 9 * 60 && mins < 9 * 60 + 10 ? "open"
               : mins >= 16 * 60 + 15 && mins < 16 * 60 + 25 ? "close" : null;
    if (!kind || lastBriefingDay[kind] === today) return;
    if (!aiLive()) return; // live updates paused — skip scheduled briefings
    lastBriefingDay[kind] = today;
    // One briefing per account, each written against that account's positions.
    // A deep-model call each, twice a day — the largest fixed per-account cost
    // in the fan-out. Accounts with nothing to brief on are skipped rather than
    // paying for "you hold nothing".
    for (const u of await monitoredUsers()) {
      if (!allTickers(u.portfolio).length) continue;
      try {
        console.log(`[briefing] generating ${kind} briefing for user ${u.id}`);
        const content = await generateBriefing(kind, u.portfolio, u.id);
        broadcastTo(u.id, "briefing", { kind, content });
        // no notification — briefings live on the dashboard; alerts are reserved for buy/sell advice
      } catch (err) {
        console.error(`[briefing] user ${u.id}:`, err);
      }
    }
  }, 5 * 60_000);
}

// Index sweep: every 15 min during market hours, batch-quote the scan universe
// and promote abnormal movers into live news/filing monitoring.
function scheduleSweep() {
  const sweep = async () => {
    if (marketPhase() === "closed") return;
    try {
      const universe = await scanUniverse();
      if (!universe.length) return;
      // "watched" excludes tickers already covered by the detector loop — that's
      // the union across accounts now, so a name one user holds isn't swept as
      // an anonymous mover for everyone else.
      const watch = await watchMap();
      const events = await sweepIndex(universe, new Set(watch.keys()));
      // A swept mover is a name nobody holds, so it's market awareness for every
      // monitored account rather than a position-specific alert.
      const everyone = await monitoredUserIds();
      for (const e of events) await processEvent(e, everyone);
    } catch (err) {
      console.error("[sweep]", err);
    }
  };
  setTimeout(sweep, 60_000); // first sweep 1 min after boot
  setInterval(sweep, 15 * 60_000);
}

// Screener: full scan at boot, then every 6 hours. Pure math — no AI cost;
// any setups it finds flow through processEvent (which respects the AI toggle).
// Market context (regime/sectors) refreshes right before each scan so scores
// and idea validation always reference the current tape.
function scheduleScreener() {
  const scan = async () => {
    try {
      await refreshMarketContext();
      broadcast("market", {});
      // runScan takes a portfolio only to bias which names it surfaces; the
      // scan itself is universe-wide, so the union portfolio covers everyone.
      const watch = await watchMap();
      const events = await runScan(unionPortfolio(await monitoredUsers()));
      const everyone = await monitoredUserIds();
      // A screener setup on a name you hold is about your position; on any other
      // name it's a general idea, so it goes to all monitored accounts.
      for (const e of events) await processEvent(e, watch.get(e.ticker) ?? everyone);
      broadcast("market", {}); // breadth updates after the scan completes
    } catch (err) {
      console.error("[screener]", err);
    }
  };
  scan();
  setInterval(scan, 6 * 3600_000);
}

// Market context alone is cheap (~16 chart fetches) — keep the regime fresh
// between scans during trading hours.
function scheduleMarketContext() {
  setInterval(async () => {
    if (marketPhase() === "closed") return;
    try {
      await refreshMarketContext();
      broadcast("market", {});
    } catch (err) {
      console.error("[market]", err);
    }
  }, 90 * 60_000);
}

// Data-feed canaries (SHARP-9): every 30 minutes, plus one probe a minute after
// boot so a feed that broke overnight is visible before the first scan leans on
// it. Deliberately not tied to market hours — a shape change on a Sunday is
// still worth knowing about before Monday's open.
function scheduleCanaries() {
  const tick = async () => {
    try { await runCanaries(); } catch (err) { console.error("[canary]", err); }
  };
  setTimeout(tick, 60_000);
  setInterval(tick, 30 * 60_000);
}

// Expired sessions, swept daily. cleanupExpiredSessions() has existed since auth
// was added but was never actually called, so sessions accumulated forever — 14
// rows survived across three accounts before the last account reset. Not
// load-bearing (validateSession already checks expiry), this just stops dead
// rows piling up.
function scheduleAuthCleanup() {
  const tick = async () => {
    try { await cleanupExpiredSessions(); } catch (err) { console.error("[auth] cleanup:", err); }
  };
  setTimeout(tick, 120_000);
  setInterval(tick, 24 * 3600_000);
}

// Universe: rebuild daily (constituents/market caps drift slowly).
function scheduleUniverse() {
  setInterval(async () => {
    try {
      const scan = await refreshUniverse(unionPortfolio(await monitoredUsers()));
      await loadCikMap(scan);
    } catch (err) {
      console.error("[universe]", err);
    }
  }, 24 * 3600_000);
}

// Broker: re-pull positions/orders/equity and push to the dashboard. A live
// linked broker (Robinhood) refreshes every 60s while the market is open
// for near-live position updates; otherwise every 15 minutes.
// Every account is refreshed, not just the first — a linked broker is what makes
// an account's monitoring real, and it used to be pulled on a timer for user 1
// only. The cadence is driven by whether ANY account has a live link.
function scheduleBroker() {
  const tick = async () => {
    let anyLive = false;
    for (const id of await monitoredUserIds()) {
      try {
        const snap = await refreshBroker(id);
        if (snap.source === "robinhood") anyLive = true;
        broadcastTo(id, "broker", { source: snap.source });
      } catch (err) {
        console.error(`[broker] user ${id}:`, err);
      }
    }
    setTimeout(tick, anyLive && marketPhase() === "open" ? 60_000 : 15 * 60_000);
  };
  setTimeout(tick, 60_000);
}

// Insights: upcoming-earnings cache + options expiry warnings. Twice a day is
// plenty — earnings dates and days-to-expiry move on a daily clock.
function scheduleInsights() {
  const tick = async () => {
    try {
      const users = await monitoredUsers();
      // Expiry warnings are position-specific — "your NVDA calls expire in 3
      // days" only means something against the portfolio that holds them.
      for (const u of users) {
        try { await checkOptionExpiries(u.portfolio, u.id); }
        catch (err) { console.error(`[insights] expiries for user ${u.id}:`, err); }
      }
      // The earnings cache is a shared lookup keyed by ticker, so it's filled
      // once from the union rather than re-fetched per account.
      const union = unionPortfolio(users);
      const held = union.holdings.filter((h) => (h.asset_class ?? "equity") === "equity").map((h) => h.ticker);
      await refreshEarnings([...new Set(held)]);
      console.log(`[insights] tick done — ${users.length} accounts, ${union.holdings.filter((h) => h.asset_class === "option").length} options checked, earnings refreshed for ${held.length} tickers`);
      broadcast("broker", { source: "insights" }); // nudge the dashboard to re-pull state (earnings chips)
    } catch (err) {
      console.error("[insights]", err);
    }
  };
  setTimeout(tick, 90_000); // after the boot broker snapshot settles
  setInterval(tick, 12 * 3600_000);
}

function scheduleDailyStats() {
  const refresh = async () => {
    for (const t of allTickers(unionPortfolio(await monitoredUsers()))) {
      try {
        await refreshDailyStats(t);
        await Bun.sleep(1100);
      } catch (err) {
        console.error(`[stats] ${t}:`, err);
      }
    }
    console.log("[stats] daily stats refreshed");
  };
  refresh();
  setInterval(refresh, 6 * 3600_000);
}

// Dev-only synthetic event injection: POST /api/test-event
setTestEventHandler(async (body) => {
  const ticker = (body.ticker ?? [...bootWatch.keys()][0] ?? "SPY").toUpperCase();
  const event: RawEvent = {
    id: 0, ts: Math.floor(Date.now() / 1000), ticker,
    kind: body.kind ?? "news",
    title: body.title ?? `${ticker} test event: surprise CEO resignation announced`,
    detail: body.detail ?? { source: "test", summary: "Synthetic event for pipeline verification." },
  };
  const { insertEvent } = await import("./db");
  const id = await insertEvent({ ...event, dedupeKey: `test:${Date.now()}` });
  // Test events exercise the whole fan-out, so they go to every account.
  if (id) await processEvent({ ...event, id }, await monitoredUserIds());
});

// On-demand briefing from the dashboard button: "open"-style before 1pm ET, else
// "close"-style. Written for whoever clicked it, not for a fixed account.
setBriefingHandler(async (userId) => {
  const kind = etNow().mins < 13 * 60 ? "open" : "close";
  console.log(`[briefing] on-demand ${kind} briefing requested by user ${userId}`);
  const content = await generateBriefing(kind, currentPortfolio(userId), userId);
  broadcastTo(userId, "briefing", { kind, content });
  return content;
});

// ── Boot ─────────────────────────────────────────────────────────────────────

// Listen before the slow part. refreshUniverse walks ~12k NASDAQ symbols and
// loadCikMap resolves ~3k CIKs against EDGAR, which together can run for minutes
// on a cold container — long enough that a hosting platform's healthcheck gives up
// and marks the deploy failed while the process is in fact healthy. Serving first
// costs nothing: routes read the database per request, and the only things warming
// up behind this are search coverage and EDGAR lookups.
startServer();

// Universe first (sector metadata + scan list), then CIK map so EDGAR lookups
// work for any promoted mover across the whole universe.
const universeList = await refreshUniverse(unionPortfolio(await monitoredUsers()));
await seedFutures(); // futures contracts join the universe (searchable/scorable/chartable)
await loadCikMap(universeList);
// One websocket subscription list covering every account's tickers — trades are
// public, so a shared stream is both correct and the only affordable option.
startTradeStream([...bootWatch.keys()]);
scheduleDailyStats();
scheduleDetectors();
scheduleBriefings();
scheduleScreener();
scheduleSweep();
scheduleMarketContext();
scheduleUniverse();
scheduleBroker();
scheduleInsights();
scheduleCanaries();
scheduleAuthCleanup();
startCacheHeartbeat(unionPortfolio(await monitoredUsers()));
console.log(`[sharpEdge] running — market is currently ${marketPhase()}`);
