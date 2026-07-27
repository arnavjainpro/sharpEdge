// Tier 2: deep analysis of high/critical events (deep model, adaptive thinking).
import Anthropic from "@anthropic-ai/sdk";
import type { RawEvent } from "../engine/detectors";
import { config, type Portfolio } from "../config";
import { recentBars, insertSignal, db } from "../db";
import { snapshot } from "../engine/technicals";
import { marketContextText } from "../engine/market";
import { claudeQueue, parseJsonResponse } from "./queue";
import { opusBreaker } from "./breaker";

const client = new Anthropic();

// Last N significant events (and this advisor's own past signals) for a ticker,
// so Opus analyzes the *delta* of new news rather than each headline in amnesia —
// e.g. a "$50B buyback" reads very differently if a $60B one was announced last quarter.
// The events half is global (public market fact); the signals half is joined on
// userId so "your prior signal" means theirs and not another account's.
export async function recentHistory(ticker: string, excludeEventId: number, userId: number, limit = 3): Promise<string> {
  const rows = await db
    .query(
      `SELECT e.ts, e.kind, e.title, e.severity, s.action, s.conviction, s.thesis
       FROM events e LEFT JOIN signals s ON s.event_id = e.id AND s.user_id = ?
       WHERE e.ticker = ? AND e.id != ? AND e.severity IN ('critical','high')
       ORDER BY e.ts DESC LIMIT ?`
    )
    .all(userId, ticker, excludeEventId, limit) as {
    ts: number; kind: string; title: string; severity: string;
    action: string | null; conviction: string | null; thesis: string | null;
  }[];
  if (rows.length === 0) return "(no prior significant events on record for this ticker)";
  return rows
    .map((r) => {
      const when = new Date(r.ts * 1000).toISOString().slice(0, 16).replace("T", " ");
      let line = `- [${when} UTC] (${r.severity}/${r.kind}) ${r.title}`;
      if (r.action) line += `\n  → your prior signal: ${r.action} (${r.conviction}) — ${r.thesis}`;
      return line;
    })
    .join("\n");
}

export interface Signal {
  action: "buy" | "sell" | "trim" | "add" | "hold" | "watch";
  conviction: "high" | "medium" | "low";
  plain_headline: string;
  thesis: string;
  invalidation: string;
  portfolio_impact: string;
}

// Stable system prompt — byte-identical across calls for prompt-cache hits.
function systemPrompt(portfolio: Portfolio): string {
  const positions = portfolio.holdings
    .map((h) => {
      let line = `- ${h.ticker}: ${h.shares} shares @ $${h.cost_basis} cost basis`;
      if (h.thesis) line += `\n  investor's thesis: ${h.thesis}`;
      return line;
    })
    .join("\n");
  return `You are a senior equity analyst advising one individual investor. You receive a market event that triage flagged as significant, plus a live technical snapshot. Produce a decision-ready assessment.

Investor's portfolio:
${positions || "(no current positions)"}
Watchlist: ${portfolio.watchlist.join(", ") || "none"}

Rules:
- Write for a beginner. Plain everyday English. If you must reference a technical concept, explain it in the same sentence (e.g. "the stock's short-term trend just rose above its long-term trend — historically a positive sign" instead of "golden cross"). No jargon like RSI, VWAP, MACD, or z-score in your output.
- Ground every claim in the event and data provided. Do not invent facts, prices, or news.
- Be position-aware: if the investor holds the ticker, quantify exposure and speak to their actual position (P&L vs cost basis, concentration).
- "action" is your recommendation: buy/add/trim/sell only with a clear catalyst-driven case; otherwise hold (if held) or watch (if not).
- "invalidation" is the specific condition that would prove the thesis wrong (a price level, a follow-up disclosure, a data point).
- Where a position has a stated investor thesis, judge the event against it: does this strengthen, weaken, or break the reason they own it?
- Conviction reflects evidence quality, not enthusiasm. Ambiguous events get low conviction and a watch/hold action.
- This is decision support for a self-directed investor, not licensed financial advice; write with appropriate epistemic honesty about uncertainty.`;
}

const SIGNAL_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["buy", "sell", "trim", "add", "hold", "watch"] },
    conviction: { type: "string", enum: ["high", "medium", "low"] },
    plain_headline: {
      type: "string",
      description: "One short sentence of advice a complete beginner understands, suitable for a phone notification. E.g. 'Consider selling some SNDK to protect your big gain.' or 'NVDA just showed a classic buy signal — worth a look.'",
    },
    thesis: { type: "string", description: "2-4 sentences in plain English: what happened and why the action follows." },
    invalidation: { type: "string", description: "In plain English: what happening next would mean this advice is wrong." },
    portfolio_impact: { type: "string", description: "1-2 plain sentences on what this means for THIS investor's money." },
  },
  required: ["action", "conviction", "plain_headline", "thesis", "invalidation", "portfolio_impact"],
  additionalProperties: false,
} as const;

// userId owns the resulting signal — the analysis is written against THIS
// portfolio ("you hold 200 shares, trimming half…"), so it must not surface on
// another account's dashboard.
export async function analyzeEvent(event: RawEvent, portfolio: Portfolio, userId: number): Promise<Signal | null> {
  if (!opusBreaker.allow()) {
    console.warn(`[analyst] circuit breaker tripped — skipping analysis for event ${event.id}`);
    return null;
  }
  const bars = await recentBars(event.ticker, 120);
  const stats = await db.query(`SELECT prev_close FROM daily_stats WHERE ticker = ?`).get(event.ticker) as { prev_close: number } | null;
  const tech = snapshot(bars, stats?.prev_close ?? null);
  const marketCtx = await marketContextText();
  const history = await recentHistory(event.ticker, event.id, userId);

  try {
    const response = await claudeQueue(() => client.messages.create({
      model: config.modelDeep,
      max_tokens: 6000,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: systemPrompt(portfolio),
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: {
        format: { type: "json_schema", schema: SIGNAL_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            `EVENT [${event.kind}] on ${event.ticker} at ${new Date(event.ts * 1000).toISOString()}:`,
            event.title,
            `Detail: ${JSON.stringify(event.detail).slice(0, 1500)}`,
            ``,
            `TECHNICAL SNAPSHOT for ${event.ticker}:`,
            `price=$${tech.price ?? "n/a"}  sessionChange=${tech.sessionChangePct?.toFixed(2) ?? "n/a"}%  RSI14=${tech.rsi14?.toFixed(0) ?? "n/a"}  MACD-hist=${tech.macdHistogram?.toFixed(3) ?? "n/a"}  VWAP=$${tech.vwap?.toFixed(2) ?? "n/a"}  SMA20=$${tech.sma20?.toFixed(2) ?? "n/a"}`,
            ``,
            marketCtx,
            ``,
            `RECENT HISTORY for ${event.ticker} (prior significant events + your own past signals — analyze the new event as a delta against these, not in isolation):`,
            history,
          ].join("\n"),
        },
      ],
    }));

    const signal = parseJsonResponse<Signal>(response, "analyst");
    await insertSignal({ event_id: event.id, user_id: userId, ticker: event.ticker, ...signal });
    return signal;
  } catch (err) {
    console.error(`[analyst] failed for event ${event.id}:`, err);
    return null;
  }
}
