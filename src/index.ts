import { config, allTickers, marketPhase, etNow } from "./config";
import { aiLive } from "./db";
import { runScan } from "./engine/screener";
import { evaluateActiveAlerts } from "./engine/alerts";
import { refreshUniverse, scanUniverse } from "./ingest/universe";
import { refreshMarketContext } from "./engine/market";
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
import { startServer, broadcast, setTestEventHandler, setBriefingHandler } from "./server/server";

if (!config.finnhubKey) {
  console.error("FINNHUB_API_KEY is not set. Get a free key at https://finnhub.io and put it in .env");
  process.exit(1);
}

// Background monitoring (detectors, triage, scheduled briefings, sweep) is a
// single shared pipeline, not fanned out per signed-in user — it watches one
// account's holdings/watchlist. That account is whoever signed up first (user
// id 1, the original single-user data's new owner). Other users get the
// interactive features (validate/generate/intraday/chat, their own linked
// broker) but not their own independent background event monitoring.
const PRIMARY_USER_ID = 1;

// Broker snapshot first: positions/watchlist may come from a linked account
// (Robinhood), a prior JSON import, or portfolio.yaml — everything downstream
// reads currentPortfolio(PRIMARY_USER_ID) so it always sees the freshest view.
await refreshBroker(PRIMARY_USER_ID);
const bootTickers = allTickers(currentPortfolio(PRIMARY_USER_ID));
console.log(`[sharpEdge] monitoring ${bootTickers.length} tickers: ${bootTickers.join(", ")}`);

// Circuit breaker trips fire an immediate CRITICAL alert on every channel.
setTripHandler(async (name, count, windowSec) => {
  const msg = `Circuit Breaker Tripped — ${name} hit ${count} calls in ${windowSec}s. AI halted to prevent spend. Monitoring continues; reset from the dashboard.`;
  broadcast("health", { breakerTripped: name });
  await notifyMac("🚨 sharpEdge: AI HALTED", msg);
  if (telegramEnabled()) await notifyTelegram(`🚨 *sharpEdge: AI HALTED*\n\n${msg}`);
});

// ── Pipeline: event → triage → (analysis) → notify → broadcast ──────────────

// No-token severity heuristic used when live AI updates are paused.
function heuristicSeverity(event: RawEvent): { severity: "critical" | "high" | "info"; rationale: string } {
  const held = currentPortfolio(PRIMARY_USER_ID).holdings.some((h) => h.ticker === event.ticker);
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

async function processEvent(event: RawEvent) {
  const portfolio = currentPortfolio(PRIMARY_USER_ID);
  let triage;
  let signal = null;

  if (!(await aiLive())) {
    // Live updates paused: no tokens spent — rule-based severity, no analysis.
    triage = heuristicSeverity(event);
    const { setTriage } = await import("./db");
    await setTriage(event.id, triage.severity, triage.rationale);
  } else {
    triage = await triageEvent(event, portfolio);
    if (triage.severity === "critical" || triage.severity === "high") {
      signal = await analyzeEvent(event, portfolio);
    }
  }
  console.log(`[pipeline] ${event.ticker} ${event.kind} → ${triage.severity}: ${event.title}`);

  broadcast("event", {
    id: event.id, ts: event.ts, ticker: event.ticker, kind: event.kind,
    title: event.title, severity: triage.severity, triage_rationale: triage.rationale,
    ...(signal ?? {}),
  });

  // Notifications fire ONLY for actionable buy/sell advice — plain language.
  const isBuy = signal && (signal.action === "buy" || signal.action === "add");
  const isSell = signal && (signal.action === "sell" || signal.action === "trim");
  if (signal && (isBuy || isSell)) {
    const headline = signal.plain_headline || `${isBuy ? "Consider buying" : "Consider selling"} ${event.ticker}.`;
    await notifyMac(isBuy ? `Buy idea: ${event.ticker}` : `Sell alert: ${event.ticker}`, headline);
    if (telegramEnabled()) {
      await notifyTelegram(`*${isBuy ? "Buy idea" : "Sell alert"}: ${event.ticker}*\n\n${headline}\n\n_${signal.thesis}_`);
    }
  }
}

async function runDetectors() {
  const phase = marketPhase();
  const tickers = allTickers(currentPortfolio(PRIMARY_USER_ID));
  for (const t of tickers) {
    try {
      const events: RawEvent[] = [];
      if (phase !== "closed") events.push(...(await detectPriceVolume(t)));
      events.push(...(await detectNews(t)));
      events.push(...(await detectFilings(t)));
      for (const e of events) await processEvent(e);
      await Bun.sleep(1100); // respect Finnhub 60 req/min free tier
    } catch (err) {
      console.error(`[detectors] ${t}:`, err);
    }
  }
  // Dynamically-promoted market movers (from the index sweep): news + filings
  // only — they have no local bar history for price detectors, and their move
  // was already captured by the sweep event itself.
  for (const t of activeDynamicTickers()) {
    try {
      const events: RawEvent[] = [];
      events.push(...(await detectNews(t)));
      events.push(...(await detectFilings(t)));
      for (const e of events) await processEvent(e);
      await Bun.sleep(1100);
    } catch (err) {
      console.error(`[detectors:dynamic] ${t}:`, err);
    }
  }
  try {
    for (const e of await detectEarnings(tickers)) await processEvent(e);
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
    try {
      console.log(`[briefing] generating ${kind} briefing`);
      const content = await generateBriefing(kind, currentPortfolio(PRIMARY_USER_ID));
      broadcast("briefing", { kind, content });
      // no notification — briefings live on the dashboard; alerts are reserved for buy/sell advice
    } catch (err) {
      console.error("[briefing]", err);
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
      const watched = new Set(allTickers(currentPortfolio(PRIMARY_USER_ID)));
      const events = await sweepIndex(universe, watched);
      for (const e of events) await processEvent(e);
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
      const events = await runScan(currentPortfolio(PRIMARY_USER_ID));
      for (const e of events) await processEvent(e);
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

// Universe: rebuild daily (constituents/market caps drift slowly).
function scheduleUniverse() {
  setInterval(async () => {
    try {
      const scan = await refreshUniverse(currentPortfolio(PRIMARY_USER_ID));
      await loadCikMap(scan);
    } catch (err) {
      console.error("[universe]", err);
    }
  }, 24 * 3600_000);
}

// Broker: re-pull positions/orders/equity and push to the dashboard. A live
// linked broker (Robinhood) refreshes every 60s while the market is open
// for near-live position updates; otherwise every 15 minutes.
function scheduleBroker() {
  const tick = async () => {
    let source = "manual";
    try {
      const snap = await refreshBroker(PRIMARY_USER_ID);
      source = snap.source;
      broadcast("broker", { source });
    } catch (err) {
      console.error("[broker]", err);
    }
    const live = source === "robinhood";
    setTimeout(tick, live && marketPhase() === "open" ? 60_000 : 15 * 60_000);
  };
  setTimeout(tick, 60_000);
}

// Insights: upcoming-earnings cache + options expiry warnings. Twice a day is
// plenty — earnings dates and days-to-expiry move on a daily clock.
function scheduleInsights() {
  const tick = async () => {
    try {
      const portfolio = currentPortfolio(PRIMARY_USER_ID);
      await checkOptionExpiries(portfolio);
      const held = portfolio.holdings.filter((h) => (h.asset_class ?? "equity") === "equity").map((h) => h.ticker);
      await refreshEarnings([...new Set(held)]);
      console.log(`[insights] tick done — ${portfolio.holdings.filter((h) => h.asset_class === "option").length} options checked, earnings refreshed for ${held.length} tickers`);
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
    for (const t of allTickers(currentPortfolio(PRIMARY_USER_ID))) {
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
  const ticker = (body.ticker ?? bootTickers[0]).toUpperCase();
  const event: RawEvent = {
    id: 0, ts: Math.floor(Date.now() / 1000), ticker,
    kind: body.kind ?? "news",
    title: body.title ?? `${ticker} test event: surprise CEO resignation announced`,
    detail: body.detail ?? { source: "test", summary: "Synthetic event for pipeline verification." },
  };
  const { insertEvent } = await import("./db");
  const id = await insertEvent({ ...event, dedupeKey: `test:${Date.now()}` });
  if (id) await processEvent({ ...event, id });
});

// On-demand briefing from the dashboard button: "open"-style before 1pm ET, else "close"-style.
setBriefingHandler(async () => {
  const kind = etNow().mins < 13 * 60 ? "open" : "close";
  console.log(`[briefing] on-demand ${kind} briefing requested`);
  const content = await generateBriefing(kind, currentPortfolio(PRIMARY_USER_ID));
  broadcast("briefing", { kind, content });
  return content;
});

// ── Boot ─────────────────────────────────────────────────────────────────────

// Universe first (sector metadata + scan list), then CIK map so EDGAR lookups
// work for any promoted mover across the whole universe.
const universeList = await refreshUniverse(currentPortfolio(PRIMARY_USER_ID));
await loadCikMap(universeList);
startServer();
startTradeStream(bootTickers);
scheduleDailyStats();
scheduleDetectors();
scheduleBriefings();
scheduleScreener();
scheduleSweep();
scheduleMarketContext();
scheduleUniverse();
scheduleBroker();
scheduleInsights();
startCacheHeartbeat(currentPortfolio(PRIMARY_USER_ID));
console.log(`[sharpEdge] running — market is currently ${marketPhase()}`);
