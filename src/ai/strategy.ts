// English (or chart) → StrategySpec. The model ONLY translates intent into the
// backtester's closed rule vocabulary; it never computes results. Ambiguous
// input returns a clarification instead of a lossy guess.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import type { StrategySpec, Rule, Param } from "../engine/backtest";
import { claudeQueue, parseJsonResponse } from "./queue";
import { haikuBreaker } from "./breaker";

const client = new Anthropic();

const RULE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["sma_cross", "price_vs_sma", "rsi", "breakout", "macd_cross"] },
    dir: { type: "string", enum: ["above", "below", "up", "down"] },
    fast: { type: ["number", "null"], description: "sma_cross: fast MA period" },
    slow: { type: ["number", "null"], description: "sma_cross: slow MA period" },
    period: { type: ["number", "null"], description: "price_vs_sma / rsi period" },
    level: { type: ["number", "null"], description: "rsi threshold (0-100)" },
    lookback: { type: ["number", "null"], description: "breakout channel length in bars" },
  },
  required: ["kind", "dir", "fast", "slow", "period", "level", "lookback"],
  additionalProperties: false,
} as const;

const SPEC_SCHEMA = {
  type: "object",
  properties: {
    clarification: { type: ["string", "null"], description: "If the request can't be expressed in the vocabulary, ask ONE concrete question here and leave the rest null." },
    // Nullable enum has to be an anyOf: structured outputs rejects an `enum`
    // sitting on a union `type` ("Enum value 'long' does not match declared
    // type '['string','null']'"), which 400s every backtest parse.
    direction: { anyOf: [{ type: "string", enum: ["long", "short"] }, { type: "null" }] },
    entry: { type: ["array", "null"], items: RULE_SCHEMA, description: "ALL entry rules must hold to enter (AND)." },
    exit: { type: ["array", "null"], items: RULE_SCHEMA, description: "ANY exit rule triggers an exit (OR). May be empty if relying on stop/target." },
    stop_atr: { type: ["number", "null"], description: "Stop distance in ATR(14) multiples, e.g. 2." },
    target_atr: { type: ["number", "null"], description: "Target distance in ATR(14) multiples." },
  },
  required: ["clarification", "direction", "entry", "exit", "stop_atr", "target_atr"],
  additionalProperties: false,
} as const;

const SYSTEM = `You translate a trading strategy description into a strict JSON spec for a backtester. You do NOT evaluate or judge the strategy — only translate it.

The ONLY available rules:
- sma_cross {fast, slow, dir: above|below} — fast SMA crosses above/below slow SMA.
- price_vs_sma {period, dir: above|below} — price above/below its SMA(period).
- rsi {period, level, dir: above|below} — RSI(period) above/below level.
- breakout {lookback, dir: up|down} — price breaks above the highest high / below the lowest low of the last {lookback} bars.
- macd_cross {dir: above|below} — MACD histogram above/below zero.

Rules:
- Fill only the fields a rule uses; set the others to null.
- entry rules are AND-ed; exit rules are OR-ed. If the user gives no explicit exit, mirror the entry (e.g. exit on the opposite cross) or rely on stop_atr/target_atr.
- Convert vague risk language to ATR multiples (e.g. "wide stop" → stop_atr 3, "tight" → 1).
- If the description cannot be represented with these rules (e.g. references candlestick patterns, fundamentals, or indicators not listed), set clarification to ONE specific question and leave direction/entry/exit null. Do not force a bad approximation.
- Daily bars only. Be faithful to the user's numbers; if they imply tuning ("around 50", "roughly oversold"), still emit a single representative value — the backtester explores a range around it.`;

export interface ParsedStrategy { spec?: StrategySpec; clarification?: string; error?: string; }

const P = (v: number | null | undefined, def: number): Param => ({ value: v ?? def });

function toRule(raw: any): Rule | null {
  switch (raw.kind) {
    case "sma_cross": return { kind: "sma_cross", fast: P(raw.fast, 50), slow: P(raw.slow, 200), dir: raw.dir === "below" ? "below" : "above" };
    case "price_vs_sma": return { kind: "price_vs_sma", period: P(raw.period, 50), dir: raw.dir === "below" ? "below" : "above" };
    case "rsi": return { kind: "rsi", period: P(raw.period, 14), level: P(raw.level, 30), dir: raw.dir === "below" ? "below" : "above" };
    case "breakout": return { kind: "breakout", lookback: P(raw.lookback, 20), dir: raw.dir === "down" ? "down" : "up" };
    case "macd_cross": return { kind: "macd_cross", dir: raw.dir === "below" ? "below" : "above" };
    default: return null;
  }
}

export async function parseStrategy(ticker: string, description: string, image?: string): Promise<ParsedStrategy> {
  if (!haikuBreaker.allow()) return { error: "AI circuit breaker is tripped — reset it from the dashboard status bar." };
  const content: Anthropic.ContentBlockParam[] = [];
  if (image) {
    const m = image.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s);
    if (m) {
      content.push({ type: "image", source: { type: "base64", media_type: m[1] as any, data: m[2] } });
      content.push({ type: "text", text: "The chart above shows a setup. Express the entry/exit as rules from the vocabulary if you can; if the setup depends on visual candlestick patterns that the vocabulary can't express, ask for clarification." });
    }
  }
  content.push({ type: "text", text: `Ticker: ${ticker || "(unspecified)"}\nStrategy: ${description || "(see chart)"}` });

  try {
    const res = await claudeQueue(() =>
      client.messages.create({
        model: config.modelFast,
        max_tokens: 1024,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        output_config: { format: { type: "json_schema", schema: SPEC_SCHEMA } },
        messages: [{ role: "user", content }],
      })
    );
    const raw = parseJsonResponse<any>(res, "strategy");
    if (raw.clarification) return { clarification: String(raw.clarification) };
    const entry = (raw.entry ?? []).map(toRule).filter(Boolean) as Rule[];
    const exit = (raw.exit ?? []).map(toRule).filter(Boolean) as Rule[];
    if (!entry.length) return { clarification: "I couldn't turn that into concrete entry rules. Try naming an indicator condition, e.g. \"buy when the 50-day crosses above the 200-day\" or \"buy when RSI drops below 30\"." };
    const spec: StrategySpec = {
      ticker: ticker.toUpperCase(),
      direction: raw.direction === "short" ? "short" : "long",
      entry, exit,
      ...(raw.stop_atr ? { stop_atr: { value: Number(raw.stop_atr) } } : {}),
      ...(raw.target_atr ? { target_atr: { value: Number(raw.target_atr) } } : {}),
    };
    return { spec };
  } catch (err) {
    console.error("[strategy] parse failed:", err);
    return { error: `strategy parse failed: ${err}` };
  }
}
