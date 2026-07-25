// Intraday setup analyzer: fuses a chart screenshot (optional) with live
// intraday bars, higher-timeframe structure, relative volume, market tape,
// same-day news, and account risk context into a concrete trade plan — or an
// honest "no trade". A screenshot alone is never trusted blindly: when a ticker
// is provided the model must cross-check the chart against real data, and
// 1-minute setups must be validated against higher-timeframe structure before
// they count as anything more than noise.
import Anthropic from "@anthropic-ai/sdk";
import { config, marketPhase, type Portfolio } from "../config";
import { db } from "../db";
import { fetchIntradayBars, fetchDailyCandles, type IntradayBars } from "../ingest/yahoo";
import { fetchCompanyNews, fetchNextEarnings, cachedQuote } from "../ingest/finnhub";
import { fetchOptionsSummary, optionsContextText } from "../ingest/options";
import { stressStructure, type Leg } from "../engine/optionsMath";
import { universeMeta, sectorEtf } from "../ingest/universe";
import { computeIndicators } from "../engine/screener";
import { benchmarkCandles, refreshMarketContext, marketContextText } from "../engine/market";
import { rsi, macd, vwap, pivotLevels, atr, type Bar } from "../engine/technicals";
import { positionSizing, accountContextText, loadRiskConfigFor } from "../broker";
import { claudeQueue, parseJsonResponse } from "./queue";
import { opusBreaker } from "./breaker";

const client = new Anthropic();

export interface IntradayRequest {
  ticker?: string;
  timeframe?: "1m" | "5m" | "15m" | "60m";
  image?: string;         // single chart (legacy) — data URL or raw base64
  images?: { label: string; data: string }[]; // labeled multi-timeframe charts (e.g. 1D/1W/1M)
  mode?: "intraday" | "swing"; // swing = multi-day/position + options strategy
  notes?: string;
  options?: boolean;
}

export interface IntradayPlan {
  ticker: string;
  regime: string;
  setup_quality: "strong" | "moderate" | "weak" | "no_trade";
  direction: "long" | "short" | "no_trade";
  trade_type: "scalp" | "momentum" | "trend_continuation" | "mean_reversion" | "no_trade";
  timeframe_note: string;
  chart_read: string;
  entry_zone: string;
  stop_loss: string;
  targets: string[];
  invalidation: string;
  holding_period: string;
  confidence: "high" | "medium" | "low";
  risk_reward: string;
  exit_plan: string;
  sizing: string;
  what_would_improve: string;
  warnings: string[];
  options_view?: {
    stance: "calls" | "puts" | "spread" | "neutral" | "avoid";
    strike_range: string;
    expiry_range: string;
    iv_context: string;
    upside_risk: string;
    downside_risk: string;
    strategy?: OptionsStrategy;
  };
}

// Concrete multi-leg options structure (swing mode). Legs are repriced/stress-
// tested deterministically by optionsMath after the model proposes them.
export interface OptionsLeg {
  action: "buy" | "sell";
  right: "call" | "put";
  strike: number;
  expiry: string;   // ISO date
  quantity: number;
}
export interface OptionsStrategy {
  structure:
    | "long_call" | "long_put" | "vertical_call_spread" | "vertical_put_spread"
    | "calendar" | "straddle" | "strangle" | "iron_condor" | "covered_call"
    | "cash_secured_put" | "none";
  legs: OptionsLeg[];
  net_debit_credit: string;
  max_loss: string;
  max_gain: string;
  breakevens: string[];
  rationale: string;
  stress?: unknown; // attached by optionsMath (Phase E), not produced by the model
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    regime: { type: "string", description: "One sentence: the market tape today + this stock's session character (trending, ranging, gappy, news-driven)." },
    setup_quality: { type: "string", enum: ["strong", "moderate", "weak", "no_trade"] },
    direction: { type: "string", enum: ["long", "short", "no_trade"] },
    trade_type: { type: "string", enum: ["scalp", "momentum", "trend_continuation", "mean_reversion", "no_trade"] },
    timeframe_note: { type: "string", description: "The noise check: is this move real or 1-minute noise? Does higher-timeframe structure support it?" },
    chart_read: { type: "string", description: "What the chart (screenshot and/or data) actually shows: trend structure, key levels, volume behavior, momentum. If a screenshot conflicts with the live data, say so." },
    entry_zone: { type: "string" },
    stop_loss: { type: "string" },
    targets: { type: "array", items: { type: "string" } },
    invalidation: { type: "string", description: "The observable condition that kills the setup (level lost, VWAP reclaim against you, volume dying...)." },
    holding_period: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    risk_reward: { type: "string" },
    exit_plan: { type: "string", description: "Scale-out/trail rules AND the early-exit condition if the setup stalls." },
    sizing: { type: "string", description: "Concrete sizing from the provided account math; if no equity known, express as % risk. Include max risk per trade." },
    what_would_improve: { type: "string", description: "The confirmation that would upgrade this setup (e.g. 'a 5m close above VWAP on >1.5x volume')." },
    warnings: { type: "array", items: { type: "string" } },
    options_view: {
      type: "object",
      description: "Only when options data was provided in the input.",
      properties: {
        stance: { type: "string", enum: ["calls", "puts", "spread", "neutral", "avoid"] },
        strike_range: { type: "string" },
        expiry_range: { type: "string" },
        iv_context: { type: "string" },
        upside_risk: { type: "string" },
        downside_risk: { type: "string" },
        strategy: {
          type: "object",
          description: "A concrete, executable options structure. Strikes and expiries MUST come from the provided chain. Include only when an options play is warranted.",
          properties: {
            structure: {
              type: "string",
              enum: ["long_call", "long_put", "vertical_call_spread", "vertical_put_spread", "calendar", "straddle", "strangle", "iron_condor", "covered_call", "cash_secured_put", "none"],
            },
            legs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["buy", "sell"] },
                  right: { type: "string", enum: ["call", "put"] },
                  strike: { type: "number" },
                  expiry: { type: "string", description: "ISO date YYYY-MM-DD, from the chain." },
                  quantity: { type: "number", description: "Number of contracts, positive." },
                },
                required: ["action", "right", "strike", "expiry", "quantity"],
                additionalProperties: false,
              },
            },
            net_debit_credit: { type: "string", description: "Net premium in dollars per structure (debit paid or credit received)." },
            max_loss: { type: "string" },
            max_gain: { type: "string" },
            breakevens: { type: "array", items: { type: "string" } },
            rationale: { type: "string" },
          },
          required: ["structure", "legs", "net_debit_credit", "max_loss", "max_gain", "breakevens", "rationale"],
          additionalProperties: false,
        },
      },
      required: ["stance", "strike_range", "expiry_range", "iv_context", "upside_risk", "downside_risk"],
      additionalProperties: false,
    },
  },
  required: [
    "regime", "setup_quality", "direction", "trade_type", "timeframe_note", "chart_read", "entry_zone",
    "stop_loss", "targets", "invalidation", "holding_period", "confidence", "risk_reward", "exit_plan",
    "sizing", "what_would_improve", "warnings",
  ],
  additionalProperties: false,
} as const;

const INTRADAY_SYSTEM = `You are the intraday analysis engine of a trading decision-support system for one self-directed trader. You receive some combination of: a chart screenshot, live intraday bars with computed session statistics, higher-timeframe (daily) structure, market tape context, same-day news, and account risk parameters. Produce a structured intraday assessment.

Hard rules:
- "No trade" is a first-class answer. Chop, low relative volume, mid-range price locations, and conflicted signals should produce setup_quality "no_trade" — never force a plan onto a weak chart.
- A 1-minute chart alone proves nothing. For 1m setups, explicitly judge whether the move is real (participation, follow-through, alignment with 5m/15m and daily structure) or noise, and classify the play: scalp (minutes, small target, tight stop), momentum (ride an active impulse), or trend continuation (higher-timeframe trend resuming). State this in timeframe_note.
- Screenshots are claims, not facts. When live data is provided, cross-check the screenshot against it and call out any mismatch. When ONLY a screenshot is provided, read levels off its axes carefully, use only what is visible, lower your confidence one notch, and say which data you are missing.
- Every plan needs: entry zone with its trigger condition, a stop at a structurally meaningful level (not an arbitrary %), 1-3 targets with level logic, the invalidation condition, expected holding period, and an exit plan that includes when to bail early because the setup stalled (time stop, VWAP loss, volume dying).
- Risk/reward below ~1.5:1 for scalps or ~2:1 for swing-style entries is a weak setup — say so.
- Respect the tape: fighting a strong index trend requires extra evidence. If the market phase is closed/extended, note that the plan is for the next session and levels may gap.
- Position sizing: use the provided account math; never suggest risking more than the trader's max risk per trade. If equity is unknown, express size as % risk.
- SWING MODE: when the input is multi-timeframe charts (1D/1W/1M) the horizon is days-to-weeks, not minutes. Weight the higher-timeframe (weekly/monthly) structure and the week's news sentiment; entry/stop/targets should be swing levels, not scalp ticks. Fill options_view.strategy with a concrete structure whose legs use ONLY strikes and expiries that appear in the provided chain — an invented strike is a hard error. Prefer defined-risk structures (verticals, iron condors) when IV is elevated; naked long premium only when IV is cheap and a real catalyst is expected. State max loss and max gain in dollars.
- Ground every number in the provided data or the visible chart. Never invent prices or levels. Plain English; explain technical terms in the same sentence. Decision support, not licensed financial advice.`;

// Session stats computed from intraday bars (last session in the series).
function sessionStats(bars: IntradayBars) {
  const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
  const lastDay = dayKey(bars.timestamps.at(-1)!);
  const idx = bars.timestamps.map((t, i) => ({ t, i })).filter((x) => dayKey(x.t) === lastDay).map((x) => x.i);
  const sel = (arr: number[]) => idx.map((i) => arr[i]);
  const o = sel(bars.opens), h = sel(bars.highs), l = sel(bars.lows), c = sel(bars.closes), v = sel(bars.volumes);
  const asBars: Bar[] = idx.map((i) => ({
    ts: bars.timestamps[i], open: bars.opens[i], high: bars.highs[i], low: bars.lows[i], close: bars.closes[i], volume: bars.volumes[i],
  }));
  const barsPer30min = bars.interval === "1m" ? 30 : bars.interval === "5m" ? 6 : bars.interval === "15m" ? 2 : 1;
  const orBars = Math.min(barsPer30min, asBars.length);
  return {
    date: lastDay,
    open: o[0],
    high: Math.max(...h),
    low: Math.min(...l),
    last: c.at(-1)!,
    volume: v.reduce((a, b) => a + b, 0),
    vwap: vwap(asBars),
    openingRangeHigh: Math.max(...h.slice(0, orBars)),
    openingRangeLow: Math.min(...l.slice(0, orBars)),
    rsi: rsi(c),
    macdHist: macd(c)?.histogram ?? null,
    closes: c,
    highs: h,
    lows: l,
  };
}

async function buildDataContext(userId: number, req: IntradayRequest): Promise<{ text: string; ticker: string }> {
  const swing = req.mode === "swing";
  const ticker = (req.ticker ?? "").toUpperCase().trim();
  if (!ticker) {
    return {
      ticker: "UNKNOWN",
      text: [
        "NO TICKER PROVIDED — screenshot-only analysis. Read the symbol/timeframe off the chart if visible.",
        "",
        await marketContextText(),
        accountContextText(userId),
      ].join("\n"),
    };
  }

  const tf = req.timeframe ?? "5m";
  const lines: string[] = [];
  const fmt = (v: number | null | undefined, dec = 2) => (v != null ? v.toFixed(dec) : "n/a");
  // Warm the benchmark cache if analysis is requested before the first market refresh.
  if (!benchmarkCandles("SPY")) await refreshMarketContext();

  const intra = await fetchIntradayBars(ticker, tf);
  const daily = await fetchDailyCandles(ticker, "1y", 60);
  let quote: { c: number; dp: number } | null = null;
  try {
    const q = await cachedQuote(ticker);
    quote = { c: q.c, dp: q.dp };
  } catch {}

  if (swing) lines.push(`MODE: SWING/POSITION — judge a multi-day to multi-week setup from the uploaded 1D/1W/1M charts cross-checked against the daily structure below. Intraday session stats are secondary context only.`);
  lines.push(`TICKER: ${ticker} · requested timeframe: ${tf} · market phase now: ${marketPhase()}`);
  if (quote) lines.push(`LIVE QUOTE: $${fmt(quote.c)} (${quote.dp >= 0 ? "+" : ""}${fmt(quote.dp)}% today)`);

  if (intra) {
    const s = sessionStats(intra);
    const piv = pivotLevels(s.highs, s.lows, s.last, 2, 200);
    lines.push(
      ``,
      `SESSION (${s.date}, ${tf} bars):`,
      `open $${fmt(s.open)}  high $${fmt(s.high)}  low $${fmt(s.low)}  last $${fmt(s.last)}  prevClose $${fmt(intra.prevClose)}`,
      `VWAP $${fmt(s.vwap)} (price is ${s.vwap != null ? (s.last >= s.vwap ? "ABOVE" : "BELOW") : "n/a"} VWAP — the session's volume-weighted average price)`,
      `opening range (first 30min): $${fmt(s.openingRangeLow)}–$${fmt(s.openingRangeHigh)} (price is ${s.last > s.openingRangeHigh ? "above it" : s.last < s.openingRangeLow ? "below it" : "inside it"})`,
      `intraday RSI=${fmt(s.rsi, 0)}  MACD-hist=${fmt(s.macdHist, 4)}`,
      `intraday levels: support ${piv.supports.slice(0, 2).map((x) => "$" + fmt(x)).join(", ") || "n/a"}; resistance ${piv.resistances.slice(0, 2).map((x) => "$" + fmt(x)).join(", ") || "n/a"}`
    );
    if (daily) {
      const avgVol20 = daily.volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      if (avgVol20 > 0) lines.push(`relative volume: session ${fmt(s.volume / 1e6, 1)}M vs 20d avg ${fmt(avgVol20 / 1e6, 1)}M/day → ${fmt(s.volume / avgVol20, 2)}x of a full average day`);
    }
  } else {
    lines.push(`(no intraday bars available for ${ticker} — analysis must lean on the screenshot and daily data)`);
  }

  if (daily && daily.closes.length >= 210) {
    const meta = await universeMeta(ticker);
    const ind = computeIndicators(daily, benchmarkCandles("SPY")?.closes ?? null, benchmarkCandles(sectorEtf(meta?.sector))?.closes ?? null);
    if (ind) {
      lines.push(
        ``,
        `HIGHER-TIMEFRAME (daily) STRUCTURE — judge whether the intraday setup aligns with it:`,
        `price vs SMA20/50/200: $${fmt(ind.sma20)}/$${fmt(ind.sma50)}/$${fmt(ind.sma200)} (${fmt(ind.pctVs200, 1)}% vs 200d)  swing structure: ${ind.structure}`,
        `daily cross: ${ind.crossStatus}  daily RSI=${fmt(ind.rsi14, 0)}  daily ATR=${fmt(ind.atrPct, 1)}%  ` +
        `daily levels: support $${fmt(ind.support)}, resistance $${fmt(ind.resistance)}`,
        `prior day: high $${fmt(daily.highs.at(-2))}, low $${fmt(daily.lows.at(-2))}, close $${fmt(daily.closes.at(-2))}`,
        `relative strength vs SPY 1m: ${fmt(ind.rsSpy1m, 1)}pp`
      );
    }
  } else if (daily) {
    const dAtr = atr(daily.highs, daily.lows, daily.closes, 14);
    lines.push(``, `DAILY CONTEXT (short history): last $${fmt(daily.closes.at(-1))}, prior day H/L/C $${fmt(daily.highs.at(-2))}/$${fmt(daily.lows.at(-2))}/$${fmt(daily.closes.at(-2))}, ATR $${fmt(dAtr)}`);
  }

  // Market tape: SPY same-timeframe behavior today.
  const spyIntra = await fetchIntradayBars("SPY", tf === "1m" ? "5m" : tf);
  if (spyIntra) {
    const s = sessionStats(spyIntra);
    lines.push(``, `MARKET TAPE TODAY: SPY $${fmt(s.last)} (session ${intraPct(s.last, spyIntra.prevClose)}), ${s.vwap != null ? (s.last >= s.vwap ? "above" : "below") : "n/a"} its VWAP, session range $${fmt(s.low)}–$${fmt(s.high)}`);
  }
  lines.push(``, await marketContextText());

  // News + earnings proximity. Swing setups weigh the last week of sentiment;
  // intraday only cares about same-day catalysts.
  try {
    const newsDays = swing ? 7 : 1;
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - newsDays * 86400_000).toISOString().slice(0, 10);
    const news = (await fetchCompanyNews(ticker, from, today)).slice(0, swing ? 10 : 6);
    lines.push(``, `NEWS (last ${newsDays} day${newsDays === 1 ? "" : "s"}) — read the sentiment, not just the headlines:`, news.length ? news.map((n) => `- [${new Date(n.datetime * 1000).toISOString().slice(0, 16)}] ${n.headline} (${n.source})`).join("\n") : "(none — treat any move as technical/flow-driven)");
  } catch {}
  const earn = await fetchNextEarnings(ticker);
  if (earn && earn.daysAway <= 5) lines.push(`⚠ EARNINGS ${earn.date} (${earn.daysAway} days away${earn.hour ? ", " + earn.hour : ""}) — overnight holds carry earnings risk.`);

  // Sizing math anchored to a 1-ATR-ish intraday stop so the model has real numbers.
  const px = quote?.c ?? intra?.closes.at(-1);
  if (px && daily) {
    const dAtr = atr(daily.highs, daily.lows, daily.closes, 14);
    if (dAtr) {
      const stopDist = dAtr * 0.35; // typical intraday stop ≈ a fraction of the daily range
      const sz = await positionSizing(userId, px, px - stopDist);
      lines.push(
        ``,
        `SIZING MATH (example with a ${fmt(stopDist)}$ ≈ 0.35×dailyATR stop): ` +
        (sz.accountEquity
          ? `buying power $${sz.accountEquity.toLocaleString()}, max risk ${sz.riskPct}% = $${sz.riskDollars} → ~${sz.shares} shares. Rescale linearly to the actual stop distance you choose.`
          : sz.note)
      );
    }
  }
  lines.push(accountContextText(userId));

  // The trader's own reward:risk bar (Analyze tab) drives what counts as a strong
  // short-term setup here — this is the one place target_rr is consumed now.
  const targetRR = (await loadRiskConfigFor(userId)).target_rr_ratio;
  lines.push(`TARGET REWARD:RISK — the trader wants at least ${targetRR.toFixed(1)}:1 to the first target for a "strong" setup; below that, rate the R:R leg weak and say so.`);

  if (req.options || swing) {
    lines.push(``, optionsContextText(await fetchOptionsSummary(ticker)),
      `Include an options_view: calls/puts/spread/neutral/avoid for this setup, strike + expiry ranges from the chain, and premium risk (IV, theta for short-dated contracts) in plain terms.`);
    if (swing) lines.push(
      `SWING MODE — also fill options_view.strategy with a concrete, executable structure: pick the structure that fits the thesis and IV (elevated IV → favor defined-risk spreads / credit structures over naked long premium), list every leg with real strikes and expiries FROM THE CHAIN ABOVE, and state net debit/credit, max loss, max gain, and breakeven(s) in dollars. If no options play is warranted, set structure "none" with an empty legs array.`);
  }
  if (req.notes) lines.push(``, `TRADER'S NOTES: ${req.notes}`);

  return { ticker, text: lines.join("\n") };
}

function intraPct(last: number, prev: number | null): string {
  if (!prev) return "n/a";
  const p = ((last - prev) / prev) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

function parseImage(image: string): { media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string } | null {
  const m = image.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s);
  if (m) return { media_type: m[1] as any, data: m[2] };
  if (/^[A-Za-z0-9+/=\s]+$/.test(image) && image.length > 100) return { media_type: "image/png", data: image.replace(/\s/g, "") };
  return null;
}

export async function analyzeIntraday(userId: number, req: IntradayRequest, portfolio: Portfolio): Promise<IntradayPlan | { error: string }> {
  if (!opusBreaker.allow()) return { error: "AI circuit breaker is tripped — reset it from the dashboard status bar." };
  // Normalize to a labeled image list (legacy single `image` still works). Cap
  // at 4 (1D/1W/1M charts + an optional options-chain screenshot).
  const imageList = (req.images?.length ? req.images : req.image ? [{ label: "", data: req.image }] : []).slice(0, 4);
  // Screenshot-only analysis is no longer accepted: without a symbol none of the
  // live cross-checks below (bars, daily structure, chain, news, sizing) can run,
  // and the plan degrades to reading a picture.
  if (!req.ticker?.trim()) return { error: "a ticker is required — enter the symbol you're analyzing" };

  const { ticker, text } = await buildDataContext(userId, req);
  const held = portfolio.holdings.find((h) => h.ticker === ticker);

  const content: Anthropic.ContentBlockParam[] = [];
  for (const im of imageList) {
    const img = parseImage(im.data);
    if (!img) return { error: "unsupported image format — paste/upload a PNG, JPEG, or WebP screenshot" };
    content.push({ type: "image", source: { type: "base64", ...img } });
    const caption = im.label === "OPTIONS-CHAIN"
      ? `Above: the trader's options-chain screenshot — use these exact strikes/premiums to build the strategy (prefer them over the delayed live chain).`
      : `Above: the trader's ${im.label ? im.label + " " : ""}chart screenshot. Cross-check it against the live data below${req.ticker ? "" : " (no ticker given — identify it from the chart if visible)"}.`;
    content.push({ type: "text", text: caption });
  }
  content.push({
    type: "text",
    text: `${text}\n${held ? `POSITION: trader holds ${held.shares} shares @ $${held.cost_basis}.` : ""}\n\nAnalyze this intraday situation and produce the structured plan.`,
  });

  try {
    const response = await claudeQueue(() =>
      client.messages.create({
        model: config.modelDeep,
        // Swing mode's plan (full options strategy + every prose field) runs long,
        // and adaptive thinking draws from this same budget — 3072 truncated it.
        max_tokens: 12000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: INTRADAY_SYSTEM, cache_control: { type: "ephemeral" } }],
        output_config: { format: { type: "json_schema", schema: PLAN_SCHEMA } },
        messages: [{ role: "user", content }],
      })
    );
    const plan = { ticker, ...parseJsonResponse<Omit<IntradayPlan, "ticker">>(response, "intraday") };

    // Options legs are model-proposed; the max-loss/gain/breakeven the trader
    // sees is computed deterministically (Black-Scholes), never taken on the
    // model's word. Attaches to strategy.stress.
    const strat = plan.options_view?.strategy;
    if (req.mode === "swing" && strat?.legs?.length && strat.structure !== "none") {
      try {
        const summ = await fetchOptionsSummary(ticker);
        const spot = summ?.spot;
        const iv = summ?.expiries.find((e) => e.atmIv != null)?.atmIv ?? 0.3;
        if (spot) strat.stress = stressStructure(strat.legs as Leg[], spot, iv);
      } catch (e) {
        console.error(`[intraday] stress attach failed for ${ticker}:`, e);
      }
    }
    await db.query(`INSERT INTO ideas (ts, ticker, direction, rating, confidence, source, report, user_id) VALUES (extract(epoch from now())::int, ?, ?, ?, ?, 'intraday', ?, ?)`)
      .run(ticker, plan.direction, plan.setup_quality === "no_trade" ? "reject" : plan.setup_quality, plan.confidence, JSON.stringify(plan), userId);
    return plan;
  } catch (err) {
    console.error(`[intraday] ${ticker} failed:`, err);
    return { error: `intraday analysis failed: ${err}` };
  }
}

// ── In-trade management chat ─────────────────────────────────────────────────
// After a plan is generated, the trader can keep talking to the AI to manage the
// live position — "should I take profit?", "it broke my stop, now what?" — and
// attach fresh screenshots. Re-pulls current data so advice reflects the tape now.
export interface FollowupRequest {
  ticker?: string;
  mode?: "intraday" | "swing";
  plan?: unknown;                                   // the prior structured plan (context)
  question: string;
  images?: { label: string; data: string }[];       // new screenshots added mid-trade
  history?: { role: "user" | "assistant"; content: string }[];
}

const MANAGE_SYSTEM = `You are managing a live trade with the trader. They already have a plan (given below) and are now asking what to do as the trade unfolds. Give direct, decisive, practical guidance — hold / trim / add / exit, where to move the stop or target, whether to roll or close an options position — grounded in the CURRENT data and any new screenshot they attached. Reference their original plan and its invalidation. Plain prose, no JSON, no preamble. Be concise. If the situation is genuinely unclear, say what you'd watch for rather than guessing. You are decision support, not licensed advice.`;

export async function manageTrade(userId: number, req: FollowupRequest, portfolio: Portfolio): Promise<{ answer: string } | { error: string }> {
  if (!opusBreaker.allow()) return { error: "AI circuit breaker is tripped — reset it from the dashboard status bar." };
  const question = String(req.question ?? "").trim();
  if (!question) return { error: "empty question" };

  const { ticker, text } = await buildDataContext(userId, { ticker: req.ticker, mode: req.mode, options: req.mode === "swing" });
  const held = portfolio.holdings.find((h) => h.ticker === ticker);

  const content: Anthropic.ContentBlockParam[] = [];
  for (const im of (req.images ?? []).slice(0, 4)) {
    const img = parseImage(im.data);
    if (img) {
      content.push({ type: "image", source: { type: "base64", ...img } });
      content.push({ type: "text", text: `Above: a new ${im.label ? im.label + " " : ""}screenshot the trader just added.` });
    }
  }
  content.push({
    type: "text",
    text: `ORIGINAL PLAN:\n${JSON.stringify(req.plan ?? {}, null, 2)}\n\nCURRENT DATA:\n${text}\n${held ? `POSITION: trader holds ${held.shares} ${held.asset_class ?? "shares"} @ $${held.cost_basis}.` : ""}\n\nThe trader is managing the trade and asks:\n"${question}"`,
  });

  const messages: Anthropic.MessageParam[] = [
    ...(req.history ?? []).slice(-8).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content },
  ];

  try {
    const res = await claudeQueue(() =>
      client.messages.create({
        model: config.modelDeep,
        max_tokens: 1200,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: MANAGE_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages,
      })
    );
    const answer = res.content.find((b) => b.type === "text")?.text ?? "";
    return { answer };
  } catch (err) {
    console.error(`[intraday] followup ${ticker} failed:`, err);
    return { error: `follow-up failed: ${err}` };
  }
}
