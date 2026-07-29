// Unified long/short idea validation — the core decision-support engine.
//
// Every idea (screener candidate, user ticker, generated batch) goes through
// the same pipeline: deterministic evidence gathering (technicals, levels,
// relative strength, sector rotation, market regime, news, earnings proximity,
// risk-first trade frame) → one deep-reasoning AI pass that must score each
// evidence dimension separately, stress-test the idea across market scenarios,
// and only rate it strong on genuine multi-factor confluence. Momentum alone is
// never sufficient; shorts require structural breakdown plus a bearish case,
// not just recent weakness. Conservative by design: when in doubt, downgrade.
import Anthropic from "@anthropic-ai/sdk";
import { config, loadRiskConfig, type Portfolio } from "../config";
import { db } from "../db";
import { fetchDailyCandles } from "../ingest/candles";
import { fetchCompanyNews, fetchNextEarnings, cachedQuote } from "../ingest/finnhub";
import { fetchOptionsSummary, optionsContextText, type OptionsSummary } from "../ingest/options";
import { stressStructure, type Leg } from "../engine/optionsMath";
import { universeMeta, sectorEtf } from "../ingest/universe";
import { computeIndicators, scoreLong, scoreShort, directionOf, type Indicators, type ScreenRow, getScreenerRows } from "../engine/screener";
import { benchmarkCandles, refreshMarketContext, getMarketSnapshot, marketContextText } from "../engine/market";
import { positionSizing, accountContextText, type SizingPlan } from "../broker";
import { journalContextText } from "./journal";
import { claudeQueue, parseJsonResponse } from "./queue";
import { opusBreaker } from "./breaker";

const client = new Anthropic();

export interface IdeaReport {
  ticker: string;
  direction: "long" | "short" | "no_trade";
  rating: "strong" | "moderate" | "weak" | "reject";
  confidence: "high" | "medium" | "low";
  headline: string;
  scores: {
    technical: number;
    catalyst: number;
    market_alignment: number;
    news_sentiment: number;
    risk_reward: number;
    invalidation_clarity: number;
  };
  technical_reasons: string[];
  news_reasons: string[];
  catalyst: { description: string; quality: "strong" | "moderate" | "noisy" | "conflicting" | "none" };
  trade_plan: {
    entry_zone: string;
    stop_loss: string;
    targets: string[];
    risk_reward: string;
    holding_period: string;
  };
  invalidation: string;
  stress_tests: {
    base_case: string;
    bull_case: string;
    bear_case: string;
    invalidation_case: string;
    survives_risk_off: boolean;
    risk_off_note: string;
    single_condition_dependency: string;
  };
  sector_context: string;
  sizing: string;
  exit_plan: string;
  warnings: string[];
  options_view?: {
    // The AI picks a structure from the full menu and proposes concrete legs;
    // maxLoss/maxGain/breakevens are computed server-side (Black-Scholes),
    // never taken on the model's word — same pattern as the trade frame.
    strategy:
      | "long_call" | "long_put"
      | "vertical_call_debit" | "vertical_call_credit"
      | "vertical_put_debit" | "vertical_put_credit"
      | "straddle" | "strangle" | "iron_condor"
      | "covered_call" | "cash_secured_put" | "calendar"
      | "neutral" | "avoid";
    legs: Leg[];
    rationale: string;
    iv_context: string;
    pricing?: {
      entryCost: number;      // net debit(+)/credit(−), dollars
      maxLoss: number;
      maxGain: number;
      breakevens: number[];
      note: string;
    };
  };
}

const IDEA_SCHEMA = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["long", "short", "no_trade"] },
    rating: { type: "string", enum: ["strong", "moderate", "weak", "reject"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    headline: { type: "string", description: "One plain-English sentence stating the verdict and the core reason." },
    scores: {
      type: "object",
      description: "0-10 per dimension, honest and independent — do not let one strong dimension inflate the others.",
      properties: {
        technical: { type: "number" }, catalyst: { type: "number" }, market_alignment: { type: "number" },
        news_sentiment: { type: "number" }, risk_reward: { type: "number" }, invalidation_clarity: { type: "number" },
      },
      required: ["technical", "catalyst", "market_alignment", "news_sentiment", "risk_reward", "invalidation_clarity"],
      additionalProperties: false,
    },
    technical_reasons: { type: "array", items: { type: "string" }, description: "The specific technical evidence, each grounded in the provided data." },
    news_reasons: { type: "array", items: { type: "string" }, description: "What the news flow supports or contradicts. Empty array if no relevant news." },
    catalyst: {
      type: "object",
      properties: {
        description: { type: "string" },
        quality: { type: "string", enum: ["strong", "moderate", "noisy", "conflicting", "none"] },
      },
      required: ["description", "quality"],
      additionalProperties: false,
    },
    trade_plan: {
      type: "object",
      properties: {
        entry_zone: { type: "string", description: "Price zone + the condition that makes entry valid (e.g. 'pullback to $182-184 holding above the breakout level')." },
        stop_loss: { type: "string", description: "Specific level + why it is the right invalidation point." },
        targets: { type: "array", items: { type: "string" }, description: "1-3 targets with the level logic (resistance, measured move, R multiple)." },
        risk_reward: { type: "string", description: "Numeric estimate to first/main target, e.g. '~2.3:1 to T1'." },
        holding_period: { type: "string" },
      },
      required: ["entry_zone", "stop_loss", "targets", "risk_reward", "holding_period"],
      additionalProperties: false,
    },
    invalidation: { type: "string", description: "The specific observable condition that proves this idea wrong." },
    stress_tests: {
      type: "object",
      properties: {
        base_case: { type: "string" },
        bull_case: { type: "string", description: "What happens to this trade if the broad market rallies." },
        bear_case: { type: "string", description: "What happens if the broad market sells off." },
        invalidation_case: { type: "string", description: "What the failure looks like and the expected loss if stopped." },
        survives_risk_off: { type: "boolean" },
        risk_off_note: { type: "string", description: "Does the idea still make sense if the market turns risk-off? Why/why not." },
        single_condition_dependency: { type: "string", description: "Whether the idea depends on one narrow condition (e.g. 'only works if earnings beat') — name it, or state it is multi-legged." },
      },
      required: ["base_case", "bull_case", "bear_case", "invalidation_case", "survives_risk_off", "risk_off_note", "single_condition_dependency"],
      additionalProperties: false,
    },
    sector_context: { type: "string", description: "Where its sector sits in the rotation and whether that helps or hurts." },
    sizing: { type: "string", description: "Position sizing guidance built from the provided account sizing math; if no equity known, express as % risk." },
    exit_plan: { type: "string", description: "How to manage the trade: scale-out rules, trailing logic, and when to exit early because the setup failed." },
    warnings: { type: "array", items: { type: "string" }, description: "Material risks: earnings proximity, crowded trade, thin liquidity, news conflict, momentum-only, etc." },
    options_view: {
      type: "object",
      description: "Only when options data was provided in the input. Propose ONE concrete structure with real legs from the strike ladder; max loss/gain/breakevens are computed by the server, not by you.",
      properties: {
        strategy: {
          type: "string",
          enum: [
            "long_call", "long_put",
            "vertical_call_debit", "vertical_call_credit",
            "vertical_put_debit", "vertical_put_credit",
            "straddle", "strangle", "iron_condor",
            "covered_call", "cash_secured_put", "calendar",
            "neutral", "avoid",
          ],
        },
        legs: {
          type: "array",
          description: "Every leg of the structure. Strikes and expiries MUST come from the provided chain ladder. Empty array only for strategy neutral/avoid.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["buy", "sell"] },
              right: { type: "string", enum: ["call", "put"] },
              strike: { type: "number" },
              expiry: { type: "string", description: "ISO date YYYY-MM-DD, from the chain data" },
              quantity: { type: "number", description: "contracts (×100 shares); usually 1" },
            },
            required: ["action", "right", "strike", "expiry", "quantity"],
            additionalProperties: false,
          },
        },
        rationale: { type: "string", description: "Why THIS structure fits the thesis and the IV regime, vs the alternatives on the menu." },
        iv_context: { type: "string", description: "IV level read + crush/theta risk in plain terms." },
      },
      required: ["strategy", "legs", "rationale", "iv_context"],
      additionalProperties: false,
    },
  },
  required: [
    "direction", "rating", "confidence", "headline", "scores", "technical_reasons", "news_reasons",
    "catalyst", "trade_plan", "invalidation", "stress_tests", "sector_context", "sizing", "exit_plan", "warnings",
  ],
  additionalProperties: false,
} as const;

// Stable rubric — byte-identical across calls for prompt-cache hits.
const VALIDATOR_SYSTEM = `You are the idea-validation engine of a trading decision-support system for one self-directed trader. You receive one candidate trade idea (long or short) with pre-computed technical evidence, support/resistance levels, relative strength, sector rotation, market regime, news headlines, earnings timing, and a risk-first trade frame. Produce a structured, conservative validation.

Rating rubric — apply it strictly. The context provides a TARGET RISK/REWARD block with this trader's numeric R:R thresholds; apply those exact numbers wherever this rubric references the R:R bar:
- "strong": at least three INDEPENDENT confirmations (e.g. trend structure + volume-confirmed level break + relative strength + supportive catalyst), a clear invalidation level, risk/reward at or above the trader's stated target to the first target, market/sector context not fighting the trade, and no unresolved news conflict.
- "moderate": two solid confirmations and acceptable risk/reward, but a missing leg (no catalyst, neutral sector, or R:R in the trader's stated moderate band below target).
- "weak": one factor doing all the work, conflicted evidence, poor entry location (extended/chased), or R:R below the trader's stated weak threshold.
- "reject": no edge, structure contradicts the direction, news contradicts the setup without a repricing case, illiquid, or the trade only works in a narrow scenario that current regime makes unlikely.

Hard rules:
- Momentum alone NEVER justifies more than "weak" — a stock having moved up or down recently is not evidence it will continue. Demand structure, participation (volume), relative strength, and context.
- Short ideas must be validated by structural breakdown (trend break, level break, lower-high sequence, distribution volume) AND a bearish thesis. Falling price alone is not a short case; crowded oversold shorts (deep RSI lows) get downgraded for bounce risk.
- If the provided news contradicts the technical direction, say so explicitly in news_reasons, set catalyst quality to "conflicting", and downgrade the rating unless there is a strong repricing argument.
- Distinguish real catalysts (earnings surprises, guidance changes, regulatory decisions, contract wins, activist stakes) from noise (listicles, price-move commentary, routine PR). Noise never raises catalyst score above 3.
- Earnings within the holding period is a material risk: flag it in warnings and reflect it in the plan (size down, exit before, or explicitly frame it as an earnings bet).
- Ground every number in the provided data. Do not invent prices, levels, or news. If a needed input is missing, say so and be more conservative.
- The trade frame provided (entry/stop/targets) is a starting point computed from ATR and levels — refine it with judgment, but keep stops at structurally meaningful levels and state the R:R math.
- Respect the market regime: longs in a risk-off tape and shorts in a strong uptrend need extra evidence; say whether the idea survives a regime flip in stress_tests.
- If a TRADER'S PAST-TRADE JOURNAL block is provided and it shows a recurring mistake relevant to this setup (e.g. repeatedly chasing breakouts without volume confirmation, repeatedly losing on this same ticker, cutting winners early), call it out explicitly in warnings and let it inform the plan — that history is real, not hypothetical.
- If the honest answer is "no trade", return direction "no_trade" with rating "reject" — do not manufacture a plan.
- Plain English throughout; explain any technical term in the same sentence. This is decision support, not licensed financial advice; the trader decides.`;

export interface IdeaContext {
  ticker: string;
  requestedDirection: "long" | "short" | "auto";
  ind: Indicators;
  longScore: number;
  shortScore: number;
  quantDirection: string;
  sector: string;
  industry: string;
  name: string;
  price: number;
  headlines: string;
  earnings: { date: string; daysAway: number; hour: string } | null;
  frame: { direction: string; entry: number; stop: number; t1: number; t2: number; rr: number } | null;
  sizing: SizingPlan | null;
  optionsText: string | null;
  optionsSummary: OptionsSummary | null; // raw chain kept for server-side leg pricing
}

// Deterministic risk-first trade frame from ATR + swing levels. The AI refines
// it; computing it here keeps every plan grounded in real numbers.
function tradeFrame(ind: Indicators, direction: "long" | "short") {
  const atrAbs = ind.atrPct != null ? (ind.atrPct / 100) * ind.price : ind.price * 0.02;
  if (direction === "long") {
    const entry = ind.price;
    const structural = ind.support != null ? ind.support - 0.25 * atrAbs : entry - 1.5 * atrAbs;
    const stop = Math.min(entry - 0.75 * atrAbs, structural);
    const t1 = ind.resistance != null && ind.resistance > entry + (entry - stop) ? ind.resistance : entry + 2 * (entry - stop);
    const t2 = entry + 3 * (entry - stop);
    return { direction, entry, stop, t1, t2, rr: (t1 - entry) / Math.max(entry - stop, 0.01) };
  }
  const entry = ind.price;
  const structural = ind.resistance != null ? ind.resistance + 0.25 * atrAbs : entry + 1.5 * atrAbs;
  const stop = Math.max(entry + 0.75 * atrAbs, structural);
  const t1 = ind.support != null && ind.support < entry - (stop - entry) ? ind.support : entry - 2 * (stop - entry);
  const t2 = entry - 3 * (stop - entry);
  return { direction, entry, stop, t1, t2, rr: (entry - t1) / Math.max(stop - entry, 0.01) };
}

export async function gatherIdeaContext(
  userId: number,
  ticker: string,
  requestedDirection: "long" | "short" | "auto",
  withOptions: boolean
): Promise<IdeaContext | { error: string }> {
  ticker = ticker.toUpperCase().trim();
  // Relative-strength and beta math needs benchmark candles — warm the cache
  // if this is called before the first scheduled market refresh.
  if (!benchmarkCandles("SPY")) await refreshMarketContext();

  // Prefer the screener's stored indicators; compute fresh for off-universe tickers.
  const row = await db.query(`SELECT * FROM screener WHERE ticker = ?`).get(ticker) as any;
  let ind: Indicators | null = row ? (JSON.parse(row.indicators) as Indicators) : null;
  const stale = row ? Date.now() / 1000 - row.updated_at > 24 * 3600 : true;
  if (!ind || stale) {
    const candles = await fetchDailyCandles(ticker);
    if (candles) {
      const meta = await universeMeta(ticker);
      const spy = benchmarkCandles("SPY")?.closes ?? null;
      const sec = benchmarkCandles(sectorEtf(meta?.sector))?.closes ?? null;
      ind = computeIndicators(candles, spy, sec) ?? ind;
    }
  }
  if (!ind) return { error: `${ticker}: not enough price history to analyze (need ~1 year of daily data).` };

  // Live price refresh so the frame isn't anchored to a stale scan.
  let price = ind.price;
  try {
    const q = await cachedQuote(ticker);
    if (q.c) price = q.c;
  } catch {}
  ind = { ...ind, price };

  const longScore = scoreLong(ind);
  const shortScore = scoreShort(ind);
  const quantDirection = directionOf(longScore, shortScore);
  const dir: "long" | "short" =
    requestedDirection !== "auto" ? requestedDirection : quantDirection === "short" ? "short" : "long";

  const meta = await universeMeta(ticker);
  let headlines = "(news unavailable)";
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
    const news = (await fetchCompanyNews(ticker, from, to)).slice(0, 10);
    headlines =
      news.map((n) => `- [${new Date(n.datetime * 1000).toISOString().slice(0, 10)}] ${n.headline} (${n.source})`).join("\n") ||
      "(no company news in the last 14 days)";
  } catch {}

  const earnings = await fetchNextEarnings(ticker);
  const frame = tradeFrame(ind, dir);
  // Ideas are medium/long-term equity positions: size against account equity
  // with fixed account defaults, NOT the trader's short-term Analyze-tab risk
  // prefs — the Ideas tab is fully independent of the analyzer.
  const sizing = await positionSizing(userId, frame.entry, frame.stop, { risk: loadRiskConfig(), basis: "equity" });
  let optionsText: string | null = null;
  let optionsSummary: OptionsSummary | null = null;
  if (withOptions) {
    optionsSummary = await fetchOptionsSummary(ticker);
    optionsText = optionsContextText(optionsSummary);
  }

  return {
    ticker,
    requestedDirection,
    ind,
    longScore,
    shortScore,
    quantDirection,
    sector: meta?.sector ?? row?.sector ?? "Unknown",
    industry: meta?.industry ?? "Unknown",
    name: meta?.name ?? ticker,
    price,
    headlines,
    earnings,
    frame,
    sizing,
    optionsText,
    optionsSummary,
  };
}

async function contextToPrompt(userId: number, ctx: IdeaContext, portfolio: Portfolio, userNotes?: string): Promise<string> {
  const i = ctx.ind;
  const held = portfolio.holdings.find((h) => h.ticker === ctx.ticker);
  const snap = await getMarketSnapshot();
  const secRot = snap?.sectors.find((s) => s.sector === ctx.sector);
  const fmt = (v: number | null | undefined, dec = 2) => (v != null ? v.toFixed(dec) : "n/a");
  // Ideas are medium-to-long-term equity buys/shorts, so the R:R bar is a fixed
  // 2:1 — deliberately NOT the trader's analyzer target_rr (that knob is for the
  // short-term swing/options Analyze tab only). Keeping it constant also holds
  // the system block byte-identical across users so prompt-cache hits survive.
  const targetRR = 2;

  return [
    `IDEA TO VALIDATE: ${ctx.ticker} (${ctx.name}) — ${ctx.requestedDirection === "auto" ? `direction AUTO (quant lean: ${ctx.quantDirection})` : ctx.requestedDirection.toUpperCase()}`,
    `Sector: ${ctx.sector} / ${ctx.industry}`,
    userNotes ? `Trader's notes: ${userNotes}` : "",
    ``,
    `QUANT CONFLUENCE SCORES (0-100; momentum capped so it cannot dominate; shorts hard-capped at 35 without structural breakdown):`,
    `long score ${ctx.longScore}, short score ${ctx.shortScore}, quant direction: ${ctx.quantDirection}`,
    ``,
    `TECHNICALS (1y daily):`,
    `price=$${fmt(ctx.price)}  SMA20=$${fmt(i.sma20)}  SMA50=$${fmt(i.sma50)}  SMA200=$${fmt(i.sma200)}  (${fmt(i.pctVs200, 1)}% vs SMA200)`,
    `20d slope=${fmt(i.slope20, 3)}%/day  cross: ${i.crossStatus}${i.crossDetail ? ` (${i.crossDetail})` : ""}  swing structure: ${i.structure}`,
    `RSI14=${fmt(i.rsi14, 0)}  MACD-hist=${fmt(i.macdHist, 3)}  ATR=${fmt(i.atrPct, 1)}% of price  extension=${fmt(i.extension, 1)} ATRs from SMA20`,
    `momentum: 1m ${fmt(i.mom1m, 1)}%  3m ${fmt(i.mom3m, 1)}%  6m ${fmt(i.mom6m, 1)}%  52wk position: ${fmt(i.pct52w, 0)}/100`,
    `volume trend (20d/60d): ${fmt(i.volTrend)}x  range: ${i.rangeState}${i.rangeLevel ? ` at $${fmt(i.rangeLevel)}` : ""}${i.rangeState !== "none" ? (i.rangeVolConfirmed ? " (volume-confirmed)" : " (NOT volume-confirmed)") : ""}`,
    `levels: nearest support $${fmt(i.support)}, nearest resistance $${fmt(i.resistance)}`,
    `relative strength: vs SPY 1m ${fmt(i.rsSpy1m, 1)}pp, 3m ${fmt(i.rsSpy3m, 1)}pp; vs sector ETF 1m ${fmt(i.rsSector1m, 1)}pp  beta(60d)=${fmt(i.beta, 2)}`,
    ``,
    await marketContextText(),
    secRot
      ? `THIS SECTOR: ${secRot.sector} is ${secRot.state} (1m ${secRot.ret1m >= 0 ? "+" : ""}${secRot.ret1m.toFixed(1)}%, vs SPY ${secRot.rel1m >= 0 ? "+" : ""}${secRot.rel1m.toFixed(1)}pp, trend ${secRot.relTrend >= 0 ? "improving" : "fading"}).`
      : ``,
    ``,
    `NEWS (last 14 days):`,
    ctx.headlines,
    ``,
    `EARNINGS: ${ctx.earnings ? `next report ${ctx.earnings.date} (${ctx.earnings.daysAway} days away${ctx.earnings.hour ? ", " + ctx.earnings.hour : ""}) — flag if inside the holding period.` : "no scheduled report found in the next ~70 days."}`,
    ``,
    `TARGET RISK/REWARD: this trader's minimum R:R for a "strong" rating is ${targetRR.toFixed(1)}:1 to the first target; the "moderate" band runs down to ${Math.max(1, targetRR - 0.5).toFixed(1)}:1; anything below ${Math.max(1, targetRR - 0.5).toFixed(1)}:1 caps the rating at "weak" on the risk/reward leg.`,
    ``,
    `RISK-FIRST TRADE FRAME (deterministic starting point from ATR + swing levels — refine with judgment):`,
    ctx.frame
      ? `${ctx.frame.direction.toUpperCase()}: entry ~$${fmt(ctx.frame.entry)}, stop $${fmt(ctx.frame.stop)}, T1 $${fmt(ctx.frame.t1)}, T2 $${fmt(ctx.frame.t2)}, R:R to T1 ≈ ${fmt(ctx.frame.rr, 1)}:1`
      : "(unavailable)",
    ctx.sizing
      ? `SIZING MATH: ${ctx.sizing.accountEquity ? `equity $${ctx.sizing.accountEquity.toLocaleString()}, max risk ${ctx.sizing.riskPct}% = $${ctx.sizing.riskDollars}, suggested ~${ctx.sizing.shares} shares (~$${ctx.sizing.notional}). ${ctx.sizing.note}` : ctx.sizing.note}`
      : "",
    accountContextText(userId),
    await journalContextText(userId, ctx.ticker),
    held ? `POSITION: trader already holds ${held.shares} shares @ $${held.cost_basis}${held.thesis ? ` — thesis: ${held.thesis}` : ""}.` : `POSITION: trader does not hold ${ctx.ticker}.`,
    ctx.optionsText
      ? `\n${ctx.optionsText}\nInclude an options_view in your output. Consider the FULL strategy menu — long call/put, vertical debit/credit spreads, straddle, strangle, iron condor, covered call, cash-secured put, calendar — and pick the ONE structure that best fits both the thesis and the IV regime: sell premium (credit spreads, iron condor, covered call, CSP) when IV is elevated; buy premium (long options, debit spreads) when IV is low and a real move is expected; straddle/strangle only for a genuine big-move-either-way thesis; iron condor for a range-bound thesis; covered call / cash-secured put only when it fits an existing or intended share position. Do NOT default to plain calls/puts if a defined-risk structure fits better. Propose concrete legs (action/right/strike/expiry/quantity) using ONLY strikes and expiries from the chain data above — max loss, max gain, and breakevens will be computed deterministically from your legs, so make them real. If options genuinely add nothing here, use strategy "neutral" or "avoid" with an empty legs array and say why. Spell out premium risk (IV crush, theta decay) in plain terms in iv_context.`
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// Price the AI's proposed option legs deterministically (Black-Scholes stress),
// so the max loss / max gain / breakevens the trader sees are computed, never
// model-authored — the options twin of the deterministic tradeFrame().
function priceOptionsView(report: IdeaReport, ctx: IdeaContext) {
  const ov = report.options_view;
  if (!ov?.legs?.length || ov.strategy === "neutral" || ov.strategy === "avoid") return;
  try {
    const spot = ctx.optionsSummary?.spot ?? ctx.price;
    const legExpiry = ov.legs[0].expiry;
    const expiries = ctx.optionsSummary?.expiries ?? [];
    const baseIv =
      expiries.find((e) => e.expiry === legExpiry && e.atmIv != null)?.atmIv ??
      expiries.find((e) => e.atmIv != null)?.atmIv ?? 0.3;
    const st = stressStructure(ov.legs as Leg[], spot, baseIv);
    ov.pricing = {
      entryCost: Math.round(st.entryCost * 100) / 100,
      maxLoss: Math.round(st.maxLoss * 100) / 100,
      maxGain: Math.round(st.maxGain * 100) / 100,
      breakevens: st.breakevens.map((b) => Math.round(b * 100) / 100),
      note: st.note,
    };
  } catch (err) {
    console.error(`[validator] options pricing failed for ${ctx.ticker}:`, err);
  }
}

export async function validateIdea(
  userId: number,
  ticker: string,
  requestedDirection: "long" | "short" | "auto",
  portfolio: Portfolio,
  opts: { notes?: string; options?: boolean; source?: string } = {}
): Promise<IdeaReport | { error: string }> {
  if (!opusBreaker.allow()) return { error: "AI circuit breaker is tripped — reset it from the dashboard status bar." };

  const ctx = await gatherIdeaContext(userId, ticker, requestedDirection, !!opts.options);
  if ("error" in ctx) return ctx;
  const prompt = await contextToPrompt(userId, ctx, portfolio, opts.notes);

  try {
    const response = await claudeQueue(() =>
      client.messages.create({
        model: config.modelDeep,
        max_tokens: 12000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: VALIDATOR_SYSTEM, cache_control: { type: "ephemeral" } }],
        output_config: { format: { type: "json_schema", schema: IDEA_SCHEMA } },
        messages: [{ role: "user", content: prompt }],
      })
    );
    const report = { ticker: ctx.ticker, ...parseJsonResponse<Omit<IdeaReport, "ticker">>(response, "validator") };
    priceOptionsView(report, ctx);
    await db.query(`INSERT INTO ideas (ts, ticker, direction, rating, confidence, source, report, user_id) VALUES (extract(epoch from now())::int, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ctx.ticker, report.direction, report.rating, report.confidence, opts.source ?? "validate", JSON.stringify(report), userId);
    return report;
  } catch (err) {
    console.error(`[validator] ${ticker} failed:`, err);
    return { error: `validation failed: ${err}` };
  }
}

// Optional narrowing for generation — mirrors the dashboard's filter panel.
export interface IdeaFilters {
  sectors?: string[];                    // exact sector names; empty/absent = all
  minScore?: number;                     // floor for the directional score (default 68)
  direction?: "long" | "short" | "both"; // default both
  tickers?: string[];                    // allowlist — the dashboard's filtered view; absent = all
}

// Batch idea generation: strongest screener confluences, both directions,
// sector-diversified (max 2 per sector per direction), capped for cost.
export async function pickCandidates(portfolio: Portfolio, count: number, filters?: IdeaFilters): Promise<{ ticker: string; direction: "long" | "short" }[]> {
  const rows = await getScreenerRows(portfolio);
  const regime = (await getMarketSnapshot())?.regime;
  const minScore = filters?.minScore ?? 68;
  const sectorSet = filters?.sectors?.length ? new Set(filters.sectors) : null;
  const tickerSet = filters?.tickers?.length ? new Set(filters.tickers) : null;
  const dirWant = filters?.direction === "long" || filters?.direction === "short" ? filters.direction : null;
  const picks: { ticker: string; direction: "long" | "short"; score: number; sector: string }[] = [];
  for (const r of rows) {
    if (sectorSet && !sectorSet.has(r.sector)) continue;
    if (tickerSet && !tickerSet.has(r.ticker)) continue;
    if (r.direction === "long" && dirWant !== "short" && r.long_score >= minScore) picks.push({ ticker: r.ticker, direction: "long", score: r.long_score, sector: r.sector });
    else if (r.direction === "short" && dirWant !== "long" && r.short_score >= minScore) picks.push({ ticker: r.ticker, direction: "short", score: r.short_score, sector: r.sector });
  }
  // Risk-off tape: prefer shorts/defensives by nudging short scores up the sort.
  picks.sort((a, b) => (b.score + (regime?.riskOff && b.direction === "short" ? 5 : 0)) - (a.score + (regime?.riskOff && a.direction === "short" ? 5 : 0)));
  const perSector = new Map<string, number>();
  const out: { ticker: string; direction: "long" | "short" }[] = [];
  for (const p of picks) {
    const key = `${p.sector}:${p.direction}`;
    if ((perSector.get(key) ?? 0) >= 2) continue;
    perSector.set(key, (perSector.get(key) ?? 0) + 1);
    out.push({ ticker: p.ticker, direction: p.direction });
    if (out.length >= count) break;
  }
  return out;
}

// Intraday plans live in the same table with a different report shape
// (setup_quality, no `rating`), so callers that assume the IdeaReport shape keep
// the default. History passes includeIntraday and renders per-source.
//
// The summary fields come from COLUMNS, not the report JSON: intraday plans have
// no `rating` inside the blob, but the column holds the mapped value already
// (intraday.ts writes setup_quality, no_trade -> reject). Spreading the JSON
// alone rendered an "undefined" rating badge for every intraday row.
export async function recentIdeas(
  userId: number, limit = 20, opts: { includeIntraday?: boolean } = {}
): Promise<(IdeaReport & { ts: number; source: string })[]> {
  const rows = await db
    .query(
      `SELECT ts, source, ticker, direction, rating, report FROM ideas
       WHERE user_id = ? ${opts.includeIntraday ? "" : "AND source != 'intraday'"}
       ORDER BY ts DESC LIMIT ?`
    )
    .all(userId, limit) as any[];
  return rows.flatMap((r) => {
    // One poison row must not 500 the whole History tab (insights.ts guards the
    // same parse); skip it and keep the rest of the feed.
    let report: IdeaReport;
    try { report = JSON.parse(r.report) as IdeaReport; } catch { return []; }
    return [{ ...report, ticker: r.ticker, direction: r.direction, rating: r.rating, ts: r.ts, source: r.source }];
  });
}
