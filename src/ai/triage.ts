// Tier 1: cheap, fast severity triage of every detected event (fast model).
import Anthropic from "@anthropic-ai/sdk";
import type { RawEvent } from "../engine/detectors";
import { config, type Portfolio } from "../config";
import { setTriage } from "../db";
import { claudeQueue, parseJsonResponse } from "./queue";
import { haikuBreaker } from "./breaker";

const client = new Anthropic();

export type Severity = "critical" | "high" | "info";

export interface TriageResult {
  severity: Severity;
  rationale: string;
}

// Stable system prompt — kept byte-identical so the prompt cache hits.
// Exported so the cache heartbeat can send the exact same prefix.
export function triageSystemPrompt(portfolio: Portfolio): string {
  const held = portfolio.holdings.map((h) => `${h.ticker} (${h.shares} shares)`).join(", ");
  const watched = portfolio.watchlist.join(", ");
  return `You are the triage layer of a personal trading advisor. You receive one detected market event at a time and rate how urgently the investor needs to know about it.

The investor holds: ${held || "no positions"}.
Watchlist (not held): ${watched || "none"}.

Severity levels:
- "critical": likely to materially move the stock (>3-4%) or requires a same-day decision — e.g. surprise 8-K, activist 13D, big earnings miss/beat, guidance cut, M&A, CEO departure, sudden crash/spike on heavy volume.
- "high": meaningful and worth reading today, but not decision-forcing — notable analyst-grade news, unusual volume with a plausible cause, routine 10-Q from a held position, moderate earnings surprise.
- "info": routine noise — minor PR, listicle press coverage, small moves, insider Form 4s of modest size, events on watchlist names with no position impact.

Screener events (kinds: golden_cross, death_cross, screener_pick, screener_short) are technical setups computed from real daily price history, not news:
- death_cross on a held position → "critical"; on anything else → "high".
- golden_cross formed, screener_pick (strong long confluence), or screener_short (strong short confluence with confirmed structural breakdown) → "high"; screener_short on a HELD position → "critical" (the investor is long a breaking-down stock).
- golden_cross approaching (not yet formed) → "info" unless on a held position (then "high").

"market_mover" events mean an S&P 500 stock outside the portfolio made an abnormal single-day move and was auto-promoted to live monitoring: rate "high" if the move is ≥7% or clearly catalyst-driven, else "info" (its news/filings will arrive as separate events).

Bias: events on HELD tickers rate one level higher than the same event on a watchlist ticker. Routine media commentary is "info" no matter the ticker.`;
}

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["critical", "high", "info"] },
    rationale: { type: "string", description: "One sentence: why this severity." },
  },
  required: ["severity", "rationale"],
  additionalProperties: false,
} as const;

export async function triageEvent(event: RawEvent, portfolio: Portfolio): Promise<TriageResult> {
  if (!haikuBreaker.allow()) {
    const held = portfolio.holdings.some((h) => h.ticker === event.ticker);
    const fallback: TriageResult = {
      severity: held ? "high" : "info",
      rationale: "Circuit breaker tripped — AI triage halted; defaulted by holding status.",
    };
    await setTriage(event.id, fallback.severity, fallback.rationale);
    return fallback;
  }
  try {
    const response = await claudeQueue(() => client.messages.create({
      model: config.modelFast,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: triageSystemPrompt(portfolio),
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: {
        format: { type: "json_schema", schema: TRIAGE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `Event [${event.kind}] on ${event.ticker}: ${event.title}\nDetail: ${JSON.stringify(event.detail).slice(0, 800)}`,
        },
      ],
    }));

    const result = parseJsonResponse<TriageResult>(response, "triage");
    await setTriage(event.id, result.severity, result.rationale);
    return result;
  } catch (err) {
    console.error(`[triage] failed for event ${event.id}:`, err);
    // Fail-safe: unknown events on held tickers are worth surfacing
    const held = portfolio.holdings.some((h) => h.ticker === event.ticker);
    const fallback: TriageResult = {
      severity: held ? "high" : "info",
      rationale: "Triage unavailable — defaulted by holding status.",
    };
    await setTriage(event.id, fallback.severity, fallback.rationale);
    return fallback;
  }
}
